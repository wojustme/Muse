# 跨端本地工具审批实施方案（手机 + 桌面双端可审批）

本文档依据当前代码整理，描述"本地工具调用服务端集中式审批、手机与桌面两端均可审批"的实施方案与落地范围。

## 1. 背景与结论

Muse 现状：手机可"借用"某台在线桌面端的本地工具（Read/Grep/LS/Write/Edit/Bash），AI 的工具调用经服务端 WebSocket 转发到桌面执行。但**审批完全发生在桌面端本地**：

- 服务端 `apps/server/src/agent/tools/mac-local.ts` 的 `executeLocalTool` 直接 `await broker.execute(...)` 转发工具请求；
- 桌面 `apps/desktop/src/local-tools/bridge.ts` 的 `executeTool` 在写/命令类工具执行前调用 `requestApproval`，弹窗在桌面本地完成，服务端与手机对审批完全无感知。

因此手机能"触发"桌面工具，却**不能审批**——写文件/跑命令的确认弹窗只出现在 Mac 上。

需求：做出类 Codex 的桌面/手机联动审批体验——AI 要执行敏感操作（Write/Edit/Bash）时，无论用户在手机还是桌面，都能实时看到操作预览并远程批准/拒绝，批准后由桌面执行。

关键结论与决策（已与用户确认）：

- **两端都可审批**：任一端批准即执行、任一端拒绝即取消。
- **服务端集中协调**：审批决策上移到服务端，桌面 bridge 不再自弹自决；服务端向发起方（SSE）与在线桌面（WS）广播审批请求，收齐首个决策后再放行执行。
- **推送通道复用**：向手机复用当前 `/api/chat` 的 SSE 流下发审批事件；手机新增一个 POST 接口回传决策；桌面复用已有的 local-tools WebSocket。

## 2. 架构与时序

```txt
Node.js Server
  - Chat SSE 流（/api/chat）
  - Local Tool Broker（转发执行）
  - Approval Coordinator（新增：等待人工审批）
  - POST /api/chat/approval（新增：手机回传决策）
  - local-tools WebSocket（新增 approval.request/resolved/decision）

发起方（手机 / 桌面浏览器）
  - SSE 消费 approval-request → 弹窗 / 更新工具卡片
  - 手机：POST /api/chat/approval 回传决策

在线桌面（执行方 + 旁路审批方）
  - WS 收 approval.request → 弹窗
  - WS 回传 approval.decision
  - WS 收 approval.resolved → 收敛弹窗
  - WS 收 tool.request → 执行（此时已批准）
```

新时序（需审批工具）：

```txt
tool-start
  → approval-request（SSE 给发起方 + WS 广播给该用户所有在线桌面）
  → [任一端回传决策] approval.decision(WS) / POST /api/chat/approval
  → approval-resolved（SSE + WS 广播，收敛两端弹窗）
  → 批准: broker.execute → tool.request → 桌面执行 → tool.result
     拒绝/超时/断连: 直接 tool-result(failed)，不执行
```

只读工具（Read/Grep/LS，`requiresApproval=false`）不进入审批阶段，直接执行。

## 3. 协议扩展（packages/shared）

文件：`packages/shared/src/schemas/local-tools.ts`（经 `index.ts` 统一导出，新增自动可用）。

### 3.1 SSE 侧（服务端 → 发起方）

- `chatApprovalRequestSchema`：`approvalId, eventId, toolName, riskLevel, workspaceId, workspaceName?, inputPreview, expiresAt`。
- `chatApprovalResolvedSchema`：`approvalId, eventId, decision, decidedBy`。
- `approvalInputPreviewSchema`：`path? / command? / cwd? / bytes? / patchPreview? / contentPreview?`（参数展示摘要，避免塞完整 payload）。
- SSE 事件 `type` 为 `approval-request` / `approval-resolved`（扁平对象，字段在顶层）。

### 3.2 WS 侧（桌面 ↔ 服务端）

- server → desktop 新增 `approval.request`、`approval.resolved`，并入 `localToolServerMessageSchema`。
- desktop → server 新增 `approval.decision`，并入 `localToolClientMessageSchema`。
- 决策枚举：`approvalDecisionSchema = ["approved","rejected"]`；来源 `approvalDecidedBySchema = ["mobile","desktop","timeout","disconnect"]`。

