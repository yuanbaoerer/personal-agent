# 21 · MVP Functional Ready：私有自用主体功能实施纲领

> **当前产品优先级：先让 owner 在飞书使用自己开启的真实 omp 会话。** [配对操作](../README.md#飞书使用本机-omp)独立于下面 #41/#92 的后台试用验收。这里的「编程」指在同一工作区多轮读、改、跑测试、查看执行进度和中止；不是请 Router 生成一段代码供人复制，也不是现阶段建立无人值守开发平台。

> **当前结论（2026-11-25，盘点基线 `a54328d`）：私有 MVP 尚未通过。** #137/#138 的 schedule E1 已合并；#41 的 M01–M14 和 #92 的 C01–C12 仍分开签收。[剩余实施队列](#4-剩余实施队列)是下一轮入口；下文带日期的 PR、测试数和 Sprint 记录不作为当前待开发清单。

> **实施与验收分开跟踪**：[对话与计划](28-conversational-planning-mvp.md)的 #89–#91 已合并；[#92](https://github.com/yuanbaoerer/personal-agent/issues/92) 记录真实体验，不因实现合并而关闭。GitHub 项目评估是第一个验证场景；C01–C12 不替代 #41 的 M01–M14 或原安全与发布门槛。

> **2026-11-20 Extension Platform 衔接**：[25 · Extension Platform](25-extension-platform.md) / [#73](https://github.com/yuanbaoerer/personal-agent/issues/73) 为下一工程检查点，#65 仍为下一业务检查点。GH-00/01 真实安全验收与 EXT-01 并行；#68 迁移 GitHub 首插件，#69/#70 MCP/Skills 与 GH-02/04 协作。当前不开发任意第三方包或市场，但 V2/V3 是长期必选，不降级 M01–M14。

> **2026-11-20 下一产品检查点**：在 #41 原 M01–M14 与正式版本要求不变的前提下，[24 · GitHub Project Management MVP](24-github-project-management.md) / [#65](https://github.com/yuanbaoerer/personal-agent/issues/65) 作为第一个垂直场景。GH-00/01 先修已知预算/任务指代/claims 一致性问题并完成真实飞书/GitHub G1；允许并行准备只读扩展，未经对应安全与真实验收不启用写入、无人值守或付费开发。后续 GH-02–04 实现项目评估与审批式 Issue 维护，再 GH-05/06 开发协调与独立审查。

> 2026-11-20 · 总跟踪 [#41](https://github.com/yuanbaoerer/personal-agent/issues/41) · 实施基线 `b93e0ad`（MVP-01 PR #43 已合并）；后续 MVP-02、Intent Handler、事实核验、预算与安全映射 PR 已合并；最新 main 以仓库为准。
> 这是 v0.2 Reliable Core 主线内的近期私有试用检查点，**不是新版本发布或放宽 v0.2/v0.3/v0.4 的正式门槛**。本文优先决定近期任务顺序；长期设计保留。

## 1. 目标与边界

一个 owner、一个常驻 Agent Core、一个真实模型、一个真实飞书私聊入口。通过自然语言对话/创建任务/查询状态/补充/修改/取消、真实 GitHub 只读查询、明确确认的记忆和一次/周期提醒、授权的定期汇报，关闭客户端仍可执行并收回结果。已有本地 CLI/TUI 辅助管理；不要求远程多设备或 Desktop。私有首版只读优先，真实外部写默认不启用；若必须验证写操作，仅隔离测试资源、明确审批和可核对结果。

状态查询与事实核验（#38）、自然语言入口（#39）、本地 API/CLI/TUI、跨平台 CI 已有实现。真实飞书入站已有[对话和计划草稿记录](acceptance/2026-11-22-conversational-planning-runbook.md)；这不等于 D19、M02/M03、G1–G3 全流程或持续运行通过。各项须按[验收手册](22-mvp-acceptance-runbook.md)分别留证；例如，SSE 主进程恢复不能证明运行中的任务或模型恢复。

## 2. 工作包与依赖

| ID | 优先级 | 交付 | Issue | 依赖 |
| --- | --- | --- | --- | --- |
| MVP-01 | P0 第一任务 | 内部状态工具 + state-read verifier | #38 | 无 |
| MVP-02 | P0 | 自然语言意图/指代/确认 | #39 | MVP-01；周期接线与 MVP-05 协调 |
| MVP-03 | P0 | 真实 GitHub、核验回执与事实 | #8 #10 | PA-01/03，真实凭据 |
| MVP-04 | P0 | 常驻 Node、真实并发/中断/恢复、备份 | #2 #3 #4 #5 #6 #13 #15 | 可与 MVP-01/03 并行 |
| MVP-05 | P0 | 周期提醒、GitHub/内部状态汇报 | #9 #11 | MVP-01/02/03/04；激活前 MVP-06 |
| MVP-06 | P0 | 有界预算与关键安全负例 | #7 #28 | 激活无人值守前必须通过 |
| MVP-07 | P1 | 公开 Web Search/Fetch | #40 | P0 验收之后，不阻断 MVP |
| MVP-08 | P0 | 14 项真实场景逐项验收 | #12 #41 | MVP-01～06 |
| MVP-09 | **P0** | 多轮自然对话与 chat/task/plan 无缝切换 | #89 | #39 的现有 Intent/Task |
| MVP-10 | **P0** | 通用持久 Plan、Step 依赖、版本/权限 | #90 | 现有 Task/Store/#7/#28 |
| MVP-11 | **P0** | 自主有限执行、Verifier/进度、重规划与恢复 | #91 | MVP-10、#7/#28 |
| MVP-12 | **P0** | C01–C12 多轮 + 多步真实用户体验验收 | #92 | MVP-09–11；可复用 #60/#62 G1 |

### MVP-01：修复 D19/D20（实现已合并，真实验收 pending）

- 首先 state.summary、reminder.list；按场景补 task.list/get、memory.list、schedule.list。复用已有仓储、服务和 ToolRegistry，owner/project 作用域、字段最小化、返回大小限制、无写权限。状态直接问答可走确定性服务，不强制 Worker。
- Router 意图与工具 allowlist、Mandate resource、ActionService 程序化守卫一致；明确 owner 请求内的只读能力可窄范围自动批准。租约/revision 等既有不变量保留。
- state-read verifier 必须验证当前 revision 的真实快照/回执，来源核验与内容事实核验分开。缺证据不得成功；对照真实状态复测 D19，不接受模型自报。
- 负例：空、过期、跨 owner/project、旧 revision、恶意文本、缺权或凭据泄漏。
- 当前状态：代码与确定性测试完成；state-read 已支持 Worker 结构化 `stateClaims`（计数/任务状态/提醒时间）与回执字段对照；GitHub 任务支持 `githubClaims`（Issue/PR/commit 字段）与 GitHub receipt 对照。新 Router 任务要求结构化 claims；缺失、冲突或未知证据进入 `needs_review`，自由文本始终标记未独立核验。剩余验收仅限真实 Feishu 长连接入站、自然语言状态查询、后台分析报告与实际收件。人工验收未完成前不勾选 M02/M03，不以本地注入事件替代。

### MVP-02：自然语言主入口

改现有 pi-router.ts/router.ts 与对应 Intent/服务，不建平行状态机。查询 Intent 必须带结构化 target（summary/tasks/task/reminders/memories/schedules）与可选 taskId/project/status/limit，程序校验后直接调用已有 StateReadService，返回实际请求的数据而非一律 summary；未知或非法过滤器先澄清。区分只读查询、需后台分析、改变状态与复合请求，普通状态查询不得派空 Mandate Worker。任务指代候选只来自当前 owner/会话可访问任务，唯一明确目标才执行，多任务或时间歧义先询问；补充、修订、取消继续经 TaskService 的 revision/幂等机制。显式记忆与一次提醒复用 Confirmation；周期计划自然语言提供草稿/确认/取消，执行 cadence 归 #9。模型只提议 Intent，程序负责参数、owner/conversation/权限与目标消歧；不得自行扩大授权或用外部正文伪装 owner 指令。保留 slash/API 命令。真实飞书覆盖典型流程。

### MVP-02 落地顺序

1. 先完成细粒度只读查询与确定性格式化，避免把状态问答送入 Worker。
2. 再接入任务指代/上下文消歧，所有控制操作复用 TaskService 与 revision 栅栏。
3. 最后补记忆、提醒、计划草稿/确认/取消的自然语言入口与确认展示；新增分支放入小型 Intent Handler，Router 保留编排与鉴权后 dispatch。

当前实现（2026-11-20，MVP-02 PR）：六个只读 target 已结构化并经 `StateReadService` 返回真实数据；任务指代支持显式 ID、唯一前缀、序号、会话焦点与目标关键词，歧义时只询问不执行；复合查询+控制请求要求拆分；记忆保存/删除复用 Confirmation，提醒取消复用 ReminderService，周期计划走草稿→确认→取消。新增分支已提取到 `StateQueryHandler` / `PersonalIntentHandler`，Router 保留编排、鉴权后 dispatch 与回复投递。确定性测试合计 385 项通过（含 48 项 MVP-02 新增）。真实飞书自然语言覆盖仍待 #38/#12 人工验收，不以本地事件替代。

### MVP-03：GitHub 真实闭环

复用 github.read、预授权、回执、OAuth，不重做授权。D21 已选择 OAuth App；验证私有仓库可先采用精确 repo 的 fine-grained read-only PAT（OAuth repo scope 本身更宽）。真实查询 commits/issues/PR → 数据与可点击来源 → 飞书交付，含撤销/越权/错误。来源 URL 合法不等于摘要事实正确；字段确定性对照 API，或明确人审/needs_review。真实授权需 owner 配置；不提交凭据，不默认扩大资源。

### MVP-04：常驻服务

首选已有 Node + SQLite + Feishu long_connection，受监督的 Node 或现有 Docker Compose（先证实构建/健康/卷/重启），在常开机器运行；一个实例，不依赖客户端在线，API 仅 loopback 或受保护 TLS/隧道。Cloudflare 保留实验路径，不阻断私有 MVP，不从架构删除。真实双 Worker 慢任务、补充/修订/取消，真实进程执行中 SIGKILL，恢复任务/提醒/Outbox 或明确人工处置；按 PA-05 记录服务端受理延迟。首版停接新任务并停止服务/达到安全检查点后备份双库，恢复核对业务状态；不把逐库 VACUUM INTO 当原子跨库快照。

### MVP-05：主动工作

复用 SchedulePolicy/Reminder 而非常驻模型 Watchdog。一次提醒、每天/工作日/每周提醒及 GitHub 报告、owner 状态日报。weekly 与内部状态 plan 类型已补（E1）。草稿确认→激活/暂停/修改重确认/取消；唯一 runKey、当前授权 revision、时区、错过触发策略；真实飞书回传。激活前先通过 MVP-06。复杂 cron、任意事件订阅后置。

### MVP-06：资源与权限门槛

当前实现：并发 Worker 2、Assignment 10 分钟、最多 10 次模型请求/Task、每日请求上限可选、单任务累计工具调用上限 20、周期执行 20 次/日、工具超时 15 秒；请求/动作/周期计数持久化，永久超限停止任务，每日超限暂停/跳过且不消耗 task attempt。仍待实现：token/费用采集、owner 确认的实际 Provider 成本阈值。

建议起始值（待 owner 确认、可配置，不表示现状）：并发 Worker 2、单 Task 10 分钟总时长（区别于 Assignment lifetime）、最多 10 次模型请求/Task、失败自动重试 2 次、周期执行 20 次/日、工具默认 15 秒且尊重更严格声明。持久化计数、提前拒绝超额新调用、说明失败/暂停；后台预算未知 fail-closed，不依赖 Magpie 在线；有可观测的真实调用/失败记录，未知金额不编造。用户确认具体 Provider、每日成本/Token 上限后运行；无硬预算不得激活无人值守付费计划。保留既有权限、审批、撤销、unknown/reconcile；对实际 GitHub 文本注入、越权读取、外部文本诱导副作用/记忆、凭据泄漏做最少负例，实际越权或重复副作用阻断；当前映射见 [23 · 安全威胁模型](23-security-redteam.md)。正式 SEC01–SEC08 与 K 契约不降低。

### MVP-07：可选工具

Web Search/Fetch 在 P0 后再做，复用工具执行路径。公开内容、来源、返回上限、超时、预算、SSRF/DNS/重定向防护与注入隔离。时间工具优先复用现有 time.now；授权文件读取需独立设计，不作为首轮必需项。

### MVP-09–12：新增自然对话与自主规划交付要求

- **#89 Conversation**：Owner 可持续讨论、追问、纠正与计划，只有明确启动才创建/执行 Task；有限对话窗口与真实会话隔离、隐私与恢复。简单聊天不得被强行派 Worker。
- **#90 WorkflowPlan**：3–5 个有依赖的 Step 持久化在 Parent Task 下，模型提出计划而程序核验 DAG/权限/预算/版本；计划可编辑，但 Plan 不授予外部动作权限。
- **#91 Autonomous Loop**：利用现有 Assignment/ActionService/Verifier/Effect 执行获准的只读步骤，观察结果、阻塞、有限重规划、暂停/恢复/取消，Owner 可实时问进度；不得引入第二个 Coordinator 或无界后台循环。
- **#92 真实体验**：增加 C01–C12 黄金场景；与原 M01–M14 同时验收，验证真实模型 + 真飞书 + 真工具，并独立记录 E1/E3/E4；不能只引用 CI 绿灯。先交只读自主计划 Pilot，#61 外部 Issue 写入另经安全审批。
- **顺序**：CX-01/PL-01 可并行开发，先交可自然讨论且能显示 Plan 的用户体验；再 PL-02/PL-03 有界执行；#65 GitHub Project Review 作为首个真实工作负载。原有 #41 Functional Ready 不因某个新的 Plan PR 合并就自动验收通过。

## 3. 验收清单（MVP-08）

| ID | 真实场景 | 通过判据 |
| --- | --- | --- |
| M01 | 飞书自然对话 | 实际接收模型回复 |
| M02 | 自然语言任务/提醒查询 | 与状态快照一致，不编造 |
| M03 | 后台任务 | 创建、执行、最终结果真实回到原对话 |
| M04 | 双并发 | 两独立任务、Session、Mandate 与 Worker 上限 |
| M05 | 运行中补充/修订/取消 | 新输入未丢、旧结果无权推进、取消不复活 |
| M06 | GitHub | 真实授权工具回执、来源与事实对照 |
| M07 | 显式记忆 | 询问/确认后写入、可查删 |
| M08 | 项目记忆 | 新任务只注入对应项目与全局记忆 |
| M09 | 一次性提醒 | 到期真飞书收件 |
| M10 | 周期任务 | 确认计划、真实触发汇报、重复唤醒不重复 |
| M11 | 客户端退出 | 常驻服务继续任务并投递 |
| M12 | 服务进程中断 | task/Session/reminder 不静默丢失，恢复或明确人工处置 |
| M13 | 失败/权限 | 明确反馈，测试范围内零越权/重复外部副作用 |
| M14 | 预算 | 超额/后台预算未知不再发新模型请求 |

执行步骤与核对命令见 [22 · MVP 真实验收 Runbook](22-mvp-acceptance-runbook.md)。每项记录 SHA、环境（E2/E3/E4 等）、模型/参数、trace、输入/期望、实际状态、真实外部证据、成本/延迟、失败/待验证；敏感信息脱敏，不入库原始个人消息/密钥。所有 P0 必须有实际证据，无已知越权、输入丢失、关键恢复或失控预算。私有 MVP 通过才进入连续自用；原正式版本要求的 10×3、完整场景、7/30 天及开源验证仍然保留，不因 MVP 通过标为完成。

## 4. 剩余实施队列

工程实施交给 `opencode-go/deepseek-v4.1-flash`，复用现有 Router、计划执行器和 GitHub 插件。维护者核验代码，owner 授权并操作真实飞书与受控重启；模型不代签。真实验收失败时，按该行的 trace、SHA、预期与实测修复并重跑。

| 顺序 / 跟踪 | 已实施与证据边界 | 剩余工作、负责人及完成判据 |
| --- | --- | --- |
| 0 · 飞书交互编程（当前优先） | 复用飞书 owner 鉴权、Inbox 去重、Outbox 投递；本地显式配对真实 omp，工具执行和模型选择留在开发机。#133 已合并（E1 + 本地 E2）；真实飞书 §10 E3 尚未执行。 | 先用可丢弃工作区验收：同会话读代码 → 修复 → 测试 → 追问，再覆盖单次审批、停止、断连不得重放。owner 在真实飞书按[配对验收](22-mvp-acceptance-runbook.md#10-飞书配对-omp)留证；与下方后台任务分开签收。 |
| 1 · 采集用量（#7、C12） | [CallBudget](../apps/agent/src/observability/call-budget.ts)持久化请求计数；#130 的 `pa_usage` + `/usage` 已合并（provider/catalog 费用、按模型/来源、Worker 端到端）；#133 的 [session-usage](../scripts/session-usage.ts) 已合并。真实飞书空会话轮次记录 3 次 Router 调用、508,462 tokens、catalog 估算 0.036784；完整计划/Worker 成本未采集。 | 维护者在下一次真实运行按[手册 §9](22-mvp-acceptance-runbook.md)核对 session 与运行边界，补齐调用/工具、耗时、纠正与交付记录；owner 确认 Provider 费用阈值。不因 Router-only 快照签收 C12，不授权付费计划。 |
| 2 · 首次完整交付（#123、#92、#65） | [真实记录](acceptance/2026-11-22-conversational-planning-runbook.md)：C01–C03 E3 通过；2026-11-24 空会话草稿/修订 E3 PASS（0 Assignment/0 Action）；C04/C11 的 A、B 通过、C 失败，23 次只读、零写，仍 PARTIAL。#125/#127/#128/#129/#130/#133/#134 已合并；实时库无 GitHub 凭据。 | owner 连接 GitHub 读凭据并重启，新建只读三步计划，末步声明 `github`/`github.read`；同一次运行须有三步核验、最终报告、真实收件和零写入。旧 paused C04 不能直接续跑；缺任一项仍为 PARTIAL。 |
| 3 · 任务核心（#38、#41 M01–M09） | 飞书 ingress/outbox、状态回执、指代与确认、项目记忆、提醒、双 Worker 和 revision 栅栏已有实现。[独立 GitHub 评估](acceptance/2026-11-22-real-project-review.md)核对过结构化 claims，但没有飞书交付。 | owner 按[手册](22-mvp-acceptance-runbook.md)逐项记录真实聊天与状态快照、后台结果、双任务隔离、修订/取消、GitHub 事实来源、记忆确认/隔离及提醒收件。可以复用第 2 项的同一 trace，不能拼接不同运行或批量勾选。 |
| 4 · 控制与恢复（#91/#92 C05–C10；#41 M11–M13） | [计划执行回归](../apps/agent/test/plan-executor.test.ts)覆盖派工、暂停、重规划与时限；已有备份/恢复工具，空闲服务重启不是运行中 E4。 | 维护者与 owner 在受控实例验证进度、补充/暂停/恢复、有限重规划和跨项目拒绝；关闭客户端验证继续交付，再对运行中步骤受控中断。前后对照 Plan/Step/Task/Outbox，证明无丢输入、无重复副作用或明确进入人工处置。 |
| 5 · 主动任务与准入（#7/#9/#28、M10/M13/M14、C09/C12） | [#137](https://github.com/yuanbaoerer/personal-agent/pull/137) / [#138](https://github.com/yuanbaoerer/personal-agent/pull/138) 已合并：[现有周期服务](../apps/agent/src/personal/schedule-policies.ts)支持 GitHub 只读摘要与 owner 内部状态日报；cadence 覆盖 `daily` / `weekdays` / `weekly`（weekly 需指定 weekday），草稿/确认/编辑重确认/暂停/取消、确定性 runKey 去重和跨重启跳过过期触发已有 E1 测试；新增子进程 SIGKILL 后重启 run ledger 去重测试。内部状态任务使用 `state.summary` 与 state-read verifier，暂停/编辑后执行前重核。未配置每日模型请求上限时跳过。请求数上限不等于费用硬上限。 | 真实飞书周期收件、真实模型费用与运行耗时仍待 owner 授权后验收；owner 明确 Provider 与付费上限后再补硬预算守卫。未知/撤权/超额不得发新请求。守卫通过后才激活并验收真实周期收件，最后逐条签收 #41/#92。 |

独立排队：GC-00/01 的真实登录、撤销和重启验收归 #68；审批式 Issue 写入归 #61。GC-02/03、公开 App、Desktop、**无人值守** Coding Worker / Draft PR 与 Web Search/Fetch 不阻断交互式配对；不得把允许配对解读为允许推送、合并或部署。

## 5. 暂缓与开发流程

保留现有 CLI/TUI/API，不再扩展 Desktop、TUI 美化、远程多设备、DO 驱逐、Organization、完整 Coding Mode、多模型动态路由、自动记忆/向量检索、国际化/公开发行、插件生态。上述长期计划不删除，原 Issues 不关闭。MVP-P0 优先于原 P1/P2 中非阻断性工作；P1 增强可在真实闭环后做。

每个修复沿用原 Issue 与独立 PR，说明回归证据及未验证边界。只有新增真实证据才更新 #41/#92 的验收项；README 只记录可复核的事实，不把实现合并当作发布或验收。

## 6. 待 owner 确认 / 配置

- D01/D03：真实 Provider/费用预算、飞书与 GitHub 凭据、常驻机器、允许的副作用；默认只读。不代填、不自动授权。
- D19/D20：按 #38 优先补内部状态语义再进行真实验收；D21 已选择个人 OAuth 保留。
- D07/D09：long_connection 为私有试用建议默认，Node ADR 保持 provisional 直到正式证据齐备。
- D22 等配置向导和发行问题后置；不擅自修改仓库可见性或许可。
