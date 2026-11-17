# 06 · 下一步待办与操作手册

> **2026-11-14 下一阶段索引**：PA-01～PA-16 Issue 为后续执行任务的权威清单，优先 PA-01/PA-02/PA-03。详见 [07 · 长期路线图](07-long-term-roadmap.md)、[08 · 评测标准](08-evaluation.md)、[09 · 开源复用](09-open-source-plan.md) 和 [ADR-0001](adr/0001-runtime-hosting.md)。本文件仍保存截至当前的操作手册与实际环境限制。


> 2026-11-10。Week 2–4 的独立代码已落地并通过本地确定性测试；真实飞书 p2p 收发已通过本地 Node（webhook + 长连接）验证；Cloudflare Worker 已真实部署，飞书侧稳定入口与对象驱逐恢复仍待完成。

## 1. 当前基线

| 已具备 | 不在基线内 |
| --- | --- |
| `pa_*` schema、Inbox 去重/恢复、Outbox 重试/unknown/核对 | 对象驱逐恢复 |
| 真实 Cloudflare Worker 部署（`workers.dev`） | Worker 的飞书回调稳定入口（自定义域；长连接在本地 Node 已可用） |
| 真实飞书 p2p `/status` 回调与回复（webhook 与长连接；`om_` 证据） | 正式域名的真实收发证据 |
| 飞书验签、URL challenge、主人白名单；本地长连接已连上 Feishu | MCP 灯桥接与真机 |
| 本地 `opencode-go/deepseek-v4.1-flash` 单/多会话 | 40 条场景与真实模型重复统计 |
| 本地 workerd DO + PiHarness + Lifecycle + `pa_*` 迁移 | 费用上限与演示材料 |
| Router/Worker、Task/Assignment/fencing、审批/执行、提醒、记忆 | 真实 Worker 侧验收 |
| Node 进程内 pi-durable 模型运行时（`apps/agent/src/runtime/node-pi.ts`，未配置 key 时显式失败） | 真实模型 E3 证据、SIGKILL 恢复演练 |
| 单一组合根 `apps/agent/src/app.ts`，Node 与 DO 只注入适配层 | — |
| 不可变 TaskInput（`pa_task_inputs`，按 task 单调 seq，同一 inbox 幂等）与 Assignment 输入屏障；旧 Worker 报告不能绕过补充输入 | 真实模型 G2、SIGKILL 中断窗口 |
| file-backed 重启脚本：Inbox 未路由、Assignment/Effect 租约过期、派工 effect 丢失、Action 外部已写但 unknown、needs_manual 可见 | 真实 SIGKILL、DO 驱逐、真实渠道/Pi 恢复 |
| 非阻塞调度：Assignment/Router 短切片轮询，两个 Worker 等待时普通 effect 与 status/cancel 不被长等待拖住 | 真实模型长生成、平台延迟、物理并发压测 |
| Outbox traceId + `/诊断`/`/admin/diagnostics` 安全诊断（无正文/goal/args） | token/费用、预算、用量报表、真实 G2 链路 |
| 模型解读记忆/提醒的确认项（最长 10 分钟，提醒以 dueAt 为上限；owner 校验、取消/过期不写入）；显式命令即时 | 项目范围隔离、Worker 记忆注入、真实误触发负例 |
| 149 个确定性测试、typecheck、DO dry-run、workerd webhook/鉴权/真实模型任务 | 客户端收到确认、真实中断演练 |

## 2. 下一步待办

