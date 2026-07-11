import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  localToolClientMessageSchema,
  type LocalToolClientMessage,
} from "@muse/shared";
import { verifySession } from "../auth/session.js";
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
  }
}

export const localToolDevices = new DeviceRegistry();
export const localToolBroker = new LocalToolBroker(localToolDevices);

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
