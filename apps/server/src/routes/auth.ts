import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  authChallengeRequestSchema,
  authProviderSchema,
  type AuthProvider,
  type AuthStatusResponse,
  type ClientPlatform,
} from "@muse/shared";
import { env } from "../config/env.js";
import { generatePkce, generateState } from "../auth/challenge.js";
import { optionalAuth, requireAuth, getBearerToken } from "../auth/guard.js";
import { IdentityConflictError, resolveIdentity } from "../auth/identity.js";
import { getAuthProvider, isAuthProviderEnabled } from "../auth/provider.js";
import {
  buildAuthUser,
  createSession,
  revokeSession,
} from "../auth/session.js";
import { db } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";

type ChallengeState =
  "pending" | "authorized" | "failed" | "consumed" | "expired";

type LoginChallenge = {
  state: string;
  provider: AuthProvider;
  clientPlatform: ClientPlatform;
  codeVerifier?: string;
  status: ChallengeState;
  userId?: string;
  errorCode?: string;
  sessionToken?: string;
  expiresAt: Date;
};

const loginChallenges = new Map<string, LoginChallenge>();

function cleanupExpiredChallenges() {
  const now = Date.now();
  for (const [state, challenge] of loginChallenges) {
    if (
      challenge.expiresAt.getTime() <= now ||
      challenge.status === "consumed"
    ) {
      loginChallenges.delete(state);
    }
  }
}

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCallbackPage(input: {
  message: string;
  status: "success" | "failed";
}): string {
  const frontendURL = env.FRONTEND_BASE_URL;
  const safeMessage = escapeHTML(input.message);
  const payload = JSON.stringify({
    type: "muse-auth-callback",
    status: input.status,
  });

  // 与客户端「暖米黄创作工作台」主题保持一致：暖纸底 + 靛紫渐变品牌标记。
  const isSuccess = input.status === "success";
  const title = isSuccess ? "登录成功" : "登录未完成";
  const museMark = `<svg width="52" height="52" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="tile" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#8B7CFF"/><stop offset="1" stop-color="#6FB0FF"/></linearGradient><linearGradient id="glass" x1="0.5" x2="0.5" y1="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.98"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.82"/></linearGradient></defs><rect x="1" y="1" width="46" height="46" rx="13" fill="url(#tile)"/><rect x="1" y="1" width="46" height="22" rx="13" fill="#FFFFFF" opacity="0.14"/><path d="M12 34 L12 17 Q12 14 15 15.4 L24 21 L33 15.4 Q36 14 36 17 L36 34" fill="none" stroke="url(#glass)" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 9 L36.4 12.2 L39.6 13.6 L36.4 15 L35 18.2 L33.6 15 L30.4 13.6 L33.6 12.2 Z" fill="#F5C97B"/></svg>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;color:#3a3320;background:radial-gradient(900px 520px at 50% -10%,rgba(139,124,255,0.16),transparent 60%),radial-gradient(700px 480px at 50% 110%,rgba(111,176,255,0.12),transparent 62%),#f4efdf}main{display:grid;justify-items:center;gap:16px;width:min(380px,calc(100% - 48px));padding:38px 32px;border:1px solid rgba(74,58,20,0.18);border-radius:22px;background:#fffdf7;box-shadow:0 18px 48px rgba(74,58,20,0.16),0 0 0 1px rgba(109,91,214,0.10);text-align:center}.mark{display:grid;place-items:center}h2,p{margin:0}h2{font-size:21px;font-weight:780;color:#3a3320}p{color:#726a52;font-size:14px;line-height:1.6;max-width:290px}a{display:inline-flex;align-items:center;justify-content:center;width:100%;height:44px;padding:0 18px;border-radius:12px;color:#fff;background:linear-gradient(135deg,#8b7cff 0%,#6fb0ff 100%);text-decoration:none;font-size:14px;font-weight:720;letter-spacing:0.2px;box-shadow:0 8px 22px rgba(139,124,255,0.32)}.hint{display:inline-flex;align-items:center;gap:8px;color:#6d5bd6;font-size:13px;font-weight:600}.spin{width:16px;height:16px;border-radius:999px;border:2px solid rgba(109,91,214,0.25);border-top-color:#6d5bd6;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><main><span class="mark">${museMark}</span><h2>${title}</h2><p>${safeMessage}</p>${
    isSuccess
      ? `<span class="hint"><span class="spin"></span>正在返回 Muse…</span>`
      : ""
  }<a href="${frontendURL}">返回 Muse</a></main><script>const target=${JSON.stringify(frontendURL)};try{if(window.opener){window.opener.postMessage(${payload},target);window.close();}}catch(error){}setTimeout(()=>{window.location.replace(target);},1200);</script></body></html>`;
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/dev", async (request, reply) => {
    if (!env.AUTH_DEV_MOCK) {
      return reply.status(404).send({ error: "Dev auth is not enabled" });
    }

    const now = new Date();
    const [existingIdentity] = await db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, "feishu"),
          eq(userIdentities.providerTenantId, "local"),
          eq(userIdentities.providerUserId, "dev-local"),
        ),
      )
      .limit(1);

    let userId = existingIdentity?.userId;

    if (!userId) {
      userId = crypto.randomUUID();

      await db.insert(users).values({
        id: userId,
        displayName: env.AUTH_DEV_MOCK_NAME,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });

      await db.insert(userIdentities).values({
        id: crypto.randomUUID(),
        userId,
        provider: "feishu",
        providerUserId: "dev-local",
        providerTenantId: "local",
        displayName: env.AUTH_DEV_MOCK_NAME,
        rawProfile: JSON.stringify({ source: "AUTH_DEV_MOCK" }),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      });
    } else {
      await db
        .update(users)
        .set({
          displayName: env.AUTH_DEV_MOCK_NAME,
          updatedAt: now,
          lastLoginAt: now,
        })
        .where(eq(users.id, userId));
    }

    const session = await createSession({
      userId,
      clientPlatform: "web",
    });
    const user = await buildAuthUser(userId);

    return reply.send({
      token: session.token,
      expiresAt: session.expiresAt,
      user,
    });
  });

  // 发起扫码/授权：创建进程内短 TTL challenge，返回 authUrl + state。
  // 携带有效 bearer 时视为"绑定"（把新 provider 绑到当前账号）。
  app.post(
    "/auth/:provider/challenge",
    { preHandler: optionalAuth },
    async (request, reply) => {
      cleanupExpiredChallenges();

      const providerParsed = authProviderSchema.safeParse(
        (request.params as { provider: string }).provider,
      );
      if (!providerParsed.success) {
        return reply.status(400).send({ error: "Unknown provider" });
      }
      const provider = providerParsed.data;

      if (!isAuthProviderEnabled(provider)) {
        return reply
          .status(404)
          .send({ error: `Provider not enabled: ${provider}` });
      }

      const bodyParsed = authChallengeRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: "Invalid challenge request",
          issues: bodyParsed.error.flatten(),
        });
      }

      const adapter = getAuthProvider(provider);
      const state = generateState();
      const redirectUri = `${env.PUBLIC_BASE_URL}/api/auth/${provider}/callback`;

      let codeVerifier: string | undefined;
      let codeChallenge: string | undefined;
      if (adapter.usesPkce) {
        const pkce = generatePkce();
        codeVerifier = pkce.codeVerifier;
        codeChallenge = pkce.codeChallenge;
      }

      const authUrl = adapter.buildAuthUrl({
        state,
        redirectUri,
        codeChallenge,
      });
      const expiresAt = new Date(
        Date.now() + env.LOGIN_CHALLENGE_TTL_SECONDS * 1000,
      );

      loginChallenges.set(state, {
        state,
        provider,
        clientPlatform: bodyParsed.data.platform,
        codeVerifier,
        status: "pending",
        // 绑定模式：把当前登录用户带到 callback。
        userId: request.userId,
        expiresAt,
      });

      return reply.send({ state, authUrl, expiresAt: expiresAt.toISOString() });
    },
  );

  // provider 回调：换 token -> 拉资料 -> 判定 -> 签发 session -> 回填进程内 challenge。
  app.get("/auth/:provider/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    reply.header("content-type", "text/html; charset=utf-8");

    if (!query.state) {
      return reply.status(400).send(
        renderCallbackPage({
          message: "登录失败：缺少 state。",
          status: "failed",
        }),
      );
    }

    const challenge = loginChallenges.get(query.state);

    if (!challenge) {
      return reply.status(404).send(
        renderCallbackPage({
          message: "登录失败：无效的登录会话。",
          status: "failed",
        }),
      );
    }

    // 已过期或已被消费：直接失败，防重放。
    if (challenge.status !== "pending") {
      return reply.send(
        renderCallbackPage({
          message: "该登录请求已处理，请回到 Muse。",
          status: "failed",
        }),
      );
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      challenge.status = "expired";
      return reply.status(410).send(
        renderCallbackPage({
          message: "登录已超时，请重新扫码。",
          status: "failed",
        }),
      );
    }

    if (!query.code) {
      failChallenge(challenge.state, "missing_code");
      return reply.status(400).send(
        renderCallbackPage({
          message: "登录失败：缺少授权码。",
          status: "failed",
        }),
      );
    }

    const provider = authProviderSchema.parse(challenge.provider);
    const adapter = getAuthProvider(provider);
    const redirectUri = `${env.PUBLIC_BASE_URL}/api/auth/${provider}/callback`;

    try {
      const token = await adapter.exchangeToken({
        code: query.code,
        redirectUri,
        codeVerifier: challenge.codeVerifier,
      });
      const profile = await adapter.fetchUserInfo(token);

      const { userId } = await resolveIdentity({
        provider,
        profile,
        currentUserId: challenge.userId,
      });

      const session = await createSession({
        userId,
        clientPlatform: challenge.clientPlatform as never,
      });

      // 明文 token 只短暂存在进程内 challenge，供轮询取走一次；MariaDB 只保存 token hash。
      challenge.status = "authorized";
      challenge.userId = userId;
      challenge.sessionToken = session.token;

      return reply.send(
        renderCallbackPage({
          message: "登录成功，正在返回 Muse。",
          status: "success",
        }),
      );
    } catch (error) {
      const code =
        error instanceof IdentityConflictError
          ? "IDENTITY_ALREADY_BOUND"
          : "exchange_failed";
      failChallenge(challenge.state, code);
      request.log.error({ err: error }, "auth callback failed");
      return reply.status(400).send(
        renderCallbackPage({
          message: "登录失败，请回到 Muse 重试。",
          status: "failed",
        }),
      );
    }
  });

  // 客户端轮询扫码结果。authorized 时一次性取走 token 并置 consumed。
  app.get("/auth/challenge/status", async (request, reply) => {
    const state = (request.query as { state?: string }).state;
    if (!state) {
      return reply.status(400).send({ error: "Missing state" });
    }

    const challenge = loginChallenges.get(state);

    if (!challenge) {
      const body: AuthStatusResponse = { status: "expired" };
      return reply.send(body);
    }

    // 过期兜底（轮询期间可能刚好越过 TTL）。
    if (
      challenge.status === "pending" &&
      new Date(challenge.expiresAt).getTime() <= Date.now()
    ) {
      challenge.status = "expired";
      const body: AuthStatusResponse = { status: "expired" };
      return reply.send(body);
    }

    if (challenge.status === "pending") {
      const body: AuthStatusResponse = { status: "pending" };
      return reply.send(body);
    }

    if (challenge.status === "expired") {
      const body: AuthStatusResponse = { status: "expired" };
      return reply.send(body);
    }

    if (challenge.status === "failed" || challenge.status === "consumed") {
      const body: AuthStatusResponse = {
        status: "failed",
        errorCode: challenge.errorCode ?? undefined,
      };
      return reply.send(body);
    }

    // authorized：取出暂存 token 与用户，置 consumed，清掉明文。
    const sessionToken = challenge.sessionToken;
    if (!challenge.userId || !sessionToken) {
      const body: AuthStatusResponse = { status: "failed" };
      return reply.send(body);
    }

    const user = await buildAuthUser(challenge.userId);
    if (!user) {
      const body: AuthStatusResponse = { status: "failed" };
      return reply.send(body);
    }

    challenge.status = "consumed";
    challenge.sessionToken = undefined;
    loginChallenges.delete(state);

    const body: AuthStatusResponse = {
      status: "authorized",
      token: sessionToken,
      user,
    };
    return reply.send(body);
  });

  // 当前用户 + 已绑定身份。
  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await buildAuthUser(request.userId as string);
    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }
    return reply.send({ user });
  });

  // 登出：吊销当前设备的 session。
  app.post("/auth/logout", async (request, reply) => {
    const token = getBearerToken(request);
    if (token) {
      await revokeSession(token);
    }
    return reply.send({ ok: true });
  });
}

function failChallenge(state: string, errorCode: string) {
  const challenge = loginChallenges.get(state);
  if (challenge) {
    challenge.status = "failed";
    challenge.errorCode = errorCode;
  }
}
