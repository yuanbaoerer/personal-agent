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
| Outbox traceId + `/诊断`/`/admin/diagnostics` 安全诊断（无正文/goal/args） | token/费用、预算、token 级报表、真实 G2 链路 |
| 模型解读记忆/提醒的确认项（最长 10 分钟，提醒以 dueAt 为上限；owner 校验、取消/过期不写入）；显式命令即时 | 项目范围隔离、Worker 记忆注入、真实误触发负例 |
| GitHub 只读连接器：repo 白名单、GET-only、超时/大小/分页上限、资源 scope、来源 URL、可区分错误 | 真实 token/仓库 G1、不支持写 Issue |
| 只读预授权：24h、可撤销、repo 作用域、仅 github.read、自动批准无审批卡 | 真实 G1、周期计划、预算 |
| SQLite 备份：VACUUM INTO、manifest SHA-256、integrity_check、600 权限、verify、恢复到空目录（拒绝较新 schema） | 恢复/升级自动化、加密、保留期 |
| 工具扩展 seam + 只读样例：`registerTools`、resource/readOnly/timeoutMs/replayPolicy 双重校验 | Provider/Channel 扩展契约、真实第三方工具 |
| Magpie 用量/预算：可选读取 quotas/usage/limit，OpenCode Go 窗口低于阈值或 key 限额时阻止新模型请求，`/usage` 附带订阅窗口 | 当前 Magpie 工作区无 OpenCode Go 卡；真实配额/重置未验证 |
| 周期计划：草稿→确认、daily/weekdays、IANA 时区/DST、确定性 runKey、暂停/恢复/取消/修改、计划级 repo 只读授权、DO wake | 真实 Feishu/GitHub G3、生产 alarm 观察 |
| 完成验证器：GitHub Action 回执/来源 URL、Action receipt、结构校验；needs_review 终态 + `/ack` | 真实 G1/G3 外部判据、文本人审质量 |
| 235 个确定性测试、typecheck、DO dry-run、workerd webhook/鉴权/真实模型任务 | 客户端收到确认、真实中断演练 |

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
| 审计 | `action.succeeded/failed/unknown/expired/reconciled/needs_manual/superseded` 均写 audit；task cancel/revise 的批量 supersede 也逐条记录 | `actions.test.ts` 成功/取消 supersede/proposed+executing sweep |

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
| Reminder 已创建、未到点即重启 | 关闭 SQLite，时钟推进超过 dueAt | 重启后只外发一次；再次维护不重复，schedule 为 fired |
| needs_manual 不可见 | Outbox 进入 `needs_manual` | `/status` 显示“需人工 N 条” |
| Outbox 平台已接受、本地未记 | 既有 `outbox.test.ts` 发送租约中断场景 | 有查询能力时按 businessKey 核对，不重复发送 |

边界：以上均为 E1（file-backed SQLite + mock 灯 + 模拟进程重建）。未覆盖：真实 SIGKILL 时序、Cloudflare DO 驱逐、Pi 会话跨重启、真实飞书回执与真实写工具。PA-04 保持 OPEN。

### 2.5 2026-11-17 实施进展（PA-05 非阻塞调度，E1 部分）

当前优先级：**PA-06（可观测/诊断已落地 E1；剩余预算/用量）→ PA-07 → PA-04 的 E4 / PA-01 的 E3（环境/凭据就绪时）**。

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| Assignment 等待切片 | `handleWait` 每次只等 100ms；pending 返回 retry，退避 250ms→5s 并延长租约；瞬时 runtime 错误返回固定 5s retry、不延长租约（靠租约到期重排任务）；效果上限 1000 | `coordinator.test.ts` 断言 timeout=100ms、maxAttempts=1000 |
| Router 等待切片 | `PiRouterModel` 等待 250ms；pending 抛 `RouterPendingError`，Router 返回 250ms→2s 退避的有界 retry | `scheduling.test.ts` “passes the bounded slice...” 与 “turns a pending router model...” |
| 双 Worker 并发 | 两个 Assignment 可同时 active；slow wait 不再阻塞同一 drain 中的普通 effect | “does not let two slow worker waits starve another effect” |
| 人工指令响应 | 一个 wait handler 被持有（drain 单并发）时，`/status` 与 `/cancel` 仍走 ingress 持久受理 | E1 ingress smoke；不构成 p95 或并发阻塞证据 |
| 并发上限 | Worker 名额与工具并发上限未改变；等待轮询不新增 Worker | 既有 K05/K06 测试 |
| 慢工具上限 | 工具调用默认 15s，且不超过 execution lease−1s；只读超时按失败处理，写超时转 unknown + reconcile，避免无限占住 drain | `tool-timeout.test.ts` |
| 重放能力 | 写工具须声明 `replayPolicy="verify"`；未声明或 verify 返回不满足的 unknown 动作直接 needs_manual，不重复写；verify 抛错只重试 reconcile 直到预算 | `tool-timeout.test.ts` “requires verified replay…” |

