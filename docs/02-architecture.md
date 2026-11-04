# 02 · 目标架构与技术方案

> 目标：做一个“住在云上、手在本地、可审计”的个人 Agent。它不是聊天机器人，而是一个能长期运行、主动做事、在副作用前停下来等人确认的系统。

## 1. 设计原则

1. **Durable by default**：模型调用、工具调用、审批等待、定时任务都必须可恢复；进程死了不能靠“再问一遍”。
2. **副作用与模型隔离**：模型只能“提议”副作用，不能直接持有执行权；执行器由宿主在审批后调用。
3. **Local-first for sensitive capabilities**：桌面控制、家庭局域网、文件系统留在本地；云端只拿最小必要结果。
4. **Least privilege**：每个工具声明 risk/scope/timeout/是否可重放；默认拒绝，按需授权。
5. **Provider-agnostic**：模型、MCP server、通知渠道都可替换；不把业务逻辑写进某个厂商的 hook。
6. **Eval-driven**：每个能力都要有可复现的任务集、成功判定、失败归因；没有 eval 的功能不算完成。
7. **Boring where it matters**：审批、幂等、审计用简单明确的状态机，不用“让模型自己记得”。

### 产品边界（MVP）

- 单用户、单 Agent、单区域部署；
- Web/PWA 聊天 + 审批收件箱 + 记忆管理 + 审计；
- 6 类工具：天气、日历、Web 搜索/抓取、记忆、提醒/定时、米家（只读 + 单个低风险控制）；
- 一条本地 connector：Mac mini/家庭服务器，接米家 MCP + 一个 macOS 安全动作（如 Shortcuts）；
- 可选的 Browser Run 任务（Web，不是桌面）。

**非目标**：多租户 SaaS、任意 GUI 自动化、训练模型、替代米家 App、金融/医疗高风险决策。

---

## 2. 总体架构

```mermaid
flowchart TB
  subgraph Client["客户端"]
    WEB["Web / PWA<br/>聊天 · 审批 · 记忆 · 审计"]
    IM["IM / 邮件 / Webhook<br/>（V1）"]
  end

  subgraph Edge["Cloudflare 边缘"]
    API["Worker API<br/>REST + WebSocket/SSE"]
    DO["Durable Object / 用户<br/>PiHarness + Lifecycle"]
    RT["Agent Runtime<br/>Pi Durable 1.5"]
    POL["Policy Engine<br/>风险分级 · 审批 · 预算"]
    MCPC["MCP Adapter<br/>OAuth · 重连 · 工具发现"]
    SCH["Scheduler<br/>DO alarm / job queue"]
    MEM["Memory Service<br/>抽取 · 检索 · 冲突"]
    OBS["Observability<br/>OTel spans / metrics"]
  end

  subgraph Data["存储"]
    SQL["DO SQLite<br/>transcript · tasks · app state"]
    D1["D1<br/>eval / analytics"]
    VEC["Vectorize<br/>memory embeddings"]
    R2["R2<br/>screenshots · exports"]
  end

  subgraph Local["本地执行面"]
    CONN["Connector<br/>VPC / Tunnel / WSS"]
    HOME["米家 MCP<br/>MIoT cloud/LAN"]
    MAC["macOS 动作<br/>Shortcuts / AppleScript"]
    CUA["可选 CUA<br/>Kimi/OpenAI bridge"]
  end

  subgraph External["外部服务"]
    LLM["Kimi / Claude / GPT<br/>AI Gateway"]
    SAAS["Calendar / GitHub / Notion<br/>MCP"]
    WEBX["Web / Browser Run"]
  end

  WEB --> API
  IM --> API
  API --> DO
  DO --> RT
  RT --> POL
  RT --> MCPC
  RT --> MEM
  RT --> SCH
  RT --> OBS
  RT --> LLM
  MCPC --> SAAS
  MCPC --> WEBX
  MCPC -->|VPC / Tunnel + Access| CONN
  CONN --> HOME
  CONN --> MAC
  CONN --> CUA
  RT --> SQL
  MEM --> VEC
  MEM --> D1
  OBS --> R2
```

### 关键决策

| 决策 | 选择 | 理由 | 退出条件 |
|---|---|---|---|
| Agent runtime | Pi Durable + Cloudflare `PiHarness` | 任务级 checkpoint、sleep/wake、subagent、DO 托管 | 2 周内无法稳定恢复 → 切 Cloudflare Agent + AI SDK |
| 隔离粒度 | **一个 DO / 用户**，root session 主线程 | 个人 Agent 需要跨渠道连续记忆；单用户并发低 | 多会话并发明显争用 → 按 channel 拆 DO，D1/Vectorize 共享 |
| 审批 | **两阶段：propose → approve → execute** | Pi 没有内建审批；模型不能持有执行权 | 若切 Cloudflare Agent，可用其 `needsApproval`，但保留本状态机 |
| 本地接入 | MVP：Workers VPC（beta）优先；Tunnel + Access 备选；V1：outbound WSS | VPC 无公网 hostname；Tunnel 代码少；WSS 更适合事件/低延迟/双向 | VPC beta 不可用/需要设备事件 → Tunnel 或 WSS |
| 记忆 | DO SQLite + Vectorize + R2 | 结构化事实可审计；向量检索补充语义 | 记忆规模/多人协作 → 独立 memory service |
| 模型 | Pi AI + AI Gateway，多 provider | 避免绑定；Kimi 中文/长上下文，Claude/GPT 备选 | 成本/延迟不达标 → 路由/小模型 |

