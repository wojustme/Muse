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
  localToolBroker?: LocalToolBroker;
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
