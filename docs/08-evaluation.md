# 08 · 评测体系、关键契约与发布门槛

> 版本：2026-11-14。此文为实施规范，不代表 40 场景已实现，也不代表真实云端恢复已通过。与 docs/04-build-plan.md 中 K01–K12 兼容；新增 K13/K14 不替换既有条目。

## 1. 证据分层

| 级别 | 环境 | 可证明 | 不可证明 |
| --- | --- | --- | --- |
| E0 | 静态检查、tsc、lint | 类型和配置基本一致 | 运行时可靠 |
| E1 | Fake Runtime + SQLite 组件测试 | 有界输入下的状态转移、协议逻辑 | 真实模型或云端稳定 |
| E2 | 本地真实 Provider + Node / workerd | 调度接口、真实模型请求、局部恢复 | 云端对象驱逐或真实飞书投递 |
| E3 | 真实飞书 + 正式运行环境 | 特定入口下的端到端行为 | 长期稳定性 |
| E4 | 控制故障注入和恢复 | 指定崩溃窗口的可恢复性 | 未覆盖故障窗口 |
| E5 | 7/30 天持续自用与外部安装 | 使用价值、维护成本、经验上的稳定性 | 所有用户环境适配 |

测试报告必须记录：UTC 时间、commit SHA、Node/SDK/Worker 版本、环境、模型及参数、渠道、mock/真实工具、输入、预期外部状态、观察状态、traceId、token/cost、重试次数、结果与失败原因。不能把 E1 的通过宣传成 E3/E5。

## 2. K01–K14 关键契约

| ID | 不变量 / 故障窗口 | 验收判据 |
| --- | --- | --- |
| K01 | 非主人或伪造事件 | 不创建任务，不泄漏个人状态 |
| K02 | 相同平台消息重复投递 | 一条业务输入、一份受理记录 |
| K03 | Runtime 接受 Input 但应用未记完成 | 用稳定 deliveryId 核对，不能重复进入会话 |
| K04 | 平台已接受消息但回执未落库 | 不误称未发/已读；可查询则核对，否则进入 unknown |
| K05 | 两 Worker 忙时的 status/cancel | 人工指令无需等 Worker 名额 |
| K06 | 两个任务并发 | 独立 session、Mandate、结果与名额上限 |
| K07 | 修订后旧 Worker 回报 | 旧 revision/fencing 无权推进或提出新 Action |
| K08 | 相同审批重复/并发点击 | 只有一个 Action 获得有效执行机会 |
| K09 | 错人/错会话/错参数/过期审批 | 全部拒绝进入 executing |
| K10 | 取消时外部调用已发出 | 撤销未来动作，标记在途未知并核对，不声称物理撤销 |
| K11 | 外部写已生效但状态未落库 | unknown→核对/人工，无不安全重试 |
| K12 | 提醒重复唤醒、过期、取消、时区 | runKey 去重，符合当前 Schedule 状态 |
| K13 | Worker 运行中有新补充输入 | 完成前覆盖所有已接受 input_seq；旧报告不能遗漏后成功 |
| K14 | Action 已获批但尚未调用时任务撤销/修订 | 执行前程序核验当前 Task 与审批；旧授权不得新增外部写 |

K13 与 K14 必须包含至少一个可控竞态复现测试；应用的锁、事务、序号和外部请求边界都需可观察。K14 必须额外测试“外部请求已经发出”的结果未知路径。

**K13 实现状态（2026-11-17，E1）**：`pa_task_inputs` 保存不可变输入（同一 `task_id + source_inbox_id` 幂等）；`pa_assignments` 记录 `dispatched_input_seq` 与 `consumed_input_seq`；任何旧报告（含 `failed`）在当前最新 seq 高于派工快照时都不能推进任务，而是回到 `queued` 重新派工，也不处理其 `proposedActions`。`coordinator.test.ts` 覆盖补充与旧报告交错、两个并发任务隔离、重复平台消息、旧 attempt 重放不抢占新 Assignment、取消中任务不被旧报告复活、崩溃窗口补派工、补充轮次不计入重试上限、revise 后旧报告失权且输入保留。真实模型 G2、平台投递和崩溃窗口仍 pending，不能据此把 K13 标为 E3 通过。

**K14 实现状态（2026-11-17，E1）**：`ActionRepository.claimForExecution` 在同一事务内重核 owner/conversation/taskRevision、Task 非终态/非 cancelling、Mandate 含工具；失败则 approved → superseded、消费一次性审批并审计，不调用工具。审批入口同样重核；同一审批重复 claim 只有一次成功（`action_executing`）；approved Action 错过执行窗口时转为 expired 并消费审批；外部已发仍走 unknown → reconcile。真实写工具、平台审批点击与故障注入 pending，不能据此把 K14 标为 E3 通过。

