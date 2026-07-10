import { createOpenAI } from "@ai-sdk/openai";
import { defaultCapabilities } from "../capabilities.js";
import type { ModelProvider, ModelProviderConfig } from "../model-router.js";

export function createOpenAIProvider(
  config: ModelProviderConfig = {},
): ModelProvider {
  const openai = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return {
    id: "openai",
    name: "OpenAI",
    createModel: (modelName) => openai(modelName),
    capabilities: {
      ...defaultCapabilities,
      tools: true,
      vision: true,
      reasoning: true,
    },
  };
}
