# 28 · Conversational & Autonomous Planning MVP：自然对话、任务规划与受控自主推进

> **2026-11-21 产品定义升级 / 规划，不代表已实现**。代码核对基线 main `345faacf803fe3d230ab1843295b18d353e5da66`；执行前应重新检查最新 main。实施 Issue：[CONV-01 #89](https://github.com/yuanbaoerer/personal-agent/issues/89)、[PLAN-01 #90](https://github.com/yuanbaoerer/personal-agent/issues/90)、[PLAN-02 #91](https://github.com/yuanbaoerer/personal-agent/issues/91)、[EXP-01 #92](https://github.com/yuanbaoerer/personal-agent/issues/92)。与 [#41 MVP Functional Ready](https://github.com/yuanbaoerer/personal-agent/issues/41)、[21 · 私有 MVP 实施纲领](21-mvp-functional-ready.md)、[12 · Mode Architecture](12-mode-architecture.md)、[24 · GitHub Project Management](24-github-project-management.md) 并存。**原 M01–M14、K/SEC、E3/E4 验收及正式发布门槛不降低。**

> **2026-11-22 实施状态**：P0-A/B/C 的代码路径已通过 PR #106–#110 合并到 main（`a0b6bdf`，线性栈 CX-01 → PL-01 → PL-02）；CX-02 聊天侧计划修订（`revise_plan` + `/plan replan` + PlanDiff）已通过 PR #112 合并（main `acc5bd6`）；E1 记录见 [E1 acceptance](acceptance/2026-11-22-conversational-planning-e1.md)。runbook 前置步骤已在 live 数据库上执行（服务重启、schema 17→25、健康检查、preflight），见 [runbook execution](acceptance/2026-11-22-conversational-planning-runbook.md)；真实 Feishu 交互与 GitHub/成本 E3/E4 仍为 **BLOCKED**，不能据此宣称 Pilot。原 #41 M01–M14 与安全/预算门槛不变。

## 1. 产品北极星和实际差异

**一句话**：Personal Agent 是一个能像成熟交互式 Agent 一样自然对话、以可持久的 Plan 规划复杂目标、在 Owner 授权与预算内自主推进、允许实时修订并以可验证证据汇报的长期个人助手。

与纯 Chatbot 不同：不仅解释做法，还能持久保存已授权计划、执行步骤并管理阻塞与恢复。

与单次 Coding Agent 的差异定位：统一 owner 项目与工具，跨会话保留目标/任务/计划/回执/授权，具备有界主动跟踪与连续使用能力。**不能未经同口径实际 benchmark 宣称“比 OMP/Codex/DSH 更会规划”；这些工具也有规划、工具调用和自动化能力。**

**核心 MVP 体验**：Owner 可以自由聊天而不创建任务 → 讨论范围和约束 → 看见可编辑的 3–5 步计划 → 明确开始 → Agent 自己执行获得授权的只读步骤并核验 → 用户可随时追加要求/询问进展/暂停 → 计划有限重构或请求审批 → 最终在原会话收到结果或诚实的阻塞报告。

### 1.1 三个边界必须明确

1. **Conversation ≠ Task**：聊天讨论是交流，只有明确目标及执行意图才建立 Task。计划草稿不等于任务已执行；模型给出的回答不能作为真实状态和外部工具结果。
2. **Plan ≠ Authorization**：Plan/Skill 只描述候选工作，程序要检查 owner/project/mandate/credential/catalog/预算交集；计划不能提升权限。外部写操作使用现有 Confirmation/ActionService，不能靠“已批准计划”默认批准新目标/新 payload。
3. **Autonomy ≠ Unbounded Background Run**：没有明确授权、预算、时间、工具范围时不能自主启动付费后台循环。后台运行与重启使用既有 Task/Effect/Schedule/Outbox；失败、未知副作用必须可中断、恢复、人工接管。

## 2. 源码基线：已有能力和真实缺口

| 能力 | 当前已实现（核对至 main 345faac） | MVP 增量 |
| --- | --- | --- |
| 自然语言路由 | `pi-router.ts` JSON Router 的 reply/create_task/supplement/revise/cancel/status/记忆/提醒/周期草稿；`router.ts` 有确定性状态问答与控制消歧，#39 已有代码 | **#89**：明确多轮 Conversation Context、连续讨论与 task/plan 切换、跨重启/隔离/隐私；目前 Router 更多读取当前文本与最近 Task，而非稳定的多轮对话上下文 |
| Durable Task/Worker | TaskService、Assignment、TaskInput seq、revision、lease/fencing，最多两个 Worker，ActionService/Verifier、Inbox/Outbox/Audit | **#90**：Parent Task 下的 Plan/Step/依赖与版本持久化，Plan 不是 Worker 临时文本 |
| 工具与业务 | ExtensionPolicy/Skills/Typed GitHub Read、Project Review Finding/Issue Draft，PR #86–#88 已合并 | **#91**：依赖调度、反馈、有限重规划和有界执行；业务首例 #60/#62 readonly GitHub，#61 写仍单独门禁 |
| 真实产品体验 | 存在真实飞书与 GitHub 外部片段证据，#88 PR CI 455 tests 通过 | **#92**：真实多轮聊天、真实模型 Plan、3+ 节点自主执行、用户修订、真实飞书回复、成本与错误率验收；不能把 CI 等于 E3 |
| 组织模式 | [12](12-mode-architecture.md) 已提出 WorkflowPlan 3–5 节点 DAG 模型，但标注为**设计** | 先落地 **通用最小 WorkflowPlan V1**，不是先开发整个 ModeCatalog、Organization Strategy 或多 Agent 编队 |

## 3. 交互状态：从对话到计划再到执行

```text
Owner message
  → Conversation Context（同 owner/会话有限窗口，可恢复；不自动写长期记忆）
  → Router（chat / clarify / propose_plan / task_control / state_query）
     ├─ chat → 直接自然回复（不创建 Task）
     ├─ clarify → 追问缺少的关键约束（不创建 Task）
     ├─ propose_plan → 展示并持久保存计划候选（不执行）
     └─ start/continue plan → Task/Mandate + Plan snapshot
                               → Existing Worker / ActionService / Verifier
                               → Step progress / failure / bounded replan
                               → Outbox: progress / blocked / final
```

- 默认**会话可以讨论**：例如“我想把 personal-agent 开源，先讨论下方案”，不要立即排后台工作。
- 需要操作时明确触发：如“按上面的方案执行只读检查”，才在资源范围内启动已批准 Plan；用户对高风险工具、写操作、费用扩张仍逐项/按已定义粒度确认。
- “先别做了”“修改第三步”“你现在到哪一步”被解释为已有 Plan 的控制或状态请求，不能变成第二个不相干的 Task。
- 普通聊天答案/澄清无需 Worker；长期任务的状态需从 DB 的 Plan/Task/Action 事实读取，不能由 LLM 自编。
- 对话上下文是有限、可控且可清理的会话历史，不是自动、跨项目永久记忆；对外部内容加信任边界。

## 4. 技术实施拆分与责任边界

### P0-A · CONV-01 多轮会话层（#89）

**修改范围建议**：`coordinator/pi-router.ts`、`router.ts`、会话上下文读取/存储、相关 `storage` 表及 Feishu/Client API 消息读取；具体接口以 PR 代码评审确定。

实现有限 ConversationTurn / Window（或引用已有可靠 Inbox/Outbox 持久事实，避免第二份敏感聊天正文），包含 ownerId、conversationId、消息来源、序号、role、内容/引用、createdAt、隐私/保留策略；Router 读取上几轮 owner 与 assistant 的有效上下文，剔除跨会话、跨 owner、未经信任的工具输入。历史摘要若由 LLM 压缩应带来源并不作为权限事实。

首批路由：chat / clarify / propose_plan / start_or_control_task_or_plan / state_query；复用 #39 的现有 Intents/Handler，不重写整个 `pi-router`。把多轮澄清与计划形成无缝连接，取消/暂停/确认仍由程序核验。

**DoD**：同一真实飞书会话至少 6 轮连贯自然对话，按讨论自然衔接；纯聊天不建 Task，不猜用户授权；重启后继续、错 project 和非 owner 无跨界，长任务不阻断正常回复。记录真实模型和成本。

### P0-B · PLAN-01 持久化 Plan V1（#90）

沿用 [12 · Mode Architecture §6](12-mode-architecture.md) 的 `WorkflowPlan` 草案，在 Parent Task 下持久化一个**有限、版本化 DAG**，禁止做独立 Organization Coordinator。

最小数据建议（可调整具体表名）：`PlanRecord(id, ownerId, parentTaskId, projectKey?, taskRevision, inputSeq, planVersion, status, approvedScopeRef, budgetCeiling, createdAt/updatedAt)` 和 `PlanStep(id, planId, goal, dependencies, capabilityRequirements, verifierId, maxAttempts, timeoutMs, status, assignmentId?, evidenceRefs)`。

- 初始 **3–5 节点**、DAG 无环、依赖 ID 合法、全实例最多两个 Worker；模型提出的 Plan 是不可信候选，程序校验节点数量、权限、时间、成本与资源交集。
- 草稿可讨论/调整；明确启动后才进入 active；改计划递增 planVersion（必要时 Task revision），旧 Plan/批准/Assignment/Action 失效。
- Owner 可查询/修订/暂停/恢复/取消，展示版本及 PlanDiff，所有状态经 Store/Audit；历史 Task/Action/receipt 不丢。
- 计划不能提高 Parent Mandate、账号权限、ExtensionPolicy 或 Budget；一个 step 的能力是上限交集，未获得授权就不能执行。
- 初版不实现任意嵌套 DAG、无限动态新增节点、多工作流 DSL。

**DoD**：持久化 Plan/Step 的创建、编辑、版本栅栏、依赖验证、重启与 CLI/Feishu 查询；此 PR 不开放外部写或后台无界执行。

### P0-C · PLAN-02 有界自主执行循环（#91）

**修改范围建议**：已有 TaskService/EffectDispatcher/Assignment/Action/Verifier/Schedule，必要时新增小型 PlanService 维护计划节点状态，但**不能创建第二套 Task/Assignment Executor**。

- Step 仅当所有前置依赖 verified completed 时 ready。调度复用 Worker（最多两个），每步实际工具调用由现有 ActionService / capabilities / approval 约束；绝不能绕过 TaskInput seq、revision、fencing。
- Result → Verifier → Step done/needs_review/blocked；下一步由程序推进，而不是模型用一句“已完成”推动。
- 限额采用 Parent Task 共享额度：步骤数、每步/任务 attempts、累计工具调用、真实模型/token/花费与总 wall-time，计划重构不能“刷新预算”。后台预算未知 fail-closed (#7/#9)。
- `replan` 最小形式：失败或新用户约束时生成局部 PlanDiff；**仅对未开始节点、未扩权、未超预算** 的调整允许按既有执行授权继续；扩大目标/增加权限/更换账号/新费用范围须 Owner 再确认；已执行外部副作用进入显式核对而非“回滚”文字。
- 状态可通过飞书/CLI/TUI 查询；支持 Owner 随时暂停/继续/取消；重启后按持久 step/runKey/lease/fence 恢复或 needs_manual。避免多次 Effect 重放重复外部副作用。
- 首个 E3 目标选 #60/#62 的 GitHub **只读** 评估，#61 Issue 写仍只按经批准的 Typed Action 执行，不借 Plan 直接自动执行。

**DoD**：真实模型能在主人授权后完成 3 个依赖步骤、遇失败有限调整或询问、返回真实回执与最终结果；进程杀掉后不凭空标记成功。对于跨会话长期运行首轮可以支持用户发问时有界续跑，不要求复杂常驻模型 Watchdog。

### P0-D · EXP-01 真实体验验收（#92）

新增 12 类场景 C01–C12，分别测试自然聊天、讨论形成计划、计划修订、真实只读多步执行、进度追问、暂停取消、出错重规划、持久恢复、权限预算、多项目隔离、真实 Project Review、成本与效果；每场景留 SHA/E1/E3/E4/输入/回执/验证结果/成本/延迟，参见 #92。

私有 MVP **增量准入**：C01/C02/C03/C04/C05/C06/C07/C09/C11 的适用 E3 测试，以及 C08/C10 对应的持久恢复/作用域测试，均需证据；原 #41 M01–M14 不变且仍须通过。L2-R GitHub 真实只读与该 MVP 联合验收可复用同一个真实示例；**L2-W 外部 Issue 写入不是自然会话 MVP 的默认门槛**，仍按 #61/#65 单独开放。

## 5. 交付依赖、PR 顺序及并行化

| Workstream / PR | 目标 | 前置 | 不在范围 |
| --- | --- | --- | --- |
| CX-01 | Conversation 上下文/自然 chat vs task routing | #39 已有 Intent、#41 入口 | 第三方渠道/向量检索 |
| CX-02 | Discussion → Plan Draft / Clarification / PlanDiff UX | CX-01 可并行 PLAN-01 schema | 全自动后台 |
| PL-01 | Plan/Step Store + validated DAG + API/CLI | TaskService + #7/#28 守卫 | Organization Mode |
| PL-02 | Dependent Step dispatch + verifier + budget fence | PL-01 | 未经许可的写入 |
| PL-03 | Replan / pause / resume / cancellation / recovery | PL-02 | 无界递归 |
| ACC-01 | E1/E3/E4 真实验收和修复，维护效果指标 | CX/PL 与 #60/#62 | 仅凭 CI 宣称发布 |
| 并行现有业务线 | #60/#62 L2-R 项目真实感知、#68 账号、#7/#28 安全 | 独立 Workstream | 为聊天重造 GH Plugin |

**建议下一开发 PR**：先 CX-01 多轮会话与自然回复，再 PL-01 持久化小 Plan；两者可不同分支并行评审。PL-02/PL-03 在边界经过测试后实施；#92 严格按功能累积真实证据。#61 GitHub Issue 写可以在对应安全条件满足时独立推进，但不得被误称为“自然对话能力完成”。

## 6. 产品验收示例

### 例 A：正常聊天不会意外启动后台任务

Owner：“我在想 Personal Agent 适合做什么，帮我分析下利弊。” → Agent 直接聊天，不创建 Task。Owner：“先给我一个最小 MVP 实施计划，不用执行。” → Agent 形成可编辑 Plan draft，不调用 GitHub 写。Owner：“第三步改成只读评估，而且先给我看代价。” → PlanDiff，原版保留为历史；若 budget 不明，不激活付费后台。

### 例 B：真正的自主执行与重规划

Owner：“按刚才方案，在授权的 personal-agent 项目里检查规划、源码和 PR，先只读执行。” → 程序核对 project/mandate/预算→激活 3–5 步计划→读取固定 SHA 文档→匹配代码/CI→真实验证及草稿回传。中途 Owner：“先忽略 GUI，重点检查证据准确性。” → TaskInput seq 与 PlanVersion 前进→尚未执行步骤改变，旧报告不能覆盖。外部 GitHub 429 时有限退避/needs_review，不尝试越权调用，也不盲目说已完成。

### 例 C：受控写与主动性层级

- L0 Chat：只对话、解释，无 Task/Tool。
- L1 Plan：提出可编辑草稿、无需执行授权。
- L2 Bounded Execution：对具体已授权项目、只读工具、资源和预算自主推进多步。
- L3 Approved Side Effects：写入类变化仍经独立具体 Action 审批、幂等与核验。
- L4 Scheduled Autonomy（后续）：有明确时区/期限/预算/频率的周期只读计划；不要求 MVP 实现无界常驻主动模型，不允许自动合并、生产部署、资金类动作。

这些是**授权等级**，不是需要创建四套 Coordinator 或四个独立 Agent。

## 7. 成功指标与停止规则

首轮用真实记录建立基线：任务一次成功率、对话误建任务率、回复关联上下文准确率、Plan 草稿接受/修改率、每步证据核验率、有效重规划率、Owner 介入次数、费用/延迟、恢复后重复副作用次数。阈值应由真实样本/成本确定，不编造与竞品的优越性。

停止条件：输入丢失、旧 Plan 进度污染、跨项目对话/工具泄漏、执行超授权/预算、未批准外部写、不明确外部动作被重复、错误事实被标 verified，必须 fail-safe/人工介入，不能以新增 Prompt 绕过。

## 8. 变更管理

- 每个工作包独立 feature branch/PR，实际改动需测试/Review/CI；不得自动合并。
- 真实 E3 需要 Owner 的 Feishu / Provider / GitHub 凭据与成本授权；不可用标 BLOCKED，工程继续做 E1。
- 更新 #89–#92 与 #41 的 MVP 整体状态；#65 保留 GitHub 产品线验收，#73 保留 Plugin 生态，不关闭未完成 Issue。
- 文件为规划设计，**不授权启动后台成本、接入新账号/写权限、执行外部 Issue 更新或自动部署**。
