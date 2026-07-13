import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import {
  smoothStream,
  stepCountIs,
  streamText,
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
  // 用户在客户端开启了联网检索开关时为 true。
  webSearch: z.boolean().optional(),
  client: z
    .object({
      app: z.string().min(1).max(64).optional(),
      runtime: z.string().min(1).max(64).optional(),
      os: z.string().min(1).max(128).optional(),
      osVersion: z.string().min(1).max(128).optional(),
      platform: z.string().min(1).max(128).optional(),
      cpuArchitecture: z.string().min(1).max(128).optional(),
      cpuBrand: z.string().min(1).max(256).optional(),
      hardwareConcurrency: z.number().int().positive().optional(),
      userAgent: z.string().min(1).max(512).optional(),
      language: z.string().min(1).max(64).optional(),
      timezone: z.string().min(1).max(128).optional(),
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
      localToolsHost: z
        .object({
          status: z.string().min(1).max(64).optional(),
          deviceId: z.string().min(1).max(128).optional(),
          workspaceId: z.string().min(1).max(128).optional(),
          workspaceName: z.string().min(1).max(128).optional(),
          workspaceRoot: z.string().min(1).max(512).optional(),
        })
        .optional(),
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

// SSE 事件写入：每个事件是一行 `data: <json>\n\n`，前端按 event.type 分流处理。
function writeSseEvent(raw: ServerResponse, event: Record<string, unknown>) {
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

// 判断首个非空白字符是否为 CJK（中日韩），用于让中文也能逐字输出。
const CJK_PATTERN =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// smoothStream 的自定义分块：CJK 逐字吐出，拉丁文按「词 + 尾随空白」吐出，
// 兼顾中文打字机效果与英文的自然节奏。返回值必须是 buffer 的前缀。
function typewriterChunking(buffer: string): string | undefined | null {
  const firstNonSpace = buffer.match(/\S/);

  if (firstNonSpace && CJK_PATTERN.test(firstNonSpace[0])) {
    return buffer.slice(0, (firstNonSpace.index ?? 0) + 1);
  }

  const wordMatch = /\S+\s+/.exec(buffer);
  return wordMatch ? buffer.slice(0, wordMatch.index) + wordMatch[0] : null;
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
  client?: z.infer<typeof chatRequestSchema>["client"];
}): string {
  const base = [
    "You are Muse, an AI assistant inside the Muse chat application.",
    "When tools are available, use them directly instead of claiming that a capability is unavailable.",
    `The tools registered for this request are: ${input.availableToolNames.join(", ") || "(none)"}.`,
  ];
  if (input.availableToolNames.includes("WebSearch")) {
    base.push(
      "Use WebSearch to look up current information on the public web when the user asks about recent events, current facts, prices, releases, or anything likely outside your training data. Cite the returned URLs when you rely on them.",
    );
  }
  const client = input.client;
  const clientLines = client
    ? [
        "Client context for this request:",
        `- app: ${client.app ?? "unknown"}`,
        `- runtime: ${client.runtime ?? "unknown"}`,
        `- operating system: ${client.os ?? "unknown"}`,
        `- operating system version: ${client.osVersion ?? "unknown"}`,
        `- platform: ${client.platform ?? "unknown"}`,
        `- CPU architecture: ${client.cpuArchitecture ?? "unknown"}`,
        `- CPU brand: ${client.cpuBrand ?? "unknown"}`,
        `- hardware concurrency: ${client.hardwareConcurrency ?? "unknown"}`,
        `- language: ${client.language ?? "unknown"}`,
        `- timezone: ${client.timezone ?? "unknown"}`,
        client.viewport
          ? `- viewport: ${client.viewport.width}x${client.viewport.height}`
          : "- viewport: unknown",
        client.localToolsHost
          ? `- local tool host: status=${client.localToolsHost.status ?? "unknown"}, deviceId=${client.localToolsHost.deviceId ?? "unknown"}, workspaceId=${client.localToolsHost.workspaceId ?? "unknown"}, workspace=${client.localToolsHost.workspaceName ?? "unknown"}, workspaceRoot=${client.localToolsHost.workspaceRoot ?? "unknown"}`
          : "- local tool host: not reported",
        client.userAgent ? `- user agent: ${client.userAgent}` : null,
        "Use this client context to choose tools and explain platform-specific behavior accurately.",
      ].filter((line): line is string => Boolean(line))
    : [
        "Client context for this request was not reported. Avoid assuming the user's client OS or runtime.",
      ];

  if (!input.localToolsEnabled) {
    return [
      ...base,
      ...clientLines,
      "macOS local tools are not connected for this request. If the user asks you to inspect local files, explain that they need to connect the Muse macOS Local Tool Host first.",
    ].join("\n");
  }

  return [
    ...base,
    ...clientLines,
    "macOS local tools are connected for this request if the registered tool list includes Read, Grep, LS, Write, Edit, or Bash.",
    "Use LS to list directories inside the attached macOS workspace.",
    "Use Read to read a text file inside the attached macOS workspace.",
    "Use Grep to search text inside files in the attached macOS workspace.",
    "Use Write to create or overwrite a text file after desktop approval.",
    "Use Edit for targeted edits to existing text files after desktop approval.",
    "Use Bash only when the user explicitly asks to run a shell command or when no safer local tool fits.",
    "Use ServerBash only when the user explicitly asks to operate on the Muse server host instead of the attached macOS workspace.",
    "Muse application tools use the muse_* prefix and are for app state such as session history, available models, and current time.",
    "Do not say that file reading is unavailable when Read is in the registered tool list. If you need a file path, ask for it or infer it from the user's request.",
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

    // 收窄后固化，避免在异步闭包里丢失 apiKey 的非空判定。
    const apiKey = model.apiKey;

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
    let raw: ServerResponse | null = null;
    const toolRegistry = createBuiltinToolRegistry({
      userId,
      sessionId,
      runId,
      deviceId: parsed.data.localTools?.deviceId,
      workspaceId: parsed.data.localTools?.workspaceId,
      webSearchRequested: parsed.data.webSearch ?? false,
      localToolBroker,
      onToolEvent: (event) => {
        if (!raw || raw.writableEnded) {
          return;
        }
        writeSseEvent(raw, event);
      },
    });
    const availableToolNames = Object.keys(toolRegistry.tools);
    const localToolsEnabled = Boolean(
      parsed.data.localTools?.deviceId &&
        parsed.data.localTools?.workspaceId &&
        ["Read", "Grep", "LS", "Write", "Edit", "Bash"].some((toolName) =>
          availableToolNames.includes(toolName),
        ),
    );
    const systemPrompt = buildLocalToolSystemPrompt({
      localToolsEnabled,
      availableToolNames,
      client: parsed.data.client,
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

    // SSE 响应：直接接管底层 socket 写 event-stream。
    // reply.hijack() 让 Fastify 不再管理响应生命周期，避免它按普通响应
    // 计算 content-length / 走 onSend 钩子而把流“压平”成空响应。
    raw = reply.raw;
    // 客户端断开时中止模型流，避免继续消耗额度与句柄。
    const abortController = new AbortController();
    request.raw.on("close", () => abortController.abort());

    // hijack 会跳过 @fastify/cors 的 onSend，这里手动补齐 CORS（等价 origin:true 的回显）。
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      raw.setHeader("access-control-allow-origin", requestOrigin);
      raw.setHeader("vary", "Origin");
      raw.setHeader("access-control-allow-credentials", "true");
    }
    raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    raw.setHeader("cache-control", "no-cache, no-transform");
    raw.setHeader("connection", "keep-alive");
    raw.setHeader("x-accel-buffering", "no");

    reply.hijack();
    raw.flushHeaders();

    // 复用原有的会话/消息元信息组织成 session payload，供起始与结束事件下发。
    const buildSessionPayload = (
      updatedAt: Date,
      preview: string,
      messageDelta: number,
    ) => ({
      id: sessionId,
      title: nextTitle,
      updatedAt: updatedAt.toISOString(),
      modelProvider: model.provider,
      modelName: model.modelName,
      messageCount: sessionMessageCount + messageDelta,
      lastMessagePreview: preview,
    });

    // 起始事件：把消息/会话 id 先告诉前端，便于其创建占位的 assistant 气泡。
    writeSseEvent(raw, {
      type: "start",
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      model: { provider: model.provider, name: model.modelName },
      session: buildSessionPayload(now, previewFromText(prompt), 1),
    });

    void (async () => {
      try {
        const result = streamText({
          model: buildDeepSeekLanguageModel({
            apiKey,
            baseUrl: model.baseUrl,
            modelName: model.modelName,
          }),
          system: systemPrompt,
          messages,
          tools: toolRegistry.tools,
          stopWhen: stepCountIs(5),
          // 平滑分块 + 小延迟，让前端呈现自然的打字机节奏（中文逐字、英文逐词）。
          experimental_transform: smoothStream({
            delayInMs: 12,
            chunking: typewriterChunking,
          }),
          abortSignal: abortController.signal,
        });

        // 逐段把文本增量推给前端。
        for await (const delta of result.textStream) {
          if (delta) {
            writeSseEvent(raw, { type: "delta", text: delta });
          }
        }

        const [finalText, steps, usage] = await Promise.all([
          result.text,
          result.steps,
          result.totalUsage,
        ]);

        const completedAt = new Date();
        const assistantText = finalText.trim() || "模型返回了空响应。";
        const assistantParts = [{ type: "text", text: assistantText }];
        const persistedToolCalls = await persistToolCalls({
          steps,
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
              promptTokens: tokenCount(usage.inputTokens),
              completionTokens: tokenCount(usage.outputTokens),
              totalTokens: tokenCount(usage.totalTokens),
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

        // 终止事件：下发最终文本、工具调用与会话元信息，前端据此定稿气泡。
        writeSseEvent(raw, {
          type: "done",
          id: assistantMessageId,
          sessionId,
          role: "assistant",
          parts: assistantParts,
          createdAt: completedAt.toISOString(),
          model: { provider: model.provider, name: model.modelName },
          toolCalls: persistedToolCalls.map((toolCall) => ({
            id: toolCall.id,
            toolCallId: toolCall.toolCallId,
            name: toolCall.toolName,
            source: toolCall.toolSource,
            riskLevel: toolCall.riskLevel,
            status: toolCall.status,
            requiresApproval: toolCall.requiresApproval,
          })),
          session: buildSessionPayload(
            completedAt,
            previewFromText(assistantText),
            2,
          ),
        });
      } catch (error) {
        const failedAt = new Date();
        const message = errorMessage(error);

        request.log.error({ err: error }, "deepseek model stream failed");

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

        // 错误事件：前端据此提示失败并回收占位气泡。
        writeSseEvent(raw, {
          type: "error",
          error: "Model call failed",
          message,
        });
      } finally {
        // 结束 SSE 流；push(null) 触发底层响应的 end。
        raw.end();
      }
    })();
  });
}
