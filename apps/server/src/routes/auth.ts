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
import {
  IdentityConflictError,
  resolveIdentity,
} from "../auth/identity.js";
import { getAuthProvider, isAuthProviderEnabled } from "../auth/provider.js";
import {
  buildAuthUser,
  createSession,
  revokeSession,
} from "../auth/session.js";
import { db } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";

type ChallengeState =
  | "pending"
  | "authorized"
  | "failed"
  | "consumed"
  | "expired";

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
    if (challenge.expiresAt.getTime() <= now || challenge.status === "consumed") {
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

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;color:#1f2937;background:#f4f6f8}main{display:grid;gap:14px;width:min(360px,calc(100% - 48px));padding:28px;border:1px solid #dce3eb;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgb(17 24 39 / 10%);text-align:center}h2,p{margin:0}h2{font-size:20px}p{color:#667085;font-size:14px;line-height:1.6}a{display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 16px;border-radius:8px;color:#fff;background:#14532d;text-decoration:none;font-size:14px;font-weight:700}</style></head><body><main><h2>Muse</h2><p>${safeMessage}</p><a href="${frontendURL}">返回 Muse</a></main><script>const target=${JSON.stringify(frontendURL)};try{if(window.opener){window.opener.postMessage(${payload},target);window.close();}}catch(error){}setTimeout(()=>{window.location.replace(target);},1200);</script></body></html>`;
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

      const authUrl = adapter.buildAuthUrl({ state, redirectUri, codeChallenge });
      const expiresAt = new Date(Date.now() + env.LOGIN_CHALLENGE_TTL_SECONDS * 1000);

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
