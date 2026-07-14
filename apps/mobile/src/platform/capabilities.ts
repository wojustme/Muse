import { openUrl } from "@tauri-apps/plugin-opener";
import { detectPlatform, type MobilePlatform } from "./index";

// 跨平台差异的唯一收敛点。业务/UI 代码只调用这里的能力，不出现 if (ios) / if (android) 分支。
// 后期加 Android 时，只在本文件补对应分支（授权回跳、返回键、safe-area 等）。

// 在系统外部浏览器打开授权 URL。
// 优先用 Tauri opener 插件（真机/模拟器）；非 Tauri 环境（桌面浏览器联调）回退 window.open。
export async function openExternalAuthUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
    return;
  } catch {
    // 非 Tauri runtime 或插件不可用时回退。
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      throw new Error("无法打开浏览器，请检查系统设置后重试");
    }
  }
}

export type PlatformCapabilities = {
  platform: MobilePlatform;
  // 授权后是否支持 deep link 自动回跳。本期均为 false，靠轮询 + 用户手动切回 App。
  supportsAuthDeepLink: boolean;
};

export function platformCapabilities(): PlatformCapabilities {
  const platform = detectPlatform();
  return {
    platform,
    supportsAuthDeepLink: false,
  };
}
