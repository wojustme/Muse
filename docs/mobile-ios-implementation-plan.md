# Muse 移动端实现方案（iOS 先行，Android 复用）

本文档只依据当前代码整理，描述新增手机端的实施方案与落地范围。

## 1. 背景与结论

Muse 当时已有桌面客户端：

- `apps/desktop`：Tauri macOS 端，额外带本地工具桥 `LocalToolBridge`，可在已绑定 workspace 内执行文件/命令类工具。

需求是新增手机端，本期做 iOS、后期加 Android，具体诉求：

- 登录复用现有飞书 OAuth。
- **不要**工作区与本地 tools 调用能力（手机不注册设备、不挂目录）。
- 只用云端工具：内置只读工具 + 联网搜索 WebSearch。
- 支持"远程连接桌面端"：手机对话时借用某台在线桌面端的工具，AI 的文件/命令类工具调用经服务端转发到桌面执行，审批仍在桌面确认。

关键结论：**服务端已完整支持"手机借用桌面工具"，本期服务端零改动。**

- `POST /api/chat`（`apps/server/src/routes/chat.ts`）已接受 `localTools: { deviceId, workspaceId }`。
- `LocalToolBroker.execute()`（`apps/server/src/local-tools/local-tool-broker.ts`）按 `userId` 校验设备归属后，经 WebSocket 把工具请求转发到对应桌面设备；桌面 `LocalToolBridge` 对 write/dangerous 工具弹出审批。
- `GET /api/local-tools/devices`（`apps/server/src/routes/local-tools.ts`）已能列出当前用户在线设备及其 `workspaces[]`。
- `ClientPlatform` 枚举（`packages/shared/src/schemas/auth.ts`）已含 `ios` / `android`。

因此手机端要做的只是：登录后用设备选择器选一台在线桌面 + 工作区，把 `deviceId/workspaceId` 带进 `POST /api/chat`，其余转发/审批链路复用。

## 2. 技术选型

- 技术栈：**Tauri v2 + React 聊天 UI**。移动端保留纯云端对话，并支持借用桌面本地工具。
- 目录形态：**`apps/mobile` 规划为一个跨平台移动 app**，iOS/Android 共用同一份前端与同一个 `src-tauri`，用 `tauri ios init` / `tauri android init` 分别生成 `gen/apple` / `gen/android` 出包。不为两个平台建两个目录。
- 平台差异收敛点：仅 `src/platform/` 与 `src-tauri/gen/`；业务与 UI 代码零分叉。

## 3. 目录结构

```txt
apps/mobile/
  package.json            # @muse/mobile，一个 app 同时产 iOS + Android
  index.html
  vite.config.ts          # 端口 1440，复用 @muse/api-client alias
  tsconfig.json
  public/muse.svg
  src/
    main.tsx
    App.tsx               # 共享的移动端单列聊天壳（iOS/Android 通用）
    BrandMark.tsx
    styles.css            # 移动样式 + safe-area
    auth/
      client.ts           # platform 运行时判定为 "ios" | "android"
      LoginScreen.tsx      # 外部浏览器授权 + 轮询
    config/
      server-url.ts       # 可配服务端地址（真机不能用 127.0.0.1）
    remote/
      useRemoteDevices.ts # 借用桌面设备选择器
    platform/             # ← 跨平台差异唯一收敛点
      index.ts            # detectPlatform()
      capabilities.ts     # 平台开关：授权回跳、返回键、safe-area 等
  src-tauri/
    Cargo.toml            # crate muse-mobile
    tauri.conf.json       # 共享：identifier、插件、frontendDist、devUrl
    src/{lib.rs,main.rs}
    build.rs
    capabilities/default.json
    icons/                # 复用 desktop 现有 ios + android 图标
    gen/apple/            # tauri ios init 生成（本期）
    gen/android/          # tauri android init 生成（后期）
```

## 4. 实施内容

### 4.1 前端脚手架（基于 web fork）

- `package.json`（`@muse/mobile`）依赖对齐 desktop：`react`/`react-dom`、`react-markdown`、`remark-gfm`、`lucide-react`、`@tauri-apps/api`、`@tauri-apps/plugin-opener`、`@muse/api-client`、`@muse/shared`；devDeps 含 `@tauri-apps/cli`、`@vitejs/plugin-react`、`vite`、`@types/react(-dom)`。
- `vite.config.ts`：端口 1440，复用 desktop 的 `@muse/api-client` alias 与 `envPrefix: ["VITE_", "TAURI_"]`。
- `tsconfig.json` / `index.html` / `main.tsx` / `BrandMark.tsx` / `public/muse.svg`：从现有客户端复制。

### 4.2 跨平台抽象 `src/platform/`

- `index.ts`：`detectPlatform()` 依据 UA 返回 `"ios" | "android"`，供 api-client 的 `platform` 与 chat `client` 上下文使用。
- `capabilities.ts`：收敛平台差异（授权回跳方式、Android 物理返回键、safe-area 细节），UI/业务代码不出现平台分支。

### 4.3 移动端登录（飞书，外部浏览器 + 轮询）

- `src/auth/client.ts`：`createMuseApiClient({ platform: detectPlatform(), serverUrl: resolveServerUrl() })`，复用 `packages/api-client/src/index.ts` 全部能力（challenge/poll/me/logout/token 存 localStorage）。
- `src/auth/LoginScreen.tsx`：从 web fork 但简化——去掉 `window.open` / `postMessage`（WKWebView 内不适用），改为：点击 → `startFeishuChallenge()` → 用 `@tauri-apps/plugin-opener` 打开系统浏览器授权 → 轮询 `pollChallengeStatus(state)` 至 `authorized` 存 token。保留 Dev Login（`POST /api/auth/dev`）便于模拟器联调。
- 服务端回调页（`renderCallbackPage`）在外部浏览器里的 `postMessage`/`window.close` 会静默失败但不影响，App 侧靠轮询拿 token，用户手动切回 App。deep link 自动回跳留待后期，走 `platform/`。

