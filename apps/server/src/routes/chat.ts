import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { createDeepSeekProvider } from "@muse/model-router";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";
import { createBuiltinToolRegistry } from "../agent/tool-registry.js";
import type { MuseToolMetadata } from "../agent/types.js";
import { db } from "../db/client.js";
import {
  chatMessages,
  chatSessions,
  modelRuns,
  toolCalls,
} from "../db/schema.js";
import { localToolBroker } from "../local-tools/local-tool-socket.js";
import { getAuthorizedModel } from "../models/authorized.js";

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

const chatRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.object({
    id: z.string().optional(),
    role: z.literal("user"),
    parts: z.array(textPartSchema).min(1),
  }),
  model: z
    .object({
      provider: z.string().min(1),
      name: z.string().min(1),
    })
    .optional(),
  localTools: z
    .object({
      deviceId: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .optional(),
});

function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  return trimmed.length > 22
    ? `${trimmed.slice(0, 22)}...`
    : trimmed || "新对话";
}

function previewFromText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Model call failed";
}

function tokenCount(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fallbackToolMetadata(toolName: string): MuseToolMetadata {
  return {
    name: toolName,
    title: toolName,
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  };
}

function buildDeepSeekLanguageModel(input: {
  apiKey: string;
  baseUrl: string | null;
  modelName: string;
}): LanguageModel {
  const provider = createDeepSeekProvider({
    apiKey: input.apiKey,
    baseURL: input.baseUrl ?? "https://api.deepseek.com",
  });

  return provider.createModel(input.modelName) as LanguageModel;
}

function buildLocalToolSystemPrompt(input: {
  localToolsEnabled: boolean;
  availableToolNames: string[];
}): string {
  const base = [
    "You are Muse, an AI assistant inside the Muse chat application.",
    "When tools are available, use them directly instead of claiming that a capability is unavailable.",
    `The tools registered for this request are: ${input.availableToolNames.join(", ") || "(none)"}.`,
  ];

  if (!input.localToolsEnabled) {
    return [
      ...base,
      "macOS local tools are not connected for this request. If the user asks you to inspect local files, explain that they need to connect the Muse macOS Local Tool Host first.",
    ].join("\n");
  }

  return [
    ...base,
    "macOS local tools are connected for this request if the registered tool list includes mac_* tools.",
    "Use mac_list_directory to list directories inside the attached macOS workspace.",
    "Use mac_read_file to read a text file inside the attached macOS workspace.",
    "Use mac_search_files to search text inside files in the attached macOS workspace.",
    "Use mac_write_file to create or overwrite a text file after desktop approval.",
    "Use mac_apply_patch for targeted edits to existing text files after desktop approval.",
    "Use mac_local_bash only when the user explicitly asks to run a shell command or when no safer local tool fits.",
    "Do not say that file reading is unavailable when mac_read_file is in the registered tool list. If you need a file path, ask for it or infer it from the user's request.",
  ].join("\n");
}

async function loadSessionHistory(input: {
  sessionId: string;
  userId: string;
}): Promise<ModelMessage[]> {
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, input.sessionId),
        eq(chatMessages.userId, input.userId),
        eq(chatMessages.status, "completed"),
      ),
    )
    .orderBy(asc(chatMessages.createdAt));

  return rows
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.content.trim().length > 0,
    )
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}

async function persistToolCalls(input: {
  steps: Array<StepResult<ToolSet>>;
  metadataByName: Map<string, MuseToolMetadata>;
  modelRunId: string;
  sessionId: string;
  userId: string;
  log: FastifyBaseLogger;
}) {
  const rows = input.steps.flatMap((step) =>
    step.toolCalls.map((call) => {
      const result = step.toolResults.find(
        (toolResult) => toolResult.toolCallId === call.toolCallId,
      );
      const now = new Date();
      const metadata =
        input.metadataByName.get(call.toolName) ??
        fallbackToolMetadata(call.toolName);

      return {
        id: randomUUID(),
        modelRunId: input.modelRunId,
        sessionId: input.sessionId,
        userId: input.userId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        toolSource: metadata.source,
        riskLevel: metadata.riskLevel,
        inputJson: jsonStringify(call.input),
        outputJson: result ? jsonStringify(result.output) : null,
        status: result ? "succeeded" : "running",
        requiresApproval: metadata.requiresApproval,
        startedAt: now,
        completedAt: result ? now : null,
        createdAt: now,
      };
    }),
  );

  if (!rows.length) {
    return [];
  }

  try {
    await db.insert(toolCalls).values(rows);
    return rows;
  } catch (error) {
    input.log.error({ err: error }, "persist tool calls failed");
    return [];
  }
}

