import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { aiModels, userAiModels } from "../db/schema.js";

export type AuthorizedModel = {
  id: string;
  provider: string;
  modelName: string;
  displayName: string;
  apiKey: string | null;
  baseUrl: string | null;
};

export type ModelSelection = {
  provider: string;
  name: string;
};

const authorizedModelSelection = {
  id: aiModels.id,
  provider: aiModels.provider,
  modelName: aiModels.modelName,
  displayName: aiModels.displayName,
  apiKey: aiModels.apiKey,
  baseUrl: aiModels.baseUrl,
};

export async function getDefaultAuthorizedModel(
  userId: string,
): Promise<AuthorizedModel | null> {
  const [model] = await db
    .select(authorizedModelSelection)
    .from(aiModels)
    .innerJoin(userAiModels, eq(userAiModels.aiModelId, aiModels.id))
    .where(and(eq(aiModels.enabled, true), eq(userAiModels.userId, userId)))
    .orderBy(asc(aiModels.provider), asc(aiModels.modelName))
    .limit(1);

  return model ?? null;
}

export async function getAuthorizedModel(
  userId: string,
  selection: ModelSelection,
): Promise<AuthorizedModel | null> {
  const [model] = await db
    .select(authorizedModelSelection)
    .from(aiModels)
    .innerJoin(userAiModels, eq(userAiModels.aiModelId, aiModels.id))
    .where(
      and(
        eq(aiModels.enabled, true),
        eq(userAiModels.userId, userId),
        eq(aiModels.provider, selection.provider),
        eq(aiModels.modelName, selection.name),
      ),
    )
    .limit(1);

  return model ?? null;
}