| ID | 优先级 | 待办 | 依赖 | 完成判据 | 2026-11-08 状态 |
| --- | --- | --- | --- | --- | --- |
| N01 | P0 | 飞书自建应用、机器人、事件订阅、回调 URL、发布 | 飞书账号 | 真实 p2p 事件 200；记录 event/message ID、验签日志、回调时延 | 完成：webhook 200；长连接 `feishu_ws_event` 已受理；`om_` 已记录 |
| N02 | P0 | 真实主动发信与失败分类 | N01、app secret | `pa_outbox.platform_message_id` 有真实 `om_` ID；客户端收到消息 | 完成（平台侧）：`om_x100b603e03ccbca4c1ec6d3785d2599`；客户端收到待确认 |
| N03 | P0 | 运行中断/补投演练 | N01/N02 | 入站已持久化但未回复、发信已接受但未落库两种窗口可核对；不重复发 | 本地确定性测试通过；真实中断窗口待补 |
| N04 | P0 | 把 `pa_*` 存储适配到 DO SQLite | N01 | Worker 内 `ctx.storage.sql` migration；Inbox/Outbox 测试通过 | 完成：`DoDb` + migration，workerd 启动通过 |
| N05 | P0 | 把飞书 webhook 接入 Worker | N01、N04 | 真实飞书回调进入 DO；主人绑定；重复事件不重复建任务 | Worker 已真实部署（2026-11-10）；飞书后台保存请求地址超时，尾流未见飞书请求；本地长连接已连上 Feishu，Worker 侧待自定义域或 WS 桥接 |
| N06 | P0 | 真实模型 Router 替换 `CommandResponder` | N01/N05 | 普通消息进入 Router session；状态查询/取消仍走程序路径 | 完成（本地 workerd）：`PiRouterModel` 真实模型建任务通过；Worker 已部署，待飞书入口打通后做真实回调验收 |
| N07 | P1 | Task / Mandate / Assignment / 两个 Worker | N06 | 两任务并发、Worker 忙时受理新消息、上下文隔离 | 完成：状态机、租约/心跳、fencing、上限 2，测试通过 |
| N08 | P1 | 补充、修改、取消、fencing | N07 | 旧派工迟到报告无权推进；取消先落库再中断 | 完成：补充/回答、修改、取消、前缀解析已接聊天；旧派工/旧审批失效，测试通过 |
| N09 | P1 | 审批、ActionExecutor、mock 灯、unknown/reconcile | N07 | 重复/过期/越权/撤销审批全部被拒；外部成功未落库可核对 | 代码完成：原子审批、取消/修订后拒绝 reconcile；mock 灯为程序化工具，MCP/真机待接 |
| N10 | P1 | 一次性提醒（时区、TTL、取消、runKey） | N07 | 客户端关闭/重启后仍投递；重复 alarm 只生成一次任务 | 完成：Lifecycle job + runKey/TTL + 聊天取消/列表，测试通过 |
| N11 | P1 | 显式记忆查改删 | N07 | 保存、查看、修改、忘记都有程序判据；不自动写入推测 | 完成：查改删与命令路径，测试通过 |
| N12 | P1 | 40 条场景与真实模型重复运行报告 | N07–N11 | 确定性关键集全通过；真实模型单独统计成功率/成本/波动 | 部分：106 个确定性测试通过；40 条报告与重复统计待补 |
| N13 | P1 | 真实部署、鉴权、费用上限、演示 | N05 | 陌生人按手册复现；`/ask` 不再裸奔；有部署/停止/故障步骤 | 部分：Worker 已真实部署，`/ask`、`/admin/*` 鉴权完成；Worker 自定义域/WS 桥接与费用上限待做 |

执行顺序固定为：**N01–N03 → N04–N05 → N06 → N07–N08 → N09 → N10–N11 → N12–N13**。不要同时接第二渠道、真机或管理页。N01/N02 已通过本地 Node（webhook + 长连接）验证；N03 的真实中断窗口仍待补；N05/N06 的 Worker 已部署，但飞书入口超时，真实回调验收仍待补。N04–N11 独立代码与本地测试已完成，N09 的 MCP/真机仍待补。

### 2.1 2026-11-14 实施进展（PA-01 部分完成）

N01–N13 是历史工作分解，后续执行以 PA Issue 为准；本节记录 PA-01 已落地的部分，避免把“代码存在”读成“门槛通过”。

