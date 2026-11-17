# 11 · 面向全球开源社区的产品、可信与治理路线图

> 修订日期：2026-11-14。类型：长期规划与发布验收规则，**不是已实现声明**。本仓库目前仍为 private，公开代码仓库必须由所有者另行明确决定。
> 产品定位：**A reliable, self-hosted, cross-platform personal AI agent.**
> 先读：[07 · 长期路线图](07-long-term-roadmap.md) · [08 · 评测](08-evaluation.md) · [09 · 自托管与开源](09-open-source-plan.md) · [10 · 跨平台客户端](10-client-platforms.md)。

## 1. 全球开源 ≠ 多语言 GUI ≠ 多租户 SaaS

目标用户是希望控制个人数据、自行提供模型密钥、运行个人智能体的开发者及有技术能力的个人。**优先交付一个完整、可信、可解释的单用户产品**，而非追求最多 Provider、最多国家、最多插件或最复杂桌面 UI。

需区分三种发布状态：
- **Private Alpha（现在）**：开发者自用，目标 v0.2 Reliable Core 的真实端到端、任务一致性、授权、恢复。
- **Public Alpha（有条件开放源代码）**：公开前完成许可证、历史敏感信息排查、基础安全模型、英文 Quickstart、真实环境可重现的核心使用路径和清晰的已知限制；可在 CLI-first 情况下开放，不要求 Desktop/TUI 先完成。
- **Public Beta（社区独立部署）**：macOS/Windows/Linux 受声明范围支持、Provider/渠道可替换、备份/升级可验证、用户反馈形成回归测试、发布产物有可检查的来源。
- **Stable v1.0（维护承诺）**：任务成功与恢复数据、升级兼容与支持范围、安全漏洞处理和已验证的长期自用指标；不能把“Public Alpha 已开源”写成“Production Ready”。

版本号与公开时点是两个正交决策：v0.4 当前仍定义 Open-source Ready 的**工程交付门槛**，不能反过来要求 v0.4 所有 UI 完成才能开放源码。发布到各国家/地区的第三方 SaaS 服务适用性，不由“开源”自动保证。

## 2. 全球化准备检查矩阵

| 维度 | 需要具体实现/文档化的内容 | 本次专项 | 既有负责人/避免重复 |
| --- | --- | --- | --- |
| i18n/l10n | 英文 Quickstart 与 CLI Help、中文可用、翻译资源、日期/时区/Unicode | PA-23 | PA-18/19/20 的客户端落地 |
| Provider/Channel 地区适配 | BYOK、兼容 Provider、无飞书也可本地/CLI 使用、限制明确 | PA-24 | PA-13 负责抽象接口，PA-17/18 负责 Client API |
| Agent 安全威胁 | Prompt Injection、数据/工具授权隔离、Local Connector 安全、恶意扩展 | PA-25 **P0 设计** | PA-03/07/13 负责修补实际执行边界 |
| 隐私和数据流 | Data Flow、遥测 opt-in、日志最小化、导出/删除承诺边界、供应商透明 | PA-26 | PA-14 实现数据导出/恢复，PA-15 做发布前安全检查 |
| 可信发行 | 产物 hash、tag、SBOM、provenance、签名/升级与 rollback | PA-27 | PA-22 做平台 CI/安装包，PA-15 做历史秘密审计 |
| 社区运营 | 英文贡献流程、维护者权限、RFC/ADR、版本兼容、漏洞处理目标 | PA-28 | PA-15 创建基本文件和许可证 |
| 无障碍/可理解性 | 键盘、屏幕阅读器、TUI 无色/窄屏、可本地化错误、无障碍验证 | PA-29 | PA-19/20 实现终端/桌面交互 |
| 模型输出质量 | 不同地区语言/时区的独立测试，跨语言 Prompt Injection 案例 | PA-23/25 | PA-11 维护既有 40 场景契约 |
| 数据/法规 | 不声称全球合规或自托管自动豁免；数据主体请求/供应商/地区限制说明 | PA-26 | 如未来提供托管 SaaS 需专项法律审查 |
| 可持续维护 | 发布/弃用支持政策、Issue triage、脆弱单维护者风险 | PA-28 | PA-15 基本治理和 SECURITY |

