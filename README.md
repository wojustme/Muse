# Muse

Muse 是一个桌面优先的 AI Chat / Agent 应用。当前代码已经不是单纯的聊天壳，而是由 Tauri 桌面端、浏览器 Web 端、Fastify API 服务、MariaDB 持久化和 Vercel AI SDK 工具调用链路组成的 monorepo。

这个 README 只依据当前代码整理，不基于 git 历史。它描述的是当前仓库能跑起来、能读到的实现状态。

## 当前能力

- 登录认证：支持飞书 OAuth 登录，本地开发可通过 `AUTH_DEV_MOCK` 绕过第三方 OAuth，但仍签发真实 session token。
- 用户体系：内部用户、第三方身份、登录态都落在 MariaDB，session token 明文只返回给客户端一次，库里只保存 SHA-256 hash。
- 模型授权：模型目录存储在 `ai_models`，用户可用模型通过 `user_ai_models` 授权，`/api/models` 只返回当前用户被授权的非敏感模型信息。
- 聊天会话：支持会话列表、消息历史、重命名、软删除、首条消息懒创建，避免空会话落库。
- 流式响应：`POST /api/chat` 使用 SSE 推送 `start`、`delta`、`done`、`error` 事件，前端按增量渲染打字机效果。
- 真实模型调用：当前 Chat 路由接入 DeepSeek provider，通过 Vercel AI SDK `streamText` 调用模型。
- 工具调用：模型调用时注册内置工具、会话工具、模型工具、可选服务端 bash 工具，以及桌面端 macOS 本机工具。
- 桌面本机能力：Tauri 侧可以在已绑定 workspace 内列目录、读文件、搜索、写文件、应用 patch、执行命令；写入和命令执行会在前端弹出确认。
- 双客户端：`apps/desktop` 是 Tauri + React 桌面端，`apps/web` 是浏览器 Web 端；两者共享主要聊天 UI 逻辑，桌面端额外连接本机工具桥。

## 技术栈

- Monorepo: `pnpm` workspace
- Desktop: Tauri v2, Rust, React 19, TypeScript, Vite
- Web: React 19, TypeScript, Vite
- Server: Node.js 24+, Fastify 5, Zod, Drizzle ORM, MariaDB, WebSocket
- AI: Vercel AI SDK 5, OpenAI-compatible provider, DeepSeek provider
- UI: lucide-react, react-markdown, remark-gfm
- Shared packages: `@muse/shared`, `@muse/api-client`, `@muse/model-router`

## 目录结构

```txt
apps/
  server/          Fastify API 服务：认证、模型、会话、聊天、local tools WebSocket
  desktop/         Tauri 桌面端：React Chat UI + macOS 本机工具桥
  web/             浏览器 Web 端：React Chat UI + OAuth 登录

packages/
  shared/          跨端 Zod schemas、类型和常量
  api-client/      浏览器兼容 API client，封装 token、登录 challenge、logout 等
  model-router/    模型 provider 抽象与 OpenAI-compatible provider 工厂

docs/              架构、认证、数据库、迁移和 local tools 设计文档
scripts/           开发辅助脚本，例如桌面 debug bundle 启动器
```

## 架构概览

Muse 的运行时可以按四层理解：

1. 客户端层

   `apps/desktop` 和 `apps/web` 负责登录态恢复、模型选择、会话列表、消息历史加载、Markdown 渲染和 SSE 流式消费。桌面端额外初始化 `LocalToolBridge`，登录后通过 WebSocket 连接服务端并注册 macOS 本机工具。

2. API 层

   `apps/server/src/server.ts` 创建 Fastify 实例，注册 CORS、健康检查、认证、模型、会话、聊天和 local tools 路由，同时把 `/api/local-tools/ws` 挂到同一个 HTTP server 的 upgrade 流程里。

3. 业务与数据层

   `apps/server/src/db/schema.ts` 是当前数据库事实来源，包含用户、身份、登录态、系统配置、模型目录、模型授权、聊天会话、消息、模型调用和工具调用记录。服务端通过 `mysql2/promise` pool + `drizzle-orm/mysql2` 访问 MariaDB。

4. Agent / Tool 层

   Chat 路由在每次模型调用前创建工具注册表。内置工具包括时间、当前会话、消息搜索、可用模型列表；高风险的 `local_bash_run` 需要通过环境变量显式打开；桌面端连接后还会注册 `mac_*` 工具，把模型工具调用转发给本机 Tauri command。

## 本地开发

环境要求：

- Node.js `>=24.0.0`
- pnpm `>=11.0.0`
- MariaDB
- Rust 和 Tauri v2 本地开发环境

安装依赖：

```bash
pnpm install
```

准备服务端配置：

```bash
cp apps/server/.env.example apps/server/.env
```

默认服务端地址是 `127.0.0.1:8787`，桌面端 Vite 地址是 `127.0.0.1:1420`，Web 端 Vite 地址是 `127.0.0.1:1430`。

启动服务端：

```bash
pnpm dev:server
```

启动桌面端推荐使用：

```bash
pnpm dev:desktop
```

`pnpm dev:desktop` 会运行 `scripts/muse-dev-desktop.mjs`。这个脚本会检查 `http://127.0.0.1:8787/health`，必要时启动后端，然后构建 Tauri debug bundle，并通过完整路径打开：

