import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { ToolExecutionContext } from "../types.js";

const execFileAsync = promisify(execFile);
const repoRoot = "/Users/bytedance/codes/my/Muse";

function localBashAllowedRoots(): string[] {
  return env.MUSE_LOCAL_BASH_ALLOWED_ROOTS.split(",")
    .map((root) => root.trim())
    .filter(Boolean);
}

function truncateOutput(value: string): { text: string; truncated: boolean } {
  const limit = env.MUSE_LOCAL_BASH_MAX_OUTPUT_CHARS;

  if (value.length <= limit) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, limit)}\n[output truncated at ${limit} chars]`,
    truncated: true,
  };
}

function summarizeCommandOutput<T extends { stdout?: string; stderr?: string }>(
  result: T,
): T {
  return {
    ...result,
    stdout:
      typeof result.stdout === "string" && result.stdout.length > 2000
        ? `${result.stdout.slice(0, 2000)}\n[stdout truncated for UI]`
        : result.stdout,
    stderr:
      typeof result.stderr === "string" && result.stderr.length > 2000
        ? `${result.stderr.slice(0, 2000)}\n[stderr truncated for UI]`
        : result.stderr,
  };
}

async function resolveAllowedCwd(cwd?: string): Promise<string> {
  const requestedCwd = cwd?.trim() || repoRoot;
  const [resolvedCwd, ...resolvedRoots] = await Promise.all([
    realpath(requestedCwd),
    ...localBashAllowedRoots().map((root) => realpath(root)),
  ]);

  const allowed = resolvedRoots.some(
    (root) => resolvedCwd === root || resolvedCwd.startsWith(`${root}/`),
  );

  if (!allowed) {
    throw new Error(
      `cwd is outside allowed roots: ${requestedCwd}. Allowed roots: ${localBashAllowedRoots().join(", ")}`,
    );
  }

  return resolvedCwd;
}

export function createLocalBashTools(context?: ToolExecutionContext) {
  return {
    ServerBash: tool({
      description:
        "Run a local bash command on the Muse server host. Use only when the user explicitly asks to execute a local shell command. Commands are high risk; prefer read-only inspection commands unless the user asks for changes.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(4000)
          .describe("Bash command to run via /bin/bash -lc."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Working directory. Must be under configured allowed roots.",
          ),
      }),
      execute: async ({ command, cwd }) => {
        const eventId = randomUUID();
        context?.onToolEvent?.({
          type: "tool-start",
          id: eventId,
          name: "ServerBash",
          source: "local",
          riskLevel: "dangerous",
          requiresApproval: true,
          input: { command, cwd: cwd ?? repoRoot },
        });

        if (!env.MUSE_LOCAL_BASH_ENABLED) {
          const error =
            "ServerBash is disabled. Set MUSE_LOCAL_BASH_ENABLED=true in the Muse server environment to enable it.";
          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "ServerBash",
            status: "failed",
            error,
          });
          throw new Error(error);
        }

        const startedAt = Date.now();
        let resolvedCwd: string;

        try {
          resolvedCwd = await resolveAllowedCwd(cwd);
        } catch (error) {
          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "ServerBash",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        try {
          const result = await execFileAsync("/bin/bash", ["-lc", command], {
            cwd: resolvedCwd,
            timeout: env.MUSE_LOCAL_BASH_TIMEOUT_MS,
            maxBuffer: env.MUSE_LOCAL_BASH_MAX_OUTPUT_CHARS * 4,
            windowsHide: true,
          });
          const stdout = truncateOutput(result.stdout ?? "");
          const stderr = truncateOutput(result.stderr ?? "");

          const output = {
            command,
            cwd: resolvedCwd,
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          };

          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "ServerBash",
            status: "succeeded",
            output: summarizeCommandOutput(output),
          });

          return output;
        } catch (error) {
          const execError = error as {
            code?: number | string;
            killed?: boolean;
            signal?: NodeJS.Signals;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          const stdout = truncateOutput(execError.stdout ?? "");
          const stderr = truncateOutput(execError.stderr ?? "");

          const output = {
            command,
            cwd: resolvedCwd,
            exitCode:
              typeof execError.code === "number" ? execError.code : null,
            signal: execError.signal ?? null,
            timedOut: Boolean(execError.killed),
            durationMs: Date.now() - startedAt,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            errorMessage: execError.message ?? "Command failed",
          };

          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "ServerBash",
            status: "failed",
            output: summarizeCommandOutput(output),
            error: execError.message ?? "Command failed",
          });

          return output;
        }
      },
    }),
  };
}
