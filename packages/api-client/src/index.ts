import type {
  AuthStatusResponse,
  AuthUser,
  ClientPlatform,
} from "@muse/shared";

const TOKEN_KEY = "muse.auth.token";
const CLIENT_ID_KEY = "muse.clientId";

export type MuseApiClientOptions = {
  serverUrl: string;
  platform: ClientPlatform;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

export type ChallengeResult = {
  state: string;
  authUrl: string;
  expiresAt: string;
};

export type DevLoginResult = {
  token: string;
  user: AuthUser;
};

export type ApprovalDecisionResult = {
  ok: boolean;
  settled: boolean;
};

function resolveStorage(
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (storage) {
    return storage;
  }

  if (typeof localStorage === "undefined") {
    return null;
  }

  return localStorage;
}

export function createMuseApiClient(options: MuseApiClientOptions) {
  const storage = resolveStorage(options.storage);

  function loadToken(): string | null {
    return storage?.getItem(TOKEN_KEY) ?? null;
  }

  function saveToken(token: string): void {
    storage?.setItem(TOKEN_KEY, token);
  }

  function clearToken(): void {
    storage?.removeItem(TOKEN_KEY);
  }

  function authHeaders(): Record<string, string> {
    const token = loadToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  // 稳定的客户端标识：用于事件流去重（exceptClientId）与上报当前会话。
  function loadClientId(): string {
    const existing = storage?.getItem(CLIENT_ID_KEY);
    if (existing) {
      return existing;
    }
    const next =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storage?.setItem(CLIENT_ID_KEY, next);
    return next;
  }

  // 事件流 URL（GET /api/events?clientId=...）。用 fetch+ReadableStream 消费，
  // 因原生 EventSource 不支持自定义 Authorization 头。
  function eventsUrl(clientId: string): string {
    return `${options.serverUrl}/api/events?clientId=${encodeURIComponent(clientId)}`;
  }

  // 上报当前打开的会话页；sessionId 为 null 表示离开会话页。best-effort，不抛错。
  async function postActiveSession(
    clientId: string,
    sessionId: string | null,
  ): Promise<void> {
    try {
      await fetch(`${options.serverUrl}/api/events/active`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ clientId, sessionId }),
      });
    } catch {
      // 网络抖动时忽略，下次切换会话会再次上报。
    }
  }

  async function startFeishuChallenge(): Promise<ChallengeResult> {
    const response = await fetch(
      `${options.serverUrl}/api/auth/feishu/challenge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: options.platform }),
      },
    );

    if (!response.ok) {
      throw new Error(`发起登录失败（${response.status}）`);
    }

    return (await response.json()) as ChallengeResult;
  }

  async function pollChallengeStatus(
    state: string,
  ): Promise<AuthStatusResponse> {
    const response = await fetch(
      `${options.serverUrl}/api/auth/challenge/status?state=${encodeURIComponent(
        state,
      )}`,
    );

    if (!response.ok) {
      throw new Error(`轮询登录状态失败（${response.status}）`);
    }

    return (await response.json()) as AuthStatusResponse;
  }

  async function fetchMe(): Promise<AuthUser | null> {
    const token = loadToken();
    if (!token) {
      return null;
    }

    const response = await fetch(`${options.serverUrl}/api/auth/me`, {
      headers: authHeaders(),
    });

    if (response.status === 401) {
      clearToken();
      return null;
    }

    if (!response.ok) {
      throw new Error(`获取用户信息失败（${response.status}）`);
    }

    const data = (await response.json()) as { user: AuthUser };
    return data.user;
  }

  async function devLogin(): Promise<DevLoginResult> {
    const response = await fetch(`${options.serverUrl}/api/auth/dev`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`开发登录失败（${response.status}）`);
    }

    const data = (await response.json()) as DevLoginResult;
    saveToken(data.token);
    return data;
  }

  async function logout(): Promise<void> {
    try {
      await fetch(`${options.serverUrl}/api/auth/logout`, {
        method: "POST",
        headers: authHeaders(),
      });
    } finally {
      clearToken();
    }
  }

  // 回传本地工具审批决策（手机端 HTTP 通道）。settled=false 表示已被其他端先定（竞态）。
  async function postApprovalDecision(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<ApprovalDecisionResult> {
    const response = await fetch(`${options.serverUrl}/api/chat/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ approvalId, decision }),
    });

    if (!response.ok) {
      throw new Error(`提交审批决定失败（${response.status}）`);
    }

    return (await response.json()) as ApprovalDecisionResult;
  }

  return {
    authHeaders,
    clearToken,
    devLogin,
    eventsUrl,
    fetchMe,
    loadClientId,
    loadToken,
    logout,
    postActiveSession,
    postApprovalDecision,
    pollChallengeStatus,
    saveToken,
    startFeishuChallenge,
  };
}