## 4. 服务端

### 4.1 审批协调器（新增）

文件：`apps/server/src/local-tools/approval-coordinator.ts`。仿 `LocalToolBroker` 的 pending Map + Promise resolve，但语义是"等待人工审批"：

- `request(input)`：登记 `approvalId`，返回 `{ approvalId, expiresAt, wait: Promise<ApprovalOutcome> }`；`wait` 直到有决策 / 超时 / abort 才 resolve。
- `resolve(approvalId, decision, decidedBy)`：命中已 settled/不存在返回 false（**竞态去抖**，后到者被忽略）。
- `getPending(approvalId)`：供越权校验（回传者 userId 必须与登记者一致）。
- `failRun(runId, reason)`：run 结束/断开时兜底取消该 run 全部待审批。
- 超时：`env.MUSE_APPROVAL_TIMEOUT_MS`（默认 120s，远长于执行超时）；发起方断开经 `abortSignal` 立即取消（`CLIENT_DISCONNECTED`）。

### 4.2 socket 层

文件：`apps/server/src/local-tools/local-tool-socket.ts`。

- 导出协调器单例 `approvalCoordinator`。
- `handleClientMessage` 新增 `approval.decision` 分支（校验 `pending.userId === userId` 后 `resolveApproval`）。
- `broadcastApprovalRequest(userId, payload)` / `broadcastApprovalResolved(...)`：遍历该用户所有在线设备下发（依赖 `DeviceRegistry.getDevicesForUser`，新增）。
- `resolveApproval(approvalId, decision, decidedBy, log?)`：统一 settle 入口，成功后向桌面广播 `approval.resolved` 收敛弹窗。

### 4.3 工具审批阶段

文件：`apps/server/src/agent/tools/mac-local.ts`。

- `executeLocalTool` 在 `tool-start` 之后、`broker.execute` 之前，若 `toolPresentation[displayName].requiresApproval` 则调 `runApprovalPhase`：
  - `approvalCoordinator.request(...)` 拿到 `approvalId`；
  - `onToolEvent({type:"approval-request", ...})` 走 SSE；`broadcastApprovalRequest(...)` 走 WS；
  - `await wait`，再发 `approval-resolved`；未批准则 throw（`tool-result` 记 failed）。
- 6 个工具的 `execute` 签名接收 AI SDK 第二参 `{ abortSignal }` 并透传，使发起方断开能取消审批等待。
- `buildInputPreview(args)`：抽取 path/command/cwd/bytes/预览。
- `ToolExecutionContext` 新增 `approvalCoordinator?`；`MuseToolRuntimeEvent` 新增 `approval-request` / `approval-resolved` 变体（`apps/server/src/agent/types.ts`）。

### 4.4 chat 路由

文件：`apps/server/src/routes/chat.ts`。

- 注入 `approvalCoordinator` 到 `createBuiltinToolRegistry`；`onToolEvent` 无差别 `writeSseEvent`，审批事件自动进入 SSE。
- 新增 `POST /api/chat/approval`：body `{ approvalId, decision }`，校验 `pending.userId === request.userId`，`resolveApproval(..., "mobile")`，返回 `{ ok, settled }`（幂等，竞态后到者 `settled=false`）。
- 请求断开（`request.raw.on("close")`）时 `approvalCoordinator.failRun(runId, "CLIENT_DISCONNECTED")`；`finally` 再 `failRun(runId, "RUN_COMPLETED")` 兜底。

### 4.5 配置

文件：`apps/server/src/config/env.ts` 新增 `MUSE_APPROVAL_TIMEOUT_MS`（默认 120000）。

## 5. 桌面端（apps/desktop）

### 5.1 bridge.ts

- 删除 `executeTool` 内 Write/Edit/Bash 的本地 `requestApproval`——收到 `tool.request` 即代表已被服务端批准，直接执行。
- `handleMessage` 分流：`approval.request` → `onApprovalRequest`（转发上层弹窗，不 await）；`approval.resolved` → `onApprovalResolved`（收敛弹窗）；`tool.request` → 执行。
- 新增 `sendApprovalDecision(approvalId, decision)`（发 `approval.decision`）。
- Options 用 `onApprovalRequest`/`onApprovalResolved` 取代 `onApproval`；导出 `DesktopApprovalRequest`/`DesktopApprovalResolved`。

