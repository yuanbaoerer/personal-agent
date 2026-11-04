# 01 · 可行性与技术栈核实

> 核查日期：2026-11-04。结论只对应当前公开文档与实测；beta/experimental 组件的变化风险单独标注。

## 1. 结论

| 判断 | 结论 | 置信度 |
|---|---|---|
| 截图中的技术栈是否真实 | **真实，且时间点很新**：Pi 1.0 / Pi Durable 于 2026-10-01 发布；Cloudflare `PiHarness` 于 2026-10-02 进入 beta。 | 高 |
| 能否支撑一个 personal agent 作品 | **可以**，而且比常见的“RAG + Chat”项目更能展示 durable execution、HITL、MCP、长任务与安全边界。 | 高 |
| 能否直接上生产 | **不建议**。Pi Durable 明确标注 experimental，`PiHarness` 是 beta，且每个 `agents` 版本只支持一个 Pi minor；回滚可能导致会话不可读。 | 高 |
| 截图里的 Kimi Computer Use 是否可云端托管 | **不可以**。官方 KimiCU 是 Kimi Work 插件 + 本地 macOS 桌面 MCP server（Apple Silicon macOS 14+，锁屏即失效）；社区 `kimi-computer-use` 还依赖 OpenAI Computer Use runtime、ChatGPT/Codex 签名启动器、辅助功能与录屏权限。两者都不能在 Cloudflare/Linux 运行。 | 高 |
| 米家 MCP 是否稳定 | **不稳定但可演示**。社区实现走小米云 API + 二维码 token，非官方接口；token 会过期，设备覆盖取决于 MIoT 映射。 | 中高 |
| 项目对 Agent 岗位的适配度 | **Agent Harness/Runtime 最强；应用/平台方向强；算法/Infra 方向需要补课**。详见 `03-job-fit.md`。 | 中高 |

**一句话**：这条链路的技术可行性成立，但必须把“演示级”与“生产级”分开；最脆弱的两块是 **PiHarness beta 的版本风险** 和 **本地 computer-use 的不可托管性**。架构上应把它们隔离在可替换的边界内。

---

## 2. 截图逐项拆解

| 截图表述 | 核实结果 | 对项目的影响 |
|---|---|---|
| “本地推荐 pi durable + pi sdk” | **基本准确，但表述省略了关键限定。** `pi` 是 Earendil Works 的 minimal agent harness；`@earendil-works/pi-durable` 是 2026-10-01 随 Pi 1.0 发布的 experimental durable harness；`pi sdk` 指 `@earendil-works/pi-coding-agent` 的进程内 SDK。Pi Durable 是独立包，不等于 coding agent SDK。 | 选型成立；但要接受 experimental API 变动，锁定版本。 |
| “cloud flare 托管你的 personal agent” | **成立。** Cloudflare Agents SDK 提供 `PiHarness`，把 Pi Durable 跑在 Durable Object 里；transcript/inbox/tasks 存在 DO 的 SQLite，object 被驱逐后由 alarm 唤醒继续。 | 托管可行；但 `PiHarness` 是 beta，且 DO 有 CPU/内存/时长限制。 |
| “搭配 kimi 的 computer use mcp” | **要分两层。** 官方确实有 **Kimi Computer Use**（Kimi Work 插件 + 本地 macOS 桌面操作 MCP server，`KimiCU.app`，18 工具），但它不是云端 computer-use API，只支持 Apple Silicon macOS 14+、锁屏即失效。另有社区 `songkeys/kimi-computer-use`，把本机 OpenAI Computer Use 桥接给 Kimi Code CLI，依赖 ChatGPT/Codex、签名启动器、辅助功能/录屏权限。 | 只能作为“本地可选能力”，不能作为云端核心链路，更不能作为第一个 demo；本机 x64 跑不了官方 KimiCU。 |
| “再接一些米家 mcp” | **成立但非官方。** 多个社区 MCP 通过米家二维码登录拿 `passToken`，再换 `serviceToken` 调小米云 API；支持设备发现、属性读写、场景执行。token 长则数周/数月，失效需重扫。 | 适合做“家庭设备”演示；要隔离 token、只做低风险设备、写操作必须审批。 |
| “这样的项目会在秋招中让你脱颖而出” | **方向对，但作品价值取决于工程深度，不是技术名词堆叠。** 招聘方更关心：为什么需要 durable、如何防止副作用、如何评测、失败如何恢复。 | 项目叙事要从“我用了 Pi/Cloudflare”转成“我解决了长任务 agent 的可靠性/安全问题”。 |

