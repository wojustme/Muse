import { createOpenAI } from "@ai-sdk/openai";
import { defaultCapabilities } from "../capabilities.js";
import type { ModelProvider, ModelProviderConfig } from "../model-router.js";

export function createDeepSeekProvider(
  config: ModelProviderConfig = {},
): ModelProvider {
  const deepseek = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://api.deepseek.com",
  });

  return {
    id: "deepseek",
    name: "DeepSeek",
    createModel: (modelName) => deepseek.chat(modelName),
    capabilities: {
      ...defaultCapabilities,
      tools: true,
    },
  };
}
