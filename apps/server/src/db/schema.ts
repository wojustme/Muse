import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// 时间统一存 ISO datetime 字符串（对齐 packages/shared 的 z.string().datetime()）。
const isoNow = () => new Date().toISOString();

// users：Muse 内部账号本体（一个"人"）。业务数据只外键到这里。
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").notNull().default("active"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(isoNow),
    updatedAt: text("updated_at").notNull().$defaultFn(isoNow),
    lastLoginAt: text("last_login_at"),
  },
  (t) => ({
    statusIdx: index("idx_users_status").on(t.status),
  }),
);

// auth_identities：第三方登录身份。一个 user 可绑定多个身份。
// identity_key UNIQUE 保证一个外部身份只归属一个 Muse 账号（绑定模型核心约束）。
export const authIdentities = sqliteTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    identityKey: text("identity_key").notNull(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerUnionId: text("provider_union_id"),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    providerOpenId: text("provider_open_id"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    rawProfile: text("raw_profile").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(isoNow),
    updatedAt: text("updated_at").notNull().$defaultFn(isoNow),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    identityKeyUq: uniqueIndex("uq_auth_identities_key").on(t.identityKey),
    userIdx: index("idx_auth_identities_user").on(t.userId),
    providerIdx: index("idx_auth_identities_provider").on(t.provider),
  }),
);

// auth_sessions：App 登录态。不透明 session token 只存哈希，可按设备吊销。
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    identityId: text("identity_id").references(() => authIdentities.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    clientPlatform: text("client_platform"),
    deviceLabel: text("device_label"),
    status: text("status").notNull().default("active"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(isoNow),
    updatedAt: text("updated_at").notNull().$defaultFn(isoNow),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => ({
    tokenUq: uniqueIndex("uq_auth_sessions_token").on(t.tokenHash),
    userIdx: index("idx_auth_sessions_user").on(t.userId),
    statusIdx: index("idx_auth_sessions_status").on(t.status),
  }),
);

// login_challenges：扫码登录中间态（服务端中转 + 客户端轮询）。
export const loginChallenges = sqliteTable(
  "login_challenges",
  {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    clientPlatform: text("client_platform").notNull(),
    codeVerifier: text("code_verifier"),
    status: text("status").notNull().default("pending"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    sessionTokenHash: text("session_token_hash"),
    errorCode: text("error_code"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(isoNow),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (t) => ({
    statusIdx: index("idx_login_challenges_status").on(t.status),
    expiresIdx: index("idx_login_challenges_expires_at").on(t.expiresAt),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type AuthIdentityRow = typeof authIdentities.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type LoginChallengeRow = typeof loginChallenges.$inferSelect;

// 供建库使用的原始 DDL。第一阶段用本地 SQLite，随应用启动时执行一次。
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_union_id TEXT,
  provider_tenant_id TEXT NOT NULL DEFAULT '',
  provider_open_id TEXT,
  display_name TEXT,
  avatar_url TEXT,
  raw_profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_identities_key ON auth_identities(identity_key);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_id TEXT REFERENCES auth_identities(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL,
  client_platform TEXT,
  device_label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_status ON auth_sessions(status);

CREATE TABLE IF NOT EXISTS login_challenges (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_platform TEXT NOT NULL,
  code_verifier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT,
  error_code TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_status ON login_challenges(status);
CREATE INDEX IF NOT EXISTS idx_login_challenges_expires_at ON login_challenges(expires_at);
`;