---

## 3. 核心组件核实

### 3.1 Pi Durable：真正的价值与边界

Pi 1.0 的定位是“minimal, extensible agent harness”；Pi Durable 则把同一套 agent loop 扩展为“long-running, durable, malleable agents that can run anywhere”。它的核心抽象是：

- **Harness**：storage + 运行 agent loop 的机制；
- **Conversation / Entry**：不可变 transcript，commit 后才可见；
- **Task**：每个模型调用、工具调用都是 durable task，每步 checkpoint；
- **Submission**：幂等提交，`requestId` 保证重试不重复；
- **Sleep / Wake**：任务可以持久化 sleep，由宿主 alarm 唤醒；
- **Subagent / Child Task**：子会话、子任务有所有权与 abort 传播；
- **Extension**：tools / prompt sections / hooks / tasks 的可插拔单元；
- **Code Mode**：模型写 JS，在 QuickJS 沙箱里组合工具调用，脚本可恢复。

内部实现上，所有变更走一条原子 commit line；崩溃后重新打开 storage，未完成任务从 checkpoint 继续；模型请求中断会按 retry 策略重发，工具是否重跑由 `replay: "safe"` 决定。官方称不含测试的源码约 15,000 行，SQLite/JSONL storage 不依赖 Node API，可适配 Bun 或 Cloudflare Durable Object。

**但官方同时明确列出限制**（Cloudflare Pi 文档 “Limitations”）：

- **没有内建的审批/权限步骤**；
- `abort()` 要等 session idle，忽略 abort signal 的工具会拖住；
- 唤醒 job 在 alarm invocation 内运行，alarm 最长 15 分钟；harness 每 10 分钟交接一次，但单次模型请求流式超过 15 分钟可能被切断；
- 后台任务完成最多延迟 30 秒才被 harness 发现；
- 运行中的 session 不会 graceful drain；
- **不能删除 conversation**。

这些限制直接决定了架构：审批必须自己做；长任务必须切步骤；会话删除/数据导出要自己做；不能把 Pi 当成完整产品。

### 3.2 Cloudflare PiHarness：托管可行，但 beta

`PiHarness` 是 Agents SDK 的 “Lifecycle capability”：它给 Pi 提供 DO 的 SQLite storage，并用 Lifecycle job 的 alarm 在 object 被驱逐后唤醒 Pi。具体行为：

- Pi 的 transcript、inbox、tasks 存在 DO SQLite 的 `pi_*` 表；
- Pi 的 scheduler 在内存里，object 驱逐后由 Lifecycle job 的心跳/下次唤醒时间恢复；
- 运行中每 30 秒 heartbeat；空闲时 job 在 Pi 的下一个 sleep 时间到期，object 可以 hibernation；
- 部署/崩溃后，runtime 给在途工作 30 秒，然后 alarm 重启 object；
- 崩溃恢复：模型请求按 retry 重发；`replay: "safe"` 工具重跑，其他工具不重跑，模型收到 interrupted 结果。

