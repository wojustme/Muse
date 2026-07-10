# Muse 研发计划：从 AI Chat 到 AI Agent

## 1. 项目目标

Muse 的目标是从一个桌面端 AI Chat 产品逐步演化为具备本机操作能力的 AI Agent。

阶段性路线：

1. 先支持 macOS 桌面 App，提供基于 session 的 AI 对话能力，当前 session 内可记住历史上下文。
2. 完善多模型 AI Chat 能力，支持 OpenAI、DeepSeek、GLM 等模型。
3. 扩展 Windows 桌面版本。
4. 在 Chat 能力稳定后，逐步演进到 AI Agent，支持工具调用、本地文件/系统能力、MCP、本机 Computer Use。

## 2. 第一阶段技术选型

### 2.1 客户端/桌面端

第一阶段直接采用 Tauri v2。

推荐栈：

- Desktop Shell: Tauri v2
- Frontend: React + TypeScript + Vite
- UI: Tailwind CSS + Radix UI 或 shadcn/ui
- Client State: Zustand
- Data Fetching: TanStack Query
- Local Store: SQLite

选择 Tauri v2 的原因：

- 支持 macOS 和 Windows，符合先 macOS、后 Windows 的产品路线。
- Rust native 层适合承载后续本机能力，例如文件系统、截图、权限管理、系统调用、Accessibility、键鼠操作等。
- 相比 Electron，包体积和资源占用更低。
- Tauri v2 的权限模型更严格，更适合后续做本机操作类 Agent。

需要注意：

- Tauri 不内置 Node.js。
- AI/Agent 主逻辑建议放在独立 Node.js 服务中，Tauri 主要负责桌面壳和本机能力。
- macOS 正式分发需要 code signing 和 notarization。
- Windows 正式分发需要考虑签名，否则系统安全提示会比较明显。

### 2.2 后端/AI 服务端

第一阶段采用 Node.js + TypeScript。

推荐栈：

- Runtime: Node.js LTS
- Package Manager: pnpm
- Web Framework: Fastify
- AI SDK: Vercel AI SDK
- Streaming: SSE / AI SDK UI Message Stream
- Storage: SQLite 起步，后续可扩展 PostgreSQL
- Schema Validation: Zod
- ORM: Drizzle ORM

选择 Vercel AI SDK 的原因：

- TypeScript 原生，适合 Node.js 技术栈。
- 支持 streaming、tool calling、多模型 provider、OpenAI-compatible provider。
- 可以较轻量地支持 session 级别 AI Chat。
- 后续可以继续演进到轻量 Agent loop。

第一阶段暂不引入 LangGraph。

原因：

- 当前核心需求是 session 级别 Chat，不需要复杂 workflow、human-in-the-loop、long-running task 和可恢复执行。
- LangGraph 更适合复杂 Agent 编排阶段。
- 过早引入会增加系统复杂度和调试成本。

Mastra 可作为第二阶段候选。

定位：

- 当需要更完整的 Agent runtime、memory、tools、workflow、multi-agent、observability 时，再评估引入。
- Mastra 可以和 Vercel AI SDK provider 一起使用，但不建议同时使用两套 Agent loop。

### 2.3 包管理与运行时

第一阶段统一使用 pnpm 管理 Node.js 依赖和 monorepo workspace。

决策：

- Package Manager: pnpm
- Runtime: Node.js LTS
- Workspace: pnpm workspace
- Lockfile: `pnpm-lock.yaml`
- Workspace Config: `pnpm-workspace.yaml`

不使用 Bun 作为第一阶段主线。

原因：

- 当前项目是多应用 monorepo，pnpm workspace 在 TypeScript monorepo 中更成熟、稳定。
- Tauri 官方支持 pnpm，创建项目和开发命令都可以直接使用 pnpm。
- Node.js LTS 与 Fastify、Vercel AI SDK、Drizzle、Tauri 前端工程链路兼容性更稳。
- Bun 虽然速度快，也支持 workspaces，但同时承担 runtime、package manager、bundler、test runner 多个角色，第一阶段会增加兼容性变量。