### 4.4 可配置服务端地址 `src/config/server-url.ts`

- 服务端地址持久化到 localStorage，默认取 `VITE_SERVER_URL`；登录页/设置提供输入框（真机需填局域网 IP）。所有 fetch/SSE/轮询走该地址。

### 4.5 远程桌面设备选择器 `src/remote/useRemoteDevices.ts`

- 调用 `GET /api/local-tools/devices`，列出在线设备与其 `workspaces[]`；用户选一台设备 + 一个工作区后存入状态。
- 发送聊天时若已选：`POST /api/chat` 带 `localTools: { deviceId, workspaceId }`，并在 `client.localToolsHost` 回填 `status/deviceId/workspaceId/workspaceName`（`chat.ts` 已消费这些字段生成 system prompt）。未选中则为纯云端对话。
- AI 触发 Write/Edit/Bash 时审批弹窗出现在**桌面端**（现有 `LocalToolBridge` 行为），手机只看结果，符合"借用桌面工具"语义。

### 4.6 移动端 `App.tsx` + `styles.css`

- 使用**单列移动布局**（去掉多栏 grid、traffic lights、context-panel），保留：
  - SSE 打字机消费 `consumeChatStream`、Markdown 渲染、模型选择、会话列表/历史/删除/重命名、`buildClientContext`。
  - WebSearch 开关（对齐 desktop：`webSearchEnabled` 状态 + composer 里的 Search 按钮，请求带 `webSearch`）。
  - 远程设备选择器入口与 `localTools`/`localToolsHost` 拼装（对齐 desktop 的请求体组织）。
- 移除所有 `LocalToolBridge`/工作区/Tauri `invoke` 本地文件工具相关代码。
- `styles.css` 从 web 复制并做移动适配：`env(safe-area-inset-*)`、触控尺寸、软键盘处理。

### 4.7 Tauri 工程 `apps/mobile/src-tauri`

- `Cargo.toml`（crate `muse-mobile`）、`tauri.conf.json`（`identifier` 用独立值如 `com.wojustme.muse.mobile`，去桌面窗口尺寸约束，注册 `tauri-plugin-opener`，`frontendDist=../dist`，`devUrl=http://127.0.0.1:1440`）、`src/{lib.rs,main.rs}`、`build.rs`、`capabilities/default.json`。
- `lib.rs` 只保留移动端需要的最小 command 集（本期无本地文件工具，仅保留 `mobile_entry_point` 与 opener 插件），图标复用 `apps/desktop/src-tauri/icons/{ios,android}`。
- 本期 `tauri ios init` 生成 `gen/apple`（需 Xcode + Rust iOS target + CocoaPods）。

### 4.8 根 `package.json` 脚本

- 新增 `dev:mobile:web`（Vite）、`dev:mobile:ios`（`tauri ios dev`）、`ios:init`、`ios:build`；预留 `dev:mobile:android` / `android:build` 待后期。`pnpm-workspace.yaml` 已 glob `apps/*`，无需改。

## 5. 复用的现有实现

- `packages/api-client/src/index.ts`：登录/token/轮询全复用，仅传运行时 `platform` 与可配 `serverUrl`。
- `apps/mobile/src/App.tsx`：SSE 消费、Markdown、会话逻辑和移动端布局。
- `apps/desktop/src/App.tsx`：`webSearch` / `localTools` / `client.localToolsHost` 请求组织方式对齐。
- 服务端 `chat.ts`、`local-tool-broker.ts`、`local-tools.ts`、`device-registry.ts`、`auth.ts` **全部不改**。

## 6. 后期加 Android 的增量

`tauri android init`（生成 `gen/android`）→ `platform/capabilities.ts` 补 Android 回跳/返回键分支 → `package.json` 加 android 脚本 → 准备签名。前端与 Rust 逻辑不动。

## 7. 明确不做（本期）

- 不加工作区/本地 tools 桥；不做手机直连屏幕镜像/直接下发操作到桌面 UI；服务端不加新接口；不做 Android 出包。

## 8. 验证

1. 类型检查：`pnpm --filter @muse/mobile typecheck`。
2. iOS 模拟器：`AUTH_DEV_MOCK=true` 起服务端 → `pnpm dev:mobile:ios` → Dev Login → 发消息，确认云端只读工具 + WebSearch 开关生效、SSE 打字机正常。
3. 真机飞书登录：服务端 `HOST=0.0.0.0`、`PUBLIC_BASE_URL` 与手机端 serverUrl 填局域网 IP（飞书重定向白名单含该地址）→ 外部浏览器授权 → 轮询登录成功。
4. 远程桌面工具：桌面端登录并挂一个工作区 → 手机设备选择器看到该设备/工作区 → 让 AI 读/写文件 → 审批弹窗在桌面、结果回传手机。
5. 提交前扫描暂存 diff 是否含密钥。

## 9. 风险点

- iOS WKWebView 的 SSE `fetch` + ReadableStream 兼容性：新版 iOS 支持，异常则回退整段渲染。
- 外部浏览器授权后本期靠轮询、需用户手动切回 App（deep link 自动回跳留待后期）。
- 首次 `tauri ios init` 需 Xcode / CocoaPods / Rust iOS target 环境。