| 提交 | 内容 | 证据 |
| --- | --- | --- |
| `cc1831b` | `NodePiRuntime`：`Harness.open` + `openNodeSqliteStorage`，`operationId` 作 pi 的 `requestId`；`wait` 通过 `storage.submissionByRequest` 重连；超时映射 `pending`；`onWake` 用 Node timer 驱动 `resume()` | `apps/agent/test/node-pi.test.ts`：重复提交只入库一次、重启后重连已结算提交、pending→answered、未知 session 拒绝 |
| `cc1831b` | 组合根 `apps/agent/src/app.ts`；`main.ts`/`infra/src/worker.ts` 改为注入 `Store`/`AgentRuntime`/`WakeScheduler`/`RouterModel`/`ReminderTimer` | 新旧接线逐项比对一致；`f77c74d` 增加 `createApp` 端到端测试 |
| `cc1831b` | Pi 与 `pa_*` 分库：`DATABASE_PATH` + `PI_DATABASE_PATH`（默认 `./data/pi.sqlite`） | 无 key 启动只生成 `agent.sqlite`；两份文件都要备份 |
| `cc1831b` | ADR-0001 记录临时方向 A（Node 默认、DO 实验）与定稿门槛 | 文档；定稿仍需 E3 + E4 |
| `cc1831b` | docs/08 §5.1 固定 `needs_review` 为终态、只由 `/ack` 关闭 | 文档；实现随 PA-09 |
| `1714c52` | 默认模型钉到 opencode-go catalog（`deepseek-v4.1-flash` 解析通过） | 单测，无需密钥 |

仍未取证、不得宣称完成：真实模型 + 真实飞书 p2p 的 E3 全链路；SIGKILL/驱逐恢复；`needs_review`、执行前重核（PA-03）等仍未实现。ADR-0001 的定稿条件见其文末，未满足前不把 Node 路径写进安装说明当已验收。

### 2.2 2026-11-17 实施进展（PA-02 / K13）

当前优先级：**PA-02（已完成本轮实现）→ PA-03 → PA-01 的 E3 证据（需真实凭据）→ PA-04/05/06**。PA-02 与 PA-03 无相互依赖，可并行评审；PA-04 依赖前两者。真实模型与飞书证据受本机凭据限制，不以 E1 结果替代。

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 不可变 TaskInput | `pa_task_inputs`：`task_id`、单调 `seq`、`kind`、`source_inbox_id`、`actor_id`、正文、时间；`(task_id, source_inbox_id)` 唯一，effect 重试不重复写入 | `coordinator.test.ts` “does not duplicate an input for a retried platform message” |
| Assignment 输入序号 | `pa_assignments.dispatched_input_seq` / `consumed_input_seq`；派工时快照最新 seq，Worker prompt 只注入已派发输入 | K13 测试断言 `dispatchedInputSeq=1` 且 prompt 含输入正文 |
| 完成屏障 | 任何旧报告（含 `failed`）都先比较当前最新 seq；存在未派发输入时任务回到 `queued` 并重新派工，旧报告不能标记 `succeeded`，也不处理其 `proposedActions` | K13 测试：旧 ready 被拒、新 Assignment 完成后才 `succeeded` 且 `consumedInputSeq=1` |
| 并发隔离 | 补充一个任务不影响另一个运行中的任务完成 | K13 测试中的第二任务独立 `succeeded` |
| 重放与取消/修订 | 旧 attempt 的报告不得推进任务，不抢占已报告的新 Assignment，不复活 `cancelling` 任务；崩溃窗口由同一消息重试补齐派工；每个输入额外授予一轮执行（含 `working`/租约路径），不按重试上限误杀；revise 后输入保留且旧报告失权；正常 `working` 报告仍重新排队 | 七个回归测试（replay / newer attempt / cancelling / crash window / attempt budget / stale failed / revise）与 working 队列测试 |
| 聊天语义 | 补充回复带输入序号；running 时明确“旧结果不会生效，结束后按最新输入重新执行”；waiting_user 立即重新排队；`/tasks` 显示待消费输入数 | `router.ts`；PA-02 时点 124 个测试 |