---

## 3. 运行时：PiHarness 怎么用

### 3.1 对象模型

```
Worker (route)
  └── DurableObject "PersonalAgent:<userId>"
        ├── Lifecycle
        ├── PiHarness
        │     └── Pi Harness (root session "1")
        │           ├── Conversation / Entries
        │           ├── Tasks (generation / tool / custom)
        │           └── Registry (extensions/tools/sections)
        ├── App tables (pa_*)
        ├── ActionExecutor
        └── Scheduler
```

- `PiHarness` 负责 Pi 的 storage/wake；应用自己的表也放同一个 DO SQLite，用 `pa_` 前缀，避免和 `pi_` 冲突。
- `root session` 是主对话；Web、IM、定时任务可以是同一 session 的输入，也可以 fork 出独立 session（例如“周报”任务）。
- 每个 session 可以配置不同模型/工具（Pi 的 `configure()`），但 MVP 保持一套策略，减少不可解释性。
- **与官方建议的差异**：PiHarness 文档建议“一个会话一个 DO”；本项目是单用户，先用“一个用户一个 DO + root session”换取跨渠道连续记忆。若多 channel 并发明显争用（DO 单线程），再按 channel 拆 DO，记忆/审计放 D1/Vectorize 共享。

### 3.2 运行循环

```
用户输入 / 定时触发 / connector 事件
  → 去重（requestId / eventId）
  → 组装上下文（profile + memory + 最近 transcript + 工具 schema）
  → 模型规划
  → 只读工具：直接执行（有超时/输出上限）
  → 副作用：propose_action（写 pending，返回“待审批”）
  → 用户审批
  → host executor 执行（幂等键）
  → 结果写回 transcript（app.approval / app.tool_result）
  → 模型总结 / 验证
  → 记忆抽取（后台）
  → 审计 + trace
```

### 3.3 长任务

- 单次 alarm 最多 15 分钟；PiHarness 每 10 分钟交接；单次模型请求流式超过 15 分钟可能被切断。
- 把任务拆成 **步骤 ≤ 10 分钟**：计划 → 每步工具 → 检查点 → 下一步。
- `maxTurns` 限制一轮工具循环；外层用 `Task`/`Schedule` 控制总步数。
- 任何外部副作用都带 `action_id` 作为幂等键；工具声明 `replay: "safe"` 仅用于只读/可重复写。
- 大输出截断到 8–16KB，完整内容写 R2，transcript 只留摘要 + 引用。

**语义差异（面试要能讲）**：Pi Durable 是 **checkpoint 语义**——每个 phase 结束存 checkpoint，重启从 checkpoint 继续，phase 内不能 sleep，phase 重跑时副作用要按 `replay` 策略处理。Temporal 是 **Event History + 确定性重放**——workflow 代码必须 deterministic，靠重放历史重建状态。两者不是等价物；Pi 对“模型调用 + 不可预测工具”更宽松，但把确定性要求下推到了 Code Mode 脚本。

---

## 4. 工具网关与 MCP 适配

### 4.1 工具分层

| 层 | 例子 | 谁可调用 | 审批 |
|---|---|---|---|
| 只读工具 | 天气、搜索、日历查询、设备状态、记忆检索 | 模型 | 自动（有速率/预算） |
| 可逆写 | 开灯、调亮度、创建提醒、加日历 | 模型只能 propose | 一键确认（可配置自动） |
| 高风险写 | 删日历、发消息、转账、开门锁 | 模型只能 propose | 强确认 + step-up（Passkey） |
| 禁止 | 密码管理器、银行、删除设备、批量导出 | 不暴露 | 永远拒绝 |

### 4.2 MCP 适配层

Cloudflare `MCPClientManager` 负责连接、OAuth、重连；但 Pi 的 registry 需要 `ToolRegistration`，所以中间加一个 **MCP → Pi Tool** 适配器。注意：**Pi Durable 没有内置 MCP client**；Pi 1.x CLI 的 MCP（stdio / streamable HTTP，不支持 legacy SSE）是另一套扩展模型。在 PiHarness 上必须自己写桥，不能直接复用 CLI 的 `mcp.json`。

