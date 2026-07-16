# Muse

Muse 是一个桌面优先、支持多端协同的 AI Chat / Agent 应用。它将模型对话、会话持久化、联网搜索、桌面工作区工具、人工审批和跨端实时同步整合到同一套产品中：

- 在 macOS Desktop 上，AI 可以在用户选择的工作区内读取、搜索、写入文件和执行命令。
- 在 Mobile 上，用户可以发起对话、查看流式回复，并远程借用在线 Desktop 的工作区能力。
- 在 Desktop 或 Mobile 上，用户都可以审批高风险的写文件、应用 Patch 和 Shell 操作。
- 在多个客户端同时登录时，同一会话的用户消息和 AI 流式回复可以实时同步。

项目采用 `pnpm` monorepo，包含 Fastify Server、React Web、Tauri Desktop、Tauri Mobile 和多个共享 TypeScript 包。本文只描述当前代码中已经存在的能力；仅有设计文档或类型预留、尚未接入产品主流程的能力会明确标注。

## 产品定位

Muse 当前面向个人或可信团队环境，目标是提供一套“对话入口统一、能力在合适设备执行”的 AI 工作台：

1. Server 统一负责身份认证、模型授权、会话数据、Agent 编排和工具路由。
2. Desktop 提供普通 Web 无法直接访问的本机文件与命令能力。
3. Mobile 不直接操作手机文件系统，而是远程选择 Desktop 设备和工作区。
4. 所有高风险本地操作进入人工审批流程，执行过程通过工具卡片实时展示。
5. 多端共享同一账号、会话和消息历史。

## 当前能力

| 领域          | 已实现能力                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| 客户端        | Web、macOS Desktop、Tauri Mobile（iOS 已配置，Android 保留初始化与构建入口） |
| 登录          | 飞书 OAuth、开发环境 Mock 登录、Bearer session、登出吊销                     |
| 用户数据      | 用户、第三方身份、登录态持久化到 MariaDB                                     |
| 模型          | 数据库模型目录、用户模型授权、DeepSeek 真实流式调用                          |
| Chat          | SSE 流式响应、Markdown/GFM、中文逐字/英文逐词输出、消息历史                  |
| 会话          | 本地草稿、首消息懒创建、列表、刷新、重命名、软删除                           |
| Agent         | 时间、会话查询、历史消息搜索、可用模型查询                                   |
| Web Search    | Tavily 搜索，服务端配置与单次客户端开关双重控制                              |
| Desktop Tools | `LS`、`Read`、`Grep`、`Write`、`Edit`、`Bash`                                |
| 审批          | Desktop 与 Mobile 均可审批，first-wins、超时与断连自动拒绝                   |
| 跨端协同      | 用户消息同步、AI 回复流式同步、会话摘要同步                                  |
| Mobile Remote | 选择在线 Desktop 设备和工作区，远程借用本机工具                              |

当前明确未完成或未接入主路径的能力：

- Chat 主调用链只支持 DeepSeek；OpenAI、GLM 只有 Provider 抽象。
- 飞书已经实现；钉钉、微信、支付宝只有 schema 或注释预留。
- 数据模型支持一个用户绑定多个第三方身份，但客户端绑定流程尚未闭环。
- Android 有 Tauri 脚本和配置入口，但当前主要验证方向是 iOS。
- Web 端尚未完整对齐 Desktop/Mobile 的跨端事件、联网开关和审批体验。

## 技术栈

- Monorepo: `pnpm` workspace
- Desktop: Tauri v2, Rust, React 19, TypeScript, Vite
- Mobile: Tauri v2 Mobile, Rust, React 19, TypeScript, Vite
- Web: React 19, TypeScript, Vite
- Server: Node.js 24+, Fastify 5, Zod, Drizzle ORM, MariaDB, WebSocket
- AI: Vercel AI SDK 5, OpenAI-compatible provider, DeepSeek, Tavily
- UI: lucide-react, react-markdown, remark-gfm
- Shared packages: `@muse/shared`, `@muse/api-client`, `@muse/model-router`

## 目录结构

```txt
apps/
  server/          Fastify API 服务：认证、模型、会话、聊天、local tools WebSocket
  desktop/         Tauri 桌面端：React Chat UI + macOS 本机工具桥
  web/             浏览器 Web 端：React Chat UI + OAuth 登录
  mobile/          Tauri Mobile：移动聊天 UI + 远程 Desktop 工具选择与审批

packages/
  shared/          跨端 Zod schemas、类型和常量
  api-client/      跨端 API client：token、登录、事件 URL、审批等
  model-router/    模型 provider 抽象与 OpenAI-compatible provider 工厂

docs/              架构、认证、数据库、跨端交互、风险审查与实施方案
scripts/           开发辅助脚本，例如桌面 debug bundle 启动器
```