### 5.2 App.tsx

- `ApprovalPrompt` 改为 `DesktopApprovalRequest & { details }`，详情由本地 `buildApprovalDetails(arguments)` 生成。
- bridge 构造改用 `onApprovalRequest`（存弹窗）+ `onApprovalResolved`（按 `approvalId` 关闭）。
- `resolveApproval` 改为 `sendApprovalDecision` + 乐观关闭。
- `ToolRuntimeCall.status` 新增 `awaiting-approval`；`ToolCallList` 渲染等待态。
- **桌面双通道去重**：桌面若同时是发起方（SSE）与在线桌面（WS），弹窗只认 WS `approval.request`；SSE 的 `approval-request`/`approval-resolved` 仅更新工具卡片状态。

## 6. 手机端（apps/mobile）

- `packages/api-client` + `apps/mobile/src/auth/client.ts` 新增 `postApprovalDecision(approvalId, decision)`（POST `/api/chat/approval`）。
- `App.tsx`：`ChatStreamEvent` 加 `approval-request`/`approval-resolved`；`ToolRuntimeCall.status` 加 `awaiting-approval`；consume 分支据 `eventId` 更新卡片、据事件弹/关审批弹窗；`submitApproval` 调 `postApprovalDecision` 乐观关闭。
- 审批弹窗复用 `approval-*` 类名（`styles.css` 补 `approval-risk`/`approval-details`/`tool-call-status.awaiting-approval`）。
- 流 `error`/结束时清理悬挂弹窗。

## 7. 复用的现有实现

- `LocalToolBroker`（`local-tool-broker.ts`）的 pending 模式作为协调器蓝本（不复用，语义不同）。
- `chat.ts` 的 `writeSseEvent` 与无差别 `onToolEvent`（审批事件自动下发）。
- `device.socket.send` + `DeviceRegistry`（仅新增 `getDevicesForUser`）+ `handleClientMessage` switch。
- 两端现有审批/删除/重命名弹窗视觉（`approval-*` 类名）。
- api-client 闭包函数 + return 导出模式，mobile 薄封装 + `authHeaders`/`resolveServerUrl`。

## 8. 验证

1. 类型检查：`pnpm -r --sort run typecheck`（shared 先 build）。
2. 起服务端 `HOST=0.0.0.0 AUTH_DEV_MOCK=true`；桌面与手机 Dev Login 登录**同一用户**；桌面挂一个工作区。
3. 手机选中该桌面设备 + 工作区 → 发"写文件"消息 → **手机与桌面同时弹审批**。
4. 任一端批准 → 桌面执行、结果回传手机、另一端弹窗自动关闭；再测桌面端批准。
5. 边界：拒绝（工具 failed）、超时（120s 自动 rejected）、桌面离线（审批可过但执行 `DEVICE_OFFLINE`）、两端同时点（只执行一次）、发起方断线（审批取消）、只读工具（无弹窗直接执行）。

## 9. 风险与边界

- **15s 执行超时冲突**：审批走独立的 120s 协调器超时，绝不复用 broker 的 15s；执行阶段仍 15s。
- **SSE 单向**：手机无法在 SSE 连接回传，必须用 POST；审批靠 `approvalId`（协调器 map）跨连接关联。
- **abortSignal 覆盖**：必须从 AI SDK tool `execute` 第二参透传到审批等待，否则手机断线后 Promise 悬挂到超时。
- **多桌面**：审批广播给该用户所有在线桌面，任一台可批；执行仍定向到 `localTools.deviceId` 指定那台；`approval.resolved` 广播关闭其他桌面弹窗。
- **审批不绑定执行方掉线**：审批可能来自手机，桌面 WS close 不取消审批；仅发起方 SSE 断开才 `failRun`（与 broker `failDevice` 语义相反，勿照搬）。
- **越权**：POST 与 WS `approval.decision` 都校验 `userId === pending.userId`。
- **前端状态机**：`running → awaiting-approval → running/failed → succeeded/failed`，两端 `ToolRuntimeCall.status` 均需 `awaiting-approval`。

## 10. 明确不做（本期）

- 不做手机直连屏幕镜像 / 直接下发操作到桌面 UI。
- 不引入独立审批持久化（协调器为进程内内存态，随 run 生命周期回收）。
- 不改动只读工具的执行路径。