```ts
// 伪代码：启动时发现 MCP 工具，包装成 Pi tool
for (const server of config.mcpServers) {
  const tools = await mcp.listTools({ serverId: server.id });
  for (const t of tools) {
    registry.install(defineExtension({
      name: `mcp:${server.id}`,
      tools: [defineTool({
        name: `mcp__${server.id}__${t.name}`,
        description: sanitize(t.description),
        parameters: t.inputSchema,
        replay: server.readOnly ? "safe" : undefined,
        deferred: true, // 大工具集用 tool_search 渐进加载
        execute: async (args, api) => {
          const decision = await policy.check({ server, tool: t, args });
          if (decision.kind === "propose") {
            return { output: [{ type: "text", text: await actions.propose(...) }] };
          }
          return { output: await mcp.callTool(server.id, t.name, args) };
        },
      })],
    }));
  }
}
```

> 关键点：**不要**把 MCP 的 tool description 直接拼进系统提示。它来自外部，可能包含注入文本；只作为“工具元数据”放在工具 schema 里，并在策略层做来源标记。

工具很多时，用 `deferred: true` + `tool_search` 做渐进披露，避免一次性把几十个工具塞进上下文。V1 可以评估 Pi 的 Code Mode（模型写 JS 组合工具调用，脚本可恢复），但它要求脚本确定性/可重放，MVP 先不用。

### 4.3 MCP 连接拓扑

**首选：Workers VPC（beta，Free/Paid）**

```
Cloudflare Worker (MCP aggregator / custom transport)
  → vpc_services binding (http://home-mcp.internal:8787)
  → Cloudflare Tunnel (cloudflared outbound)
  → 127.0.0.1:8787 (local MCP server)
```

- `cloudflared` 只做出站，私有主机不暴露公网 hostname；
- Worker 通过 `vpc_services` / `vpc_networks` binding 访问私有 host:port；
- `MCPClientManager` 会拒绝 private/internal URL，所以需要一个 Worker 侧 MCP aggregator 或自定义 transport；不要直接把 `http://home-mcp.internal` 传给 `registerServer()`；
- Workers VPC 目前是 beta，行为可能变；用它就要接受“beta 依赖”。

**备选：Tunnel + Access service token**

```
Cloudflare Worker (MCP client)
  → https://mcp-home.example.com/mcp
  → Cloudflare Access (Service Auth)
  → cloudflared tunnel
  → 127.0.0.1:8787 (local MCP server)
```

- Access service token 用 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 头；
- **Access 不是 MCP 的 OAuth Authorization Server**，只适合机器认证；支持 OAuth 发现的 MCP 客户端不要指望它；
- 只暴露 `/mcp`，不暴露管理端口；本地 MCP server 只绑定 loopback。

**V1：outbound WSS connector**

```
Connector → wss://agent.example.com/connector (mTLS / short-lived token)
Cloud → command envelope → connector → local tool
Connector → event → Cloud (device state changed)
```

优点：无公网入口、双向事件、低延迟；缺点：要自己做协议、重连、背压、审计。MVP 不先做。

> 三选一的原则：**能不用公网 hostname 就不用**。Workers VPC 最优，Tunnel + Access 次之，WSS 最灵活但代码最多。

### 4.4 云端能力边界

| 需求 | Cloudflare 能力 | 限制 | 本项目的用法 |
|---|---|---|---|
| 文件系统 | Computer Workspace | 存在 DO SQLite；适合工作文件，不适合大 repo | 存导出/临时文件；大文件放 R2 |
| Shell/编译 | Sandbox（Container） | Debian Linux；默认断网；读不到 agent bindings | 可选：跑 Python eval/脚本；不做桌面 |
| 浏览器 | Browser Run/CDP | session 空闲约 10 分钟丢标签页/cookie/登录态；默认 60s 超时，可 keep-alive 到 20 分钟 | Web 任务优先；登录态任务必须本地或重新授权 |
| 桌面控制 | **无 macOS 运行时** | 只有 Linux 容器 | 只能本地 connector + Mac mini |
| 长流程 | Workflows | 每 step 无墙钟上限；按 step/存储计费 | 重型后台任务可外移；MVP 不用 |

> 结论：**云端做“大脑 + Web 工具”，本地做“桌面 + LAN + 家庭设备”**。不要把“云端 agent”误解成“云端什么都能操作”。

---

## 5. 审批与执行器分离（核心）

### 5.1 状态机

```mermaid
stateDiagram-v2
  [*] --> proposed
  proposed --> approved: 用户批准（低/中风险）
  proposed --> denied: 用户拒绝
  proposed --> expired: 超时
  approved --> executing: executor 取走
  executing --> succeeded: 外部调用成功
  executing --> failed: 外部调用失败
  failed --> proposed: 可重试（需重新审批）
  succeeded --> [*]
  denied --> [*]
  expired --> [*]
```

