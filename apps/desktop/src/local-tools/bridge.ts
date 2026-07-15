import { invoke } from "@tauri-apps/api/core";
import type {
  ApprovalDecision,
  ApprovalRequestMessage,
  ApprovalResolvedMessage,
  LocalToolManifest,
  LocalToolServerMessage,
  ToolResultMessage,
} from "@muse/shared";
import { loadToken } from "../auth/client";

export type LocalToolBridgeStatus =
  "disabled" | "connecting" | "ready" | "closed" | "error";

export type WorkspaceBinding = {
  workspaceId: string;
  displayName: string;
  rootPath: string;
};

export type LocalToolBridgeSnapshot = {
  status: LocalToolBridgeStatus;
  deviceId: string;
  // null 表示「空工作区」：不挂载任何目录，本地文件工具不可用，但聊天照常。
  workspace: WorkspaceBinding | null;
  error?: string;
};

export type LocalToolApprovalRequest = {
  id: string;
  toolName: string;
  title: string;
  riskLevel: "read" | "write" | "dangerous";
  workspace: WorkspaceBinding;
  details: Array<{
    label: string;
    value: string;
  }>;
};

type DirectoryListing = {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory" | "other";
    size?: number;
    readonly: boolean;
  }>;
  truncated: boolean;
};

type FileReadResult = {
  path: string;
  content: string;
  truncated: boolean;
};

type FileWriteResult = {
  path: string;
  created: boolean;
  bytesWritten: number;
  previousContent?: string;
  previousTruncated: boolean;
};

type PatchApplyResult = {
  path: string;
  bytesWritten: number;
  hunksApplied: number;
  previousContent: string;
  previousTruncated: boolean;
};

type SearchResult = {
  query: string;
  matches: Array<{
    path: string;
    line: number;
    preview: string;
  }>;
  truncated: boolean;
};

type CommandRunResult = {
  command: string;
  cwd: string;
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

// 服务端 WS 广播来的审批请求负载。桌面据此弹窗，用户决定后回传 approval.decision。
export type DesktopApprovalRequest = ApprovalRequestMessage["payload"];
// 服务端 WS 广播来的审批已定负载。
export type DesktopApprovalResolved = ApprovalResolvedMessage["payload"];

type LocalToolBridgeOptions = {
  serverUrl: string;
  // 初始工作区，null 表示空工作区（不挂载目录）。运行期可通过 setWorkspace 修改。
  workspace: WorkspaceBinding | null;
  onStatus?: (snapshot: LocalToolBridgeSnapshot) => void;
  // 收到服务端审批请求：由上层弹窗，决定后调用 sendApprovalDecision 回传（火发即忘）。
  onApprovalRequest?: (request: DesktopApprovalRequest) => void;
  // 审批已定（本端或其他端）：上层据此关闭仍开着的弹窗。
  onApprovalResolved?: (resolved: DesktopApprovalResolved) => void;
};

const manifests: LocalToolManifest[] = [
  {
    name: "workspace.read_file",
    description: "Read a text file inside the attached macOS workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    riskLevel: "read",
    requiresApproval: false,
    outputLimitBytes: 32_000,
  },
  {
    name: "workspace.search_files",
    description: "Search text files inside the attached macOS workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
      },
      required: ["query"],
    },
    riskLevel: "read",
    requiresApproval: false,
    outputLimitBytes: 32_000,
  },
  {
    name: "workspace.list_directory",
    description:
      "List files and directories inside the attached macOS workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    riskLevel: "read",
    requiresApproval: false,
    outputLimitBytes: 32_000,
  },
  {
    name: "workspace.write_file",
    description:
      "Create or overwrite a text file inside the attached macOS workspace after user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    riskLevel: "write",
    requiresApproval: true,
    outputLimitBytes: 32_000,
  },
  {
    name: "workspace.apply_patch",
    description:
      "Apply a unified diff patch to one text file inside the attached macOS workspace after user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        patch: { type: "string" },
      },
      required: ["path", "patch"],
    },
    riskLevel: "write",
    requiresApproval: true,
    outputLimitBytes: 32_000,
  },
  {
    name: "workspace.run_command",
    description:
      "Run a bash command inside the attached macOS workspace after user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    riskLevel: "dangerous",
    requiresApproval: true,
    outputLimitBytes: 32_000,
  },
];

