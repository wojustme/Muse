# MariaDB Migration Plan

目标：把 Muse 后端持久化统一迁移到 MariaDB，去掉 SQLite 依赖、SQLite 建表逻辑，以及当前仍然存在的 mock / 非持久化 session 与 chat 逻辑。

当前本地 MariaDB 实例：

```txt
user=muse
password=muse
database=muse_db
```

## 0. 当前代码盘点与迁移结论

本节基于当前代码重新梳理，用来指导后续实际改造。

### 0.1 当前已经落 SQLite 的状态

当前后端只有 `apps/server/src/db/client.ts` 和 `apps/server/src/db/schema.ts` 负责数据库接入与 schema 定义：

- `client.ts` 使用 `better-sqlite3`、`drizzle-orm/better-sqlite3`、`DATABASE_PATH`。
- `schema.ts` 使用 `drizzle-orm/sqlite-core`、`sqliteTable`、`text`、`CREATE_TABLES_SQL`。
- `server.ts` 启动时直接调用 `initDatabase()`，由应用进程执行 SQLite DDL。

目前真正持久化的表只有四张：

```txt
users
auth_identities
auth_sessions
login_challenges
```

这些表支撑当前飞书 OAuth / Dev Login / bearer session 校验链路：

- `/api/auth/dev` 会创建或更新 `users`、`auth_identities`，再写入 `auth_sessions`。
- `/api/auth/:provider/challenge` 会写入 `login_challenges`。
- `/api/auth/:provider/callback` 会读取并更新 `login_challenges`，调用 `resolveIdentity()` 写用户和身份，再调用 `createSession()` 写 session。
- `/api/auth/challenge/status` 会读取 challenge，授权成功后把 challenge 标记为 `consumed`。
- `requireAuth` / `optionalAuth` 通过 `auth_sessions.token_hash` 校验登录态。

### 0.2 当前仍未持久化或只是静态占位的状态

下面这些不是 SQLite，只是临时实现，但迁移 MariaDB 时也应该一起收敛为数据库状态：

- `apps/server/src/routes/sessions.ts`
  - `GET /api/sessions` 固定返回空数组。
  - `POST /api/sessions` 只返回 `randomUUID()` 生成的临时对象，不落库。
- `apps/server/src/routes/chat.ts`
  - `POST /api/chat` 不保存用户消息。
  - 不保存 assistant 回复。
  - 不保存模型调用记录。
  - 当前只返回一条 placeholder 文本。
- `apps/server/src/routes/models.ts`
  - 模型列表是代码里的静态数组。
  - 尚未接入 `model_providers` / `model_catalog`。
- `packages/model-router/src/model-router.ts`
  - 内部用 `Map<string, ModelProvider>` 做运行期 provider registry。
  - 这是代码级路由表，不是用户数据存储；不需要迁入 MariaDB，但后续应由 DB 中启用的 provider/model 配置来驱动注册或选择。

### 0.3 迁移目标

迁移完成后，后端持久化层只保留 MariaDB：

```txt
Fastify routes/auth/services
  -> Drizzle ORM
  -> mysql2 pool
  -> MariaDB muse_db
```

本地连接建议统一用：

```txt
DATABASE_URL=mysql://muse:muse@127.0.0.1:3306/muse_db
```

需要删除或停用：

```txt
better-sqlite3
@types/better-sqlite3
DATABASE_PATH
CREATE_TABLES_SQL
drizzle-orm/better-sqlite3
drizzle-orm/sqlite-core
sqliteTable
应用启动自动执行 SQLite DDL
```

### 0.4 第一阶段必须落 MariaDB 的表

为了既迁移现有 auth，又补齐当前 session/chat/model 的非持久化缺口，第一阶段建议直接创建这些表：

```txt
users
auth_identities
auth_sessions
login_challenges
model_providers
model_catalog
chat_sessions
chat_messages
model_runs
attachments
```

其中前四张是现有 auth 功能的等价迁移；后六张是把当前静态/临时实现变成真实持久化。

### 0.5 推荐实施顺序

建议分三步做，避免一次性改完后定位困难：