专项是**新增设计/验收缺口的 owner**，不替换 PA-01～PA-22；重复的实施应回到原 Issue 中通过 PR 完成。

## 3. 国际化和地域语义（PA-23）

### 3.1 内容和语言
- **面向全球的英文 README / Quickstart 为优先维护文档**；中文保持同等核心功能说明；不得为了翻译在当前阶段复制整套产品规划文档。
- UI 可选 locale 与 Agent 对话语言、系统 Prompt 语言相互独立。错误码/协议/CLI JSON 输出为机器稳定值，不依赖本地化文本解析。
- 采用消息键和资源字典，不在代码中硬编码中英两套文案或拼接语法；时区/数字/日历/单位/日期输出使用平台国际化 API。
- 默认 locale 选择、用户覆盖、缺失翻译 fallback 有明确规则；语言切换不影响数据库 id、Task revision 和审批 payload hash。

### 3.2 跨地区时间与 Unicode
- 内部持久化具体时刻为 UTC，周期计划保留 IANA timezone 与用户约定的本地钟表时间；夏令时不存在时刻和重复时刻必须给出可解释行为。
- 测试中文、重音字符、阿拉伯/希伯来 RTL 文本、emoji、组合字符、长文件名、Windows 路径与 Unicode；平台能否完整支持 RTL 无障碍需要实际 UX 验证，不能仅以字符串显示正常声称完整本地化。
- 模型自身回答语言的准确性属于模型能力，不等同 UI 翻译功能的完成。

### 3.3 最小发布门槛
至少 G1（项目助手）英文路径完整、英文安装手册可复现；中文原有使用不退化；跨时区提醒/状态输出通过基本测试。

## 4. 跨地域的 Provider 与 Channel（PA-24）

- 核心任务必须可在**不启用飞书**时通过本地或远程认证 CLI 触发、查询和取消；飞书保留首个高价值 IM 渠道，但不是不可绕过的 bootstrap 依赖。
- 用户自行提供兼容模型凭据（BYOK）；在 README 中说明 Provider 的费用、数据流向、地区可用性、条款由第三方决定，并单独说明无 API Key/Provider 不可用时的行为。
- 拆清 Channel 与模型可用性：某国家不可用飞书不意味着产品不能使用；某 Provider 不支持 tool calling 要显示缺失能力而非悄悄降级为可能误导的“成功”。
- 对本地模型支持采取 capability checks：已验证支持工具调用、上下文长度和恢复语义之后再承诺，不说“支持任何 OpenAI 兼容模型”。
- 最小兼容性矩阵：标准部署 + CLI + 当前默认 Provider，以及至少一个不同 Provider 的真实模型任务；故障时保留任务、不得泄露密钥或盲目重试写操作。
- 不做规避地区限制、代理绕过服务协议或内置供应商账号共享。

## 5. Agent 特有的安全威胁模型（PA-25，必须提前）

关注的不是泛泛的 OWASP 列表，而是**基于本仓库可信边界和真实业务的可复现攻击路径**。

### 5.1 信任边界
1. 主人（owner）和各 Client Device / IM actor 的真实身份。
2. 用户明确交代的 Task/Mandate/Approval。
3. LLM 生成的计划/工具参数/Worker 回报，永远不构成程序级授权。
4. GitHub Issue/网页/第三方文件/搜索结果等**不可信数据**，不能提升指令优先级。
5. Tool、Local Connector、系统文件与 secrets：权限在代码中被限制，不能只通过 prompt 声明。
6. 外部 Provider、日志/遥测、备份是潜在的数据外传路径。

