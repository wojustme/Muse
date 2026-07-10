import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";

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

export async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid chat request",
        issues: parsed.error.flatten(),
      });
    }

    const prompt = parsed.data.message.parts
      .map((part) => part.text)
      .join("\n")
      .trim();

    return {
      id: randomUUID(),
      sessionId: parsed.data.sessionId,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Muse server is ready. AI streaming will be wired next. You said: ${prompt}`,
        },
      ],
    };
  });
}
