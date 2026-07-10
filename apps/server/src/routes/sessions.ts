import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/guard.js";

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/sessions", { preHandler: requireAuth }, async () => {
    return { sessions: [] };
  });

  app.post("/sessions", { preHandler: requireAuth }, async () => {
    return {
      session: {
        id: randomUUID(),
        title: "New chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  });
}
