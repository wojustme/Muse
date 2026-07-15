import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),

  // 模型 provider
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),

  // MariaDB 连接串
  DATABASE_URL: z
    .string()
    .url()
    .default("mysql://muse:muse@127.0.0.1:3306/muse_db"),

  // 服务端对外可访问的 base URL，用于拼接 OAuth redirect_uri
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),
  FRONTEND_BASE_URL: z.string().url().default("http://127.0.0.1:1420"),

  // 登录态
  SESSION_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(720),
  LOGIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // 本地开发免 OAuth 登录。只用于 Web/Tauri 前端联调，仍签发真实 session。
  AUTH_DEV_MOCK: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
  AUTH_DEV_MOCK_NAME: z.string().default("Muse Dev User"),

  // 本地工具人工审批超时（毫秒）。远长于执行超时，给手机/桌面留出确认时间。
  MUSE_APPROVAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),

  // 本地 bash 工具默认关闭。只应在可信本机开发环境中开启。
  MUSE_LOCAL_BASH_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
  MUSE_LOCAL_BASH_ALLOWED_ROOTS: z
    .string()
    .default(
      "/Users/bytedance/codes/my/Muse,/Users/bytedance/Downloads,/private/tmp",
    ),
  MUSE_LOCAL_BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  MUSE_LOCAL_BASH_MAX_OUTPUT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(12000),
});

export const env = envSchema.parse(process.env);
