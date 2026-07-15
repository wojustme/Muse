# 跨端消息实时同步实施方案（服务端推送）

本文档依据当前代码整理，描述把"跨端消息同步"从 2s 轮询升级为**服务端主动推送**的实时方案与落地范围。

## 1. 背景与结论

当前状态（已实现）：桌面与手机在同一 session 下，空闲时每 2s 轮询 `GET /api/sessions/:id/messages`，用 `mergeServerMessages` 合并对方端发送的内容（`apps/desktop/src/App.tsx`、`apps/mobile/src/App.tsx`）。功能正确，但**有最长 2s 延迟**，且每个在线客户端持续轮询有额外请求开销。

需求：**真正实时的双端同步**——一端发送/AI 回复完成后，另一端立即（亚秒级）看到，无需等待轮询周期。

关键结论：服务端已具备两种"服务端 → 客户端"推送基础设施，本方案复用其一即可，无需引入新依赖。

- **SSE**：`apps/server/src/routes/chat.ts` 已用 `reply.hijack()` + `writeSseEvent` 向发起方推流；两端已实现 `consumeChatStream` 消费 `data: <json>` 事件。
- **WebSocket**：`apps/server/src/local-tools/local-tool-socket.ts` 已有带 token 鉴权的 WS（`/api/local-tools/ws`），但仅面向桌面本地工具设备。

决策：**新增一条按用户的 SSE "会话事件"长连接 `GET /api/events`**，作为通用的服务端推送通道。理由：

- 两端（含 iOS WKWebView）已验证能稳定消费 SSE `ReadableStream`；WS 在手机端尚无客户端实现，SSE 复用面更大。
- chat 落库点已存在，只需在写库后向该用户的所有事件流广播即可。
- 客户端合并逻辑（`mergeServerMessages`/`sameMessages`）已就绪，直接复用。

## 2. 架构与事件流

```txt
Node.js Server
  - GET /api/events (SSE, requireAuth)  ← 新增：按 userId 注册长连接
  - SessionEventHub (新增)：userId -> Set<clientStream>
  - chat.ts 落库后 hub.publish(userId, event, { exceptClientId })

客户端（桌面 / 手机，同一账号可多端）
  - 登录后建立 EventSource-like SSE 长连接（自带 clientId）
  - 收到 message.created / session.updated → 合并进本地会话（复用 mergeServerMessages）
  - 断线自动重连（指数退避）
```

事件类型（服务端 → 客户端）：

- `message.created`：`{ sessionId, message: {id, role, text, createdAt}, originClientId }`——新用户消息或 AI 定稿消息落库时推送。
- `session.updated`：`{ session: {id,title,updatedAt,lastMessagePreview,...}, originClientId }`——会话元信息变化（标题、预览、messageCount）。
- `hello`/心跳：连接建立即发 `hello`；每 ~25s 发注释行心跳保活，避免中间层断连。

去重：事件带 `originClientId`；发起端自己不重复应用（本地已乐观更新/流式渲染），仅其他端应用。服务端 `publish(userId, event, { exceptClientId })` 直接跳过发起端连接即可，客户端侧再兜底比对。

### 2.1 优化：仅当两端都在同一 session 页面时才实时同步

只有当"另一端也正打开同一个 session"时，推送该会话的 `message.created` 才有意义；否则对方看不到、纯属浪费。为此事件通道支持客户端上行"当前 session"信号：

- SSE 单向，客户端上行走新增的 `POST /api/events/active`（body `{ clientId, sessionId }`；`sessionId` 为 null 表示当前不在任何会话页）。
- 服务端 hub 为每条连接记录 `activeSessionId`；连接注册时初始为 null。
- `message.created` 只推给 `activeSessionId === event.sessionId` 的其他端；`session.updated`（列表元信息）仍广播给该用户所有连接（历史列表随时可能可见）。
- 客户端在 `switchSession` / 打开会话 / 关闭到列表时上报当前 sessionId。


## 3. 服务端

### 3.1 SessionEventHub（新增）

文件：`apps/server/src/events/session-event-hub.ts`。

- 内部 `streamsByUser = Map<string, Map<clientId, ServerResponse>>`。
- `register(userId, clientId, raw)`：登记连接；返回注销函数。
- `publish(userId, event, opts?: { exceptClientId })`：向该用户所有连接 `write("data: <json>\n\n")`，可跳过发起端。
- `heartbeat`：定时向所有连接写 `: ping\n\n`。
- 连接关闭（`raw.on("close")`）时自动注销，防泄漏。

### 3.2 事件路由（新增）

文件：`apps/server/src/routes/events.ts`，在 `server.ts` 注册（`prefix: "/api"`）。

- `GET /api/events`：`preHandler: requireAuth`；`clientId` 由 query 传入（客户端生成的稳定 id）。
- 复用 chat.ts 的 SSE 接管手法：`reply.hijack()`、手动补 CORS（`origin` 回显 + credentials）、`content-type: text/event-stream`、`flushHeaders`、立即发 `hello`。
- `hub.register(userId, clientId, raw)`，`request.raw.on("close")` 注销。

