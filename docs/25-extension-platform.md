# 25 · Extension Platform：Plugin / Skills / MCP / Credential Architecture

> 2026-11-20 · [#73 总跟踪](https://github.com/yuanbaoerer/personal-agent/issues/73) · 基线 c42243b · 设计与待办，非已实现能力。Extension Platform 为一级长期架构模块，完整开放插件生态为必选产品路线。保留 #41 Reliable Core 和 #65 GitHub 垂直场景以及原发布门槛。

## 1. 产品决策

One Agent Core + WorkProfile × ExecutionStrategy × ModelPolicy + ExtensionPolicy。前三者分别描述做什么、怎样组织、模型选择；ExtensionPolicy 描述可选扩展能力与限制，不另造权限体系，也不是第四种执行模式。Core 保持 Task/Assignment/Session/Mandate、ActionService、Confirmation、Verifier、Memory、Schedule、Budget、Recovery 和 Audit 的唯一权威。Extension Platform 管理能力发现、版本、生命周期、凭据、MCP/Skills 及受控运行。GitHub 是首个 Integration Plugin，Coding Agent 是首个 Runtime Plugin；以两种实际插件验证抽象，而非先做通用 SDK 再找需求。

参考设计资料（具体协议/API 实施前重新核对，以官方当前文档为准）：[OpenClaw plugins](https://docs.openclaw.ai/tools/plugin)、[Claude Code plugins](https://code.claude.com/docs/en/plugins)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers)、[GitHub MCP Server](https://github.com/github/github-mcp-server)、[MCP specification](https://modelcontextprotocol.io/specification)、[GitHub Apps](https://docs.github.com/en/apps)。不复制各项目的安全假设，不宣称完全兼容。

## 2. 现状与迁移边界

当前 app.ts 调用 createDefaultToolRegistry 并通过 registerTools 注入；actions/tools.ts 静态注册 GitHubReadTool，GitHubReadConfig 按 env/tokenProvider 决定是否注册；pi-router.ts 对 github.read/resource 存在静态白名单与 prompt；Task 报告、Verifier、SchedulePolicy、OAuth 路由亦存在 GitHub 专有逻辑。应先识别所有消费工具与授权的入口，迁移到同一 Capability Catalog，而不是另包一层却保留双重真源。保留 actions/tooling.ts 的 ActionTool/ToolRegistry 契约和已验证的 github.read、OAuth URL、历史 Task/receipt/claims、预授权、DB 迁移及原测试。Core 内建 state tools 与测试 lamp 保持受控；不强制所有内部组件插件化。Node V1 先行，DO 只支持明确可用的平台能力，不假称支持动态执行。

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

EXT01–10 见 #73：manifest/冲突、无 GitHub Core 正常、Node 不重启启停、真实登录与撤销、旧审批/在途动作/重启、MCP 实证对照、Skill 版本/注入、GH 项目管理闭环、Coding Runtime/Draft PR、第三方独立开发、安全分发和跨平台。每项记录 SHA、E1/E3/E4、plugin/version/generation、授权版本、trace、测试命令及实际回执、已知成本、PASS/FAIL/PARTIAL/BLOCKED；未知明确标记。插件调用观测记录 latency/error/capability/version，但不存凭据/原始私聊；复用 #7 的预算/audit 与 #28 安全负例，正式 K/SEC 和 M01–M14 不降低。当前 GitHub Actions 账单阻断仍待恢复，不能用本地测试替代跨平台 CI。

## 12. 开发顺序与约束

先 #67，再 #68（真实 G1 能并行准备），随后 #69 和 #70 loader；#60/62 与兼容评估/skills 业务验收协作。每包独立分支/PR/Review，保留现有 API/CLI/DB 兼容；不启动巨型重构。V1 不等于完整生态，V2/V3 不以“普通可选插件”删除。owner 后续决定真实授权 repo、GitHub App/首个 Coding CLI、隔离机器、网络/命令/硬预算和开放发布时间；计划变更不自动授予凭据或外部副作用。
