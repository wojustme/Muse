import type { ServerResponse } from "node:http";
import type { MuseToolRuntimeEvent } from "../agent/types.js";

// 按用户的会话事件广播中心。
//
// 用于服务端 → 客户端的实时推送（跨端消息同步）：同一账号可能在桌面 + 手机多端登录，
// 每个客户端建立一条 GET /api/events 的 SSE 长连接并注册到这里；chat 落库后调用
// publish() 把 message.created / session.updated 推给该用户的所有连接（可跳过发起端）。
//
// 单进程内存实现：多实例部署时应演进为 Redis/pub-sub，本期不做。

export type SessionEvent =
  | {
      type: "message.created";
      sessionId: string;
      message: {
        id: string;
        role: "user" | "assistant";
        text: string;
        createdAt: string;
      };
      originClientId?: string;
    }
  | {
      type: "session.updated";
      session: {
        id: string;
        title: string;
        updatedAt: string;
        modelProvider?: string;
        modelName?: string;
        messageCount?: number;
        lastMessagePreview?: string;
      };
      originClientId?: string;
    }
  // AI 开始生成：另一端据此建流式占位气泡。
  | {
      type: "message.stream-start";
      sessionId: string;
      messageId: string;
      originClientId?: string;
    }
  // AI 生成增量：另一端逐字追加，与发起端同步流式。
  | {
      type: "message.stream-delta";
      sessionId: string;
      messageId: string;
      text: string;
      originClientId?: string;
    }
  // AI 定稿：另一端关闭流式态（随后 message.created 做最终对齐）。
  | {
      type: "message.stream-end";
      sessionId: string;
      messageId: string;
      text: string;
      originClientId?: string;
    }
  // 工具运行态：另一端把工具卡片挂到同一条 assistant 消息下。
  | {
      type: "tool-runtime";
      sessionId: string;
      messageId: string;
      event: MuseToolRuntimeEvent;
      originClientId?: string;
    }
  // 当前会话的跨端连接状态：用于桌面展示哪些移动端正在借用本机工具。
  | {
      type: "session.presence";
      sessionId: string;
      connections: SessionPresenceConnection[];
      originClientId?: string;
    };

export type ClientKind = "desktop" | "mobile" | "unknown";

export type RemoteToolTarget = {
  deviceId: string;
  workspaceId: string;
  deviceName?: string;
  workspaceName?: string;
};

export type SessionPresenceConnection = {
  clientId: string;
  clientKind: ClientKind;
  clientLabel: string;
  remoteTarget?: RemoteToolTarget;
};

type ClientConnection = {
  raw: ServerResponse;
  // 该连接当前打开的会话页；null 表示不在任何会话页（如历史列表）。
  activeSessionId: string | null;
  clientKind: ClientKind;
  clientLabel: string;
  remoteTarget: RemoteToolTarget | null;
};

type ClientConnections = Map<string, ClientConnection>;

export class SessionEventHub {
  private readonly connectionsByUser = new Map<string, ClientConnections>();

  // 注册一条客户端连接，返回注销函数。同一 clientId 重复连接会覆盖旧连接。
  register(userId: string, clientId: string, raw: ServerResponse): () => void {
    let clients = this.connectionsByUser.get(userId);
    if (!clients) {
      clients = new Map();
      this.connectionsByUser.set(userId, clients);
    }

    const previous = clients.get(clientId);
    if (previous && previous.raw !== raw) {
      try {
        previous.raw.end();
      } catch {
        // 旧连接可能已断开，忽略。
      }
    }
    clients.set(clientId, {
      raw,
      activeSessionId: null,
      clientKind: "unknown",
      clientLabel: "Muse Client",
      remoteTarget: null,
    });

    return () => {
      const current = this.connectionsByUser.get(userId);
      if (!current) {
        return;
      }
      if (current.get(clientId)?.raw === raw) {
        current.delete(clientId);
      }
      if (current.size === 0) {
        this.connectionsByUser.delete(userId);
      }
    };
  }