边界：以上为 E1 确定性证据；真实模型 G2、真实飞书消息与 SIGKILL 恢复仍未验证。PA-02 保持 OPEN，直到 G2 与故障注入证据补齐。

### 2.3 2026-11-17 实施进展（PA-03 / K14）

当前优先级：**PA-03（本轮实现）→ PA-04 故障注入（可与 PA-05/06 并行）→ PA-01 的 E3 证据（需真实凭据）**。PA-03 的真实外部写工具仍受“未接 GitHub 写工具”限制，E1 使用 mock 灯。

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 执行前事务化重核 | `claimForExecution` 在同一事务内调用授权守卫：Action owner/conversation/taskRevision 与 Task 一致；Task 非终态/非 cancelling；Mandate 仍包含工具 | `actions.test.ts` “execution-time authorization (K14)” |
| 撤销旧审批 | 守卫失败时 approved → superseded、消费一次性审批、记录 `action.execution_rejected`，不调用工具 | “does not execute ... after the task ended/cancellation” |
| 审批入口重核 | 任务已结束/取消/修订时拒绝批准并把 proposed Action 置为 superseded，避免旧审批卡片重新授权 | “rejects approval when the task already ended” |
| 重复领取 | 同一审批只有一次 approved → executing；第二次 claim 返回 `action_executing` | “allows only one claim for the same approval” |
| 执行窗口 | approved Action 超过 expiresAt 时在 claim 中置为 expired、消费审批、通知并 settle，不调用工具 | “expires an approved action that misses its execution window” |
| 外部已发 | 保留 unknown → reconcile；重试前仍重核授权，不盲目重复写 | 既有 reconcile 边界测试 |

边界：以上为 E1；真实外部写、真实平台审批点击与崩溃注入未验证。PA-03 保持 OPEN，直到真实写工具和故障注入证据补齐。

### 2.4 2026-11-17 实施进展（PA-04 重启恢复，E1 部分）

当前优先级：**PA-04（本轮完成 E1 重启脚本；E4 凭证/环境就绪后补）→ PA-05/06 可并行 → PA-01 的 E3**。PA-04 的真实 SIGKILL、DO 驱逐与真实渠道恢复仍 pending，不能以模拟重启替代。

可重跑命令与覆盖窗口：

```bash
npm run test:recovery   # apps/agent/test/recovery.test.ts
```

| 故障窗口 | 注入方式 | 恢复断言 |
| --- | --- | --- |
| Inbox 已受理、Router 尚未持久化 | handler 在 `accept` 中抛错后关闭 SQLite | 重启 `recoverPending` 后只产生一条回复，Inbox 标记 processed |
| Assignment 已打开 Worker、等待报告前中断 | 关闭进程，时钟推进超过租约 | `sweep` 将旧 Assignment 置 expired，显式提交旧报告被拒，任务重新派工并完成；新旧 Worker session id 不同 |
| Effect 已领取、handler 未完成 | 手动 claim 后关闭，时钟推进超过租约 | 重启 `recoverExpired` 回收并执行，任务完成 |
| Task 已创建、派工 effect 未入队 | 删除派工 effect 后关闭，重放同一 Router 决策 | `TaskService.create` 的幂等修复重新入队，任务不再永久 queued |
| Action 外部写已生效、本地 unknown | mock 灯写状态后抛 `ToolUnknownError`，不处理 reconcile 即关闭 | 重启后 reconcile 依据持久灯状态判定 succeeded，证据含 `reconciled:true` |
| needs_manual 不可见 | Outbox 进入 `needs_manual` | `/status` 显示“需人工 N 条” |
| Outbox 平台已接受、本地未记 | 既有 `outbox.test.ts` 发送租约中断场景 | 有查询能力时按 businessKey 核对，不重复发送 |

