import { createOpenAI } from "@ai-sdk/openai";
import { defaultCapabilities } from "../capabilities.js";
import type { ModelProvider, ModelProviderConfig } from "../model-router.js";

export function createGlmProvider(
  config: ModelProviderConfig = {},
): ModelProvider {
  const glm = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://open.bigmodel.cn/api/paas/v4",
  });

  return {
    id: "glm",
    name: "GLM",
    createModel: (modelName) => glm(modelName),
    capabilities: {
      ...defaultCapabilities,
      tools: true,
    },
  };
}