### 5.2 至少覆盖的安全用例
- SEC01：恶意 GitHub Issue 内容要求泄露 API Key 或绕过 Mandate；拒绝并记录污染来源。
- SEC02：非白名单 repo、错误 owner、不同 device token 尝试读取/修改其他资源；零未授权执行。
- SEC03：读取外部文档时其中含有“系统指令”；不能变成 save_memory 或自动 approve。
- SEC04：已获批 Action 在 revision/cancel/expiry 竞态后不得新增外部写；在途进入 reconcile。
- SEC05：Local Connector 默认拒绝任意 Shell、未授权目录、任意网络目标；手动申请更细权限并可撤销。
- SEC06：第三方扩展不能自声明无条件获取系统密钥、历史聊天或所有工具能力；资源隔离与审计。
- SEC07：恶意超长输入、递归工具链和高成本请求不能突破 budget/timeout / output limits。
- SEC08：无论中文、英文或混合语言，外部文本都不可以利用语言差异越过权限边界。

输出 threat model/攻击图、测试样例、测试结果与未覆盖边界；仅报告**已验证场景**中的未授权执行数，不夸称“绝对安全”。不引入默认高权限浏览器/系统操作；即使扩展接口存在，也不意味着允许插件不受控地执行。

## 6. 数据自主权、隐私、遥测（PA-26）

### 6.1 Data Flow 作为公开发布文件
逐项列出：飞书/CLI 输入、Router/Worker prompt、任务和记忆、Tool 返回、日志、评测数据、备份、Outbox，以及与模型和外部 API 的**出站流向**；标明主体、目的、保留期、位置（local/Cloudflare/Provider）、加密与删除边界。提供本地部署和可选云端的两种图。

### 6.2 默认行为
- 遥测默认**关闭**；若以后引入，明确 opt-in、展示采集字段和独立撤回；崩溃日志不得包含凭据/完整聊天原文。
- API 密钥不得写入运行日志、测试 snapshot、公开 issue 或发布资产；最小化保存工具原始输出。
- 记忆可查看/删除/导出，但不得声称删除本地 memory 等同清除 Pi transcript、第三方 Provider 日志或离线备份。
- 用户同意 GitHub 读取，不自动同意将全部返回事实保存为长期个人记忆；长期记忆必须具备明确来源和撤销机制。
- 所有公开 Eval / 示例只能使用合成数据或经明确授权的脱敏样例。

### 6.3 合规边界
开源软件、自托管使用或许可条款不自动满足 GDPR/其他当地隐私法律。作为自托管工具提供者，须清楚区分软件维护者、部署者与外部 Provider 的责任；若开始经营托管 SaaS，需另立产品、法律、数据处理与事故通知专项，不把现阶段的技术清单称为全球法律合规证明。

## 7. 可信发行与供应链（PA-27）

按投入成本分阶段：
1. **Public Alpha**：锁文件、依赖检查、CI 最小权限、明确许可证、tagged release、CHANGELOG、公开 SHA-256 和对应 commit。
2. **Public Beta**：各目标 OS/arch 构建可追溯，发布机器可读构建元数据和 SBOM，适用平台支持 artifact provenance/attestation；验证产物可由发布证据对应到同一 commit。
3. **Stable/正式 Desktop**：macOS 签名/notarization、Windows 安装包签名和更新策略、自动更新/回滚安全；无法签名时明确标实验状态，不绕过系统安全检查。
- 依赖漏洞扫描需要人审例外策略；“扫描通过”不等于没有漏洞。供应链证明不等于产物可安全授予任意系统权限。
- 发布密钥、GitHub token、构建工作流权限必须最小化；不允许不受信任 PR 直接访问发布秘密。

职责划分：PA-22 构建 OS matrix/可安装包；PA-27 定义可信来源与 Release 验收；PA-15 审核 Git 历史和许可证。CI 运行环境必须作为报告的一部分，不能把 Ubuntu 结果替换 Windows/Apple Silicon 验收。