**恢复证据（PA-04 部分，E1）**：`npm run test:recovery` 使用 file-backed SQLite 重建进程，覆盖 Inbox 已受理但未路由、Assignment/Effect 租约过期、Task 创建后派工 effect 丢失、Action 外部写已生效但本地 unknown 后 reconcile、Reminder 到期跨重启只外发一次、`needs_manual` 在 `/status` 可见；Outbox 发送中断的 businessKey 核对由 `outbox.test.ts` 覆盖。真实 SIGKILL、DO 驱逐、Pi 会话跨重启、真实飞书回执仍为 pending，不能据此宣称 E4 通过。

**非阻塞调度（PA-05 部分，E1）**：Assignment 等待按 100ms 切片轮询，pending 使用 250ms–5s 退避；Router 等待按 250ms 切片轮询，pending 使用 250ms–2s 退避。两个 pending Worker 与普通 effect 同轮处理时普通 effect 不被饿死；一个 wait handler 被持有时 `/status`/`/cancel` 仍通过 ingress 受理（E1 smoke，不是 p95 证据）。工具调用默认 15s 超时且不超过 execution lease−1s：只读超时失败、写超时转 unknown/reconcile；未知写仅在 `replayPolicy="verify"` 且 verify 不满足时才重试，否则 needs_manual。真实模型长生成、平台延迟、真实慢工具隔离和物理并发压测仍 pending，不能据此宣称 E3/E4。

**可观测/诊断（PA-06 部分，E1）**：Outbox 增加 `trace_id`（schema v6），Inbox/Router/Task/Action/Reminder 投递带因果 trace；`/诊断` 与 `/admin/diagnostics` 列出过期 Assignment、unknown Action、unknown/needs_manual/failed 投递与 Effect 计数，不含消息正文、goal、Action args 或自由文本 lastError；`/admin/recent` 已移除正文与错误文本；`/usage` 与 `/admin/usage` 提供 Task/Action/Effect/Outbox/Tool 聚合，token/费用明确未采集；router 日志记录 action、长度与错误原因，不记录模型输出或 goal；action succeeded/failed/unknown/expired/reconciled/needs_manual/superseded 均写审计（含 task cancel/revise 批量 supersede）。真实 token/费用、硬预算、真实 G2 全链路仍未验证。

**确认与范围（PA-10 部分，E1）**：模型解读的 `save_memory`/`remind` 进入最长 10 分钟确认项（提醒以 dueAt 为上限；owner + source inbox 唯一），`/确认` 后应用；`/取消确认`、过期、跨 owner 均不写入；显式 `/remember`、`/remind` 保持即时；timer 注册失败会取消 schedule 并报错。项目范围隔离与 Worker 记忆注入仍 pending。

**只读 GitHub（PA-07 部分，E1）**：`github.read` 仅 GET，repo 精确白名单、Bearer token、拒重定向、8s 超时、单次 ≤20 项/≤200KB；返回 repo/commits/open issues/open pulls/PR 状态与来源 URL；工具名与 `github` Mandate resource 双重校验；401/403/429（含 retry-after）/404/timeout 可区分。新增 24h 可撤销只读预授权：仅对命中 repo 的 `github.read` 自动批准，report 事务提交后执行；撤销/过期阻止新提案，并让未执行的已批准 Action 在 claim 时失效；重复 report 不重复批准，post-commit 自动批准丢失时重放会补做。真实 token/仓库 G1 与周期计划/预算仍 pending。

**备份/校验（PA-14 部分，E1）**：`npm run backup` 使用 `VACUUM INTO` 复制 agent/pi SQLite；manifest 记录 SHA-256/字节/schema_version；复制后 `integrity_check`，目录/文件 700/600；`--verify` 重新校验并拒绝路径型文件名；`--restore --target` 先 verify，只恢复到空目录，拒绝高于当前 build 的 schema，恢复后重跑完整性检查。恢复/升级自动化、加密与保留期仍 pending。

**工具扩展（PA-13 部分，E1）**：`ActionTool` 暴露 resource/readOnly/timeoutMs/replayPolicy；`createApp({registerTools})` 允许注册独立工具；样例 `time.now` 通过 Mandate resource + 工具名双重校验，并由 ActionService 审批/执行。Provider/Channel 兼容契约与真实第三方工具仍 pending。

## 3. 40 场景结构

