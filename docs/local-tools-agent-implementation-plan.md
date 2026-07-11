# Local Tools Agent Implementation Plan

## 1. 背景与结论

Muse 当前由 Node.js 服务端管理用户、Session、消息和 AI Models。macOS 客户端负责聊天 UI 与本机交互。现有 `local_bash_run` 位于服务端进程内，本质上操作的是 server host，而不是用户 Mac。

长期方案应调整为：

```txt
Node.js Server
  - Session / Message DB
  - AI Models gateway
  - Agent runtime
  - Local Tool Broker

macOS Desktop
  - Chat UI
  - Workspace authorization
  - Local Tool Host
  - Permission confirmation UI
  - Optional MCP bridge
```

核心原则：

- Agent 可以运行在云端 Node.js。
- 本地文件、Git、Shell、系统能力必须在用户 Mac 上执行。
- macOS 客户端主动连接服务端，不暴露公网端口。
- MCP 可以作为本地工具接入标准，但首版不需要完整 MCP 化。
- 数据库中的 Muse Session 继续作为唯一真源，Pi 或其他 Agent runtime 只作为运行时层。

推荐实施路线：

```txt
Phase 1: Custom WebSocket Tool Protocol + Local Tool Registry
Phase 2: Write tools, approval flow, richer tool-call UI
Phase 3: MCP adapter for local tool ecosystem
Phase 4: Pi Agent Runtime with customTools over Local Tool Broker
```

## 2. 当前实现评估

已有基础：

- 服务端已有 AI SDK tool registry。
- `tool_calls` 已落库，具备审计基础。
- 工具 metadata 已包含 `source`、`riskLevel`、`requiresApproval`。
- 计划文档中已经把 Local Tools / MCP 放在 Phase 3。

主要问题：

- `local_bash_run` 在服务端执行，生产部署后会操作云端机器。
- `local_bash_run` 是通用 shell，风险过高，只适合作为本机开发调试能力。
- `riskLevel: "dangerous"` 但 `requiresApproval: false`，语义不安全。
- 当前 `/api/chat` 是同步 `generateText`，还没有流式 run 状态机。
- Desktop Tauri 层目前没有本地 tool provider、workspace 授权或审批 UI。

处理策略：

- 保留现有 server-side bash 作为开发期实验工具。
- 重命名或文档标注为 server dev tool，生产默认关闭。
- 新增真正的 macOS Local Tool Host 路线。

## 3. 目标架构

```txt
┌─────────────────────────────────────────────┐
│ Node.js Server                              │
│                                             │
│  Chat Routes / WebSocket Gateway            │
│           │                                 │
│           ▼                                 │
│  Agent Runtime                              │
│    - AI SDK agent loop first                │
│    - Pi AgentSession later                  │
│           │                                 │
│           ▼                                 │
│  Local Tool Broker                          │
│    - requestId                              │
│    - timeout                                │
│    - device routing                         │
│    - audit persistence                      │
└───────────┬─────────────────────────────────┘
            │ authenticated WebSocket
            ▼
┌─────────────────────────────────────────────┐
│ macOS Desktop                               │
│                                             │
│  WebSocket Bridge                           │
│           │                                 │
│           ▼                                 │
│  Local Tool Host                            │
│    - tool registry                          │
│    - policy engine                          │
│    - workspace grants                       │
│    - approval dialogs                       │
│           │                                 │
│           ▼                                 │
│  Built-in Tools / MCP Tools                 │
│    - filesystem                             │
│    - search                                 │
│    - git                                    │
│    - command runner                         │
└─────────────────────────────────────────────┘
```

请求流程：

```txt
1. 用户在 macOS 客户端发送消息。
2. 客户端附带 sessionId、deviceId、workspaceId。
3. 服务端读取 Session 历史并启动 Agent run。
4. Agent 调用 mac_read_file 等自定义工具。
5. 服务端 Local Tool Broker 发送 tool.request 到指定 Mac。
6. Mac Local Tool Host 做权限、路径、策略校验。
7. 必要时展示确认弹窗。
8. Mac 执行工具并返回 tool.result。
9. Agent 获得结果后继续推理。
10. 服务端把 assistant 消息、tool call 概要和 usage 落库。
```

## 4. Phase 0: 收口现有 Server Local Bash

目标：

- 避免现有 `local_bash_run` 被误认为用户本机工具。
- 保证生产环境不会注册高风险 server shell。

