import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { systemConfigs } from "../db/schema.js";

// 联网搜索配置存放于 system_configs 表，key 为 web_search，value 为 JSON。
// 与飞书凭证一样属于敏感第三方凭证，不放入 .env / 代码。
// 示例 value：
// {"enabled": true, "provider": "tavily", "api_key": "tvly-xxxx", "timeout_ms": 10000}
const WEB_SEARCH_CONFIG_KEY = "web_search";

const webSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.literal("tavily").default("tavily"),
  api_key: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().default(10000),
});

export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

// 启动时加载一次后缓存，供同步的工具注册流程读取。
let cachedConfig: WebSearchConfig | null = null;

// 在服务启动阶段调用一次，从 DB 载入并校验联网搜索配置。
export async function loadWebSearchConfig(): Promise<void> {
  const [row] = await db
    .select()
    .from(systemConfigs)
    .where(eq(systemConfigs.configKey, WEB_SEARCH_CONFIG_KEY))
    .limit(1);

  if (!row) {
    cachedConfig = null;
    return;
  }

  const parsedJSON = safeParseJSON(row.configValue);
  const parsedConfig = webSearchConfigSchema.safeParse(parsedJSON);
  if (!parsedConfig.success) {
    throw new Error("Invalid web_search config in system_configs");
  }

  cachedConfig = parsedConfig.data;
}

// 返回缓存的联网搜索配置；未配置时返回 null。
export function getWebSearchConfig(): WebSearchConfig | null {
  return cachedConfig;
}

// 联网搜索是否可用：需已启用且配置了 API key。
export function isWebSearchEnabled(): boolean {
  return Boolean(cachedConfig?.enabled && cachedConfig.api_key);
}

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
