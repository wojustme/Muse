# Auth Implementation Plan

本文件是 Muse 第三方登录（飞书 / 钉钉 / 微信 / 支付宝）的实施计划。

数据表设计以 [`database-design.md`](./database-design.md) 为准，本文件不重复定义已有表，只：

1. 明确登录的整体模型与原则；
2. 复用并补充 `database-design.md` 中的 `users` / `auth_identities` / `auth_sessions` / `user_devices`；
3. 新增扫码登录所需的 `login_challenges` 表；
4. 定义服务端的 provider 适配层与传输层抽象；
5. 给出全端（macOS / iOS / Windows / Android）的登录传输矩阵；
6. 给出接入顺序与分阶段落地计划。

## 1. 目标与非目标

目标：

- 支持第三方登录，接入顺序：**飞书 → 钉钉 → 微信 → 支付宝**。
- 一个 Muse 账号可以绑定多个第三方身份（绑定模型，而非"一登录一账号"）。
- 同一套身份模型覆盖 macOS / iOS / Windows / Android。
- 登录态可按设备管理，可主动登出/吊销单个设备。

非目标（本阶段不做）：

- 账号"合并"工具。绑定模型下正常流程不需要合并，合并只作为早期误用的补救，后置。
- 长期记忆、跨账号数据迁移。
- 手机号/邮箱密码登录（第一阶段只做第三方登录 + 可选本地匿名用户）。

## 2. 核心模型：账号 ≠ 登录方式 ≠ 登录设备

三个维度正交，分别落在三张表：

```txt
users            一个"人"（Muse 内部账号，代理主键 uuid）
  ├─ auth_identities   他绑定的 N 个第三方身份（feishu / dingtalk / wechat / alipay）
  └─ auth_sessions     他在 M 个端上的登录态（macos / web / ios / windows / android）
```

关键约束（来自 `database-design.md`）：

- `auth_identities.identity_key` **UNIQUE**：一个外部身份只能属于一个 Muse 账号，从数据库层杜绝"一个微信挂两个账号"。
- 所有业务数据（`chat_sessions` / `chat_messages` / `model_runs` / `attachments`）只外键到 `users.id`，**绝不外键到登录方式或设备**。数据属于"人"，这是绑定/多端零成本的前提。

## 3. 身份锚点：unionId 优先

全端接入最大的坑：**同一个 provider 的网站应用与移动应用往往是不同的 AppID，`open_id` 各不相同**。若用 `open_id` 当锚点，同一个人从 Web 微信登录和从 iOS 微信登录会被认成两个人。

因此 `auth_identities.identity_key` 的构造规则统一为 **unionId 优先，open_id/user_id 兜底**：

```txt
provider    identity_key 构造                     锚点来源
--------    --------------------------------      -----------------------------
feishu      feishu:{tenant_key}:{union_id||user_id}   union_id（同主体跨应用一致）
dingtalk    dingtalk::{union_id||user_id}             unionId（同开放平台跨应用一致）
wechat      wechat::{union_id||open_id}               unionid（需同一开放平台主体下的多应用）
alipay      alipay::{user_id}                         user_id（支付宝无 unionId）
```

说明：

- `provider_union_id`、`provider_open_id`、`provider_tenant_id` 均按 `database-design.md` 原样存储，`identity_key` 只是业务层据此生成的稳定唯一键。
- 微信 unionId 依赖"同一微信开放平台主体下绑定同一 UnionID 机制"；网站应用与移动应用需挂在同一主体下才能共享 unionId。
- 飞书保留 `tenant_key`，避免同一外部用户在不同企业空间下身份歧义。

## 4. 登录/绑定判定流程

登录或绑定回调最终都归一为：服务端拿到 `(provider, identity_key, normalizedProfile)`，然后：

```txt
按 identity_key 查 auth_identities
├─ 命中
│    └─ 读出 user_id，更新 raw_profile / last_used_at，签发 session（登入）
└─ 未命中
     ├─ 当前请求已带有效登录态（已登录 A）
     │    └─【绑定】INSERT auth_identities(user_id = A, ...)，登录态不变
     └─ 当前请求未登录
          └─【新建】INSERT users + INSERT auth_identities，签发 session
```