边界：以上均为 E1（file-backed SQLite + mock 灯 + 模拟进程重建）。未覆盖：真实 SIGKILL 时序、Cloudflare DO 驱逐、Pi 会话/提醒时钟跨重启、真实飞书回执与真实写工具。PA-04 保持 OPEN。

### 2.5 2026-11-17 实施进展（PA-05 非阻塞调度，E1 部分）

当前优先级：**PA-06（可观测/诊断已落地 E1；剩余预算/用量）→ PA-07 → PA-04 的 E4 / PA-01 的 E3（环境/凭据就绪时）**。

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| Assignment 等待切片 | `handleWait` 每次只等 100ms；pending 返回 retry，退避 250ms→5s，效果上限 1000，租约继续延长 | `coordinator.test.ts` 断言 timeout=100ms、maxAttempts=1000 |
| Router 等待切片 | `PiRouterModel` 等待 250ms；pending 抛 `RouterPendingError`，Router 返回 250ms→2s 退避的有界 retry | `scheduling.test.ts` “passes the bounded slice...” 与 “turns a pending router model...” |
| 双 Worker 并发 | 两个 Assignment 可同时 active；slow wait 不再阻塞同一 drain 中的普通 effect | “does not let two slow worker waits starve another effect” |
| 人工指令响应 | 一个 wait handler 被持有（drain 单并发）时，`/status` 与 `/cancel` 仍走 ingress 持久受理 | E1 ingress smoke；不构成 p95 或并发阻塞证据 |
| 并发上限 | Worker 名额与工具并发上限未改变；等待轮询不新增 Worker | 既有 K05/K06 测试 |

边界：以上为 E1（fake slow runtime + 合成延迟）；真实模型长生成、真实飞书平台延迟、真实慢工具超时/隔离与物理并发压测仍 pending，PA-05 保持 OPEN。

### 2.6 2026-11-17 实施进展（PA-06 可观测/诊断，E1 部分）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 投递 trace | `pa_outbox.trace_id`（schema v6）；Inbox/Router 用 `inbox:*`，Task/Action 用 `task:*`，Reminder 用 `schedule:*` | `observability.test.ts` 断言 ingress 回复 trace；真实库副本迁移 v6 |
| 所有者诊断 | `/诊断` 输出过期 Assignment、unknown Action、unknown/needs_manual/failed 投递、Effect 计数与安全处理提示 | 同上；格式化文本不含私聊正文 |
| 管理员诊断 | `GET /admin/diagnostics` 返回结构化快照；`/admin/recent` 移除 goal/text/result | `infra/src/worker.ts`；鉴权沿用 ADMIN_TOKEN |
| 脱敏 | 诊断结构不含消息正文、goal、Action args 或自由文本 lastError；`listOutboxDiagnostics` 只查询安全列，`/admin/recent` 同样移除 lastError | 测试断言 SECRET 与工具错误文本不出现在 JSON/文本中 |
| 待定 | token/费用采集、单 Task/每日硬预算、用量报表、日志全链路脱敏策略 | 需运行时 usage 接口与预算口径决策 |

边界：E1；真实 G2 因果链、平台回执、token 用量与预算执行未验证。PA-06 保持 OPEN。

### 2.7 2026-11-18 实施进展（PA-10 部分：确认与范围，E1）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 模型写入确认 | `save_memory`/`remind` 不再直接落库；生成 `pa_confirmations`（最长 10 分钟，提醒以 dueAt 为上限；owner/source inbox 唯一） | `confirmations.test.ts` 记忆/提醒确认 |
| 确认与撤销 | `/确认 <id>` 应用；`/取消确认 <id>` 取消；显式 `/remember`、`/remind` 保持即时 | 取消不写入、显式命令即时 |
| 过期与鉴权 | 过期确认懒清理；跨 owner 前缀查询拒绝；提醒 runKey/outbox 幂等保留 | 过期/跨 owner 测试 |
| 审计 | `confirmation.created/confirmed/cancelled` | audit 事件 |
| 待定 | memory `projectScope`、Worker 按 Mandate 注入记忆、自然语言提示注入负例 | 需项目标识与注入范围决策 |