**版本风险**：`agents@0.33.0`（2026-11-03 发布）支持 Pi 1.5；Pi packages 是 optional peer deps，范围 `~1.5.0`；每个 `agents` release 只支持一个 Pi minor。官方警告：会话在 Pi 1.5 跑过之后，把 Worker 回滚到 Pi 1.4 的 Agents SDK 版本会让该会话不可读，只能向前修复。**因此：锁定 `agents@0.33.0` + `pi-durable@1.5.0`，升级前跑会话兼容性测试，演示前一周冻结版本。**

**一个容易混淆的稳定性边界**：`agents/lifecycle` 本身是 **stable**；experimental/beta 的是 **Pi Durable** 和 **`agents/harness/pi` 这层集成**。面试时不要把“Lifecycle 稳定”说成“PiHarness 稳定”。

**平台限制**（Durable Objects）：

| 限制 | 值 | 影响 |
|---|---|---|
| 单 object 存储 | 10 GB（Paid） | transcript/截图不能无限堆；大文件放 R2 |
| 内存 | 128 MB/isolate | 不能把大模型响应/大量图片常驻内存 |
| CPU/请求 | 默认 30 秒，最高 5 分钟 | 复杂工具/解析要外移或分片 |
| Alarm wall time | 15 分钟 | 单次长任务必须可 checkpoint |
| 单 object 并发 | 单线程，约 1,000 req/s 软上限 | 个人使用足够；多租户要按用户分片 |
| 出站连接 | 6 个同时等待响应头 | 并发 MCP 调用要限流 |
| SQL 行/值 | 2 MB | 大结果要截断/落 R2 |

### 3.3 MCP：能力很强，但“云端连本地”不是默认能力

Cloudflare 的 `MCPClientManager` 支持注册 server、OAuth、重连、工具发现与调用；但它明确 **拒绝 private/internal addresses**。另外要注意：**Pi Durable 本身没有内置 MCP client**。Pi 1.x CLI 的 MCP（stdio、streamable HTTP，不支持 legacy SSE）属于另一套扩展模型；在 `PiHarness` 上接 MCP，需要自己写桥，把 MCP tool 包成 Pi 的 `ToolRegistration`。不要把 CLI 的 MCP 配置直接当成 Pi Durable 的能力。

这意味着：

- Cloudflare Worker 不能直接 `http://192.168.x.x:3000/mcp` 或 `http://localhost:...`；
- **首选（如果可用）**：**Cloudflare Workers VPC**（beta，Free/Paid 可用）。`cloudflared` 只做出站，Worker 通过 `vpc_services` / `vpc_networks` binding 直连私有主机，**不生成公网 hostname**；官方把 “Build MCP servers that aggregate data from multiple private services” 列为用例。注意：`MCPClientManager` 仍会拒绝 private/internal URL，所以通常需要一个 Worker 侧 MCP aggregator 或自定义 transport 来走 VPC binding。
- **备选**：**Cloudflare Tunnel + Access service token**（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）。Access 不是 MCP 的 OAuth Authorization Server，只适合机器认证；不要把它当 MCP OAuth 发现端点。
- **V1 可选**：自建 **outbound WebSocket connector**，本地主动连云端，云端发命令；无公网入口、双向事件、低延迟，但要自己做协议/重连/背压/审计。

推荐 MVP 用 **Workers VPC**（若 beta 行为可接受），否则用 Tunnel + Access；V1 再评估 WebSocket connector。

MCP 规范的安全最佳实践明确提示：confused deputy、token passthrough（规范禁止）、per-client consent、redirect URI 精确匹配、state 防 CSRF 等。个人 Agent 还额外面对 **prompt injection**：网页/邮件/工具结果里的恶意指令可能诱导模型调用副作用工具。OWASP LLM Top 10 2025 把 Prompt Injection、Sensitive Information Disclosure、Excessive Agency、Unbounded Consumption 列为核心风险。

### 3.4 Kimi Computer Use：官方有本地能力层，但不是云服务

这里必须把两个东西切开：

