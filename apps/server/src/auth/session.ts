import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AuthUser, ClientPlatform } from "@muse/shared";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { authSessions, userIdentities, users } from "../db/schema.js";

// 不透明 session token：明文只返回给客户端一次，库里只存哈希。
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export type CreatedSession = {
  token: string;
  expiresAt: string;
};

// 为某个 user 签发一条登录态，返回明文 token。
export async function createSession(input: {
  userId: string;
  clientPlatform?: ClientPlatform;
}): Promise<CreatedSession> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + env.SESSION_TOKEN_TTL_HOURS * 3600 * 1000,
  );

  await db.insert(authSessions).values({
    tokenHash: hashToken(token),
    userId: input.userId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });

  return { token, expiresAt: expiresAt.toISOString() };
}

// 校验 token 是否为有效登录态，返回 userId。
export async function verifySession(token: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        eq(authSessions.status, "active"),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    await db
      .update(authSessions)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(authSessions.tokenHash, row.tokenHash));
    return null;
  }

  return row.userId;
}

// 主动登出：吊销该 token 对应的登录态。
export async function revokeSession(token: string): Promise<void> {
  const now = new Date();
  await db
    .update(authSessions)
    .set({ status: "revoked", updatedAt: now })
    .where(eq(authSessions.tokenHash, hashToken(token)));
}

// 构建对外的 AuthUser 聚合视图（用户 + 已绑定身份）。
export async function buildAuthUser(userId: string): Promise<AuthUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return null;
  }

  const identities = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));

  return {
    id: user.id,
    displayName: user.displayName ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    identities: identities.map((identity) => ({
      id: identity.id,
      provider: identity.provider as AuthUser["identities"][number]["provider"],
      displayName: identity.displayName ?? undefined,
      avatarUrl: identity.avatarUrl ?? undefined,
      createdAt: identity.createdAt.toISOString(),
    })),
  };
}