## 架构概览

Muse 的运行时可以按四层理解：

1. 客户端层

   `apps/desktop`、`apps/web` 和 `apps/mobile` 负责登录态恢复、模型选择、会话列表、消息历史、Markdown 渲染和 Chat SSE 流消费。Desktop 额外初始化 `LocalToolBridge`；Mobile 额外查询在线 Desktop 并选择远程工作区。

2. API 层

   `apps/server/src/server.ts` 创建 Fastify 实例，注册 CORS、健康检查、认证、模型、会话、聊天和 local tools 路由，同时把 `/api/local-tools/ws` 挂到同一个 HTTP server 的 upgrade 流程里。

3. 业务与数据层

   `apps/server/src/db/schema.ts` 是当前数据库事实来源，包含用户、身份、登录态、系统配置、模型目录、模型授权、聊天会话、消息、模型调用和工具调用记录。服务端通过 `mysql2/promise` pool + `drizzle-orm/mysql2` 访问 MariaDB。

4. Agent / Tool 层

   Chat 路由在每次模型调用前按请求上下文创建工具注册表。内置 Muse 工具使用 `muse_*` 前缀；联网搜索由数据库配置和客户端开关共同启用；Desktop 连接且请求指定设备/工作区后，再注册 `Read`、`Grep`、`LS`、`Write`、`Edit`、`Bash`。

5. 实时协同层

   Desktop 和 Mobile 登录后通过 `GET /api/events` 建立用户级 SSE 长连接，并通过 `POST /api/events/active` 上报当前打开的 session。Server 只把会话内消息与流式增量推给正在查看同一 session 的其他客户端。

### 运行时拓扑

```mermaid
flowchart LR
  Web[Web Client] -->|HTTP + Chat SSE| Server[Fastify Server]
  Desktop[Desktop React] -->|HTTP + SSE| Server
  Mobile[Mobile React] -->|HTTP + SSE| Server
  Desktop <-->|Local Tools WebSocket| Server
  Server --> DB[(MariaDB)]
  Server --> Model[DeepSeek API]
  Server --> Search[Tavily API]
  Desktop --> Tauri[Tauri Rust Commands]
  Mobile -. 选择远程设备/工作区 .-> Desktop
```

## 核心交互流程

### 登录流程

```mermaid
sequenceDiagram
  participant Client as Web/Desktop/Mobile
  participant Server
  participant Feishu
  participant DB as MariaDB

  Client->>Server: POST /api/auth/feishu/challenge
  Server-->>Client: state + authUrl + expiresAt
  Client->>Feishu: 系统浏览器打开授权页
  Feishu->>Server: GET /api/auth/feishu/callback
  Server->>Feishu: 使用 code 换 token 并读取用户信息
  Server->>DB: 创建/更新用户与身份
  Server->>DB: 保存 session token hash
  Client->>Server: 轮询 challenge status
  Server-->>Client: 一次性返回明文 session token
```

客户端将 token 保存到本地存储，后续请求携带：

```http
Authorization: Bearer <session-token>
```

### 发送消息与模型流式回复

1. 客户端在本地创建 draft session，不立即写数据库。
2. 用户发送第一条消息时，客户端提交 `POST /api/chat`。
3. Server 校验 session 归属和模型授权。
4. 新会话与第一条用户消息在同一事务中落库。
5. Server 根据当前请求注册 Agent 工具。
6. Vercel AI SDK `streamText` 调用 DeepSeek。
7. Server 通过 SSE 下发 `start`、`delta`、工具事件、`done` 或 `error`。
8. 模型完成后写入 Assistant 消息、token 用量和工具调用记录。
9. Server 向同账号其他在线客户端推送消息和会话更新。

```mermaid
sequenceDiagram
  participant Client as 发起端 Client
  participant Chat as POST /api/chat
  participant DB as MariaDB
  participant Agent as AI SDK / DeepSeek
  participant Hub as SessionEventHub
  participant Peer as 同账号其他端

  Client->>Chat: sessionId + message + model + clientId
  Chat->>Chat: 校验登录、会话归属和模型授权
  Chat->>DB: 事务：懒创建 session + 用户消息 + pending model_run
  DB-->>Chat: 提交成功
  Chat->>Hub: message.created(user)
  Hub-->>Peer: 推送用户消息（跳过发起端）
  Chat-->>Client: SSE start
  Chat->>Hub: message.stream-start
  Hub-->>Peer: 创建 Assistant 流式占位
  Chat->>Agent: streamText(messages + tools)
  loop 模型文本增量
    Agent-->>Chat: text delta
    Chat-->>Client: SSE delta
    Chat->>Hub: message.stream-delta
    Hub-->>Peer: 同步文本增量
  end
  Agent-->>Chat: finalText + steps + usage
  Chat->>Hub: message.stream-end
  Hub-->>Peer: 结束流式展示
  Chat->>DB: 事务：Assistant 消息 + model_run + session 摘要
  DB-->>Chat: 提交成功
  Chat->>Hub: message.created(assistant) + session.updated
  Hub-->>Peer: 最终消息对齐 + 列表刷新
  Chat-->>Client: SSE done
```

