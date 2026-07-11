import type { AuthProvider } from "@muse/shared";
import type {
  AuthProviderAdapter,
  BuildAuthUrlInput,
  ExchangeTokenInput,
  NormalizedProfile,
  ProviderToken,
} from "../provider.js";

// 飞书 OAuth 端点（已核对开放平台文档）。
const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

type FeishuConfig = {
  appId: string;
  appSecret: string;
};

type FeishuTokenResponse = {
  code?: number;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  open_id?: string;
};

type FeishuUserInfoResponse = {
  code: number;
  msg?: string;
  data?: {
    open_id?: string;
    union_id?: string;
    tenant_key?: string;
    name?: string;
    avatar_url?: string;
  };
};

export class FeishuAdapter implements AuthProviderAdapter {
  readonly id: AuthProvider = "feishu";
  readonly usesPkce = false;

  constructor(private readonly config: FeishuConfig) {}

  buildAuthUrl(input: BuildAuthUrlInput): string {
    const params = new URLSearchParams({
      app_id: this.config.appId,
      redirect_uri: input.redirectUri,
      state: input.state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeToken(input: ExchangeTokenInput): Promise<ProviderToken> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });

    const data = (await response.json()) as FeishuTokenResponse;

    if (!response.ok || !data.access_token) {
      throw new Error(
        `Feishu token exchange failed: ${data.error ?? data.code ?? response.status} ${
          data.error_description ?? ""
        }`.trim(),
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      openId: data.open_id,
      raw: data,
    };
  }

  async fetchUserInfo(token: ProviderToken): Promise<NormalizedProfile> {
    const response = await fetch(USER_INFO_URL, {
      headers: { authorization: `Bearer ${token.accessToken}` },
    });

    const body = (await response.json()) as FeishuUserInfoResponse;

    if (!response.ok || body.code !== 0 || !body.data) {
      throw new Error(
        `Feishu user_info failed: ${body.code} ${body.msg ?? response.status}`,
      );
    }

    const data = body.data;
    const providerUid = data.union_id ?? data.open_id ?? token.openId;

    if (!providerUid) {
      throw new Error("Feishu user_info missing union_id/open_id");
    }

    return {
      providerUid,
      unionId: data.union_id,
      tenantId: data.tenant_key,
      displayName: data.name,
      avatarUrl: data.avatar_url,
      raw: body,
    };
  }
}