约束：

- `proposed` 只能由 `propose_action` 创建；模型不能直接写 `approved`。
- `approved` 必须绑定：`action_id`、`args_hash`、`user_id`、`expires_at`、`nonce`。
- `executing` 只能由 host `ActionExecutor` 进入；模型没有这个工具的调用权。
- `succeeded/failed` 后写审计与 transcript；失败可重试，但必须重新走审批（除非策略允许幂等重试）。
- `failed → proposed` 仅当工具幂等或已完成补偿；不可逆操作失败后进入终态，转人工处理，不自动重试。

### 5.2 审批 token

```ts
token = HMAC-SHA256(serverSecret, JSON.stringify({
  actionId, argsHash, userId, expiresAt, nonce
}))
```

- 服务端只存 token hash；
- 一次性使用；过期 5–10 分钟；
- 执行器校验：状态、token、args hash、用户、过期、nonce 未用过；
- 高风险动作额外要求 WebAuthn/Passkey 或设备端确认；
- **token 永不进入模型上下文**。

### 5.3 为什么不让模型直接调用副作用工具

- prompt injection 可以把“读网页”变成“发邮件/删数据”；
- 模型的 tool call 参数可能被篡改/幻觉；
- 审批需要展示“将要发生什么”，而不是“模型说它要做什么”；
- 审计需要“谁批准了什么”，模型不是责任主体。

### 5.4 可借鉴的原生 HITL 模式（但不要直接依赖）

Cloudflare 其他 harness 已经有一些审批原语，可作为设计参考：

- **Think**：`needsApproval` → 客户端回 `CF_AGENT_TOOL_APPROVAL`；
- **Code Mode**：`runtime.pendingExecutions()` / `approveExecution()` 做 durable pause/resume；
- **Computer Workspace**：`ctx.interrupt(payload)` 让可重放 run 持久暂停，`workspace.runtime.pending()` / `respond()` 作答（实验性）；
- **Workflows**：`waitForApproval()` 适合天/月级审批。

Pi Durable 没有这些内建能力，所以本项目仍采用 **DB 状态机 + host executor**。好处是：不依赖某个 harness 的 beta API，切换到 Cloudflare Agent 时审批层可以复用。

### 5.5 工具执行结果如何回到对话

执行器完成后，通过宿主写一条 `app.action_result` entry（或 `session.submit` 一条带 `entry.kind` 的消息），让模型看到结构化结果：

```json
{
  "action_id": "act_123",
  "status": "succeeded",
  "tool": "mcp__home__set_light",
  "result": { "device": "客厅灯", "brightness": 40 },
  "approved_by": "user",
  "executed_at": "2026-11-04T10:00:00Z"
}
```

模型据此总结；如果失败，给出可执行的下一步，而不是重复调用。

---

## 6. 记忆系统

### 6.1 记忆分层

| 类型 | 内容 | 存储 | 例子 |
|---|---|---|---|
| Profile | 稳定偏好/身份/约束 | DO SQLite | “怕冷，空调默认 26℃” |
| Semantic | 事实/关系 | SQLite + Vectorize | “妈妈的生日是 5 月 3 日” |
| Episodic | 事件/对话摘要 | Pi transcript + 摘要 | “上周三改了牙医预约” |
| Procedural | 技能/流程 | Skills / prompt templates | “每周一生成周报” |

### 6.2 写入管线

```
对话/工具结果
  → 候选抽取（LLM + JSON schema）
  → 分类（preference/fact/event/task）
  → 敏感度分级（PII/健康/财务/家庭）
  → 去重（entity + predicate + normalized value）
  → 冲突检测（新值 vs 旧值；保留 valid_from/valid_to）
  → 置信度（用户明说 > 推断 > 第三方内容）
  → 写入 SQLite + 异步 embedding → Vectorize
```

规则：

- 只从**用户直接输入**或**已验证来源**抽取高置信记忆；网页/邮件内容标记 `untrusted`，不自动写成长期偏好；
- 不存密码/token/完整卡号；需要时存 secret reference；
- 每条记忆有 `source_entry_id`、`confidence`、`sensitivity`、`valid_from/valid_to`；
- 用户可查看/编辑/删除/导出；“忘记我”触发软删除 + 向量删除；
- 冲突不覆盖历史，旧值 `valid_to` 关闭，保留审计。

### 6.3 检索

```
query rewrite
  → 结构化过滤（user, type, sensitivity, valid)
  → hybrid: Vectorize top-k + SQLite FTS5 top-k
  → rerank（交叉编码器或 LLM）
  → 去重/多样性
  → token budget（默认 2–4k）
  → 注入 <memory source="...">，带 provenance
```

评测：记忆命中率、错误记忆率、任务成功率增益、token 成本。参考 Mem0 的“抽取-整合-检索”思路，但不要直接照搬其 benchmark 数字（厂商自测，需在自己的任务集上验证）。