约束：

- 仓库只保留 `pnpm-lock.yaml`，不混用 `bun.lock`、`package-lock.json`、`yarn.lock`。
- 所有 workspace 内部依赖使用 `workspace:*`。
- Bun 可作为后续性能优化或 server runtime 预研，但不进入第一阶段主线。

## 3. 推荐架构

```txt
apps/
  desktop/              Tauri v2 + React + TypeScript + Vite
  server/               Node.js + Fastify + Vercel AI SDK

packages/
  shared/               shared types, zod schemas
  model-router/         OpenAI / DeepSeek / GLM adapters
  session-store/        session and message persistence
  agent-runtime/        lightweight agent loop, tools, future MCP bridge
```

运行边界：

```txt
Tauri App
  -> React UI
  -> 调用 Node.js API
  -> 通过 SSE 接收模型流式输出

Node.js API
  -> 读取 session 历史
  -> 选择模型 provider
  -> 调用 Vercel AI SDK streamText
  -> 保存消息
  -> 返回 UI Message Stream

Tauri Native Layer
  -> 当前阶段只做基础桌面能力
  -> 后续承载本机工具、权限、本机操作能力
```

### 3.1 目录组织结论

项目采用 pnpm workspace monorepo，按应用形态和可复用能力分层：

```txt
Muse/
  apps/
    desktop/            Tauri 桌面客户端，macOS + Windows 共用
    server/             Node.js 后端服务
    mobile/             未来移动端，iOS + Android 共用
    miniapp/            未来微信小程序客户端

  packages/
    shared/             全端共享类型、zod schemas、常量
    model-router/       后端模型路由，OpenAI / DeepSeek / GLM 适配
    api-client/         可选，多客户端共享 API client
    session-store/      可选，session/message 存储抽象
    agent-runtime/      可选，轻量 agent loop、tools、MCP bridge

  docs/                 架构、接口、研发文档
  scripts/              工程脚本
```

第一阶段只需要创建：

```txt
apps/
  desktop/
  server/

packages/
  shared/
  model-router/
```

后续当能力变复杂后，再逐步抽出：

```txt
packages/
  api-client/
  session-store/
  agent-runtime/
```

目录边界：

- `apps/desktop`: 用户可见的桌面客户端，包含 React 前端和 Tauri Rust native 层。
- `apps/server`: Node.js 后端，负责 Chat API、session 读写、模型调用、streaming、tool calling 和后续 agent runtime。
- `apps/mobile`: 后续 iOS 和 Android 客户端入口，建议 React Native / Expo 起步，或继续评估 Tauri mobile。
- `apps/miniapp`: 后续微信小程序客户端入口，可选 Taro + React + TypeScript，或原生小程序。
- `packages/shared`: 桌面端、移动端、小程序、后端都能复用的类型、schema 和常量。
- `packages/model-router`: 后端侧模型 provider 适配层，不直接放到客户端。
- `packages/api-client`: 后续多客户端共享 API 调用时再抽，微信小程序需要单独适配 `wx.request`、`wx.connectSocket` 等 transport。
- `packages/session-store`: session/message 存储逻辑稳定后，从 `apps/server` 中抽出。
- `packages/agent-runtime`: tool calling、MCP、本机工具和 Agent loop 复杂后再抽出。

macOS 和 Windows 不拆成两个 app，统一放在 `apps/desktop`，平台差异在内部处理：

```txt
apps/desktop/
  src/                  React 前端，macOS/Windows 共用
  src-tauri/            Tauri Rust 层，macOS/Windows 共用
    src/
      platform/
        macos.rs
        windows.rs
        mod.rs
```

iOS 和 Android 后续统一放在 `apps/mobile`，不要一开始拆成 `apps/ios` 和 `apps/android`。