改造项：

- 将文档和描述中的语义明确为 `server host bash`。
- 生产环境默认关闭 `MUSE_LOCAL_BASH_ENABLED`。
- 将 metadata 调整为：

```ts
{
  source: "local",
  riskLevel: "dangerous",
  requiresApproval: true,
}
```

- 后续可以考虑重命名为 `server_dev_bash_run`，避免与 macOS local tools 混淆。

验收标准：

- 默认配置下模型不会看到 bash tool。
- 开启后工具描述明确提示执行位置是 server host。
- 危险工具在 metadata 层标记为需要确认。

## 5. Phase 1: Local Tool Protocol

目标：

- 在 `@muse/shared` 中定义服务端和桌面端共用的消息协议。
- 协议接近 MCP tool shape，方便后续适配 MCP。

建议类型：

```ts
export type LocalToolRiskLevel = "read" | "write" | "dangerous";

export type LocalToolManifest = {
  name: string;
  description: string;
  inputSchema: unknown;
  riskLevel: LocalToolRiskLevel;
  requiresApproval: boolean;
  outputLimitBytes: number;
};

export type ToolRequestMessage = {
  type: "tool.request";
  payload: {
    requestId: string;
    sessionId: string;
    runId: string;
    userId: string;
    deviceId: string;
    workspaceId: string;
    toolName: string;
    arguments: unknown;
    timeoutMs: number;
  };
};

export type ToolResultMessage = {
  type: "tool.result";
  payload: {
    requestId: string;
    success: boolean;
    result?: unknown;
    error?: {
      code: string;
      message: string;
    };
  };
};
```

建议 WebSocket 消息：

```txt
device.hello
device.ready
workspace.attach
workspace.detach
tool.request
tool.result
tool.error
chat.prompt
chat.abort
assistant.delta
assistant.done
run.error
```

验收标准：

- `@muse/shared` 提供完整协议类型。
- 服务端和桌面端不再手写零散 JSON shape。
- 所有消息都包含可追踪的 `requestId` 或 `runId`。

## 6. Phase 2: Server Tool Broker

目标：

- 服务端能把 Agent tool call 路由到指定在线 Mac。
- 服务端负责 timeout、断线失败、审计落库。

新增模块建议：

```txt
apps/server/src/local-tools/
  device-registry.ts
  local-tool-broker.ts
  local-tool-socket.ts
  local-tool-types.ts
```

核心接口：

```ts
export type LocalToolBrokerRequest = {
  sessionId: string;
  runId: string;
  userId: string;
  deviceId: string;
  workspaceId: string;
  toolName: string;
  arguments: unknown;
};

export interface LocalToolBroker {
  execute(
    request: LocalToolBrokerRequest,
    options?: { timeoutMs?: number },
  ): Promise<ToolResultMessage["payload"]>;
}
```

行为要求：

- WebSocket 必须使用现有 bearer token 鉴权。
- `deviceId` 必须绑定当前用户。
- `workspaceId` 必须来自桌面端授权上报。
- 每个 pending request 必须有 timeout。
- Mac 断线时，该设备上的 pending request 立即失败。
- tool call 状态写入数据库。

建议扩展 `tool_calls.status`：

```txt
pending
waiting_for_device
waiting_for_approval
running
succeeded
failed
timed_out
canceled
```

验收标准：

- 服务端可以向在线桌面端发送 `tool.request`。
- 桌面端返回 `tool.result` 后 broker resolve。
- 设备离线、workspace 未授权、请求超时都有明确错误码。

## 7. Phase 3: macOS Local Tool Host

目标：

- macOS 客户端提供真正的本机工具箱。
- 首版只做只读工具。

新增模块建议：

```txt
apps/desktop/src/local-tools/
  registry.ts
  policy.ts
  websocket-bridge.ts
  workspace.ts
  builtins/
    read-file.ts
    search-files.ts
    list-directory.ts
    git-status.ts
    git-diff.ts
```

统一工具接口：

