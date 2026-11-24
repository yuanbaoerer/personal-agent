# 07 · Personal Agent 长期产品与工程路线图

> **2026-11-21 产品能力补充**：私有 MVP 增加 [28 · 自然对话与自主规划执行](28-conversational-planning-mvp.md)：#89 多轮会话、#90 持久 Plan、#91 有界执行与动态重规划、#92 真实交互黄金场景。此为与可靠 Core 同属 MVP P0 的**尚未实施**能力，GitHub [#65](https://github.com/yuanbaoerer/personal-agent/issues/65) 是首个验证场景；不能只做 GitHub 专用 Planner，也不要求同步做完整 Organization Mode/SDK/市场。发布门槛和 #41 M01–M14 不降低。

> **2026-11-20 架构升级**：[25 · Extension Platform](25-extension-platform.md) / [#73](https://github.com/yuanbaoerer/personal-agent/issues/73) 为一级必选长期模块。One Core + WorkProfile × ExecutionStrategy × ModelPolicy + ExtensionPolicy（扩展选择与约束，不另造权限）。V1 内置插件、凭据/MCP/Skills；V2 SDK 与第三方隔离；V3 可信 Registry、分发和社区。此前暂缓通用插件市场指近期范围，不再是永久非目标。#65 GitHub 首插件、Coding Runtime 第二类；保留 #41 及原正式发布门槛。

> **2026-11-20 垂直产品交付**：在既有 Reliable Core / #41 门槛之上，采用 [24 · GitHub Project Management MVP 与 Development Orchestrator](24-github-project-management.md)（[#65](https://github.com/yuanbaoerer/personal-agent/issues/65)）定义首个实际业务场景：GH-00/01 真实验收及安全前置 → GH-02 项目与证据读取 → GH-03/04 审批式 Issue 管理与项目评估 → GH-05/06 单 Coding adapter、Draft PR、独立 Review 与主动只读报告。不是平行 Core，不改变正式版本门槛，保留 WorkProfile × ExecutionStrategy × ModelPolicy 长期架构。

> **2026-11-19 近期交付顺序调整**：在 v0.2 Reliable Core 中新增私有试用检查点 [MVP Functional Ready](21-mvp-functional-ready.md)，由 [#41](https://github.com/yuanbaoerer/personal-agent/issues/41) 跟踪。优先 #38 状态语义 → #39 自然语言 → 真实 GitHub/常驻 Node → 安全预算/主动工作 → 14 场景验收。既有 PA Issue 的 MVP-P0 子集先执行；其他原版本门槛、组织模式、ModelPolicy、跨平台及开源设计保留。私有 MVP 不等于 v0.2/v0.3 正式发布，不降低正式门槛。

> 状态：2026-11-14 规划基线，适用代码 main@7199c48。本文定义目标和下一阶段优先级；不声称目标功能已经实现。实施事实以 README、测试和可复现实验记录为准。
> 规划原则：先长期自用，再开源复用；单用户实例优先，单体模块化优先；以真实端到端证据取代“代码存在即完成”。

## 1. 产品使命、受众与成功定义

Personal Agent 是一个单用户优先、自主部署、可扩展、能够长期运行的个人助手。对外是一个持续的聊天身份；内部由 Coordinator 管理 Task、Assignment、Mandate、Action、Approval 和持久任务，Router 负责理解意图，有限数量 Worker 负责独立执行。

**首要用户**：愿意配置模型密钥和聊天机器人、希望委托个人项目与日常信息工作的人。**优先产品策略**：每个使用者部署独立实例，不在本阶段开发多人共享 SaaS、多租户计费与复杂跨用户身份授权。

双重目标：
1. 长期自用：在真实聊天渠道接单、异步执行、按授权读取外部信息、主动提醒，出现故障后可定位、恢复或明确交由主人处理。
2. 可开源复用：另一个开发者不用了解核心业务源码也能安装、配置、备份、升级和完成同一条核心流程；模型、渠道、工具的扩展边界稳定。

成功不以 Agent 数量、Prompt 长度、测试总数或“支持平台数量”衡量，而以有价值的完成任务、人工干预、投递可靠性、恢复证据、费用和维护成本衡量。

## 2. 必须遵守的产品边界

- 首发渠道：飞书个人私聊；一次只验证一个真实聊天渠道。微信、QQ 等放在稳定后。
- 一个逻辑 Router、最多两个并发 Worker；无需嵌套派工、模型互聊团队或常驻模型 Watchdog。
- 第一版只读真实工具优先选择 GitHub 仓库/提交/Issue/PR 查询；天气可作为第二只读工具；mock 灯用于写动作安全测试，不作为产品价值核心。
- 写工具不得直接暴露给模型；Worker 只能在 Task Mandate 范围内提出 Action，程序核验、主人审批、Executor 执行并核对。
- 不接支付、门锁、密码管理、任意 Shell 或未隔离的桌面自动化。
- 记忆仅对主人显式事实/偏好自动保存；第三方文件、Worker 猜测和工具结果不能自动写成个人记忆。
- 单用户自托管不意味着无安全边界。每次输入必须验平台身份和会话；每次外部操作必须有资源和动作级授权。
- 在真实聊天→Router→Worker→结果→聊天闭环、运行中修订、恢复与核心权限测试通过前，不开发第二渠道、Vector DB、多模型路由或通用插件市场。

## 3. 三条黄金场景（Golden Journeys）

### G1 · 项目助手
主人问：“检查我授权的 GitHub 仓库最新进展、待处理 Issue/PR，按紧急度整理我今天应做的事。”
- 输入：真实飞书消息，仓库白名单和只读 GitHub 权限。
- 执行：Router 创建或处理任务；Worker 使用真实 API 返回带来源/链接的摘要。
- 输出：原对话返回结构化结果和各项来源；外部查询异常时按部分失败显示，不伪造更新。
- 验收：无仓库权限时不得跨项目检索；重复事件不创建双任务；可追踪 API、模型、通知的 trace。

### G2 · 运行中补充与修订
主人委托调研三种 Agent Eval 方案；Worker 正在进行时补充“增加成本与部署限制”；随后查询进度或取消。
- 语义：新输入持久化为 TaskInput 事件和输入序号，不因 Worker 正在生成而消失。
- 约束：完成报告必须覆盖已接受的输入版本；旧 Assignment 回报不越过 revision/fencing 检查。
- 验收：两个 Worker 并行时状态与取消仍可及时响应；重启后可恢复待执行工作或明确标记失败。

### G3 · 主动汇报与审批写操作
主人授权工作日上午检查指定 GitHub 仓库并汇报需处理事项；后来指示创建 Issue。
- 语义：定时 Trigger 有确定的授权范围、时区、频率、截止时间和接收对话；同一计划触发有唯一 runKey。
- 只读查询无需额外写授权；创建 Issue 是具体的 Action，提交前展示仓库/标题/正文并由主人确认。
- 验收：重复唤醒不得创建重复任务；发送超时进入可核对的未知投递状态；新 Action 不能复用旧审批。

## 4. 目标体系结构

逻辑层：
1. Channel Adapter：验签、主人身份和会话绑定、事件规范化、发送与平台回执。
2. Durable Core：Ingress/Inbox、Coordinator、Task/Assignment/Mandate、Effect、Outbox、Scheduler、Audit、Recovery。
3. Agent Runtime Adapter：Pi Session 的 open/submit/wait/interrupt 与稳定 operationId；Router 和 Worker 隔离。
4. Capability & Action：声明式只读 Tool，写入类提议、策略核验、原子审批、执行器、unknown/reconcile。
5. Personal Services：记忆、提醒、授权的周期计划及其生命周期。
6. Operations：配置、状态、trace、成本、数据导出备份、升级与恢复。

**部署方向已定为 Node + SQLite（临时结论）**：`apps/agent/src/runtime/node-pi.ts` 已用 pi-durable + `node:sqlite` 实现本地模型运行时，未配置模型密钥时仍走 LocalRuntime 占位并显式失败。Cloudflare DO 保留实验模式。定稿条件与回退见 docs/adr/0001-runtime-hosting.md；在真实模型端到端与 SIGKILL 恢复证据齐备前，不宣称标准路径已验收。

重用已有 TaskService、ActionService、Store、Ingress/Outbox 和 PiRuntime；将环境组装从 main.ts/worker.ts 提取为注入式组合根，而非立即拆微服务。Node 与 DO 的数据库、调度和生命周期不能假设语义自动等价，须跑相同契约集。

## 5. 必须强化的语义不变量

### 5.1 用户输入不能丢
- 新建不可变 TaskInput（inputId、taskId、序号、actor、sourceInbox、kind、createdAt），保留追加事实与修改目标两种语义。
- Assignment 记录它接受的 input sequence；“ready”报告必须与当前待消费序号一致；如果有更新的输入，拒绝旧版本“完成”，将其再交新派工或已授权的活跃会话。
- 任务运行中的目标变更增加 task revision，旧 Assignment 和未执行 Action 立即失权；纯补充也不能被旧 Worker 绕过。
- 不得把新补充简单拼接到 owner_input 后就允许旧报告成功。完整验证见新增 K13。

### 5.2 写操作的权限必须跨事务边界成立
- Mandate 的 resource/tool 白名单在程序层执行，工具声明 resource scope、参数 schema、超时、输出限制、重放策略。
- Action 必须绑定 owner、conversation、task revision、工具、规范化参数哈希、nonce、有效期和来源。
- 在外部请求之前，事务化校验当前 Task 仍有效、审批只消费一次、Action 未失效、版本匹配。跨进程/外部请求的竞态仍须靠执行租约和核对规则明确处理。
- 不得因批准过就跳过执行前检查；取消或修订后禁止新的写入。已在途动作进入 unknown/reconcile，不误称物理回滚。完整验证见 K14。

### 5.3 完成、投递与恢复不是模型自述
- Worker 报告 JSON 只是候选结果。按任务类型使用程序或外部状态判据：GitHub 结果来源、写入后状态、代码任务测试、文本工作质量抽检。
- platform accepted、delivered、read、unknown、needs_manual 不能混为一个“已完成”。
- 应用 pa_* 与 Pi pi_* 并非天然同一个原子业务提交；所有关键中断窗口必须有幂等交付标识和恢复测试。
- 排队的耗时模型等待不能长期占有唯一 EffectDispatcher drain；需要异步查询/分阶段唤醒/有界并发。
- 失败应被主人看见并可人工处理，不允许队列静默卡死。

## 6. 能力演进与不做事项

| 能力 | v0.2 | v0.3 | v0.4 | v1.0 |
| --- | --- | --- | --- | --- |
| 真实渠道与 Router/Worker | 修复端到端闭环 | 日常使用 | 可复用配置 | 稳定升级 |
| 幂等/任务补充/授权/恢复 | 核心必需 | 扩展故障集 | 部署兼容验证 | 持续可观测 |
| 工具 | mock 测试保留 | GitHub 只读为首个真实工具 | 工具接口文档化 | 受控扩展 |
| 主动能力 | 一次提醒可靠 | 周期授权触发与汇报 | 参数化配置 | 长期运行 |
| 记忆 | 显式、可管控 | 项目作用域与来源 | 导出和删除验证 | 按使用反馈演进 |
| 部署 | 一条标准运行路径 | 自用稳定 | 他人可独立安装 | 支持备份升级 |
| 多渠道/多模型/向量检索 | 不做 | 原则上不做 | 根据证据选择 | 仍非强制 |

**近期不做**：通用第三方插件安装/市场（V2/V3 长期必选，见 25）、多租户 SaaS、任意高权限动作、复杂模型编队、自动爬取所有个人数据。V1 内置插件由 GitHub 实际业务驱动，不因技术可实现就自动添加。

## 7. 分阶段发布门槛（以验收而非日历驱动）

### v0.2 Reliable Core（当前唯一工程主线）
- 一个真实飞书 p2p → Router → Worker → Outbox → 飞书完整模型任务成功，并记录平台消息 ID 与 trace。
- TaskInput 与修订一致性：新增输入不丢；旧报告不能覆盖未消费输入。
- 审批/撤销/重复投递/未知外部副作用关键权限契约通过。
- 运行中中断和恢复在所选标准宿主上有可复现证据；无法自动核对的结果可人工处理。
- K01–K14 中适用的全部确定性关键测试通过；关键未覆盖项目显式标 pending，不删门槛。
- 全部变更 CI green，只有声明证据覆盖的环境才标记“已验证”。

### v0.3 Useful Personal Agent
- G1–G3 在真实环境可执行；GitHub 只读输出有真实来源，计划任务获得主人显式授权。
- **新增 MVP 产品要求**：在 #41 原安全与真实验收上，完成 [#92 C01–C12](https://github.com/yuanbaoerer/personal-agent/issues/92) 的自然多轮对话、计划草稿/修订、3+ 步有界只读执行、进度询问、有限重规划、跨重启恢复及权限/预算测试；不允许用模型输出计划文本代替持久执行事实。
- 至少 7 天实际自用，留下带日期、模型版本、结果、失败、干预和花费的运行台账。
- 为文本任务/工具任务定义不同完成验收判据；完整 40 场景集与代表真实模型重复运行报告。
- 不依赖人工改 DB 才能恢复已知故障。

### v0.4 Open-source Ready
- 一套明确的自托管部署方案、环境模板、秘密管理、数据导出/备份/恢复、schema migration/升级说明。
- 第二名开发者在全新机器独立安装、运行 G1 核心流程，记录安装步骤和阻塞。
- 许可证及所有依赖许可证核对、SECURITY、CONTRIBUTING、版本策略与 CI 权限检查完成。
- 只读和写工具的安全边界在文档中明确，公开示例数据无个人标识与凭据。

### v1.0 Stable Personal Agent
- 至少连续 30 天实用记录与故障统计；重大阻断问题清零，升级/恢复演练有证据。
- 任务成功、人工干预、通知投递、异常恢复、成本和运维负担形成可复现报告。
- 稳定的核心接口和文档。不是对所有环境的“零故障”保证。

## 8. 实施顺序与依赖

| Work ID | 优先级 | 核心交付 | 依赖 |
| --- | --- | --- | --- |
| PA-01 | P0 | 一条标准 Runtime/渠道闭环 + 组合根 | 无 |
| PA-02 | P0 | TaskInput 序号与完成 fencing | 无；与 PA-01 并行 |
| PA-03 | P0 | 执行前程序授权与 K14 | 无；与 PA-02 协调 |
| PA-04 | P0 | 持久化故障注入、投递与恢复 | PA-01、PA-02、PA-03 |
| PA-05 | P0 | 非阻塞调度与并发性能 | PA-01 |
| PA-06 | P0 | 追踪、费用及异常可观测 | PA-01 |
| PA-07 | P1 | GitHub 只读工具与 G1 | PA-01、PA-03 |
| PA-08 | P1 | 主动授权计划与 G3 | PA-04、PA-06 |
| PA-09 | P1 | 外部判据的完成校验 | PA-07 |
| PA-10 | P1 | 记忆/提醒确认及来源作用域 | PA-01、PA-03 |
| PA-11 | P1 | 40 场景、K01–K14、真实模型评测 | PA-02～PA-10 |
| PA-12 | P2 | Docker/自托管部署 | PA-01、PA-04 |
| PA-13 | P2 | Model/Channel/Tool 扩展契约 | PA-07、PA-12 |
| PA-14 | P2 | 数据导出、备份、恢复和升级 | PA-04、PA-12 |
| PA-15 | P2 | 许可证、安全与社区治理 | PA-12、PA-13 |
| PA-16 | P2 | 外部安装复现与发布候选 | PA-11～PA-15 |

ID 是工作流标识；GitHub Issue 编号以实际创建结果为准。实施前检查已有 Issues/PR 和当前代码；每个 Issue 使用 feature branch + PR + CI，附失败复现、变更范围、验收输出和真实/模拟环境边界。

**2026-11-14 状态**：PA-01 已合并首批实现（`cc1831b`、`f77c74d`、`1714c52`）：Node 进程内 Pi 运行时、单一组合根、Pi/`pa_*` 分库、ADR-0001 临时方向。真实模型飞书 E3 与 SIGKILL E4 证据仍缺，PA-01 保持 OPEN。

**2026-11-17 状态**：PA-02 的实现已落地（不可变 TaskInput、Assignment `dispatched/consumed_input_seq`、旧报告输入屏障含 `failed`），E1 覆盖 K13、同一消息幂等、崩溃窗口补派工与补充轮次预算；真实模型 G2 与故障注入仍待 PA-04，PA-02 保持 OPEN。

PA-03 的执行前授权重核已落地（E1）：claim 在同一事务内校验 Task 状态/revision/Mandate，旧审批撤销并消费，审批入口同样重核；真实写工具与平台审批点击仍未验证，PA-03 保持 OPEN。

PA-04 的可重跑重启脚本已落地（E1）：覆盖 Inbox 路由前中断、Assignment 租约过期、Action 外部已写但本地 unknown、Reminder 到期跨重启只外发一次、needs_manual 可见；真实 SIGKILL、DO 驱逐、Pi 跨重启与真实渠道恢复仍 pending，PA-04 保持 OPEN。

PA-05 的非阻塞调度已落地 E1：Assignment 等待改为 100ms 切片 + 250ms–5s 退避，Router 等待改为 250ms 切片 + 250ms–2s 退避；两个 Worker 等待期间普通 effect 与 `/status`/`/cancel` 不再被长等待拖住；工具调用默认 15s 超时（读失败/写 unknown）。真实模型长生成、平台延迟与慢工具隔离未测，PA-05 保持 OPEN。

PA-06 的可观测/诊断已落地 E1：Outbox traceId 贯通 inbox/task/schedule，`/诊断` 与 `/admin/diagnostics` 提供过期 Assignment、unknown Action、needs_manual 投递和安全处理提示，`/usage` 与 `/admin/usage` 提供 Task/Action/Effect/Outbox/Tool 聚合，并新增可选 Magpie `/v1/magpie/quotas`、`/usage`、`/limit` 读取：OpenCode Go 窗口低于阈值或 gateway key 限额耗尽时阻止新的 Router/Worker 模型请求；Magpie 不可达时 fail-open。真实 token/费用、真实 Go 窗口与硬预算仍 pending，PA-06 保持 OPEN。

PA-10 的确认与范围已落地 E1：模型解读的 `save_memory`/`remind` 先生成 10 分钟确认项，`/确认` 后应用，`/取消确认`、过期、跨 owner 均不写入；显式命令保持即时。记忆增加 global/project 作用域，Worker 只注入全局 + 当前 `Mandate.project`（最多 20 条），Router 不注入；项目名校验、同 key 跨项目独立、确认卡显示项目。真实提示注入负例与语义检索仍 pending，PA-10 保持 OPEN。

PA-07 的只读 GitHub 连接器已落地 E1，并新增可撤销的只读预授权：`/allow-read owner/repo` 24h 内仅对该 repo 的 `github.read` 自动批准，撤销/过期即恢复逐次审批；真实 token/仓库 G1 仍 pending，PA-07 保持 OPEN。

PA-09 的 TaskCompletionVerifier 已落地 E1：结构校验后按任务类型注册 verifier；`github-read` 必须有 succeeded Action 回执、repo/来源 URL 匹配，否则 needs_review；`needs_review` 不再派工，只能 `/ack` 转 succeeded 并审计；`/status` 与 `/usage` 显示待核对数。真实 G1/G3 外部判据和人审质量仍 pending，PA-09 保持 OPEN。

PA-08 的 SchedulePolicy 已落地 E1：`/schedule new` 只创建草稿，确认后激活；edit 退回草稿并要求重新确认；支持 GitHub 只读摘要与 owner 内部状态日报，cadence 覆盖 daily/weekdays/weekly（weekly 需 weekday）；每次 occurrence 由确定性 sourceKey + run 表去重；GitHub 任务绑定精确 repo/version，内部状态读取绑定 policy/version，暂停/修改/取消/过期、白名单变化或读取失权时拒绝且执行前重核；Node 轮询、DO 用立即 `wake()` 触发 maintenance 重算。预算读取/门禁已在前一节落地。真实飞书 G3、真实 GitHub 调度、真实内部状态日报收件与 DO alarm 生产观察仍 pending；PA-08 保持 OPEN。PA-10 的项目范围隔离/Worker 记忆注入已完成 E1；PA-11 的固定 40 场景目录与确定性 JSON/Markdown 报告已落地，37/40 执行通过、3 条真实 pending，真实模型 10×3/G1–G3/7 天自用需主人决策。详见 [15 · 待决策](15-decisions-pending.md)。

PA-14 的数据资产路径已推进到 E1：manifest v2 元数据、双库备份/校验/空目录恢复、agent JSON 导出（不含 Pi/secret）、删除边界文档；加密/保留期、Pi 跨 SDK 修复、写入中 SIGKILL、真实 PITR 仍 pending，PA-14 保持 OPEN。

PA-12 的 Node + Docker 自托管路径已落地 E1：Dockerfile/Compose、非 root/只读根、持久卷、健康检查、preflight 与诊断文档；镜像未发布 registry，真实 E3/E4、arm64 与定期备份 pending，PA-12 保持 OPEN。

GitHub OAuth（个人开发者）已落地 E1：OAuth App start/callback/status/disconnect、一次性 state、AES-256-GCM token 存储、执行时 token provider；Worker 仍 PAT，私有细粒度只读与真实 G1 待验收。

PA-15 的开源治理确定性部分已落地 E1：SECURITY/CONTRIBUTING/CHANGELOG/模板、工作树秘密扫描、许可清单与治理文档；LICENSE、历史重写、visibility、传递依赖审计仍待 D16–D18，PA-15 保持 OPEN。

PA-13 的扩展契约已部分落地 E1：`MODEL_PROVIDER` 配置校验、实验期 `TOOL/RUNTIME/CHANNEL_CONTRACT_VERSION=1`、`ToolRegistry.describe()` 与只读工具文档；工具声明 `resource`/`readOnly`/`timeoutMs`/`replayPolicy`，`createApp({registerTools})` 是独立注册 seam，未知写只有 `replayPolicy="verify"` 且 verify 返回不满足时才重试。第二真实 Provider、通用入站 ChannelAdapter、真实 G1 与稳定性 D11 仍 pending，PA-13 保持 OPEN。详见 [06 · 待办 §2.17](06-next-steps-and-runbook.md)。

## 9. 风险、监控指标与停止规则

- 可靠性：入站 accepted/processed、Outbox accepted/unknown/manual、Task succeeded/failed/cancelled、租约回收与恢复次数。
- 质量：按黄金场景统计有效完成率、来源正确性、人工修正率、未消费输入数。
- 成本：Router/Worker 的 token、调用次数、重试和金额（未知价格时只记录 token），配置单任务和评测预算硬上限。
- 安全：未授权写与无意重复写在已执行的安全用例中为 0，报告测试范围；不可推导全域安全。
- 可用性：人工 status/cancel 在两个慢 Worker 运行时的 p95 持久受理时延以 2 秒为初始目标，区分平台网络延迟。
- 运维：安装时间、升级故障、备份恢复结果、每周人工排障次数。

**暂停增强功能条件**：完整链路无法工作、已知权限绕过、补充输入丢失、关键持久状态恢复失败或任务成本失控。先修 P0；不通过降低关键测试或忽略事故来解锁后续功能。

## 10. 文档权威性与下一步

- docs/00-product-plan.md：初版产品定位与边界，未来范围决策以本文优先。
- docs/02-architecture.md：现有架构细节，新增技术决策应回填其中。
- docs/04-build-plan.md：原六周预算与 K01–K12 基线；本路线图的版本发布门槛优先，新增 K13/K14 见 docs/08-evaluation.md。
- docs/06-next-steps-and-runbook.md：当前环境操作证据；实施卡片以 PA-01～PA-16 Issues 为准。
- docs/08-evaluation.md：验收规范与证据口径。
- docs/09-open-source-plan.md：标准部署和可复用工程要求。
- docs/adr/0001-runtime-hosting.md：Node vs Cloudflare 的有条件决策。
- README：实现现状唯一事实源；Issue/PR：具体变更与验收事实源。

下一步执行顺序：先 PA-01/02/03，合并通过后开展 PA-04/05/06；形成 v0.2 后验证 GitHub 真工具与连续自用。
## 11. 多终端与 macOS / Windows 兼容路线（2026-11-14 补充）

Desktop、CLI、TUI、Web、IM 均应作为统一 Agent Core 的独立客户端，不得各自管理一套 Task/Memory/Approval 数据。长期支持 macOS Apple Silicon/Intel 与 Windows 11 x64 原生客户端及本机运行路径；Windows ARM64 先验证后承诺；Linux 继续作为服务器/CI 基线。v0.2 仍聚焦真实运行闭环；v0.3 增加 Client API/CLI（本地 E1 最小版已实现），v0.4 逐步纳入 TUI 和跨平台验收（最小 TUI 已在本地接入，平台验收未完成）；Desktop 先 Spike，正式发布可晚于 v0.4。完整支持矩阵、协议、OS adapter、K15–K17 与 PA-17～PA-22 见 [10 · 跨平台客户端规划](10-client-platforms.md)。

## 12. 全球开源社区准备度（2026-11-14 补充）

除长期自用、跨平台和 CLI/TUI/Desktop 外，全球开源社区还要求英文 Quickstart、多语言/时区语义、无需飞书的原生 CLI 使用路径、BYOK/Provider 能力检查、Prompt Injection 与 Local Connector 信任边界、可解释的数据流和隐私默认值、可验证的发行产物、社区治理及无障碍验收。完整细节、Public Alpha 与 Public Beta 分阶段发布阻断项、PA-23～PA-29 的边界见 [11 · 全球开源社区路线图](11-global-open-source-community.md)。

**优先级约束**：v0.2 可靠性仍是唯一核心开发主线；PA-25 威胁模型与关键攻击用例提前进行。Public Alpha 是许可证/安全/隐私/英文文档及一条真实可用路径达标后的独立发布决策，**不等同 v1.0 或 Production Ready**；TUI/Desktop 尚未全部实现不能成为公开源码的机械性前置条件。代码公开只能由所有者明确决策，本文不授权自动修改 repository visibility。

## 13. Mode Architecture：Coding 与智能组织是可组合而非互斥的能力（2026-11-17）

对用户提供 **General / Coding / Organized Work** 等快捷模式，底层保持两个正交维度：

- **WorkProfile（做什么）**：General / Coding / Research 的 Skills、候选工具、上下文与独立验收判据。
- **ExecutionStrategy（如何做）**：Direct / Delegated / Organization 的直答、单派工与受控依赖图。
- 因而「Coding + Organization」是有效组合，不能为不同模式建立各自的 Coordinator/Task DB。

现有的 SuperAgent-inspired Coordinator、Task、Assignment、Mandate、Action/Approval、持久化与恢复继续作为唯一共同基座。Organization 的子节点不得扩大 Parent Mandate；全实例并发上限保持 2，不能依靠模型自报完成或无限分解任务。Skill、WorkflowTemplate 与 Human Feedback 必须有可验证版本、来源和人工发布流程。

**版本边界**：v0.2 不变，优先真实模型闭环和权限/恢复；v0.3 依赖 PA-01/03/07/09/25 的必要安全与完成判据，先做最小 General/Coding Profile 与 Direct/Delegated 试验；PA-13/17/18 中所需接口可以提前抽取，但不要求完整 P2 适配器工作提前完成；Organization 在 v0.4 以后以**可选技术 Spike**验证 DAG、取消、恢复和对照收益，**不是 Public Alpha/v0.4 Open-source Ready 的前置要求**。经验沉淀与 Improvement Loop 后置。

完整领域契约、候选 API、Coding 隔离与 MODE01–MODE10 评测见 [12 · Mode Architecture](12-mode-architecture.md)。本阶段工作包标识 MODE-01～MODE-05，仅为设计待办，未创建 GitHub Issues，不与已有 PA-01～PA-29 混淆。

## 14. ModelPolicy 与可选多模型 Gateway 路线（2026-11-17）

长期产品架构进一步明确为 **WorkProfile × ExecutionStrategy × ModelPolicy**。不同角色可以使用不同模型：低延迟 Router、Code Worker、Research Worker，以及后续 Organization 的 Planner/Reviewer/Summary 节点；模型分配属于 Task/Assignment/Session 的受控配置，而不是增加一组常驻 Agent 或独立调度器。

**实施顺序与优先级**：
- **v0.2 当前主线不变**：继续完善真实链路/持久化恢复/权限和 PA-06 中最小模型用量追踪，不新建网关或自动多模型选择器。
- **v0.3 候选**：在 PA-13 的最小 Provider/Runtime 契约上提前验证 ModelCatalog、最低能力检查、Session 级绑定与 Router/Worker 独立模型配置（MODEL-01）；PA-13 的完整 P2 扩展工作不必全部前置。
- **v0.3–v0.4 可选集成**：Magpie Gateway Adapter、路由组/用量/容错协议 Spike（MODEL-02），**不替代 Direct Provider、不阻断 Public Alpha 或 v0.4 Open-source Ready**。
- **Organization 后期**：Workflow Node 级动态 ModelPolicy（MODEL-03）及 Delegated/Organization、多模型与单模型对照评测；真实数据证明收益后再增加动态选模型。
- 更后期可考虑受限的性能/费用智能路由，模型切换不能绕过授权和未知副作用核对。

MODEL-01～03 是本轮拆分的未来工程工作包，与已存在的 [PA-13](https://github.com/yuanbaoerer/personal-agent/issues/14)（Provider/Runtime 扩展）、[PA-24](https://github.com/yuanbaoerer/personal-agent/issues/27)（BYOK 和全球可用性）、[PA-06](https://github.com/yuanbaoerer/personal-agent/issues/7)（成本/追踪）各有边界，不复制工作。会话级模型绑定、Magpie 可选集成和故障转移安全标准见 [13 · Model Routing & Gateway](13-model-routing-gateway.md)。

## 15. Multi-Harness Worker Runtime（2026-11-24）
[30 · Multi-Harness Worker Runtime](30-multi-harness-worker-runtime.md) 确立可自定义 Worker/Harness/Provider/Model 的长期核心能力。MH-00 契约与真实协议/安全 Spike → MH-01 固定绑定及兼容迁移 → MH-02 单真实 external adapter → MH-03 ACP、第二 Harness 与 Gateway → MH-04 L3 真实 Draft PR/Review → MH-05 多端管理及扩展生态 → MH-06 动态策略/远程。工作包归属 #63/#35/#36/#37/#64/#73/#14，不重复创建平行主线。#41/#92 真实体验、#65 L2、#7/#28 安全预算门槛不下降；首个 adapter 及所有平台支持须独立实证，magpie 不设为必装。MH-00 设计/Spike 可与 v0.2 并行；MH-01 起的实现须在 v0.2 验收后或 owner 明确批准后启动。
