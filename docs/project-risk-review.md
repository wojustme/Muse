# Muse 项目风险审查

> 审查日期：2026-07-16  
> 审查范围：当前 `main` 分支中的 Server、Web、Desktop、Mobile、共享包、Tauri/Rust 本地工具实现与工程配置。  
> 本文记录的是当前代码风险，不代表所有问题都已发生，也不替代正式的渗透测试、依赖治理和生产发布评审。

## 1. 结论

Muse 已具备 AI Chat、Agent 工具调用、跨端消息同步、桌面工作区工具和移动端远程审批等完整产品雏形，但当前仍更适合可信本机或内部开发环境，不建议未经整改直接暴露到公网。

优先整改方向：

1. 修复 `ServerBash` 声明需要审批、实际直接执行的问题。
2. 为 `AUTH_DEV_MOCK` 增加开发环境强制保护。
3. 升级存在公开高危安全公告的 `drizzle-orm`。
4. 生产环境启用 HTTPS/WSS、Tauri CSP 和安全凭证存储。
5. 建立数据库 migration、核心自动化测试和跨端并发控制。

## 2. 风险等级

| 等级 | 含义                                                               | 建议               |
| ---- | ------------------------------------------------------------------ | ------------------ |
| P1   | 可能导致远程命令执行、认证绕过、敏感凭证泄露或生产环境重大安全问题 | 发布前必须处理     |
| P2   | 可能导致数据不一致、功能失效、跨端异常或扩容失败                   | 进入下一轮核心开发 |
| P3   | 工程质量、可维护性和文档一致性问题                                 | 纳入持续治理       |

## 3. P1：高优先级风险

### 3.1 `ServerBash` 未真正进入审批流程

**现状**

- `apps/server/src/agent/tool-registry.ts` 将 `ServerBash` 标记为：
  - `riskLevel: "dangerous"`
  - `requiresApproval: true`
- `apps/server/src/agent/tools/local-bash.ts` 的实际执行逻辑没有调用 `ApprovalCoordinator`。
- 设置 `MUSE_LOCAL_BASH_ENABLED=true` 后，模型生成的命令会直接通过 `/bin/bash -lc` 执行。

**影响**

- UI 和工具元数据表示“需要审批”，实际没有人工确认。
- `MUSE_LOCAL_BASH_ALLOWED_ROOTS` 只限制初始 `cwd`，不是文件系统沙箱；Shell 仍可使用绝对路径访问其他目录。
- 一旦模型受到提示注入或误判，可能直接影响 Server 主机。

**整改建议**

1. 未修复前保持 `MUSE_LOCAL_BASH_ENABLED=false`。
2. 复用 Desktop `Write`、`Edit`、`Bash` 的审批协调器。
3. 不要将 cwd 白名单描述为文件系统隔离。
4. 生产场景改为容器、MicroVM 或独立低权限执行器。
5. 增加命令审计、执行身份隔离和资源配额。

### 3.2 `AUTH_DEV_MOCK` 缺少环境强制保护

**现状**

`POST /api/auth/dev` 只检查 `AUTH_DEV_MOCK`，没有同时检查 `APP_ENV`、监听地址或调用来源。

**影响**

如果生产环境误配置 `AUTH_DEV_MOCK=true`，访问者可以直接获得有效 Muse session。

**整改建议**

1. 增加 `APP_ENV`。
2. 仅允许 `local`、`development`、`test` 环境启用。
3. 非 loopback `HOST` 下启用时拒绝启动。
4. 服务启动时输出显著 WARN。
5. 在生产构建或部署配置中显式覆盖为 `false`。

### 3.3 `drizzle-orm` 命中高危安全公告

**现状**

当前依赖版本为 `drizzle-orm@0.36.4`。执行：

```bash
pnpm audit --prod --audit-level moderate
```

检测到 SQL identifier escaping 相关高危公告，修复版本要求 `drizzle-orm >= 0.45.2`。

**影响**

当前代码主要使用静态表名和字段名，不能仅凭公告断言已有接口可直接利用；但依赖版本处于已知漏洞范围，不应继续作为生产基线。

**整改建议**

1. 升级到已修复版本。
2. 回归 MariaDB 查询、事务、布尔字段和 datetime 映射。
3. 将 `pnpm audit --prod` 纳入 CI。

### 3.4 Mobile 允许任意明文 HTTP

**现状**

`apps/mobile/src-tauri/Info.ios.plist` 设置了：

```xml
<key>NSAllowsArbitraryLoads</key>
<true/>
```

Mobile 支持用户输入任意 `http://` 或 `https://` Server 地址，session token 默认存储在 WebView `localStorage`，默认有效期为 720 小时。

**影响**

使用局域网 HTTP 时，登录 token、聊天内容和审批信息可能被同网段攻击者窃听或篡改。

**整改建议**