```ts
export interface LocalToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;
  riskLevel: "read" | "write" | "dangerous";
  requiresApproval(input: TInput, context: ToolContext): boolean;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

首批工具：

```txt
workspace.read_file
workspace.search_files
workspace.list_directory
git.status
git.diff
```

Tauri Rust 层职责：

- 选择 workspace。
- 保存 workspace 授权信息。
- 获取 realpath。
- 防止符号链接逃逸。
- 读取文件、列目录、执行受控命令。

Local Tool Host 校验顺序：

```txt
1. 当前用户和 session 是否匹配。
2. deviceId 是否匹配。
3. workspaceId 是否已授权。
4. path 是否在 workspace 内。
5. realpath 后是否仍在 workspace 内。
6. 工具是否允许当前 session 使用。
7. 是否需要用户确认。
8. 执行工具。
9. 截断过大的输出。
```

验收标准：

- 用户通过文件选择器授权 workspace。
- 服务端只能读取授权 workspace 内文件。
- 符号链接越界会被拒绝。
- 返回内容有大小限制。

## 8. Phase 4: 接入现有 Chat Agent

目标：

- 在不引入 Pi 的情况下，先用当前 AI SDK tool loop 跑通闭环。

改造项：

- `ToolExecutionContext` 增加：

```ts
deviceId?: string;
workspaceId?: string;
localToolBroker?: LocalToolBroker;
```

- `createBuiltinToolRegistry` 根据在线设备动态注册：

```txt
mac_read_file
mac_search_files
mac_list_directory
mac_git_status
mac_git_diff
```

- 这些工具的 `execute` 内部调用 `localToolBroker.execute()`。
- `/api/chat` 支持客户端传入 workspace 绑定信息。
- 前端展示 tool call cards。

验收标准：

- 用户发送“读一下当前项目 package.json”。
- 模型调用 `mac_read_file`。
- Mac 读取本地 workspace 文件并返回。
- 模型基于文件内容回答。
- `tool_calls` 表记录完整调用概要。

## 9. Phase 5: 写操作与审批流

目标：

- 支持受控修改文件和运行命令。

新增工具：

```txt
workspace.apply_patch
workspace.write_file
run.tests
run.command
git.apply_patch
```

权限策略：

| 操作 | 策略 |
| --- | --- |
| 读取普通源码 | 自动允许 |
| 搜索文件 | 自动允许 |
| `git status` / `git diff` | 自动允许 |
| 写文件 | 展示 diff，用户确认 |
| 运行测试 | 可按 workspace 授权自动允许 |
| 安装依赖 | 每次确认 |
| 删除文件 | 每次确认 |
| Git commit | 每次确认 |
| `git reset --hard` / `git clean -fd` | 默认禁止 |
| `sudo` | 禁止 |
| 访问 workspace 外部 | 禁止 |
| 读取 `.env` / SSH Key / Keychain | 默认禁止 |
| `curl | sh` | 默认禁止 |

建议优先提供高层命令工具：

```txt
run_tests
format_project
install_dependencies
git_status
git_diff
```

通用 `run.command` 保持高风险，每次确认。

验收标准：

- 写文件前 UI 展示 unified diff。
- 用户拒绝后工具返回 `USER_REJECTED`。
- 危险命令被 policy 拦截。
- 修改完成后可展示变更文件列表。

## 10. Phase 6: MCP Adapter

目标：

- 让本地工具箱可以加载 MCP server。
- 服务端仍通过 WebSocket 调用 Mac，不直接连接用户机器上的 MCP server。

架构：

```txt
Server Agent Runtime
  ↓
Server Tool Broker
  ↓ WebSocket
Desktop MCP Bridge
  ↓ MCP client
Local MCP Servers
```

新增模块：

```txt
apps/desktop/src/local-tools/mcp/
  client-manager.ts
  tool-adapter.ts
  server-config.ts
```

规则：

- MCP server 只在本地启动。
- Desktop Bridge 枚举 MCP tools 后转换成 `LocalToolManifest`。
- 所有 MCP tool 调用仍经过本地 `policy.ts`。
- 不信任 MCP server 自身声明的安全边界。

验收标准：

- 可以加载一个本地 filesystem MCP server。
- MCP tool 对服务端看起来和内置 local tool 一致。
- policy engine 仍能拦截越界路径和危险操作。

## 11. Phase 7: Pi Agent Runtime

目标：

- 用 Pi 替换或增强当前轻量 AI SDK agent loop。
- 保留 Muse Session DB 作为唯一真源。

原则：

- Pi 运行在 Node.js 服务端。
- 禁用 Pi 内置 `read`、`write`、`edit`、`bash` 等 server filesystem tools。
- 只通过 Pi `customTools` 调用 Muse `LocalToolBroker`。
- 不让 Pi 的本地 JSONL session 成为主存储。

服务端分层：

```txt
Muse Session DB
  ↕
