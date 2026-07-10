import type { ModelCapabilities } from "./capabilities.js";

export type ModelProviderConfig = {
  apiKey?: string;
  baseURL?: string;
};

export type ModelProvider = {
  id: string;
  name: string;
  createModel: (modelName: string) => unknown;
  capabilities: ModelCapabilities;
};

export class ModelRouter {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
    return this;
  }

  getProvider(providerId: string) {
    const provider = this.providers.get(providerId);

    if (!provider) {
      throw new Error(`Model provider is not registered: ${providerId}`);
    }

    return provider;
  }

  createModel(providerId: string, modelName: string) {
    return this.getProvider(providerId).createModel(modelName);
  }

  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      capabilities: provider.capabilities,
    }));
  }
}
