import type { AuthStatusResponse, AuthUser, ClientPlatform } from "@muse/shared";

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:8787";

// 桌面端固定平台标识；后续多端复用同一套 client 时再参数化。
const PLATFORM: ClientPlatform = "macos";

const TOKEN_KEY = "muse.auth.token";

// 登录态 token 存本地（P1a 用 localStorage；后续可换 Tauri secure store）。
export function loadToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// 给业务请求加上 Authorization 头。
export function authHeaders(): Record<string, string> {
  const token = loadToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export type ChallengeResult = {
  state: string;
  authUrl: string;
  expiresAt: string;
};

// 发起飞书扫码登录：建 challenge，拿到 authUrl 与 state。
export async function startFeishuChallenge(): Promise<ChallengeResult> {
  const response = await fetch(`${serverUrl}/api/auth/feishu/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: PLATFORM }),
  });
  if (!response.ok) {
    throw new Error(`发起登录失败（${response.status}）`);
  }
  return (await response.json()) as ChallengeResult;
}

// 轮询扫码结果。
export async function pollChallengeStatus(
  state: string,
): Promise<AuthStatusResponse> {
  const response = await fetch(
    `${serverUrl}/api/auth/challenge/status?state=${encodeURIComponent(state)}`,
  );
  if (!response.ok) {
    throw new Error(`轮询登录状态失败（${response.status}）`);
  }
  return (await response.json()) as AuthStatusResponse;
}

// 取当前用户。token 失效返回 null。
export async function fetchMe(): Promise<AuthUser | null> {
  const token = loadToken();
  if (!token) {
    return null;
  }
  const response = await fetch(`${serverUrl}/api/auth/me`, {
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

// 登出：吊销服务端 session 并清本地 token。
export async function logout(): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/auth/logout`, {
      method: "POST",
      headers: authHeaders(),
    });
  } finally {
    clearToken();
  }
}
