import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),

  // 模型 provider
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),

  // 本地 SQLite 路径
  DATABASE_PATH: z.string().default("./muse.db"),

  // 服务端对外可访问的 base URL，用于拼接 OAuth redirect_uri
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),

  // 登录态
  SESSION_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(720),
  LOGIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // 飞书（P1a）。未配置则飞书 provider 不注册。
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);
