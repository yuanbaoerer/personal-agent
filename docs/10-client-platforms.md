# 10 · 跨平台客户端与桌面部署规划（macOS / Windows）

> 2026-11-14 规划修订；2026-11-19 状态更新。目标：一个 Personal Agent Core，多种客户端，macOS 和 Windows 都能够原生使用。**当前已有本地 Node 的最小 Client API、`pa` CLI 和 `pa tui`（E1）**；远程设备鉴权、SSE/WS、跨平台安装/键盘/终端验收和 Desktop 仍未完成。
> 对应主规划：[07 · 长期路线图](07-long-term-roadmap.md)、[08 · 评测](08-evaluation.md)、[09 · 开源](09-open-source-plan.md)、[ADR-0001 · 运行时](adr/0001-runtime-hosting.md)。

## 1. 基本原则：One Agent Core / Multiple Clients / Cross-platform

CLI、TUI、Desktop、Web、飞书等是**不同交互入口**，不是各自独立的 Agent 或独立数据库。所有客户端读写同一个 Coordinator/Task/Assignment/Approval/Memory/Outbox 状态。

建议的逻辑边界：

    macOS CLI / TUI / Desktop ─┐
    Windows CLI / TUI / Desktop ├── Authenticated Client API ── Personal Agent Core
    Web / Feishu / other IM ────┘                                  │
                                             Runtime · Durable Storage · Tools · Scheduler

- Core 可以在本机自托管、另一台服务器或支持的云端宿主运行；**桌面 GUI 不应强制捆绑另一份 Agent Core**，以免用户在 Mac 和 Windows 上各有一份互不一致的任务状态。
- CLI / TUI / Desktop 可以附着在本地 loopback 或远程实例；连接管理属于 Client SDK。远程连接必须鉴权、加密并具备凭据撤销能力。
- 本机系统能力（文件、通知、开机自启、设备操作）由 Local Connector 与操作系统 Adapter 处理，不默认给模型或 UI 宿主进程任意系统权限。
- 控制命令与聊天命令使用同一后端授权/状态迁移；不能通过 CLI、TUI、Desktop 绕过 ActionService。
- 尽量保持 TypeScript Core 和共用 Client SDK；不要同时实现四套后端、把系统包装层混入业务核心。

## 2. 目标平台支持矩阵

| 操作环境 | CLI | TUI | Desktop | 本地 Core / Connector | 交付策略 |
| --- | --- | --- | --- | --- | --- |
| macOS Apple Silicon (arm64) | 正式目标 | 正式目标 | 正式目标 | 正式目标 | v0.3 CLI；v0.4 TUI；Desktop 后续 |
| macOS Intel (x64) | 正式目标 | 正式目标 | 正式目标 | 正式目标 | 单列安装/测试证据，不把 arm64 通过等同 x64 |
| Windows 11 x64 | 正式目标 | 正式目标 | 正式目标 | 正式目标 | 原生 PowerShell/Windows Terminal，不强制 WSL |
| Windows ARM64 | 兼容验证 | 兼容验证 | 后续验证 | 后续验证 | 验证依赖及打包后再承诺 |
| Linux x64 | 必须支持 Core 和 CI | 目标 | 后续 | 必须支持 | 开源自托管/服务器基线 |

“正式目标”是未来发布验收要求，不是当前已支持承诺。具体最低 OS 版本由依赖支持矩阵和真正安装测试确定。Node 官方提供 Mac x64/arm64 与 Windows x64/arm64 包，但 Node 本身跨平台**不等于** Pi、native SQLite/SDK、TUI、打包器和 Local Connector 都能正常运行；逐项验证。

## 3. 三类客户端职责

