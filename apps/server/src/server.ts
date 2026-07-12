import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAuthProviders } from "./auth/registry.js";
import { env } from "./config/env.js";
import { installLocalToolSocket } from "./local-tools/local-tool-socket.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { healthRoutes } from "./routes/health.js";
import { localToolRoutes } from "./routes/local-tools.js";
import { modelRoutes } from "./routes/models.js";
import { sessionRoutes } from "./routes/sessions.js";

// 按接入顺序注册已配置的第三方登录 provider。
await registerAuthProviders();

const app = Fastify({
  logger: true,
});
installLocalToolSocket({
  server: app.server,
  log: app.log,
});

await app.register(cors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["authorization", "content-type"],
});

await app.register(healthRoutes, { prefix: "/health" });
await app.register(authRoutes, { prefix: "/api" });
await app.register(chatRoutes, { prefix: "/api" });
await app.register(localToolRoutes, { prefix: "/api" });
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
