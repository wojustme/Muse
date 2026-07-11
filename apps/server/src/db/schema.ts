import {
  boolean,
  char,
  datetime,
  index,
  int,
  longtext,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const dateTime = (name: string) => datetime(name, { mode: "date", fsp: 3 });

// users：Muse 内部账号本体（一个"人"）。业务数据只外键到这里。
export const users = mysqlTable(
  "users",
  {
    id: char("id", { length: 36 }).primaryKey(),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    email: varchar("email", { length: 320 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
    lastLoginAt: dateTime("last_login_at"),
  },
  (t) => ({
    statusIdx: index("idx_users_status").on(t.status),
  }),
);

// user_identities：第三方登录身份。一个 user 可绑定多个身份。
// provider + tenant + provider_user_id UNIQUE 保证一个外部身份只归属一个 Muse 账号。
export const userIdentities = mysqlTable(
  "user_identities",
  {
    id: char("id", { length: 36 }).primaryKey(),
    userId: char("user_id", { length: 36 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
    providerUnionId: varchar("provider_union_id", { length: 255 }),
    providerTenantId: varchar("provider_tenant_id", { length: 255 })
      .notNull()
      .default(""),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    rawProfile: longtext("raw_profile"),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
    lastUsedAt: dateTime("last_used_at"),
  },
  (t) => ({
    providerUserUq: uniqueIndex("uq_user_identities_provider_user").on(
      t.provider,
      t.providerTenantId,
      t.providerUserId,
    ),
    userIdx: index("idx_user_identities_user").on(t.userId),
  }),
);

// auth_sessions：App 登录态。不透明 session token 只存哈希，token_hash 直接作为主键。
export const authSessions = mysqlTable(
  "auth_sessions",
  {
    tokenHash: char("token_hash", { length: 64 }).primaryKey(),
    userId: char("user_id", { length: 36 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    expiresAt: dateTime("expires_at").notNull(),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_auth_sessions_user").on(t.userId),
    expiresAtIdx: index("idx_auth_sessions_expires_at").on(t.expiresAt),
  }),
);

// system_configs：系统级 key-value 配置，value 使用 JSON 字符串。
export const systemConfigs = mysqlTable("system_configs", {
  configKey: varchar("config_key", { length: 128 }).primaryKey(),
  configValue: longtext("config_value").notNull(),
  description: varchar("description", { length: 255 }),
  createdAt: dateTime("created_at").notNull(),
  updatedAt: dateTime("updated_at").notNull(),
});

// ai_models：现阶段的模型目录与调用配置。/api/models 只返回非敏感字段。
export const aiModels = mysqlTable(
  "ai_models",
  {
    id: char("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    modelName: varchar("model_name", { length: 128 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    apiKey: text("api_key"),
    baseUrl: varchar("base_url", { length: 512 }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
  },
  (t) => ({
    providerModelUq: uniqueIndex("uq_ai_models_provider_model").on(
      t.provider,
      t.modelName,
    ),
    enabledIdx: index("idx_ai_models_enabled").on(t.enabled),
  }),
);

// user_ai_models：用户可使用的模型授权关系。行存在即表示该用户可使用该模型。
export const userAiModels = mysqlTable(
  "user_ai_models",
  {
    userId: char("user_id", { length: 36 }).notNull(),
    aiModelId: char("ai_model_id", { length: 36 }).notNull(),
    createdAt: dateTime("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: "pk_user_ai_models",
      columns: [t.userId, t.aiModelId],
    }),
    aiModelIdx: index("idx_user_ai_models_ai_model").on(t.aiModelId),
  }),
);

// chat_sessions：用户的一条对话会话摘要。
export const chatSessions = mysqlTable(
  "chat_sessions",
  {
    id: char("id", { length: 36 }).primaryKey(),
    userId: char("user_id", { length: 36 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    modelProvider: varchar("model_provider", { length: 64 }),
    modelName: varchar("model_name", { length: 128 }),
    aiModelId: char("ai_model_id", { length: 36 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    pinned: boolean("pinned").notNull().default(false),
    messageCount: int("message_count").notNull().default(0),
    lastMessagePreview: varchar("last_message_preview", { length: 512 }),
    lastMessageAt: dateTime("last_message_at"),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
  },
  (t) => ({
    userStatusUpdatedIdx: index("idx_chat_sessions_user_status_updated").on(
      t.userId,
      t.status,
      t.updatedAt,
    ),
    userPinnedUpdatedIdx: index("idx_chat_sessions_user_pinned_updated").on(
      t.userId,
      t.pinned,
      t.updatedAt,
    ),
  }),
);

// chat_messages：会话内消息历史。content 是便于检索展示的纯文本，parts 保留结构化消息。
export const chatMessages = mysqlTable(
  "chat_messages",
  {
    id: char("id", { length: 36 }).primaryKey(),
    sessionId: char("session_id", { length: 36 }).notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    content: longtext("content").notNull(),
    parts: longtext("parts"),
    modelProvider: varchar("model_provider", { length: 64 }),
    modelName: varchar("model_name", { length: 128 }),
    aiModelId: char("ai_model_id", { length: 36 }),
    status: varchar("status", { length: 32 }).notNull().default("completed"),
    errorMessage: text("error_message"),
    createdAt: dateTime("created_at").notNull(),
    updatedAt: dateTime("updated_at").notNull(),
  },
  (t) => ({
    sessionCreatedIdx: index("idx_chat_messages_session_created").on(
      t.sessionId,
      t.createdAt,
    ),
    userCreatedIdx: index("idx_chat_messages_user_created").on(
      t.userId,
      t.createdAt,
    ),
  }),
);

// model_runs：一次模型调用记录。当前先记录 placeholder 调用，后续接真实模型和用量。
export const modelRuns = mysqlTable(
  "model_runs",
  {
    id: char("id", { length: 36 }).primaryKey(),
    sessionId: char("session_id", { length: 36 }).notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    requestMessageId: char("request_message_id", { length: 36 }),
    responseMessageId: char("response_message_id", { length: 36 }),
    aiModelId: char("ai_model_id", { length: 36 }),
    provider: varchar("provider", { length: 64 }).notNull(),
    modelName: varchar("model_name", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    promptTokens: int("prompt_tokens"),
    completionTokens: int("completion_tokens"),
    totalTokens: int("total_tokens"),
    errorMessage: text("error_message"),
    startedAt: dateTime("started_at").notNull(),
    completedAt: dateTime("completed_at"),
    createdAt: dateTime("created_at").notNull(),
  },
  (t) => ({
    sessionCreatedIdx: index("idx_model_runs_session_created").on(
      t.sessionId,
      t.createdAt,
    ),
    userCreatedIdx: index("idx_model_runs_user_created").on(
      t.userId,
      t.createdAt,
    ),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type UserIdentityRow = typeof userIdentities.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type SystemConfigRow = typeof systemConfigs.$inferSelect;
export type AiModelRow = typeof aiModels.$inferSelect;
export type UserAiModelRow = typeof userAiModels.$inferSelect;
export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ModelRunRow = typeof modelRuns.$inferSelect;