function stableDeviceId(): string {
  const key = "muse.localTools.deviceId";
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  localStorage.setItem(key, next);
  return next;
}

function socketUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/local-tools/ws";
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function errorPayload(
  requestId: string,
  code: string,
  message: string,
): ToolResultMessage {
  return {
    type: "tool.result",
    payload: {
      requestId,
      success: false,
      error: { code, message },
    },
  };
}

function inputPath(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("path" in args)) {
    return null;
  }
  const value = (args as { path?: unknown }).path;
  return typeof value === "string" && value.trim() ? value : null;
}

function inputQuery(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("query" in args)) {
    return null;
  }
  const value = (args as { query?: unknown }).query;
  return typeof value === "string" && value.trim() ? value : null;
}

function inputContent(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("content" in args)) {
    return null;
  }
  const value = (args as { content?: unknown }).content;
  return typeof value === "string" ? value : null;
}

function inputPatch(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("patch" in args)) {
    return null;
  }
  const value = (args as { patch?: unknown }).patch;
  return typeof value === "string" && value.trim() ? value : null;
}

function inputCommand(args: unknown): string | null {
  if (!args || typeof args !== "object" || !("command" in args)) {
    return null;
  }
  const value = (args as { command?: unknown }).command;
  return typeof value === "string" && value.trim() ? value : null;
}

