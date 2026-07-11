import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { FastifyInstance } from "fastify";
import { createDeepSeekProvider } from "@muse/model-router";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";
import { db } from "../db/client.js";
import { chatMessages, chatSessions, modelRuns } from "../db/schema.js";
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
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, parsed.data.sessionId),
          eq(chatSessions.userId, userId),
          eq(chatSessions.status, "active"),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    const modelSelection =
      parsed.data.model ??
      (session.modelProvider && session.modelName
        ? {
            provider: session.modelProvider,
            name: session.modelName,
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
    const nextTitle =
      session.messageCount === 0 ? titleFromPrompt(prompt) : session.title;
    const history = await loadSessionHistory({
      sessionId: session.id,
      userId,
    });
    const messages: ModelMessage[] = [
      ...history,
      {
        role: "user",
        content: prompt,
      },
    ];

    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({
        id: userMessageId,
        sessionId: session.id,
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
        sessionId: session.id,
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
        messages,
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
            messageCount: session.messageCount + 1,
            lastMessagePreview: previewFromText(prompt),
            lastMessageAt: failedAt,
            updatedAt: failedAt,
          })
          .where(eq(chatSessions.id, session.id));
      });

      return reply.status(502).send({
        error: "Model call failed",
        message,
      });
    }

    const completedAt = new Date();
    const assistantText = result.text.trim() || "模型返回了空响应。";
    const assistantParts = [{ type: "text", text: assistantText }];

    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({
        id: assistantMessageId,
        sessionId: session.id,
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
          messageCount: session.messageCount + 2,
          lastMessagePreview: previewFromText(assistantText),
          lastMessageAt: completedAt,
          updatedAt: completedAt,
        })
        .where(eq(chatSessions.id, session.id));
    });

    return {
      id: assistantMessageId,
      sessionId: session.id,
      role: "assistant",
      parts: assistantParts,
      createdAt: completedAt.toISOString(),
      model: {
        provider: model.provider,
        name: model.modelName,
      },
      session: {
        id: session.id,
        title: nextTitle,
        updatedAt: completedAt.toISOString(),
        modelProvider: model.provider,
        modelName: model.modelName,
        messageCount: session.messageCount + 2,
        lastMessagePreview: previewFromText(assistantText),
      },
    };
  });
}
