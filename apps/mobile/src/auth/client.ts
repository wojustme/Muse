import { createMuseApiClient, type ChallengeResult } from "@muse/api-client";
import { detectPlatform } from "../platform";
import { resolveServerUrl } from "../config/server-url";

// 移动端 API client。
// serverUrl 是用户可配的（真机需填局域网 IP），因此按当前 serverUrl 惰性构建并缓存；
// 地址变化时自动重建，token 仍由底层 client 存 localStorage。
type MuseApiClient = ReturnType<typeof createMuseApiClient>;

let cachedUrl: string | null = null;
let cachedClient: MuseApiClient | null = null;

function client(): MuseApiClient {
  const url = resolveServerUrl();
  if (!cachedClient || cachedUrl !== url) {
    cachedUrl = url;
    cachedClient = createMuseApiClient({
      platform: detectPlatform(),
      serverUrl: url,
    });
  }
  return cachedClient;
}

export function authHeaders(): Record<string, string> {
  return client().authHeaders();
}

export function loadToken(): string | null {
  return client().loadToken();
}

export function saveToken(token: string): void {
  client().saveToken(token);
}

export function clearToken(): void {
  client().clearToken();
}

export function startFeishuChallenge(): Promise<ChallengeResult> {
  return client().startFeishuChallenge();
}

export function pollChallengeStatus(state: string) {
  return client().pollChallengeStatus(state);
}

export function fetchMe() {
  return client().fetchMe();
}

export function devLogin() {
  return client().devLogin();
}

export function logout() {
  return client().logout();
}

export function postApprovalDecision(
  approvalId: string,
  decision: "approved" | "rejected",
) {
  return client().postApprovalDecision(approvalId, decision);
}

export function loadClientId() {
  return client().loadClientId();
}

export function eventsUrl(clientId: string) {
  return client().eventsUrl(clientId);
}

export function postActiveSession(clientId: string, sessionId: string | null) {
  return client().postActiveSession(clientId, sessionId);
}

export type { ChallengeResult } from "@muse/api-client";
