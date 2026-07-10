import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  authChallengeRequestSchema,
  authProviderSchema,
  type AuthStatusResponse,
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
  hashToken,
  revokeSession,
} from "../auth/session.js";
import { db } from "../db/client.js";
import { loginChallenges } from "../db/schema.js";

// 回调页：无 UI，只提示用户回到 App。Web 端后续可替换为 302。
function renderCallbackPage(message: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;color:#333;background:#f7f7f8}main{text-align:center}</style></head><body><main><h2>Muse</h2><p>${message}</p></main></body></html>`;
}

export async function authRoutes(app: FastifyInstance) {
  // 发起扫码/授权：建 login_challenges，返回 authUrl + state。
  // 携带有效 bearer 时视为"绑定"（把新 provider 绑到当前账号）。
  app.post(
    "/auth/:provider/challenge",
    { preHandler: optionalAuth },
    async (request, reply) => {
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
      const expiresAt = new Date(
        Date.now() + env.LOGIN_CHALLENGE_TTL_SECONDS * 1000,
      ).toISOString();

      await db.insert(loginChallenges).values({
        state,
        provider,
        clientPlatform: bodyParsed.data.platform,
        codeVerifier: codeVerifier ?? null,
        status: "pending",
        // 绑定模式：把当前登录用户带到 callback。
        userId: request.userId ?? null,
        expiresAt,
      });

      return reply.send({ state, authUrl, expiresAt });
    },
  );

  // provider 回调：换 token -> 拉资料 -> 判定 -> 签发 session -> 回填 challenge。
  app.get("/auth/:provider/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    reply.header("content-type", "text/html; charset=utf-8");

    if (!query.state) {
      return reply.status(400).send(renderCallbackPage("登录失败：缺少 state。"));
    }

    const [challenge] = await db
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.state, query.state))
      .limit(1);

    if (!challenge) {
      return reply.status(404).send(renderCallbackPage("登录失败：无效的登录会话。"));
    }

    // 已过期或已被消费：直接失败，防重放。
    if (challenge.status !== "pending") {
      return reply.send(renderCallbackPage("该登录请求已处理，请回到 Muse。"));
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      await db
        .update(loginChallenges)
        .set({ status: "expired" })
        .where(eq(loginChallenges.state, challenge.state));
      return reply.status(410).send(renderCallbackPage("登录已超时，请重新扫码。"));
    }

    if (!query.code) {
      await failChallenge(challenge.state, "missing_code");
      return reply.status(400).send(renderCallbackPage("登录失败：缺少授权码。"));
    }

    const provider = authProviderSchema.parse(challenge.provider);
    const adapter = getAuthProvider(provider);
    const redirectUri = `${env.PUBLIC_BASE_URL}/api/auth/${provider}/callback`;

    try {
      const token = await adapter.exchangeToken({
        code: query.code,
        redirectUri,
        codeVerifier: challenge.codeVerifier ?? undefined,
      });
      const profile = await adapter.fetchUserInfo(token);
      const identityKey = adapter.buildIdentityKey(profile);

      const { userId, identityId } = await resolveIdentity({
        provider,
        identityKey,
        profile,
        currentUserId: challenge.userId,
      });

      const session = await createSession({
        userId,
        identityId,
        clientPlatform: challenge.clientPlatform as never,
      });

      // 明文 token 暂存到 challenge，供轮询取走一次；hash 存 session_token_hash 备查。
      await db
        .update(loginChallenges)
        .set({
          status: "authorized",
          userId,
          sessionTokenHash: hashToken(session.token),
          metadata: JSON.stringify({
            sessionToken: session.token,
            expiresAt: session.expiresAt,
          }),
        })
        .where(eq(loginChallenges.state, challenge.state));

      return reply.send(renderCallbackPage("登录成功，请回到 Muse。"));
    } catch (error) {
      const code =
        error instanceof IdentityConflictError
          ? "IDENTITY_ALREADY_BOUND"
          : "exchange_failed";
      await failChallenge(challenge.state, code);
      request.log.error({ err: error }, "auth callback failed");
      return reply.status(400).send(renderCallbackPage("登录失败，请回到 Muse 重试。"));
    }
  });

  // 客户端轮询扫码结果。authorized 时一次性取走 token 并置 consumed。
  app.get("/auth/challenge/status", async (request, reply) => {
    const state = (request.query as { state?: string }).state;
    if (!state) {
      return reply.status(400).send({ error: "Missing state" });
    }

    const [challenge] = await db
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.state, state))
      .limit(1);

    if (!challenge) {
      const body: AuthStatusResponse = { status: "expired" };
      return reply.send(body);
    }

    // 过期兜底（轮询期间可能刚好越过 TTL）。
    if (
      challenge.status === "pending" &&
      new Date(challenge.expiresAt).getTime() <= Date.now()
    ) {
      await db
        .update(loginChallenges)
        .set({ status: "expired" })
        .where(eq(loginChallenges.state, state));
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
    const meta = safeParse(challenge.metadata);
    const sessionToken = meta.sessionToken as string | undefined;
    if (!challenge.userId || !sessionToken) {
      const body: AuthStatusResponse = { status: "failed" };
      return reply.send(body);
    }

    const user = await buildAuthUser(challenge.userId);
    if (!user) {
      const body: AuthStatusResponse = { status: "failed" };
      return reply.send(body);
    }

    await db
      .update(loginChallenges)
      .set({
        status: "consumed",
        metadata: "{}",
        consumedAt: new Date().toISOString(),
      })
      .where(eq(loginChallenges.state, state));

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

async function failChallenge(state: string, errorCode: string) {
  await db
    .update(loginChallenges)
    .set({ status: "failed", errorCode })
    .where(eq(loginChallenges.state, state));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