边界：E1；真实模型误触发、项目隔离和记忆注入未验证，PA-10 保持 OPEN。

## 3. 环境与密钥

```bash
node -v                 # 需要 26.x
npm install
cp .env.example .env    # 本地 Node 服务/模型实验
cp infra/.dev.vars.example infra/.dev.vars  # 本地 workerd
```

| 变量 | 用途 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用身份与 tenant token |
| `FEISHU_VERIFICATION_TOKEN` | 事件/挑战 token |
| `FEISHU_ENCRYPT_KEY` | 事件解密与签名；生产建议配置 |
| `FEISHU_EVENT_MODE` | `webhook`（默认）或 `long_connection`；长连接由本地 Node 主动连 Feishu，不需要公网地址 |
| `OWNER_FEISHU_OPEN_ID` | 显式主人绑定；禁止昵称推断 |
| `OPENCODE_API_KEY` | 本地模型；未设置时模型任务显式失败。DO 部署时用 Worker secret |
| `OPENCODE_MODEL` | 本地模型 id，默认 `deepseek-v4.1-flash`；provider 固定 `opencode-go` |
| `DATABASE_PATH` | 本地 Node SQLite（`pa_*` 应用状态），默认 `./data/agent.sqlite` |
| `PI_DATABASE_PATH` | Pi 会话库（`pi_*`），默认 `./data/pi.sqlite`；与上一项成对备份 |
| `OUTBOX_*` | 租约、重试次数、退避 |

`.env`、`infra/.dev.vars` 已在 `.gitignore`；不要提交、不要贴日志。密钥轮换时同时更新 `.env`、`infra/.dev.vars` 和 `wrangler secret put`。

## 4. 飞书接入手册

### 4.1 控制台

1. 在飞书开放平台创建**自建应用**，启用**机器人**能力。
2. 权限至少开通：
   - 接收用户发给机器人的单聊消息：`im:message.p2p_msg:readonly`
   - 以应用身份发消息：`im:message:send_as_bot`
   - 群聊权限不需要；MVP 会拒绝群消息。
3. 事件订阅选择**发送到开发者服务器**，订阅 `im.message.receive_v1`。
4. 请求地址填 `https://<公网域名>/webhooks/feishu`；保存时飞书会发 `url_verification` challenge。**challenge 必须在 1 秒内返回，普通事件推送超过 3 秒会重试。** 已部署的 `workers.dev` 地址在 Worker 内响应为毫秒级，但飞书后台保存仍超时；尾流未见飞书请求，优先怀疑 Feishu 到 `workers.dev` 的网络不可达，改用自定义域名或长连接。
5. 在加密策略里设置 Verification Token 和 Encrypt Key，与服务端环境变量一致。若配置了 Encrypt Key，Worker 必须设置同名 `FEISHU_ENCRYPT_KEY` secret；URL challenge 也会被加密。
6. 创建版本并发布；把主人加入应用可用范围，否则发信会报 `230013`。

本地回调可用 Cloudflare Tunnel、ngrok 或已部署 Worker 的 HTTPS 地址：

```bash
cloudflared tunnel --url http://localhost:8787
# 将输出的 https://... 地址填到飞书请求地址
```

临时隧道 URL 会变化，正式联调使用固定域名/命名隧道。Worker 的 `workers.dev` 域名如果被飞书侧网络拦截，绑定自定义域（Workers → Settings → Domains & Routes），或改用飞书长连接：

```bash
FEISHU_EVENT_MODE=long_connection npm start
```

飞书后台的订阅方式要同时改为“使用长连接接收事件/回调”；此时不需要请求地址，本地进程主动连 Feishu。已实测 `feishu_ws_ready` 连接成功。长连接目前跑在本地 Node，不经过 Cloudflare Worker；Worker 侧仍需自定义域或 WS 桥接才能云端接收事件。

