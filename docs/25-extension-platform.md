# 25 · Extension Platform：Plugin / Skills / MCP / Credential Architecture

> 2026-11-21 · [#73 总跟踪](https://github.com/yuanbaoerer/personal-agent/issues/73) · 基线 c42243b · Extension Platform 为一级长期架构模块，完整开放插件生态为必选产品路线。保留 #41 Reliable Core 和 #65 GitHub 垂直场景以及原发布门槛。**V1 首批代码已合并 main**：PR #74（EXT-01/02）、#75（EXT-04 loader）、#76（EXT-03 只读 MCP）、#78（任务级 ExtensionPolicy）；真实证据 #77。
>
> **实施状态（2026-11-21，已合并 main）**
>
> - **EXT-01 已实现（Node）**：`plugins/manifest.ts`/`catalog.ts` 提供内置 manifest 校验、命名空间/冲突拒绝、持久 lifecycle、原子 ToolRegistry swap 与 catalog generation；`pa_plugins` 保存 installed/enabled/disabled/error，connection 独立派生；Task 固定 plugin/version/digest/generation，Action 固定 plugin binding/generation；Router、Mandate sanitize、Worker prompt、Action proposal/execute/reconcile 共用 catalog；禁用会 supersede 待执行审批、暂停未派工任务，运行中写入进入 unknown/reconcile，reconcile 失效时进入 needs_manual 而非宣称未执行；未配置插件拒绝 enable。`pa plugins list/status/enable/disable` 与 `/api/v1/plugins` 已接入，enabled 状态跨重启保留，generation 单调递增。
> - **EXT-02 首批已实现**：GitHub 由 `plugins/github.ts` 包装既有 `GitHubReadTool`，保留 `github.read`、PAT/OAuth、白名单、预授权和加密凭据路径；OAuth 连接/断开/换账号通过 `ExtensionService.credentialChanged` 推进 generation 并撤销旧审批。真实只读 G1（私有 repo/PR/commit）与 Feishu 出站证据见 `docs/acceptance/2026-11-20-real-github-g1.md`；真实 browser OAuth revoke/account-switch 仍未验收。
> - **EXT-04 loader 与任务级 ExtensionPolicy 已实现（Node）**：`plugins/skills.ts` 索引 `SKILL.md` 元数据（id/version/digest/plugins/permissions/priority），正文按需读取并在每次注入前重新校验 digest、路径、插件 enabled 与权限子集；单文件 64KB、单技能正文 8KB、任务总预算 16KB、最多 8 个技能；不执行任何脚本。Task revision 固定 skill binding，Worker prompt 只把已校验正文作为 guidance 注入，拒绝项进入审计/提示。内置 `github.project-review`、`github.issue-management`、`github.project-digest` 三个只读技能；`GET /api/v1/skills` 与 `pa skills list` 可用。任务级 `ExtensionPolicy` 支持 plugins/skills allowlist 与 permissions `allow|require_approval|deny`，只收紧 Mandate/catalog，持久化在 task extension，并在提案/执行/自动批准前复核。**未完成**：WorkProfile × ExecutionStrategy × ModelPolicy 的完整 ModeCatalog/Strategy 解析层仍 pending；当前 policy 由调用方按任务提供。
> - **EXT-03 只读远程 MCP 已实现（Node）**：官方 SDK Streamable HTTP client；显式 server/tool allowlist、https/私网/重定向/凭据来源校验、静态参数 schema、timeout、结果截断、每次请求 URL/DNS 复核并把非 trusted 连接固定到已校验 IP、catalog 生命周期与禁用 fencing。`PA_MCP_CONFIG` 接入，详见 [26 · MCP Host](26-mcp-host.md)；真实 GitHub MCP 只读对照见 `docs/acceptance/2026-11-20-real-github-mcp.md`。**未完成**：MCP OAuth、stdio transport、分页/resume/重连和任何 MCP 写穿透。
> - **剩余扩展缺口**：WorkProfile × ExecutionStrategy × ModelPolicy 的完整 ModeCatalog/Strategy 解析层仍 pending；MCP OAuth/stdio/写路径、第三方 SDK/隔离、V3 Registry/分发未实现。V1 真实只读 GitHub/MCP/Skill 已有证据，但 Feishu inbound、真实 OAuth negatives、真实模型 skill adherence 与 GitHub 业务工作流未验收。V1 热启停、Skills、MCP 与 policy 只承诺 Node，Durable Object 不宣称支持动态加载。

## 1. 产品决策

One Agent Core + WorkProfile × ExecutionStrategy × ModelPolicy + ExtensionPolicy。前三者分别描述做什么、怎样组织、模型选择；ExtensionPolicy 描述可选扩展能力与限制，不另造权限体系，也不是第四种执行模式。Core 保持 Task/Assignment/Session/Mandate、ActionService、Confirmation、Verifier、Memory、Schedule、Budget、Recovery 和 Audit 的唯一权威。Extension Platform 管理能力发现、版本、生命周期、凭据、MCP/Skills 及受控运行。GitHub 是首个 Integration Plugin，Coding Agent 是首个 Runtime Plugin；以两种实际插件验证抽象，而非先做通用 SDK 再找需求。

参考设计资料（具体协议/API 实施前重新核对，以官方当前文档为准）：[OpenClaw plugins](https://docs.openclaw.ai/tools/plugin)、[Claude Code plugins](https://code.claude.com/docs/en/plugins)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers)、[GitHub MCP Server](https://github.com/github/github-mcp-server)、[MCP specification](https://modelcontextprotocol.io/specification)、[GitHub Apps](https://docs.github.com/en/apps)。不复制各项目的安全假设，不宣称完全兼容。

## 2. 现状与迁移边界

迁移前，`app.ts` 通过 `createDefaultToolRegistry` 与 `registerTools` 注入工具，`actions/tools.ts` 静态注册 `GitHubReadTool`，`pi-router.ts` 维护静态工具/resource 白名单。2026-11-20 的 EXT-01/02 已移除这条 GitHub 双注册路径：registry factory 只保留 Core 工具，`PluginCatalog` 负责 GitHub 内置插件与原子发布；Router prompt/sanitize、Worker prompt、Action proposal/execute/reconcile 读取同一 catalog。仍保留的 GitHub 专有逻辑是 `github-read` completion verifier、SchedulePolicy 的 repo/version 读取授权和 OAuth 管理页；这些是已验证的业务契约，后续在对应垂直工作包中迁移，不在本轮重写。保留 `actions/tooling.ts` 的 `ActionTool`/`ToolRegistry` 契约和已验证的 `github.read`、OAuth URL、历史 Task/receipt/claims、预授权、DB 迁移及原测试。Core 内建 state tools 与测试 lamp 保持受控；不强制所有内部组件插件化。Node V1 先行；Durable Object 复用持久 schema，但不承诺动态加载或插件管理入口。

## 3. 目标架构

```text
Clients (Feishu / CLI / TUI / later Desktop)
    -> Core: Router -> Task -> Assignment / Worker
       Mandate / Action / Confirm / Verifier / Audit / Recovery
    -> Extension Platform
       Manifest & Registry | Capability Catalog | Lifecycle
       Credential Broker   | Skill Runtime      | MCP Host
       SDK / Isolation / Distribution (V2/V3)
    -> trusted GitHub integration / Coding Runtime / future plugins
    -> native API / remote MCP / isolated local process
```

扩展点类型：Integration、Tool、Skill、Workflow、Runtime、Verifier（V1/V2 first）；Channel、Provider、Memory 等后续真实性需求驱动，最终纳入统一 manifest，不要求九套并行 SDK。Plugin 是打包及生命周期单元，Skill 是指导性上下文，MCP 是协议和传输，Credential 是认证，Policy 是程序强制授权；各自不可代替。插件不能直接获取 Store、全权 Core、owner secret、原始 session 或任意执行权限；V1 仅受信内置实现，V2 非受信代码必须进程隔离。

## 4. Manifest / 内部契约（示意，并非现有代码）

```json
{
  "id": "github",
  "version": "0.1.0",
  "apiVersion": "1",
  "trust": "builtin",
  "exports": {
    "tools": ["github.read"],
    "skills": ["github.project-review", "github.issue-management"]
  },
  "auth": ["pat", "oauth", "github-app"],
  "permissions": ["repository.read", "issue.write"],
  "defaultPolicy": "read-only"
}
```

auth 与权限列表表示可支持的候选，不等于已实现或已授权。本阶段需要 schema/namespace/version/digest、唯一性与兼容校验、声明式 config（无 secret）、明确注册的 entrypoint、工具参数 schema/资源/operation/read-write 分类/timeout/replayPolicy/verify、skills metadata。capability mapping 由可信宿主提供；不信任 MCP tool annotation 或插件自行声明只读。

候选内部接口：PluginDescriptor、PluginFactory、PluginHandle(start/stop/health)、CapabilityDescriptor、CatalogSnapshot(generation, entries)、CredentialRef、SkillDescriptor、ExtensionPolicy。沿用 ActionTool；只在必要时扩展 contract。V1 内置 factory 静态注册，不支持任意 import 或下载 npm 后执行。SDK V2 才正式稳定 ABI/RPC、开发模板、contract tests、兼容矩阵；不承诺本篇具体类型命名不变。

## 5. 热插拔、授权和持久任务（EXT-01）

分别维护 plugin lifecycle（installed/enabled/disabled/error）、connection（unconfigured/connected/expired/revoked/error）、permission/grant（owner/project/account/repo/operation/expiry/version），不把三者合并。启停/连接管理经已有认证 Client API；CLI 候选 pa plugins list/status/enable/disable/login/logout，不暴露 secret，不允许模型直接管理授权；TUI/HTTP 后续复用 Client API。

Catalog 为宿主内唯一能力目录；加载候选、验证依赖/schema/冲突后原子发布 generation。Router、Mandate sanitize、Worker prompt、Action proposal/execute/reconcile、Verifier、Schedule 读取同一受控能力定义。Task/Assignment 固定 plugin/version/digest、catalog generation、skill refs；执行时仍核对最新授权/启用状态。兼容历史任务无版本字段时显式迁移/重新确认，不自动授权。启用/更新失败保持先前安全状态；禁用/撤权不等同卸载、不删除审计与密文，不会自动恢复失效审批。

禁用：立即阻断新任务取得工具及未开始动作；排队动作暂停/拒绝并反馈，已运行只读取消或安全结束但旧结果无权推进过期任务；正在写入不能宣称撤销已发生，进入 unknown/reconcile，禁止重试写，仅在有当前独立核对权限时做最小 read-after-write，否则 needs_manual。旧 receipt 历史可核验，不能调用已卸载代码完成新 Task。停止、重启、热更新、generation 变化和授权撤销竞态必须测试。V1 热插拔目标为不重启 Node 的内置插件启停、授权与 catalog 刷新；运行时代码替换/第三方安装更新属 V2/V3，不在 V1 承诺。

## 6. Credential Broker 与 GitHub（EXT-02 / EXT-05）

安装/启用插件、连接账号、授权具体资源、Task Mandate、写审批是独立步骤，最终权限取交集；不新增平行 Permission Manager。Broker 保存 owner/plugin/account/credentialRef/scopes/expiry/version，秘密通过既有 AES-GCM 或受控秘密存储加密并在调用边界按需获取；不进入 prompt、日志、任务、manifest、导出明文或子进程。备份恢复/轮换/撤销/账号切换使旧授权失效，需精确版本绑定。

保留 D21 个人 OAuth App，浏览器管理页与 PKCE（provider 支持时）、state/redirect/admin 鉴权、scope 提示；PAT 兼容已有 env，但迁移须可回滚，不自动扩大 repo 或写权限。无浏览器场景仅在 provider 支持时使用 device code。logout 本地断开与 provider revoke 分开说明，不声称后者自动完成。短期真实 G1 先用单 repo fine-grained read-only PAT 或现有 OAuth；OAuth repo scope 较宽，应用层只读仍必需。Issue write 使用独立细粒度凭据和 #61 单次审批。GitHub App 是长期后台身份：明确 installation/repo/权限、短期 token/刷新、bot 身份、撤销；在 EXT-05，业务需要时可提前单独交付。不能假定 GitHub App、OAuth 与官方 MCP 的认证方式全部互通，逐项实测。真实凭据由 owner 另行配置。

## 7. MCP Host（EXT-03）

采用当前官方 SDK，先 remote Streamable HTTP；受信本地 stdio adapter 仅允许明确 executable/argv/环境，独立进程、不继承主机 secrets。支持初始化、tools/list、tools/call、取消、超时、连接状态/重连、返回及总预算，传输/能力不支持显式报错。MCP OAuth 使用对应协议 discovery、PKCE、audience/resource、redirect/state、refresh；token 不透传；远端 URL/SSRF/DNS/redirect 策略拒绝任意本地服务和重定向漏密。工具元数据和返回内容不可信，动态列表变化视为权限及 catalog 更新，不自动注册任意写工具。

2026-11-20 已实现 Node 只读远程 MCP：官方 SDK 1.32.2 Streamable HTTP client；每个 server 静态声明 allowed tools/参数 schema，`tools/list` 只确认声明存在，未知工具不注册；所有工具固定只读；URL 仅 https（显式 localhost 测试例外），拒绝私网 DNS/URL credentials/重定向，Bearer 仅来自 `PA_MCP_*` 环境变量；连接、list、call 有 timeout，输出截断 32KB；通过 `PA_MCP_CONFIG` 生成内置插件并进入同一 catalog。真实远端/GitHub MCP 对照、MCP OAuth、stdio、分页/resume 与写穿透未实现，详见 [26 · MCP Host](26-mcp-host.md)。

GitHub 官方 MCP 首先只读兼容测试，比较 repo/Issue/PR/源码来源与 SHA、字段、截断、延迟和授权。保留已有 REST adapter 作为可核验回退；MCP 对照失败/真实凭据缺失不耽误 REST G1 及 GH-02 的有界证据扩展。禁止通用 MCP 写穿透，GH-03 仍要求 typed action/canonicalize/批准/幂等/verify/reconcile。MCP 不是安全沙箱或权限系统。

## 8. Skills Runtime 与 ExtensionPolicy（EXT-04）

SKILL.md 元数据索引和正文按需加载、schema/id/version/digest、路径防逃逸/字节与 token 预算；不执行任意 bundled scripts、不自动向模型附加所有 skills。按 owner/project/profile/task 选择，记录 skill digest 与 capability generation；禁用/撤权不再加载或使用对应能力。外部文本不可信，Skill 可以建议流程但不能授予 tools/resources 或泄露秘密。

```yaml
workProfile: project-management
executionStrategy: delegated
modelPolicy: default
extensionPolicy:
  plugins: [github]
  skills: [github.project-review]
  permissions:
    repository.read: allow
    issue.write: require_approval
    pull_request.merge: deny
```

示意而非现有 schema；ExtensionPolicy 只收紧或选择 Core 已授予的能力，禁止越过 owner/credential/project/Mandate/ActionService 检查。首批 project-review、issue-management、project-digest 按 #62/#64 工作流逐步交付；loader 可独立先做，真实业务 skills 验收与 GH-02/04 并行，避免循环依赖。

2026-11-20 已实现 Node 端 `FileSkillRuntime`：递归索引 `SKILL.md`（拒绝 symlink/路径逃逸/重复 id/超限文件），元数据含 id/version/digest/plugins/permissions/priority；任务通过 `mandate.skills` 显式请求，选择时校验插件已 enable、权限是当前 catalog 插件权限子集，最多 8 个；Task revision 固定 skill binding。每次派工重新读取正文并核对 digest/版本/路径/插件状态；单技能 8KB、总 16KB，超限拒绝。正文只作为 Worker guidance 注入，不执行脚本、不授予工具。`GET /api/v1/skills` 与 `pa skills list` 只返回元数据。

任务级 `ExtensionPolicy`（`{plugins?, skills?, permissions?}`）由 Client API/CLI 提交，只做收紧：创建时校验 Mandate 工具属于允许插件、所需权限未被 `deny`、请求技能在 allowlist；Task extension 固定 policy，catalog 在每次 proposal/action 时重核，`requiresApproval` 阻止预授权/内部读取自动批准。CLI：`--plugins`、`--skills`、`--deny-permissions`、`--require-approval`。完整 WorkProfile/ExecutionStrategy/ModelPolicy 的 ModeCatalog/Strategy 解析仍未实现；上述示意 YAML 不能当作现有配置格式。

## 9. 完整生态与交付阶段

| 工作包 | 交付 | 阶段 |
| --- | --- | --- |
| EXT-01 #67 | Manifest/Catalog、内置插件热启停、版本栅栏 | V1 P0 |
| EXT-02 #68 | Credential Broker、GitHub 迁移、OAuth/PAT G1 | V1 P0 |
| EXT-03 #69 | MCP Host 与 GitHub 只读兼容评估 | V1 P0 |
| EXT-04 #70 | Skills Runtime、ExtensionPolicy | V1 P0 |
| EXT-05 #71 | 正式 SDK、第三方隔离、GitHub App | V2 P1 |
| EXT-06 #72 | 可信 Registry、版本/dependency、分发与社区 | V3 P2 |

V1：内置 GitHub 启停、真实 read-only 连接、可验证 tool/skill，兼容现有 Core；不下载任意包。V2：SDK、template、contract tests、两个实际插件（GitHub + Coding Runtime）、独立开发者扩展无需改 Core；第三方进程隔离、RPC capability broker、最小文件/网络/CPU/内存、密钥隔离、install/update permission diff、锁定版本与 digest、回滚。没有可靠隔离就拒绝第三方运行。V3：Registry/index、可信签名与 provenance/SBOM、依赖解析、撤销下架、更新确认/离线安装/回滚、CLI/TUI/Desktop 管理、开放示例、审查/举报/安全事件响应与社区维护政策；不等同付费 marketplace，也不要求多租户 SaaS。#14/#17/#24/#27/#29/#30/#31 原发布治理保留。

## 10. 与 GitHub 产品路线的依赖

GH-00/01 与 EXT-01 并行：现有安全/真实验收阻断不延期。EXT-02 迁移首插件并真实 G1；GH-02 #60 基于相同 catalog/broker 扩展证据，MCP read-only spike 与 REST 实施并行；GH-03 #61 必须用插件能力受控写入口，GH-04 #62 复用最小 skills 与现有 Task/Assignment。V1 是下一核心工程检查点，L2 仍是下一业务交付，不因 MCP 可选适配失败而停止所有业务。GH-05 #63 作为 Runtime Plugin，GH-06 #64 作独立 Review 和只读主动汇报。V2 SDK/隔离与第二种真实插件共同验证；V3 长期必选但不阻断当前 L2。无人值守/写/付费开发先通过 #7/#28/对应 #41 门槛；不得以插件化为由绕过。

## 11. 验收与运营

EXT01–10 见 #73：manifest/冲突、无 GitHub Core 正常、Node 不重启启停、真实登录与撤销、旧审批/在途动作/重启、MCP 实证对照、Skill 版本/注入、GH 项目管理闭环、Coding Runtime/Draft PR、第三方独立开发、安全分发和跨平台。每项记录 SHA、E1/E3/E4、plugin/version/generation、授权版本、trace、测试命令及实际回执、已知成本、PASS/FAIL/PARTIAL/BLOCKED；未知明确标记。插件调用观测记录 latency/error/capability/version，但不存凭据/原始私聊；复用 #7 的预算/audit 与 #28 安全负例，正式 K/SEC 和 M01–M14 不降低。2026-11-21 GitHub Actions 已恢复，main run `44860766068` 全部通过；此前 #74–#78 的 CI run 因账单未启动，合并依据是本地测试，不能追认为 CI 通过。

## 12. 开发顺序与约束

先 #67，再 #68（真实 G1 能并行准备），随后 #69 和 #70 loader；#60/62 与兼容评估/skills 业务验收协作。每包独立分支/PR/Review，保留现有 API/CLI/DB 兼容；不启动巨型重构。V1 不等于完整生态，V2/V3 不以“普通可选插件”删除。owner 后续决定真实授权 repo、GitHub App/首个 Coding CLI、隔离机器、网络/命令/硬预算和开放发布时间；计划变更不自动授予凭据或外部副作用。