## 8. 许可证、贡献、治理（PA-28）

- LICENSE 的**最终选择属于仓库所有者**；可评估 MIT、Apache-2.0、AGPL-3.0 的条款适用性，核查第三方依赖许可和复制代码。不能因为计划写了 MIT 就替所有者自动选定。
- 英文 README/CONTRIBUTING/SECURITY/Issue & PR templates，中文补充可独立提供。欢迎不同国家贡献时，维持统一 issue 模板、Bug Reproduction 环境信息、CI 指令。
- 为大的 API/schema/权限变动使用 RFC/ADR，先解释需求、兼容性/迁移、安全后再写代码；轻量修复无需走重流程。
- 明确 CODEOWNERS 或维护责任、保护主分支、Code Review 标准、Release 发布权限和紧急安全修复流程。
- 维护版本策略：什么算 breaking change、最低受支持版本/Node OS、弃用期限、数据库迁移与恢复说明；未发布时公开“experimental/unstable”状态。
- 首次公开前记录一个最小问题分类：bug、security（私密报告）、good first issue、docs、integration、proposal。设计清晰的初学者贡献路径，不要让所有 issue 都要求理解 Coordinator。
- 重要的治理风险：单维护者发布凭据与审查权限集中。需要管理恢复方案和最小必要的共同维护责任，但不需立刻建立组织委员会。

PA-15 实现基础 LICENSE/SECURITY/CONTRIBUTING/secret 扫描；PA-28 针对持续运营、维护规则、可持续贡献验收，两者不是重复做文档。

## 9. 无障碍与跨文化体验（PA-29）

- CLI：错误应有机器可读码和用户可执行解决建议；不可要求颜色才能区分危险审批状态。
- TUI：键盘全操作、焦点/ARIA 等价（适合终端实际能力的文字反馈）、窄屏/无色模式、长输出截断说明、屏幕阅读器兼容性测试。
- Desktop：语义化控件和屏幕阅读器标签、键盘焦点顺序、对比度、缩放与减少动画；明确系统通知权限与不可达状态。
- 语种/RTL 支持需要真实 OS/终端验收；对尚未支持的方向、平台和文本布局标 known limitations。
- 不做不真实的“全球语言/无障碍全覆盖”营销宣称，明确测试语言和设备。

## 10. 版本门槛：必须做/可以后做

| 目标阶段 | 必须通过 | 可以继续完善 |
| --- | --- | --- |
| v0.2 核心闭环 | PA-01～PA-06 中的权限、修订、恢复与端到端；PA-25 的威胁模型和 P0 攻击用例最小集 | 完整多语言 GUI、正式二进制发布 |
| Public Alpha | 明确 LICENSE、全历史 secret 复核、SECURITY、英文 Quickstart、单条可用不依赖特定 IM 的路径、安全/隐私免责声明 | Desktop、插件生态、SBOM 完整覆盖 |
| v0.3 自用 + 走向全球 | PA-23 最小国际化、PA-24 BYOK 和 CLI-only 路径、PA-26 Data Flow、真实 G1/G2/G3 与 7 天使用 | TUI/桌面全部正式发行 |
| Public Beta / v0.4 工程准备 | PA-27 Release provenance/SBOM（覆盖实际发布产物）、PA-28 维护与贡献、原 PA-12～22 的跨平台和备份验收 | 世界所有国家或语言的服务商接入 |
| Stable v1.0 | 30 天使用/恢复证据、已发布平台升级迁移、安全维护流程、最低无障碍要求；未覆盖范围明示 | 多租户 SaaS、插件市场 |

**发布阻断**：未授权外部写、可利用的凭据外泄、无法辨识数据发送去向、未验证安装包宣称官方、安全问题缺少私密报告渠道、无许可证却宣称开放源代码。若发布前检查不通过，仍保持 private；仓库 visibility 变更必须由所有者明确确认。

## 11. PA-23～PA-29 执行序列与边界