### 4.2 绑定主人

先启动服务，再用主人账号给机器人发一条私聊。第一次会被拒绝，但 `pa_inbox` 会记录 actor：

```bash
npm start
sqlite3 data/agent.sqlite \
  "select actor_id, status, reject_reason, received_at
   from pa_inbox order by received_at desc limit 5;"
```

把 `actor_id`（`ou_...`）写入 `OWNER_FEISHU_OPEN_ID`，重启服务。之后同一账号的 p2p 消息才会被受理。

### 4.3 Worker 入口与鉴权

Worker 已接入同一套 webhook 与 `pa_*` 存储。本地 `wrangler dev` 需要 `infra/.dev.vars` 中的飞书凭据、`OWNER_FEISHU_OPEN_ID` 和 `ADMIN_TOKEN`：

```bash
npm run dev:cloudflare
curl -s http://127.0.0.1:8787/healthz
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/status
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/recent
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/diagnostics
```

`/ask`、`/admin/status`、`/admin/recent`、`/admin/diagnostics` 没有有效 `ADMIN_TOKEN` 时返回 401；未配置 token 时返回 503。`/webhooks/feishu` 在缺少飞书凭据时返回 503。不要把这些入口直接暴露到公网。

### 4.4 验证

```bash
curl -s http://localhost:8787/healthz
```

给机器人发 `/status` 或 `状态`，应收到程序生成的运行状态；普通消息应收到 `已收到。`。检查：

```sql
select platform_event_id, status, actor_id, received_at, processed_at
from pa_inbox order by received_at desc limit 10;

select business_key, purpose, status, attempts,
       platform_message_id, last_error
from pa_outbox order by created_at desc limit 10;
```

飞书消息事件的 `platform_event_id` 使用 `message_id`（`om_...`），因为飞书可能用不同 `event_id` 重复推送同一条消息。

### 4.5 常见错误

| 现象 | 检查 |
| --- | --- |
| 401 / invalid signature | Encrypt Key、时间戳、原始 body 是否被代理改写 |
| 200 但无回复 | `OWNER_FEISHU_OPEN_ID`、chat_type 是否 p2p、Outbox 状态 |
| 发信失败 `230006` | 机器人能力未发布 |
| 发信失败 `230013` | 主人在应用可用范围外 |
| 发信失败 `230027` | 缺少发消息权限或外部群限制 |
| 发信失败 `230020` | 触发频率限制 |
| Outbox `unknown` | 飞书不支持按业务键查询；不要盲目重发，人工核对 |

## 5. 本地模型手册

```bash
# 根 .env 设置 OPENCODE_API_KEY
npm run real          # 单会话
npm run real:multi    # Router + 两个 Worker 并发
```

预期：

- `real`：`status=done`，文本 `PA_REAL_MODEL_OK`。
- `real:multi`：三个会话都 `done`，答案分别为 `ROUTER_REAL_OK`、`WORKER_A_REAL_OK`、`WORKER_B_REAL_OK`。

出现 401/403 先检查 key 是否过期/轮换；不要把 key 打印到终端或报告。

## 6. 本地 DO 与部署手册

### 6.1 本地 workerd

```bash
# infra/.dev.vars 设置 OPENCODE_API_KEY
npm run dev:cloudflare
curl -s http://127.0.0.1:8787/healthz
curl -s 'http://127.0.0.1:8787/ask?prompt=Reply%20with%20DO_OK'
```

预期 `/healthz` 返回 `{"ok":true,"runtime":"cloudflare-do"}`，`/ask` 返回 `DO_OK`。本地 DO SQLite 在 `.wrangler/state`；删除它等于重置本地对象数据。

### 6.2 部署

```bash
npx wrangler login
npx wrangler whoami
npm run deploy:dry-run
npx wrangler secret put OPENCODE_API_KEY --config infra/wrangler.jsonc
npm run deploy
npx wrangler tail --config infra/wrangler.jsonc
```

