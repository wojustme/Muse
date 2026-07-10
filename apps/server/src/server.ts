import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAuthProviders } from "./auth/registry.js";
import { env } from "./config/env.js";
import { initDatabase } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { healthRoutes } from "./routes/health.js";
import { modelRoutes } from "./routes/models.js";
import { sessionRoutes } from "./routes/sessions.js";

// 建表（本地 SQLite）+ 按接入顺序注册已配置的 provider。
initDatabase();
registerAuthProviders();

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

await app.register(healthRoutes, { prefix: "/health" });
await app.register(authRoutes, { prefix: "/api" });
await app.register(chatRoutes, { prefix: "/api" });
await app.register(modelRoutes, { prefix: "/api" });
await app.register(sessionRoutes, { prefix: "/api" });

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