边界：以上为 E1（fake slow runtime + 合成延迟）；真实模型长生成、真实飞书平台延迟、真实慢工具超时/隔离与物理并发压测仍 pending，PA-05 保持 OPEN。

### 2.6 2026-11-17 实施进展（PA-06 可观测/诊断，E1 部分）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 投递 trace | `pa_outbox.trace_id`（schema v6）；Inbox/Router 用 `inbox:*`，Task/Action 用 `task:*`，Reminder 用 `schedule:*` | `observability.test.ts` 断言 ingress 回复 trace；真实库副本迁移 v6 |
| 所有者诊断 | `/诊断` 输出过期 Assignment、unknown Action、unknown/needs_manual/failed 投递、Effect 计数、待确认项计数与安全处理提示；`/usage` 输出 Task/Action/Effect/Outbox/Tool 聚合，token/费用标为未采集 | 同上；格式化文本不含私聊正文 |
| 管理员诊断 | `GET /admin/diagnostics` 返回结构化快照；`GET /admin/usage` 返回聚合用量；`/admin/recent` 移除 goal/text/result | `infra/src/worker.ts`；鉴权沿用 ADMIN_TOKEN |
| 脱敏 | 诊断结构不含消息正文、goal、Action args 或自由文本 lastError；`listOutboxDiagnostics` 只查询安全列，`/admin/recent` 同样移除 lastError；router 日志记录 action、长度与错误原因，不记录模型输出或 goal | 测试断言 SECRET 与工具错误文本不出现在 JSON/文本，日志捕获断言无线索 |
| 待定 | token/费用采集、单 Task/每日硬预算、token 级报表、日志全链路脱敏策略 | 需运行时 usage 接口与预算口径决策 |

边界：E1；真实 G2 因果链、平台回执、token 用量与预算执行未验证。PA-06 保持 OPEN。

### 2.7 2026-11-18 实施进展（PA-10 部分：确认与范围，E1）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 模型写入确认 | `save_memory`/`remind` 不再直接落库；生成 `pa_confirmations`（最长 10 分钟，提醒以 dueAt 为上限；owner/source inbox 唯一） | `confirmations.test.ts` 记忆/提醒确认 |
| 确认与撤销 | `/确认 <id>` 应用；`/取消确认 <id>` 取消；显式 `/remember`、`/remind` 保持即时 | 取消不写入、显式命令即时 |
| 过期与鉴权 | 过期确认在维护 tick 清理并计数；跨 owner 前缀查询拒绝；提醒 runKey/outbox 幂等保留；timer 注册失败时取消 schedule 并报错 | 过期/跨 owner/ timer 失败测试 |
| 项目作用域 | `pa_memories.project`（空=global）；`/remember --project=`、`/memory --project=`、`/forget --project=`；同 key 跨项目独立；`UNIQUE(owner_id, project, key)` | `memory-scope.test.ts` |
| Worker 注入 | Worker prompt 只加入 global + Task `mandate.project` 的记忆，最多 20 条；Router 不注入；其他项目不出现 | prompt 隔离测试 |
| 模型项目写入 | `save_memory.project` 进入确认 payload，确认卡显示项目；确认后按项目写入 | 项目确认测试 |
| 审计 | `confirmation.created/confirmed/cancelled`；memory audit 带 project | audit 事件 |
| 待定 | 真实模型误触发/提示注入负例、语义检索、项目权限模型 | 需真实模型评测 |