1. 生产环境强制 HTTPS/WSS。
2. ATS 只对明确的本地开发地址放行。
3. 使用 iOS Keychain、Android Keystore 或 Tauri 安全存储保存 token。
4. 增加设备维度 session、远程吊销和更短的默认有效期。

### 3.5 Desktop/Mobile Tauri CSP 被关闭

**现状**

以下配置均为 `"csp": null`：

- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/mobile/src-tauri/tauri.conf.json`

Desktop WebView 可以调用文件读写、Patch 和 Shell Tauri command。

**影响**

如果 WebView 出现 XSS，恶意脚本可能绕过 React 交互层直接调用 Tauri command。当前 Rust command 只校验路径和命令模式，不验证一次性人工审批凭证。

**整改建议**

1. 配置严格 CSP。
2. 收紧 Tauri Capability。
3. 高风险 Rust command 接收并验证一次性审批票据。
4. 将批准状态绑定到具体工具、参数、工作区、用户和过期时间。

## 4. P2：中优先级风险

### 4.1 OAuth challenge 仅保存在单进程内存

**现状**

`apps/server/src/routes/auth.ts` 使用模块级 `Map` 保存 OAuth challenge。

**影响**

- Server 重启后正在进行的登录全部失效。
- 多实例部署时 callback 和轮询请求可能命中不同实例。
- challenge 接口没有明确的速率限制。

**整改建议**

- 迁移到 MariaDB 或 Redis。
- 使用一次性原子状态转换。
- 只保存必要上下文和敏感值 hash。
- 增加 IP、设备和账号维度限流。

### 4.2 第三方身份绑定链路未完整闭环

**现状**

服务端支持“已登录用户携带 bearer token 发起 challenge”进入绑定模式，但 `packages/api-client/src/index.ts` 的 `startFeishuChallenge()` 没有附加认证头，客户端也没有完整绑定入口。

**影响**

代码和数据模型看似支持多身份绑定，当前产品实际上只能完成普通登录。

**整改建议**

- 为 challenge 方法增加可选认证头。
- 在账号设置中增加绑定入口、冲突提示和解绑规则。
- 补充绑定与账号合并测试。

### 4.3 禁用用户后既有 session 仍有效

**现状**

`verifySession()` 只检查 session 状态和过期时间，不检查 `users.status`。

**影响**

管理员将用户设为非 active 后，用户仍可以使用未过期 session。

**整改建议**

- session 校验联表检查用户状态。
- 禁用用户时批量吊销其全部 session。

### 4.4 同一会话并发发送可能覆盖会话摘要

**现状**

Chat 请求先读取 `messageCount`，模型完成后再写入 `messageCount + 2`。两个客户端同时发送时可能读取相同旧值。

**影响**

- `messageCount` 丢增量。
- `lastMessagePreview` 和 `updatedAt` 采用 last-write-wins。
- 两次模型调用可能互相看不到对方刚写入的上下文。

**整改建议**

- 使用数据库原子增量。
- 引入 session version 乐观锁或单 session 运行队列。
- 明确一个 session 是否允许多个并发生成任务。

### 4.5 跨端 `message.stream-end` 早于数据库提交

**现状**

Assistant 最终文本先通过事件中心广播，随后才写入 `chat_messages` 和更新 `chat_sessions`。

**影响**

如果数据库事务失败，其他客户端已经显示最终回复，但刷新后消息不存在。

**整改建议**

- `delta` 可以实时广播。
- 最终 `stream-end` 和 `message.created` 应在事务成功后发送。
- 数据库失败时广播 `message.stream-error`。

### 4.6 Local Tool 结果没有核对来源设备

**现状**

Broker 的 pending request 保存了目标 `deviceId`，但 `complete()` 只按 `requestId` 完成；WebSocket 收到 `tool.result` 时没有把当前连接设备传给 Broker 校验。

**影响**

同一用户的其他设备在获得 request ID 后可能伪造执行结果。

**整改建议**

- 使用 `complete(result, sourceDeviceId)`。
- 强制 `pending.deviceId === sourceDeviceId`。
- 未完成 `device.hello` 的连接不得提交工具结果。

### 4.7 多实例部署不支持跨端事件和本地工具路由

**现状**

以下状态都保存在单进程内：

- `SessionEventHub`
- `DeviceRegistry`
- `LocalToolBroker`
- `ApprovalCoordinator`
- OAuth challenge

**影响**

水平扩容后，SSE、WebSocket、审批和工具调用可能分布在不同实例并失效。

**整改建议**

- 明确当前部署约束为单实例。
- 后续使用 Redis Pub/Sub、共享 pending store 和连接路由层。

### 4.8 敏感配置明文存储在 MariaDB

涉及：

- 飞书 `app_secret`
- Tavily API Key
- 模型 API Key

**整改建议**

- 使用 KMS、Keychain 或 Secret Manager。
- 数据库只保存密文或 secret reference。
- 控制数据库备份和日志访问权限。

## 5. P3：工程与维护风险

### 5.1 缺少自动化测试

当前仓库没有发现单元测试、集成测试或端到端测试。

建议优先覆盖：

1. OAuth challenge 状态机。
2. 身份冲突、session 过期和用户禁用。
3. 会话归属和越权访问。
4. 同 session 并发发送。
5. `ApprovalCoordinator` first-wins、超时和断连。
6. Local Tool Broker 设备校验。
7. 工作区路径穿越和敏感路径拒绝。
8. SSE 解析、重连、消息合并和去重。

### 5.2 缺少数据库 migration

当前 schema 位于 `apps/server/src/db/schema.ts`，但仓库没有正式 Drizzle migration、初始化 SQL 或 seed。

**影响**

- 新环境无法从仓库稳定重建数据库。
- schema 演进和回滚不可追踪。
- 集成测试难以自动准备数据库。

**建议**

增加：

```text
apps/server/drizzle.config.ts
apps/server/drizzle/
apps/server/src/db/migrate.ts
apps/server/src/db/seed.ts
```

### 5.3 数据库没有外键约束

用户、身份、session、message、model run 和 tool call 之间主要依赖应用层维护，异常事务或人工操作可能产生孤儿数据。

建议逐步补充 FK，并明确软删除策略与级联行为。

### 5.4 三端前端代码重复且已经发生能力漂移

当前主要文件体量：

- Desktop `App.tsx`：约 2700 行。
- Web `App.tsx`：约 1800 行。
- Mobile `App.tsx`：约 2400 行。

Desktop 和 Mobile 已接入跨端 SSE、联网搜索和审批，Web 仍是基础聊天实现。

建议抽取：

- Chat API 和 SSE parser。
- session store。
- 消息合并与去重。
- 模型选择和草稿会话逻辑。
- 工具运行卡片。
- 认证状态管理。

平台工程只保留布局、Tauri、本地工具和移动端差异。

### 5.5 Lint 当前失败

审查时执行 `pnpm lint` 发现：

- Desktop/Web 存在未使用的 `setIsCreatingSession`。
- Desktop/Web 登录页存在未使用的 `prepareChallenge`。
- Desktop 引用了未安装或未配置的 `react-hooks/exhaustive-deps` 规则。

### 5.6 全仓格式检查当前失败

审查时执行 `pnpm format:check`，多个源码和文档文件不符合当前 Prettier 配置。

### 5.7 部分配置和接口处于半废弃状态

示例：

- env 中保留 OpenAI、DeepSeek、GLM API Key，但 Chat 主路径读取数据库模型配置。
- `createSession()` 接收 `clientPlatform`，数据库未保存。
- `POST /api/sessions` 支持显式空会话，但当前客户端使用本地草稿和首消息懒创建。
- 登录组件保留未使用的 `prepareChallenge`。

建议删除失效入口，或明确其使用场景并增加测试。

## 6. 已有安全措施

当前代码并非没有安全设计，以下能力应保留并继续加强：

- session token 明文只返回客户端一次，数据库仅保存 SHA-256 hash。
- 模型列表和 Chat 请求均执行用户模型授权校验。
- 会话 API 按 `userId` 校验归属。
- Desktop 文件路径 canonicalize 后限制在工作区内。
- 拒绝 `.env`、`.ssh`、Keychains 等敏感路径。
- 文件、搜索和命令输出有大小限制。
- Desktop `Write`、`Edit`、`Bash` 已接入跨端审批。
- 审批采用 first-wins，并支持超时、断连和 run 结束清理。
- Web Search 需要服务端配置和单次用户开关双重启用。
- `ServerBash` 默认关闭。

## 7. 验证记录

审查期间执行结果：

| 命令                                                            | 结果                               |
| --------------------------------------------------------------- | ---------------------------------- |
| `pnpm typecheck`                                                | 通过                               |
| `pnpm build`                                                    | 通过                               |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 通过                               |
| `cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml`  | 通过                               |
| `pnpm lint`                                                     | 失败，存在前端 lint 错误           |
| `pnpm format:check`                                             | 失败，存在格式差异                 |
| `pnpm audit --prod --audit-level moderate`                      | 失败，包含 1 个高危和 1 个低危公告 |

## 8. 推荐整改顺序

### 第一阶段：安全止血

1. 关闭并重构 `ServerBash`。
2. 为 `AUTH_DEV_MOCK` 增加环境保护。
3. 升级 `drizzle-orm`。
4. 生产环境强制 HTTPS/WSS。
5. 启用 CSP 和安全 token 存储。

### 第二阶段：可靠性闭环

1. 增加数据库 migration 和 seed。
2. OAuth challenge 持久化。
3. 修复身份绑定。
4. 处理同 session 并发。
5. 调整跨端最终事件的提交顺序。
6. 校验本地工具结果来源设备。

### 第三阶段：工程治理

1. 建立核心测试集。
2. 抽取三端共享 Chat 核心。
3. 修复 lint 和 format。
4. 清理失效配置和半废弃接口。
5. 将安全审计、依赖审计和构建检查纳入 CI。