function inputTimeoutMs(args: unknown): number | undefined {
  if (!args || typeof args !== "object" || !("timeoutMs" in args)) {
    return undefined;
  }
  const value = (args as { timeoutMs?: unknown }).timeoutMs;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function inputCwd(args: unknown): string {
  if (!args || typeof args !== "object") {
    return ".";
  }

  const value =
    "cwd" in args
      ? (args as { cwd?: unknown }).cwd
      : "path" in args
        ? (args as { path?: unknown }).path
        : undefined;

  return typeof value === "string" && value.trim() ? value : ".";
}

export class LocalToolBridge {
  readonly deviceId = stableDeviceId();
  private socket: WebSocket | null = null;
  private status: LocalToolBridgeStatus = "disabled";
  private error: string | undefined;
  // 当前工作区，null 表示空工作区。可在运行期通过 setWorkspace 动态切换。
  private currentWorkspace: WorkspaceBinding | null;

  constructor(private readonly options: LocalToolBridgeOptions) {
    this.currentWorkspace = options.workspace;
  }

  connect() {
    const token = loadToken();
    if (!token) {
      this.setStatus("disabled", "Missing auth token.");
      return;
    }

    this.disconnect();
    this.setStatus("connecting");

    const socket = new WebSocket(socketUrl(this.options.serverUrl, token));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({
        type: "device.hello",
        payload: {
          deviceId: this.deviceId,
          name: "Muse macOS",
          platform: "macos",
          appVersion: "0.1.0",
        },
      });
      this.send({
        type: "device.ready",
        payload: {
          deviceId: this.deviceId,
          manifests,
        },
      });
      // 空工作区不挂载任何目录，仅在有工作区时发送 attach。
      if (this.currentWorkspace) {
        this.send({
          type: "workspace.attach",
          payload: {
            deviceId: this.deviceId,
            workspaceId: this.currentWorkspace.workspaceId,
            displayName: this.currentWorkspace.displayName,
          },
        });
      }
      this.setStatus("ready");
    });

    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.status !== "disabled") {
        this.setStatus("closed");
      }
    });

    socket.addEventListener("error", () => {
      this.setStatus("error", "Local tool socket failed.");
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  snapshot(): LocalToolBridgeSnapshot {
    return {
      status: this.status,
      deviceId: this.deviceId,
      workspace: this.currentWorkspace,
      error: this.error,
    };
  }

  // 动态切换工作区：无需重连 socket，仅对已连接的会话发送 detach/attach。
  // next 为 null 表示切换到空工作区（卸载当前目录）。
  setWorkspace(next: WorkspaceBinding | null) {
    const previous = this.currentWorkspace;
    if (
      previous?.workspaceId === next?.workspaceId &&
      previous?.rootPath === next?.rootPath &&
      previous?.displayName === next?.displayName
    ) {
      return;
    }

    this.currentWorkspace = next;

    if (this.socket?.readyState === WebSocket.OPEN) {
      if (previous) {
        this.send({
          type: "workspace.detach",
          payload: {
            deviceId: this.deviceId,
            workspaceId: previous.workspaceId,
          },
        });
      }
      if (next) {
        this.send({
          type: "workspace.attach",
          payload: {
            deviceId: this.deviceId,
            workspaceId: next.workspaceId,
            displayName: next.displayName,
          },
        });
      }
    }

    this.options.onStatus?.(this.snapshot());
  }

  private setStatus(status: LocalToolBridgeStatus, error?: string) {
    this.status = status;
    this.error = error;
    this.options.onStatus?.(this.snapshot());
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  // 回传审批决策给服务端（任一端先回传即定，服务端做竞态去抖）。
  sendApprovalDecision(approvalId: string, decision: ApprovalDecision) {
    this.send({
      type: "approval.decision",
      payload: {
        approvalId,
        deviceId: this.deviceId,
        decision,
      },
    });
  }

  private async handleMessage(raw: unknown) {
    const message = JSON.parse(String(raw)) as LocalToolServerMessage;

    // 审批请求：转发给上层弹窗，不在此处执行/等待。
    if (message.type === "approval.request") {
      this.options.onApprovalRequest?.(message.payload);
      return;
    }

    // 审批已定：通知上层收敛（关闭其他端仍开着的弹窗）。
    if (message.type === "approval.resolved") {
      this.options.onApprovalResolved?.(message.payload);
      return;
    }

    if (message.type !== "tool.request") {
      return;
    }

    // 收到 tool.request 表示服务端已完成审批（若需审批），桌面直接执行。
    const { requestId, toolName } = message.payload;

    try {
      const result = await this.executeTool(
        toolName,
        message.payload.arguments,
      );

      this.send({
        type: "tool.result",
        payload: {
          requestId,
          success: true,
          result,
        },
      } satisfies ToolResultMessage);
    } catch (error) {
      this.send(
        errorPayload(
          requestId,
          "TOOL_EXECUTION_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async executeTool(toolName: string, args: unknown): Promise<unknown> {
    // 空工作区下不应收到工具请求（服务端不会注册本地工具）；防御性兜底。
    const workspace = this.currentWorkspace;
    if (!workspace) {
      throw new Error("No workspace attached. Select a workspace first.");
    }

    if (toolName === "workspace.read_file") {
      const path = inputPath(args);
      if (!path) {
        throw new Error("Missing path.");
      }

      return invoke<FileReadResult>("read_workspace_file", {
        path,
        workspaceRoot: workspace.rootPath,
      });
    }

    if (toolName === "workspace.search_files") {
      const query = inputQuery(args);
      if (!query) {
        throw new Error("Missing query.");
      }

      return invoke<SearchResult>("search_workspace_files", {
        query,
        path: inputPath(args) ?? ".",
        workspaceRoot: workspace.rootPath,
      });
    }

    if (toolName === "workspace.list_directory") {
      const path = inputPath(args);
      if (!path) {
        throw new Error("Missing path.");
      }

      return invoke<DirectoryListing>("list_workspace_directory", {
        path,
        workspaceRoot: workspace.rootPath,
      });
    }

    if (toolName === "workspace.write_file") {
      const path = inputPath(args);
      const content = inputContent(args);
      if (!path) {
        throw new Error("Missing path.");
      }
      if (content === null) {
        throw new Error("Missing content.");
      }

      // 审批已在服务端完成（收到 tool.request 即代表已批准），此处直接写入。
      return invoke<FileWriteResult>("write_workspace_file", {
        path,
        content,
        workspaceRoot: workspace.rootPath,
      });
    }

    if (toolName === "workspace.apply_patch") {
      const path = inputPath(args);
      const patch = inputPatch(args);
      if (!path) {
        throw new Error("Missing path.");
      }
      if (!patch) {
        throw new Error("Missing patch.");
      }

      // 审批已在服务端完成，此处直接应用补丁。
      return invoke<PatchApplyResult>("apply_workspace_patch", {
        path,
        patch,
        workspaceRoot: workspace.rootPath,
      });
    }

    if (toolName === "workspace.run_command") {
      const command = inputCommand(args);
      if (!command) {
        throw new Error("Missing command.");
      }

      const cwd = inputCwd(args);
      // 审批已在服务端完成，此处直接执行命令。
      return invoke<CommandRunResult>("run_workspace_command", {
        command,
        cwd,
        workspaceRoot: workspace.rootPath,
        timeoutMs: inputTimeoutMs(args),
        maxOutputBytes: 32_000,
      });
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }
}