边界：E1；项目隔离与注入已实现并测试，但真实模型误触发/提示注入负例、语义检索与项目权限模型未验证，PA-10 保持 OPEN。

### 2.8 2026-11-18 实施进展（PA-07 只读 GitHub，E1 部分）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 只读连接器 | `github.read` 仅 GET；repo 精确白名单、Bearer token、拒重定向、8s 超时、≤20 项、≤200KB | `github.test.ts` 认证/白名单/分页/超时 |
| 查询能力 | repo、commits、open issues、open pulls、PR 状态；每项返回来源 URL | 同上；fixture 断言 source URL |
| 授权范围 | 工具名与 `github` Mandate resource 双重校验；提案/执行入口都重核 | “requires the github Mandate resource…” |
| 错误 | 401 / 403/429（含 rate limit 与 retry-after）/ 404 / timeout 可区分；token 不入错误 | 错误分类测试 |
| 配置 | `GITHUB_TOKEN` + `GITHUB_ALLOWED_REPOS`；任一缺失不注册工具 | “absent from the registry…” |
| 待定 | 只读自动批准已由 §2.11 实现；token 类型（PAT/App）、白名单仓库、真实 G1 | 需凭据/决策 |

边界：E1（fake GitHub API）；真实 GitHub/Feishu G1 未验证，PA-07 保持 OPEN。

### 2.9 2026-11-18 实施进展（PA-14 备份/校验，E1 部分）

```bash
npm run backup -- --data ./data --out ./backups/$(date +%Y%m%dT%H%M%S)
npm run backup -- --verify ./backups/<timestamp>
npm run backup -- --restore ./backups/<timestamp> --target ./restored-data
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 一致性快照 | 两个 SQLite 文件用 `VACUUM INTO`；目标目录必须为空 | `backup.test.ts` |
| 完整性 | manifest 记录 SHA-256/字节/schema_version；复制后 `PRAGMA integrity_check`；verify 重算 | 篡改检测测试；CLI 冒烟 |
| 权限 | 目录 700、文件/manifest 600 | 测试断言 mode |
| 安全边界 | 拒绝路径型 manifest 文件名；不写入日志/密钥 | verify 校验 |
| 恢复到新实例 | `--restore <backup> --target <emptyDir>` 先 verify，再复制并校验；拒绝非空目标与高于当前 build 的 schema | 恢复后 `openStore` 读取测试；较新 schema 拒绝 |
| 待定 | 恢复/升级自动化、加密、保留期与异地存储策略 | 需部署/安全决策 |

恢复（人工，E1 未演练）：停服务 → 保留现有数据目录副本 → 将备份的 `agent.sqlite`/`pi.sqlite` 复制回 `DATABASE_PATH`/`PI_DATABASE_PATH` → 删除目标目录残留 `-wal`/`-shm` → 启动并检查 `/healthz` 与 `/status`。

边界：E1；未在真实生产数据上演练恢复，PA-14 保持 OPEN。

### 2.10 2026-11-18 实施进展（PA-13 工具扩展 seam，E1 部分）

只读工具样例与字段契约见 [14 · ToolCapability](14-tool-capability.md)。

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 独立注册 | `createApp({registerTools})` 注入 ToolRegistry，不改业务状态机 | `tool-capability.test.ts` |
| 双层授权 | 工具名必须在 Mandate.tools；`resource` 必须在 Mandate.resources | 允许/拒绝两条路径 |
| 只读契约 | `readOnly`、`replayPolicy`、`timeoutMs`、`verify` 由 ActionService 统一执行 | 样例 `time.now` 成功执行 |
| 待定 | Provider/Channel 契约、真实第三方工具、只读自动预授权 | 需真实凭据/策略决策 |

边界：E1；真实第三方工具与 Provider/Channel 兼容性未验证，PA-13 保持 OPEN。

### 2.11 2026-11-18 实施进展（只读预授权，PA-08 前置）

```bash
/allow-read owner/repo     # 24h，仅 github.read + 该 repo
/revoke-read owner/repo
/preauth
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 授权范围 | 仅 `github.read`、repo 必须同时在 `GITHUB_ALLOWED_REPOS`；24h 过期；owner 作用域 | 过期/跨 owner/不同 repo 测试 |
| 自动批准 | 提案命中 active preauth → 事务提交后 approve/execute，无审批卡；生产 `createApp` 已注入 | report-path 测试；`createApp` wiring 测试 |
| 撤销/过期 | 撤销/过期阻止新提案；已自动批准但未执行的 Action 在 claim 时因 provenance 失效转 superseded | revoke-before-execute 测试 |
| 重放 | 重复 report 只在 task 仍 running 时补写；task 已前进则直接返回；post-commit 自动批准丢失时，重放会 finalize 仍为 proposed 的预授权 Action | report replay / lost-finalize 断言 |
| 审计 | `action.auto_approved` + 既有 action 生命周期事件 | 审计断言 |
| 待定 | 周期计划触发、预算、真实 token G1 | 需部署/预算决策 |

