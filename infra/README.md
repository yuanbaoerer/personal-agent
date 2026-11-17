# Cloudflare Durable Object 配置

这份配置是一个 `Assistant` Durable Object、SQLite 存储、PiHarness + Lifecycle、真实 `opencode-go` 模型，以及应用层 `pa_*` 业务表。它已通过 `wrangler deploy --dry-run`；本地 `wrangler dev` 已跑通 `/healthz`、`/ask`、飞书 webhook 受理/去重、`/admin/*` 鉴权和真实模型 Router → Worker 任务。2026-11-10 已真实部署到 Cloudflare（`personal-agent.3103148441.workers.dev`）；Worker 内 challenge 与 DO 请求为毫秒级，但飞书后台保存请求地址仍超时，尾流未见飞书请求。本地 Node 的长连接已连上 Feishu（`FEISHU_EVENT_MODE=long_connection`），但它不经过本 Worker；Worker 的真实飞书回调与对象驱逐恢复尚无证据。

## 前置条件

- Cloudflare 账号：真实部署需要；`deploy:dry-run` 和本地 `wrangler dev` 不需要登录。
- 模型：使用 OpenCode Go 的 `deepseek-v4.1-flash`。本地 `.dev.vars`/根 `.env` 或部署时的 Worker secret 提供 `OPENCODE_API_KEY`。
- Node 26 与仓库锁文件；不要单独升级 `agents` 或 Pi 的 minor 版本。

## 配置说明

`wrangler.jsonc` 的关键项：

| 配置 | 作用 |
| --- | --- |
| `main` | Worker 入口，导出 `Assistant` 类 |
| `compatibility_flags: ["nodejs_compat"]` | Pi/Agents SDK 需要 Node 兼容层 |
| `durable_objects.bindings` | 让 Worker 通过 `env.ASSISTANT` 访问对象 |
| `exports.Assistant` | 新建 SQLite-backed DO namespace；与旧 `migrations` 二选一 |
| `observability.enabled` | 打开 Workers Logs |
| `OPENCODE_API_KEY` secret | DO 内的 Pi AI provider 通过自定义 `authContext` 读取 |

`exports` 是 Cloudflare 当前推荐的声明式写法；Pi 文档里的 `migrations` 仍然可用，但一个 Worker 不能同时使用两种流程。新项目用本仓库的 `exports` 即可。

## 本地验证与部署

```bash
npm install
npm run deploy:dry-run      # 不创建资源，只打包和校验绑定
npm run dev:cloudflare      # 本地 workerd；SQLite 状态在 .wrangler/state
npx wrangler login          # 真实部署前
npm run deploy              # 首次部署会创建 DO namespace
```

本地开发前把 `OPENCODE_API_KEY`、飞书凭据、`OWNER_FEISHU_OPEN_ID` 和 `ADMIN_TOKEN` 放进 `infra/.dev.vars`（已被 `.gitignore` 忽略），或使用 `--var`/环境变量注入。`wrangler dev` 不需要 Cloudflare 登录；本地已实测：

```text
GET /healthz 200 -> {"ok":true,"runtime":"worker"}
POST /webhooks/feishu 200 -> {"status":"accepted"}
POST /webhooks/feishu 200 -> {"status":"duplicate"}
GET /admin/status (无 token) -> 401
GET /admin/status (Bearer ADMIN_TOKEN) -> 200
GET /ask?prompt=... (Bearer ADMIN_TOKEN) -> {"text":"DO_OK"}
```

`/ask` 请求包含一次真实模型调用；没有 `ADMIN_TOKEN` 时返回 503，token 不匹配返回 401。`/admin/status`、`/admin/recent` 与 `/admin/diagnostics` 使用同一鉴权。

部署后：

```bash
curl https://personal-agent.<你的子域>.workers.dev/healthz
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  'https://personal-agent.<你的子域>.workers.dev/ask?prompt=hello'
npx wrangler tail --config infra/wrangler.jsonc
npx wrangler deployments list --config infra/wrangler.jsonc
```

`/healthz` 不调用模型；`/ask` 会通过 RPC 进入 `Assistant.ask()`，再走 PiHarness 和 `opencode-go`。部署前先设置模型与鉴权 secret：

