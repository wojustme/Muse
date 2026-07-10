import type { AuthProvider } from "@muse/shared";

// provider 换取到的原始 token（各家差异封装在适配器内部）。
export type ProviderToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  openId?: string;
  raw: unknown;
};

// 归一化后的用户资料，供上层统一处理。
export type NormalizedProfile = {
  providerUid: string; // provider 平台用户唯一 ID
  unionId?: string; // 有则优先作为身份锚点
  tenantId?: string; // 飞书 tenant_key 等
  displayName?: string;
  avatarUrl?: string;
  raw: unknown;
};

export type BuildAuthUrlInput = {
  state: string;
  redirectUri: string;
  codeChallenge?: string;
};

export type ExchangeTokenInput = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
};

// 第三方登录 provider 适配器。加一个 provider = 实现一个适配器。
export interface AuthProviderAdapter {
  readonly id: AuthProvider;
  // 是否需要 PKCE（飞书需要，其余不需要）。
  readonly usesPkce: boolean;
  buildAuthUrl(input: BuildAuthUrlInput): string;
  exchangeToken(input: ExchangeTokenInput): Promise<ProviderToken>;
  fetchUserInfo(token: ProviderToken): Promise<NormalizedProfile>;
  // identity_key：unionId 优先，见 docs/auth-implementation-plan.md 第 3 节。
  buildIdentityKey(profile: NormalizedProfile): string;
}

const registry = new Map<AuthProvider, AuthProviderAdapter>();

export function registerAuthProvider(adapter: AuthProviderAdapter) {
  registry.set(adapter.id, adapter);
}

export function getAuthProvider(id: AuthProvider): AuthProviderAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`Auth provider is not registered or not configured: ${id}`);
  }
  return adapter;
}

export function isAuthProviderEnabled(id: AuthProvider): boolean {
  return registry.has(id);
}

export function listEnabledProviders(): AuthProvider[] {
  return [...registry.keys()];
}