保留原有 40 场景的 8+10+10+8+4 分类：渠道/投递 8、任务协作 10、审批/权限 10、中断/恢复 8、记忆/提醒 4。**K13 和 K14 是这 40 场景之内的附加契约标签**，不要为了增项把总数改成 42，也不能通过删旧场景提成功率。

每场景元数据：
- scenarioId、version、type、critical、environmentLevel、mockOrReal、modelId。
- preconditions、inputSequence、faultInjectionPoint、expectedDbState、expectedExternalState、expectedNotifications。
- runCount、successCount、median/p95 latency、token/cost、failures、traceLinks。
- skipped/pending 的独立字段；不许计入成功分母。失败必须保留原始输入与重现步骤。

## 4. 三条黄金场景评测

- G1（GitHub 只读）：授权仓库白名单内获取指定的最新 commit、Issue/PR；每条事实有可点击源；越权仓库被拒绝；平台和模型失败有清晰错误。
- G2（运行中补充）：两个慢 Worker 期间新增补充与修订，旧结果不能忽略最新有效输入；status/cancel 保持响应；真实 Runner 恢复后仍一致。
- G3（主动触发与审批）：周期计划有主人确认的频率/范围/接收人；重复计划触发只产生一次业务工作；写 Issue 必须按 Action 审批、核对结果。

确定性单元测试只证明有界契约。对真实模型，至少选 10 个代表任务，每个独立执行 3 次，以外部判定或人审为依据，记录波动和失败；模型输出合法 JSON 并非成功标准。

## 5. 完成判定与拒绝误报

**任务完成验证器 (TaskCompletionVerifier)** 应按任务类型分层：
1. 结构验证：输出 schema、来源字段、大小、超时和明确的完成报告。
2. 可核对外部事实：外部 API 响应、平台资源状态、检索来源和调用记录，不能只引用 Worker 自述。
3. 语义工作：固定样例、人审或独立 evaluator，记录评分准则和误判；评测模型不能替代硬性权限断言。
4. 证据缺失：标为 needs_review/failed，不通过虚构 evidence 标记成功。

审批和不可重复写的正确性不得由 LLM Judge 判断。对不能证明 exactly-once 的外部平台，应正确报告 at-least-once、幂等、unknown 或手工核对边界。

### 5.1 `needs_review` 的语义（PA-09 契约）

结论已定：`needs_review` 是**终态**，不是中间态，实现随 PA-09 落地。

- 进入条件：Worker 报告结构合法，但 TaskCompletionVerifier 无法用可核对证据确认完成（缺来源、外部状态不可读、只有自述）。这是“不确定”，不是“失败”，因此不得复用 `failed`。
- 不是自动重试态：进入后不再自动派工；重试会掩盖“验证器缺失判据”这个真实问题。
- 退出唯一路径：主人显式命令 `/ack <taskId> [note]`，写入 `acknowledged_by`、`acknowledged_at` 与审计事件 `task.acknowledged`，然后转 `succeeded`；`/ack` 只对 `needs_review` 生效，对其他状态返回原因而不改状态。
- 记录字段（PA-09 的 migration）：`pa_tasks.verification_json`（判据、被检查的证据、缺失项、检查器版本）与 `pa_tasks.acknowledged_at/acknowledged_by`。
- 判定主体：程序判据或人审。LLM Judge 只能作为 `evidence` 的一项输入，不能单独把任务标为 `succeeded`。
- 可观测：`needs_review` 数量必须出现在 `/admin/status`，否则这类任务会静默积压，违反“失败应被主人看见”。

## 6. 目标指标（发布门槛）

- v0.2：有效环境 E3 的 G2 基础闭环 + E4 关键崩溃窗口；K01–K14 已实现且适用的关键检查通过；重要缺失明示 pending。
- v0.3：G1–G3 E3 通过，7 天真实自用；40 场景报告，至少 10 项真实模型任务 ×3 次，任务成功率目标 >=85%（按运行次数报告，不能隐去失败）。
- v0.4：独立安装复现、备份恢复和升级实验，许可证、安全清单完成。
- v1.0：30 天真实使用记录，重大故障零未解决；用户可恢复或处理已知异常。

非功能初始目标：运行中查询/取消从服务接受到持久受理 p95 < 2 秒（按环境与样本量报告）；无授权外部写为 0/已执行案例总数；成本分别报告 Router/Worker/重试和失败；消息发送记录 accepted/unknown/manual 与延迟。

上述目标不是统计保证，需同时报告运行次数与置信边界。未知成本价格时先记录 token 和用量，不虚构货币金额。

