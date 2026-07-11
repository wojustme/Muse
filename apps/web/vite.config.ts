import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_"],
  resolve: {
    alias: {
      "@muse/api-client": fileURLToPath(
        new URL("../../packages/api-client/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
