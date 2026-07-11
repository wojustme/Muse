import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/guard.js";
import { localToolDevices } from "../local-tools/local-tool-socket.js";

export async function localToolRoutes(app: FastifyInstance) {
  app.get("/local-tools/devices", { preHandler: requireAuth }, (request) => {
    const userId = request.userId as string;

    return {
      devices: localToolDevices.listUserDevices(userId),
    };
  });
}
