import { and, asc, desc, eq, like } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/client.js";
import { chatMessages, chatSessions } from "../../db/schema.js";
import type { ToolExecutionContext } from "../types.js";

const limitSchema = z.number().int().min(1).max(50).default(10);

function serializeSession(row: typeof chatSessions.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    model: {
      provider: row.modelProvider,
      name: row.modelName,
    },
    messageCount: row.messageCount,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageAt: row.lastMessageAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeMessage(row: typeof chatMessages.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getOwnedSession(input: { sessionId: string; userId: string }) {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, input.sessionId),
        eq(chatSessions.userId, input.userId),
        eq(chatSessions.status, "active"),
      ),
    )
    .limit(1);

  return session ?? null;
}

export function createSessionTools(context: ToolExecutionContext) {
  return {
    muse_session_current: tool({
      description:
        "Get metadata for the current Muse chat session, including title, selected model, message count, and update time.",
      inputSchema: z.object({}),
      execute: async () => {
        const session = await getOwnedSession({
          sessionId: context.sessionId,
          userId: context.userId,
        });

        if (!session) {
          return { found: false, session: null };
        }

        return { found: true, session: serializeSession(session) };
      },
    }),

    muse_session_messages: tool({
      description:
        "List recent messages from the current Muse chat session. Use this to inspect earlier conversation turns.",
      inputSchema: z.object({
        limit: limitSchema.describe("Maximum number of recent messages."),
      }),
      execute: async ({ limit }) => {
        const session = await getOwnedSession({
          sessionId: context.sessionId,
          userId: context.userId,
        });

        if (!session) {
          return { found: false, messages: [] };
        }

        const rows = await db
          .select()
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, context.sessionId),
              eq(chatMessages.userId, context.userId),
              eq(chatMessages.status, "completed"),
            ),
          )
          .orderBy(desc(chatMessages.createdAt))
          .limit(limit);

        return {
          found: true,
          messages: rows.reverse().map(serializeMessage),
        };
      },
    }),

    muse_search_messages: tool({
      description:
        "Search the current user's Muse chat messages by keyword. Use this when the user asks to find prior discussion or recall previous context.",
      inputSchema: z.object({
        query: z.string().trim().min(1).describe("Keyword to search for."),
        limit: limitSchema.describe("Maximum number of search results."),
        currentSessionOnly: z
          .boolean()
          .default(false)
          .describe("When true, search only the current session."),
      }),
      execute: async ({ query, limit, currentSessionOnly }) => {
        const filters = [
          eq(chatMessages.userId, context.userId),
          eq(chatMessages.status, "completed"),
          like(chatMessages.content, `%${query}%`),
        ];

        if (currentSessionOnly) {
          filters.push(eq(chatMessages.sessionId, context.sessionId));
        }

        const rows = await db
          .select()
          .from(chatMessages)
          .where(and(...filters))
          .orderBy(desc(chatMessages.createdAt))
          .limit(limit);

        return {
          query,
          results: rows.map(serializeMessage),
        };
      },
    }),
  };
}
