import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import type { ApprovalInputPreview } from "@muse/shared";
import { env } from "../../config/env.js";
import {
  approvalCoordinator,
  broadcastApprovalRequest,
  localToolDevices,
} from "../../local-tools/local-tool-socket.js";
import type { ToolExecutionContext } from "../types.js";

const toolPresentation = {
  Read: {
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  Grep: {
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  LS: {
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  Write: {
    source: "local",
    riskLevel: "write",
    requiresApproval: true,
  },
  Edit: {
    source: "local",
    riskLevel: "write",
    requiresApproval: true,
  },
  Bash: {
    source: "local",
    riskLevel: "dangerous",
    requiresApproval: true,
  },
} as const;

function summarizeLocalToolOutput(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if ("content" in value && typeof value.content === "string") {
    return {
      ...value,
      content:
        value.content.length > 2000
          ? `${value.content.slice(0, 2000)}\n[content truncated for UI]`
          : value.content,
    };
  }

  if ("stdout" in value || "stderr" in value) {
    const output = value as {
      stdout?: unknown;
      stderr?: unknown;
    };

    return {
      ...value,
      stdout:
        typeof output.stdout === "string" && output.stdout.length > 2000
          ? `${output.stdout.slice(0, 2000)}\n[stdout truncated for UI]`
          : output.stdout,
      stderr:
        typeof output.stderr === "string" && output.stderr.length > 2000
          ? `${output.stderr.slice(0, 2000)}\n[stderr truncated for UI]`
          : output.stderr,
    };
  }

  return value;
}

// 从工具参数抽取审批展示摘要：只带路径/命令/大小/截断预览，避免把完整 payload 塞进事件。
function buildInputPreview(args: unknown): ApprovalInputPreview {
  const preview: ApprovalInputPreview = {};
  if (!args || typeof args !== "object") {
    return preview;
  }
  const record = args as Record<string, unknown>;

  if (typeof record.path === "string") {
    preview.path = record.path;
  }
  if (typeof record.command === "string") {
    preview.command = record.command;
  }
  if (typeof record.cwd === "string") {
    preview.cwd = record.cwd;
  }
  if (typeof record.content === "string") {
    preview.bytes = new TextEncoder().encode(record.content).length;
    preview.contentPreview =
      record.content.length > 4000
        ? `${record.content.slice(0, 4000)}\n[content preview truncated]`
        : record.content;
  }
  if (typeof record.patch === "string") {
    preview.bytes = new TextEncoder().encode(record.patch).length;
    preview.patchPreview =
      record.patch.length > 8000
        ? `${record.patch.slice(0, 8000)}\n[patch preview truncated]`
        : record.patch;
  }

  return preview;
}

type ResolvedLocalToolContext = {
  broker: NonNullable<ToolExecutionContext["localToolBroker"]>;
  runId: string;
  deviceId: string;
  workspaceId: string;
};

function requireLocalToolContext(
  context: ToolExecutionContext,
): ResolvedLocalToolContext {
  if (
    !context.localToolBroker ||
    !context.runId ||
    !context.deviceId ||
    !context.workspaceId
  ) {
    throw new Error(
      "macOS local tools are unavailable. Connect a Muse desktop Local Tool Host and attach a workspace first.",
    );
  }

  return {
    broker: context.localToolBroker,
    runId: context.runId,
    deviceId: context.deviceId,
    workspaceId: context.workspaceId,
  };
}

// 审批阶段：向发起方（SSE）与该用户所有在线桌面（WS）广播审批请求，等待任一端回传。
// 返回 true 表示批准；抛错表示拒绝/超时/断连。仅在 requiresApproval 时调用。
async function runApprovalPhase(input: {
  context: ToolExecutionContext;
  local: ResolvedLocalToolContext;
  eventId: string;
  displayName: keyof typeof toolPresentation;
  toolName: string;
  arguments: unknown;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const presentation = toolPresentation[input.displayName];
  const workspace = localToolDevices
    .getDeviceForUser(input.context.userId, input.local.deviceId)
    ?.workspaces.get(input.local.workspaceId);

  const { approvalId, expiresAt, wait } = approvalCoordinator.request({
    userId: input.context.userId,
    sessionId: input.context.sessionId,
    runId: input.local.runId,
    deviceId: input.local.deviceId,
    eventId: input.eventId,
    toolName: input.displayName,
    timeoutMs: env.MUSE_APPROVAL_TIMEOUT_MS,
    abortSignal: input.abortSignal,
  });

  const expiresAtIso = expiresAt.toISOString();
  const inputPreview = buildInputPreview(input.arguments);

  // 发起方通道（SSE）：手机/桌面浏览器据此弹窗或更新工具卡片状态。
  input.context.onToolEvent?.({
    type: "approval-request",
    approvalId,
    eventId: input.eventId,
    toolName: input.displayName,
    riskLevel: presentation.riskLevel,
    workspaceId: input.local.workspaceId,
    workspaceName: workspace?.displayName,
    inputPreview,
    expiresAt: expiresAtIso,
  });

  // 桌面通道（WS）：该用户所有在线桌面均可审批。
  broadcastApprovalRequest(input.context.userId, {
    approvalId,
    sessionId: input.context.sessionId,
    runId: input.local.runId,
    userId: input.context.userId,
    deviceId: input.local.deviceId,
    workspaceId: input.local.workspaceId,
    toolName: input.toolName,
    displayName: input.displayName,
    riskLevel: presentation.riskLevel,
    arguments: input.arguments,
    expiresAt: expiresAtIso,
  });

  const outcome = await wait;

  // 通知发起方审批已定，供其收敛弹窗与卡片状态。
  input.context.onToolEvent?.({
    type: "approval-resolved",
    approvalId,
    eventId: input.eventId,
    decision: outcome.decision,
    decidedBy: outcome.decidedBy,
  });

  if (outcome.decision !== "approved") {
    throw new Error(outcome.reason ?? "USER_REJECTED");
  }
}

async function executeLocalTool(input: {
  context: ToolExecutionContext;
  displayName: keyof typeof toolPresentation;
  toolName: string;
  arguments: unknown;
  abortSignal?: AbortSignal;
}) {
  const local = requireLocalToolContext(input.context);
  const eventId = randomUUID();
  const presentation = toolPresentation[input.displayName];

  input.context.onToolEvent?.({
    type: "tool-start",
    id: eventId,
    name: input.displayName,
    source: presentation.source,
    riskLevel: presentation.riskLevel,
    requiresApproval: presentation.requiresApproval,
    input: input.arguments,
  });

  try {
    // 审批阶段：需审批的工具（Write/Edit/Bash）先等待任一端批准，未过则不执行。
    if (presentation.requiresApproval && input.context.approvalCoordinator) {
      await runApprovalPhase({
        context: input.context,
        local,
        eventId,
        displayName: input.displayName,
        toolName: input.toolName,
        arguments: input.arguments,
        abortSignal: input.abortSignal,
      });
    }

    const result = await local.broker.execute(
      {
        sessionId: input.context.sessionId,
        runId: local.runId,
        userId: input.context.userId,
        deviceId: local.deviceId,
        workspaceId: local.workspaceId,
        toolName: input.toolName,
        arguments: input.arguments,
      },
      { timeoutMs: 15_000 },
    );

    if (!result.success) {
      throw new Error(
        result.error?.message ?? "macOS local tool execution failed.",
      );
    }

    input.context.onToolEvent?.({
      type: "tool-result",
      id: eventId,
      name: input.displayName,
      status: "succeeded",
      output: summarizeLocalToolOutput(result.result),
    });

    return result.result;
  } catch (error) {
    input.context.onToolEvent?.({
      type: "tool-result",
      id: eventId,
      name: input.displayName,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function createMacLocalTools(context: ToolExecutionContext) {
  return {
    Read: tool({
      description:
        "Read a text file on the user's macOS device inside the attached workspace. Use this for local project files instead of accessing the server filesystem.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "File path to read. It must be inside the attached workspace on the user's Mac.",
          ),
      }),
      execute: async ({ path }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "Read",
          toolName: "workspace.read_file",
          arguments: { path },
          abortSignal,
        }),
    }),

    Grep: tool({
      description:
        "Search text files on the user's macOS device inside the attached workspace.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Text query to search for."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Directory path inside the attached workspace. Defaults to the workspace root.",
          ),
      }),
      execute: async ({ query, path }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "Grep",
          toolName: "workspace.search_files",
          arguments: { query, path: path ?? "." },
          abortSignal,
        }),
    }),

    LS: tool({
      description:
        "List files and directories on the user's macOS device inside the attached workspace. Use this instead of shell commands when the user asks to inspect a local directory such as ls -al.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Directory path to list. It must be inside the attached workspace on the user's Mac.",
          ),
      }),
      execute: async ({ path }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "LS",
          toolName: "workspace.list_directory",
          arguments: { path },
          abortSignal,
        }),
    }),

    Write: tool({
      description:
        "Create or overwrite a text file on the user's macOS device inside the attached workspace. Use this for local file creation or full-file replacement instead of shell redirection. The desktop client will ask the user to confirm before writing.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "File path to create or overwrite. It must be inside the attached workspace on the user's Mac.",
          ),
        content: z
          .string()
          .max(256_000)
          .describe("Complete text content to write to the file."),
      }),
      execute: async ({ path, content }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "Write",
          toolName: "workspace.write_file",
          arguments: { path, content },
          abortSignal,
        }),
    }),

    Edit: tool({
      description:
        "Apply a unified diff patch to an existing text file on the user's macOS device inside the attached workspace. Prefer this for targeted edits to existing files. The desktop client will show the patch and ask the user to confirm before writing.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Existing text file path to patch. It must be inside the attached workspace on the user's Mac.",
          ),
        patch: z
          .string()
          .min(1)
          .max(256_000)
          .describe(
            "Unified diff patch for the target file. Include ---/+++ headers and @@ hunks.",
          ),
      }),
      execute: async ({ path, patch }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "Edit",
          toolName: "workspace.apply_patch",
          arguments: { path, patch },
          abortSignal,
        }),
    }),

    Bash: tool({
      description:
        "Run a bash command on the user's macOS device inside the attached workspace. Use this for local command requests such as listing files, reading files with cat, creating files, editing files, or running project commands. This is high risk and the desktop client will ask the user to confirm before execution.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(4000)
          .describe("Bash command to run via /bin/bash -lc on the user's Mac."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Working directory inside the attached workspace. Defaults to the workspace root.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .optional()
          .describe("Command timeout in milliseconds."),
      }),
      execute: async ({ command, cwd, timeoutMs }, { abortSignal }) =>
        executeLocalTool({
          context,
          displayName: "Bash",
          toolName: "workspace.run_command",
          arguments: { command, cwd: cwd ?? ".", timeoutMs },
          abortSignal,
        }),
    }),
  };
}