### CLI（优先落地）
- 命令示例：pa ask、pa task list/show/cancel、pa approve、pa memory list、pa doctor、pa config show、pa events。
- 有交互与非交互两种模式；自动化命令支持 --json/稳定 schema、退出码和 stdout/stderr 分离，重试写命令有稳定 request id。
- Windows PowerShell、cmd 和 Windows Terminal 可用；macOS zsh/bash 可用，不依赖 bash-only shell 脚本，不把字符串插入 shell -c。
- 配置 Core URL、账户、设备认证、凭据轮换与 TLS；不在控制台打印 token。

### TUI（CLI 与 SDK 验证后）
- 用一个终端仪表盘查看 Task/Assignment 状态、取消/修订、Approval、Outbox unknown/needs_manual、运行 trace。
- 复用 CLI 的 Client SDK 和 API，不直接访问 SQLite，也不偷偷创建后台 Core。
- macOS Terminal/iTerm2 与 Windows Terminal/PowerShell（ConPTY/ANSI 能力检测）要求响应式布局、键盘导航、窄屏回退、非 TTY 提示。
- 断线后基于事件游标恢复订阅，不重复提交写指令；审批必须显示不可变参数与有效期。

### Desktop（TUI 可用后进行选型）
- 主要提供复杂任务看板、审批中心、记忆和连接管理、通知、故障核对、可选系统托盘。
- Tauri v2 与 Electron 是候选实现，不在 Spike 前定死。评估项目的 TS/UI 复用、原生依赖、体积、更新安全和目标 OS 签名打包。
- macOS .app/.dmg 的签名与 notarization、Windows .msi/.exe 的签名/安装策略、自动更新与回滚是发行责任，不能仅将 npm dev 跑通称为跨平台正式支持。
- Tauri Windows 开发/运行环境的 WebView2 依赖和 macOS Xcode Command Line Tools 构建要求需在技术 Spike 中验证。Desktop 不自动获得个人文件或系统通知权限。

## 4. 必须先稳定统一 Client API

建议先引入应用级 API 与 TypeScript Client SDK，而不是让每个 GUI 连接内部 Service。

- Control Plane：task.create/list/get/cancel/revise/supplement；approval.list/approve/deny；memory.list/save/delete；reminder.list/create/cancel；admin.status/diagnostics。
- Event Plane：任务/派工状态、进度、消息投递、审批请求和成本事件。可选 SSE 或 WebSocket；必须支持断线重连、eventId/cursor、重放上限与防重复呈现。
- 协议：稳定 requestId/idempotencyKey、ownerId/instanceId、correlationId、schemaVersion、结构化错误与可区分的取消/请求超时。
- 身份与权限：本地回环接口也需明确 owner 绑定，远程使用受保护的 token 或设备配对。CLI/TUI/Desktop 不能共享一个永久 root/admin token 到所有设备；至少设计设备撤销与最小权限。
- 文件/大输出以引用或安全下载处理；避免把完整私有文件流重复写入聊天日志。
- 并发一致性：CLI 的 cancel 与 Desktop 的 approve 由后端原子校验；终端不拥有独立权威状态，不允许客户端离线写回覆盖新 revision。

## 5. macOS / Windows 系统差异必须隔离

| 关注点 | macOS | Windows | 工程策略 |
| --- | --- | --- | --- |
| 用户数据目录 | ~/Library/Application Support（按应用目录） | %LOCALAPPDATA%（按应用目录） | 统一 AppPaths，路径由 OS API 获取；不使用硬编码斜杠 |
| 用户配置 / secrets | Keychain 等系统安全存储候选 | Credential Manager / DPAPI 候选 | SecretStore Adapter；默认不明文落在项目目录 |
| 长期后台运行 | launchd / Login Items | Task Scheduler / Windows Service | ServiceHost Adapter；显式启动、停止、恢复 |
| 原生进程控制 | POSIX signals | Windows 进程/服务生命周期不同 | 不把 SIGKILL 当通用测试；按平台等价故障点验证 |
| CLI shell | zsh/bash | PowerShell/cmd | 以 Node API 为主；禁止依赖 POSIX 语义 |
| 终端 | Terminal/iTerm2 | Windows Terminal/ConPTY | 功能探测，ANSI/颜色回退 |
| 文件读写 | 路径大小写/Unicode/权限差异 | drive letter、反斜杠、文件锁、UNC 路径 | path/fs Adapter、临时文件与持久锁验证 |
| 桌面分发 | 签名/notarization、Apple Silicon/Intel | installer、签名、WebView2（如 Tauri） | 每个目标输出有独立构建和安装证据 |