1. MariaDB 基础设施
   - 加 `mysql2`。
   - 改 `env.ts`：移除 `DATABASE_PATH`，新增 `DATABASE_URL`。
   - 改 `db/client.ts`：用 `mysql2/promise` pool + `drizzle-orm/mysql2`。
   - 改 `db/schema.ts`：从 `sqlite-core` 切到 `mysql-core`。
   - 新增 `db:migrate` 或 `db:init` 脚本创建 MariaDB 表。

2. Auth 等价迁移
   - 先只保证 `users` / `auth_identities` / `auth_sessions` / `login_challenges` 在 MariaDB 下行为一致。
   - 覆盖 Dev Login、飞书 challenge、callback、轮询、`/auth/me`、logout。
   - 保持 session token 只在 `auth_sessions` 存 hash 的设计。

3. 补齐业务持久化
   - `sessions.ts` 改为读写 `chat_sessions`。
   - `chat.ts` 改为写入 user message、assistant message 和 `model_runs`。
   - `models.ts` 改为读取 `model_providers` + `model_catalog`。
   - 当前 placeholder assistant 回复可以短期保留，但必须落库。

### 0.6 关键风险

- MariaDB `JSON` 兼容性取决于版本；第一版建议元数据字段用 `LONGTEXT` 存 JSON 字符串，应用层校验。
- 当前 shared schema 使用 ISO datetime string；第一版建议 MariaDB 时间字段先用 `VARCHAR(32)`，降低接口转换成本。
- `login_challenges.metadata` 当前短暂保存明文 `sessionToken` 供轮询取走；迁移时可以先保持行为一致，但后续应改成一次性 exchange code 或加密 metadata。
- 应用启动时自动建表不适合长期保留；迁移到 MariaDB 后建议显式脚本 `pnpm --filter @muse/server db:migrate`。

## 1. 当前代码现状

### 1.1 已经使用 SQLite 的部分

当前后端持久化集中在 `apps/server/src/db/`：

```txt
apps/server/src/db/client.ts
apps/server/src/db/schema.ts
```

`client.ts` 当前使用：

```txt
better-sqlite3
drizzle-orm/better-sqlite3
DATABASE_PATH
```

`schema.ts` 当前使用：

```txt
drizzle-orm/sqlite-core
sqliteTable
text
index
uniqueIndex
CREATE_TABLES_SQL
```

当前 SQLite 表：

```txt
users
auth_identities
auth_sessions
login_challenges
```

这些表支撑飞书 OAuth 登录、session token 校验、登录 challenge 轮询。

### 1.2 仍然是 mock / 非持久化的部分

`apps/server/src/routes/sessions.ts`：

```txt
GET /api/sessions  直接返回 []
POST /api/sessions 只返回 randomUUID 生成的临时 session
```

`apps/server/src/routes/chat.ts`：

```txt
POST /api/chat 不落库
用户消息不保存
助手回复不保存
model_runs 不保存
只返回一条 placeholder assistant message
```

`apps/server/src/routes/models.ts`：

```txt
模型列表是代码里的静态数组
未接 model_providers / model_catalog 表
```

### 1.3 当前需要移除的 SQLite 相关依赖与配置

`apps/server/package.json`：

```txt
better-sqlite3
@types/better-sqlite3
```

`apps/server/src/config/env.ts`：

```txt
DATABASE_PATH
```

`apps/server/.env.example`：

```txt
DATABASE_PATH=./muse.db
```

`pnpm-lock.yaml` 中也会随依赖调整移除对应 SQLite 依赖。

## 2. 目标架构

迁移后后端只使用 MariaDB：

```txt
Fastify Server
  -> Drizzle ORM
  -> MariaDB driver
  -> muse_db
```

推荐连接配置：

```txt
DATABASE_URL=mysql://muse:muse@127.0.0.1:3306/muse_db
```

建议仍保留 Drizzle ORM，不换 ORM：

- 现在代码已经围绕 Drizzle query builder 写了 auth 逻辑。
- 迁移主要是 dialect 从 SQLite 换到 MySQL/MariaDB。
- 后续可以用 Drizzle migrations 管理正式 schema。

## 3. 目标表设计

