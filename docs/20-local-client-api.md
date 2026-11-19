# 20 · 本地 Client API、CLI 与 TUI（PA-17/PA-18/PA-19 E1）

> 2026-11-19。状态：本地 Node 的 **E1 最小实现**。远程多设备、TLS 终止、SSE/WebSocket 推送、Windows Terminal/ConPTY 实机验收仍 pending；本文不把当前实现称为稳定跨平台客户端。

## 1. 架构边界

```text
pa CLI  ─┐
pa TUI  ─┼── authenticated /api/v1 ── ClientApiService ── TaskService / ActionService / Memory / Reminder
future  ─┘                                      │
                                                └── 同一个 Store/Coordinator，不另建状态
```

- CLI/TUI 只使用 HTTP API 和 TypeScript SDK，**不直接打开 SQLite**。
- 所有写操作仍经过 TaskService/ActionService 的 owner、revision、Mandate、审批与执行前复核。
- API 只有一个 owner；不做多租户。
- API 创建任务时复用 owner 最近的已绑定会话，因此结果/审批仍能通过真实渠道投递；不会伪造无法投递的 `api` 会话。

实现位置：

| 层 | 文件 |
| --- | --- |
| API 路由/鉴权 | `apps/agent/src/client-api.ts` |
| Token 表 | `apps/agent/src/storage/client-tokens.ts`、schema v14/v16（v15 稳定 audit seq，v16 token 过期） |
| SDK | `apps/agent/src/client/sdk.ts` |
| CLI | `apps/agent/src/cli.ts`、`bin/pa` |
| TUI | `apps/agent/src/tui.ts` |
| HTTP mount | `apps/agent/src/server.ts`（`/api/v1/*`） |

## 2. 鉴权

### 2.1 admin bootstrap

`ADMIN_TOKEN` 用于本地首次管理：

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/api/v1/health
```

admin token 等同全部 scope，且只能通过 Bearer header 发送；**不接受 URL query token**。

### 2.2 设备 token

```bash
npm run pa -- tokens create --name laptop --scopes read,write --ttl-days 30
# 输出一次 pa_...；服务端只保存 SHA-256 hash；到期返回 401
export PA_API_TOKEN=pa_...
```

| scope | 权限 |
| --- | --- |
| `read` | health/status/tasks/approvals/memories/reminders/events |
| `write` | 创建/取消/修订/补充任务，保存/删除记忆，创建/取消提醒 |
| `approve` | approve/deny 待审批 Action |
| admin token | 全部 + token 管理 |

- token 可撤销（`pa tokens revoke <id>`），撤销立即生效。
- 可选 `ttlDays`（1–365）；到期返回 401，`expiresAt` 在 token 列表可见。
- 每个 credential 固定窗口 600 请求/分钟；超限返回 429 `rate_limited`。该限制是进程内保护，不是分布式配额。
- 默认 token scope 为 `read`；CLI 日常本地可继续用 `ADMIN_TOKEN`，远程设备必须用窄 scope token。
- 当前没有 HTTPS/设备配对/mTLS；远程使用必须放在 TLS 反向代理后，不能把 API 明文暴露到 LAN/公网。`HOST=0.0.0.0` 只应配合防火墙/TLS 使用。
- 日志只记录 method/path/status；不记录 token、body 或 query string。

## 3. HTTP 契约

API 前缀 `/api/v1`，请求/响应 JSON，`cache-control: no-store`。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/health` | 鉴权与 API 版本 |
| GET | `/status` | diagnostics + usage |
| GET | `/diagnostics` | 过期 Assignment、unknown Action、outbox/confirmations |
| GET | `/usage` | Task/Action/Effect/Outbox 聚合；token 未采集 |
| GET | `/tasks?status=&limit=` | owner 任务列表 |
| POST | `/tasks` | 创建任务；必须带 `Idempotency-Key` |
| GET | `/tasks/:id` | task + assignments + actions + inputs |
| POST | `/tasks/:id/cancel` | 取消 |
| POST | `/tasks/:id/revise` | 修改；必须带 `expectedRevision` |
| POST | `/tasks/:id/supplement` | 补充；必须带 `Idempotency-Key` |
| GET | `/approvals` | 当前 proposed Actions |
| GET | `/approvals/:id` | 单个 Action 的不可变参数/绑定 |
| POST | `/approvals/:id/approve` | `{nonce,argsHash,taskRevision}` |
| POST | `/approvals/:id/deny` | 同上 |
| GET/POST | `/memories` | 列表 / 保存 |
| DELETE | `/memories/:key?project=` | 软删除 |
| GET/POST | `/reminders` | 列表 / 创建 |
| DELETE | `/reminders/:id` | 取消 |
| GET | `/events?after=&limit=` | 可重放事件游标 |
| GET | `/events/stream?after=` | SSE 推送；支持 `Last-Event-ID`、心跳与 1s replay |
| GET/POST | `/tokens` | admin：列表 / 创建 |
| DELETE | `/tokens/:id` | admin：撤销 |

