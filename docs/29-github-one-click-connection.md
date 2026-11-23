# 29 · GitHub 一键连接（GitHub One-Click Connection）设计与实施规划

> 状态：**GC-00 IMPLEMENTED / GC-01 PENDING**。规划日期：2026-11-22。审阅基线：`main@fcdd278490ef0a147b7f41af630d25bf5e39edf4`。本文件是实施契约，不等于 API、CLI、TUI、Desktop 或 GitHub App 功能已经实现。每次实施前复核最新 `main` 与 Issue，避免按历史状态重复开发。
>
> **2026-11-23 实施状态**：GC-00 连接契约、加密 PAT/OAuth vault、broker epoch、连接状态与失效钩子已落地（schema 27、`github.connection.test.ts`），E1 PASS；GC-01 CLI/API、运行期刷新与真实 E3 仍未实现。
>
> 跟踪：[#68 EXT-02 Credential / OAuth](https://github.com/yuanbaoerer/personal-agent/issues/68)（GC-00～GC-03 主入口）；[#71 EXT-05 SDK / GitHub App](https://github.com/yuanbaoerer/personal-agent/issues/71)（GC-04 与后续 SDK / 隔离）；[#60 GH-02 ProjectBinding](https://github.com/yuanbaoerer/personal-agent/issues/60)（GC-02 对接）；[#65 GH Tracking](https://github.com/yuanbaoerer/personal-agent/issues/65)（真实业务验收）。相关架构：`docs/19-github-oauth.md`、`docs/24-github-project-management.md`、`docs/25-extension-platform.md`、`docs/10-client-platforms.md`、`docs/20-local-client-api.md`。

## 1. 产品目标与严格边界

**目标**：首次用户在 CLI/TUI/未来 Desktop 通过同一连接入口完成“选择连接方式 → GitHub 身份认证 / 授权 → 显式选择仓库 → 创建 ProjectBinding → 用自然语言只读审查”，不必手工查 Repository ID；连接后的权限能被验证、撤回、诊断。

分两种不同交付承诺，**不能混为一谈**：

1. **P0（GC-00～GC-03）：自托管 Quick Connect**。复用当前 `GITHUB_TOKEN` / GitHub OAuth App / CredentialBroker / ProjectBinding。用户可使用已有 PAT，或在自备 OAuth App 参数已配置时通过浏览器登录。P0 不承诺“全新用户无任何预配置的一键授权”。
2. **P1（GC-04）：真正面向社区的 One-Click Connect**。通过公开的 GitHub App 及必要的可信认证服务，用户无须自行创建 OAuth App 或粘贴 PAT，就能选择安装范围并授权仓库。必须提供不依赖官方服务的自托管备选路径。
3. **P2（GC-05）：跨端发布质量**。CLI、TUI、Desktop 复用 Client SDK 和 Core；Desktop 独立产品研发不构成 P0 / CLI 自托管发布的阻断。

**分离五个动作**：`Plugin enabled` ≠ `Account connected` ≠ `Repo selected/bound` ≠ `Task Mandate` ≠ `Write action approved`。登录本身不授予所有可见仓库，更不授予 Issue write、代码 push、PR merge 或无人值守执行。授权取 owner、connection、credential、repository、plugin、task mandate、action policy、预算的交集。原 #41、#61、#65 安全与真实验收门槛不降低。

## 2. 现有基线（只记录仓库已实现内容）

- `apps/agent/src/personal/github-oauth.ts` 有 OAuth web flow、单次 state、Token AES-256-GCM 加密、status / disconnect；`docs/19-github-oauth.md` 仍要求部署者自行配置 OAuth App client ID/secret/encryption key 和 `ADMIN_TOKEN`，`/oauth/github` 管理页不是 OAuth App 配置向导。
- `apps/agent/src/actions/credentials.ts` 和 `apps/agent/src/storage/credentials.ts` 已有 `CredentialBroker`、`credentialRef`、owner/scope/repoId/version/revoked 元数据持久化；秘密仍由已有 OAuth vault 或 host provider 提供。不可再建平行 Token Store。
- `apps/agent/src/main.ts` 主要把现有 PAT/OAuth 注入 `github:default`；独立的 Issues-write credential 已有配置路径。当前并非通用多账号连接平台。
- `apps/agent/src/plugins/github.ts` 有 `github.read` 和受控 Issue create/update/comment 内置工具，`configured` 依赖创建插件时的凭据/allowlist；必须检验登录后运行时 catalog 变更机制，不能直接宣称无需重启。
- `apps/agent/src/personal/projects.ts`、`apps/agent/src/storage/projects.ts` 已实现 ProjectBinding/owner scoped key/immutable repoId/credentialRef。CLI `pa projects bind <key> owner/repo --repo-id N` 仍要求手填 repo ID；`pa plugins` 只有 list/status/enable/disable，缺 login/logout。
- `apps/agent/src/client-api.ts`、`apps/agent/src/client/sdk.ts` 是现有控制面；`apps/agent/src/tui.ts` 有 Tasks/Approvals/Reminders，没有 Connections 视图。Desktop 尚无实际产品实现；不得宣称已支持。
- 仓库已有 GitHub 只读评估与受控 Issue 写的阶段性代码和证据，但 **OAuth 真实浏览器授权全负例、社区 GitHub App 与跨端连接尚未验收**。固定 SHA、Project Review、Verifier、Issue 写实现不因连接 UX 重新开发。

## 3. 统一架构与责任

```text
CLI ───────┐
TUI ───────┼── ClientApiClient ── /api/v1 ── ConnectionService (NEW)
Desktop ───┘                                  │
                                         Auth Provider Adapter
                                     PAT / existing OAuth / GitHub App
                                               │
                                Existing OAuth vault / CredentialBroker
                                               │
                              Repo Discovery (bounded, read-only)
                                               │
                          Existing ProjectService / Plugin Catalog
                                               │
                     Existing ActionService / Task Mandate / Verifier
```

**ConnectionService（新增最薄的一层）**：负责 begin/complete/cancel/status/list/disconnect、账号身份绑定、CredentialBroker epoch 更新、插件生命周期通知。复用现有 `GitHubOAuthService`；不旁路 `ActionService`。只能通过受保护 Client API 管理；模型文本不能发起连接或扩权。

**Auth Provider Adapter**：
- `pat`：本地显式提交的 fine-grained PAT 或已有 env PAT，读取身份与有效权限，不在终端回显或以 URL/query 存储。不能假定输入的 PAT 自动是只读。
- `oauth`：当前 **自建 OAuth App** 的浏览器 Web Flow；未配置 Client ID/Secret 时应清晰提示 setup required，而非伪称“一键”。不得在 P0 假设旧 OAuth App 支持 GitHub App Device Flow 或细粒度私库 read-only。
- `github_app`（GC-04）：区分**用户身份**（user-to-server token）与 **App 安装身份**（installation access token）。安装范围、可操作 repo/permission 必须回源核验；用户发起动作按产品策略使用相应身份并保留 actor attribution，后台只读工作亦不可自动获得写权。公开的 CLI/Desktop 不可内嵌 GitHub App 私钥或 client secret。

**RepoDiscovery**：从授权身份实际可访问的 repo / installation 列表分页获取 `id`、`full_name`、`default_branch`、`permissions`/coverage；结果仅用于候选显示，不改变授权。每次 `bind` 必须在 Core 端用相同凭据复核 repo immutable ID 与允许权限、明确选择和写入范围。支持 rename/transfer、分页截断、403/404/429、权限未知状态，禁止“获取用户全部仓库即全部授权”。

**Existing ProjectService / Plugin Catalog**：`bind` 必须复用现有服务与审计；连接成功不自动启用插件或修改 Task Mandate。新增登录后要在 Runtime 受控刷新工具可用状态 / catalog generation，并使旧 action approval/Issue draft 的授权版本失效；不可不经 Task 版本栅栏热替换 Token。

## 4. 数据契约（建议形态，不作为已有接口）

```ts
type GitHubAuthMethod = "pat" | "oauth" | "github_app";
type ConnectionStatus =
  | "connected" | "expired" | "revoked"
  | "reauth_required" | "error";

interface GitHubConnectionView {
  id: string;
  ownerId: string;
  pluginId: "github";
  authMethod: GitHubAuthMethod;
  accountId: string;        // GitHub stable user id, not login only
  accountLogin: string;     // display identity
  credentialRef: string;    // no secret
  credentialVersion: number;
  status: ConnectionStatus;
  installationId?: number;  // only GitHub App
  repositoryIds: number[];  // verified allowlist, never discovery=grant
  updatedAt: string;
}
```

注意：优先扩展现有 `CredentialRepository` 的非秘密元数据与 OAuth vault；只有实际需要多连接生命周期的字段才新增表/迁移。Token、refresh token、GitHub App private key、client secret 不得落到 ProjectBinding、Task、Prompt、日志、Issue body、CLI JSON。是否使用 OS SecretStore / 加密 DB 由部署模式决定，并明确密钥恢复/轮换方案。

**状态不应混淆**：插件 disabled 与连接有效是不同维度；`connected` 只表示当前可验证的身份/凭据，不等于所有 repo 可读。`disconnect`（本地撤销凭据/解除连接）不等同于 GitHub 侧 revoke/uninstall；对外明确显示两者结果。账号更换、scope 缩减、installation repo selection 变化、Token 轮换、重启恢复须递增或保留正确 epoch，旧 pending approval 和 write draft 不得被重放。

## 5. API / CLI / TUI / Desktop 一致性契约

优先在现有 `/api/v1`、`ClientApiClient` 加**最小**连接控制面，以下是拟议接口（命名可在 GC-00 评审时定稿，保持统一错误语义）：

| 功能 | Proposed API | 安全要求 |
| --- | --- | --- |
| 查询连接状态 | `GET /connections/github` | 只返回脱敏身份/权限状态 |
| 发起连接 | `POST /connections/github/start` | owner/admin 权限；一次性 state、有效期、requestId |
| 完成 PAT 连接 | `POST /connections/github/pat` | authenticated TLS/loopback；不记录 token；敏感体限流 |
| OAuth 完成 | 复用 `/oauth/github/callback` + 内部 finish | 精确 redirect、state 与会话/owner 绑定；防 CSRF/重放；不绕过 admin session |
| 查询授权候选仓库 | `GET /connections/github/repos` | 分页、限量、区分 unavailable / partial |
| 断开 | `POST /connections/github/disconnect` | 可区分 local disconnect 与 provider revoke/uninstall |
| 绑定项目 | **复用** `POST /projects` | immutable repoId 验证、owner/project fence、显式确认 |
| 健康检查 | `GET /connections/github/diagnostics` | 独立区分 401/403/404/429、repo scope/extension 状态 |

CLI 目标命令（**全部拟议，非当前实现**）：

```bash
pa plugins login github              # 交互式：PAT / 已配置 OAuth；GC-04 增加 App
pa plugins status github --json      # 分离 plugin state / account / permissions
pa github repos                     # 分页选择授权候选；只读
pa projects bind <key> owner/repo    # 自动核对 GitHub immutable repoId
pa github doctor                    # 诊断、不写仓库
pa plugins logout github            # 默认本地断连；远端撤销需要明确确认
```

TUI：在既有 `pa tui` 加 `Connections` tab，复用 SDK，键盘操作、短终端/无色输出、OAuth 链接和设备码展示、取消/重连；不要让 TUI 直接读 SQLite 或调用 GitHub token API。P0 支持跳浏览器；**Device Flow 只有 GC-04 选择 GitHub App 且按官方流程验证之后才能承诺**。

Desktop：未来 Integrations 页面复用 **同一** Client SDK 与状态机；不运行第二套 Core，不缓存独立的 GitHub secret。远程设备与回调需要设备身份、TLS、精确允许的回调 URI；不得把绑定任意 localhost/URL 视为可信。Desktop 打包与正式发布独立于 P0 CLI/TUI。

## 6. 权限、安全和外部依赖（非可选）

1. Login/Install/Bind/Task approval/Write approval 分离。GitHub OAuth `repo` scope 可能比工具只读语义宽；必须保持工具端 GET-only、独立 write credential 和严格 allowlist。`github.issue.create/update/comment` 保留 #61 owner 明确审批、幂等与 GET verify，禁止因连接完成自动开放。
2. PAT 与 OAuth 旧配置不被静默覆盖：`GITHUB_TOKEN`、`GITHUB_ALLOWED_REPOS`、`github:default`、`GITHUB_OAUTH_*` 和旧数据库数据有可测试的兼容与回滚；新连接绝不意外扩大旧 scope。
3. 连接/权限的控制面只能由已认证 owner 操作。state 一次性、过期、绑定 caller/owner、禁止开放跳转；Device Flow 正确处理 `authorization_pending`、`slow_down`、过期和取消。Web Flow PKCE 以 GitHub 当前支持形态为准；不要想当然替换现有 OAuth 流程。
4. 短期 GitHub App installation token 的缓存、过期与重签只能在可信侧；GitHub App 私钥不可随开源 CLI/TUI/Desktop 发包。公共 App 可选安全 Broker 承担必要签发；自托管模式可 BYO App/PAT/OAuth，不强制把仓库内容发送到官方云。声明元数据、token、源码是否经过服务端的实际数据边界。
5. Repo rename/transfer/uninstall、Webhooks 丢失时必须在重要动作前回源校验；Webhook 不是唯一正确性依据。撤销或缩权对 queued/in-flight/action reconciliation 立即 fail-closed，结果未知必须标 unknown 而不能重试盲写。
6. `PluginCatalog` / `ExtensionService` 实现热生效要保护未完成任务与 catalog/credential generation；两客户端并发登录、切换账号、断开不得产生重复授权或旧状态覆盖。日志、审计、API 错误、测试 fixtures、命令行参数不泄漏秘密。
7. 当前 Feishu owner 初始化/本地 API bootstrap 与多端远程 client 的身份模型需在 GC-00 识别和校验，不能因缺少 Feishu ID 就偷偷创建不受约束的默认 owner。
8. 所有外部 GitHub 响应、repo README、Issue 内容不可信，不得因“连接向导”引入通用 URL fetch 或 Prompt Injection 提权。

## 7. 实施拆分与代码改动边界

### GC-00（#68）连接契约与迁移：**第一个 PR**

- [x] 核实最新 main：`CredentialBroker`、`GitHubOAuthService`、`PluginCatalog`、`Client API`、`ProjectService` 及其测试；记录现状/重复代码风险。
- [x] 明确 ConnectionStatus、auth method、owner/identity、repo allowlist、credentialRef/version、插件/项目/Task/审批交集；确定 API、事件、稳定错误码、审计。
- [x] 设计并实现**必要的最小**连接业务接口与元数据存储/迁移（如果原 broker 已覆盖，直接复用），不创建平行 vault/registry/permission manager。
- [x] 测试旧 PAT/OAuth 数据兼容、重启 restore/rotate/revoke epoch、空 scopes fail-closed、老配置/回滚；不能仅写 ADR 而不验证接口契约。
- [x] 为 GC-01 提供可测试 provider boundary（fake provider）与明确的 E1 验收证据。

**GC-00 完成定义**：typecheck、既有测试、存储迁移/回滚通过；Token 不入 Task/log；在一条权威连接/凭据路径上证明连接/断连/重启的版本栅栏。无真 GitHub 账号时允许 E1_PASS / E3_BLOCKED。

**GC-00 落地记录（2026-11-23）**：
- `personal/github-token-vault.ts`：复用 `pa_github_credentials` AES-256-GCM vault，`auth_method`（schema 27）区分 PAT/OAuth；状态查询不解密，key 不匹配显式 `reauth_required`。
- `personal/github-connection.ts`：`GitHubConnectionService` 提供 status / PAT connect / OAuth begin+complete / local disconnect，稳定错误码，broker `register|rotate|revoke` epoch，审计事件与 `github:default` 失效钩子；不授予 repo/Task/Issues-write。
- `main.ts`：OAuth 网页 flow 与 connection service 合并为单一后置处理；env PAT 使用 `restore`，撤销在重启后保持；stored credential 优先于 env PAT，key 错误不回退 env token。
- E1：`github-connection.test.ts`、`github-oauth.test.ts`、`migration-compat.test.ts`、`config.test.ts`；`npm test` 620/620（GC-00 时点）、`npm run typecheck` 通过。

### GC-01（#68）CLI 自托管登录闭环：**第二个 PR**

- [ ] 实现 Core-backed `pa plugins login/status/logout github` 和 Client SDK，优先已有 PAT 与已配置 OAuth Web Flow。无已注册 OAuth App 时报 setup_required，**绝不假称 P0 为无预配置一键登录**。
- [ ] PATH：OAuth start/complete/cancel/logout 使用已有 callback/state/encryption，支持 token 不可用、撤销、切号、重复授权、重启；PAT 输入不回显、不落日志与 stdout；兼容 `gh auth` 的“用户确认导入”可以是可选优化，不能默认自动拾取高权限 Token。
- [ ] 登录后动态连接现有 GitHub Plugin；credential 变化使旧审批和 Issue 草稿失效；只读工具正常工作，旧 env 连接继续可用；不要新建 GitHub read 实现。
- [ ] `--json` 稳定 machine-readable 状态/错误；交互式命令退出码、取消体验、无浏览器提示、Windows PowerShell/macOS 原生终端 smoke。
- [ ] E1：state CSRF/replay/expiry、401/403/429、重复 login、同一/异账号、restart、disconnect、撤销后访问 fail-closed、密钥缺失、token leak、plugin enable/disable/generation、旧配置。
- [ ] E3：owner 本机真实 GitHub PAT 或自备 OAuth 完成登录→`status`→精确 repo 的 read→退出/重启/断开验证；记录脱敏 API 回执。无真实 owner 凭据不得标 E3_PASS。

**GC-01 完成定义**：CLI 完整连接/断连闭环对实际 GitHub 至少有一条可复验成功路径，插件状态可见，跨重启安全；不依赖 GC-02/GC-04/GC-05。

### GC-02（#68 联动 #60）仓库发现和绑定：**第三个 PR**

- [ ] 分页 `repos` 发现：身份、repo immutable ID、default branch、真实 permission/coverage；“可见 ≠ 授权”；用户明确选择、自动 `repo-id`，复用 `ProjectService.bind`。
- [ ] 受控 allowlist/installation 授权与项目 binding 取交集；同一 repo 重名、rename/transfer、两个 repo/两个 owner、未授权、截断/429 均安全处理。
- [ ] E3：真实两个仓库（至少一个 private 在 owner 自愿授权下）绑定/读、无跨项目串访；与原 #60 GH02 验收共用回执，不宣称代替整个 #60。

### GC-03（#68）TUI + 运行时热刷新：**第四个 PR**

- [ ] TUI Connections tab 使用同一 SDK；Connect/status/disconnect、选仓库与错误提示，键盘/窄屏/无色/终端重连；无数据库直读。
- [ ] 真实验证运行中 login/logout 后 plugin catalog/Action/Task version fences；CLI 和 TUI 交叉操作不重复、不覆盖；重启、失联恢复；原 TUI 功能回归。

### GC-04（#71 的**可独立前置子项**）公开 GitHub App：**后续多个小 PR**

- [ ] GitHub App 注册与部署模型选择：Public App + 可信 Broker / 自托管 BYO App。明确 URL、安装配置、客户端/服务端密钥存储边界、协议和故障模型；无需先建设 V2 Plugin SDK / Marketplace。
- [ ] GitHub App 用户授权（Web Flow / 受控 CLI Device Flow）、installation 关联与授权 repo/permissions 真实核验。验证用户与安装身份对应关系，防跨用户拿别人的 installation。
- [ ] installation access token 按需签发/缓存/过期（通常 1h）及权限收窄；刷新、轮换、卸载、缩权、Webhook 回放丢失后的回源确认；按用户与 bot 场景选择身份；Issue write 仍走 #61。
- [ ] 真实**独立第二用户**从干净 CLI 完成安装/授权/选私有 repo/read，无需创建 OAuth App/PAT；显式拒绝授权、org 安装受限、repo 移除、断连/remote revoke 验证。公共 Broker 的隐私边界需审核。

### GC-05（Client Platform / #71 关联）Desktop + 正式发行

- [ ] 在 `docs/10-client-platforms.md` 已规划的 Desktop spike 基础上选择框架，不为连接功能提前扩展 Desktop 全产品。
- [ ] Desktop Integrations 复用 SDK/API/状态机，远程服务 TLS、设备授权撤销；无明文长期 token/第二份 Core。
- [ ] macOS x64/arm64、Windows 11 x64 的 CLI/TUI 登录 smoke 各自留证；Desktop 针对已构建 target 真机/可信 runner 单独验收安装、callback/Device Flow、签名与权限。Linux headless 宿主另验；未测平台标 BLOCKED。

**实施顺序**：GC-00 → GC-01 → GC-02 → GC-03；GC-04 可在 P0 获得真实自用反馈后并行起步；GC-05 不阻断 P0。每个阶段独立 branch/PR/review，绝不一个巨型 PR 实现全部。

## 8. 验收矩阵（GC-A01～GC-A12）

| 编号 | 场景 | 检查点 | 首次门槛 |
| --- | --- | --- | --- |
| GC-A01 | 新用户连接 | P0 明确 PAT/BYO OAuth 前置；P1 全新用户不自行创建 OAuth App/PAT | P1 |
| GC-A02 | 身份正确 | GitHub stable account ID/login 凭据一致、错账号不能绑定 | GC-01 |
| GC-A03 | 仓库发现 | 显式选 repo、自动解析不可变 repoId、拒绝越界与分页遗漏伪完整 | GC-02 |
| GC-A04 | 真实只读 | 私有 repo 文件/PR/CI fixed SHA 来源可核对；coverage 清楚 | GC-02/#60 |
| GC-A05 | 隔离 | repo A/B、owner、credentialRef/installation 无跨访 | GC-01～04 |
| GC-A06 | 生命周期 | 失效/切号/断连/撤销/重启版本与状态正确 | GC-00/01 |
| GC-A07 | 写入防护 | 旧 Task/Approval/Draft 因权限变化失效，GitHub write 仍需独立审批 | GC-01/03 |
| GC-A08 | 失败处理 | cancel、CSRF、401/403/429、timeout、network、unknown fail-closed | GC-01～04 |
| GC-A09 | 多端同态 | CLI/TUI/Desktop 共用 API/连接记录，交叉操作无重复副作用 | GC-03/05 |
| GC-A10 | 秘密保护 | stdout/json、Audit、Task/Prompt、数据库非秘密表、回执无 Token | GC-00/01 |
| GC-A11 | OS 支持 | macOS Intel/arm64、Windows x64 本地 CLI/TUI 真终端验证 | GC-03/05 |
| GC-A12 | 独立使用 | 第二用户 GitHub App 自助安装/授权/真实读、不需自备 App | GC-04 |

**证据标注**：每项明确 E1（mock/contract）、E3（owner / 外部 GitHub 实测），写明 `PASS / FAIL / PARTIAL / BLOCKED`、OS/arch、SHA、实际 API endpoint/receipt、授权 repo、权限、错误/成本/时延；不因为测试数增加或 PR 合并直接判定真实验收通过。原 #41/#65 GH01–10 和 #61 Approval/GET-verify 继续独立有效。

## 9. 首轮交付合同（给 Coding Agent）

**只执行 GC-00 + GC-01；可以两个小 PR，GC-01 基于已审阅的 GC-00。GC-00 已于 2026-11-23 交付，下一 PR 为 GC-01。** 不在首轮实现 GitHub App、Device Flow、TUI Connections、Desktop、仓库发现、完整 SDK、第三方插件、MCP 写、自动 merge，也不修改现有模型路由/Plan Loop。

开始前：读取 `docs/29`、#68、#71、当前 main 源码与已有测试；列出可复用模块与真实缺口；若与最新 main 冲突，以代码事实为准并在 PR 说明差异。制定最小接口、迁移/回滚和风险方案，先测试 E1 负例，再接 Core API / CLI。

交付：代码 PR（清楚分支/提交范围）、新增测试、兼容文档、真实/模拟验收记录、精确配置步骤及安全影响说明。运行 `npm run typecheck`、`npm test`、仓库实际配置的 secret scan / install smoke / macOS-Windows CI；失败不得声称完成。外部授权必须由 owner 手动完成；不得自行请求私有凭据、提交秘密、修改远程业务仓库 Issue、运行无人值守付费、自动合并。

## 10. 兼容、回退和非目标

- 增量迁移应支持旧 `GITHUB_TOKEN` 和 existing OAuth 数据；恢复需要正确加密密钥，无 key 时显式 reauth_required，不静默回退高权限 PAT。
- 关闭新连接 feature flag 后旧 GitHub read 路径仍可按既有授权工作；旧审批、已失效 credential、未完成 OAuth 会话安全处理。
- 不实现通用账户云同步、Marketplace、完整插件 SDK、远程任意命令、自动写 Issue/Push/Merge、默认全 repo 授权。GitHub App 跟 MCP OAuth 并非同一凭据协议，不假定互通。

## 11. 官方依据（实施前重新核对）

- [GitHub Apps：User access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub Apps：Installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub Apps：Building a CLI / Device Flow](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-cli-with-a-github-app)
- [GitHub Apps：Public vs private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [GitHub Apps：Security best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
