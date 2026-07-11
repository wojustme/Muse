#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const appPath = resolve(
  repoRoot,
  "apps/desktop/src-tauri/target/debug/bundle/macos/Muse.app",
);
const binaryPath = `${appPath}/Contents/MacOS/muse-desktop`;
const serverHealthUrl = process.env.MUSE_SERVER_HEALTH_URL ?? "http://127.0.0.1:8787/health";
const serverLogPath = process.env.MUSE_SERVER_LOG_PATH ?? "/tmp/muse-server-dev.log";

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 0;
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return result.stdout;
}

function listMuseProcesses() {
  const ps = output("ps", ["-axo", "pid=,command="]);
  return ps
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((processInfo) => {
      if (!processInfo) {
        return false;
      }

      return (
        processInfo.command.includes(
          "apps/desktop/src-tauri/target/debug/bundle/macos/Muse.app/Contents/MacOS/muse-desktop",
        ) ||
        processInfo.command.includes(
          "apps/desktop/src-tauri/target/release/bundle/macos/Muse.app/Contents/MacOS/muse-desktop",
        ) ||
        processInfo.command.includes("apps/desktop/src-tauri/target/debug/muse-desktop")
      );
    });
}

function stopStaleDesktopProcesses() {
  const staleProcesses = listMuseProcesses();

  if (!staleProcesses.length) {
    console.log("No stale Muse desktop process found.");
    return;
  }

  for (const processInfo of staleProcesses) {
    console.log(`Stopping stale Muse desktop process ${processInfo.pid}`);
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function buildDebugBundle() {
  run("pnpm", ["--filter", "@muse/desktop", "typecheck"]);
  run("pnpm", ["--filter", "@muse/desktop", "build"]);

  const status = run("pnpm", [
    "--filter",
    "@muse/desktop",
    "exec",
    "tauri",
    "build",
    "--debug",
  ]);

  if (status !== 0 && !existsSync(appPath)) {
    throw new Error("Tauri debug build failed before Muse.app was generated.");
  }

  if (status !== 0) {
    console.warn(
      "Tauri debug build exited non-zero after generating Muse.app. Continuing with the debug app bundle.",
    );
  }
}

function openDebugBundle() {
  if (!existsSync(binaryPath)) {
    throw new Error(`Debug app binary does not exist: ${binaryPath}`);
  }

  run("open", ["-n", appPath]);
}

function sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

async function isServerReady() {
  try {
    const response = await fetch(serverHealthUrl);
    return response.ok;
  } catch {
    return false;
  }
}

function startServerDev() {
  const logFd = openSync(serverLogPath, "a");
  const child = spawn("pnpm", ["--filter", "@muse/server", "run", "dev"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  console.log(`Started Muse server dev process ${child.pid}. Logs: ${serverLogPath}`);
}

async function ensureServerReady() {
  if (await isServerReady()) {
    console.log(`Muse server is ready: ${serverHealthUrl}`);
    return;
  }

  console.log("Muse server is not ready. Starting @muse/server dev server...");
  startServerDev();

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (await isServerReady()) {
      console.log(`Muse server is ready: ${serverHealthUrl}`);
      return;
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }

  throw new Error(`Muse server did not become ready. Check ${serverLogPath}`);
}

function foregroundWindow() {
  const script = [
    'tell application "System Events" to tell process "muse-desktop" to set position of window "Muse" to {120, 120}',
    'tell application "System Events" to tell process "muse-desktop" to set size of window "Muse" to {1200, 800}',
    'tell application "System Events" to tell process "muse-desktop" to perform action "AXRaise" of window "Muse"',
    'tell application "System Events" to set frontmost of process "muse-desktop" to true',
    'tell application "System Events" to tell process "muse-desktop" to get {position of window "Muse", size of window "Muse", frontmost, visible, value of attribute "AXMinimized" of window "Muse"}',
  ];

  const args = script.flatMap((line) => ["-e", line]);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = spawnSync("osascript", args, {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.status === 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return;
    }

    if (attempt === 20) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error("Muse window was not ready for foreground activation.");
    }

    sleep(250);
  }
}

try {
  await ensureServerReady();
  stopStaleDesktopProcesses();
  buildDebugBundle();
  openDebugBundle();
  foregroundWindow();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
