import { z } from "zod";

export const localToolRiskLevelSchema = z.enum(["read", "write", "dangerous"]);

export const localToolManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.unknown(),
  riskLevel: localToolRiskLevelSchema,
  requiresApproval: z.boolean(),
  outputLimitBytes: z.number().int().positive(),
});

export const localToolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const deviceHelloMessageSchema = z.object({
  type: z.literal("device.hello"),
  payload: z.object({
    deviceId: z.string().min(1),
    name: z.string().min(1),
    platform: z.string().min(1),
    appVersion: z.string().optional(),
  }),
});

export const deviceReadyMessageSchema = z.object({
  type: z.literal("device.ready"),
  payload: z.object({
    deviceId: z.string().min(1),
    manifests: z.array(localToolManifestSchema),
  }),
});

export const workspaceAttachMessageSchema = z.object({
  type: z.literal("workspace.attach"),
  payload: z.object({
    deviceId: z.string().min(1),
    workspaceId: z.string().min(1),
    displayName: z.string().min(1),
  }),
});

export const workspaceDetachMessageSchema = z.object({
  type: z.literal("workspace.detach"),
  payload: z.object({
    deviceId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
});

export const toolRequestMessageSchema = z.object({
  type: z.literal("tool.request"),
  payload: z.object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    workspaceId: z.string().min(1),
    toolName: z.string().min(1),
    arguments: z.unknown(),
    timeoutMs: z.number().int().positive(),
  }),
});

export const toolResultMessageSchema = z.object({
  type: z.literal("tool.result"),
  payload: z.object({
    requestId: z.string().min(1),
    success: z.boolean(),
    result: z.unknown().optional(),
    error: localToolErrorSchema.optional(),
  }),
});

export const toolErrorMessageSchema = z.object({
  type: z.literal("tool.error"),
  payload: z.object({
    requestId: z.string().min(1),
    error: localToolErrorSchema,
  }),
});

export const localToolClientMessageSchema = z.discriminatedUnion("type", [
  deviceHelloMessageSchema,
  deviceReadyMessageSchema,
  workspaceAttachMessageSchema,
  workspaceDetachMessageSchema,
  toolResultMessageSchema,
  toolErrorMessageSchema,
]);

export const localToolServerMessageSchema = z.discriminatedUnion("type", [
  toolRequestMessageSchema,
]);

export type LocalToolRiskLevel = z.infer<typeof localToolRiskLevelSchema>;
export type LocalToolManifest = z.infer<typeof localToolManifestSchema>;
export type LocalToolError = z.infer<typeof localToolErrorSchema>;
export type DeviceHelloMessage = z.infer<typeof deviceHelloMessageSchema>;
export type DeviceReadyMessage = z.infer<typeof deviceReadyMessageSchema>;
export type WorkspaceAttachMessage = z.infer<
  typeof workspaceAttachMessageSchema
>;
export type WorkspaceDetachMessage = z.infer<
  typeof workspaceDetachMessageSchema
>;
export type ToolRequestMessage = z.infer<typeof toolRequestMessageSchema>;
export type ToolResultMessage = z.infer<typeof toolResultMessageSchema>;
export type ToolErrorMessage = z.infer<typeof toolErrorMessageSchema>;
export type LocalToolClientMessage = z.infer<
  typeof localToolClientMessageSchema
>;
export type LocalToolServerMessage = z.infer<
  typeof localToolServerMessageSchema
>;
