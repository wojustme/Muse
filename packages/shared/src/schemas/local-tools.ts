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

// 审批决策枚举与来源。decidedBy 记录是谁/为何定的（手机、桌面、超时、断连）。
export const approvalDecisionSchema = z.enum(["approved", "rejected"]);
export const approvalDecidedBySchema = z.enum([
  "mobile",
  "desktop",
  "timeout",
  "disconnect",
]);

// 工具参数的展示摘要：避免把完整 payload（可能很大）塞进审批事件。
export const approvalInputPreviewSchema = z.object({
  path: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  bytes: z.number().optional(),
  patchPreview: z.string().optional(),
  contentPreview: z.string().optional(),
});

// SSE 侧：服务端 → 发起对话方，请求对某次工具调用进行审批。
export const chatApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  eventId: z.string().min(1),
  toolName: z.string().min(1),
  riskLevel: localToolRiskLevelSchema,
  workspaceId: z.string().min(1),
  workspaceName: z.string().optional(),
  inputPreview: approvalInputPreviewSchema,
  expiresAt: z.string(),
});

// SSE 侧：服务端 → 发起对话方，通知某审批已定（供收敛弹窗与卡片状态）。
export const chatApprovalResolvedSchema = z.object({
  approvalId: z.string().min(1),
  eventId: z.string().min(1),
  decision: approvalDecisionSchema,
  decidedBy: approvalDecidedBySchema,
});

// WS 侧：服务端 → 桌面，广播审批请求（该用户所有在线桌面均可审批）。
export const approvalRequestMessageSchema = z.object({
  type: z.literal("approval.request"),
  payload: z.object({
    approvalId: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    workspaceId: z.string().min(1),
    toolName: z.string().min(1),
    displayName: z.string().min(1),
    riskLevel: localToolRiskLevelSchema,
    arguments: z.unknown(),
    expiresAt: z.string(),
  }),
});

// WS 侧：服务端 → 桌面，广播审批已定（供关闭其他桌面上的弹窗）。
export const approvalResolvedMessageSchema = z.object({
  type: z.literal("approval.resolved"),
  payload: z.object({
    approvalId: z.string().min(1),
    decision: approvalDecisionSchema,
    decidedBy: approvalDecidedBySchema,
  }),
});

// WS 侧：桌面 → 服务端，回传审批决策。
export const approvalDecisionMessageSchema = z.object({
  type: z.literal("approval.decision"),
  payload: z.object({
    approvalId: z.string().min(1),
    deviceId: z.string().min(1),
    decision: approvalDecisionSchema,
  }),
});

export const localToolClientMessageSchema = z.discriminatedUnion("type", [
  deviceHelloMessageSchema,
  deviceReadyMessageSchema,
  workspaceAttachMessageSchema,
  workspaceDetachMessageSchema,
  toolResultMessageSchema,
  toolErrorMessageSchema,
  approvalDecisionMessageSchema,
]);

export const localToolServerMessageSchema = z.discriminatedUnion("type", [
  toolRequestMessageSchema,
  approvalRequestMessageSchema,
  approvalResolvedMessageSchema,
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
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalDecidedBy = z.infer<typeof approvalDecidedBySchema>;
export type ApprovalInputPreview = z.infer<typeof approvalInputPreviewSchema>;
export type ChatApprovalRequest = z.infer<typeof chatApprovalRequestSchema>;
export type ChatApprovalResolved = z.infer<typeof chatApprovalResolvedSchema>;
export type ApprovalRequestMessage = z.infer<
  typeof approvalRequestMessageSchema
>;
export type ApprovalResolvedMessage = z.infer<
  typeof approvalResolvedMessageSchema
>;
export type ApprovalDecisionMessage = z.infer<
  typeof approvalDecisionMessageSchema
>;
export type LocalToolClientMessage = z.infer<
  typeof localToolClientMessageSchema
>;
export type LocalToolServerMessage = z.infer<
  typeof localToolServerMessageSchema
>;