边界：E1；预算与 SchedulePolicy 的后续实施见 §2.12/§2.13，PA-07/PA-08 保持 OPEN。

### 2.12 2026-11-18 实施进展（Magpie 用量/预算，PA-06/PA-08 部分）

```bash
MAGPIE_URL=http://127.0.0.1:3425
MAGPIE_GATEWAY_KEY=magpie-personal-agent
MAGPIE_MIN_REMAINING_PERCENT=5
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 订阅额度 | 读取 Magpie `/v1/magpie/quotas`；仅匹配 OpenCode Go 卡（单个无 go 标签的 OpenCode 卡按 Go 处理；多个 OpenCode 卡时仅显式 go 生效），读取 windows 的 used/remaining/resetsAt/limited | `magpie.test.ts` |
| 用量摘要 | 读取 `/v1/magpie/usage?period=today` 与 `/v1/magpie/limit`；`/usage` 附加 calls/tokens/cost/窗口（gateway-wide，所有 Provider）；有 Magpie 数据时移除本地“未采集”行 | 摘要测试；本地只读探测 |
| 预算门禁 | OpenCode Go 窗口 remaining ≤5%、window limited 或 gateway key limited 时阻止新的 Router/Worker 模型请求；Router 只拦新请求，pending 重连不中断；任务 dispatch 60s retry（30 天上限） | gate/limit/窗口测试 |
| 失败策略 | Magpie 不可达或可选端点失败时 fail-open + degraded，Direct Provider 不受影响；配额端点失败才视为不可用 | 不可达测试 |
| 当前环境 | 本地 Magpie 0.1.3792 可读 quotas/usage/limit，但工作区没有 OpenCode Go 卡（仅 Codex/Copilot），因此真实 Go 窗口未验证 | 只读探测 |
| 待定 | 在 Magpie 中添加 OpenCode Go 订阅并验证 5h/7d 窗口、重置与 429 | 需真实订阅连接 |

边界：E1；真实 Go 订阅额度、重置与 429 未验证，PA-06/PA-08 保持 OPEN。

### 2.13 2026-11-18 实施进展（周期计划 SchedulePolicy，PA-08 部分）

```bash
/schedule new owner/repo 09:00 weekdays 检查仓库进展 --tz=Asia/Shanghai --until=2026-12-31
/schedule confirm <id>
/schedule list | show <id> | pause <id> | resume <id> | cancel <id>
/schedule edit <id> owner/repo 10:00 weekdays 新内容 --tz=Asia/Shanghai --until=2026-12-31
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 草稿与确认 | 创建只写 draft；确认前不排期。草稿回复展示频率、时区、仓库、内容、收件会话、截止时间 | 命令草稿/确认测试 |
| 修改与撤销 | edit 整包替换并 `status=draft, version+1, next_run_at=NULL`；pause/resume/cancel 均按 owner；修改后必须重新确认 | 生命周期测试 |
| 时间计算 | IANA 墙钟；daily/weekdays；DST 春季缺口跳过、秋季重复取第一次；工作日跳周末；错过 >1h 不补跑；`--until` 结束日含 23:59:59.999 | `schedule-policy.test.ts` DST/边界测试 |
| 幂等触发 | `source_key=schedule:<policyId>:<scheduledAt>` + Task 唯一键；`pa_schedule_policy_runs(policy_id, scheduled_at)` 抢占；advance 对 `next_run_at` CAS；崩溃窗口可复用 run | 重复 fire、run→task、错过窗口测试 |
| 计划授权 | Task 记录 `schedule_policy_id`；Action 记录 policy/version；仅 `github.read` + 精确 repo + active/未过期/白名单 + 版本匹配时自动批准；其他提案拒绝而非审批卡；执行前再次核验 | 自动批准、out-of-plan repo 拒绝、edit 后执行拒绝测试 |
| 宿主唤醒 | `confirm/resume` 立即 `wake()`；DO maintenance 的 `#nextDueAt` 纳入 policy 并重算最早时间；Node 1s 轮询 | 类型检查/wiring；真实 alarm 待验证 |
| 待定 | 真实飞书 G3、真实 GitHub 调度与回执、DO alarm 生产观察、每周频率 | 需真实凭据/部署 |

