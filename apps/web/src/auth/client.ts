import { createMuseApiClient } from "@muse/api-client";

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:8787";

export const {
  authHeaders,
  clearToken,
  devLogin,
  fetchMe,
  loadToken,
  logout,
  pollChallengeStatus,
  saveToken,
  startFeishuChallenge,
} = createMuseApiClient({
  platform: "web",
  serverUrl,
});

export type { ChallengeResult } from "@muse/api-client";