| | **KimiCU.app（官方）** | **songkeys/kimi-computer-use（社区桥）** |
|---|---|---|
| 本质 | Kimi Work 插件 + 本地 macOS 桌面操作 MCP server | 把已安装的 OpenAI Computer Use 借给 Kimi Code CLI 的协议翻译层 |
| 来源 | Kimi 帮助中心明确写“Kimi Work 支持你主动选择开启……点击、输入、滚动、拖拽、读取 app 界面或截图” | README 自述 experimental / unofficial；不含 OpenAI 二进制 |
| 工具 | 18 个：`list_apps`、`get_app_state`、`click`、`type_text`、`press_key`、`scroll`、`drag`、`set_value` 等 | 透传上游工具 |
| 运行 | `launchd` 服务持有 Accessibility + Screen Recording；`kimi-cu mcp` 是 stdio 前端 | 依赖 ChatGPT/Codex、签名 Codex 启动器、OpenAI Computer Use runtime |
| 平台 | **Apple Silicon macOS 14+**；二进制是 arm64-only；**锁屏/休眠即失效** | macOS 14.4+；同样依赖本地 GUI 会话 |
| 数据 | 二进制未见 login/token；存在遥测子系统与 `gator.volces.com` 端点（载荷未验证） | 明确把 AX 文本 + 截图回传 Kimi 的模型 provider |
| 云端 | **不能** Linux / Cloudflare | **不能** Linux / Cloudflare |

**本机约束（重要）**：当前开发机是 **x64 macOS**；官方 KimiCU 是 **arm64-only**，直接运行不了。要用 KimiCU，需要一台 Apple Silicon Mac；否则请用 Playwright MCP / Browser Run 做 Web 任务。

**社区桥的安全风险**（源码级）：它为绕过 OpenAI 的进程血缘鉴权，借用签名的 Codex 可执行文件作为启动器，并把 sandbox 设为 `disabled/unrestricted`，同时**自动接受 app-access elicitation**。这等于把“是否允许访问某 app”的确认权交给模型侧；不建议用于任何正式链路。

**结论**：KimiCU 是“本地手和眼”，不是“云端 computer-use API”。它适合“我在 Apple Silicon Mac 上让 Agent 操作某个 App”的有人值守 demo，不适合 Cloudflare 托管、7×24 运行的核心能力。Cloudflare 没有 macOS 运行时：**Computer Workspace** 是 DO SQLite 里的文件系统（适合工作文件，不适合 monorepo），**Sandbox** 是 Debian Linux 容器（默认断网、读不到 agent bindings），**Browser Run** 是 Chromium/CDP（session 空闲约 10 分钟会丢标签页/cookie/登录态）。它们都不是 macOS 桌面。若必须做桌面自动化，就把 Apple Silicon Mac 作为本地执行面，并接受它离线/锁屏时能力降级。

### 3.5 米家 MCP：能演示，但别把它当稳定基础设施

社区实现的共同链路：

```
米家 App 扫码 → 本地 login 工具保存 token
  → MCP server → 小米云 API (api.io.mi.com)
  → MIoT spec (siid/piid/aiid) 或 legacy miio RPC
```

已核实的特点：

- 二维码登录，token 存在本地文件（有的实现权限 600）；`passToken` 约 1 个月有效，`serviceToken` 自动刷新；
- **社区实现全部走小米云，没有可用的局域网直连**；设备记录里的 `localip` 不用于控制；
- 设备覆盖依赖型号前缀/MIoT 属性映射，不是所有设备都支持；
- 控制能力包括开关、亮度、色温、目标温度、模式、风速、开合、场景执行等；
- 属于非官方 API，存在风控、协议变更、账号安全风险；`mijiaAPI` 是 **GPL-3.0**，分发/闭源要注意；
- `javen-yan/miot-mcp` 依赖 `mijiaAPI>=3.0.5` 未封顶，而最新 5.0.0 有破坏性变更；`744722411/xiaomi-home-mcp` 与 `gehaiyi/xiaomi-home-mcp` 高度重复，不建议选型。