Pi AgentSession runtime cache
  ↕ customTools
Local Tool Broker
  ↕ WebSocket
macOS Local Tool Host
```

持久化策略：

- 用户消息、最终 assistant 消息、tool call 概要继续写 Muse DB。
- 如接入 Pi，需要保存可恢复 Agent 上下文的原始 payload。
- 不要只保存纯文本，否则服务重启后 tool result 上下文会丢失。

验收标准：

- 服务端重启后可以从 Muse DB 恢复下一轮 Agent 上下文。
- Pi 不会访问 server filesystem。
- Pi 触发本地文件读取时走 WebSocket Tool Broker。

## 12. 数据库建议

短期可以复用现有 `tool_calls` 表，并补充状态枚举。

中期建议新增：

```txt
devices
  id
  user_id
  name
  platform
  last_seen_at
  status

workspace_grants
  id
  user_id
  device_id
  workspace_id
  display_name
  root_path_hash
  created_at
  last_used_at

agent_runs
  id
  session_id
  user_id
  device_id
  workspace_id
  status
  started_at
  completed_at
```

注意：

- 云端不要默认保存用户本地绝对路径。
- 可以保存 hash、display name 和用户主动命名的 workspace label。
- 不要上传完整源码、完整 shell 输出、`.env` 或凭据。

## 13. 安全要求

必须实现：

- Desktop 主动连接服务端。
- WebSocket 使用登录态鉴权。
- deviceId 绑定用户。
- workspace 必须用户显式选择。
- 所有 path 做 realpath 校验。
- 防止符号链接逃逸。
- 工具输出大小限制。
- 高风险工具确认。
- 危险命令 denylist。
- shell tool 默认关闭或每次确认。
- 本地 token 使用 Keychain 或内存保存。
- sidecar 或 local bridge 不监听公网端口。

高风险 denylist 初版：

```txt
sudo
rm -rf
git reset --hard
git clean -fd
chmod
chown
curl | sh
wget | sh
访问 ~/.ssh
访问 ~/Library/Keychains
访问 .env
访问 workspace 外路径
```

## 14. 推荐里程碑

### M1: Protocol

交付物：

- `@muse/shared` local tool 协议类型。
- WebSocket message schema。
- local tool manifest schema。

验收：

- 服务端和桌面端类型共享。
- 可以 mock 一次 tool request / result。

### M2: Broker

交付物：

- 服务端 WebSocket endpoint。
- Device registry。
- LocalToolBroker。

验收：

- 桌面端连接后服务端能看到在线设备。
- 服务端可以发送工具请求并等待响应。

### M3: Read-only Local Tools

交付物：

- Workspace 授权。
- `read_file`、`search_files`、`list_directory`。
- realpath sandbox。

验收：

- Agent 可以读取授权 workspace 文件。
- 越界读取失败。

### M4: Chat Integration

交付物：

- AI SDK tools 调用 LocalToolBroker。
- tool call cards。
- tool call 落库状态完善。

验收：

- 一次真实对话中完成本地文件读取并回答。

### M5: Write and Approval

交付物：

- `apply_patch`。
- diff viewer。
- approval modal。
- command policy。

验收：

- 用户确认后才能修改文件。
- 危险命令被拦截。

### M6: MCP Adapter

交付物：

- Desktop MCP client manager。
- MCP tool adapter。

验收：

- 本地 MCP tool 可作为 Muse local tool 暴露。

### M7: Pi Runtime

交付物：

- Pi AgentSession runtime cache。
- Pi customTools over LocalToolBroker。
- DB message mapper。

验收：

- Pi 不访问 server filesystem。
- 本地工具全部通过 Mac 执行。
- Muse DB 仍是 Session 唯一真源。

## 15. 第一阶段建议任务拆分

优先做以下 PR：

1. `docs`: 固化 Local Tools Agent 方案。
2. `shared`: 增加 local tool protocol schema。
3. `server`: 增加 authenticated WebSocket 和 DeviceRegistry。
4. `desktop`: 建立 WebSocket bridge，完成 device hello。
5. `desktop`: workspace picker 和 read-only file tools。
6. `server`: LocalToolBroker + mock tool call endpoint。
7. `server`: AI SDK registry 接入 `mac_read_file`。
8. `desktop`: tool call status UI。

完成这些后，再评估是否进入 MCP adapter 或 Pi runtime。