边界：E1；PA-08 保持 OPEN，不能据确定性测试宣称 G3 已通过。

### 2.14 2026-11-18 实施进展（TaskCompletionVerifier / needs_review，PA-09 部分）

```bash
/ack <taskId> [备注]      # 仅对 needs_review 生效
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| verifier 注册 | `TaskCompletionVerifier.register()`；内置 structural/text-review/github-read/action-receipt；`github.read` mandate 强制 github-read，模型不能用 criteria 降级 | `completion-verifier.test.ts` |
| GitHub 判据 | repo 优先取主人消息/目标，否则显式 criterion；至少一条当前 revision 的 succeeded `github.read` Action；Action 证据 repo/source 匹配；报告中每个 GitHub URL 都必须来自该 Action 的已知 URL 字段 | 无 Action、无 repo、来源不符、旧 revision、混合 mandate、虚构 citation 测试 |
| 其他判据 | 有工具 mandate → action-receipt（无 Action 不得成功）；text-review/未知 verifier → needs_review；无工具旧任务 → structural，仅声明结构通过；模型不能降级工具任务 | 无 Action、未知/文本/旧路径测试 |
| 终态 | `needs_review` 不再派工；`/ack` 是唯一出口，写 `acknowledged_at/by` 与 `task.acknowledged` 审计；其他状态拒绝 | ack 状态/审计/重复 ack 测试 |
| 可观测 | `/status`、`/usage`、`/admin/status` 显示待核对任务数；SQLite 用 `waiting_user + needs_review=1` 兼容旧 CHECK | 状态文本测试；backup schema v11 |
| 报告字段 | Worker Report 兼容解析 `completionReason`、`evidenceRef`、`verifierVersion`、`unverifiedClaims`，但不把它们当作已验证事实 | 解析测试 |
| 待定 | 真实 G1/G3 外部数据判据、真实模型虚构来源、文本任务固定样例/人审流程 | 需真实凭据与评测数据 |

边界：E1；PA-09 保持 OPEN。

### 2.15 2026-11-18 实施进展（PA-11 确定性部分）

```bash
npm run eval:report           # 40 场景清单 + 37 条确定性测试 + JSON/MD
npm run eval:report:critical  # 仅 critical，CI 关键集
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 固定 40 场景 | 8+10+10+8+4；每项含 ID/version/K/env/mock-real/前置/输入/故障/DB/外部/通知/trace | `evals/scenarios.ts` |
| 执行器 | 逐场景静态校验测试名，再用 `node --test --test-name-pattern` 运行；缺失/不匹配/失败不伪造通过 | `scripts/eval-report.ts` |
| 报告 | JSON+Markdown；绑定 SHA/dirty/Node/OS/arch/依赖/catalog；passed/failed/pending/skipped 分列；K01–K14 状态 | `evals/reports/`（gitignore） |
| 当前结果 | 40 总数；37 executed/passed；3 pending（真实飞书、真实 GitHub 权限、DO 驱逐）；0 failed | 本地运行 |
| CI | 每次 push/PR 运行 deterministic report 并上传 artifact；真实模型不自动触发 | `.github/workflows/ci.yml` |
| 待决策 | 真实模型 Provider/预算、10 任务、E3 凭据、rubric、报告保留、发布阻断 | [15 · 待决策](15-decisions-pending.md) |

