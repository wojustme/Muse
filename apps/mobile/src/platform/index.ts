import type { ClientPlatform } from "@muse/shared";

// 移动端支持的平台。iOS 本期先行，Android 后期复用同一份前端。
export type MobilePlatform = Extract<ClientPlatform, "ios" | "android">;

// 依据 UA 判定运行平台。Tauri iOS/Android WebView 的 UA 与系统浏览器一致，
// 因此 iPhone/iPad -> ios，其余（含 Android WebView）-> android。
export function detectPlatform(): MobilePlatform {
  const ua =
    typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";

  if (/iphone|ipad|ipod/.test(ua)) {
    return "ios";
  }
  if (/android/.test(ua)) {
    return "android";
  }

  // 桌面浏览器联调（pnpm dev:mobile:web）默认按 iOS 处理，仅影响上报的 platform 字段。
  return "ios";
}

// 供聊天 client 上下文上报使用的可读 OS 名。
export function platformOsLabel(platform: MobilePlatform): string {
  return platform === "ios" ? "iOS" : "Android";
}