微信小程序作为独立客户端入口，放在 `apps/miniapp`：

```txt
apps/miniapp/
  src/                  Taro/React 写法
    app.ts
    app.config.ts
    pages/
      chat/
      sessions/
      settings/
    components/
    services/
    utils/
  project.config.json
  package.json
```

## 4. Session 级别对话设计

第一阶段的 memory 只做 session 级别，不做长期记忆。

数据模型建议：

- sessions
  - id
  - title
  - created_at
  - updated_at
  - model_provider
  - model_name
- messages
  - id
  - session_id
  - role
  - parts
  - created_at
  - metadata
- model_runs
  - id
  - session_id
  - message_id
  - provider
  - model
  - status
  - usage
  - error
  - created_at
- tool_calls
  - id
  - session_id
  - message_id
  - tool_name
  - input
  - output
  - status
  - created_at

基础流程：

```txt
POST /api/chat
  1. 接收 sessionId 和用户 message
  2. 从数据库读取 session 历史 messages
  3. append 当前用户 message
  4. convertToModelMessages
  5. streamText({ model, messages })
  6. toUIMessageStreamResponse()
  7. onFinish 保存完整 messages
```

前端使用：

```ts
useChat({
  id: sessionId,
  transport: new DefaultChatTransport({
    api: "http://127.0.0.1:3000/api/chat",
  }),
});
```

## 5. 多模型设计

第一阶段需要支持多模型，但不要把模型厂商 SDK 散落在业务代码中。

建议封装统一模型路由：

```ts
interface ModelProvider {
  id: string;
  name: string;
  createModel(modelName: string): unknown;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    computerUse: boolean;
  };
}
```

优先支持：

- OpenAI
- DeepSeek
- GLM / 智谱

策略：

- 优先使用 Vercel AI SDK provider。
- 对 OpenAI-compatible API，通过统一 baseURL 和 apiKey 接入。
- 在配置层保存 provider、model、apiKey、baseURL。
- 每个 session 可以绑定默认模型，也允许用户切换模型。

## 6. Agent 演进路线

### Phase 1: AI Chat

目标：

- macOS App 可启动。
- 可以创建、切换、删除 session。
- session 内历史可记忆。
- 支持 SSE 流式输出。
- 支持 OpenAI、DeepSeek、GLM 至少一个以上 provider。

不做：

- 复杂 Agent workflow。
- 长期记忆。
- 本机自动操作。
- 多 Agent 协作。

### Phase 2: Tool Calling

目标：

- 引入基础工具调用。
- 工具先从安全、低风险能力开始，例如时间、简单计算、文件只读检索、配置读取。
- 所有工具调用落库，便于审计和调试。

技术：

- 继续使用 Vercel AI SDK tools。
- 保持轻量 agent loop。
- 如果工具和流程复杂度明显上升，再评估 Mastra。

### Phase 3: Local Tools / MCP

目标：

- 把本机能力抽象为 tools。
- 支持 MCP，作为后续工具生态边界。
- Tauri Rust 层负责本机权限和系统调用。

候选工具：

- file.read
- file.search
- app.open
- clipboard.read
- clipboard.write
- screenshot.capture
- system.info

安全原则：

- 默认只读。
- 高风险操作必须二次确认。
- 每个 tool 有权限声明、参数 schema、调用日志。

### Phase 4: Computer Use

目标：

- 通过 AI 对话完成本地操作。
- 支持截图理解、鼠标点击、键盘输入、窗口切换、应用操作。

macOS 方向：

- Accessibility 权限。
- Screen Recording 权限。
- Tauri Rust command 或 Swift helper。

Windows 方向：

- Windows UI Automation。
- PowerShell / .NET helper。

安全原则：

- 人类确认优先。
- 高风险动作禁止自动执行。
- 操作前展示计划，操作后展示结果。
- 所有动作可审计、可回滚时尽量支持回滚。