macOS Intel 不应被“Mac 支持”一笔带过；Windows x64 必须有无需 WSL 的原生安装路径。Windows ARM64 的状态初期为 experimental/pending，不承诺未经验证的发行包。

Core 不应在普通业务流程中直接使用 os.platform() 分支和 OS 专用 shell 命令；平台分支集中在 adapters。文件路径通过 Node path/os 或受支持的系统 API 构造。

## 6. 跨平台测试矩阵与验收

### CI 基线
- 已有 ubuntu-latest 完整 CI；2026-11-19 新增 macOS job，macos-26-arm64 与 windows-2025-vs2026 均通过（npm ci、typecheck、275 tests、secret scan，最新 run `44502686441`）；macOS Intel、真实 Terminal/PTY 验收仍 pending。
- 按实际 runner 架构明确每份证据；macOS Intel 和 Apple Silicon 是两个不同 target；不能因同一个 macos-latest job 成功就宣称两个架构全部通过。
- Windows 原生 smoke：SQLite 创建/重启/文件锁、Feishu 事件 normalize、CLI 子进程生命周期、路径与空格/中文文件名。
- macOS x64/arm64 分别在真实机器或可信对应 runner 验证 Node/Pi 运行时、SQLite 恢复、CLI/TUI 行为。
- TUI：窄终端、无颜色、重连、退出恢复、键盘导航；PowerShell/Windows Terminal 和 macOS Terminal/iTerm2 中至少各一次 E3 真实交互证据。
- Desktop：每目标 architecture 构建、安装、启动/退出、系统权限、升级/回滚、错误恢复、签名/公证状态；无证据的发布目标标 pending。
- 外部安装者至少在 macOS 与 Windows 各完成一次独立 G1 + 恢复验收；保存 OS/arch/安装步骤/失败记录。

### 新增关键跨端契约
- K15：同一 Core 的两客户端并发修改同一 Task/Approval，不能重复执行、不能被旧状态覆盖。
- K16：客户端连接中断、重放或离线恢复后，订阅不丢业务事件、不重复发送写命令；无法核对写结果时标 unknown。
- K17：macOS/Windows 的原生安装、路径、持久化、权限与生命周期符合平台门槛；所有平台特定失败与修复有独立证据。

K15–K17 是建议扩展标签；不改写原 K01–K14 的定义，也不以新增测试数冒充原 40 场景的完成率。正式形成扩大后的场景集时，统一调整总样例数量和报告版本，避免把 40 场景与新增平台测试混算。

## 7. 规划里程碑与依赖

| Work ID | 推荐阶段 | 内容 | 依赖 |
| --- | --- | --- | --- |
| PA-17 | v0.3 / P1 | 跨平台统一 Client API + TypeScript SDK + 设备鉴权 + 事件订阅 | PA-01、PA-03、PA-06 |
| PA-18 | v0.3 / P1 | macOS/Windows CLI（JSON、退出码、doctor、任务/审批） | PA-17 |
| PA-19 | v0.4 / P2 | macOS/Windows TUI（任务/审批/告警与重连） | PA-18 |
| PA-20 | v0.4+ / P2 | Desktop 技术 Spike 和轻量原型；选型 Tauri/Electron | PA-17、PA-18 |
| PA-21 | v0.4 / P2 | 多客户端共享状态、安全授权与事件一致性 | PA-17、PA-19 |
| PA-22 | v0.3–v0.4 / P1 | macOS/Windows 原生 CI、打包/安装矩阵、平台系统适配 | PA-01、PA-18；Desktop 发行在 PA-20 后 |

