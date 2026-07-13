import type { ToolSet } from "ai";
import type { LocalToolBroker } from "../local-tools/local-tool-broker.js";

export type ToolSource = "builtin" | "mcp" | "local" | "remote";
export type ToolRiskLevel = "read" | "write" | "dangerous";

export type ToolExecutionContext = {
  userId: string;
  sessionId: string;
  runId?: string;
  deviceId?: string;
  workspaceId?: string;
  // 用户是否在本次请求中开启了联网检索（客户端 Search 开关）。
  webSearchRequested?: boolean;
  localToolBroker?: LocalToolBroker;
  onToolEvent?: (event: MuseToolRuntimeEvent) => void;
};

export type MuseToolMetadata = {
  name: string;
  title: string;
  source: ToolSource;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
};

export type MuseToolSet = ToolSet;

export type RegisteredMuseTools = {
  tools: MuseToolSet;
  metadataByName: Map<string, MuseToolMetadata>;
};

export type MuseToolRuntimeEvent =
  | {
      type: "tool-start";
      id: string;
      name: string;
      source: ToolSource;
      riskLevel: ToolRiskLevel;
      requiresApproval: boolean;
      input: unknown;
    }
  | {
      type: "tool-result";
      id: string;
      name: string;
      status: "succeeded" | "failed";
      output?: unknown;
      error?: string;
    };
