import { randomUUID } from "node:crypto";
import type {
  ToolRequestMessage,
  ToolResultMessage,
  LocalToolServerMessage,
} from "@muse/shared";
import type { DeviceRegistry } from "./device-registry.js";

export type LocalToolBrokerRequest = {
  sessionId: string;
  runId: string;
  userId: string;
  deviceId: string;
  workspaceId: string;
  toolName: string;
  arguments: unknown;
};

type PendingRequest = {
  deviceId: string;
  timer: NodeJS.Timeout;
  resolve: (result: ToolResultMessage["payload"]) => void;
};

function errorResult(
  requestId: string,
  code: string,
  message: string,
): ToolResultMessage["payload"] {
  return {
    requestId,
    success: false,
    error: { code, message },
  };
}

export class LocalToolBroker {
  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(private readonly devices: DeviceRegistry) {}

  async execute(
    request: LocalToolBrokerRequest,
    options?: { timeoutMs?: number },
  ): Promise<ToolResultMessage["payload"]> {
    const requestId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const device = this.devices.getDeviceForUser(
      request.userId,
      request.deviceId,
    );

    if (!device) {
      return errorResult(
        requestId,
        "DEVICE_OFFLINE",
        "Local device is offline.",
      );
    }

    if (!device.workspaces.has(request.workspaceId)) {
      return errorResult(
        requestId,
        "WORKSPACE_NOT_ATTACHED",
        "Workspace is not attached on this device.",
      );
    }

    const manifest = device.manifests.find(
      (item) => item.name === request.toolName,
    );
    if (!manifest) {
      return errorResult(
        requestId,
        "TOOL_NOT_FOUND",
        `Local tool is not available: ${request.toolName}`,
      );
    }

    const message: LocalToolServerMessage = {
      type: "tool.request",
      payload: {
        requestId,
        sessionId: request.sessionId,
        runId: request.runId,
        userId: request.userId,
        deviceId: request.deviceId,
        workspaceId: request.workspaceId,
        toolName: request.toolName,
        arguments: request.arguments,
        timeoutMs,
      },
    };

    return new Promise<ToolResultMessage["payload"]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(
          errorResult(requestId, "TOOL_TIMEOUT", "Local tool timed out."),
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        deviceId: request.deviceId,
        timer,
        resolve,
      });

      device.socket.send(JSON.stringify(message), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve(
          errorResult(
            requestId,
            "SEND_FAILED",
            error instanceof Error
              ? error.message
              : "Failed to send tool request.",
          ),
        );
      });
    });
  }

  complete(result: ToolResultMessage["payload"]): boolean {
    const pending = this.pendingRequests.get(result.requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(result.requestId);
    pending.resolve(result);
    return true;
  }

  failDevice(deviceId: string, code = "DEVICE_DISCONNECTED"): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.deviceId !== deviceId) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve(
        errorResult(requestId, code, "Local device disconnected."),
      );
    }
  }
}