### 3.1 幂等与并发

- 创建任务的 `Idempotency-Key` 进入 source key；相同 key + 不同目标返回 `409 idempotency_conflict`。
- 补充输入把 `api:<key>` 写成 `sourceInboxId`；相同 key + 不同文本冲突。
- 修订必须带当前 `expectedRevision`，旧 revision 返回 409；不会用离线状态覆盖新 revision。
- approve/deny 必须同时提交 nonce、argsHash、taskRevision；API 再次与 Action 行核对后调用 ActionService。

### 3.2 事件

提供两个入口：

```bash
pa events --after 0 --limit 100          # 一次性 replay
pa events --after 0 --follow             # SSE 持续订阅
```

- `GET /events` 返回 `events[]` 与 `nextCursor`。
- `GET /events/stream` 是 `text/event-stream`：每个事件带 `id: <cursor>`、`event: audit`、`data: <json>`；支持 `Last-Event-ID`，每秒 replay 新事件，15 秒心跳；服务端最多 8 条并发流。
- 事件只包含 event/subject/trace/time，不返回 goal、消息正文或 Action args。
- SDK `streamEvents({after,signal})` 与 CLI `--follow` 已接 SSE；断线后调用方以最后 cursor 重连。浏览器 `EventSource` 不能设置 Bearer header，当前 SDK/CLI 使用 fetch stream。

## 4. CLI

```bash
npm run pa -- status
npm run pa -- tasks
npm run pa -- task <id>
npm run pa -- create "检查仓库" --criteria "带来源链接" --request-id req-1
npm run pa -- supplement <id> "补充成本限制" --request-id input-1
npm run pa -- approvals
npm run pa -- approve <action-id> --yes
npm run pa -- events --after 0
npm run pa -- memory save city Shanghai --project alpha
npm run pa -- reminders create "喝水" --at 2026-11-19T10:00:00Z --timezone Asia/Shanghai
npm run pa -- tokens create --name laptop --scopes read,write
```

`npm link` 后可执行 `pa ...`。`pa approve` 必须先显示参数/nonce/binding，再要求 `--yes`；没有 `--yes` 不发送写请求。

环境：

```bash
PA_API_URL=http://127.0.0.1:8787
PA_API_TOKEN=pa_...   # 未设置时回退 ADMIN_TOKEN
```

## 5. TUI

```bash
npm run pa -- tui
```

按键：

| 键 | 作用 |
| --- | --- |
| `j`/`k` 或上下 | 选择 |
| `tab` | Tasks → Approvals → Reminders → Tasks |
| `n` + 文本 + Enter + ISO 到期时间 | 创建提醒（本地时区） |
| `x` + `y` | 取消选中提醒 |
| `s` + 文本 + Enter | 增补任务输入 |
| `v` + 新目标 + Enter | 修订选中任务目标（带当前 revision） |
| `c` + `y` | 取消选中任务 |
| `a` / `d` + `y` | 批准 / 拒绝选中 Action |
| `r` | 刷新 |
| `q` / Ctrl-C | 退出并恢复终端 |

TUI 只通过 Client API，每 2 秒刷新；显示任务状态、目标、Action 参数/nonce/binding、提醒状态、unknown/confirm/effects 计数。输入提示固定在最后一行，短终端不会遮住；非 TTY 直接报错。没有动画、鼠标或后台常驻。

## 6. 验证与边界

已执行：

- `apps/agent/test/client-api.test.ts`：auth/scope/revocation、token 过期、速率限制、任务幂等、修订冲突、补充幂等、审批绑定、并发审批单次消费、错误 owner。
- `apps/agent/test/client-http.test.ts`：真实 HTTP mount、Bearer 鉴权、token 不进入日志。
- `apps/agent/test/cli.test.ts`：CLI/SDK header/idempotency、SSE 数据帧、错误映射、approve 必须有 `--yes`。
- `apps/agent/test/tui.test.ts`：帧渲染、任务/审批绑定、增补/提醒输入、短终端底部提示。
- 本地 Node PTY smoke：`pa tui` 进入 alternate screen 并由 `q` 干净退出。
- 全量 `npm test`：267 个确定性测试通过（2026-11-19）。

仍 pending：

- 远程 TLS/设备配对、token 轮换 UI；当前速率限制是单进程内存窗口；
- SSE 断线重连/重放上限的跨进程实测；WebSocket 未实现；
- macOS Terminal/iTerm2、Windows Terminal/ConPTY 的真实键盘/窄屏验收；
- CLI/TUI 的 E3 真实操作证据；TUI 已支持任务取消/审批/增补/修订目标和提醒创建/取消，仍不覆盖提醒内容编辑。
