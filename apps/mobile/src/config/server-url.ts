// 可配置服务端地址。
// 手机（真机/模拟器）无法访问桌面开发机的 127.0.0.1，需要填局域网 IP，
// 因此把 serverUrl 持久化到 localStorage，并在登录页提供输入框。

const SERVER_URL_KEY = "muse.serverUrl";

// 默认地址：优先取 Vite 注入的 VITE_SERVER_URL，其次回退到本机（仅桌面浏览器联调可用）。
const DEFAULT_SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  "http://127.0.0.1:8787";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function resolveServerUrl(): string {
  try {
    const stored = localStorage.getItem(SERVER_URL_KEY);
    if (stored && stored.trim()) {
      return normalize(stored);
    }
  } catch {
    // localStorage 不可用时回退默认值。
  }
  return normalize(DEFAULT_SERVER_URL);
}

export function saveServerUrl(url: string): string {
  const next = normalize(url);
  try {
    localStorage.setItem(SERVER_URL_KEY, next);
  } catch {
    // 忽略写入失败（隐私模式等）。
  }
  return next;
}

// 校验用户输入是否为合法 http(s) 地址。
export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(normalize(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