**更稳的替代**：小米官方开源的 **Xiaomi Miloco**。它是一个本地运行的 whole-home agent（Python，OpenClaw 插件），强调 24/7 本地硬件、**局域网中枢网关 + mTLS**、家庭记忆、主动任务、摄像头感知。它不是 MCP，且**仅限非商业使用**；如果项目重点在家庭场景，可以把 Miloco 的 MIoT gateway 作为参考或本地能力提供者，而不是自己维护一套非官方 MCP。

### 3.6 模型层

Pi AI 支持大量 provider，包括 **Moonshot AI（含中国区）**、**Cloudflare Workers AI**、**Cloudflare AI Gateway**、OpenAI、Anthropic、Google、OpenRouter 等；工具调用是 chat catalog 的硬性要求。Kimi 当前旗舰是 `kimi-k3.1-pro`（1M context、native visual understanding），另有 `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`。

**建议**：不要把模型写死。用 Pi AI 的 `Models` + Cloudflare AI Gateway 做：

- 规划/复杂任务：Kimi K3.1 Pro / Claude / GPT（按可用性）；
- 分类/摘要/压缩：便宜的小模型（Workers AI 上的 GLM/Kimi 小模型）；
- fallback：provider 失败时切备用模型；
- 成本/延迟：AI Gateway 的 analytics、缓存、限流、重试/fallback。

---

## 4. 可行性验证：我们实际跑了什么

`spikes/pi-durable-smoke/smoke.ts` 用 `@earendil-works/pi-durable@1.5.0` + faux provider + SQLite 跑了最小链路：

1. 注册一个 `danger` 工具；
2. 用 `beforeTool` hook 拦截它，返回 `{ block: "Needs human approval" }`；
3. 模型先发起工具调用，再给出最终回答；
4. 检查工具 `execute` 没有执行；
5. 关闭 harness，重新打开同一个 SQLite 文件，检查 root 与 entry 仍在。

实测输出：

```json
{
  "answer": "I need approval before doing that.",
  "executed": false,
  "toolResult": "<harness>\n[error] Tool call blocked: Needs human approval\n</harness>",
  "entryCount": 5
}
{
  "reopenedEntryCount": 5,
  "sameRoot": true
}
```

**验证结论**：

- Pi Durable 的 SQLite 持久化、root session 复用、`beforeTool` 拦截都按文档工作；
- 但 `beforeTool` 只是“阻断 + 错误结果”，不是“暂停后恢复执行”。真正的审批需要额外的 **pending action + signed approval + host executor**，见架构文档；
- 没有验证 Cloudflare `PiHarness` 的真实部署（需要 Cloudflare 账号/凭据）；该部分依赖官方文档与平台限制，属于“文档可行、待部署验证”。

---

## 5. 关键风险与缓解

