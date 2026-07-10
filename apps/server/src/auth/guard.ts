import type { FastifyReply, FastifyRequest } from "fastify";
import { verifySession } from "./session.js";

// 把当前登录用户挂到 request 上，供业务路由使用。
declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

// 从 Authorization: Bearer <token> 中取出明文 token。
export function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    return null;
  }
  return value.trim();
}

// preHandler：强制要求已登录，否则 401。校验通过后回填 request.userId。
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = getBearerToken(request);
  if (!token) {
    return reply.status(401).send({ error: "Missing bearer token" });
  }

  const userId = await verifySession(token);
  if (!userId) {
    return reply.status(401).send({ error: "Invalid or expired session" });
  }

  request.userId = userId;
}

// 可选登录：有 token 就回填 userId，无 token 不报错（用于绑定等半登录场景）。
export async function optionalAuth(request: FastifyRequest) {
  const token = getBearerToken(request);
  if (!token) {
    return;
  }
  const userId = await verifySession(token);
  if (userId) {
    request.userId = userId;
  }
}