### 3.3 chat.ts 落库后广播

文件：`apps/server/src/routes/chat.ts`。

- 从请求体读取可选 `clientId`（发起端标识，chatRequestSchema 增加 `clientId?: string`）。
- **用户消息落库后**（首个 `db.transaction` 内 insert `chatMessages` 成功后）：`hub.publish(userId, { type:"message.created", sessionId, message, originClientId: clientId }, { exceptClientId: clientId })`。
- **AI 定稿落库后**（assistant message insert 成功后）：同样 `publish` assistant 消息 + `session.updated`。
- 失败分支（error）：`publish session.updated`（预览/时间变化），保证列表一致。

注意：发起端本身通过 SSE `/api/chat` 流已实时看到自己的内容，故 `exceptClientId` 跳过它，避免重复。

## 4. 客户端（桌面 + 手机对称）

### 4.1 稳定 clientId

- 各端在 localStorage 存一个 `muse.clientId`（`crypto.randomUUID()` 首次生成），用于事件流标识与 `exceptClientId` 去重。桌面已有 `muse.localTools.deviceId` 可复用思路。

### 4.2 事件流订阅 hook（新增）

- 新增 `useSessionEvents`（桌面/手机各一份或抽到 api-client）：
  - 用 `fetch(serverUrl + "/api/events?clientId=...", { headers: authHeaders() })` + `ReadableStream` 读取（复用 `consumeChatStream` 的解析范式；不用原生 `EventSource`，因为它不支持自定义 Authorization 头）。
  - 收到 `message.created`/`session.updated` 回调上层。
  - 断线自动重连（1s→2s→5s→10s 退避），登出时关闭。

### 4.3 应用事件到会话状态

- `message.created`：若该 `sessionId` 在本地存在，用 `mergeServerMessages` 合并该单条消息；否则忽略（列表刷新时会补）。若消息属于当前会话，触发滚动到底部。
- `session.updated`：更新会话标题/预览/时间（复用现有 `syncPersistedSession` 或 `mergeRefreshedSessions` 思路）。

### 4.4 移除/降级轮询

- 事件流连接成功后**停止 2s 轮询**；作为兜底，事件流断开期间恢复轮询（或保留一个 15~30s 的低频兜底轮询防丢事件）。

## 5. 复用的现有实现

- `chat.ts` 的 SSE 接管范式（`reply.hijack` + CORS 回显 + `writeSseEvent`）→ events 路由照搬。
- `requireAuth`（`auth/guard.ts`）→ events 路由鉴权。
- `local-tool-socket.ts` 的 upgrade-token 鉴权思路（若后续改 WS）。
- 客户端 `consumeChatStream`（两端各有）→ 事件流解析复用。
- `mergeServerMessages`/`sameMessages`（两端已新增）→ 合并单条/整组消息。
- `resolveServerUrl`/`authHeaders`（手机）与 `serverUrl`/`authHeaders`（桌面）。

## 6. 验证

1. 类型检查：`pnpm -r --sort run typecheck`。
2. 起服务端（`HOST=0.0.0.0 AUTH_DEV_MOCK=true`），桌面与手机 Dev Login 同一用户，进入同一 session。
3. 手机发消息 → **桌面亚秒级出现**（不再等 2s）；反向同样。
4. AI 回复：一端触发，另一端在定稿后立即看到完整内容。
5. 断网/切后台再恢复：事件流自动重连，期间产生的消息通过兜底轮询/重连补齐。
6. 多端去重：发起端不因广播而出现重复消息。

## 7. 风险与边界

- **iOS WKWebView 长连接**：SSE `ReadableStream` 在新版 iOS 可用；App 切后台可能被挂起，需重连补偿（保留低频兜底轮询）。
- **hijack 与 CORS**：与 chat.ts 一致，必须手动回显 `origin` 且 `credentials`，否则 WebView `Load failed`。
- **连接泄漏**：`raw.on("close")` 必须注销 hub 连接与心跳。
- **多连接**：同一 clientId 多次连接需覆盖旧连接，避免重复推送。
- **事件丢失**：纯推送在断连窗口会丢事件，故保留低频兜底轮询或在重连时全量拉取当前会话消息。
- **顺序一致性**：事件按 `createdAt` 合并；`mergeServerMessages` 已保证服务端为权威内容、保留本地在流消息。

## 8. 明确不做（本期）

- 不引入 Redis/消息队列做多实例广播（当前单进程内存 hub 足够；多实例部署再演进到 pub/sub）。
- 不改为 WebSocket 双向（SSE + 既有 POST 已满足；除非后续需要客户端上行高频事件）。
- 不做离线消息补偿的持久化游标（靠重连全量拉取兜底）。
