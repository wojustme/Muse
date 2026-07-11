# Muse

Muse 是一个以桌面端为优先入口的 AI Chat 应用，当前阶段聚焦登录、会话 UI、多模型选择和本地开发闭环，后续会逐步演进为具备工具调用与本机能力的 AI Agent。

## 当前状态

- 已搭建 `pnpm` workspace monorepo，包含桌面端、Web 端、Node.js 服务端和共享包。
- 已实现 Tauri v2 + React + Vite 桌面壳，以及同构的浏览器 Web 客户端。
- 已实现 Fastify API 服务、MariaDB/Drizzle 连接、用户身份表和登录态表。
- 已接入飞书 OAuth provider 框架，支持真实飞书登录和本地开发免 OAuth 登录。
- 已提供模型列表、创建会话和发送消息的 API 占位实现。
- 聊天模型流式调用、消息持久化、真实 session 列表落库仍在后续阶段。

## 技术栈

- Monorepo: pnpm workspace
- Desktop: Tauri v2, React 19, TypeScript, Vite
- Web: React 19, TypeScript, Vite
- Server: Node.js 24+, Fastify 5, Zod, Drizzle ORM, MariaDB
- AI: Vercel AI SDK 5, OpenAI-compatible provider 适配层
- Shared: `@muse/shared`, `@muse/api-client`, `@muse/model-router`

## 目录结构

```txt
apps/
  desktop/        Tauri 桌面客户端，复用 React Chat UI
  web/            浏览器 Web 客户端，复用 API client 和大部分 UI
  server/         Fastify API 服务，负责认证、模型列表、聊天和会话接口

packages/
  shared/         全端共享类型、Zod schemas 和常量
  api-client/     浏览器兼容的 Muse API client，封装登录态与 OAuth 轮询
  model-router/   服务端模型 provider 路由与能力声明

docs/             架构、认证、数据库和迁移设计文档
scripts/          工程辅助脚本
```

## 环境要求

- Node.js `>=24.0.0`
- pnpm `>=11.0.0`
- Rust 和 Tauri v2 本地开发环境
- MariaDB，本地默认连接串为 `mysql://muse:muse@127.0.0.1:3306/muse_db`

## 本地开发

安装依赖：

```bash
pnpm install
```

准备服务端环境变量：

```bash
cp apps/server/.env.example apps/server/.env
```

启动服务端：

```bash
pnpm dev:server
```

启动桌面端：

```bash
pnpm dev:desktop
```

启动 Web 端：

```bash
pnpm dev:web
```

同时启动服务端和桌面端：

```bash
pnpm dev
```

## 环境变量

服务端读取 `apps/server/.env`，主要配置如下：

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
```

模型相关环境变量已预留：

```env
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
GLM_API_KEY=
```

前端默认请求 `http://127.0.0.1:8787`，可通过 Vite 环境变量覆盖：

```env
VITE_SERVER_URL=http://127.0.0.1:8787
```

## 登录与认证

- 认证入口统一在 `POST /api/auth/:provider/challenge`，当前 provider 实现为 `feishu`。
- 飞书 OAuth callback 为 `GET /api/auth/feishu/callback`。
- 客户端通过 `GET /api/auth/challenge/status?state=...` 轮询扫码或授权结果。
- 登录成功后服务端签发不透明 session token，数据库只保存 token hash。
- `GET /api/auth/me` 用于恢复当前用户，`POST /api/auth/logout` 用于吊销当前 token。
- 本地联调可将 `AUTH_DEV_MOCK=true`，使用 `POST /api/auth/dev` 签发真实 session，绕过第三方 OAuth。

飞书凭证从 MariaDB 的 `system_configs` 表读取，配置 key 为 `auth.feishu`，value 为 JSON 字符串：

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

## API 概览

- `GET /health`：健康检查。
- `GET /api/models`：返回当前内置模型列表。
- `POST /api/chat`：要求 bearer token，接收 sessionId、用户消息和可选模型选择，当前返回占位 assistant 文本。
- `GET /api/sessions`：要求 bearer token，当前返回空列表。
- `POST /api/sessions`：要求 bearer token，当前创建临时 session 响应，尚未落库。
- `POST /api/auth/dev`：开发免 OAuth 登录，仅在 `AUTH_DEV_MOCK=true` 时启用。
- `POST /api/auth/feishu/challenge`：创建飞书登录 challenge。
- `GET /api/auth/challenge/status`：轮询登录 challenge 状态。
- `GET /api/auth/me`：返回当前登录用户与已绑定身份。
- `POST /api/auth/logout`：退出登录并吊销当前 session。

## 数据库

当前 Drizzle schema 包含：

- `users`：Muse 内部用户。
- `user_identities`：第三方登录身份，一个用户可绑定多个 provider 身份。
- `auth_sessions`：登录态，只存不透明 token 的 SHA-256 hash。
- `system_configs`：系统级 JSON 配置，例如飞书 OAuth 凭证。

当前仓库还没有自动迁移命令或 migration 文件，建表与迁移方案见 `docs/database-design.md` 和 `docs/mariadb-migration-plan.md`。

## 常用脚本

```bash
pnpm dev              # 并行启动 server 和 desktop app
pnpm dev:server       # 启动 Fastify 开发服务
pnpm dev:desktop      # 启动 Tauri 桌面端
pnpm dev:desktop:web  # 只启动 desktop 的 Vite 前端
pnpm dev:web          # 启动浏览器 Web 客户端
pnpm build            # 按 workspace 顺序构建
pnpm typecheck        # 全仓类型检查
pnpm lint             # 全仓 lint
pnpm format           # Prettier 格式化
pnpm format:check     # 检查格式
```

## 当前限制

- `POST /api/chat` 还没有接入真实模型调用和 streaming。
- `GET /api/sessions` 和 `POST /api/sessions` 仍是占位实现，session/message 尚未持久化。
- `@muse/model-router` 已有 provider 抽象，但服务端 chat 路由尚未使用它。
- 桌面端生产环境如何托管或启动 Node.js API 仍待设计。
- Tauri 本机工具、MCP、Computer Use 和 Agent runtime 仍在规划阶段。

## 下一步

- 接入真实 AI SDK `streamText` 响应，并统一多模型路由。
- 为 sessions、messages、model_runs 和 tool_calls 补齐数据库 schema 与迁移。
- 将 Chat API 改为读取 session 历史、保存用户消息和 assistant 消息。
- 完成 session 列表、重命名、删除、搜索和恢复历史。
- 设计 Tauri 生产包与服务端部署/sidecar 方案。
