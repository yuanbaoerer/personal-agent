# 09 · 自托管与开源复用工程规划

> 2026-11-14。此文是 v0.4 Open-source Ready 的验收清单；当前仓库是 private，不能将本清单视为已交付功能。见 docs/07-long-term-roadmap.md。

## 1. 发布定位

发布一个可自行部署的**单用户 Personal Agent 应用**，不宣称多租户 SaaS、共享数据隔离或“开箱即用所有渠道”。每个实例有独立主人身份、SQLite/DO 数据、模型凭据及工具授权；后续多渠道必须通过明确跨渠道身份绑定。二次开发者可替换 Provider、Tool 与 Channel，但首版不承诺稳定 SDK。

## 2. 标准安装体验

- 一条**经过实验验证**的标准启动路径，开发者从 README 可判断需要的 Node 版本、配置、外部服务和预计成本。Node 自托管是优先候选，但最终选择需通过 ADR 的技术门槛；Cloudflare 部署路径可保留为可选能力。
- 提供 .env.example、配置解释、环境诊断命令和不包含个人凭据的示例。
- Docker Compose（如选定 Node）须声明持久卷、健康检查、重启策略、最小权限、数据备份位置。禁止将 .env 打进镜像；运行时 secrets 单独注入。
- 第一次启动明确说明平台机器人权限、owner 绑定、模型密钥、消息接收方式；严格拒绝未知发送人而不是默认放行。
- 提供从空实例执行 G1 的逐步操作和预期结果，错误有排查路径，不要求手工编辑 SQL 才能恢复。

## 3. 运行时与适配契约

复用项目已有核心接口，避免提前做复杂插件框架：
- ModelProviderConfig：provider/model、timeout、上下文上限、费用元数据和可用性检查；不要求同时调用多个模型。
- ChannelAdapter：validate/normalize/ack/send/reconcile，明确平台幂等、主动消息和长连接/回调限制。平台无法查询发送结果时须转 needs_manual。
- ToolCapability：tool ID/version、read/write、输入输出 schema、资源白名单、超时/大小上限、重放规则、verify 语义。
- AgentRuntime：open/submit/wait/interrupt 与稳定 operationId；替代宿主必须通过共同契约测试。
- Storage/Scheduler：运行环境注入而不在业务逻辑中直接分支；迁移和备份规则有版本号。

不要因“插件系统”暴露可任意执行 Shell、系统文件、浏览器或任意网络目标的权限。扩展接口不应绕过 ActionService 的审批与审计。

## 4. 数据生命周期、迁移和恢复

- 规定应用表 pa_* 与 Pi 会话表 pi_* 的迁移边界；每次 schema 变更应有 forward migration、回退策略或明确的向前修复步骤。
- 备份需要同时覆盖应用状态及所需会话状态，避免只复制 pa_* 导致孤儿运行时引用。验收包括新实例恢复、任务和提醒数据核对。
- 明确本地 SQLite 的安全关停、WAL、一致性备份、定期备份位置、恢复演练；Cloudflare DO 的 PITR/备份功能需按实际账户能力验证。
- 实现记忆导出/删除、任务/审计保留期策略；说明“删除一条记忆”不等于彻底清除 Provider 或 Pi 对话日志。
- secret 轮换、过期与模型失效要有测试和操作说明。

## 5. 安全与隐私发布阻断项

- OWNER 身份绑定不得依据昵称、消息正文或模型猜测；多渠道绑定不得复用未经验证的 actor 字段。
- 只读工具也应限制范围；外部资料视作不可信数据，不能扩大 Mandate。
- 非公开 token 不得出现在示例、日志、Issue、录屏、测试 fixture、配置默认值中。
- /ask、/admin、webhook 等端点必须进行配置缺失和未认证访问测试；Webhook challenge 不应跳过实际消息校验。
- Action approve→claim→execute 的任务版本、授权和 nonce 检查必须通过 K08–K11、K14。
- 建立 SECURITY.md：漏洞报告途径、密钥轮换、已知威胁面及支持版本。做依赖许可证和安全审查，检查允许再分发的范围。
- 仓库公开前清查 Git **全部历史**（不仅最新文件），特别是 .env、飞书凭据、消息 ID、open_id、内部 Workers 域名和私人使用场景；需要时重写历史并轮换可能暴露的密钥。私有仓库转公开是单独的人为发布决策。

## 6. 社区交付最低要求