| 风险 | 概率 | 影响 | 缓解 | 验收门槛 |
|---|---|---|---|---|
| PiHarness beta / Pi minor 升级导致会话不可读 | 高 | 高 | 锁定 `agents@0.33.0` + `pi-durable@1.5.0`；升级前跑 golden session 回归；演示前冻结 | 升级 PR 必须通过 30 条历史会话回放 |
| DO 驱逐/CPU/15 分钟 alarm 切断长任务 | 中 | 高 | 任务切步骤；每步 checkpoint；工具幂等；maxTurns；长任务拆成多个 alarm | 杀 object 后任务能继续，成功率 ≥ 95% |
| 审批被绕过 / 模型直接执行副作用 | 中 | 致命 | 副作用 executor 不暴露给模型；模型只能 `propose_action`；审批 token 绑定 action hash/用户/过期时间 | 红队用例 0 次未授权副作用 |
| Prompt injection 诱导外发/删数据 | 高 | 高 | 不可信内容标记；工具 allowlist；高风险动作强制审批；最小权限；预算/速率限制 | 注入用例拦截率 100% |
| 本地 connector 被攻破 | 中 | 高 | mTLS/短期 token；命令 allowlist；设备能力白名单；kill switch；审计 | connector 失窃 token 不能重放 |
| 米家 API 变更/风控/token 失效 | 中 | 中 | 只做低风险设备；CI 用 mock；官方 Miloco fallback；token 加密存储；pin `mijiaAPI` 版本 | 断网/失效时优雅降级，不阻塞聊天 |
| 米家 `mijiaAPI` GPL-3.0 / 依赖未封顶 | 中 | 中 | 分发前替换依赖；pin 版本或 fork；不要直接闭源分发 | 许可证审计通过 |
| 官方 KimiCU 仅 arm64 / 锁屏失效 / 版本漂移 | 高 | 中 | 用 Apple Silicon 专用演示机；常亮不锁屏；锁版本；只做有人值守 demo | 关闭 CUA 时其余功能 100% 可用 |
| 社区 Kimi 桥接 unrestricted 沙箱 + 自动接受 elicitation | 中 | 高 | **不用于正式链路**；只在隔离演示机；优先官方 KimiCU | 安全评审拒绝该依赖 |
| 成本失控 | 中 | 中 | maxTurns/maxTokens/预算；模型路由；缓存；CUA 步数上限 | 单任务成本上限可配置并被测试 |
| 范围蔓延 | 高 | 高 | MVP 只做一条竖切；非目标写进 README；6 周 gate | 第 6 周必须能录 5 分钟 demo |

---

## 6. 替代方案对比

| 方案 | 成熟度 | 运维复杂度 | 差异化/求职信号 | 适合场景 | 结论 |
|---|---|---|---|---|---|
| **Pi Durable + Cloudflare PiHarness** | 低（experimental/beta） | 低 | **高**（durable task、MCP、edge） | 个人项目、Agent runtime 作品 | **主选**，但锁定版本、准备 fallback |
| Cloudflare Agent + AI SDK | 中高（Agents SDK stable 部分） | 低 | 中（内置 HITL、WebSocket、调度） | 快速做聊天/审批 demo | **Fallback**；若 PiHarness 阻塞，2 天切换 |
| LangGraph + Postgres/Redis/Temporal | 高 | 中高 | 中高（Python、生态、JD 常见） | 复杂 workflow、算法/平台岗 | 备选；需要更多基础设施 |
| OpenAI Agents SDK + Temporal | 中高 | 中高 | 中（OpenAI 生态） | 已有 Temporal/OpenAI 栈 | 备选；供应商绑定较强 |
| Home Assistant + MCP | 高（智能家居） | 中 | 中（家庭自动化） | 家庭场景为主 | 可作为本地设备层，不替代通用 agent |

**建议**：主选 Pi + Cloudflare；把 `AgentRuntime` 抽象成一个窄接口（`submit/watch/approve/execute`），不要把所有业务逻辑写进 Pi 的 hook。这样 PiHarness 出问题时可以切 Cloudflare Agent，而不重写产品层。

---

## 7. 成本量级

### 固定成本

- Workers Paid：**$5/月起**；包含 10M requests、30M CPU ms、DO 1M requests、400k GB-s、5 GB-month SQLite storage 等额度。
- 400k GB-s 在 128MB 计费口径下约为 **868 小时活跃时长/月**（128MB 活跃 1 小时 = 460.8 GB-s）；空闲且可 hibernation 的时间不计费。
- 超出：DO requests **$0.15/M**；DO duration **$12.50/M GB-s**；SQLite storage **$0.20/GB-month**；D1/Vectorize/R2 另计。
- Browser Run：10 小时/月含，超出 **$0.09/小时**；并发超出另计。Sandbox/Containers 按 vCPU/内存/磁盘计费。
- 个人使用（1 个用户、每天几十次会话）通常落在 $5–15/月；真正的变量是模型 token 和 browser/CUA。