绑定冲突（绑定新 provider 时该 identity_key 已属于账号 B）：

- 命中 UNIQUE 冲突后**不静默失败**。
- 若该身份已属于当前账号本身 → 幂等，忽略。
- 若属于另一个账号 B → 返回明确错误码（如 `IDENTITY_ALREADY_BOUND`），前端提示"该微信已绑定到另一账号"，引导用户走合并确认流（后置功能）。

## 5. 登录态与令牌机制

采用**不透明 session token（非 JWT）+ 服务端存储**：

- 登录成功时生成随机不透明 token，仅存其哈希到 `auth_sessions.refresh_token_hash`，明文只返回给客户端一次。
- 每次请求 `Authorization: Bearer <token>`，服务端哈希后查 `auth_sessions` 校验 `status = active` 且未过期。
- 登出 / 换设备 / 风控：将对应 `auth_sessions` 行 `status = revoked`、`revoked_at` 置位，即刻失效。

选择理由：

- 可**按设备主动吊销**单个登录态，JWT 无法做到。
- 无 JWT 密钥轮转、过期时钟等心智负担；客户端只存一个 token。

可替换性：

- 若日后改为 JWT + refresh token 或纯无状态 HMAC session，只影响本节的签发/校验逻辑与 `auth_sessions` 的读写，**不影响 `users` / `auth_identities` 与绑定流程**——身份模型是核心，令牌是可替换实现。

跨端令牌落地：

```txt
平台                 token 存放
------------------   ------------------------------------------
macOS / Windows      Tauri store / 系统钥匙串（Keychain / Credential Manager）
iOS / Android        Keychain / Keystore
Web                  httpOnly + Secure Cookie（防 XSS 窃取，非 localStorage）
```

服务端校验逻辑五端一致，只是取 token 的位置不同。

## 6. 新增表：login_challenges

`database-design.md` 未覆盖扫码登录的中间态。桌面端与移动端扫码登录无法在客户端直接接收 OAuth 回调（回调只落到服务端），需要"服务端中转 + 客户端轮询"，因此新增：

```sql
CREATE TABLE login_challenges (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_platform TEXT NOT NULL,
  code_verifier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id),
  session_token_hash TEXT,
  error_code TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_login_challenges_status ON login_challenges(status);
CREATE INDEX idx_login_challenges_expires_at ON login_challenges(expires_at);
```

字段说明：

```txt
state                一次扫码会话的随机 id，兼作 OAuth state 防 CSRF
provider             feishu / dingtalk / wechat / alipay
client_platform      macos / windows / ios / android（web 走重定向，不用此表）
code_verifier        PKCE 场景（飞书）本地生成的 verifier，回调换 token 时使用
status               pending / authorized / expired / consumed / failed
user_id              授权成功后回填
session_token_hash   授权成功后挂上；客户端轮询取走 token 后置 consumed
expires_at           通常 5~10 分钟，对齐各家授权码有效期（飞书 5 分钟 / 微信 10 分钟）
```

生命周期：

```txt
pending  --用户扫码授权、服务端回调换取身份成功-->  authorized
authorized --客户端轮询取走 token-->  consumed
pending  --超过 expires_at-->  expired
任意 --换 token 或身份获取失败-->  failed
```

## 7. 服务端抽象：provider 适配层 + 传输层

两条正交的抽象轴。加 provider 或加平台都只是"填空题"。

### 7.1 Provider 适配器（差异封死在这里）

