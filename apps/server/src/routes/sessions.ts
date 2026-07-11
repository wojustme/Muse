import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";
import { db } from "../db/client.js";
import { chatMessages, chatSessions } from "../db/schema.js";
import {
  getAuthorizedModel,
  getDefaultAuthorizedModel,
  type AuthorizedModel,
} from "../models/authorized.js";

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
});

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  model: modelSelectionSchema.optional(),
});

const sessionParamsSchema = z.object({
  id: z.string().min(1),
});

function serializeSession(row: typeof chatSessions.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    modelProvider: row.modelProvider ?? undefined,
    modelName: row.modelName ?? undefined,
    aiModelId: row.aiModelId ?? undefined,
    pinned: row.pinned,
    messageCount: row.messageCount,
    lastMessagePreview: row.lastMessagePreview ?? undefined,
    lastMessageAt: row.lastMessageAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function safeParseParts(raw: string | null, fallback: string) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to a text part when persisted parts are malformed.
    }
  }

  return [{ type: "text", text: fallback }];
}

async function resolveModel(
  userId: string,
  selection?: z.infer<typeof modelSelectionSchema>,
): Promise<AuthorizedModel | null> {
  if (selection) {
    return getAuthorizedModel(userId, selection);
  }

  return getDefaultAuthorizedModel(userId);
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/sessions", { preHandler: requireAuth }, async (request) => {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.userId, request.userId as string),
          eq(chatSessions.status, "active"),
        ),
      )
      .orderBy(desc(chatSessions.pinned), desc(chatSessions.updatedAt));

    return { sessions: rows.map(serializeSession) };
  });

  app.post("/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid session request",
        issues: parsed.error.flatten(),
      });
    }

    const userId = request.userId as string;
    const model = await resolveModel(userId, parsed.data.model);

    if (!model) {
      return reply.status(403).send({ error: "No authorized model available" });
    }

    const now = new Date();
    const session = {
      id: randomUUID(),
      userId,
      title: parsed.data.title ?? "新对话",
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
    };

    await db.insert(chatSessions).values(session);

    return reply.send({ session: serializeSession(session) });
  });

  app.get(
    "/sessions/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.status(400).send({ error: "Invalid session id" });
      }

      const userId = request.userId as string;
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, params.data.id),
            eq(chatSessions.userId, userId),
            eq(chatSessions.status, "active"),
          ),
        )
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.sessionId, session.id),
            eq(chatMessages.userId, userId),
          ),
        )
        .orderBy(asc(chatMessages.createdAt));

      return {
        session: serializeSession(session),
        messages: rows.map((message) => ({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          parts: safeParseParts(message.parts, message.content),
          status: message.status,
          createdAt: message.createdAt.toISOString(),
          updatedAt: message.updatedAt.toISOString(),
        })),
      };
    },
  );

  app.get("/sessions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.status(400).send({ error: "Invalid session id" });
    }

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, params.data.id),
          eq(chatSessions.userId, request.userId as string),
          eq(chatSessions.status, "active"),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    return reply.send({ session: serializeSession(session) });
  });
}