---

## 7. 调度与主动性

### 7.1 Schedule 模型

```ts
type Schedule = {
  id: string;
  userId: string;
  kind: "once" | "cron";
  expression: string;       // ISO time or cron
  timezone: string;         // IANA
  prompt: string;           // 触发时注入的任务
  constraints: {
    quietHours?: [string, string];
    maxRunsPerDay?: number;
    requiresConfirmation?: boolean;
  };
  nextRunAt: number;
  status: "active" | "paused" | "done";
  lastRunAt?: number;
};
```

### 7.2 执行语义

- 每个 schedule 触发时生成 `run_key = schedule_id + scheduled_at`，幂等；
- 到点由 DO alarm/Lifecycle job 唤醒；多个 schedule 取最早时间，避免覆盖 alarm；
- 错过执行：按策略 `run_once` / `skip` / `catch_up`，默认 `run_once`（避免醒来刷屏）；
- 长任务 spawn 子任务，不阻塞 scheduler；
- 主动消息先进“待发送”队列，尊重 quiet hours；用户可 snooze/cancel；
- 所有主动消息带“为什么现在发”和“如何关闭”。

---

## 8. 本地 Connector

### 8.1 职责

- 向云端注册能力（manifest）；
- 接收签名命令，调用本地 MCP/CLI/Shortcuts；
- 回传结果/事件；
- 心跳、重连、背压、审计；
- 本地 kill switch（一键停止所有远程命令）。

### 8.2 命令信封

```json
{
  "command_id": "cmd_01",
  "action_id": "act_123",
  "tool": "miot.set_brightness",
  "args": { "room": "客厅", "device": "吸顶灯", "value": 40 },
  "deadline_ms": 10000,
  "approval_token": "…",
  "traceparent": "00-…",
  "nonce": "…"
}
```

- 传输：mTLS 或短期 HMAC token；
- 重放保护：nonce + command_id + deadline；
- 本地只执行 allowlist 内的 tool；参数用 schema 校验，禁止 shell 拼接；
- 高风险工具（门锁/摄像头/支付）默认不注册；
- 记录本地审计，云端记录命令摘要与结果。

### 8.3 设备接入

- **米家**：本地跑 `miot-mcp`（token 不离开本机），但注意它**仍走小米云 API**，不是局域网直连；社区实现没有可用的 LAN 路径。云端只看到“家庭/房间/设备/能力”抽象。LAN 只能走官方 **Xiaomi Miloco**（中枢网关 + mTLS，非商业许可），或自建 MIoT 本地协议（工作量大）。
- **米家选型**：优先 `javen-yan/miot-mcp`（能力 schema 最全），但 **pin `mijiaAPI` 版本**（上游已 5.0.0 且有破坏性变更；仓库声明 `>=3.0.5` 未封顶）；`gehaiyi`/`744722411` 是同一实现，选一个即可。
- **macOS**：Shortcuts（最安全）> AppleScript（受控 app）> 官方 **KimiCU**（本地 MCP，18 工具，Apple Silicon macOS 14+）> 社区桥（最后手段，默认禁用）。
- **KimiCU**：只作为有人值守的本地能力；默认关闭；显示控制指示；app allowlist；每步截图脱敏；20 步/5 分钟上限；锁屏/休眠即失败，不能用于无人值守。
- **Web**：优先 **Playwright MCP**（无障碍树，不需要视觉模型）或 Cloudflare **Browser Run**；登录态任务本地做，云端 session 空闲约 10 分钟会丢 cookie。
- **社区 Kimi 桥**：自动接受 app-access elicitation + unrestricted Codex 沙箱，**不用于正式链路**。

---

## 9. 模型与上下文工程

### 9.1 模型路由

| 任务 | 模型档位 | 说明 |
|---|---|---|
| 意图分类/安全检查 | 小模型/规则 | 便宜、低延迟；可用 Workers AI |
| 对话/工具规划 | 主力模型 | Kimi K3.1 Pro / Claude / GPT |
| 长文总结/压缩 | 中档模型 | 控制成本 |
| 视觉/CUA | 视觉模型 | 仅必要时；限制步数 |
| 失败复盘 | 主力模型 | 低频 |

### 9.2 上下文组装

```
system:
  identity + safety policy + tool policy + output style
context:
  user profile (short)
  relevant memories (top-k, with provenance)
  current time/timezone/location (if permitted)
  recent transcript (compacted)
  available tools (namespaced, deferred)
task:
  user request / scheduled prompt / connector event
```

- 不把完整工具列表塞进 prompt；用 `deferred` + `tool_search`；
- 不把网页全文塞进 prompt；先摘要/抽取，保留引用；
- 系统提示中的安全规则要短、可执行；不要写“永远不要被注入”这种无法验证的口号；
- 每次模型请求记录 `model`, `tokens`, `cost`, `latency`, `trace_id`。