```ts
type AuthProvider = "feishu" | "dingtalk" | "wechat" | "alipay";

interface ProviderToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  openId?: string;
  raw: unknown;
}

interface NormalizedProfile {
  providerUid: string; // provider 平台用户唯一 ID
  unionId?: string; // 有则优先作为锚点
  tenantId?: string; // 飞书 tenant_key 等
  displayName: string;
  avatarUrl?: string;
  raw: unknown;
}

interface AuthProviderAdapter {
  id: AuthProvider;
  buildAuthUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }): string;
  exchangeToken(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<ProviderToken>;
  fetchUserInfo(token: ProviderToken): Promise<NormalizedProfile>;
  buildIdentityKey(profile: NormalizedProfile): string; // 见第 3 节规则
}
```

各家差异全部封死在适配器内部，上层登录/绑定流程无感：

```txt
feishu     PKCE（code_challenge / code_verifier）；换 token 走 v3 端点
dingtalk   新版 OAuth2.0；header x-acs-dingtalk-access-token
wechat     无 PKCE；secret 换 token；扫码用 qrconnect / snsapi_login
alipay     无 PKCE；RSA2 密钥对签名；alipay.system.oauth.token + alipay.user.info.share
```

### 7.2 传输层（按平台分叉）

只有"发起授权 + 收回 code"这一小段按平台不同，之后 `exchangeToken` / `fetchUserInfo` / 判定流程五端复用：

```txt
平台                 传输方式                    结果如何回到客户端
------------------   -------------------------   -----------------------------------
Web                  标准 OAuth 重定向           浏览器 redirect_uri 直接回 Web 页
Desktop(mac/win)     扫码 / 系统浏览器           服务端中转 + 前端轮询 login_challenges
iOS / Android        原生 SDK 拉起 App 授权       SDK 回调 / Universal Link·App Link
                     （无 App 时降级扫码）        或同样走 login_challenges 轮询
```

### 7.3 扫码中转 + 轮询时序（Desktop / Mobile）

```txt
1. Client -> POST /api/auth/{provider}/challenge { platform }
   Server 生成 state（+ 飞书生成 PKCE），写 login_challenges(status=pending)
   返回 { state, authUrl }
2. Client 展示二维码（渲染 authUrl 或内嵌各家 JS）
3. 用户手机扫码并确认
4. Provider -> GET /api/auth/{provider}/callback?code&state
   Server：查 state -> exchangeToken -> fetchUserInfo -> buildIdentityKey
          -> 命中/绑定/新建（第 4 节）-> 生成 session token
          -> 更新 login_challenges(status=authorized, user_id, session_token_hash)
5. Client 轮询 GET /api/auth/challenge/status?state=...
   status=authorized 时取走 token，服务端置 consumed
   （加超时；state 一次性；防重放）
```

## 8. API 一览

在 `database-design.md` 第 7 节接口基础上细化 auth 部分：

```txt
POST   /api/auth/{provider}/challenge   发起扫码/授权，建 login_challenges，返回 authUrl（Desktop/Mobile）
GET    /api/auth/{provider}/callback    provider 回调：换 token、判定、签发 session、回填 challenge
GET    /api/auth/challenge/status       客户端轮询扫码结果（Desktop/Mobile）
POST   /api/auth/link/{provider}        已登录态下绑定新 provider（走同一 challenge/callback，携带当前 token）
GET    /api/auth/me                     当前用户 + 已绑定身份列表（聚合视图）
GET    /api/auth/identities             已绑定登录方式列表（设置页）
DELETE /api/auth/identities/:id         解绑某个身份（至少保留 1 个，防止锁死账号）
POST   /api/auth/logout                 吊销当前设备的 auth_sessions
GET    /api/auth/sessions               登录设备列表（多端管理）
DELETE /api/auth/sessions/:id           远程登出指定设备
```

约束：

- 解绑时校验"至少保留一个已绑定身份"，否则账号将无法再登录。
- `link/{provider}` 与登录复用同一套 provider 适配器与 challenge 流程，仅在 callback 判定分支走"绑定"而非"新建"。

## 9. shared 层类型

在 `packages/shared/src/schemas/` 新增 `auth.ts`，沿用现有 zod 风格（ISO datetime、`z.infer` 导出）：