  // 客户端上报"当前打开的会话页"。sessionId 为 null 表示离开会话页。
  setActiveSession(input: {
    userId: string;
    clientId: string;
    sessionId: string | null;
    clientKind?: ClientKind;
    clientLabel?: string;
    remoteTarget?: RemoteToolTarget | null;
  }): void {
    const {
      userId,
      clientId,
      sessionId,
      clientKind,
      clientLabel,
      remoteTarget,
    } = input;
    const connection = this.connectionsByUser.get(userId)?.get(clientId);
    if (connection) {
      const previousSessionId = connection.activeSessionId;
      connection.activeSessionId = sessionId;
      connection.clientKind = clientKind ?? connection.clientKind;
      connection.clientLabel = clientLabel ?? connection.clientLabel;
      connection.remoteTarget = remoteTarget ?? null;
      if (previousSessionId && previousSessionId !== sessionId) {
        this.publishPresence(userId, previousSessionId, clientId);
      }
      this.publishPresence(userId, sessionId, clientId);
      return;
    }
    this.publishPresence(userId, sessionId, clientId);
  }

  private presenceForSession(
    userId: string,
    sessionId: string | null,
  ): SessionPresenceConnection[] {
    if (!sessionId) {
      return [];
    }
    const clients = this.connectionsByUser.get(userId);
    if (!clients) {
      return [];
    }
    return [...clients.entries()]
      .filter(([, connection]) => connection.activeSessionId === sessionId)
      .map(([clientId, connection]) => ({
        clientId,
        clientKind: connection.clientKind,
        clientLabel: connection.clientLabel,
        remoteTarget: connection.remoteTarget ?? undefined,
      }));
  }

  private publishPresence(
    userId: string,
    sessionId: string | null,
    originClientId?: string,
  ): void {
    if (!sessionId) {
      return;
    }
    this.publish(userId, {
      type: "session.presence",
      sessionId,
      connections: this.presenceForSession(userId, sessionId),
      originClientId,
    });
  }

  // 向该用户所有连接广播事件，可跳过发起端（其自身已通过 /api/chat 流实时看到）。
  // 带 sessionId 的消息/流式事件仅推给正在看该 session 的其他端；session.updated 广播给全部（列表可见）。
  publish(
    userId: string,
    event: SessionEvent,
    opts?: { exceptClientId?: string },
  ): void {
    const clients = this.connectionsByUser.get(userId);
    if (!clients || clients.size === 0) {
      return;
    }

    // 需按当前会话页过滤的事件类型（单条消息与流式增量）。
    const sessionScoped =
      event.type === "message.created" ||
      event.type === "message.stream-start" ||
      event.type === "message.stream-delta" ||
      event.type === "message.stream-end" ||
      event.type === "tool-runtime" ||
      event.type === "session.presence";

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const [clientId, connection] of clients) {
      if (opts?.exceptClientId && clientId === opts.exceptClientId) {
        continue;
      }
      // 会话内事件只推给正在打开该会话页的端，避免推送对方当前看不到的内容。
      if (sessionScoped && connection.activeSessionId !== event.sessionId) {
        continue;
      }
      if (connection.raw.writableEnded) {
        continue;
      }
      try {
        connection.raw.write(payload);
      } catch {
        // 写失败的连接由其 close 回调注销。
      }
    }
  }

  // 心跳保活：向所有连接写注释行，避免中间层因空闲断连。
  heartbeat(): void {
    for (const clients of this.connectionsByUser.values()) {
      for (const connection of clients.values()) {
        if (!connection.raw.writableEnded) {
          try {
            connection.raw.write(": ping\n\n");
          } catch {
            // 忽略，close 回调会清理。
          }
        }
      }
    }
  }
}

export const sessionEventHub = new SessionEventHub();

// 全局心跳（模块级单次启动）。25s 间隔足够避开常见代理的空闲超时。
setInterval(() => sessionEventHub.heartbeat(), 25_000).unref();
