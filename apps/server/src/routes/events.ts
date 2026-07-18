import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";
import { sessionEventHub } from "../events/session-event-hub.js";

const eventsQuerySchema = z.object({
  clientId: z.string().min(1).max(128),
});

// 客户端上报"当前打开的会话页"。sessionId 为 null 表示离开会话页。
const activeSessionSchema = z.object({
  clientId: z.string().min(1).max(128),
  sessionId: z.string().min(1).nullable(),
  clientKind: z.enum(["desktop", "mobile", "unknown"]).optional(),
  clientLabel: z.string().min(1).max(128).optional(),
  remoteTarget: z
    .object({
      deviceId: z.string().min(1).max(128),
      workspaceId: z.string().min(1).max(128),
      deviceName: z.string().min(1).max(128).optional(),
      workspaceName: z.string().min(1).max(128).optional(),
    })
    .nullable()
    .optional(),
});

// 按用户的会话事件 SSE 长连接。客户端登录后建立，用于接收跨端消息推送。
// 复用 chat 路由的 SSE 接管手法：hijack + 手动补 CORS + event-stream。
export async function eventsRoutes(app: FastifyInstance) {
  app.get("/events", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing clientId" });
    }

    const userId = request.userId as string;
    const clientId = parsed.data.clientId;
    const raw: ServerResponse = reply.raw;

    // hijack 跳过 @fastify/cors 的 onSend，这里手动补齐（等价 origin:true 回显）。
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      raw.setHeader("access-control-allow-origin", requestOrigin);
      raw.setHeader("vary", "Origin");
      raw.setHeader("access-control-allow-credentials", "true");
    }
    raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    raw.setHeader("cache-control", "no-cache, no-transform");
    raw.setHeader("connection", "keep-alive");
    raw.setHeader("x-accel-buffering", "no");

    reply.hijack();
    raw.flushHeaders();

    // 建立即发 hello，客户端据此确认通道打通、可停用兜底轮询。
    raw.write(`data: ${JSON.stringify({ type: "hello", clientId })}\n\n`);

    const unregister = sessionEventHub.register(userId, clientId, raw);

    request.raw.on("close", () => {
      unregister();
    });
  });

  // 上报当前打开的会话页：仅当对端也在看同一 session 时才实时推送该会话消息。
  app.post(
    "/events/active",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = activeSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid active session" });
      }
      const userId = request.userId as string;
      sessionEventHub.setActiveSession({
        userId,
        clientId: parsed.data.clientId,
        sessionId: parsed.data.sessionId,
        clientKind: parsed.data.clientKind,
        clientLabel: parsed.data.clientLabel,
        remoteTarget: parsed.data.remoteTarget,
      });
      return reply.send({ ok: true });
    },
  );
}