> 当前代码中的 `message.stream-end` 早于最终数据库事务提交。这是已记录的可靠性风险，后续应调整为事务成功后再广播最终事件，详见 `docs/project-risk-review.md`。

### 工具动态注册

每次 Chat 请求不会注册完全相同的工具集合，而是根据 Server 配置和客户端上下文动态决定：

```mermaid
flowchart TD
  Request[Chat 请求] --> Builtin[注册 Muse 内置只读工具]
  Builtin --> SearchGate{DB 已启用 Web Search<br/>且本次 webSearch=true?}
  SearchGate -- 是 --> WebSearch[注册 WebSearch]
  SearchGate -- 否 --> BashGate
  WebSearch --> BashGate{MUSE_LOCAL_BASH_ENABLED?}
  BashGate -- 是 --> ServerBash[注册 ServerBash]
  BashGate -- 否 --> LocalGate
  ServerBash --> LocalGate{请求包含 deviceId + workspaceId?}
  LocalGate -- 否 --> Registry[生成本次 Tool Registry]
  LocalGate -- 是 --> DesktopTools[注册 Read/Grep/LS/Write/Edit/Bash]
  DesktopTools --> Registry
  Registry --> Agent[传入 streamText]
```

注册阶段只判断请求是否带有 Desktop 工具上下文。设备归属、在线状态、工作区挂载状态和工具 Manifest 会在模型真正调用工具后，由 `LocalToolBroker` 再次校验。

### Desktop 本地工具调用与审批

```mermaid
sequenceDiagram
  participant Model as DeepSeek
  participant Chat as Chat SSE
  participant Approval as ApprovalCoordinator
  participant Origin as Mobile/Desktop 发起端
  participant Desktop as Desktop WS
  participant Broker as LocalToolBroker
  participant Rust as Tauri Rust

  Model->>Chat: 调用 Read/Grep/LS/Write/Edit/Bash
  Chat-->>Origin: tool-start
  alt Write/Edit/Bash
    Chat->>Approval: 创建 approvalId + timeout
    Chat-->>Origin: Chat SSE approval-request
    Approval-->>Desktop: WS approval.request 广播到在线 Desktop
    alt Mobile 先决定
      Origin->>Approval: POST /api/chat/approval
    else Desktop 先决定
      Desktop->>Approval: WS approval.decision
    else 超时或 Chat 断连
      Approval->>Approval: 自动 rejected
    end
    Approval-->>Origin: approval-resolved
    Approval-->>Desktop: WS approval.resolved
  end
  Chat->>Broker: execute(deviceId, workspaceId, toolName)
  Broker->>Broker: 校验用户、设备、工作区和 Manifest
  Broker->>Desktop: WS tool.request
  Desktop->>Rust: invoke Tauri command
  Rust->>Rust: 校验工作区路径、敏感路径、命令与输出限制
  Rust-->>Desktop: 文件或命令结果
  Desktop-->>Broker: WS tool.result / tool.error
  Broker-->>Chat: 工具执行结果
  Chat-->>Origin: tool-result
  Chat-->>Model: 工具结果，继续下一步推理
```

### Mobile 远程借用 Desktop

1. Mobile 调用 `GET /api/local-tools/devices` 获取当前账号在线设备。
2. 用户选择一个 Desktop 及其已挂载工作区。
3. Mobile Chat 请求携带 `localTools.deviceId` 和 `workspaceId`。
4. Server 将模型工具调用定向转发给该 Desktop。
5. 写操作可由 Mobile 或任意在线 Desktop 审批。
6. 实际文件或命令操作始终在目标 Desktop 的 Tauri Rust 层执行。

```mermaid
flowchart LR
  Mobile[Mobile] -->|GET /api/local-tools/devices| Server[Fastify Server]
  Server -->|在线设备 + Workspaces| Mobile
  Mobile -->|选择 deviceId + workspaceId| Chat[POST /api/chat]
  Chat --> Agent[模型决定调用本地工具]
  Agent --> Broker[LocalToolBroker]
  Broker -->|WebSocket tool.request| Desktop[目标 Desktop]
  Desktop --> Rust[Tauri Rust]
  Rust --> Workspace[(macOS Workspace)]
  Workspace --> Rust
  Rust --> Desktop
  Desktop -->|tool.result| Broker
  Broker --> Agent
  Agent -->|Chat SSE| Mobile
```

### 跨端消息同步