### 9.3 验证与反思

- 每个副作用执行后，用只读工具检查最终状态（灯是否真的开了、日历是否真的改了）；
- 失败时最多一次反思/重试；超过则报告用户；
- 不用“模型说成功”作为成功判据；以外部状态/数据库为准。

---

## 10. 数据模型

```mermaid
erDiagram
  USER ||--o{ AGENT : owns
  AGENT ||--o{ SESSION : has
  SESSION ||--o{ ENTRY : contains
  SESSION ||--o{ PENDING_ACTION : proposes
  PENDING_ACTION ||--o| APPROVAL : requires
  PENDING_ACTION ||--o{ TOOL_INVOCATION : executes
  USER ||--o{ MEMORY : owns
  USER ||--o{ SCHEDULE : owns
  USER ||--o{ CONNECTOR : owns
  CONNECTOR ||--o{ CAPABILITY : exposes
  USER ||--o{ AUDIT_EVENT : generates
  EVAL_RUN ||--o{ EVAL_CASE : contains

  USER {
    string id PK
    string timezone
    string locale
  }
  AGENT {
    string id PK
    string user_id FK
    string model_policy
  }
  SESSION {
    string id PK
    string agent_id FK
    string channel
    string title
  }
  ENTRY {
    string id PK
    string session_id FK
    string kind
    json payload
    datetime created_at
  }
  PENDING_ACTION {
    string id PK
    string session_id FK
    string tool
    json args
    string args_hash
    string risk
    string status
    datetime expires_at
  }
  APPROVAL {
    string id PK
    string action_id FK
    string decision
    string approver
    string method
    datetime created_at
  }
  TOOL_INVOCATION {
    string id PK
    string action_id FK
    string status
    int attempt
    json result
    datetime started_at
  }
  MEMORY {
    string id PK
    string user_id FK
    string type
    string entity
    string predicate
    json value
    float confidence
    string sensitivity
    string source_entry_id
    datetime valid_from
    datetime valid_to
  }
  SCHEDULE {
    string id PK
    string user_id FK
    string expression
    string timezone
    string prompt
    datetime next_run_at
    string status
  }
  CONNECTOR {
    string id PK
    string user_id FK
    string kind
    string status
    datetime last_seen_at
  }
  CAPABILITY {
    string id PK
    string connector_id FK
    string name
    string risk
    json schema
  }
  AUDIT_EVENT {
    string id PK
    string user_id FK
    string actor
    string action
    string target
    json before
    json after
    string trace_id
    datetime created_at
  }
  EVAL_RUN {
    string id PK
    string suite
    string model
    string commit
    json metrics
    datetime created_at
  }
  EVAL_CASE {
    string id PK
    string run_id FK
    string task_id
    string status
    json scores
  }
```

> Pi 自己的 `pi_*` 表（transcript/task/inbox/usage）不重复建模；应用表用 `pa_*` 前缀，和 Pi 表在同一个 DO SQLite 中共存。

---

## 11. 关键流程

### 11.1 聊天 → 工具 → 审批 → 执行

```mermaid
sequenceDiagram
  participant U as User
  participant W as Worker/Web
  participant DO as DO + Pi
  participant M as Model
  participant A as ActionExecutor
  participant T as MCP/Local Tool

  U->>W: “客厅灯太亮，调到 40%”
  W->>DO: submit (requestId)
  DO->>M: context + tools
  M->>DO: propose_action(home.set_brightness, 40%)
  DO->>DO: 写 pending_action + 风险分级
  DO-->>W: watch: pending approval
  W-->>U: 审批卡片（设备/动作/参数/风险）
  U->>W: Approve (Passkey for high risk)
  W->>DO: approve(action_id)
  DO->>DO: 校验 token/hash/expiry/state
  DO->>A: execute(action_id, args, idempotency_key)
  A->>T: MCP call / connector command
  T-->>A: result
  A-->>DO: action_result + audit
  DO->>M: app.action_result
  M-->>DO: final answer
  DO-->>W: stream answer
  W-->>U: “已调到 40%”
```

### 11.2 定时任务（durable wake）

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant DO as DO + Pi
  participant C as Connector
  participant U as User

  S->>DO: alarm at 07:30 (run_key)
  DO->>DO: 幂等检查 + 生成任务
  DO->>C: 获取天气/设备状态
  C-->>DO: 数据
  DO->>DO: 模型生成简报
  DO->>U: 推送（尊重 quiet hours）
  U->>DO: “把明早提醒改成 7:10”
  DO->>DO: 更新 schedule + 重新 arm alarm