- LICENSE：先选定兼容的开源许可证，确认依赖和复制的第三方片段；尚未完成前不要宣称项目已获正式开源许可。
- README：定位、截图/演示（可选）、功能状态表、5–10 分钟 Quickstart、成本说明、部署方式、常见故障。
- CONTRIBUTING.md：Issue 模板、分支/PR 工作流、测试指令、验收要求、行为规范。
- CHANGELOG / 版本政策：实验阶段说明不稳定接口；标明 SQLite schema 与 Pi SDK 的升级不兼容风险。
- CI：基本检查、锁文件、测试、依赖安全审计；main 保护/PR 审核为建议项。
- 发布：提供 tagged release 和对应运行证据，而不仅是仓库某个 commit。

## 7. 第二开发者验证

邀请另一位开发者在全新环境按公开文档完成以下步骤，并记录实际阻塞：
1. clone、准备凭据、启动、验证身份拒绝和主人接收。
2. 执行 G1 GitHub 只读查询，检查真实来源与飞书回复。
3. 新建提醒、重启实例、确认唯一发送。
4. 执行一份备份，恢复到新位置，核查关键状态。
5. 撤销/修改一个任务并复现相应测试。
6. 报告部署时长、错误、修改的文档和不得不直接更改源码的环节。

如果任一步依赖开发者私有 Token、隐式服务或口头指导，则不满足 Open-source Ready 门槛。

## 8. 与 Issue 对应

PA-12 标准部署；PA-13 适配器；PA-14 数据与升级；PA-15 开源治理与安全；PA-16 独立用户复现。先通过 PA-01～PA-11 才进入正式外部发布验收。
## 9. macOS 与 Windows 原生分发要求（2026-11-14）

开源复用不只要求 Ubuntu/Linux 服务器可以运行。CLI/Core 的正式目标包含 macOS Apple Silicon / Intel 及 Windows 11 x64 原生安装（不能仅给 Windows 用户 WSL2 方案）；Windows ARM64 待兼容性验证。Desktop 安装包必须单独在目标平台验证运行、签名/公证、权限和升级，尚未验收不得标记“支持”。标准 Client SDK 允许 Desktop、TUI、CLI 连接同一 Core，并在多设备操作时共享权威任务和审批状态。对 OS 数据目录、SecretStore、后台启动/停止、路径、终端兼容、CI 测试及第二开发者 macOS+Windows 复现的要求见 [10 · 跨平台客户端规划](10-client-platforms.md)。

## 10. 全球开源社区发布准备与权限边界（2026-11-14）

现有 PA-14（数据实际导出/恢复）、PA-15（许可证/安全/历史秘密）、PA-13（Provider/Channel/Tool 接口）、PA-22（OS 构建矩阵）继续承担具体实现；新增 PA-23～PA-29 的国际化、地区服务可用性、Agent 安全红队、Data Flow、可信发行、社区治理及无障碍是**互补的独立验收专题**。英文 README/Quickstart、明确许可证、SECURITY、全历史秘密检查、真实可用路径是 Public Alpha 发布前条件；Desktop/TUI 不必是 Public Alpha 前提。第三方 Provider 的地区服务限制与当地法律不能通过“自托管/开源”一笔勾销。具体分期与发布阻断项见 [11 · 全球开源社区路线图](11-global-open-source-community.md)。

## 11. 可扩展模式不是公开发布强制依赖（2026-11-17）

全球开源开发者可通过扩展 WorkProfile 与 ExecutionStrategy 定义领域和受控执行方式；实现须服从单一 Core、持久任务与授权边界，定义版本/兼容/禁用，不允许模式包自动获取凭据或全系统权限。**Coding 和 Organization 的完整能力不是 Public Alpha 或 v0.4 Open-source Ready 的阻断项**；公开前仍以核心可靠性、许可证、秘密审计、清晰英文文档和可执行使用路径为先。见 [12 · Mode Architecture](12-mode-architecture.md)。

## 12. 可选模型 Gateway 与多模型发布边界（2026-11-17）

全球开源使用者可直接配置受支持 Provider，也可选用 Magpie 或其他经验证的兼容 Gateway；**Magpie 不应是安装、升级或 Public Alpha/v0.4 Open-source Ready 的必需依赖**。模型适配由原 [PA-13](https://github.com/yuanbaoerer/personal-agent/issues/14) 保持稳定，Session 级模型绑定和 Gateway 路由扩展按 [13 · Model Routing & Gateway](13-model-routing-gateway.md) 分阶段落地。

远程 Gateway 必须明确 TLS、最小权限的 Key、可用模型范围、费用上限和数据处理/出站位置；`127.0.0.1` 仅指相应运行宿主的本地回环地址，不能从 Cloudflare 直接指向用户 Mac。开源文档不能以“OpenAI 兼容”直接保证 Pi 的流式工具调用、reasoning、恢复与上下文完全兼容；展示真实测试矩阵和已知限制。Gateway 内部模型可能变化，不得错误声明模型固定、准确账单或无条件零重复执行。
