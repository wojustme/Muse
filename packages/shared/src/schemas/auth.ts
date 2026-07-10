import { z } from "zod";

// 第三方登录 provider。接入顺序：飞书 -> 钉钉 -> 微信 -> 支付宝。
export const authProviderSchema = z.enum([
  "feishu",
  "dingtalk",
  "wechat",
  "alipay",
]);

// 客户端平台。web 走标准重定向，其余走扫码中转 + 轮询。
export const clientPlatformSchema = z.enum([
  "macos",
  "windows",
  "web",
  "ios",
  "android",
]);

// 已绑定的第三方身份（对外聚合视图，不含 token 等敏感字段）。
export const authIdentitySchema = z.object({
  id: z.string().min(1),
  provider: authProviderSchema,
  displayName: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});

// 当前登录用户 + 已绑定身份列表。
export const authUserSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  identities: z.array(authIdentitySchema),
});

// 发起扫码登录的请求体。
export const authChallengeRequestSchema = z.object({
  platform: clientPlatformSchema.default("macos"),
});

// 发起扫码登录的响应：客户端据此渲染二维码并轮询。
export const authChallengeResponseSchema = z.object({
  state: z.string().min(1),
  authUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

// 扫码登录状态轮询响应。
export const authStatusResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("failed"), errorCode: z.string().optional() }),
  z.object({
    status: z.literal("authorized"),
    token: z.string().min(1),
    user: authUserSchema,
  }),
]);

export type AuthProvider = z.infer<typeof authProviderSchema>;
export type ClientPlatform = z.infer<typeof clientPlatformSchema>;
export type AuthIdentity = z.infer<typeof authIdentitySchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;
export type AuthChallengeResponse = z.infer<typeof authChallengeResponseSchema>;
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