迁移到 MariaDB 后，第一阶段应完整落以下表：

```txt
users
auth_identities
auth_sessions
login_challenges
model_providers
model_catalog
chat_sessions
chat_messages
model_runs
attachments
```

后续 Agent 阶段再加：

```txt
agent_runs
agent_steps
tool_calls
```

表设计以 `docs/database-design.md` 为准，但要把 SQLite DDL 转换为 MariaDB DDL：

```txt
TEXT JSON 字段         -> JSON 或 LONGTEXT
INTEGER boolean       -> TINYINT(1)
ISO datetime string   -> DATETIME(3) 或 VARCHAR(32)
ON DELETE CASCADE     -> 保留
uniqueIndex/index     -> MySQL index
```

建议第一版为了和 shared schema 保持一致，时间字段可以继续用 `VARCHAR(32)` 存 ISO 字符串；如果想更数据库原生，统一改成 `DATETIME(3)`，由接口层序列化为 ISO。

## 4. 迁移步骤

### Phase 1: 切换数据库驱动与配置

修改 `apps/server/package.json`：

```txt
remove:
  better-sqlite3
  @types/better-sqlite3

add:
  mysql2
```

Drizzle 仍保留：

```txt
drizzle-orm
```

修改环境变量：

```txt
DATABASE_URL=mysql://muse:muse@127.0.0.1:3306/muse_db
```

需要改动：

```txt
apps/server/src/config/env.ts
apps/server/.env.example
apps/server/src/db/client.ts
```

目标 `client.ts`：

```txt
使用 mysql2/promise 创建 pool
使用 drizzle-orm/mysql2 初始化 db
启动时不再 sqlite.exec(CREATE_TABLES_SQL)
```

### Phase 2: 重写 Drizzle schema 为 MySQL dialect

把 `apps/server/src/db/schema.ts` 从：

```txt
drizzle-orm/sqlite-core
sqliteTable
```

迁移到：

```txt
drizzle-orm/mysql-core
mysqlTable
varchar
text
longtext
tinyint
datetime
index
uniqueIndex
```

同时删除：

```txt
CREATE_TABLES_SQL
```

建议不要继续在应用启动时自动建表，改为迁移脚本：

```txt
apps/server/src/db/migrations/
```

或者先保留一个明确的初始化命令：

```txt
pnpm --filter @muse/server db:init
```

### Phase 3: 增加 MariaDB 初始化 SQL / migration

新增第一版 migration，创建：

```txt
users
auth_identities
auth_sessions
login_challenges
model_providers
model_catalog
chat_sessions
chat_messages
model_runs
attachments
```

并插入默认模型数据：

```txt
openai / gpt-4o-mini
deepseek / deepseek-chat
glm / glm-4-flash
```

推荐新增脚本：

```txt
apps/server/src/db/migrate.ts
```

package script：

```json
{
  "db:migrate": "tsx src/db/migrate.ts"
}
```

### Phase 4: 改造 auth 持久化

需要验证并适配 MariaDB 的 query 行为：

```txt
apps/server/src/auth/identity.ts
apps/server/src/auth/session.ts
apps/server/src/auth/challenge.ts
apps/server/src/routes/auth.ts
```

重点检查：

- `insert().values(...)` 返回值是否不依赖 SQLite 特性。
- `select().limit(1)` 行为保持一致。
- `update().where(...)` 行为保持一致。
- 时间字段格式统一。
- JSON metadata 读写统一。

当前 auth 逻辑已经使用 token hash，没有把 session token 明文存 `auth_sessions`，这个设计可以保留。

注意：`login_challenges.metadata` 当前会短暂保存明文 `sessionToken`，MariaDB 迁移时不建议扩大这个风险。可以保持 TTL 很短，后续再改成一次性 exchange code 或加密 metadata。

### Phase 5: 实现 session 持久化

改造：

```txt
apps/server/src/routes/sessions.ts
```

目标：

```txt
GET /api/sessions
  按 request.userId 查询 chat_sessions
  archived = false
  order by pinned desc, last_message_at desc, updated_at desc

POST /api/sessions
  插入 chat_sessions
  user_id = request.userId
  title = "New chat"
  default_model_id 可为空或使用默认模型
```

