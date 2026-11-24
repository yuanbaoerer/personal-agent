# 24 · GitHub Project Management MVP 与 Development Orchestrator

> **2026-11-20 插件化依赖更新（本条优先于原工作包入口）**：见 [25 · Extension Platform](25-extension-platform.md) / [#73](https://github.com/yuanbaoerer/personal-agent/issues/73)。GH-00/01 与 EXT-01 并行，EXT-02 迁移现有 GitHub connector/OAuth；GH-02 #60 依赖共同 catalog/broker，EXT-03 官方 MCP 只读对照与 REST 扩展并行（保留已验证 REST 回退）；GH-03 #61 写能力通过 plugin typed Action 与 Core 审批/核验，GH-04 #62 使用 EXT-04 skills。GH-05 #63 是第二类 Runtime Plugin，GH-06 独立审查/主动汇报，验证 V2 SDK；V3 长期必选但不阻断 L2。避免先实现 GitHub 专用第二套 registry。所有 #41/#65 原验收及安全前置不变。

> 本篇从设计基线 `c42243b` 起记录 [#65](https://github.com/yuanbaoerer/personal-agent/issues/65)。§7–12 记录已合并的 L2 读取、草稿、审批与写后核对；§1 的完成条件不是发布声明。[核心 MVP 的原验收门槛](21-mvp-functional-ready.md)不变。

## 1. 产品目标与检查点

主人通过飞书管理多个授权 GitHub 项目：检查开发进展、结合规划与源码识别缺陷、维护实施待办、派遣 Coding Agent、跟踪测试和 PR、独立 Review 并汇报。核心价值是减少主人在需求→Issue→开发→验收的重复编排，而不是增加模型数量。

| 检查点 | 用户价值 | 完成条件 |
| --- | --- | --- |
| Reliable Core / Functional Ready | 可靠执行、真实通信、恢复、权限与预算 | #41 M01–M14；原正式版本门槛不变 |
| L1 Repository Observer | 查询真实项目状态及源码证据 | GH-01/02 |
| L2 Project Manager MVP（下一产品目标） | 评估实施、生成待办、授权后更新 Issue | GH-01–04 实际闭环及相应安全负例 |
| L3 Development Orchestrator Pilot | Issue→Coding Agent→测试→Draft PR→独立 Review | GH-05/06 实际闭环及恢复 |
| L4 Autonomous Maintainer（后续） | 有界的持续监控、需求识别、返工与主人决策 | 先有连续使用证据；自动写/合并不在本阶段 |

**验收现状**：ProjectBinding、固定 SHA 的 typed reads、只读项目评估和受控 Issue 写入已合并。[合并后的真实只读评估](acceptance/2026-11-22-real-project-review.md)核对了引用与结构化声明，生成待批草稿，未投递到真实飞书、未写 GitHub。另一次[真实飞书计划执行](acceptance/2026-11-22-conversational-planning-runbook.md)完成两步读取，第三步未生成最终评估。两次运行不能拼成 L2 通过。下一项是交付同一运行的最终飞书报告；写入须在[指定隔离仓库单独验收](22-mvp-acceptance-runbook.md)。

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

2026-11-21 首批实现：`pa_projects` 持久化 owner-scoped projectKey、不可变 repositoryId、repositoryFullName、defaultBranch、credentialRef、allowedPlanPaths、status/version；`ProjectService` 拒绝跨 owner/重复 key/重复 repo，同一 immutable ID 下可按 bind 更新 display name/branch/credentialRef/plan paths（递增版本），revoke 保留历史并递增版本。`/api/v1/projects`（list/get/bind/unbind）与 `pa projects` 已接入，audit 记录 project.bound/updated/unbound。尚未把绑定强制接入 GitHub read tool、Task/Mandate 或待执行 Action；这是 B2/C1 的下一条，不能只因数据表存在就宣称 GH02 完成。

### GitHub 读取（GH-01/02）

先以真实精确 repo 的 fine-grained read-only PAT 检查 G1，保留已选 D21 OAuth App（OAuth repo scope 宽于只读）；配置、撤销和负例均留证。读取工具扩展为 typed operations：repo/ref/commit、tree/file、Issue detail、PR changed files/diff、checks/workflow status。固定 commit SHA；PR 绑定 base/head；返回 provenance、路径/行号、永久 URL、truncated/unknown。遵守现有限额，新增任务累计页数/字节/时长上限；不得通用任意 HTTP URL、全仓库无界抓取、执行仓库文本；拒绝二进制/超限及敏感路径，CI logs 默认不抓原始内容。外部内容不可信，不得触发授权、命令或记忆更新。

2026-11-21 typed read 首批实现：`github.read` 新增 `ref`、`tree`、`file`、`issue`、`pull_files`、`checks`。tree/file/checks 必须传固定 40 位 commit SHA；file path 拒绝绝对路径和 `..`；ref/tree/file/issue/PR files/checks 必须传 `projectKey`，由当前 owner 的 active ProjectBinding 解析 repo，再与 repo allowlist 取交集；绑定 missing/revoked、repo 不匹配或未配置 resolver 均在 fetch 前拒绝。PR files/checks 仍受 limit 约束；返回固定 SHA 的 source URL、路径/SHA、truncated/coverage 和 patch/content 截断标记。credentialRef 仍只做绑定元数据，token 仍来自全局 PAT/OAuth；Issue 写、CI log 原文、全仓库抓取和真实私有仓库复验未实现，GH02 不能因该 typed read 完成而关闭。

2026-11-21 B3/B4/B5/C1 已合并（#86–#88）。绑定内的读取使用 `credentialRef` 并核对不可变的 GitHub repository ID，Node 运行时按凭据版本短期缓存仓库身份核验。`checks` 区分 check-runs 和 commit status 的覆盖范围。真实私有仓库 E3、第二项目隔离、真实模型遵循性和飞书收件仍待验收。

只读评估示例：`--project=alpha 对照 docs/plan.md 审查项目实施情况`。聊天入口从当前主人的有效绑定确定仓库。任务级 typed read 要求匹配 `mandate.project` 的 `projectKey`。`pull_files` 在读取前后检查 base 和 head，最多重试一次，持续变化标为 `stale`，分页截断标为 `partial`。评估逐条核对引用和结构化 GitHub 声明，检查行号与正文范围，并在报告中标注证据缺口和模型分析。Issue 草稿只供主人审阅，更新草稿从完整 Issue 正文回执取得 `beforeHash`。

### Issue 写入（GH-03）

能力按 operation 分开：issue.create、issue.update（允许字段）、issue.comment；关闭/重开不默认开启，删除/合并/直接 push main 禁止。首版建议单隔离 repo 的 fine-grained PAT（Issues write + 最小读权限），与 read credential 分离；长线 GitHub App installation token，按安装 repo 与 operation 限制。保留 OAuth flow，不能借 OAuth 的宽 scope 自动给写权限。具体凭据由 owner 配置，禁止提交秘密。

每个 action 显示 repo、目标、前后 diff、参数 hash、审批 TTL；批准、执行、reconcile 重新检查 owner/revision/授权/目标/预算；无写预授权，无无人值守写。create/comment 用持久 request ID 与可核对的隐藏操作 marker；写后 GET 核验实际资源 ID、正文/字段、URL；unknown 不盲重试。update 写前重读、比较 before hash/updated_at、冲突暂停；GitHub API 不保证原子 CAS，不能宣称消除全部人类并发竞态，写后校验并暴露残余。拒绝 PR-as-issue 混淆，不允许 agent 无差别覆盖人工正文。故障与重复副作用测试仅在明确批准的隔离仓库。

### Project Manager 工作流（GH-04）

inspect→compare→findings→propose→approve→apply→verify→report。输入含 repo、固定 ref、计划路径、目标验收；输出 Finding 候选字段：id、severity、requirementRef、codeRef/API receipt、observed/inferred、impact、repro、suggestion、existingIssueRef、evidenceGap。报告区分实际测试执行、CI 结果、静态推断、模型分析；缺证据不声明完成。已有 Issue 先匹配、展示差异，重复运行不重复建；原则上一个 finding 一个归属，多个互相关联可合并。owner 审批具体写入，写后核对。计划文档维护先输出 diff 草稿，实际文档 PR 走 GH-05；本阶段不要求通用文档写工具。

### Coding Agent Adapter（GH-05）

**交互编程与后台开发分开验收。** 当前优先交付的是[飞书 ↔ 已打开的 omp 会话](../README.md#飞书使用本机-omp)：本地选择工作区，飞书 owner 配对后连续读、改、测试；退出、断线不重新执行。它不依赖通过只读 C04/C11，也不代表 GH-05 的隔离 Worker、推送凭据或 Draft PR 已实现。下列契约仅用于未来由服务在开发机离线时自行派工的路线。

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

## 7. 2026-11-22 L2R-01：Credential Scope 与确定性项目解析

**状态：CODE_COMPLETE + E1_PASS；真实 OAuth/PAT 负例仍为 BLOCKED（需 owner 凭据）。**

- `CredentialBroker` 现支持 owner、plugin、account、repositoryIds、scopes、expiry、version 元数据，并通过 `pa_credential_refs` 持久化非秘密元数据；secret 仍只来自 OAuth 加密库或进程环境。
- 未声明 scopes 的凭据不获得任何 scope（fail closed）；现有 `github:default` 必须显式声明 `repository.read`。`issues.write` 只能由独立 write ref 显式声明，不会自动升级。
- owner/repository 绑定在 `resolve` 时校验；重启通过 `restore` 保留 epoch 与 revoked 状态，OAuth disconnect 后重启仍是 revoked，重新连接走 `rotate` 递增 epoch。
- Router 只依据 owner 的 active ProjectBinding 解析 projectKey：支持 `--project=`、完整 `owner/name`、消息中的精确 projectKey；名称歧义、未绑定项目、模型选择与主人指定冲突均拒绝，不猜测仓库。
- 解析后的 Task criteria 固定 `repo`、`repositoryId`、`projectKey`、`defaultBranch`、`allowedPlanPaths`、binding version；`project-review` Verifier 拒绝跨 repository/project 的 finding。
- E1：466 tests passed（`npm test`）；覆盖 credential scope/owner/repo/restart、rounter 项目解析、绑定 criteria、verifier 越界拒绝。
- 仍缺：真实 OAuth 登录/切账号/撤销、真实 Feishu 入站与真实模型 project review（E3）。

## 8. 2026-11-22 L2R-02：只读 Project Review E2E 与安全负例

**状态：CODE_COMPLETE + E1_PASS；真实模型/真实飞书 E3 见验收记录。**

- 新增强制只读项目评估回归：Router → ProjectBinding → Task/Mandate → `github.read` typed reads（repo/ref/two files/pull_files/checks/issues/issue detail）→ findings/issue drafts → `project-review` Verifier → Outbox。
- 修复复合请求守卫：显式 `只读`/`不要修改 GitHub` 的项目评估不再被误判为“状态查询 + 变更操作”。
- receipt 截断检测下沉到嵌套字段（file content、issue body、patch、check output）；引用截断来源却声明 `coverage=complete` 会被 Verifier 拒绝。
- 安全负例：错误 projectKey、task mandate 不符、跨 owner、绑定撤销、缺失/撤销凭据、repositoryId 不匹配、PR head 漂移、跨 revision finding、settled action 重放；均在任何 fetch 前或 Verifier 处失败。
- E1：`project-review-e2e.test.ts` 覆盖 raw Feishu 事件 → FeishuAdapter.parseRequest → Ingress → Router → ProjectBinding → typed reads → findings/drafts → Verifier → Outbox → Feishu send API（fake HTTP，含 platform message id）；真实飞书 E3 仍 BLOCKED。
- 真实模型 + 真实 GitHub 只读取证已在合并后的 main `19427b03…` 上通过（repoId 1445007789，3 observed findings、3 pending drafts、Verifier succeeded；`externalFactsVerified=false` 表示仅引用/claim 已核验，叙述结论未独立验证）；记录见 [docs/acceptance/2026-11-22-real-project-review.md](acceptance/2026-11-22-real-project-review.md)。真实飞书入站/收件仍是 BLOCKED，不能据此标记 A5/E3 完成。

## 9. 2026-11-22 L2W-01：DraftSnapshot 生命周期

**状态：CODE_COMPLETE + E1_PASS；本阶段不执行 GitHub 写入。**

- 通过 `project-review` Verifier 的草稿持久化到 `pa_issue_drafts`：目标 repo/repoId、source task/revision/assignment、commit SHA、findings、action/targetIssue、beforeHash/beforeSummary、payloadHash、idempotencyKey、credentialRef/version、状态与过期时间。
- 草稿只在 Verifier 成功后由 TaskService 在同一事务内持久化；未通过验证的报告不会产生审批对象。
- 重复评估按 `(owner, repositoryId, idempotencyKey)` 去重：同 payload/同 revision/同 findings 复用原行；payload 变化时旧行 superseded，新行重新待审批。
- 失效检查：expiry、source task revision/cancel/fail、ProjectBinding 解绑或更新、credential revoke/rotate 都会使旧草稿 superseded；ProjectService 解绑/更新时主动失效。
- 审批载荷 `payloadHash` 由程序计算，绑定 repoId、commit、action、目标 Issue、标题、正文与 idempotencyKey；外部 Issue 被修改的校验将在 Approval Bridge 写前重新读取时执行。
- API/CLI：`GET /api/v1/drafts`、`GET /api/v1/drafts/:id`、`POST /api/v1/drafts/:id/reject`；`pa drafts list|show|reject`，展示目标 repo/Issue、来源、before/after、payloadHash 与过期时间。
- E1：全量 480 tests passed，覆盖持久化、去重、reject、revision/binding/credential 失效、expiry 与 API/CLI 权限。
- 未实现（L2W-02）：owner approve 命令、写入 Action、GitHub API 调用。当前没有任何写路径。

## 10. 2026-11-22 L2W-02：Approval Bridge 与受控 Issue 写入

**状态：CODE_COMPLETE + E1_PASS；真实写 E3 BLOCKED（需 owner 指定隔离测试仓库与 Issues-write 凭据）。**

- Typed Actions：`github.issue.create`、`github.issue.update`、`github.issue.comment`。只允许这三种；不存在 merge/push/delete/settings/branch-protection/MCP 写路径。
- 每个 Action 绑定：owner、projectKey、active ProjectBinding、immutable repositoryId/full name、独立 write credentialRef 版本、`repository.read` + `issues.write` scope、task revision、plugin generation/version、target issue、payloadHash、idempotencyKey、Action TTL。
- 写凭据必须由 owner 显式配置 `GITHUB_ISSUE_WRITE_TOKEN` + `GITHUB_ISSUE_WRITE_REPOS`，注册为独立 ref（默认 `github:issues`）；ProjectBinding 的 `credentialRef` 继续只用于只读读取。只读 PAT/OAuth 不会自动获得写权限，写入 token 也不会被读取路径复用。Token 仅存于内存/OAuth vault，action/task/log 不出现 token。
- Owner 审批：`/draft list|show <id>|approve <id> <payloadHash>|reject <id>`。批准命令绑定 draft payloadHash；兼容 `pa drafts`/`/api/v1/drafts`。批准前还会读取当前 default branch ref，要求仍等于 draft 的 `commitSha`；仓库已前进则旧草稿 superseded。
- Bridge 在批准时重新校验：draft validity、task revision、binding、write credential epoch、write capability、payloadHash；随后创建专用 external-action Task（不派发 Worker）→ 生成 typed Action → 使用 ActionService 现有 approve/execute/reconcile 链路执行。draft pending→executing 使用 CAS；若 owner 在批准期间 reject/expire，刚批准的 action 会被立即撤回，不会写入。
- 写前：update/comment 先 GET issue，拒绝 PR-as-issue；update 比较 `beforeHash = sha256(title + "\n" + body)`，标题或正文被人工修改都立即失败并要求重新批准；不声称 GitHub 提供原子 CAS。
- 幂等：create/comment 使用持久 idempotency marker，marker 前置并包含 payloadHash，旧 key/旧 payload 的 artifact 不能满足新批准；reconcile 扫描最新有界分页，超过页预算 fail closed；update 在写前发现已是目标状态则 no-op。title-only update 必须实际 PATCH，不允许假成功。
- 写后：GET 资源核对 issue/comment id、URL、正文/marker；失败或超时标记 unknown 并先 reconcile，绝不盲目重试 POST；ActionService 的 lease/revision/plugin/credential fence 继续生效。结算只允许从 `executing` 迁移，写入期间被 binding/credential/task 失效的草稿不会被“复活”为 approved，write task 进入 needs_review。
- E1：`github-issue.test.ts` 覆盖 create/update/comment、重复、scope/owner/repoId/allowlist/epoch、lost POST、conflict、429；`draft-approval.test.ts` 覆盖 approve/replay/reject/binding revoke/credential rotation/unknown reconcile/update conflict/comment/429/重启后 reconcile。全量 519 tests passed。
- 真实写验收未执行：没有 owner 指定的隔离测试仓库与 Issues-write 凭据；不得在业务仓库试故障或写入。具体 owner 操作与预期证据见 [docs/acceptance/2026-11-22-l2-blocked.md](acceptance/2026-11-22-l2-blocked.md)。


## 11. 2026-11-22 Stage D：无人值守预算 fail-closed

- `SchedulePolicyService` 在 `BUDGET_MAX_MODEL_CALLS_PER_DAY` 未配置时拒绝触发周期任务：记录 `schedule_policy.skipped(reason=budget_unknown)` 并推进下一次 occurrence，不创建 Task、不调用模型。
- 配置每日模型请求上限后才允许无人值守周期任务；单任务请求上限仍由 CallBudget 持久计数。
- 本轮不自动启用周期项目写入；L2W 写入只能由 owner `/draft approve` 触发。
- 仍缺真实 token/费用采集与 owner 确认的成本阈值；不宣称 #7 完全关闭。


## 12. 2026-11-22 L2W-04：Feishu 全链路 E1

- 写路径 Feishu E1：`/draft approve` → 受控写入 → 写后核对 → 审批 Task 结算 → Outbox → Feishu send（fake HTTP，断言 issue URL 与 platform message id）。
- 新增确定性全链路回归：构造 Feishu 2.0 原始事件（`im.message.receive_v1`，owner p2p），经 `FeishuAdapter.parseRequest` 校验 token/app_id → Ingress → Router → ProjectBinding → Task → GitHub typed reads → findings/drafts → `project-review` Verifier → OutboxDispatcher → `FeishuAdapter.send`。
- Fake Feishu HTTP 返回 tenant token 与 `data.message_id`；断言 Outbox 行 `accepted`、platform message id 存在、实际发送文本包含“项目评估（结构化证据已核对）”和“待办草稿”。
- 取消 write task、write task revision 变化、approval 后禁用插件均不会产生 GitHub 写请求；草稿进入 superseded。
- 这不是 E3：没有真实 Feishu 客户端入站/收件；真实 E3 仍按 [blocked record](acceptance/2026-11-22-l2-blocked.md) 由 owner 执行。

## 13. GH-05/06 multi-Harness execution refinement（2026-11-24）
[30](30-multi-harness-worker-runtime.md) 是 #63 Coding Adapter 和 #64 独立 Review 的执行契约。先 MH-00/01 兼容与隔离设计，MH-02 单真实 driver（Codex 推荐候选，待 Spike），MH-03 ACP/OMP 第二 driver + Gateway 兼容，MH-04 L3。不是要求所有 Harness 在 L3 同时上线；可先用经验证单 driver 完成受控试验，其他作为兼容增量。Issue→隔离 workspace→独立测试→Core typed Action/审批控制 Draft PR→独立 Review 固定 SHA；外部 Agent 无直接 GitHub write credential，禁止直接 main push/自动 merge。现有 L2、#41、#92 与写权限门槛不变。
