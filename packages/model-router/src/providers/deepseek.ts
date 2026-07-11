import { createOpenAI } from "@ai-sdk/openai";
import { defaultCapabilities } from "../capabilities.js";
import type { ModelProvider, ModelProviderConfig } from "../model-router.js";

async function deepSeekCompatibleFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (typeof init?.body !== "string") {
    return fetch(input, init);
  }

  try {
    const body = JSON.parse(init.body) as {
      messages?: Array<{ role?: string }>;
    };

    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (message.role === "developer") {
          message.role = "system";
        }
      }

      return fetch(input, {
        ...init,
        body: JSON.stringify(body),
      });
    }
  } catch {
    // If the body is not JSON, forward it unchanged.
  }

  return fetch(input, init);
}

export function createDeepSeekProvider(
  config: ModelProviderConfig = {},
): ModelProvider {
  const deepseek = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://api.deepseek.com",
    fetch: deepSeekCompatibleFetch,
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