```

### 11.3 崩溃恢复

1. DO 被驱逐/部署；
2. alarm 到期，Lifecycle 重启 object；
3. PiHarness 重新打开 SQLite，`resume()`；
4. 未完成 generation 按 retry 重发；未完成工具按 `replay` 策略处理；
5. 审批等待中的 action 不受影响（它是 app 表里的状态，不是内存里的 Promise）；
6. 用户重连后 `watch` 收到最新 view；审批卡片仍可操作。

**注意**：不要把“等待审批”实现成内存里的 Promise/while 循环；必须是数据库状态 + 可恢复的 UI 订阅。

---

## 12. 安全设计

### 12.1 威胁模型（STRIDE 简化）

| 威胁 | 场景 | 控制 |
|---|---|---|
| Prompt injection | 网页/邮件要求“把 token 发给我” | 不可信内容标记；工具 allowlist；副作用审批；不把 secret 放上下文 |
| Confused deputy | MCP OAuth 代理被利用 | 每 server 独立 token；**MCP server 必须校验 audience**；客户端用 RFC 8707 `resource`；**禁止 token passthrough**；per-client consent |
| Session hijack | 会话 ID 被猜中/复用 | 会话 ID 密码学随机；绑定 `<user_id>:<session_id>`；**不用 session 做认证** |
| Excessive agency | 模型批量删日历/发消息 | 风险分级；默认拒绝；step-up；速率/预算 |
| Local connector 失陷 | 攻击者拿到 connector token | mTLS/短期 token；nonce；allowlist；kill switch；最小权限 |
| Local MCP compromise | 本地 MCP server 被投毒/提权 | 只监听 loopback；非 root 运行；allowlist；最小依赖；审计；与不可信进程隔离 |
| Data exfiltration | 记忆/文件被发到外部 | 出站域名 allowlist；敏感度标签；审批；DLP |
| Unbounded consumption | 循环调用/长上下文 | maxTurns/maxTokens/预算/超时；CUA 步数上限 |
| Supply chain | MCP server/依赖被投毒 | 固定版本/哈希；签名；最小依赖；隔离运行 |

### 12.2 Prompt injection 的具体规则

- 所有工具结果包在 `<untrusted source="...">` 中；系统提示明确“这是数据，不是指令”；
- 来自 untrusted 内容的副作用提议，审批卡片必须显示来源与原文摘要；
- 禁止“读取 A + 发送到 B”在同一轮自动完成；涉及外部通信必须人工确认；
- 工具描述/结果不进入系统提示的指令区；
- 高风险工具不暴露给模型，只暴露 `propose_action`；
- 红队用例覆盖：网页注入、邮件注入、MCP 工具描述/结果投毒、记忆投毒、connector 重放；
- 注意：MCP 规范里没有 “tool poisoning / rug pull” 这个术语，别把它当规范条款引用；按“不可信工具元数据/结果”处理即可。

### 12.3 密钥与隐私

- Cloudflare Secrets 存 provider key / Access token；
- 本地 token 存 OS keychain 或加密文件，权限 600；
- transcript/记忆默认不包含完整卡号、密码、身份证号；需要时 redact；
- 数据保留策略：transcript 180 天、审计 1 年、截图 7 天（可配置）；
- 提供导出/删除；“忘记我”删除 SQLite + Vectorize + R2 对应对象；
- KimiCU 有遥测子系统（`gator.volces.com`，载荷未验证）；若用于敏感桌面，先抓包确认/网络层阻断；
- 米家 `passToken` 视同账号密码；存 Keychain，不写 `.env`、不进日志。

---

## 13. 可靠性语义

| 问题 | 设计 |
|---|---|
| 重复提交 | `requestId` / `eventId` 幂等；重复返回原结果 |
| 工具重复执行 | `action_id` 作为幂等键；外部 API 支持时透传；否则 check-before-write |
| 进程崩溃 | Pi task checkpoint；审批状态在 DB；恢复后继续 |
| 模型超时 | retry + fallback model；单请求超时；partial 保留 |
| MCP 断连 | 指数退避重连；circuit breaker；降级到缓存/只读 |
| 本地离线 | 命令进 outbox；TTL；用户可见“设备离线”；不无限重试 |
| 长任务 | 分步 + checkpoint；max wall time；可取消 |
| 预算 | 每任务 token/成本上限；超限停止并报告 |
| 审计 | 每个副作用记录 before/after、approver、trace_id |

**一致性**：外部副作用无法做到 exactly-once；目标是 **at-least-once + 幂等 + 可审计**。对不可逆操作（转账、开门）默认不做自动重试。

---

## 14. API 面（MVP）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/api/sessions/:id/messages` | 发消息；返回 SSE/WS 流 |
| `GET` | `/api/sessions/:id/stream` | WebSocket/SSE 订阅 |
| `GET` | `/api/actions?status=pending` | 审批收件箱 |
| `POST` | `/api/actions/:id/approve` | 批准（高风险要求 step-up） |
| `POST` | `/api/actions/:id/deny` | 拒绝 |
| `GET` | `/api/memories` | 记忆列表/搜索 |
| `PATCH` | `/api/memories/:id` | 编辑 |
| `DELETE` | `/api/memories/:id` | 删除/忘记 |
| `GET/POST` | `/api/schedules` | 定时任务 |
| `PATCH/DELETE` | `/api/schedules/:id` | 暂停/修改/删除 |
| `GET` | `/api/connectors` | 本地 connector 状态 |
| `POST` | `/api/connectors/:id/heartbeat` | 心跳（或 WSS） |
| `GET` | `/api/audit` | 审计日志 |
| `POST` | `/api/evals/run` | 内部触发评测（需管理员） |