- Chat 发起端通过当前 `POST /api/chat` SSE 看到流式结果。
- Server 使用 `clientId` 跳过发起端，避免重复消息。
- 其他正在查看同一 session 的客户端接收：
  - `message.created`
  - `message.stream-start`
  - `message.stream-delta`
  - `message.stream-end`
- `session.updated` 向该用户其他连接广播，用于刷新历史列表。
- 事件通道断开时，客户端使用定时拉取消息作为兜底。

```mermaid
sequenceDiagram
  participant A as Client A（发起端）
  participant Server
  participant Hub as SessionEventHub
  participant B as Client B（同一 session）
  participant C as Client C（其他页面）

  A->>Server: GET /api/events?clientId=A
  B->>Server: GET /api/events?clientId=B
  C->>Server: GET /api/events?clientId=C
  Server->>Hub: 注册 A/B/C 的用户级 SSE 连接
  Server-->>A: hello
  Server-->>B: hello
  Server-->>C: hello

  A->>Server: POST /api/events/active(session-1)
  B->>Server: POST /api/events/active(session-1)
  C->>Server: POST /api/events/active(null)
  Server->>Hub: 记录每个 clientId 的 activeSessionId

  A->>Server: POST /api/chat(clientId=A, session-1)
  Server-->>A: Chat SSE start/delta/done
  Server->>Hub: publish(..., exceptClientId=A)
  Hub-->>B: message.created / stream-start / stream-delta / stream-end
  Note over Hub,C: C 未打开 session-1，不接收会话内消息事件
  Hub-->>B: session.updated
  Hub-->>C: session.updated

  loop 每 25 秒
    Hub-->>A: SSE heartbeat
    Hub-->>B: SSE heartbeat
    Hub-->>C: SSE heartbeat
  end

  alt 事件 SSE 正常
    B->>B: 降低消息轮询频率
  else SSE 断开
    B->>Server: 定时 GET /api/sessions/:id/messages
    Server-->>B: 使用数据库历史最终对齐
  end
```

同步过滤规则：

```mermaid
flowchart TD
  Event[SessionEventHub.publish] --> SameUser{是否属于同一 userId?}
  SameUser -- 否 --> Drop1[不推送]
  SameUser -- 是 --> Origin{clientId 是否等于 exceptClientId?}
  Origin -- 是 --> Drop2[跳过发起端]
  Origin -- 否 --> Scoped{是否为会话内事件?}
  Scoped -- 否<br/>session.updated --> SendAll[推送给该用户其他在线端]
  Scoped -- 是 --> Active{activeSessionId == event.sessionId?}
  Active -- 否 --> Drop3[不推送]
  Active -- 是 --> Send[通过用户级 SSE 推送]
```

## 本地开发

环境要求：

- Node.js `>=24.0.0`
- pnpm `>=11.0.0`
- MariaDB
- Rust 和 Tauri v2 本地开发环境
- iOS 开发需要 Xcode、有效签名团队和 Tauri iOS 工具链
- Android 开发需要 Android Studio、SDK/NDK 和 Tauri Android 工具链

安装依赖：

```bash
pnpm install
```

准备服务端配置：

```bash
cp apps/server/.env.example apps/server/.env
```

### 固定端口

| 服务         | 地址                    |
| ------------ | ----------------------- |
| Server       | `http://127.0.0.1:8787` |
| Desktop Vite | `http://127.0.0.1:1420` |
| Web Vite     | `http://127.0.0.1:1430` |
| Mobile Vite  | `http://0.0.0.0:1440`   |

Vite 均启用 `strictPort`，端口占用时不会自动换端口。

### 启动 Server

启动服务端：

```bash
pnpm dev:server
```

同时启动 Server 和 Desktop：

```bash
pnpm dev
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health
```

预期返回形态：

```json
{ "ok": true, "service": "muse-server", "timestamp": "..." }
```

### 启动 macOS Desktop

推荐：

```bash
pnpm dev:desktop
```

该脚本会：

1. 检查 Server 健康状态，必要时后台启动 Server。
2. 清理旧的 Desktop debug/release 进程。
3. 执行 Desktop typecheck 和 build。
4. 执行 `tauri build --debug`。
5. 通过明确路径打开 debug `Muse.app`。
6. 将窗口移动到可见区域并置前。

只启动 Desktop Vite：

```bash
pnpm dev:desktop:web
```

使用 Tauri 热加载：

```bash
pnpm dev:desktop:tauri
```

### 启动 Web

```bash
pnpm dev:web
```

浏览器访问：

```text
http://127.0.0.1:1430
```

### 启动 Mobile Web 调试

```bash
pnpm dev:mobile:web
```

### iOS

首次初始化：

```bash
pnpm ios:init
```

开发运行：

```bash
pnpm dev:mobile:ios
```

构建：