```txt
apps/desktop/src-tauri/target/debug/bundle/macos/Muse.app
```

这比直接运行裸二进制或 `open -a Muse` 更稳定，可以避免误启动 release bundle 或启动了不可见的 CLI 子进程。

只启动桌面端 Vite：

```bash
pnpm dev:desktop:web
```

使用 Tauri dev 热加载：

```bash
pnpm dev:desktop:tauri
```

启动浏览器 Web 端：

```bash
pnpm dev:web
```

同时启动服务端和桌面端：

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

## 聊天链路

`POST /api/chat` 是当前核心业务接口，要求已登录。请求包含：

- `sessionId`：客户端生成或已有会话 ID。
- `message`：用户消息，目前支持 text parts。
- `model`：可选模型选择，形如 `{ provider, name }`。
- `localTools`：可选桌面工具上下文，包含 `deviceId` 和 `workspaceId`。

服务端行为：

- 如果 `sessionId` 不存在，则在首条用户消息事务里懒创建 `chat_sessions`。
- 如果会话存在但状态不是 `active`，返回 404。
- 根据请求模型或会话模型查 `ai_models` + `user_ai_models`，确保当前用户有授权。
- 当前只支持 `provider = deepseek` 的真实模型流式调用。
- 先落用户消息和 `model_runs(pending)`。
- 通过 SSE 返回 `start` 事件，随后持续返回 `delta`。
- 模型完成后落 assistant 消息、模型用量、工具调用记录，并更新会话摘要。
- 失败时把 `model_runs` 标记为 `failed`，并通过 SSE 返回 `error`。

SSE 事件类型：

- `start`：返回 assistant message id、session id、模型和会话摘要。
- `delta`：返回一段文本增量。
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

## Local Tools

Muse 的工具体系分为三类：

1. 内置只读工具

   包括 `time_now`、`session_get_current`、`session_list_messages`、`session_search_messages`、`model_list_available`。

2. 服务端本机 bash

   工具名是 `local_bash_run`，默认关闭。只有设置 `MUSE_LOCAL_BASH_ENABLED=true` 后才注册。它会把 cwd 限制在 `MUSE_LOCAL_BASH_ALLOWED_ROOTS` 下，并限制超时和输出长度。

3. 桌面 macOS 工具

   桌面端登录后创建 `LocalToolBridge`，通过 `ws://127.0.0.1:8787/api/local-tools/ws?token=...` 注册设备和 workspace。默认 workspace 写在 `apps/desktop/src/App.tsx`，当前是：

   ```txt
   /Users/bytedance/Downloads
   ```

   服务端收到模型工具调用后，通过 `LocalToolBroker` 转发到对应桌面端 WebSocket，再由 Tauri command 执行。

桌面 macOS 工具包括：

- `mac_list_directory`：列出 workspace 内目录。
- `mac_read_file`：读取 workspace 内文本文件。
- `mac_search_files`：搜索 workspace 内文本文件。
- `mac_write_file`：创建或覆盖文本文件，需要用户确认。
- `mac_apply_patch`：对文本文件应用 unified diff，需要用户确认。
- `mac_local_bash`：在 workspace 内执行 bash 命令，需要用户确认。

Tauri 侧安全边界：

- 所有文件路径必须在已绑定 workspace 内。
- 拒绝 `.env`、`.env.*`、`.ssh`、`Keychains` 等敏感路径。
- 拒绝包含 `sudo`、`rm -rf`、`git reset --hard`、`git clean -fd`、`chmod`、`chown`、`curl | sh`、`wget | sh` 等危险命令模式。
- 读取、搜索、写入、patch、命令输出都有大小或数量限制。
- 写入、patch、命令执行会在桌面 UI 上展示详情并等待用户批准。

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
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `PATCH /api/sessions/:id`
- `DELETE /api/sessions/:id`

Local tools：

- `GET /api/local-tools/devices`
- `WS /api/local-tools/ws?token=...`

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
- 桌面端默认 workspace 目前写死为 `/Users/bytedance/Downloads`，还不是用户可配置的多 workspace 管理。
- `local_bash_run` 和 `mac_local_bash` 都属于高风险能力，虽然已有路径、命令和审批限制，但仍只适合可信本机开发环境。
- Tauri 生产包如何携带、启动或发现 Node.js API 服务仍需要进一步产品化设计。

## 阅读代码后的整体判断

Muse 当前的架构方向比较清晰：后端负责身份、授权、持久化和模型调用，客户端负责交互体验，桌面端再提供 Web 无法直接触达的本机能力。最关键的设计点是把“聊天”与“工具执行”统一在一次模型 run 里：`model_runs` 记录调用，`tool_calls` 记录工具轨迹，`chat_messages` 记录最终对话结果。这样后续无论接 MCP、更多本机工具、审批流还是多模型路由，都有比较自然的落点。

同时，当前代码还处在产品化前的工程阶段：schema 有了但 migration 缺失，模型路由抽象有了但 Chat 主路径仍是 DeepSeek 专线，桌面 workspace 也还没有做成可配置能力。这些不是概念问题，而是下一阶段要补齐的工程闭环。
