import { and, asc, eq } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/client.js";
import { aiModels, userAiModels } from "../../db/schema.js";
import type { ToolExecutionContext } from "../types.js";

export function createModelTools(context: ToolExecutionContext) {
  return {
    model_list_available: tool({
      description:
        "List AI models currently available to the authenticated Muse user. Use this when the user asks which models can be used.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db
          .select({
            id: aiModels.id,
            provider: aiModels.provider,
            name: aiModels.modelName,
            displayName: aiModels.displayName,
            baseUrl: aiModels.baseUrl,
          })
          .from(aiModels)
          .innerJoin(userAiModels, eq(userAiModels.aiModelId, aiModels.id))
          .where(
            and(
              eq(aiModels.enabled, true),
              eq(userAiModels.userId, context.userId),
            ),
          )
          .orderBy(asc(aiModels.provider), asc(aiModels.modelName));

        return {
          models: rows.map((model) => ({
            provider: model.provider,
            name: model.name,
            displayName: model.displayName,
            hasCustomBaseUrl: Boolean(model.baseUrl),
          })),
        };
      },
    }),
  };
}
