import type {
  AuthStatusResponse,
  AuthUser,
  ClientPlatform,
} from "@muse/shared";

const TOKEN_KEY = "muse.auth.token";

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

  return {
    authHeaders,
    clearToken,
    devLogin,
    fetchMe,
    loadToken,
    logout,
    pollChallengeStatus,
    saveToken,
    startFeishuChallenge,
  };
}
