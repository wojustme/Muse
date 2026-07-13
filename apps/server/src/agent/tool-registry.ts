import { env } from "../config/env.js";
import { createLocalBashTools } from "./tools/local-bash.js";
import { createMacLocalTools } from "./tools/mac-local.js";
import { createModelTools } from "./tools/model.js";
import { createSessionTools } from "./tools/session.js";
import { timeTools } from "./tools/time.js";
import type {
  MuseToolMetadata,
  RegisteredMuseTools,
  ToolExecutionContext,
} from "./types.js";

const builtinToolMetadataList: MuseToolMetadata[] = [
  {
    name: "muse_time_now",
    title: "Current time",
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "muse_session_current",
    title: "Current session",
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "muse_session_messages",
    title: "Session messages",
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "muse_search_messages",
    title: "Search messages",
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "muse_models_available",
    title: "Available models",
    source: "builtin",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "ServerBash",
    title: "Server host bash",
    source: "local",
    riskLevel: "dangerous",
    requiresApproval: true,
  },
  {
    name: "LS",
    title: "List macOS directory",
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "Read",
    title: "Read macOS file",
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "Grep",
    title: "Search macOS files",
    source: "local",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    name: "Write",
    title: "Write macOS file",
    source: "local",
    riskLevel: "write",
    requiresApproval: true,
  },
  {
    name: "Edit",
    title: "Apply macOS file patch",
    source: "local",
    riskLevel: "write",
    requiresApproval: true,
  },
  {
    name: "Bash",
    title: "Run macOS local bash",
    source: "local",
    riskLevel: "dangerous",
    requiresApproval: true,
  },
];

const builtinToolMetadata = new Map<string, MuseToolMetadata>(
  builtinToolMetadataList.map((metadata) => [metadata.name, metadata]),
);

export function createBuiltinToolRegistry(
  context: ToolExecutionContext,
): RegisteredMuseTools {
  const tools = {
    ...timeTools,
    ...createSessionTools(context),
    ...createModelTools(context),
    ...(env.MUSE_LOCAL_BASH_ENABLED ? createLocalBashTools() : {}),
    ...(context.localToolBroker && context.deviceId && context.workspaceId
      ? createMacLocalTools(context)
      : {}),
  };

  return {
    tools,
    metadataByName: builtinToolMetadata,
  };
}