```bash
npx wrangler secret put OPENCODE_API_KEY --config infra/wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config infra/wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN --config infra/wrangler.jsonc
npx wrangler secret put GITHUB_ALLOWED_REPOS --config infra/wrangler.jsonc
```

## DO 语义

- **一个主人一个对象**：Worker 使用 `env.ASSISTANT.getByName("owner")`。以后应从已验证的主人 ID 派生这个 key，不能接受任意用户输入作为对象名。
- **SQLite**：PiHarness 把 `pi_*` 表写入该对象的 SQLite；应用通过 `DoDb` 把 `pa_*` 表写入同一个数据库。Worker 代码不得导入 `node:sqlite`；本地 Node 入口在 `apps/agent/src/storage/node.ts`。
- **模型认证**：`createModels({ authContext })` 从 `this.env.OPENCODE_API_KEY` 取 key，再注册 `opencodeGoProvider()`；不要依赖 Worker 里的 `process.env`。
- **单 alarm**：Lifecycle 拥有对象唯一的 alarm。应用维护、提醒触发和 Pi 唤醒都通过 Lifecycle jobs 调度；不要另外调用 `ctx.storage.setAlarm()`。
- **Webhook 与鉴权**：`/webhooks/feishu` 在 DO 内验签/解密并写 Inbox；URL challenge 由外层 Worker 先处理（含 Encrypt Key 加密的 challenge），避免冷启动 DO 拖过飞书 1 秒 deadline。`/ask`、`/admin/status`、`/admin/recent`、`/admin/diagnostics` 需要 `ADMIN_TOKEN`。未配置飞书凭据时 webhook 返回 503。
- **RPC 启动**：RPC 方法不会经过 `fetch()`，所以 `ask()` 先 `await this.lifecycle.start()`，再使用 PiHarness。
- **恢复**：对象被驱逐后，Lifecycle 从 SQLite 的 job 队列恢复；PiHarness 用 `wake()` 继续未完成工作。当前只验证了本地 workerd 的启动、webhook、真实模型任务和鉴权，未验证真实部署后的驱逐/恢复。

## 凭据

真实飞书接入时，用 Wrangler secret 或本地 `.dev.vars`，不要写入仓库：

```bash
npx wrangler secret put OPENCODE_API_KEY --config infra/wrangler.jsonc
npx wrangler secret put FEISHU_APP_ID --config infra/wrangler.jsonc
npx wrangler secret put FEISHU_APP_SECRET --config infra/wrangler.jsonc
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config infra/wrangler.jsonc
npx wrangler secret put FEISHU_ENCRYPT_KEY --config infra/wrangler.jsonc
npx wrangler secret put OWNER_FEISHU_OPEN_ID --config infra/wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config infra/wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN --config infra/wrangler.jsonc
npx wrangler secret put GITHUB_ALLOWED_REPOS --config infra/wrangler.jsonc
```

`ADMIN_TOKEN` 保护 `/ask` 和 `/admin/*`；没有它这些入口返回 503。`OPENCODE_API_KEY` 来自你的 omp 登录；如果账号或密钥轮换，需要同步更新 `.env`、`infra/.dev.vars` 和 Worker secret。

## 版本与回滚

- 锁定 `agents@0.33.0`、Pi `1.5.0`。Pi Durable 是实验性 API，`agents` 每个版本只支持一个 Pi minor。
- 会话在 Pi 1.5 写入后，降回 Pi 1.4 的运行时可能读不了；坏部署应向前修复，不要直接回滚旧版本。
- 修改 DO 类名或存储后端前先备份；`exports` 的 `deleted` tombstone 会永久删除 namespace 数据。

## 尚未完成

- 对象驱逐/恢复实验。
- Worker 的飞书回调稳定入口：`workers.dev` 在飞书后台保存请求地址时超时；需自定义域或 WS 桥接。长连接目前只在本地 Node 可用，不经过 Worker。之后补真实飞书回调与主动发信证据；MCP 灯桥接与真机仍待接。
- 40 条场景与真实模型重复运行报告；模型费用上限与密钥轮换流程。