边界：E1；40 场景是确定性契约覆盖，不等于 G1–G3 E3 或真实模型成功率。PA-11 保持 OPEN。

### 2.16 2026-11-18 实施进展（PA-12 自托管 Docker，E1）

```bash
cp .env.example .env
npm run preflight
docker compose build && docker compose up -d
curl -fsS http://127.0.0.1:8787/healthz
docker compose exec agent node scripts/backup.ts --data /data --out /data/backups
```

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| 镜像 | Node 26 slim、`npm ci --omit=dev`、非 root、只读根、HEALTHCHECK、exec 保留 SIGTERM；本地拉取阻塞，CI 构建验证构建配置 | Dockerfile / CI |
| Compose | 持久卷、restart、init、tmpfs、cap_drop、no-new-privileges、30s grace | compose.yaml / `docker compose config` |
| 预检 | Feishu 必填、owner、数据目录可写；失败不监听、不泄漏 secrets | `preflight.test.ts` |
| 文档 | 启动、TLS/webhook 差异、日志、备份、诊断、未完成边界 | docs/16 |
| 待定 | registry/架构、webhook vs 长连接、ADR 定稿、定期备份/加密 | D07–D09 |

边界：E1；镜像构建/容器启动/重启持久化需实际命令证据；真实飞书 E3/E4 未通过，Cloudflare 仍为可选实验路径。

### 2.17 2026-11-18 实施进展（PA-13 扩展契约，E1 部分）

| 内容 | 实现 | 证据 |
| --- | --- | --- |
| Provider 配置 | `MODEL_PROVIDER` 默认 `opencode-go`，未知值启动前 `ConfigError`；`OPENCODE_MODEL` 固定模型 | `config.test.ts` 默认/拒绝测试 |
| Runtime 契约 | `RUNTIME_CONTRACT_VERSION=1`；Node/DO 继续通过 `createApp` 注入 Store/Runtime/Wake | 组合根测试/代码审查 |
| Tool 契约 | `TOOL_CONTRACT_VERSION=1`；`ToolRegistry.describe()` 暴露 resource/readOnly/replayPolicy/timeout | `tool-capability.test.ts` |
| Channel 契约 | `CHANNEL_CONTRACT_VERSION=1`；出站 send/可选查询；无查询 unknown/needs_manual | 既有 outbox 契约测试 |
| 文档 | 只读工具注册、版本变更、Provider/Channel 边界 | docs/14 |
| 待定 | 第二真实 Provider、通用入站 ChannelAdapter、真实 G1 | D10/D12；稳定性 D11 |

边界：E1；Provider 验证只有单一真实 Provider 配置，Channel 入站仍以飞书为参考；PA-13 保持 OPEN。

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
| `MODEL_PROVIDER` | 本地 Node 的 Provider，默认 `opencode-go`；未知值启动前 `ConfigError`；当前仅支持该 Provider |
| `OPENCODE_MODEL` | 本地模型 id，默认 `deepseek-v4.1-flash`；由 `MODEL_PROVIDER` 解析 |
| `GITHUB_TOKEN` / `GITHUB_ALLOWED_REPOS` | 只读 GitHub 连接器；两者都需配置，仓库为逗号分隔 `owner/name` 精确白名单；不配置则不注册工具 |
| `MAGPIE_URL` / `MAGPIE_GATEWAY_KEY` / `MAGPIE_MIN_REMAINING_PERCENT` | 可选 Magpie 用量/预算；URL 例 `http://127.0.0.1:3425`；默认 key `magpie-personal-agent`；窗口剩余低于百分比（默认 5）时暂停新模型请求 |
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
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/usage
```

`/ask`、`/admin/status`、`/admin/recent`、`/admin/diagnostics`、`/admin/usage` 没有有效 `ADMIN_TOKEN` 时返回 401；未配置 token 时返回 503。`/webhooks/feishu` 在缺少飞书凭据时返回 503。不要把这些入口直接暴露到公网。

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