export async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid chat request",
        issues: parsed.error.flatten(),
      });
    }

    const userId = request.userId as string;
    // 按 id + userId 查一次（不限 status），据此区分“已有会话”与“首消息懒创建”。
    const [existingSession] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, parsed.data.sessionId),
          eq(chatSessions.userId, userId),
        ),
      )
      .limit(1);

    // 命中但已归档/删除的会话不允许再写入。
    if (existingSession && existingSession.status !== "active") {
      return reply.status(404).send({ error: "Session not found" });
    }

    const isNewSession = !existingSession;

    const modelSelection =
      parsed.data.model ??
      (existingSession?.modelProvider && existingSession.modelName
        ? {
            provider: existingSession.modelProvider,
            name: existingSession.modelName,
          }
        : null);

    if (!modelSelection) {
      return reply.status(400).send({ error: "Missing model selection" });
    }

    const model = await getAuthorizedModel(userId, modelSelection);

    if (!model) {
      return reply.status(403).send({ error: "Model is not authorized" });
    }

    if (model.provider !== "deepseek") {
      return reply.status(400).send({
        error: `Provider is not supported yet: ${model.provider}`,
      });
    }

    if (!model.apiKey) {
      return reply.status(400).send({
        error: `Missing API key for model: ${model.provider}/${model.modelName}`,
      });
    }

    const prompt = parsed.data.message.parts
      .map((part) => part.text)
      .join("\n")
      .trim();
    const userMessageId = parsed.data.message.id ?? randomUUID();
    const assistantMessageId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    // 新会话与已有会话统一用这几个本地量，避免散落的 session.* 分支。
    const sessionId = parsed.data.sessionId;
    const sessionMessageCount = existingSession?.messageCount ?? 0;
    const nextTitle =
      existingSession && existingSession.messageCount > 0
        ? existingSession.title
        : titleFromPrompt(prompt);
    const history = isNewSession
      ? []
      : await loadSessionHistory({
          sessionId,
          userId,
        });
    const toolRegistry = createBuiltinToolRegistry({
      userId,
      sessionId,
      runId,
      deviceId: parsed.data.localTools?.deviceId,
      workspaceId: parsed.data.localTools?.workspaceId,
      localToolBroker,
    });
    const availableToolNames = Object.keys(toolRegistry.tools);
    const localToolsEnabled = Boolean(
      parsed.data.localTools?.deviceId &&
        parsed.data.localTools?.workspaceId &&
        availableToolNames.some((toolName) => toolName.startsWith("mac_")),
    );
    const systemPrompt = buildLocalToolSystemPrompt({
      localToolsEnabled,
      availableToolNames,
    });
    const messages: ModelMessage[] = [
      ...history,
      {
        role: "user",
        content: prompt,
      },
    ];

    request.log.info(
      {
        sessionId,
        runId,
        localTools: parsed.data.localTools,
        availableToolNames,
      },
      "chat tool registry prepared",
    );

    await db.transaction(async (tx) => {
      // 首消息懒创建：会话与第一条消息在同一事务里原子落库，
      // 保证 chat_sessions 里不会存在没有任何消息的空会话。
      if (isNewSession) {
        await tx.insert(chatSessions).values({
          id: sessionId,
          userId,
          title: nextTitle,
          modelProvider: model.provider,
          modelName: model.modelName,
          aiModelId: model.id,
          status: "active",
          pinned: false,
          messageCount: 0,
          lastMessagePreview: null,
          lastMessageAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await tx.insert(chatMessages).values({
        id: userMessageId,
        sessionId,
        userId,
        role: "user",
        content: prompt,
        parts: JSON.stringify(parsed.data.message.parts),
        modelProvider: model.provider,
        modelName: model.modelName,
        aiModelId: model.id,
        status: "completed",
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(modelRuns).values({
        id: runId,
        sessionId,
        userId,
        requestMessageId: userMessageId,
        aiModelId: model.id,
        provider: model.provider,
        modelName: model.modelName,
        status: "pending",
        startedAt: now,
        createdAt: now,
      });
    });

    let result: Awaited<ReturnType<typeof generateText>>;

    try {
      result = await generateText({
        model: buildDeepSeekLanguageModel({
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          modelName: model.modelName,
        }),
        system: systemPrompt,
        messages,
        tools: toolRegistry.tools,
        stopWhen: stepCountIs(5),
      });
    } catch (error) {
      const failedAt = new Date();
      const message = errorMessage(error);

      request.log.error({ err: error }, "deepseek model call failed");

      await db.transaction(async (tx) => {
        await tx
          .update(modelRuns)
          .set({
            status: "failed",
            errorMessage: message,
            completedAt: failedAt,
          })
          .where(eq(modelRuns.id, runId));

        await tx
          .update(chatSessions)
          .set({
            title: nextTitle,
            modelProvider: model.provider,
            modelName: model.modelName,
            aiModelId: model.id,
            messageCount: sessionMessageCount + 1,
            lastMessagePreview: previewFromText(prompt),
            lastMessageAt: failedAt,
            updatedAt: failedAt,
          })
          .where(eq(chatSessions.id, sessionId));
      });

      return reply.status(502).send({
        error: "Model call failed",
        message,
      });
    }

    const completedAt = new Date();
    const assistantText = result.text.trim() || "模型返回了空响应。";
    const assistantParts = [{ type: "text", text: assistantText }];
    const persistedToolCalls = await persistToolCalls({
      steps: result.steps,
      metadataByName: toolRegistry.metadataByName,
      modelRunId: runId,
      sessionId,
      userId,
      log: request.log,
    });

    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({
        id: assistantMessageId,
        sessionId,
        userId,
        role: "assistant",
        content: assistantText,
        parts: JSON.stringify(assistantParts),
        modelProvider: model.provider,
        modelName: model.modelName,
        aiModelId: model.id,
        status: "completed",
        createdAt: completedAt,
        updatedAt: completedAt,
      });

      await tx
        .update(modelRuns)
        .set({
          responseMessageId: assistantMessageId,
          status: "completed",
          promptTokens: tokenCount(result.usage.inputTokens),
          completionTokens: tokenCount(result.usage.outputTokens),
          totalTokens: tokenCount(result.usage.totalTokens),
          completedAt,
        })
        .where(eq(modelRuns.id, runId));

      await tx
        .update(chatSessions)
        .set({
          title: nextTitle,
          modelProvider: model.provider,
          modelName: model.modelName,
          aiModelId: model.id,
          messageCount: sessionMessageCount + 2,
          lastMessagePreview: previewFromText(assistantText),
          lastMessageAt: completedAt,
          updatedAt: completedAt,
        })
        .where(eq(chatSessions.id, sessionId));
    });

    return {
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      parts: assistantParts,
      createdAt: completedAt.toISOString(),
      model: {
        provider: model.provider,
        name: model.modelName,
      },
      toolCalls: persistedToolCalls.map((toolCall) => ({
        id: toolCall.id,
        toolCallId: toolCall.toolCallId,
        name: toolCall.toolName,
        source: toolCall.toolSource,
        riskLevel: toolCall.riskLevel,
        status: toolCall.status,
        requiresApproval: toolCall.requiresApproval,
      })),
      session: {
        id: sessionId,
        title: nextTitle,
        updatedAt: completedAt.toISOString(),
        modelProvider: model.provider,
        modelName: model.modelName,
        messageCount: sessionMessageCount + 2,
        lastMessagePreview: previewFromText(assistantText),
      },
    };
  });
}
