# 27 · 下一阶段交付计划：Extension V1 收尾 → GitHub Project Manager L2

> **当前执行入口（2026-11-21）** · main `d2e6896a2e144e0c8c0f98cb3252865fc12531ef`。本篇覆盖“下一步先做什么、如何拆 PR、用什么证据验收”，与 [07 长期路线图](07-long-term-roadmap.md)、[21 MVP Functional Ready](21-mvp-functional-ready.md)、[24 GitHub 项目管理](24-github-project-management.md)、[25 插件平台](25-extension-platform.md)、[26 MCP Host](26-mcp-host.md) 协同。**本篇优先于它们的历史性“当前下一步”段落**，不修改原产品目标和正式版本门槛。追踪：[Core #41](https://github.com/yuanbaoerer/personal-agent/issues/41) / [GitHub L2 #65](https://github.com/yuanbaoerer/personal-agent/issues/65) / [Extension #73](https://github.com/yuanbaoerer/personal-agent/issues/73)。

## 0. 当前事实与不得误报的状态

| 项目 | 已有可核对证据 | 仍需完成 |
| --- | --- | --- |
| EXT-01 #67 | PR #74/#78：受信内置 manifest/catalog，持久 enable/disable、Task/Action generation fence，CLI/API | 多插件互不相关的 generation 失效范围；部分 GitHub verifier/schedule 专有路径；Node-only |
| EXT-02 #68 | PR #74/#77：保留 GitHub REST `github.read`、PAT/现有 OAuth、白名单、凭据 epoch；私有仓库真读 | 统一 credentialRef/broker、login/status/logout CLI、真实浏览器 OAuth 登录/撤销/换账号负例 |
| EXT-03 #69 | PR #76/#79：Node remote Streamable HTTP 只读 MCP，真实 GitHub MCP 两项 read 对照，URL/DNS/IP pinning | #80 只读语义信任边界；OAuth/stdio/resume/cancel/写路径未实现 |
| EXT-04 #70 | PR #75/#78：SKILL.md digest/路径/大小校验及按需注入；任务级 ExtensionPolicy | 真模型遵循 Skill 的行为证据；完整 ModeCatalog 不在 L2 阻断路径 |
| Core / CI | GitHub Actions main run `44861731421` 四项（test/macOS/Windows/install-smoke）成功，test 日志 427 pass/0 fail | 真实 owner Feishu 入站→模型/工具→同会话投递、真实安全/恢复/预算完整验收；不可因 CI 绿就关闭 #41 |
| GitHub 产品 | [真实 REST G1 记录](acceptance/2026-11-20-real-github-g1.md)、[真实 MCP read 记录](acceptance/2026-11-20-real-github-mcp.md)、单次飞书出站 API accepted | 固定 SHA 源码/规划/PR diff/CI 读取、项目绑定、真实模型 project-review、Issue 审批式写闭环 |

**明确区分**：记录的真实 G1 来自 in-memory createApp/本机 gh token；出站 API 接受不等于 owner 从飞书输入并完整收到对应请求结果。Skill 真实读取使用 FakeRuntime 捕获 prompt，尚未证明真实模型能按 Skill 完成项目评估。GitHub 项目管理 L2 未交付。不要把“已合并”“测试 pass”“MCP 工具发现”替换成真实业务 PASS。

## 1. 本轮产品目标、范围与停止规则

**下一业务检查点 L2**：owner 在真实飞书私聊提出“检查 personal-agent 最新实施与规划差距、生成待办并在批准后更新 Issue”；Agent 以明确绑定的项目和固定 Git SHA 读取实际计划/源码/PR/checks，输出来源可核对的 Finding，去重既有 Issue，展示变更草稿，请求 owner 对具体操作批准后在被授权的 GitHub 仓库写入，GET 核对结果并回复飞书。

- **本轮必须做**：#80 信任边界、#68 连接管理实际关键路径与 E3、#60 固定 SHA 证据及多项目作用域、#62 只读分析/待办草稿、#61 隔离仓库审批式 Issue 写、#65 GH01–06 及有关 GH09，#41 与安全预算相关真实场景。
- **允许并行**：内置 REST 固定 SHA 只读扩展和 #80 修复；文档/Issue 草稿（零外部写）和 OAuth 验收；CI 保持绿。
- **本轮不做**：重新建设 ToolRegistry、通用 workflow DSL、插件市场、第三方代码动态安装、自动合并 PR、direct push main、任意 shell/code execution、完整 MCP 写穿透、通用 ModeCatalog 重构、一次适配多个 Coding Agent。
- **阻断条件**：高风险操作若存在确认权限/凭据/目标不明、MCP 真实副作用分类未核验、预算未知、未知外部写结果未核对、回执无法追溯，必须拒绝/暂停、留下审计、请求人工处理；不能在生产项目“试试再说”。`#80` 对扩充任意 MCP 工具或 MCP 写路径是前置，REST 有界只读不必等待它；`#7/#28` 对无人值守付费、真实外部写开关是前置。

## 2. 有向依赖与建议 PR 拆分（可并行，不保证工期）

| 顺序/PR | Issue | 代码范围与交付物 | 必要验收 |
| --- | --- | --- | --- |
| A1（先做安全边界） | #80 #69 #28 | `plugins/mcp.ts` 只读语义白名单/可信 tool mapping、manifest/credential 约束；必要时拆安全配置；禁止未知远端 method 标只读 | Fake remote mutation 负例、未核验方法不注册/不执行；#79 地址固定回归；无真实写 |
| A2（并行真实联调） | #68 #8 #38 #41 | 复用 OAuth/现有 vault 的 Credential Broker 最小抽象、`pa plugins login/status/logout github`（实现中允许先拆独立 PR）、账号/epoch；真实 owner 飞书入站→GitHub 只读→可核对报告→飞书出站 | 本人真实飞书客户端收发；浏览器 OAuth/撤销/切账号须 owner 凭据；缺凭据 BLOCKED；PAT 可单独完成 GET |
| A3（安全前置，和 A2 并行） | #7 #9 #28 #39 | 后台/计划服务层预算 fail-closed、真实工具次数及总 Task 时限、Stable task reference 对应最近展示列表快照或不明确目标确认、claims 创建入口一致性 | 重启、重复/并发、撤权、超额、负例；只读/手动操作不被无必要阻断 |
| B1 | #60 | 项目绑定数据层/API/CLI + owner/project/repo immutable ID/credentialRef 管理、显式 bind/unbind、授权交集；严格项目解析 | 两个已授权项目隔离，撤销、重命名/转移、非法 repo/权限负例；迁移及恢复 |
| B2（可随 B1 拆） | #60 #10 | GitHub Plugin **typed REST read**：固定 SHA 的文件/目录/tree、Issue detail、PR changed files/diff、check run/status；引用 provenance | 实际 private repo 文件/PR/check 检索，base/head SHA、永久 URL/路径/行、truncated/unknown；限额与提示注入测试 |
| C1（只读业务先交） | #62 #70 | Project Review 受控 task profile、Skill 选择、Evidence/Requirement/Finding/Draft Schema；计划对照、Issue 去重、审查结果回传；默认零外部写 | 真实模型读固定 SHA 规划与源码，产出可定位 findings；静态推断和测试事实分开；无证据标 unknown；复跑不重建草稿 |
| D1（外部写安全门槛通过后） | #61 #4 #28 | GitHub Plugin typed `issue.create/update/comment`、独立最小范围写凭据、审批与参数/版本绑定；write receipt/reconcile/read-after-write | 仅明确授权的隔离 repo：批准/拒绝、重复、超时/429、断电/重启、跨仓库、人工并发修改、写后 GET；禁止自动关闭/合并 |
| D2（L2 完成） | #62 #65 #41 | 将 C1 Draft → Confirmation → D1 Action → Verify → 飞书 Report 串成持久可恢复状态；更新验收文档 | 真实 owner 私聊完整闭环 GH01–06、相关 GH09；明确人工合并决定，不自动打勾 |

**建议执行顺序**：现在先 A1 与 A2，B1/B2 只读可同时开始；C1 依赖 B2 的证据；D1 先过 A1/A3 与审批/授权安全；D2 依赖 C1/D1。每 PR 小粒度，只针对对应层，保留现有 ToolRegistry、ActionTool、CompletionVerifier、数据库及旧 `github.read` 兼容；迁移不重复构建平行 Core。

## 3. 关键数据与接口契约（工程 PR 应明确）

### 3.1 ProjectBinding（#60）

建议最小持久字段：`id`、`owner_id`、`project_key`、`repository_id`（GitHub 不可变 ID）、`repository_full_name`（展示/校验）、`default_branch`、`credential_ref`、`allowed_plan_paths`、`status`、`version`、`created_at`、`updated_at`。关系：单 project 映射单 repo，一个 owner 可有多个项目；暂不做跨 repo 聚合。project_key 为本地 stable key，与仓库名字不同；owner/project/repo/credential scope/Mandate/ExtensionPolicy 必须取交集，不得根据自然语言默默切换项目或扩大授权。

`bind(project, repo)`、`list/get`、`unbind` 的真实状态通过现有 Client API + CLI 暴露，`unbind` 影响新的任务与待执行 Action（以审计记录），历史 receipt 不抹除。跨项目同名、缺绑定、权限失效应要求澄清或拒绝。授权 scope 更改时 credential epoch/generation fence 不得遗漏；保留旧数据迁移可回滚。具体表名/API 命名以源码及 PR Review 确认，不预设大范围重构。

### 3.2 证据读取与体积预算（#60）

新增 typed `github.read` operation 或明确 namespace 的多个只读工具，建议功能：`ref.resolve`、`tree.list`、`file.read`、`issue.get`、`pull.files`、`checks.list`。不提供用户任意 URL、HTTP 方法或 shell；原 repo/commits/issues/pulls/pull 保持兼容。**所有代码内容必须按已解析固定 SHA 读取**；PR 的 base/head 分开标记。结果最小结构包含 `repoId`、`repo`、`refSha`、`operation`、`resourceId/path`、`sourceUrl`（prefer immutable permalink）、`items`、`truncated`、`coverage`、`error/unknown`、`receiptId`；可见实体路径与行范围需要能由外部核对。对分页/树深度/字节/单 Task 读取总量设有限默认值，超限中止并保留 coverage，不全仓库无限抓取；拒绝二进制/超过上限文件、敏感路径与未经授权的日志。检查状态区分 pass/fail/pending/skipped/infra/billing/unknown，不能以缺失视为成功。

### 3.3 Finding / Draft / Completion（#62）

Finding：`findingId`、`projectId`、`requirementRef`、`severity`、`classification(observed|inferred|unknown)`、`evidenceRefs`（receiptId、SHA、path/line、issue/PR URL）、`impact`、`proposedAction`、`existingIssueMatches`、`confidence/evidenceGap`。Draft：`targetRepoId`、`action(create|update|comment)`、`targetIssueId?`、`beforeRevision/updatedAt?`、`proposedPayload`、`sourceFindingIds`、`idempotencyKey`、`requiresOwnerApproval=true`。

报告必须区分：代码静态观察、实际执行测试、CI 记录、模型推断；没运行测试不说测试通过。草稿去重先查现有 Issue，再展示修改前后差异。技能文档只是指导；结构化证据、参数、审批和最终 verify 由 Core 程序执行；禁止引用过期 SHA 的结果自动落地写操作。事实 Claim 校验复用 #10；新工具结果必须有对应 receipt 与字段核对，不能把自由文本标为事实核验通过。

### 3.4 Issue 受控写（#61）

最小 tool `github.issue.create`、`github.issue.update`、`github.issue.comment`；创建时防重复 request marker + 真实 GET 核验，更新需在写前重新读取具体 issue 内容和 revision/updatedAt，遇冲突暂停让主人重新批准（GitHub REST 不提供通用原子 CAS，不得宣称完全避免竞态）。外部成功但本地失败进入 unknown，先 reconcile 再允许重试；不能无限调用 POST。独立凭据（测试 repo / Issues write）、写入 capability 与 owner+repo+operation+target+payloadHash+revision+TTL 绑定；显示实际变更内容。操作执行前、reconcile 前检查最新授权、plugin generation、预算与 Task fence。未经主人授权不可在现有业务仓库进行真实写测试；直接 main push / merge / delete / 大批量修改都不包含在 L2。

## 4. 安全及稳定性门槛

- **#80 MCP 语义只读**：当前 mcp.ts 把宿主配置声明的任意远程方法标记只读，是基于源码的信任边界风险，**不是已证实的攻击**。宿主需有可审核的 provider+tool+版本/证据映射，配合最小只读凭据/能力强制约束；未知或可能写入的方法拒绝挂入 read-only manifest，不能仅凭工具名称、远端 annotations 或模型判断。fake 服务提供伪装 read/实际 write 测试；真实写仅隔离 repo。保留 #79 IP pinning；trustedHosts 是明确高信任配置例外。
- **#7/#9 无人值守预算**：先有服务层统一 guard 在 confirm/resume/fire/真正模型开始前核对硬额度及撤销；未配置/未知/超额 fail-closed。记录每 Task 模型调用、真实工具尝试与重试、总时长、计划日运行；不把可选 Magpie fail-open 当安全额度。普通手动只读不因后台规则无谓拒绝。
- **#39 稳定目标**：序数“第二个任务”只能映射最近显示、相同过滤/分页/owner/project 的稳定列表快照；无快照/已变化/歧义时需用户明确确认，不能按最新全局排序猜目标。
- **#67 Generation 范围**：当前全局 generation 在无关插件变化时也可能误暂停任务；先 E1 双插件/多任务实证，再优化按依赖定向 invalidation。撤权目标插件必须继续 fail-closed。
- **真实红队 #28**：外部 GitHub 文档/Issue/PR/MCP tool 描述不可改变 Mandate/授权/Token/工具；跨 repo、未授权 Issue 写、凭据泄漏、草稿污染、无界读、网络失败、取消及重启都要负例。

## 5. 真实验收计划与分级证据

E1 确定性/模拟 ≠ E3 本地真实模型 + 真实 Feishu/GitHub ≠ E4 常驻、重启和持续使用；每项记录 `commit SHA / 环境 / 权限来源 / 输入 / expected / actual / trace / receipt / DB audit / Feishu inbound+outbound / latency / cost / verdict`，敏感信息脱敏，失败不能只记录 SUCCESS 模型自述。

| Gate | 输入与预期 | 完成含义 |
| --- | --- | --- |
| G-A 安全 | 假 read 真写 MCP、过时 generation/撤权、预算未知、任务序号变化 | 程序阻断或 needs_manual；真实副作用在测试隔离内为零或受控 |
| G-B 真正 G1/E3 | owner **亲自**飞书发起指定 repo 请求；Agent 实际模型选择 tool，返回可核对 Commit/PR 与同会话答复 | 真实飞书 ingress→Task→Action→Verifier→Outbox→用户收件；不是注入 ingress + 单发 outbound |
| G-C GH02/GH03 | 两个 repo 项目绑定，固定 SHA file/PR diff/CI Check；非法 repo/缺结果 | 来源和 coverage 正确，权限不串，不伪造测试 |
| G-D GH04 Read-only | owner 请求对照计划审查，真实模型使用 project-review Skill | Finding/Issue 草稿能回查每个具体来源；真实模型遵循，重复运行去重，未批准无写 |
| G-E GH05/06 Write | 在 owner 指定隔离测试 repo 同意 create/update/comment | GitHub 真实资源写前/后核对；拒绝/重复/撤权/冲突/超时可解释；最终飞书汇报 |
| G-F L2 自用 | GH01–06 与有关 GH09，原 #41 关键 M 场景有实际证据 | 可宣布 **Project Manager L2 Pilot**，不是完整 v0.2/v0.3/公开发行；收集连续 7 天真实反馈 |

已验证 GitHub 私有 repo read、MCP 对照及飞书出站证据可复用，不能重新标记为完整用户闭环。需 owner 提供 OAuth App/GitHub App 实际凭据、测试 repo、账号授权、运行主机、真实成本边界的项目明确标 `BLOCKED`；工程其余部分照常推进。检查 `docs/22-mvp-acceptance-runbook.md` 及 #41，不取消 M01–M14。

## 6. PR 交付协议与更新规则

1. 从最新 main 建 **单一责任** feature branch，PR 中列 Issue、前后接口、配置/schema 迁移、fail-safe、测试命令、真实证据与未完成项；任何源码与安全改动需单独 PR，不与文档规划混在一个功能 PR。
2. 既有 `npm test`（最新基线 CI 427，不保证未来仍为该数量）、`npm run typecheck`、`npm run scan:secrets`、`npm run install:smoke`、`npm run deploy:dry-run`，按适用性执行 GitHub Actions test/macOS/Windows/install-smoke。通过记录 commit 和 run ID，不引用旧绿灯冒充新 PR CI。
3. 先写负例，尤其是远端 MCP 副作用、Tool/Task generation fence、真实 GitHub 幂等、恢复。所有 SDK/HTTP 返回皆不可信；若实际字段不足，不补造内容。
4. 每完成一个包，同步原 Issue 的完成项与证据；#65/#73 只维护 checkpoint 与阻断；#41 专注真实 Core 验收，不把全链路通过提前认定。
5. **当前规划更新许可不代表实际业务副作用授权**。除非 owner 明确授权，不合并 PR、不在真实 GitHub 项目写入 Issue、不在外部账户新开权限、不激活付费无人值守/任意第三方插件。

## 7. 后续路线保持不变

L2 Pilot 真实通过后：#63 单一 Coding Agent Runtime 插件 → 实际隔离开发 + Draft PR，#64 独立 Review/CI/受限主动汇报，#71 正式 SDK、隔离与 GitHub App，#72 V3 Registry/分发/社区。完整插件生态是长期必选，但当前下一交付应首先证明一次可信、可重复的 GitHub 项目维护闭环。
