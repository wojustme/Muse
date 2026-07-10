import { eq } from "drizzle-orm";
import type { AuthProvider } from "@muse/shared";
import { db } from "../db/client.js";
import { authIdentities, users } from "../db/schema.js";
import type { NormalizedProfile } from "./provider.js";

// 绑定冲突：该第三方身份已属于另一个账号。
export class IdentityConflictError extends Error {
  code = "IDENTITY_ALREADY_BOUND";
  constructor(public readonly ownerUserId: string) {
    super("Identity already bound to another account");
  }
}

type ResolveResult = {
  userId: string;
  identityId: string;
  action: "login" | "bind" | "create";
};

// 登录/绑定判定（见 docs/auth-implementation-plan.md 第 4 节）。
// currentUserId 不为空 = 已登录态下的绑定请求。
export async function resolveIdentity(input: {
  provider: AuthProvider;
  identityKey: string;
  profile: NormalizedProfile;
  currentUserId?: string | null;
}): Promise<ResolveResult> {
  const { provider, identityKey, profile, currentUserId } = input;
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.identityKey, identityKey))
    .limit(1);

  // 命中：更新资料后登入对应账号。
  if (existing) {
    // 绑定场景下命中了别的账号 -> 冲突。
    if (currentUserId && existing.userId !== currentUserId) {
      throw new IdentityConflictError(existing.userId);
    }

    await db
      .update(authIdentities)
      .set({
        displayName: profile.displayName ?? existing.displayName,
        avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
        providerUnionId: profile.unionId ?? existing.providerUnionId,
        rawProfile: JSON.stringify(profile.raw ?? {}),
        updatedAt: now,
        lastUsedAt: now,
      })
      .where(eq(authIdentities.id, existing.id));

    return {
      userId: existing.userId,
      identityId: existing.id,
      action: currentUserId ? "bind" : "login",
    };
  }

  // 未命中 + 已登录 -> 绑定到当前账号。
  if (currentUserId) {
    const identityId = await insertIdentity({
      userId: currentUserId,
      provider,
      identityKey,
      profile,
      now,
    });
    return { userId: currentUserId, identityId, action: "bind" };
  }

  // 未命中 + 未登录 -> 新建账号 + 身份。
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    displayName: profile.displayName ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  });

  const identityId = await insertIdentity({
    userId,
    provider,
    identityKey,
    profile,
    now,
  });

  return { userId, identityId, action: "create" };
}

async function insertIdentity(input: {
  userId: string;
  provider: AuthProvider;
  identityKey: string;
  profile: NormalizedProfile;
  now: string;
}): Promise<string> {
  const { userId, provider, identityKey, profile, now } = input;
  const identityId = crypto.randomUUID();

  await db.insert(authIdentities).values({
    id: identityId,
    userId,
    identityKey,
    provider,
    providerUserId: profile.providerUid,
    providerUnionId: profile.unionId ?? null,
    providerTenantId: profile.tenantId ?? "",
    displayName: profile.displayName ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    rawProfile: JSON.stringify(profile.raw ?? {}),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  });

  return identityId;
}