```bash
pnpm ios:build
```

真机无法通过 `127.0.0.1` 访问 Mac 上的 Server。需要：

1. 将 Server `HOST` 设置为 `0.0.0.0`。
2. 将 `PUBLIC_BASE_URL` 设置为手机可访问的局域网地址。
3. 在 Mobile 登录页填写如 `http://192.168.x.x:8787` 的 Server 地址，或构建时设置 `VITE_SERVER_URL`。
4. 确保手机与 Mac 位于同一网络，防火墙允许访问 8787。

当前 Mobile OAuth 不使用 deep link 自动回跳；授权完成后依靠 challenge 轮询，用户需要切回 Muse。

### Android

首次初始化：

```bash
pnpm android:init
```

开发运行：

```bash
pnpm dev:mobile:android
```

构建：

```bash
pnpm android:build
```

Android 复用 Mobile React 代码，但当前项目主要验证方向是 iOS，正式发布前仍需完成 Android 真机、权限、网络安全和商店打包验证。

### 全仓检查

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
```

Tauri Rust 检查：

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml
```

## 配置

服务端读取 `apps/server/.env`，字段定义在 `apps/server/src/config/env.ts`。

```env
HOST=127.0.0.1
PORT=8787
DATABASE_URL=mysql://muse:muse@127.0.0.1:3306/muse_db

PUBLIC_BASE_URL=http://127.0.0.1:8787
FRONTEND_BASE_URL=http://127.0.0.1:1420

SESSION_TOKEN_TTL_HOURS=720
LOGIN_CHALLENGE_TTL_SECONDS=300

AUTH_DEV_MOCK=false
AUTH_DEV_MOCK_NAME=Muse Dev User

MUSE_LOCAL_BASH_ENABLED=false
MUSE_LOCAL_BASH_ALLOWED_ROOTS=/Users/bytedance/codes/my/Muse,/Users/bytedance/Downloads,/private/tmp
MUSE_LOCAL_BASH_TIMEOUT_MS=8000
MUSE_LOCAL_BASH_MAX_OUTPUT_CHARS=12000

# 本地工具人工审批超时，默认 120 秒
MUSE_APPROVAL_TIMEOUT_MS=120000
```

模型相关环境变量仍保留在配置里：

```env
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
GLM_API_KEY=
```

但当前 Chat 实际按数据库里的 `ai_models.api_key` 和 `ai_models.base_url` 找模型配置，并通过 `user_ai_models` 判断当前用户是否有权使用该模型。

前端默认请求 `http://127.0.0.1:8787`，可通过 Vite 环境变量覆盖：

```env
VITE_SERVER_URL=http://127.0.0.1:8787
```

Mobile 还会把用户在登录页填写的 Server 地址保存到：

```text
localStorage["muse.serverUrl"]
```

该值优先于 `VITE_SERVER_URL`。

### 数据库系统配置

飞书配置，`system_configs.config_key = auth.feishu`：

```json
{
  "app_id": "cli_xxx",
  "app_secret": "xxx"
}
```

联网搜索配置，`system_configs.config_key = web_search`：

```json
{
  "enabled": true,
  "provider": "tavily",
  "api_key": "tvly-xxx",
  "timeout_ms": 10000
}
```

这些配置在 Server 启动时加载。当前没有运行期配置刷新 API，修改数据库后需要重启 Server。

### 模型配置与授权

模型调用配置存储于 `ai_models`：

- `provider`
- `model_name`
- `display_name`
- `api_key`
- `base_url`
- `enabled`

用户必须在 `user_ai_models` 中拥有对应授权。当前 Chat 主路径要求 `provider = deepseek`。

> 当前仓库没有正式 migration 和 seed。新环境需要根据 `apps/server/src/db/schema.ts` 准备表结构和基础数据；这是项目尚待补齐的工程闭环。

## 登录认证

认证相关代码位于：

- `apps/server/src/routes/auth.ts`
- `apps/server/src/auth/provider.ts`
- `apps/server/src/auth/providers/feishu.ts`
- `apps/server/src/auth/session.ts`
- `apps/server/src/auth/identity.ts`

核心流程：

1. 客户端调用 `POST /api/auth/feishu/challenge` 创建短 TTL 登录 challenge。
2. 服务端根据 `PUBLIC_BASE_URL` 拼出 callback URL，并返回飞书授权地址。
3. 飞书回调 `GET /api/auth/feishu/callback` 后，服务端换 token、拉用户信息、解析身份归属。
4. 服务端创建或复用内部用户，绑定 `user_identities`。
5. 服务端签发不透明 session token，数据库只保存 token hash。
6. 客户端轮询 `GET /api/auth/challenge/status?state=...`，拿到 token 后存入本地存储。
7. 后续请求使用 `Authorization: Bearer <token>`。

