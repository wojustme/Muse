import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";

function requireLocalToolContext(context: ToolExecutionContext) {
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

async function executeLocalTool(input: {
  context: ToolExecutionContext;
  toolName: string;
  arguments: unknown;
}) {
  const local = requireLocalToolContext(input.context);
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

  return result.result;
}

export function createMacLocalTools(context: ToolExecutionContext) {
  return {
    mac_read_file: tool({
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
      execute: async ({ path }) =>
        executeLocalTool({
          context,
          toolName: "workspace.read_file",
          arguments: { path },
        }),
    }),

    mac_search_files: tool({
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
      execute: async ({ query, path }) =>
        executeLocalTool({
          context,
          toolName: "workspace.search_files",
          arguments: { query, path: path ?? "." },
        }),
    }),

    mac_list_directory: tool({
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
      execute: async ({ path }) =>
        executeLocalTool({
          context,
          toolName: "workspace.list_directory",
          arguments: { path },
        }),
    }),

    mac_write_file: tool({
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
      execute: async ({ path, content }) =>
        executeLocalTool({
          context,
          toolName: "workspace.write_file",
          arguments: { path, content },
        }),
    }),

    mac_apply_patch: tool({
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
      execute: async ({ path, patch }) =>
        executeLocalTool({
          context,
          toolName: "workspace.apply_patch",
          arguments: { path, patch },
        }),
    }),

    mac_local_bash: tool({
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
      execute: async ({ command, cwd, timeoutMs }) =>
        executeLocalTool({
          context,
          toolName: "workspace.run_command",
          arguments: { command, cwd: cwd ?? ".", timeoutMs },
        }),
    }),
  };
}
