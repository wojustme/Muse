import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      ok: true,
      service: "muse-server",
      timestamp: new Date().toISOString(),
    };
  });
}
