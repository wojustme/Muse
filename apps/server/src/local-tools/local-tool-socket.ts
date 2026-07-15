import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  localToolClientMessageSchema,
  type ApprovalDecidedBy,
  type ApprovalDecision,
  type LocalToolClientMessage,
  type LocalToolServerMessage,
} from "@muse/shared";
import { verifySession } from "../auth/session.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import { DeviceRegistry, parseSocketMessage } from "./device-registry.js";
import { LocalToolBroker } from "./local-tool-broker.js";

function tokenFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  const parsed = new URL(url, "ws://127.0.0.1");
  return parsed.searchParams.get("token");
}

function sendError(
  socket: WebSocket,
  requestId: string,
  message: string,
): void {
  socket.send(
    JSON.stringify({
      type: "tool.error",
      payload: {
        requestId,
        error: {
          code: "INVALID_MESSAGE",
          message,
        },
      },
    }),
  );
}

function handleClientMessage(input: {
  message: LocalToolClientMessage;
  userId: string;
  socket: WebSocket;
  devices: DeviceRegistry;
  broker: LocalToolBroker;
  log: FastifyBaseLogger;
  state: { deviceId: string | null };
}): void {
  const { message, userId, socket, devices, broker, log, state } = input;

  switch (message.type) {
    case "device.hello": {
      const device = devices.register({
        ...message.payload,
        userId,
        socket,
      });
      state.deviceId = device.deviceId;
      log.info(
        {
          userId,
          deviceId: device.deviceId,
          platform: device.platform,
        },
        "local tool device connected",
      );
      return;
    }

    case "device.ready": {
      if (state.deviceId !== message.payload.deviceId) {
        sendError(
          socket,
          "device.ready",
          "deviceId does not match connection.",
        );
        return;
      }
      devices.markReady(message.payload.deviceId, message.payload.manifests);
      return;
    }

    case "workspace.attach": {
      if (state.deviceId !== message.payload.deviceId) {
        sendError(
          socket,
          "workspace.attach",
          "deviceId does not match connection.",
        );
        return;
      }
      devices.attachWorkspace(message.payload);
      return;
    }

    case "workspace.detach": {
      if (state.deviceId !== message.payload.deviceId) {
        sendError(
          socket,
          "workspace.detach",
          "deviceId does not match connection.",
        );
        return;
      }
      devices.detachWorkspace(
        message.payload.deviceId,
        message.payload.workspaceId,
      );
      return;
    }

    case "tool.result": {
      broker.complete(message.payload);
      return;
    }

    case "tool.error": {
      broker.complete({
        requestId: message.payload.requestId,
        success: false,
        error: message.payload.error,
      });
      return;
    }

    case "approval.decision": {
      // 桌面回传审批决策。校验 pending 归属，防止跨用户越权。
      const pending = approvalCoordinator.getPending(
        message.payload.approvalId,
      );
      if (!pending || pending.userId !== userId) {
        return;
      }
      resolveApproval(
        message.payload.approvalId,
        message.payload.decision,
        "desktop",
        log,
      );
      return;
    }
  }
}

export const localToolDevices = new DeviceRegistry();
export const localToolBroker = new LocalToolBroker(localToolDevices);
export const approvalCoordinator = new ApprovalCoordinator();

// 向该用户所有在线桌面广播审批请求。任一台桌面均可审批；执行仍定向到指定设备。
export function broadcastApprovalRequest(
  userId: string,
  payload: Extract<
    LocalToolServerMessage,
    { type: "approval.request" }
  >["payload"],
): void {
  const message: LocalToolServerMessage = {
    type: "approval.request",
    payload,
  };
  const serialized = JSON.stringify(message);
  for (const device of localToolDevices.getDevicesForUser(userId)) {
    device.socket.send(serialized);
  }
}

// 向该用户所有在线桌面广播审批已定，供关闭其他桌面上仍开着的弹窗。
export function broadcastApprovalResolved(
  userId: string,
  approvalId: string,
  decision: ApprovalDecision,
  decidedBy: ApprovalDecidedBy,
): void {
  const message: LocalToolServerMessage = {
    type: "approval.resolved",
    payload: { approvalId, decision, decidedBy },
  };
  const serialized = JSON.stringify(message);
  for (const device of localToolDevices.getDevicesForUser(userId)) {
    device.socket.send(serialized);
  }
}

// 统一的审批 settle 入口：先在协调器登记决策，成功后向桌面广播收敛弹窗。
// 返回是否为首次 settle（竞态去抖：后到者返回 false）。
export function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
  decidedBy: ApprovalDecidedBy,
  log?: FastifyBaseLogger,
): boolean {
  const pending = approvalCoordinator.getPending(approvalId);
  if (!pending) {
    return false;
  }
  const settled = approvalCoordinator.resolve(approvalId, decision, decidedBy);
  if (settled) {
    broadcastApprovalResolved(pending.userId, approvalId, decision, decidedBy);
    log?.info(
      { approvalId, decision, decidedBy, userId: pending.userId },
      "local tool approval resolved",
    );
  }
  return settled;
}

export function installLocalToolSocket(input: {
  server: import("node:http").Server;
  log: FastifyBaseLogger;
}) {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/api/local-tools/ws",
  });

  input.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/api/local-tools/ws") {
      return;
    }

    const token = tokenFromUrl(request.url);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    void verifySession(token).then((userId) => {
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, userId);
      });
    });
  });

  wss.on(
    "connection",
    (socket: WebSocket, _request: IncomingMessage, userId: string) => {
      const state: { deviceId: string | null } = { deviceId: null };

      socket.on("message", (data: RawData) => {
        try {
          const parsed = localToolClientMessageSchema.parse(
            parseSocketMessage(data),
          );
          if (state.deviceId) {
            localToolDevices.touch(state.deviceId);
          }
          handleClientMessage({
            message: parsed,
            userId,
            socket,
            devices: localToolDevices,
            broker: localToolBroker,
            log: input.log,
            state,
          });
        } catch (error) {
          input.log.warn({ err: error }, "invalid local tool socket message");
        }
      });

      socket.on("close", () => {
        if (!state.deviceId) {
          return;
        }

        localToolDevices.unregister(state.deviceId);
        localToolBroker.failDevice(state.deviceId);
        input.log.info(
          { userId, deviceId: state.deviceId },
          "local tool device disconnected",
        );
      });
    },
  );

  return wss;
}
