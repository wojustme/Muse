import { invoke } from "@tauri-apps/api/core";
import type {
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
  workspace: WorkspaceBinding;
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

type LocalToolBridgeOptions = {
  serverUrl: string;
  workspace: WorkspaceBinding;
  onStatus?: (snapshot: LocalToolBridgeSnapshot) => void;
  onApproval?: (request: LocalToolApprovalRequest) => Promise<boolean>;
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

  constructor(private readonly options: LocalToolBridgeOptions) {}

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
      this.send({
        type: "workspace.attach",
        payload: {
          deviceId: this.deviceId,
          workspaceId: this.options.workspace.workspaceId,
          displayName: this.options.workspace.displayName,
        },
      });
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
      workspace: this.options.workspace,
      error: this.error,
    };
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

  private async handleMessage(raw: unknown) {
    const message = JSON.parse(String(raw)) as LocalToolServerMessage;
    if (message.type !== "tool.request") {
      return;
    }

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
    if (toolName === "workspace.read_file") {
      const path = inputPath(args);
      if (!path) {
        throw new Error("Missing path.");
      }

      return invoke<FileReadResult>("read_workspace_file", {
        path,
        workspaceRoot: this.options.workspace.rootPath,
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
        workspaceRoot: this.options.workspace.rootPath,
      });
    }

    if (toolName === "workspace.list_directory") {
      const path = inputPath(args);
      if (!path) {
        throw new Error("Missing path.");
      }

      return invoke<DirectoryListing>("list_workspace_directory", {
        path,
        workspaceRoot: this.options.workspace.rootPath,
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

      const preview =
        content.length > 4000
          ? `${content.slice(0, 4000)}\n[content preview truncated]`
          : content;
      const approved = await this.requestApproval({
        id: crypto.randomUUID(),
        toolName,
        title: "Write local file",
        riskLevel: "write",
        workspace: this.options.workspace,
        details: [
          { label: "Workspace", value: this.options.workspace.displayName },
          { label: "Path", value: path },
          { label: "Bytes", value: String(new TextEncoder().encode(content).length) },
          { label: "New content", value: preview },
        ],
      });
      if (!approved) {
        throw new Error("USER_REJECTED");
      }

      return invoke<FileWriteResult>("write_workspace_file", {
        path,
        content,
        workspaceRoot: this.options.workspace.rootPath,
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

      const preview =
        patch.length > 8000
          ? `${patch.slice(0, 8000)}\n[patch preview truncated]`
          : patch;
      const approved = await this.requestApproval({
        id: crypto.randomUUID(),
        toolName,
        title: "Apply local patch",
        riskLevel: "write",
        workspace: this.options.workspace,
        details: [
          { label: "Workspace", value: this.options.workspace.displayName },
          { label: "Path", value: path },
          { label: "Patch bytes", value: String(new TextEncoder().encode(patch).length) },
          { label: "Unified diff", value: preview },
        ],
      });
      if (!approved) {
        throw new Error("USER_REJECTED");
      }

      return invoke<PatchApplyResult>("apply_workspace_patch", {
        path,
        patch,
        workspaceRoot: this.options.workspace.rootPath,
      });
    }

    if (toolName === "workspace.run_command") {
      const command = inputCommand(args);
      if (!command) {
        throw new Error("Missing command.");
      }

      const cwd = inputCwd(args);
      const approved = await this.requestApproval({
        id: crypto.randomUUID(),
        toolName,
        title: "Run local command",
        riskLevel: "dangerous",
        workspace: this.options.workspace,
        details: [
          { label: "Workspace", value: this.options.workspace.displayName },
          { label: "Working directory", value: cwd },
          { label: "Command", value: command },
        ],
      });
      if (!approved) {
        throw new Error("USER_REJECTED");
      }

      return invoke<CommandRunResult>("run_workspace_command", {
        command,
        cwd,
        workspaceRoot: this.options.workspace.rootPath,
        timeoutMs: inputTimeoutMs(args),
        maxOutputBytes: 32_000,
      });
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  private async requestApproval(
    request: LocalToolApprovalRequest,
  ): Promise<boolean> {
    if (this.options.onApproval) {
      return this.options.onApproval(request);
    }

    return window.confirm(
      `${request.title}\n\n${request.details
        .map((detail) => `${detail.label}: ${detail.value}`)
        .join("\n")}`,
    );
  }
}