飞书凭证从 MariaDB `system_configs` 表加载，key 固定为 `auth.feishu`，value 是 JSON 字符串：

```json
{
  "app_id": "cli_xxx",
  "app_secret": "xxx"
}
```

飞书开放平台的重定向 URL 需要配置为：

```txt
{PUBLIC_BASE_URL}/api/auth/feishu/callback
```

本地开发免 OAuth 登录：

```env
AUTH_DEV_MOCK=true
AUTH_DEV_MOCK_NAME=Muse Dev User
```

开启后客户端可调用 `POST /api/auth/dev`。这个接口会创建或复用一个 `feishu/local/dev-local` 身份，并签发真实 session，因此后续 `/api/auth/me`、`/api/models`、`/api/chat` 仍走正常鉴权链路。

`AUTH_DEV_MOCK` 只能用于可信本地开发环境。当前代码还没有通过 `APP_ENV` 强制限制，部署时必须确保其为 `false`。详细风险见 `docs/project-risk-review.md`。

## 聊天链路

`POST /api/chat` 是当前核心业务接口，要求已登录。请求包含：

- `sessionId`：客户端生成或已有会话 ID。
- `message`：用户消息，目前支持 text parts。
- `model`：可选模型选择，形如 `{ provider, name }`。
- `localTools`：可选桌面工具上下文，包含 `deviceId` 和 `workspaceId`。
- `clientId`：发起端稳定标识，用于跨端事件去重。
- `webSearch`：本次请求是否允许联网搜索。
- `client`：客户端 OS、CPU、语言、时区、窗口和 Local Tool Host 上下文。

服务端行为：

- 如果 `sessionId` 不存在，则在首条用户消息事务里懒创建 `chat_sessions`。
- 如果会话存在但状态不是 `active`，返回 404。
- 根据请求模型或会话模型查 `ai_models` + `user_ai_models`，确保当前用户有授权。
- 当前只支持 `provider = deepseek` 的真实模型流式调用。
- 先落用户消息和 `model_runs(pending)`。
- 通过 SSE 返回 `start` 事件，随后持续返回 `delta`。
- 模型完成后落 assistant 消息、模型用量、工具调用记录，并更新会话摘要。
- 失败时把 `model_runs` 标记为 `failed`，并通过 SSE 返回 `error`。

Chat SSE 事件类型：

- `start`：返回 assistant message id、session id、模型和会话摘要。
- `delta`：返回一段文本增量。
- `tool-start`：工具开始执行。
- `tool-result`：工具执行成功或失败。
- `approval-request`：本次工具调用等待审批。
- `approval-resolved`：审批已由某个客户端完成。
- `done`：返回最终 assistant parts、工具调用摘要和最新会话摘要。
- `error`：返回模型调用错误。

前端的 `consumeChatStream` 会按 `data: <json>` 解析 SSE，并更新当前 assistant 气泡，实现中文逐字、英文逐词的打字机效果。

## 会话与消息

会话接口位于 `apps/server/src/routes/sessions.ts`。

- `GET /api/sessions`：返回当前用户 active 会话，按 pinned 和更新时间排序。
- `POST /api/sessions`：显式创建空会话，使用指定模型或默认授权模型。
- `GET /api/sessions/:id`：读取单个会话摘要。
- `GET /api/sessions/:id/messages`：读取会话消息历史。
- `PATCH /api/sessions/:id`：重命名会话。
- `DELETE /api/sessions/:id`：软删除会话，底层消息保留。

前端默认采用“本地草稿 + 首消息懒创建”的体验：点击 New Chat 只在前端生成 draft session，不马上写数据库；用户发送第一条消息时，Chat API 再把会话和消息原子落库。这样历史列表不会出现没有任何消息的空会话。

## 模型与授权

模型接口位于 `apps/server/src/routes/models.ts`，当前只暴露：

- `GET /api/models`：返回当前用户被授权的 enabled 模型。

数据库里有两类模型表：

- `ai_models`：模型目录与调用配置，包括 provider、model name、display name、api key、base url、enabled。
- `user_ai_models`：用户到模型的授权关系，行存在即表示可用。

Chat 路由会再次校验授权，不信任前端传入的模型选择。当前真实调用路径只实现 DeepSeek：

```ts
createDeepSeekProvider({
  apiKey,
  baseURL: model.baseUrl ?? "https://api.deepseek.com",
});
```

`packages/model-router` 已提供 OpenAI-compatible provider 抽象和 `ModelRouter`，但当前 Chat 路由是按 DeepSeek 显式分支接入，后续可以继续收敛到通用 router。

## Agent 工具

### Muse 内置工具