| ID | Priority | 核心交付 | 依赖 / 联动 |
| --- | --- | --- | --- |
| PA-23 | P1 / v0.3 | i18n 基础设施、英文 Quickstart/CLI、跨时区与 Unicode | PA-18、PA-22 |
| PA-24 | P1 / v0.3 | 非飞书路径、BYOK/Provider capability 与全球使用矩阵 | PA-01、PA-13、PA-17/18 |
| PA-25 | **P0（立即做威胁模型）** | Trust boundary、SEC01–SEC08、攻击用例与修复清单 | PA-03、PA-07；威胁模型可先行 |
| PA-26 | P1 / v0.3 | Data Flow、隐私/遥测/保留与删除语义 | PA-14、PA-15 |
| PA-27 | P1 / Public Beta | Release 可信证据、SBOM、产物 hash、签名边界 | PA-15、PA-22 |
| PA-28 | P1 / Public Alpha & Beta | 社区治理、RFC/ADR、维护/版本政策 | PA-15 |
| PA-29 | P2 / Beta→Stable | 无障碍验收、终端/桌面可理解性 | PA-18/19/20、PA-23 |

具体 Issue 中需包含 DoD、真实环境证据和未验证项；不要把这些增加到现有 40 场景的成功数量中，可用 SECxx、I18Nxx、RELSxx、A11Yxx 作为独立专项集合。在 README 用现实状态表展示某个发布阶段哪些门槛真的达标。

## 12. 可维护性与开源成功的量化指标

- 第三方从空环境部署 G1 的完成率、阻塞步骤、安装时间、跨平台/跨 Provider 的可复现结果。
- issue 从提交到首次 triage 的时间、未处理的 security issue 数、PR 复现实验信息完整率。
- 发布可核对的来源覆盖率（实际发布产物中有构建证据的比例）。
- 匿名/用户允许的真实错误类别统计；不以收集更多用户隐私换取指标。
- 按使用价值、支持成本、风险决定新功能，而不是以 GitHub stars 为唯一目标。

> 未来成为全球开源社区使用的项目，依赖的是**可验证的可靠性、诚实的支持边界、开放可审查的治理和受控的维护成本**，不是同时发布最多平台和最复杂的 Agent 抽象。

## 13. Mode 架构的全球开源贡献边界（2026-11-17）

未来的 Coding / Organization 体验采用 **WorkProfile × ExecutionStrategy**，而不是为每个 Mode 重复维护一份后端状态机、权限与数据库。模式定义、Skill 和 WorkflowTemplate 应具有版本、禁用/回滚与权限声明；不能因安装第三方模式而自动获得 Shell、文件或网络执行权。跨语言客户端共享稳定 mode ID 与错误码，界面文案独立国际化。Organization 可作为后续实验性可选能力，**不阻断 Public Alpha 或 v0.4 自托管开源发布**。详见 [12 · Mode Architecture](12-mode-architecture.md)。

## 14. 全球模型网关可选兼容与数据治理（2026-11-17）

个人自托管 Core 必须支持在**没有 Magpie 或中转 Gateway 时**通过已验证的 Direct Provider 完成核心流程。Magpie 仅是可选 Gateway Adapter，用户自行配置可达 Endpoint、Key、出站权限和可用模型列表，不能默认代理其私有对话和工具结果。第三方 Gateway 可能访问完整提示词与模型输出，因此 Data Flow、不同提供商的数据处理范围、密钥隔离、审计与撤销策略应覆盖这段路径。

模型目录和协议兼容需要真实运行验证；模型路由组的逻辑名称、实际 Provider/Model、价格元数据来源和容灾情况可能不同，不可混为同一审计事实。个人 Agent 的业务授权、预算和完成判定始终由本地 Core 执行。完整边界及独立 MRT 测试见 [13 · Model Routing & Gateway](13-model-routing-gateway.md)，与 PA-24、PA-26、PA-27 协作，不能声称项目已经支持所有国家/模型。
