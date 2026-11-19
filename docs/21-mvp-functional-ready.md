# 21 · MVP Functional Ready：私有自用主体功能实施纲领

> 2026-11-20 · 总跟踪 [#41](https://github.com/yuanbaoerer/personal-agent/issues/41) · 实施基线 `b93e0ad`（MVP-01 实现 PR #43 已合并，CI run 44560344296 通过）。
> 这是 v0.2 Reliable Core 主线内的近期私有试用检查点，**不是新版本发布或放宽 v0.2/v0.3/v0.4 的正式门槛**。本文优先决定近期任务顺序；长期设计保留。

## 1. 目标与边界

一个 owner、一个常驻 Agent Core、一个真实模型、一个真实飞书私聊入口。通过自然语言对话/创建任务/查询状态/补充/修改/取消、真实 GitHub 只读查询、明确确认的记忆和一次/周期提醒、授权的定期汇报，关闭客户端仍可执行并收回结果。已有本地 CLI/TUI 辅助管理；不要求远程多设备或 Desktop。私有首版只读优先，真实外部写默认不启用；若必须验证写操作，仅隔离测试资源、明确审批和可核对结果。

当前证据：MVP-01 的六个 owner-scope state tools、确定性状态问答路径与 state-read verifier 已合并（PR #43），仓库记录 308 个确定性测试通过；本地 API/CLI/TUI/SSE、OpenAPI、macOS arm64/Windows x64 CI、clean-install smoke 已有记录。真实 Feishu 长连接入站、D19 复测与 M02/M03 仍 pending；飞书/真实模型/短提醒只有部分真实记录。SSE 主进程 SIGKILL 恢复不是任务/模型恢复证据。真实 GitHub OAuth/G1、并发 G2、计划 G3、持续运行仍待验收。不要增加 E1 数量来代替真实业务结果。

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

### MVP-01：修复 D19/D20（实现已合并，真实验收 pending）

- 首先 state.summary、reminder.list；按场景补 task.list/get、memory.list、schedule.list。复用已有仓储、服务和 ToolRegistry，owner/project 作用域、字段最小化、返回大小限制、无写权限。状态直接问答可走确定性服务，不强制 Worker。
- Router 意图与工具 allowlist、Mandate resource、ActionService 程序化守卫一致；明确 owner 请求内的只读能力可窄范围自动批准。租约/revision 等既有不变量保留。
- state-read verifier 必须验证当前 revision 的真实快照/回执，来源核验与内容事实核验分开。缺证据不得成功；对照真实状态复测 D19，不接受模型自报。
- 负例：空、过期、跨 owner/project、旧 revision、恶意文本、缺权或凭据泄漏。
- 当前状态：代码与确定性测试完成；剩余验收仅限真实 Feishu 长连接入站、自然语言状态查询、后台分析报告与实际收件。人工验收未完成前不勾选 M02/M03，不以本地注入事件替代。

### MVP-02：自然语言主入口

改现有 pi-router.ts/router.ts 与对应 Intent/服务，不建平行状态机。查询 Intent 必须带结构化 target（summary/tasks/task/reminders/memories/schedules）与可选 taskId/project/status/limit，程序校验后直接调用已有 StateReadService，返回实际请求的数据而非一律 summary；未知或非法过滤器先澄清。区分只读查询、需后台分析、改变状态与复合请求，普通状态查询不得派空 Mandate Worker。任务指代候选只来自当前 owner/会话可访问任务，唯一明确目标才执行，多任务或时间歧义先询问；补充、修订、取消继续经 TaskService 的 revision/幂等机制。显式记忆与一次提醒复用 Confirmation；周期计划自然语言提供草稿/确认/取消，执行 cadence 归 #9。模型只提议 Intent，程序负责参数、owner/conversation/权限与目标消歧；不得自行扩大授权或用外部正文伪装 owner 指令。保留 slash/API 命令。真实飞书覆盖典型流程。

### MVP-02 落地顺序

1. 先完成细粒度只读查询与确定性格式化，避免把状态问答送入 Worker。
2. 再接入任务指代/上下文消歧，所有控制操作复用 TaskService 与 revision 栅栏。
3. 最后补记忆、提醒、计划草稿/确认/取消的自然语言入口与确认展示；新增分支放入小型 Intent Handler，Router 保留编排与鉴权后 dispatch。

当前实现（2026-11-20，MVP-02 PR）：六个只读 target 已结构化并经 `StateReadService` 返回真实数据；任务指代支持显式 ID、唯一前缀、序号、会话焦点与目标关键词，歧义时只询问不执行；复合查询+控制请求要求拆分；记忆保存/删除复用 Confirmation，提醒取消复用 ReminderService，周期计划走草稿→确认→取消。确定性测试合计 335 项通过（含 27 项 MVP-02 新增）。真实飞书自然语言覆盖仍待 #38/#12 人工验收，不以本地事件替代。

### MVP-03：GitHub 真实闭环

复用 github.read、预授权、回执、OAuth，不重做授权。D21 已选择 OAuth App；验证私有仓库可先采用精确 repo 的 fine-grained read-only PAT（OAuth repo scope 本身更宽）。真实查询 commits/issues/PR → 数据与可点击来源 → 飞书交付，含撤销/越权/错误。来源 URL 合法不等于摘要事实正确；字段确定性对照 API，或明确人审/needs_review。真实授权需 owner 配置；不提交凭据，不默认扩大资源。

### MVP-04：常驻服务

首选已有 Node + SQLite + Feishu long_connection，受监督的 Node 或现有 Docker Compose（先证实构建/健康/卷/重启），在常开机器运行；一个实例，不依赖客户端在线，API 仅 loopback 或受保护 TLS/隧道。Cloudflare 保留实验路径，不阻断私有 MVP，不从架构删除。真实双 Worker 慢任务、补充/修订/取消，真实进程执行中 SIGKILL，恢复任务/提醒/Outbox 或明确人工处置；按 PA-05 记录服务端受理延迟。首版停接新任务并停止服务/达到安全检查点后备份双库，恢复核对业务状态；不把逐库 VACUUM INTO 当原子跨库快照。

### MVP-05：主动工作

复用 SchedulePolicy/Reminder 而非常驻模型 Watchdog。一次提醒、每天/工作日/每周提醒及 GitHub 报告、owner 状态日报。必要时补 weekly 与内部状态 plan 类型。草稿确认→激活/暂停/修改重确认/取消；唯一 runKey、当前授权 revision、时区、错过触发策略；真实飞书回传。激活前先通过 MVP-06。复杂 cron、任意事件订阅后置。

### MVP-06：资源与权限门槛

建议起始值（待 owner 确认、可配置，不表示现状）：并发 Worker 2、单 Task 10 分钟总时长（区别于 Assignment lifetime）、最多 10 次模型请求/Task、失败自动重试 2 次、周期执行 20 次/日、工具默认 15 秒且尊重更严格声明。持久化计数、提前拒绝超额新调用、说明失败/暂停；后台预算未知 fail-closed，不依赖 Magpie 在线；有可观测的真实调用/失败记录，未知金额不编造。用户确认具体 Provider、每日成本/Token 上限后运行；无硬预算不得激活无人值守付费计划。保留既有权限、审批、撤销、unknown/reconcile；对实际 GitHub 文本注入、越权读取、外部文本诱导副作用/记忆、凭据泄漏做最少负例，实际越权或重复副作用阻断。正式 SEC01–SEC08 与 K 契约不降低。

### MVP-07：可选工具

Web Search/Fetch 在 P0 后再做，复用工具执行路径。公开内容、来源、返回上限、超时、预算、SSRF/DNS/重定向防护与注入隔离。时间工具优先复用现有 time.now；授权文件读取需独立设计，不作为首轮必需项。

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

每项记录 SHA、环境（E2/E3/E4 等）、模型/参数、trace、输入/期望、实际状态、真实外部证据、成本/延迟、失败/待验证；敏感信息脱敏，不入库原始个人消息/密钥。所有 P0 必须有实际证据，无已知越权、输入丢失、关键恢复或失控预算。私有 MVP 通过才进入连续自用；原正式版本要求的 10×3、完整场景、7/30 天及开源验证仍然保留，不因 MVP 通过标为完成。

## 4. 五工作日 Sprint（工作预算，不保证工期）

| 日 | 工作 | 交付 |
| --- | --- | --- |
| 1 | #38 + #39 最小状态与自然语言；真实 D19 复测 | 实际状态可查 |
| 2 | #8 #10 #2 真实模型/飞书/GitHub，G1/G2 | 一次真实业务闭环 |
| 3 | 常驻 Node/Docker、恢复与预算、安全负例 | 客户端退出/中断后可工作 |
| 4 | #9 #11 周期计划、weekly、状态日报 | 经授权能主动汇报 |
| 5 | #12 #41 逐条验收及修复，进入连续自用 | MVP functional ready（仅实际通过后声明） |

凭据、常驻机器、预算或外部平台不可用如实标 blocked，不伪造通过；可并行工程工作，但不得在预算安全门槛未过时激活无人值守计划。

## 5. 暂缓与开发流程

保留现有 CLI/TUI/API，不再扩展 Desktop、TUI 美化、远程多设备、DO 驱逐、Organization、完整 Coding Mode、多模型动态路由、自动记忆/向量检索、国际化/公开发行、插件生态。上述长期计划不删除，原 Issues 不关闭。MVP-P0 优先于原 P1/P2 中非阻断性工作；P1 增强可在真实闭环后做。

每个功能 Issue 用 feature branch、独立 PR、CI、Review；真实验收附证据，禁止在测试缺失时关闭验收 Issue。描述代码与测试、失败复现、受影响不变量、已验证环境与未验证边界。更新 #41 checklist 与 README 事实基线，不提交秘密，不重建已存在模块，不做巨型 PR。#43 已交付 MVP-01 代码；下一开发 PR 为 #39，真实 E3/M02 验收与工程可并行。

## 6. 待 owner 确认 / 配置

- D01/D03：真实 Provider/费用预算、飞书与 GitHub 凭据、常驻机器、允许的副作用；默认只读。不代填、不自动授权。
- D19/D20：按 #38 优先补内部状态语义再进行真实验收；D21 已选择个人 OAuth 保留。
- D07/D09：long_connection 为私有试用建议默认，Node ADR 保持 provisional 直到正式证据齐备。
- D22 等配置向导和发行问题后置；不擅自修改仓库可见性或许可。