| 工具                    | 用途                 |
| ----------------------- | -------------------- |
| `muse_time_now`         | 获取当前时间         |
| `muse_session_current`  | 获取当前会话信息     |
| `muse_session_messages` | 获取当前会话最近消息 |
| `muse_search_messages`  | 搜索当前用户历史消息 |
| `muse_models_available` | 查询当前用户可用模型 |

### 联网搜索

`WebSearch` 使用 Tavily。只有同时满足以下条件时才注册：

1. `system_configs.web_search.enabled = true` 且配置了 API Key。
2. 客户端在本次请求中设置 `webSearch = true`。

新建会话时 Desktop 和 Mobile 默认关闭联网搜索，防止无意产生外部请求和费用。

## Local Tools

Muse 的工具体系分为三类：

1. 内置只读工具

   包括 `muse_time_now`、`muse_session_current`、`muse_session_messages`、`muse_search_messages`、`muse_models_available`。

2. 服务端本机 bash

   工具名是 `ServerBash`，默认关闭。只有设置 `MUSE_LOCAL_BASH_ENABLED=true` 后才注册。它会把 cwd 限制在 `MUSE_LOCAL_BASH_ALLOWED_ROOTS` 下，并限制超时和输出长度。

3. 桌面 macOS 工具

   Desktop 登录后创建 `LocalToolBridge`，通过 `/api/local-tools/ws?token=...` 注册设备、工具清单和当前工作区。用户可以选择 Home、Downloads、Desktop、Documents、自定义目录或空工作区，选择结果保存在 `localStorage`。

   Server 收到模型工具调用后，通过 `LocalToolBroker` 转发到请求指定的 Desktop 和工作区，再由 Tauri command 执行。

桌面 macOS 工具包括：

- `LS`：列出 workspace 内目录。
- `Read`：读取 workspace 内文本文件。
- `Grep`：搜索 workspace 内文本文件。
- `Write`：创建或覆盖文本文件，需要用户确认。
- `Edit`：对文本文件应用 unified diff，需要用户确认。
- `Bash`：在 workspace 内执行 bash 命令，需要用户确认。

Tauri 侧安全边界：

- 所有文件路径必须在已绑定 workspace 内。
- 拒绝 `.env`、`.env.*`、`.ssh`、`Keychains` 等敏感路径。
- 拒绝包含 `sudo`、`rm -rf`、`git reset --hard`、`git clean -fd`、`chmod`、`chown`、`curl | sh`、`wget | sh` 等危险命令模式。
- 读取、搜索、写入、patch、命令输出都有大小或数量限制。
- 写入、patch、命令执行会在桌面 UI 上展示详情并等待用户批准。

### 跨端审批

- Server 为每次待审批调用生成 `approvalId`。
- 发起 Chat 的客户端通过 Chat SSE 收到审批事件。
- 该用户所有在线 Desktop 通过 Local Tools WebSocket 收到审批请求。
- Mobile 通过 `POST /api/chat/approval` 回传决定。
- Desktop 通过 WebSocket `approval.decision` 回传决定。
- 任一端先完成审批即生效，后续决定返回未结算。
- 超时、Chat 连接断开或模型 run 结束都会自动拒绝未完成审批。

### ServerBash

`ServerBash` 通过 `MUSE_LOCAL_BASH_ENABLED=true` 显式开启，在 Server 主机执行 Shell。它与 Desktop `Bash` 不是同一执行环境。

当前实现存在审批语义和隔离风险，未经整改不应在生产环境开启。参见 `docs/project-risk-review.md`。

## 数据库

当前 Drizzle schema 位于 `apps/server/src/db/schema.ts`，表包括：

- `users`：Muse 内部用户。
- `user_identities`：第三方登录身份，一个用户可以绑定多个 provider 身份。
- `auth_sessions`：登录态，只保存 token hash、状态和过期时间。
- `system_configs`：系统级 JSON 配置，例如 `auth.feishu`。
- `ai_models`：模型目录和调用配置。
- `user_ai_models`：用户可用模型授权关系。
- `chat_sessions`：会话摘要、标题、模型、消息数、最后消息预览。
- `chat_messages`：会话内消息历史，保存纯文本 content 和结构化 parts。
- `model_runs`：一次模型调用记录，包含状态、模型、消息 ID 和 token 用量。
- `tool_calls`：模型触发的工具调用和执行结果。

当前仓库没有可执行的 Drizzle migration 脚本；历史设计文档在 `docs/database-design.md` 和 `docs/mariadb-migration-plan.md`，但实际表结构应以 `apps/server/src/db/schema.ts` 为准。

主要关系：

```text
users
  ├── user_identities
  ├── auth_sessions
  ├── user_ai_models ── ai_models
  └── chat_sessions
        ├── chat_messages
        ├── model_runs
        └── tool_calls
```

## API 概览

认证：

