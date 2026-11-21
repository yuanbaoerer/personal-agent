# 24 · GitHub Project Management MVP 与 Development Orchestrator

> **2026-11-20 插件化依赖更新（本条优先于原工作包入口）**：见 [25 · Extension Platform](25-extension-platform.md) / [#73](https://github.com/yuanbaoerer/personal-agent/issues/73)。GH-00/01 与 EXT-01 并行，EXT-02 迁移现有 GitHub connector/OAuth；GH-02 #60 依赖共同 catalog/broker，EXT-03 官方 MCP 只读对照与 REST 扩展并行（保留已验证 REST 回退）；GH-03 #61 写能力通过 plugin typed Action 与 Core 审批/核验，GH-04 #62 使用 EXT-04 skills。GH-05 #63 是第二类 Runtime Plugin，GH-06 独立审查/主动汇报，验证 V2 SDK；V3 长期必选但不阻断 L2。避免先实现 GitHub 专用第二套 registry。所有 #41/#65 原验收及安全前置不变。

> 2026-11-20 · 总跟踪 [#65](https://github.com/yuanbaoerer/personal-agent/issues/65) · 设计基线 `c42243b`。尚未实现本篇新增能力。保留 [21 · MVP Functional Ready](21-mvp-functional-ready.md) 及原 v0.2/v0.3 发布门槛。本篇定义第一个垂直产品交付，不另建 Core。

## 1. 产品目标与检查点

主人通过飞书管理多个授权 GitHub 项目：检查开发进展、结合规划与源码识别缺陷、维护实施待办、派遣 Coding Agent、跟踪测试和 PR、独立 Review 并汇报。核心价值是减少主人在需求→Issue→开发→验收的重复编排，而不是增加模型数量。

| 检查点 | 用户价值 | 完成条件 |
| --- | --- | --- |
| Reliable Core / Functional Ready | 可靠执行、真实通信、恢复、权限与预算 | #41 M01–M14；原正式版本门槛不变 |
| L1 Repository Observer | 查询真实项目状态及源码证据 | GH-01/02 |
| L2 Project Manager MVP（下一产品目标） | 评估实施、生成待办、授权后更新 Issue | GH-01–04 实际闭环及相应安全负例 |
| L3 Development Orchestrator Pilot | Issue→Coding Agent→测试→Draft PR→独立 Review | GH-05/06 实际闭环及恢复 |
| L4 Autonomous Maintainer（后续） | 有界的持续监控、需求识别、返工与主人决策 | 先有连续使用证据；自动写/合并不在本阶段 |

当前：github.read GET-only、单 owner PAT/OAuth E1、repo 白名单及 24h 只读预授权；状态/结构化 Intent、Action audit、claims 与本地预算已有实现；真实 GitHub 只读 G1 与 Feishu 出站已有证据，真实 E3/Issue 写仍未完成。ProjectBinding（`pa_projects`、owner-scoped projectKey、不可变 repoId、branch/credentialRef、plan paths、API/CLI、revoked 历史）已落地；固定 SHA 源码/PR diff/CI、Issue 写和管理工作流仍未实现。2026-11-21 跨平台 CI 已恢复，main run `44860766068` 通过（当前 434 tests）；此前账单期间的合并仅以本地测试为依据。没有证据表明当前已经支持真实 Issue 写、完整源码读取或 Coding Agent 调度。不可把 ChatGPT 的 GitHub 插件能力算进项目自身实现。

## 2. 工程主线与依赖

| ID | 优先级 | 交付 | Issue |
| --- | --- | --- | --- |
| GH-00 | P0 前置 | 真实环境及现有安全/一致性问题 | #41 #7 #9 #28 #38 #39 #12 |
| GH-01 | P0 | 真实 GitHub 只读授权与 G1 | #8 #10 |
| GH-02 | P0 | 多项目绑定与源码/文档/PR diff/CI 证据 | #60 |
| GH-03 | P0 | Issue 写入审批、幂等、核验 | #61 |
| GH-04 | P0 | 项目评估与待办维护闭环 | #62 |
| GH-05 | P1（L2后） | 一个 Coding Agent adapter 与隔离 Draft PR | #63 |
| GH-06 | P1（L2后） | 独立 Review、CI 跟踪、主动汇报 | #64 |

GH-00/01 可并行；GH-02 依赖真实只读授权，GH-03 依赖 #4/#7/#10/#28 的写安全及 GH-02；GH-04 可先做只读评估和草稿，不在写安全未通过时执行。GH-05/06 在 L2 验收后推进，Review 只读可提前验证。私有 MVP 的 #41 不因本篇被降级或替换；可并行开发但未过相关真实门禁不得开启相应外部副作用。GitHub Actions 已于 2026-11-21 恢复；若再次 billing 阻断，标 blocked 并保留本地验证，不能宣称 CI 通过。

GH-00 具体待办：服务层无人值守 guard（confirm/resume/fire/后台模型发起，预算未知 fail-closed）；序号任务绑定实际用户所见列表快照及过滤条件，或者对不稳定目标强制确认；SQL 前缀/目标全量验证；统一 Router/Client API/Schedule 创建入口的 claims 规范；单报告提案上限与实际执行次数/任务总时长等预算语义；真实飞书、真实 GitHub、常驻与重启恢复，现有 #41 场景留证。不以新垂直功能掩盖这些问题。

## 3. 架构与领域边界

```text
Owner (Feishu / Client API)
  -> Router / Structured Intent -> Project context resolution
  -> existing Task / Assignment / Mandate / Worker
       read-only inspection -> evidence -> proposed changes
       explicit confirmation -> ActionService -> typed GitHub write
       approved Coding assignment -> isolated adapter job -> draft PR
       independent Review assignment -> tests/checks/claims -> report
  -> CompletionVerifier / Audit / Outbox -> original owner conversation
SchedulePolicy -> read-only project observation (guarded)
```

不新增第二个调度器、独立 Agent Core 或任意 workflow DSL。遵守 [12 · Mode Architecture](12-mode-architecture.md) 的 WorkProfile × ExecutionStrategy、[13 · Model Routing](13-model-routing-gateway.md) 的独立 ModelPolicy：本阶段可先用同一个已配置模型承担 Planner/Inspector/Reviewer；开发 adapter 的模型由 owner 决定。不同 Assignment 独立 session，工作流阶段只是可持久化的有界业务流程；复用 revision/input_seq/fencing、审批、恢复及 audit。只有明确需求才扩展 domain 类型，具体 schema/迁移由工程 PR 设计。

### ProjectBinding（GH-02）

候选契约：ownerId、projectId、repoId（GitHub immutable ID）、owner/name、defaultBranch、credentialRef（不含 token）、policyVersion、planPaths、projectMemoryRef、status。首版单 project 单 repo，可绑定多个；多 repo 聚合、组织级发现后置。项目绑定不自动授予 GitHub 权限；操作目标必须同时匹配 owner、project、repo ID、授权、工具能力与当前 Mandate；名称歧义先澄清，repo 转移/重命名核对 ID，撤销后立即失权。全局/项目记忆复用现有隔离。

2026-11-21 首批实现：`pa_projects` 持久化 owner-scoped projectKey、不可变 repositoryId、repositoryFullName、defaultBranch、credentialRef、allowedPlanPaths、status/version；`ProjectService` 拒绝跨 owner/重复 key/重复 repo，支持按 immutable ID 的 repositoryFullName 更新、revoke 保留历史并递增版本。`/api/v1/projects`（list/get/bind/unbind）与 `pa projects` 已接入，audit 记录 project.bound/renamed/unbound。尚未把绑定强制接入 GitHub read tool、Task/Mandate 或待执行 Action；这是 B2/C1 的下一条，不能只因数据表存在就宣称 GH02 完成。

### GitHub 读取（GH-01/02）

先以真实精确 repo 的 fine-grained read-only PAT 检查 G1，保留已选 D21 OAuth App（OAuth repo scope 宽于只读）；配置、撤销和负例均留证。读取工具扩展为 typed operations：repo/ref/commit、tree/file、Issue detail、PR changed files/diff、checks/workflow status。固定 commit SHA；PR 绑定 base/head；返回 provenance、路径/行号、永久 URL、truncated/unknown。遵守现有限额，新增任务累计页数/字节/时长上限；不得通用任意 HTTP URL、全仓库无界抓取、执行仓库文本；拒绝二进制/超限及敏感路径，CI logs 默认不抓原始内容。外部内容不可信，不得触发授权、命令或记忆更新。

### Issue 写入（GH-03）

能力按 operation 分开：issue.create、issue.update（允许字段）、issue.comment；关闭/重开不默认开启，删除/合并/直接 push main 禁止。首版建议单隔离 repo 的 fine-grained PAT（Issues write + 最小读权限），与 read credential 分离；长线 GitHub App installation token，按安装 repo 与 operation 限制。保留 OAuth flow，不能借 OAuth 的宽 scope 自动给写权限。具体凭据由 owner 配置，禁止提交秘密。

每个 action 显示 repo、目标、前后 diff、参数 hash、审批 TTL；批准、执行、reconcile 重新检查 owner/revision/授权/目标/预算；无写预授权，无无人值守写。create/comment 用持久 request ID 与可核对的隐藏操作 marker；写后 GET 核验实际资源 ID、正文/字段、URL；unknown 不盲重试。update 写前重读、比较 before hash/updated_at、冲突暂停；GitHub API 不保证原子 CAS，不能宣称消除全部人类并发竞态，写后校验并暴露残余。拒绝 PR-as-issue 混淆，不允许 agent 无差别覆盖人工正文。故障与重复副作用测试仅在明确批准的隔离仓库。

### Project Manager 工作流（GH-04）

inspect→compare→findings→propose→approve→apply→verify→report。输入含 repo、固定 ref、计划路径、目标验收；输出 Finding 候选字段：id、severity、requirementRef、codeRef/API receipt、observed/inferred、impact、repro、suggestion、existingIssueRef、evidenceGap。报告区分实际测试执行、CI 结果、静态推断、模型分析；缺证据不声明完成。已有 Issue 先匹配、展示差异，重复运行不重复建；原则上一个 finding 一个归属，多个互相关联可合并。owner 审批具体写入，写后核对。计划文档维护先输出 diff 草稿，实际文档 PR 走 GH-05；本阶段不要求通用文档写工具。

### Coding Agent Adapter（GH-05）

先选择一个真实 CLI（Codex CLI 或 OpenCode，owner 决策），而非同时接全部。候选 contract：start(spec)→jobId、status、logs、cancel、resume（只有支持时）、artifacts。spec 含 repo/base SHA、Issue revision/验收、允许操作/命令/文件、deadline、budget、credential grant。Job 绑定 Assignment/Session，持久 ID、进程与心跳、终止和未知状态核对；不可靠 resume 必须显式降级/人工处置。

每 Task 独立 clone 或 worktree/feature branch（agent/<task-id>）；worktree 不是安全隔离，需独立 HOME/进程/文件系统/网络与秘密隔离，禁止继承 Agent 主机/飞书/全权 GitHub credentials，禁止 shell 字符串拼接与任意执行；以明确 capability 允许最小操作。独立的 branch push / PR credential 与 issue write credential 分离；owner 明确批准后推 feature branch 并建 Draft PR；不直接 main、不 force push、不改分支保护/仓库设置、不生产部署。没有可靠隔离则仅生成人工执行 Coding 指令。收集真实命令 exit code、日志摘要、diff、base/head SHA、测试结果，取消终止进程树并核对外部副作用；绝不自动 merge。

### Review / 持续工作（GH-06）

Reviewer 独立 Assignment，读取固定 head/base、原 Issue、diff、实际测试、CI required checks。输出 blocker/non-blocker 与来源；head 更新即失效，不将开发 Worker 自述视为独立验收。CI pending/skipped/infra/billing failure 与真实代码失败分开。返工次数与总时长有界，主人最终确认合并。按现有 SchedulePolicy 增加 project read-only digest，先轮询、webhook 后置，weekly/内部状态报告归 #9；runKey 持久去重，权限撤销/预算未知不新发付费调用，不自动写 Issue、不自动派遣付费开发。复用 #7/#9/#28 的 guard；需 token/成本或等价经过 owner 确认的可强制硬额度，不能只用可选 Magpie fail-open 作为护栏。

## 4. 实际验收

| 场景 | 可核对结果 |
| --- | --- |
| GH01 | 真实飞书消息→指定 private repo 只读 API→可核对来源→用户收到 |
| GH02 | 两个项目绑定，授权/数据/记忆不串；未授权拒绝 |
| GH03 | 固定 SHA 规划/源码、PR diff/check 状态；部分结果明确 |
| GH04 | 对照真实需求与代码，证据化 finding/待办草稿，重复运行匹配现有 Issue |
| GH05 | 隔离 repo 经批准 create/update/comment，GET 核对；拒绝/撤销零写，重放不重复 |
| GH06 | 从评估到审批、写入、核验与真实飞书回报全链路 |
| GH07 | 真实 Coding Agent 小修复、隔离、测试、授权后 Draft PR |
| GH08 | 独立 Review 与 SHA/CI/需求一致，新 head 令旧评审失效 |
| GH09 | 取消/重启/预算/注入/跨 repo/人类并发变更，安全失败、无越权及测试内重复副作用 |
| GH10 | 周期真实汇报与重启去重；未知预算不启动，不自动写 |

L2 需 GH01–06 与相关 GH09；L3 pilot 需 GH07–10 与相应 #41 原验收。不以 mock、注入飞书事件、模型自述替代真实用户/工具。每项记录实际 SHA、E1/E3/E4、provider、输入与期望、trace、API/DB/实际收件、成本/延迟、PASS/FAIL/PARTIAL/BLOCKED。凭据和私聊原文脱敏。建议 L2 后连续 7 天自用，记录每项目耗时、草稿接受率、重复/错误待办率、人工干预和已知成本；目标阈值后续依据真实样本确定，不编造 Benchmark。

## 5. 实施节奏（工作预算，不保证工期）

- Sprint A：GH-00/01，恢复 CI、真实飞书、真实授权 G1，安全阻断修复；准备隔离仓库。
- Sprint B：GH-02，多项目绑定与证据化只读评估；先实现真实计划/源码/PR diff/CI 读取。
- Sprint C：GH-03/04，最小 Issue 写入与审批，完成从评估到待办的 L2 真实闭环。
- Sprint D（L2通过后）：GH-05 单 adapter、隔离、实际测试、Draft PR。
- Sprint E：GH-06 独立审查/CI/主动汇报，L3 pilot，持续自用数据反哺改进。

每个工作包独立 feature branch/PR、CI/Review，更新 #65/#41 与验收证据。不要以关闭 Issue 替代真实验收；不在本阶段引入 Desktop、动态多模型、完整 Organization、通用插件平台、自动合并或复杂调度。现有路线长期保留。

## 6. 待 owner 确认（不是已授权执行）

- D01/D03：真实模型与费用上限、常驻机器、真实飞书与 GitHub 凭据。
- D21 保留个人 OAuth 决策；新增写授权建议独立 fine-grained PAT，正式 GitHub App 评估后再迁移。测试 repo、实际可读/写 repo、允许 operation、审批范围由 owner 明确确认。
- 首个 Coding Agent CLI、独立执行机器/隔离方式、允许命令、网络与支出上限，均需真实配置和确认。
- 默认手动触发、只读优先，合并权始终主人保留。仓库规划编辑授权不等于允许运行 Agent 产生真实外部写、付费或授权扩大。
