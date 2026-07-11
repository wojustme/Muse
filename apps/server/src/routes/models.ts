import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/guard.js";
import { db } from "../db/client.js";
import { aiModels, userAiModels } from "../db/schema.js";

export async function modelRoutes(app: FastifyInstance) {
  app.get("/models", { preHandler: requireAuth }, async (request) => {
    const rows = await db
      .select({
        provider: aiModels.provider,
        modelName: aiModels.modelName,
        displayName: aiModels.displayName,
      })
      .from(aiModels)
      .innerJoin(userAiModels, eq(userAiModels.aiModelId, aiModels.id))
      .where(
        and(
          eq(aiModels.enabled, true),
          eq(userAiModels.userId, request.userId as string),
        ),
      )
      .orderBy(asc(aiModels.provider), asc(aiModels.modelName));

    const models = rows.map((model) => ({
      provider: model.provider,
      name: model.modelName,
      displayName: model.displayName,
    }));

    return { models };
  });
}