- `POST /api/auth/dev`
- `POST /api/auth/:provider/challenge`
- `GET /api/auth/:provider/callback`
- `GET /api/auth/challenge/status?state=...`
- `GET /api/auth/me`
- `POST /api/auth/logout`

模型：

- `GET /api/models`

聊天与会话：

- `POST /api/chat`
- `POST /api/chat/approval`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `PATCH /api/sessions/:id`
- `DELETE /api/sessions/:id`

Local tools：

- `GET /api/local-tools/devices`
- `WS /api/local-tools/ws?token=...`

跨端事件：

- `GET /api/events?clientId=...`
- `POST /api/events/active`

运维：

- `GET /health`

## 常用脚本

```bash
pnpm dev                  # 并行启动 server 和 desktop
pnpm dev:server           # 启动 Fastify 开发服务
pnpm dev:desktop          # 构建并打开 macOS debug bundle
pnpm dev:desktop:web      # 只启动 desktop 的 Vite 前端
pnpm dev:desktop:tauri    # 使用 tauri dev 热加载
pnpm dev:web              # 启动浏览器 Web 端
pnpm dev:mobile:web       # 启动 Mobile Web 调试
pnpm dev:mobile:ios       # 启动 Tauri iOS
pnpm dev:mobile:android   # 启动 Tauri Android
pnpm ios:init             # 初始化 iOS 工程
pnpm ios:build            # 构建 iOS
pnpm android:init         # 初始化 Android 工程
pnpm android:build        # 构建 Android
pnpm build                # 按 workspace 顺序构建
pnpm typecheck            # 全仓类型检查
pnpm lint                 # 全仓 lint
pnpm format               # Prettier 格式化
pnpm format:check         # 检查格式
```

子包脚本可以直接用 filter 调：

```bash
pnpm --filter @muse/server run dev
pnpm --filter @muse/desktop run typecheck
pnpm --filter @muse/web run build
```

## 当前限制

- Chat 路由当前只对 DeepSeek provider 做了真实流式调用分支，OpenAI/GLM provider 抽象还没有接入主调用路径。
- 数据库 schema 已在代码中定义，但仓库目前没有正式 migration 脚本，需要用当前 Drizzle schema 或额外 SQL 初始化表。
- 飞书 OAuth provider 已实现，钉钉、微信、支付宝只在注册顺序注释里预留。
- 第三方身份绑定在服务端有部分基础能力，但客户端流程尚未闭环。
- Desktop、Web、Mobile 仍分别维护大体量 `App.tsx`，部分功能已发生漂移。
- Web 端尚未完整接入 Desktop/Mobile 的实时事件、联网搜索与审批体验。
- OAuth challenge、跨端事件中心、在线设备、Broker 和审批协调器均为单进程内存状态，当前只适合单 Server 实例。
- Mobile 开发阶段允许局域网 HTTP；生产环境需要 HTTPS/WSS 和安全 token 存储。
- `ServerBash` 和 `Bash` 都属于高风险能力，虽然已有路径、命令和审批限制，但仍只适合可信本机开发环境。
- Tauri 生产包如何携带、启动或发现 Node.js API 服务仍需要进一步产品化设计。
- 当前仓库没有自动化测试。

完整风险、影响和整改建议见：

- `docs/project-risk-review.md`

## 相关文档

- `docs/project-risk-review.md`：当前项目风险审查和整改优先级。
- `docs/local-tools-call-chain.md`：Local Tools 注册、调用、执行与安全边界。
- `docs/realtime-session-sync-implementation-plan.md`：跨端消息实时同步设计。
- `docs/cross-device-approval-implementation-plan.md`：Desktop/Mobile 双端审批设计。
- `docs/mobile-ios-implementation-plan.md`：Mobile iOS 实现方案。
- `docs/auth-implementation-plan.md`：认证与多身份模型。
- `docs/database-design.md`：数据库设计。
- `docs/mariadb-migration-plan.md`：MariaDB 迁移背景。

## 阅读代码后的整体判断

Muse 的核心方向已经比较清晰：Server 负责身份、授权、持久化和 Agent 编排；客户端负责交互与跨端状态；Desktop 提供本机能力；Mobile 提供随时发起任务和远程审批的入口。

项目最有价值的设计是将消息、模型调用和工具轨迹统一到同一个 run：

- `chat_messages` 保存最终对话。
- `model_runs` 保存模型调用状态和 token 用量。
- `tool_calls` 保存工具输入、输出、风险等级和执行状态。

这为后续接入更多模型、MCP、沙箱执行器和多设备 Agent 提供了自然扩展点。

与此同时，项目仍处于生产化之前：数据库 migration、测试、依赖安全、ServerBash 隔离、多实例状态和三端共享代码都需要继续补齐。建议先完成 `docs/project-risk-review.md` 中的 P1/P2 整改，再推进公网部署或更大范围使用。