注意：v0.4 Open-source Ready 是**无 Desktop GUI 前提**的可复用发布门槛；Desktop 最终正式发布可在 v0.5+ 规划，不因 UI 未完成阻断已验证的 CLI/自托管开源。跨平台 Core/CLI 则是 v0.4 的基本要求，必须在 macOS/Windows 有明确验收。

## 8. Non-goals

- 不做多个平台各自独立的 Coordinator/Memory。
- 不把 Windows 支持等同要求 WSL2；Windows 原生路径必须可验证。
- 不要求 Desktop 离线启动独立 Core（以后如有具体需求再设计 standalone mode）。
- 不在 CLI/TUI 中引入任意高权限本地命令工具或绕过已存在的 Approval/Action 体系。
- 不在 v0.2 核心闭环完成前把 GUI 开发升级为主线。

## 9. 后续维护

主规划 [07](07-long-term-roadmap.md) 的版本发布事实与本文件一致；开源交付 [09](09-open-source-plan.md) 增加 Mac/Windows 客户端安装复现，评测 [08](08-evaluation.md) 增加 K15–K17 但保留原 40 场景基线。所有平台“已支持”声明必须有对应 os/arch 的 CI、设备或安装记录。

## 10. 全球社区客户端要求（2026-11-14）

CLI/TUI/Desktop 的 `locale` 及对话语言相互独立，CLI 机器可读 JSON/错误码不随语言翻译改变。macOS/Windows 的原生支持不仅包含路径与安装，还包含 OS/arch 对应语言显示、Unicode、IANA 时区、无色/窄屏终端、键盘访问和故障提示。多端安全必须覆盖 Prompt Injection 从外部文档进入工具调用、设备 token 撤销和隐私日志限制；正式发行应有可验证来源与更新策略。详见 [11 · 全球开源社区路线图](11-global-open-source-community.md) 中 PA-23、PA-25、PA-27、PA-29。

## 11. 模式入口与多客户端共享（2026-11-17，设计提案）

CLI/TUI/Desktop/IM 不应各自实现 Coding Agent / Organization Agent 后端。统一 Core 的 Task 记录保存 WorkProfile × ExecutionStrategy 的**有效值和版本**。UI 可提供「General / Coding / Organized Work」预设，高级组合允许 Coding + Organization。CLI 命令和候选 API 形状参见 [12 · Mode Architecture](12-mode-architecture.md)；最终接口由 [PA-17 Client API](https://github.com/yuanbaoerer/personal-agent/issues/19) 确定。

客户端不能通过切换 UI 模式扩大正在运行任务的 Mandate；服务端负责认证、预算和版本修订。未实现的 Organization 在可用模式列表中应标记 unavailable/experimental，不能向 macOS/Windows 用户假装已交付。

## 12. 跨客户端的 ModelPolicy 配置与状态（2026-11-17）

未来 CLI/TUI/Desktop/IM 可在 Core API 支持后显示 **Profile × Strategy × ModelPolicy** 及每个 Task、Assignment、Workflow Node 的实际模型绑定/版本/消耗。用户可指定授权的模型配置或逻辑路由组，但客户端不得直写 Provider 凭据、实例级策略、`pa_*` 数据表或独立调用 Gateway 绕开 Core 预算。

建议在 [PA-17](https://github.com/yuanbaoerer/personal-agent/issues/19) 的 Client API 里纳入只读 ModelCatalog/Role Defaults 与受控设置，CLI 支持 `pa models list`、任务模型状态与 `pa doctor` 的 Gateway 连通性探测（**命令尚未实现**）。模型切换属于任务修订，生效结果应显示旧/新 Session 与是否有待核对动作；多平台密钥应使用相应 OS SecretStore。详见 [13 · Model Routing & Gateway](13-model-routing-gateway.md)。