新增：

```txt
GET /api/sessions/:id
  校验 session.user_id = request.userId
  返回 session + messages
```

### Phase 6: 实现 chat/message/model_runs 持久化

改造：

```txt
apps/server/src/routes/chat.ts
```

目标流程：

```txt
1. 校验 session 属于当前 user
2. 写入 user message 到 chat_messages
3. 创建 model_runs，状态 pending/streaming
4. 调用模型或保留当前 placeholder
5. 写入 assistant message 到 chat_messages
6. 更新 model_runs.response_message_id / usage / status
7. 更新 chat_sessions.last_message_at / updated_at
8. 返回 assistant message
```

第一步可以继续保留 placeholder AI 回复，但必须落库。

### Phase 7: 模型目录持久化

改造：

```txt
apps/server/src/routes/models.ts
```

从静态数组改为查询：

```txt
model_providers
model_catalog
```

同时保留 env API key 只在服务端配置中读取，不写入前端。

### Phase 8: 清理 SQLite 与内存/mock

最终删除：

```txt
better-sqlite3
@types/better-sqlite3
DATABASE_PATH
CREATE_TABLES_SQL
drizzle-orm/better-sqlite3
drizzle-orm/sqlite-core
sqliteTable
```

确保没有：

```txt
return { sessions: [] }
randomUUID 临时 session 但不落库
chat response 不落库
模型静态数组作为唯一来源
```

## 5. 验证清单

迁移完成后执行：

```txt
pnpm install
pnpm format:check
pnpm --filter @muse/server typecheck
pnpm --filter @muse/server lint
pnpm --filter @muse/server build
```

本地联调：

```txt
pnpm --filter @muse/server db:migrate
pnpm --filter @muse/server dev
```

验证接口：

```txt
GET  /health
GET  /api/models
POST /api/auth/feishu/challenge
GET  /api/auth/challenge/status
GET  /api/auth/me
GET  /api/sessions
POST /api/sessions
POST /api/chat
```

数据库检查：

```sql
SHOW TABLES;
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM auth_sessions;
SELECT COUNT(*) FROM chat_sessions;
SELECT COUNT(*) FROM chat_messages;
SELECT COUNT(*) FROM model_runs;
```

## 6. 风险点

### 6.1 MariaDB 与 MySQL JSON 差异

MariaDB 的 `JSON` 本质上是 `LONGTEXT + CHECK`，不同版本支持程度有差异。第一版可以使用 `LONGTEXT` 存 JSON 字符串，应用层用 Zod 校验。

### 6.2 时间字段

当前 shared schema 使用 ISO datetime string。MariaDB 如果使用 `DATETIME(3)`，接口层需要转换为 ISO string。为了减少迁移风险，第一版可以继续用 `VARCHAR(32)`。

### 6.3 登录 challenge 明文 token

当前 `login_challenges.metadata` 会短暂保存明文 session token。迁移 MariaDB 时先保持行为一致，但需要后续优化：

```txt
方案 A：metadata 加密
方案 B：challenge 表只保存一次性 exchange code
方案 C：服务端内存短 TTL cache 保存明文 token，数据库只存 hash
```

如果目标是“所有状态都进 MariaDB”，推荐方案 B。

### 6.4 本地桌面端 token

桌面端当前 token 存在 `localStorage`。这和数据库迁移无直接关系，但正式版本建议迁移到 macOS Keychain / Tauri secure store。

## 7. 推荐落地顺序

建议分两个 PR / commit 做：

### Commit 1: MariaDB 基础设施

```txt
feat(server): migrate persistence layer to MariaDB

- replace better-sqlite3 with mysql2
- switch Drizzle schema to mysql-core
- add DATABASE_URL config
- add MariaDB migration/init script
- create auth tables in MariaDB
```

### Commit 2: Chat 持久化

```txt
feat(server): persist chat sessions and messages in MariaDB

- add chat_sessions, chat_messages, model_runs, model_catalog tables
- persist session creation and history lookup
- persist user and assistant messages
- load models from database
```

这样第一步能先保证 auth 不坏，第二步再把 chat/session 从 mock 补齐。