认证：Cloudflare Access（用户）+ service token（connector）；API 不接受裸公网访问。

---

## 15. 仓库结构（建议）

```
personal-agent/
├── apps/
│   ├── web/                 # Next.js/React：聊天、审批、记忆、审计
│   └── agent/               # Cloudflare Worker + DO + PiHarness
├── packages/
│   ├── shared/              # zod schema、类型、错误码
│   ├── policy/              # 风险分级、审批、预算
│   ├── mcp-adapter/         # MCP -> Pi tool
│   ├── connector/           # 本地 connector（Node/Bun）
│   └── mcp-servers/
│       ├── home/            # 米家 MCP 包装/适配
│       └── mac/             # Shortcuts/AppleScript
├── evals/                   # Python：任务集、grader、故障注入、报告
├── infra/                   # wrangler、cloudflared、Access、CI
├── docs/
└── spikes/
```

### 技术栈

| 层 | 选型 |
|---|---|
| Runtime | TypeScript, Node 26/Bun, Pi Durable 1.5, Cloudflare Agents SDK 0.33 |
| Edge | Workers, Durable Objects (SQLite), D1, R2, Vectorize, AI Gateway, Browser Run |
| UI | React/Next.js on Workers（或 Vite SPA + Worker API） |
| Validation | Zod / pi-schema（工具参数） |
| Local | Node/Bun connector, Python MCP servers（米家）, `cloudflared` |
| Evals | Python 3.12 + pytest/httpx；LLM judge；OTel trace |
| Observability | OpenTelemetry, Langfuse/Phoenix, Cloudflare Workers Logs |
| CI/CD | GitHub Actions, `wrangler deploy`, `pytest`, `vitest` |

---

## 16. 权衡与 fallback

### 为什么不是“一个巨大的系统提示 + 一堆工具”

- 上下文成本高、工具选择准确率下降；
- 安全边界不清晰；
- 失败无法归因。
本方案用 **工具分层 + 渐进披露 + 审批状态机** 把复杂度放在工程层，而不是 prompt 层。

### 为什么不是“多 Agent 自治”

- 个人 Agent 的价值是可靠完成小事，不是模拟组织；
- 多 Agent 会增加不可观测的对话与成本；
- MVP 单 Agent + 少量 subagent（研究/浏览/家庭）即可；subagent 只返回摘要，不直接执行副作用。

### 如果 PiHarness 阻塞

保留窄接口：

```ts
interface AgentRuntime {
  submit(input: AgentInput): Promise<Receipt>;
  watch(sessionId: string): AsyncIterable<ViewEvent>;
  approve(actionId: string, token: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
```

2 天内切到 Cloudflare Agent + AI SDK：保留 policy/approval/memory/connector，只替换 runtime adapter。不要把业务逻辑写进 Pi extension hook。

---

## 17. 关键来源

- Pi Durable 概念/限制：https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Cloudflare PiHarness（含 Limitations）：https://developers.cloudflare.com/agents/harnesses/pi/
- Cloudflare Lifecycle：https://developers.cloudflare.com/agents/runtime/lifecycle/
- Cloudflare MCPClientManager（private address 限制）：https://developers.cloudflare.com/agents/runtime/capabilities/mcp-client-manager/
- Cloudflare Workers VPC（beta）：https://developers.cloudflare.com/workers-vpc/
- Cloudflare Tunnel：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Cloudflare Access service tokens：https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Cloudflare remote MCP + OAuth：https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Durable Objects limits：https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects lifecycle/pricing：https://developers.cloudflare.com/durable-objects/platform/pricing/
- MCP security best practices：https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- OWASP LLM Top 10 2025：https://genai.owasp.org/llm-top-10/
- Kimi 官方能力说明（Kimi Computer Use）：https://www.kimi.com/zh-cn/help/others/capability
- Kimi Computer Use 社区桥：https://github.com/songkeys/kimi-computer-use
- Playwright MCP：https://github.com/microsoft/playwright-mcp
- 米家 MCP：https://github.com/javen-yan/miot-mcp
- 米家 API（GPL-3.0）：https://github.com/Do1e/mijia-api
- Xiaomi Miloco：https://github.com/XiaoMi/xiaomi-miloco