首次部署通过 `exports.Assistant` 创建 SQLite namespace。不要同时添加旧式 `migrations`；两者只能选一个。

部署后验证 `/healthz` 和 `/ask`。`/ask` 目前没有鉴权，只是测试入口；正式公开前必须删除或加认证。

### 6.3 DO 约束

- 一个主人一个对象：`ASSISTANT.getByName("owner")`；以后从已验证主人 ID 派生。
- Lifecycle 拥有唯一 alarm；不要再调用 `ctx.storage.setAlarm()`。
- `pa_*` 已通过 `DoDb` 迁移到 DO SQLite，与 PiHarness 的 `pi_*` 表共用同一数据库；Worker 不得导入 `node:sqlite`。
- 对象驱逐恢复、alarm 重放、真实账号部署尚未验证。
- Pi 1.5 写入的会话不要降回 1.4；坏部署向前修。

## 7. 测试与验收命令

```bash
npm run typecheck
npm test                    # 100 tests
npm run deploy:dry-run
cd spikes/pi-durable-smoke
npm run smoke               # faux 持久化/工具阻断
npm run kill                # SIGKILL 后重开
npm run multi               # faux 三会话并发
npm run real                # 真实模型单会话
npm run real:multi          # 真实模型三会话
```

真实模型脚本不是 CI 用例；运行前确认费用/配额。CI 只跑确定性测试。

## 8. 故障与恢复

| 场景 | 操作 |
| --- | --- |
| 本地进程中断 | 重启 `npm start`；`recoverPending` 会补处理已受理 Inbox；Outbox 按租约/业务键核对 |
| 发信超时 | 查 `pa_outbox.status=unknown`；飞书无查询接口时不要重发，先人工核对 |
| DO 本地状态异常 | 停止 dev，备份后清理 `.wrangler/state`；生产不要用此操作 |
| 部署失败 | 先看 `wrangler tail`；认证问题设置 `CLOUDFLARE_API_TOKEN`；不要回滚 Pi minor |
| 密钥泄露 | 轮换 OpenCode/Feishu key；更新 `.env`、`.dev.vars`、Worker secret；检查日志 |
| 数据库损坏 | 本地保留 `*.sqlite` 备份；DO 使用 SQLite PITR/备份策略（未接入前不要声称有备份） |

## 9. 每次实验记录

新增或修复关键路径时，在 `docs/` 记录以下字段，避免把局部通过写成平台保证：

| 字段 | 内容 |
| --- | --- |
| 日期/代码版本 | commit 或工作树状态 |
| 环境 | 本地 Node / workerd / 真实 Cloudflare |
| 模型 | faux / opencode-go，模型 ID |
| 渠道 | fake / 真实飞书，是否 mock |
| 场景 | K01–K12 或新场景 |
| 结果 | 成功次数/总次数、失败原因 |
| 证据 | 日志、消息 ID、DB 查询、traceId |
| 未决项 | 不能判定或未覆盖的部分 |

### 2026-11-09 真实飞书 p2p 联调

| 字段 | 内容 |
| --- | --- |
| 日期/代码版本 | 2026-11-09；工作树（含 server 事件日志） |
| 环境 | 本地 Node 26 + 临时 Cloudflare Tunnel |
| 模型 | 未调用模型（`/status` 程序路径） |
| 渠道 | 真实飞书自建应用，p2p；webhook + 长连接，无 Encrypt Key |
| 场景 | 渠道/身份/投递；N01/N02 |
| 结果 | 入站 1/1 受理；出站 1/1 平台接受；webhook 约 13ms；长连接 `feishu_ws_event` 通过 |
| 证据 | inbound `om_x100b603e0219c0a0b1e2434fa552a87`；outbound `om_x100b603e03ccbca4c1ec6d3785d2599`；owner `ou_48fabf...` |
| 未决项 | 客户端收到待确认；临时 URL；真实 Worker 部署/驱逐恢复 |
