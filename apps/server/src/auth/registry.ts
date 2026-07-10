import { env } from "../config/env.js";
import { registerAuthProvider } from "./provider.js";
import { FeishuAdapter } from "./providers/feishu.js";

// 按接入顺序注册已配置的 provider。未配置凭证的 provider 不注册。
// 接入顺序：飞书 -> 钉钉 -> 微信 -> 支付宝。
export function registerAuthProviders() {
  if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
    registerAuthProvider(
      new FeishuAdapter({
        appId: env.FEISHU_APP_ID,
        appSecret: env.FEISHU_APP_SECRET,
      }),
    );
  }

  // 钉钉 / 微信 / 支付宝：后续阶段在此注册各自适配器。
}