## 7. 里程碑计划

### M0: 项目初始化

交付物：

- Monorepo 初始化。
- Tauri v2 + React + Vite 桌面工程。
- Node.js + Fastify server 工程。
- TypeScript、ESLint、Prettier、基础脚本。
- shared types package。

验收标准：

- 本地可启动 desktop 和 server。
- Tauri App 可以请求本地 API。

### M1: 基础 Chat

交付物：

- Chat UI。
- session 列表。
- 创建 session。
- 发送消息。
- AI SDK 流式响应。
- 消息保存。

验收标准：

- 同一个 session 中，模型可以基于历史消息回答。
- App 重启后可以恢复 session 历史。

### M2: 多模型支持

交付物：

- model-router。
- OpenAI provider。
- DeepSeek provider。
- GLM provider。
- 模型配置界面。

验收标准：

- 用户可以选择模型。
- 不同 provider 走同一套 Chat API。
- provider 错误能被前端清晰展示。

### M3: Chat 产品化

交付物：

- session 重命名。
- 删除 session。
- 搜索历史 session。
- 停止生成。
- 重新生成。
- 复制消息。
- Markdown 渲染。
- code block 渲染。

验收标准：

- Chat 体验接近可日常使用。

### M4: 轻量 Agent

交付物：

- tools 基础框架。
- tool call persistence。
- 第一批安全工具。
- tool call UI 展示。

验收标准：

- 模型可以调用工具。
- 用户能看到工具调用过程和结果。
- 工具调用可追踪。

### M5: 本机能力预研

交付物：

- Tauri command 权限模型。
- macOS 文件读取工具。
- macOS 截图工具预研。
- Windows 技术验证。

验收标准：

- 本机能力通过统一 tool 接口暴露给 AI 层。

## 8. 风险与应对

### 8.1 Tauri 与 Node.js 边界

风险：

- Tauri 不内置 Node.js，本地 AI API 服务的启动、打包和生命周期需要设计。

应对：

- 开发期 desktop 和 server 分开启动。
- 生产期优先考虑远程 API。
- 如果必须本地运行 Node API，再评估 Tauri sidecar。

### 8.2 多模型能力差异

风险：

- 不同模型对 tool calling、reasoning、vision、streaming 的支持程度不同。

应对：

- 在 provider capabilities 中声明能力。
- UI 根据能力控制功能开关。
- 对 OpenAI-compatible provider 做兼容层。

### 8.3 过早 Agent 化

风险：

- 在 Chat 还没稳定前引入复杂 Agent framework，会增加开发和调试成本。

应对：

- 第一阶段只用 AI SDK + session store。
- 第二阶段只做轻量 tool calling。
- 出现复杂 workflow 后再引入 Mastra 或 LangGraph。

### 8.4 本机操作安全

风险：

- Computer Use 涉及隐私、权限和误操作风险。

应对：

- 权限最小化。
- 高风险操作必须确认。
- 操作日志全量记录。
- 本机工具按风险等级分层。

## 9. 当前推荐决策

第一阶段最终建议：

```txt
Desktop: Tauri v2 + React + TypeScript + Vite
Backend: Node.js + Fastify + TypeScript
Package Manager: pnpm
AI: Vercel AI SDK
Agent: 暂不引入重型 Agent framework
Memory: session-level messages persistence
Storage: SQLite 起步
Streaming: AI SDK UI Message Stream / SSE
Future Agent Runtime: Mastra 优先评估，LangGraph 作为复杂 workflow 候选
```

## 10. 下一步任务

1. 初始化 monorepo。
2. 配置 pnpm workspace。
3. 创建 Tauri v2 desktop app。
4. 创建 Node.js Fastify server app。
5. 接入 Vercel AI SDK 的最小 chat endpoint。
6. 实现 session/message SQLite 存储。
7. 实现 React Chat UI。
8. 跑通 macOS 本地端到端 Chat。