## 7. 自动执行及 CI

建议测试入口：
- PR：npm ci、typecheck、全部确定性用例、schema migration、安全静态检查；用 fake 工具，无真实个人密钥。
- 手工或受预算控制的定时评测：真实模型场景、限额、快照和结果报告。
- 正式环境：受控故障注入，不得使用真实高风险设备或隐私数据演示。

报告输出机器可读 JSON 和人可读 Markdown；每次对应 SHA，保留失败日志与原始场景版本。覆盖率是辅助指标，不代替 K01–K14 和真实场景证据。

## 8. 事故复盘与连续自用

建立轻量事件记录：发现时间、触发方式、预期/实际、受影响 Task/Action/Outbox、原因类别、是否有外部副作用、修复 PR、补充测试。
每周复盘三个指标：真正节省的人工步骤、每 100 任务需人工干预次数、每任务总成本。只在这些指标改善且核心故障不扩大时引入新特性。
## 9. 跨平台和多客户端补充（2026-11-14）

新增 K15（不同客户端并发编辑同一任务/审批的状态一致性）、K16（事件订阅重连及幂等重放）、K17（macOS/Windows 原生启动、数据目录和生命周期验证）。K15–K17 为独立扩展测试标签，**不计入当前固定 40 场景的完成率**。平台测试输出 os、arch、Terminal、Runtime 版本、安装方式和运行证据；macOS arm64 与 x64、Windows x64 分别确认。详细矩阵见 [10 · 跨平台客户端规划](10-client-platforms.md)。

## 10. 全球开源专项验证（2026-11-14）

新增独立验收集合：SEC01–SEC08（Prompt Injection、资源越权、Local Connector、扩展可信边界、成本上限与跨语言攻击）；I18N（英文 UI/CLI、Unicode/RTL、IANA 时区与 DST）；PRIV（数据流/日志脱敏、遥测 opt-in、数据导出/删除边界）；REL（产物 hash / provenance / SBOM/安装与回滚证据）；A11Y（键盘、无色终端、屏幕阅读器与缩放）。

**这些专项不是对 K01–K17 或已有 40 场景集的替换**；分别报告 case 数、环境证据、失败与 pending，不允许混入既有 40 场景通过率。Public Alpha、Beta 及 v1.0 的详细门槛参见 [11 · 全球开源社区路线图](11-global-open-source-community.md)。

## 11. 模式与智能组织独立评测（2026-11-17）

[12 · Mode Architecture](12-mode-architecture.md) 规定独立的 MODE01–MODE10 测试集，覆盖 Profile/Strategy 兼容组合、权限不扩大、模式版本冻结、任务修订失效、DAG 依赖/容量、故障恢复、Coding workspace/Shell/Git 隔离、独立任务验收和多客户端状态一致性。

**统计口径**：MODE 测试与原 40 场景分开报告，不改变 K01–K17 或 SEC01–SEC08 的通过率分母。Organization 只在 PA-09/11 等基础完成判据成熟后进入比较实验：至少选取 10 个可分解 Coding/Research 任务，在同模型和可比工具/预算条件下，Delegated 与 Organization 各独立运行至少三次。报告逐次结果、成功/质量、人工干预、token/费用、时延及恢复情况。不能把“调用了更多 Worker”当作质量提升；缺少净收益时保持 Delegated 默认。任何越权外部写或关键恢复失败均阻断策略推广。

## 12. 模型策略、网关与角色模型绑定专项（2026-11-17）

新增 [13 · Model Routing & Gateway](13-model-routing-gateway.md) 定义的独立 `MRT01–MRT10` 合同评测：不同 Router/Worker/Assignment 的真实 Session 模型隔离、热更新不漂移、能力不满足时拒绝、Direct/Gateway 协议、路由组的实际模型来源、超时/流中断/工具副作用时的安全 Fallback、Task/Node 预算、数据出站安全、Node/Cloudflare 运行恢复，以及单模型与角色模型分配的成本质量对照。

**统计口径**：MRT 与固定 40 场景、K01–K17、SEC01–SEC08、MODE01–MODE10 **各自统计**，不能把新增测试数量算作旧测试通过。至少验证两个真实 Provider 配置；Magpie Gateway 的流式、工具调用和多轮会话要有独立 E2/E3 证据，不能只测 `/v1/models`。模型请求结果未知时不盲目重新执行可能带外部副作用的请求，继续遵守 K03/K08–K14。每次报告明确 requestedModel、真实 observed model（未知则 unknown）、路由组、重试、token、费用依据、预算以及测试版本。