### 变量成本（公式，不做报价承诺）

```
月成本 ≈ 会话数/天 × 30 × 每次模型调用数 × (输入 tokens × 输入单价 + 输出 tokens × 输出单价)
       + 视觉/CUA 步数 × 每步图片 tokens × 视觉单价
       + Browser Run / Sandbox 时长
```

示例假设（仅用于量级估算，单价请按你选的模型替换）：

- 20 次会话/天 × 6 次模型调用 × 5k input + 600 output；
- 月输入 ≈ 18M tokens，月输出 ≈ 2.16M tokens；
- 若示例单价为 $0.6/M input、$2.4/M output，则模型成本 ≈ $10.8 + $5.2 ≈ **$16/月**；
- 若用旗舰模型/长上下文/computer use，可能到 **$30–100+/月**。

**控制手段**：模型路由（分类/压缩用便宜模型）、prompt cache、maxTurns、maxTokens、CUA 20 步上限、按任务预算、AI Gateway 限流/缓存。

---

## 8. Go / No-Go

**Go（做）**，但按以下边界：

- ✅ 用 Pi Durable 做 **durable runtime 的核心演示**；
- ✅ 用 Cloudflare DO 做 **单用户托管**；
- ✅ 用 MCP 接 **2–3 个低风险工具**（天气、日历、米家只读/单控）；
- ✅ 用本地 connector 做 **云端触达本地** 的架构亮点；
- ✅ 用 Python eval harness + OTel 做 **可验证性**；
- ❌ 不把 Kimi CUA 作为核心链路；
- ❌ 不把米家非官方 API 作为唯一设备层；
- ❌ 不做多租户/大规模并发；
- ❌ 不在 beta 版本上做“不可回滚”的会话格式升级。

**No-Go 信号**：如果 2 周内无法稳定跑通 “Cloudflare 部署 + 一次审批 + 一次重启恢复”，就切 Cloudflare Agent + AI SDK fallback，不要继续堆功能。

---

## 9. 关键来源

- Pi 官网：https://pi.dev/
- Pi 1.0：https://earendil.com/posts/pi-1-0/
- Pi Durable：https://earendil.com/posts/pi-durable/
- Pi Durable README：https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Pi AI providers：https://github.com/earendil-works/pi/blob/main/packages/ai/README.md
- Cloudflare PiHarness：https://developers.cloudflare.com/agents/harnesses/pi/
- Cloudflare Agents 总览：https://developers.cloudflare.com/agents/
- Cloudflare Durable Objects limits：https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare Durable Objects pricing：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Workers pricing：https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare MCPClientManager：https://developers.cloudflare.com/agents/runtime/capabilities/mcp-client-manager/
- Cloudflare Workers VPC（beta）：https://developers.cloudflare.com/workers-vpc/
- Cloudflare Tunnel：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Cloudflare Access service tokens：https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Cloudflare Sandbox：https://developers.cloudflare.com/agents/tools/sandbox/
- Cloudflare Browser Run limits：https://developers.cloudflare.com/browser-run/limits/
- Kimi 官方能力说明（Kimi Computer Use）：https://www.kimi.com/zh-cn/help/others/capability
- Kimi Computer Use 社区桥：https://github.com/songkeys/kimi-computer-use
- Playwright MCP：https://github.com/microsoft/playwright-mcp
- 米家 MCP（示例）：https://github.com/744722411/xiaomi-home-mcp
- 米家 MCP（产品化示例）：https://github.com/javen-yan/miot-mcp
- 米家 API（GPL-3.0）：https://github.com/Do1e/mijia-api
- Xiaomi Miloco：https://github.com/XiaoMi/xiaomi-miloco
- MCP security best practices：https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- OWASP LLM Top 10 2025：https://genai.owasp.org/llm-top-10/
- Kimi 模型列表：https://platform.kimi.ai/docs/models
