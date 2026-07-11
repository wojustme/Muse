import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { systemConfigs } from "../db/schema.js";
import { registerAuthProvider } from "./provider.js";
import { FeishuAdapter } from "./providers/feishu.js";

const feishuConfigSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
});

// 按接入顺序注册已配置的 provider。未配置凭证的 provider 不注册。
// 接入顺序：飞书 -> 钉钉 -> 微信 -> 支付宝。
export async function registerAuthProviders() {
  const feishuConfig = await loadFeishuConfig();
  if (feishuConfig) {
    registerAuthProvider(
      new FeishuAdapter({
        appId: feishuConfig.app_id,
        appSecret: feishuConfig.app_secret,
      }),
    );
  }

  // 钉钉 / 微信 / 支付宝：后续阶段在此注册各自适配器。
}

async function loadFeishuConfig(): Promise<z.infer<typeof feishuConfigSchema> | null> {
  const [row] = await db
    .select()
    .from(systemConfigs)
    .where(eq(systemConfigs.configKey, "auth.feishu"))
    .limit(1);

  if (!row) {
    return null;
  }

  const parsedJSON = safeParseJSON(row.configValue);
  const parsedConfig = feishuConfigSchema.safeParse(parsedJSON);
  if (!parsedConfig.success) {
    throw new Error("Invalid auth.feishu config in system_configs");
  }

  return parsedConfig.data;
}

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
