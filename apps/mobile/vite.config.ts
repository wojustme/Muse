import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// Tauri 移动端在真机/模拟器上运行时，dev server 需要监听在可访问的 host 上。
// `tauri ios dev` / `tauri android dev` 会注入 TAURI_DEV_HOST。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: {
      "@muse/api-client": fileURLToPath(
        new URL("../../packages/api-client/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: host || "0.0.0.0",
    port: 1440,
    strictPort: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1441,
        }
      : undefined,
  },
  build: {
    target: "es2022",
  },
});