```ts
import { z } from "zod";

export const authProviderSchema = z.enum([
  "feishu",
  "dingtalk",
  "wechat",
  "alipay",
]);

export const authIdentitySchema = z.object({
  id: z.string().min(1),
  provider: authProviderSchema,
  displayName: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});

export const authUserSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  identities: z.array(authIdentitySchema),
});

export type AuthProvider = z.infer<typeof authProviderSchema>;
export type AuthIdentity = z.infer<typeof authIdentitySchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
```

`AuthUser.identities` 是聚合视图，前端设置页直接渲染"已绑定登录方式"列表。

## 10. 配置项

在 `apps/server/src/config/env.ts` 的 `envSchema` 中新增（均 optional，未配置的 provider 在启动时不注册）：

```txt
# 会话
SESSION_TOKEN_TTL_HOURS        session 有效期（默认建议 720 = 30 天）

# 飞书
FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI

# 钉钉
DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_REDIRECT_URI

# 微信（企业资质后）
WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_REDIRECT_URI

# 支付宝（企业资质后）
ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY / ALIPAY_REDIRECT_URI
```

各 provider 的资质与回调前置条件：

```txt
provider    主体资质        回调域名           凭证机制         PKCE
--------    ------------    ---------------    -------------    ----
feishu      相对宽松        可 deep link/域名  secret           支持
dingtalk    个人可接        填 redirect_uri    secret           不支持
wechat      必须企业        必须已备案域名     secret           不支持
alipay      企业/个体户     登记真实域名       RSA2 密钥对签名  不支持
```

## 11. 分阶段落地顺序

按 "provider × 平台" 里最省事的组合先跑通，验证两条抽象轴都干净：

```txt
P1a  飞书 × macOS 桌面
     - 引入 drizzle + better-sqlite3，建 users / auth_identities / auth_sessions
       / user_devices / login_challenges
     - shared 新增 auth.ts
     - 实现 provider 适配器接口 + 飞书适配器
     - 实现 challenge / callback / status / me / logout 路由
     - server 加校验 Authorization 的 hook，保护 /api/chat 与 sessions
     - 桌面端登录页（展示二维码 + 轮询）+ token 存储 + 请求携带 token
     - 全部身份模型与绑定流程在此阶段一次搭好

P2   钉钉（× Desktop / Mobile 复用）
     - 只新增钉钉适配器 + provider 枚举值，不动表结构与绑定流程

P3   微信（需企业资质）
     - 新增微信适配器；移动端接入时落实 unionId 锚点与移动应用 AppID

P4   支付宝（需企业资质 + RSA2 签名）
     - 新增支付宝适配器，签名逻辑封在适配器内部
```

移动端（iOS / Android）与 Windows 在对应 provider 阶段按传输矩阵接入原生 SDK / 系统浏览器分支，不改身份模型。

## 12. 验收标准

- P1a：桌面端可用飞书扫码登录，登录后 `/api/chat`、`/api/sessions` 校验通过；重启 App 保持登录态；可登出。
- 绑定：已登录账号可在设置页绑定第二个 provider，绑定后两种登录方式均登入同一账号、看到同一份 chat 历史。
- 冲突：绑定一个已属于其他账号的身份时，返回明确错误并提示，不静默失败、不自动合并。
- 多端：同一账号可在多个端同时登录，设置页可见设备列表并能远程登出单个设备。
- 隔离：不同账号的 `chat_sessions` / `chat_messages` 严格按 `user_id` 隔离。

## 13. 安全注意事项

- session token、refresh token 只存哈希，明文不落库；第三方 access/refresh token 若需保存必须加密（对齐 `database-design.md`）。
- `state` 一次性、带过期，防 CSRF 与重放；飞书启用 PKCE。
- 绑定操作必须在已登录态下发起（携带有效 token），防止把他人身份挂到自己账号。
- 合并（若日后实现）必须"用户主动发起 + 双向证明所有权"，禁止基于"猜测同一人"自动合并。
- 解绑保留至少一个身份，避免账号被锁死。
</content>
</invoke>
