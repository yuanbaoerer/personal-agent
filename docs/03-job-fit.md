# 03 · 行业 Agent 岗位适配度

> 目标：判断这个 personal agent 项目对 **2027 届校招 / 社招 Agent 方向** 的适配度，并给出可执行的简历、Demo、面试表达。

## 1. 结论

| 岗位方向 | 适配度 | 判断 |
|---|---|---|
| **Agent Harness / Runtime** | **最强** | durable execution、任务状态、工具反馈、上下文、subagent、eval 与这类岗位高度同构；面壁的 JD 甚至直接点名 **Pi**。 |
| Agent 平台 / AgentOps（应用侧） | **强–中** | 有 runtime、工具网关、策略、可观测性；缺 K8s/Go/大规模并发，需要补。 |
| Agent 应用工程师（产品/业务落地） | **强** | 项目覆盖工具调用、MCP、记忆、审批、长任务、评测，正好是 JD 的高频词。 |
| Agent 算法（后训练/RL/评测） | **中–弱** | 有 eval/trace/失败归因，但没有 SFT/RL、数据合成、训练框架经验；校招算法岗还卡论文/硕士。 |
| 大模型 Infra / 推理平台 | **弱–中** | 项目不涉及推理服务、K8s、GPU、vLLM/SGLang；不适合作为主项目。 |
| 海外 Agent Infra / 大厂 | **弱–中** | 方向对，但海外样本普遍要求 5–8 年、分布式/沙箱内核/多租户；个人项目只能证明理解，不能证明规模。 |
| AI 产品 / 解决方案 | **中** | 有产品思考和端到端交付，但缺少业务指标/客户落地证据。 |

**一句话**：这是一个“Agent Harness/Runtime + 应用/平台”方向的强项目，不是“算法/Infra”方向的万能项目。投递时应主攻前者，用项目证明工程深度；后者需要额外作品或实习。

**校招 vs 社招的关键差异**：在 16 份中文 JD 的样本里，Eval、Observability、Durable execution、Memory 这些“生产级 Agent”能力几乎只出现在社招 JD；校招更看算法基础、实习、论文和“能动手”。所以：

- **2027 校招**：项目是差异化加分项，优先投小米 Agent 工程师、美团 Agent 实习这类“工程向”岗位；不要用同一个项目硬碰字节 Seed/阿里 Agent 算法的 RL、论文门槛。
- **社招 2–5 年**：项目必须拿出恢复率、重复副作用=0、eval 通过率等生产证据，才能对标面壁、Manus、腾讯 Harness、美团 BA Agent、蚂蚁 CodeFuse。

---

## 2. 目标岗位画像

### A. Agent 应用工程师

典型职责：

- 把 LLM/Agent 落到真实业务（客服、办公、研发、数据分析）；
- 意图识别、任务规划、工具调用、多轮对话、记忆；
- 高并发/低延迟、SSE/WebSocket、长任务调度；
- 评测体系、线上监控、失败归因；
- 与产品/算法/前端协作。

**项目对应**：几乎全中。你缺的不是“再做一个功能”，而是把指标和失败归因讲清楚。

### B. Agent 平台 / AgentOps

典型职责：

- Agent runtime、Workflow、Tool/Skill 平台、MCP 网关；
- 多租户、权限、配额、可观测、发布/回滚；
- 模型接入、Prompt 管理、评测平台；
- 云原生/任务编排（K8s、Argo、Kubeflow）。

**项目对应**：runtime/tool gateway/policy/observability 有；K8s/Go/多租户是缺口。可以补一个“多租户压测 + K8s 部署”小模块，但不要喧宾夺主。

### C. AI Coding / Harness

典型职责：

- Agent Harness：推理规划、上下文管理、长期记忆、工具使用、执行反馈；
- Subagent/多智能体协作；
- 真实任务评测、执行轨迹分析、失败归因；
- 代码检索/仓库理解/测试执行。

**项目对应**：Pi Durable 的 task/checkpoint/subagent/compaction 与 harness 岗位同构；你的“审批 + 本地执行 + eval”是加分项。

### D. Agent 算法

典型职责：

- Agent 数据合成、SFT/RL 后训练；
- 评测集设计、模型/策略评估；
- 任务规划、工具调用、长期记忆、多 Agent；
- 从 trace/用户反馈定位失败模式。

**项目对应**：eval/trace 有，训练/RL 没有。若投算法，需要补一个“小规模工具调用数据合成 + SFT/DPO 实验”或相关论文/实习。

---

## 3. JD 证据（2026-11 抓取）

| 公司/岗位 | 类型 | 关键要求（原文要点） | 链接 |
|---|---|---|---|
| 小红书 · 2027 校招 Agent 平台全栈研发工程师 | 校招 | Go/Java/Python 至少一门；K8s/Docker/微服务/MySQL/Redis/MQ/SQL；LLMOps；Agent Workflow、Tool Calling、Function Calling、MCP、RAG、Memory、多轮对话、调试诊断、发布；Argo/Kubeflow；可观测/可恢复；LangChain/LlamaIndex/Dify/Coze/AutoGen/CrewAI/Claude Code/MCP；vLLM/SGLang 加分 | [链接](https://job.xiaohongshu.com/campus/position/22059) |
| 360 · 27 秋招 Agent 智能体开发工程师 | 校招 | Python/FastAPI；MCP Server 协议对接/开发/封装；Skill 插件；LangChain/LangGraph/Dify/n8n；Function Calling、工具编排、Prompt；RAG/向量库；JSON/YAML/Schema；全链路测试/性能调优 | [链接](https://360campus.zhiye.com/campus/detail?jobAdId=e72712e9-7de3-4a3e-94b3-942da0c1a360) |
| 字节跳动 · 火山方舟 AI Agent 应用研发工程师 | 2027 校招 | 意图识别、工具调用、记忆、多 Agent；高并发/低延迟；SSE/WebSocket、流式、长任务调度；Agent 框架、Prompt/工具集、EVAL、线上监控；Go/Python/TS/Java | [链接](https://jobs.bytedance.com/campus/position/7672671254742157621/detail) |
| 字节跳动 · Aime 大模型 Agent 算法工程师 | 2027 校招（硕士+） | Python/Go/Java/C++；ReAct、Plan-and-Execute、Tool Use、RAG、Context Engineering、Memory、Multi-Agent；PyTorch；SFT/RL/PPO/GRPO；评测集；Trace/用户反馈定位失败；Self-Evolving Agent | [链接](https://jobs.bytedance.com/campus/position/7668355065707219253/detail) |
| 阿里云 · Qoder AI Agent 研发工程师（Harness 方向） | 社招（2 年+） | Agent Harness：推理规划、上下文管理、长期记忆、工具使用、执行反馈；Subagent/多 Agent；评测/实验/轨迹分析/失败归因；TS/Python/Go；高质量个人项目/开源加分 | [链接](https://careers.aliyun.com/off-campus/position-detail?positionId=100004083014) |
| 腾讯 · 高级 Agent 工程师（AI Coding） | 社招（5 年+） | 任务理解/拆解、代码生成、工具调用、测试执行、结果验证；Agent/Skill/Workflow/Tool/Runtime/知识库协作；执行环境/权限；AI Coding 评测（真实任务集/回归/Trace/用户反馈）；明确哪些任务必须人确认 | [链接](https://careers.tencent.com/jobdesc.html?postId=2108442094254338048) |

> 说明：以上为公开 JD 的要点摘录，不是全文；岗位可能已关闭/更新，投递前以官网为准。

### 3.1 更广样本：16 份中文 JD 的统计

> 来自另一轮独立调研（2026-11-04，17 份中国岗位 + 7 份海外岗位；16 份中文 JD 逐份编码）。完整清单见 [`05-jd-appendix.md`](05-jd-appendix.md)。计数是人工编码，不是随机抽样；用于判断趋势，不用于精确排名。

| 能力 | 校招/实习（5） | 社招（11） | 合计（16） |
|---|---:|---:|---:|
| LLM / Tool Calling / Function Calling | 5 | 11 | **16** |
| 后端 / 分布式工程 | 1 | 10 | **11** |
| Agent 框架 / Harness | 1 | 7 | **11** |
| Eval / 评测 / Benchmark | 3 | 7 | **10** |
| Observability / Trace | 0 | 9 | **9** |
| Durable execution / 长任务 / 恢复 | 0 | 6 | **6** |
| Memory / 上下文管理 | 0 | 7 | **7** |
| MCP | 1 | 5 | **6** |
| Multi-Agent | 0 | 5 | **5** |
| Sandbox / 执行环境 | 0 | 5 | **5** |
| HITL / 审批 / 权限 / 安全 | 0 | 4 | **4** |
| RAG / 检索 / 向量库 | 3 | 2 | **5** |
| 产品思维 / 业务场景 | 1 | 8 | **9** |

三个反直觉结论：

1. **MCP 不是入场券**：16 份里只有 6 份明确提到，校招仅 1 份；它是加分项，不是“不会 MCP 就进不去”。
2. **Multi-Agent 热度高于岗位需求**：只有 5/16 明确要求；更多岗位要的是单 Agent 的可靠性、状态、工具与评测。
3. **RAG 在 Harness 岗里很弱**：RAG 集中在算法岗、企业知识场景和校招加分；Kimi Code、面壁、腾讯 Harness、美团 BA Agent 都没把 RAG 列为核心要求。

### 3.2 高价值补充 JD（与 personal agent 最相关）

| 公司/岗位 | 类型 | 为什么相关 | 链接 |
|---|---|---|---|
| 小米 · Agent 工程师 | 2027 校招（硕士+，985/QS100） | 智能体运行时、编排引擎、Skill 框架、MCP 工程化、延迟/成功率/幻觉率指标；与项目几乎一一对应 | [牛客](https://www.nowcoder.com/jobs/detail/461750) |
| 面壁智能 · Agent Harness 研发工程师/架构师 | 社招 | JD 直接点名 **Pi**；要求 ReAct 主循环、状态管理、Memory/Context、Orchestrator、Skill、Tools、子 Agent、权限/审计/沙箱、token 成本/延迟 | [链接](https://modelbest.jobs.feishu.cn/career/position/7698973064822540595/detail) |
| Manus · Agent Harness Engineer | 社招（3–5 年） | 与“personal agent + durable + MCP + 审批 + eval”最接近：context/memory/tools/MCP、执行隔离、高风险审批、审计、可复现 eval、端到端 observability | [链接](https://careers.manus.im/en/job/664b475a-ca34-46d2-9846-c52f347857e6) |
| 月之暗面 · Coding Agent 研发（Kimi Code） | 社招 | Agent Loop、工具系统、上下文工程、trace/eval、MCP/Subagent/Multi-agent；与 harness 方向高度同构 | [链接](https://app.mokahr.com/apply/moonshot/148506#/job/82f07bb3-8bdc-4714-805f-43b1a22c238f) |
| 字节 Seed · Multi-Agent Harness 工程师 | 社招 | Long-Running Multi-Agent Harness、OS/多任务调度、沙盒、Claude Code/Codex 实现细节；偏基础设施深度 | [链接](https://jobs.bytedance.com/experienced/position/7650342480791095557/detail) |
| 腾讯混元 · AI Agent Harness Engineer | 社招 | 全链路 tracing/observability、自动化 eval pipeline、A/B、regression、debugging 工具；与项目的 eval/OTel 直接对应 | [链接](https://careers.tencent.com/jobdesc.html?postId=2052685072754196480) |

> 这 6 个岗位比“泛 Agent 应用”更能检验项目深度：它们会追问 runtime 状态、失败恢复、工具权限、eval 口径、trace 设计。

### 3.3 校招 vs 社招：项目该怎么讲

| 维度 | 校招/实习 | 社招（2–5 年） |
|---|---|---|
| 硬门槛 | 届别、学历、专业、实习时长 | 2–5 年，资深 5–8 年；production 经验 |
| 考察重心 | 算法/数据结构、Transformer、SFT/RL、PyTorch、论文、实习 | 分布式、并发、状态、故障恢复、可观测性、成本、ownership |
| Agent 相关 | Prompt、Chain、Harness、Skills、RAG、微调、评测指标 | Harness 内核、runtime、sandbox、MCP、memory、multi-agent、eval pipeline、tracing、审批 |
| 项目作用 | 证明“能动手 + 有 Agent 品味” | 证明“能把 Agent 跑在生产” |
| 本项目的讲法 | 讲清“我理解 Agent 的失败模式，并做了最小验证”；不要冒充生产 | 讲清恢复率、重复副作用=0、eval 通过率、成本/延迟；没有数字就不要说“生产级” |

### 3.4 高频能力（本组 6 个 JD）

| 能力 | 出现 | 项目可证明 |
|---|---:|---|
| 工具调用 / Function Calling | 6/6 | ✅ 工具网关 + MCP + 审批 |
| 任务规划 / Agent Loop | 6/6 | ✅ Pi task/generation loop + 计划/执行/验证 |
| RAG / 知识库 | 5/6 | ⚠️ 有检索，但不是重点；可加“文档/邮件检索” |
| Memory / 长期记忆 | 5/6 | ✅ 分层记忆 + 抽取/冲突/检索 |
| Eval / 评测 | 5/6 | ✅ Python eval harness + 回归 |
| Multi-Agent / Subagent | 4/6 | ✅ Pi subagent，但 MVP 只做 1–2 个 |
| 可观测性 / Trace / 失败归因 | 4/6 | ✅ OTel + trace + eval 报告 |
| 高并发 / 流式 / 长任务 | 3/6 | ⚠️ 有长任务/流式；缺大规模压测 |
| MCP | 3/6 | ✅ 核心亮点 |
| Python | 5/6 | ⚠️ 运行时是 TS；用 Python eval 补齐 |
| TypeScript | 4/6 | ✅ |
| Go/Java | 4/6 | ❌ 无；平台岗需补 |
| K8s / 云原生 | 2/6 | ❌ 无；平台岗需补 |
| SFT/RL/后训练 | 1/6 | ❌ 无；算法岗需补 |

---

## 4. 项目 ↔ JD 映射

| JD 要求 | 项目证据（做完后） | 强度 | 如果被追问 |
|---|---|---|---|
| 工具调用/编排 | MCP 工具发现、命名空间、渐进披露、超时/重试/输出上限 | 强 | 讲“工具描述是外部输入，不能当系统指令” |
| 长任务/durable | Pi task checkpoint、DO alarm、崩溃恢复、幂等键 | 强 | 讲“exactly-once 不可能，做 at-least-once + 幂等” |
| 记忆 | profile/semantic/episodic/procedural；抽取-去重-冲突-检索 | 强 | 讲“错误记忆比没有记忆更危险” |
| 审批/HITL | 两阶段 propose/approve/execute；token/hash/step-up | 强 | 讲“模型没有执行权” |
| 评测 | 50 条任务、确定性 grader + LLM judge、故障注入 | 强 | 讲“以外部状态为准，不以模型说成功为准” |
| 可观测 | OTel span：run/model/tool/approval/connector | 中强 | 讲“trace 只存 ID，不存敏感内容” |
| 多 Agent | 研究/浏览器 subagent，返回摘要，不直接副作用 | 中 | 讲“为什么 MVP 不做成自治 Multi-Agent” |
| 高并发 | 单用户 MVP；最多做一个 100 并发压测 | 弱 | 讲“知道瓶颈在 DO 单线程/6 连接，给出分片方案” |
| K8s/Go | 无 | 弱 | 不要硬编；承认边界，讲可迁移的 runtime 设计 |
| SFT/RL | 无 | 弱 | 不要投算法岗为主；或补实验 |

### 4.1 把 Pi 经验翻译成 JD 关键词

Pi 本身几乎不会出现在 JD 里；面试时要主动映射到招聘方熟悉的词：

| Pi 概念 | JD/工业界对应词 | 一句话解释 |
|---|---|---|
| Harness | Agent Harness / Runtime | 跑 agent loop、工具、上下文、恢复的运行时 |
| Run / Submission | Workflow / Run | 一次从输入到最终答案的执行 |
| Tool Task | Activity | 可重试、可审计的工具调用单元 |
| Steer | Signal | 运行中注入用户修正 |
| `sleepUntil` + alarm | Durable Timer | 持久化等待，进程可退出 |
| `replay: "safe"` | Idempotency / Retry policy | 崩溃后哪些步骤可重跑 |
| `restartLimit` | Max retries / DLQ | 连续崩溃后的封顶与死信 |
| Compaction | Context Engineering | 长对话的摘要与上下文预算 |
| Subagent | Multi-Agent | 隔离子会话，返回摘要 |
| `propose_action` | Human-in-the-loop / Approval | 副作用前的人工确认 |

**关键差异（面试加分）**：Temporal 用 **Event History + 确定性重放**，要求 workflow 代码 deterministic；Pi Durable 用 **每 phase checkpoint**，不要求业务代码确定性，但要求 phase 可从头重跑、副作用声明 replay 策略。两者不是等价物，别声称“Pi 就是 Temporal”。

> 如果 JD 明确写 LangGraph/Temporal，而你只用过 Pi：诚实说“我用 Pi 实现了同类语义，理解 workflow/activity/signal/timer 的映射；LangGraph 的 checkpointer 我可以在一周内上手”。不要编经历。

---

## 5. 简历怎么写

> 原则：**动词 + 机制 + 指标 + 边界**。不要写“使用了 Pi、Cloudflare、MCP”这种名词堆叠；要写“解决了什么失败模式”。

### 5.0 先分清“已有 / 设计 / 缺口”

| 状态 | 内容 | 能不能写进简历 |
|---|---|---|
| **已有（仓库可验证）** | Pi Durable SQLite transcript；`beforeTool` 审批阻断；重开同一 DB 后 root + 5 条 entry 仍在 | ✅ 可以写，注明“spike/验证” |
| **设计态** | Cloudflare DO 部署、MCP 网关、本地 connector、记忆、eval、OTel、审批 UI | ❌ 没实现前不能写成“已实现” |
| **缺口** | 生产级恢复率、重复副作用=0、多租户、K8s/Go、SFT/RL | ❌ 不要编数字/经历 |

**现在就能写的两条**：

- 基于 `@earendil-works/pi-durable@1.5.0` 构建持久化 Agent runtime 原型：SQLite 存储 transcript，接入 `beforeTool` 审批钩子；进程重启后恢复同一 root session 与 5 条 entry，验证副作用调用在执行前被阻断。
- 设计并验证“模型提议、宿主审批、宿主执行”的权限边界：工具调用在 `beforeTool` 阶段被拦截，模型收到结构化 error result，而不是静默失败。

**做完 Cloudflare + MCP + eval 后再写的**：

- 基于 Cloudflare Durable Object 部署单用户 Agent runtime：持久化会话与事件、WebSocket 流式输出；断线重连恢复率 `X%`，端到端 P95 `Y ms`。
- 构建 MCP 工具网关：统一注册、鉴权、审计 `N` 个工具；两阶段审批覆盖高风险动作；40 条任务中工具调用成功率 `X%`、重复副作用 `0`、审批 P95 `Y ms`。
- 构建 Agent 评测与可观测体系：OTel trace 覆盖模型与工具调用，40 条回归任务接入 CI；任务成功率从 `A` 提升到 `B`，单任务成本下降 `C%`。

**不要写**：生产级、高可用、多租户、支撑百万用户、精通 MCP/LangGraph/RAG（除非有代码与评测）、任何未经测量的百分比。

### 版本 A：Agent 应用工程师（推荐）

- 构建 durable personal agent：Cloudflare Durable Object + Pi Durable 承载长任务，任务级 checkpoint + 幂等提交，进程驱逐/部署后自动恢复；混沌测试恢复率 **X%**。
- 设计“提议-审批-执行”分离：模型只能 `propose_action`，副作用由宿主在执行前校验 action hash/过期/权限；20 条红队/越权用例 **0** 次未授权副作用。
- 接入 3 类 MCP（日历/天气/米家）与本地 connector（VPC / Tunnel + Access），实现“云端规划、本地执行”；只读自动、写入审批、高风险 step-up。
- 建立 Python eval harness（40 任务，确定性 grader + LLM judge + 故障注入），任务成功率从 **X% → Y%**，单任务成本 **$Z**；用 OTel trace 做失败归因。

> 上线前把 X/Y/Z 用实测替换；没有数字就写“建立了可复现评测”，不要编。

### 版本 B：Agent 平台 / AgentOps

- 抽象 `AgentRuntime` 窄接口（submit/watch/approve/cancel），支持 PiHarness 与 Cloudflare Agent 双实现，避免锁定 beta 运行时。
- 实现工具网关：MCP 发现/包装、风险分级、超时/重试/熔断、预算与速率限制；工具集从 3 个扩展到 10+ 仍保持可解释。
- 实现可观测与回放：每次 run 记录 model/tool/approval/connector span 与 golden transcript；升级 Pi/Agents SDK 前跑 30 条会话回放。
- 设计多租户分片：DO per user、D1/Vectorize 共享、按用户限流；100 并发压测 p95 **X ms**（如果做了再写）。

### 版本 C：Agent 算法 / 评测

- 设计 Agent 评测体系：覆盖工具选择、长任务、记忆、审批、注入、恢复 6 类，共 50 任务；确定性状态检查 + rubric judge + 人工校准。
- 基于 trace 做失败归因，定位 top 失败模式（工具参数、上下文丢失、审批绕过、记忆冲突），推动 3 轮迭代，成功率 **X% → Y%**。
- 做记忆消融：无记忆 / 全量上下文 / 分层记忆对比，任务成功率与 token 成本 trade-off（如果做了再写）。
- （可选）构造工具调用轨迹数据，做小规模 SFT/DPO 实验，验证工具选择准确率提升（没做不要写）。

---

## 6. 5 分钟 Demo 脚本

1. **0:00–0:40 定位**：不是聊天机器人，是“能长期做事、但副作用要人确认”的个人 Agent；云端大脑 + 本地手脚。
2. **0:40–1:40 审批**：说“客厅灯太亮，调到 40%”；展示 propose → 审批卡片（设备/参数/风险/来源）→ 批准 → 执行 → 审计。强调模型没有执行权。
3. **1:40–2:30 长任务/恢复**：触发“明早 7:30 简报”；展示 schedule + durable wake；中途 kill/重启 object 或断开 connector，恢复后继续。
4. **2:30–3:20 记忆**：说“以后空调默认 26℃”；展示记忆写入、来源、可编辑；下一次对话自动使用。
5. **3:20–4:10 评测**：打开 eval 报告：任务成功率、失败模式、成本、p95；展示一条 trace 从模型 → 工具 → 审批 → connector。
6. **4:10–5:00 边界**：Kimi CUA 是本地可选、米家是非官方、PiHarness 是 beta；讲清楚为什么不把这些当核心。

> 录屏比现场更稳；提前准备“离线/失败”分支，面试官更看重你如何处理失败。

---

## 7. 面试问答（准备这些）

### Q1：为什么要 durable execution？普通 agent 循环不够吗？

要点：进程会死、DO 会被驱逐、部署会中断、审批可能等很久；普通循环把状态放内存，失败就丢。Pi Durable 把模型/工具/等待都变成 task + checkpoint；恢复时知道从哪继续。外部副作用无法 exactly-once，所以用 `action_id` 幂等 + at-least-once + 审计。

### Q2：为什么选 Pi/Cloudflare，而不是 LangGraph/Temporal？

要点：Pi 的任务级持久化 + DO 的 per-user 状态/调度/ hibernation 很贴合个人 Agent；LangGraph 更成熟、Python 生态更好，但需要 Postgres/Redis/Temporal 等更多基础设施。我的业务层用窄接口隔离，随时可换。不要贬低 LangGraph；讲 trade-off。

### Q3：PiHarness 是 beta，你怎么控制风险？

要点：锁定 `agents@0.33.0` + `pi-durable@1.5.0`；升级前跑 golden session 回放；所有会话格式变更向前修复、不回滚；业务逻辑不写进 Pi hook；准备 Cloudflare Agent fallback；演示前冻结版本。

### Q4：怎么防止 prompt injection 让 Agent 乱执行？

要点：不可信内容标记；工具 allowlist；模型只能 propose；副作用审批展示来源；高风险 step-up；不把 secret 放上下文；外部通信与读取分离；红队用例。引用 OWASP LLM01/LLM06 和 MCP 安全最佳实践。

### Q5：怎么评测一个 personal agent？

要点：任务集 + 外部状态检查（灯/日历/数据库）+ 工具调用断言 + LLM rubric + 人工校准；capability vs regression；故障注入（杀 DO、断 connector、MCP 超时）；指标：成功率、未授权副作用=0、审批时延、p95、成本/任务、恢复率。不要只测“回答像不像”。

### Q6：审批等待很久，怎么不阻塞 Agent？

要点：审批是 DB 状态，不是内存 Promise；Pi session 可以 idle/hibernate；用户批准后由宿主写 `app.action_result` 并 submit；超时过期；提醒/升级；不占用模型 turn。

### Q7：长任务超过 15 分钟怎么办？

要点：拆步骤 ≤10 分钟；每步 checkpoint；alarm 链；子任务；maxTurns；大输出落 R2；不要把一次模型请求拖过 15 分钟；必要时用 Workflows/Queues 做重型步骤。

### Q8：记忆写错了怎么办？

要点：来源/置信度/敏感度；用户可编辑/删除；冲突保留历史；高影响偏好需确认；检索带 provenance；定期评测错误记忆率；不把 untrusted 内容自动写成偏好。

### Q9：怎么扩到多用户/百万用户？

要点：DO per user 分片；D1/Vectorize 共享；按用户限流/配额；重任务进 Queue/Workflows；连接数/单线程是瓶颈；不要声称已实现，讲设计方案与压测计划。

### Q10：这个项目最大的技术难点是什么？

要点（按实际经历选）：把“审批”做成可恢复状态而不是阻塞调用；让模型无法绕过执行器；在 DO 驱逐/版本升级下保持会话可读；MCP 工具描述不可信；评测的“成功”定义。讲一个具体的 bug + 怎么定位 + 怎么防回归。

## 8. 投递优先级与海外对照

### 8.1 投递优先级

| 层级 | 岗位 | 理由 |
|---|---|---|
| **A：强匹配** | 面壁 Agent Harness、Manus Agent Harness、腾讯混元 Harness、美团 BA Agent、蚂蚁 CodeFuse、小米 Agent 工程师、Cloudflare AI Agents | JD 直接要求 Harness/runtime/MCP/审批/eval/observability；项目叙事一一对应 |
| **B：中匹配，需补一项** | 月之暗面 Kimi Code（补 trace/eval 实据）、月之暗面资深 Agent（补 Go/K8s）、小红书 Agent 架构（补 5 年分布式）、MiniMax 服务端（补高并发）、阶跃 Agent 工程（补数据 pipeline）、华为 AI 应用（补 RAG/微调） | 方向对，但硬门槛或深度差一层 |
| **C：弱匹配** | 字节 Seed Agent 算法、阿里 Agent 算法、OpenAI/Anthropic Infra、Temporal | 要求 RL/论文、大规模分布式、沙箱内核或 8 年经验；项目无法短期补齐 |

### 8.2 海外对照（简）

- **海外把 durable execution 当岗位主体**：OpenAI Agent Runtime 要求持久化状态、异步执行、编排、进度报告、失败恢复；Anthropic Managed Agents 要求分钟到数天的会话、断线恢复、durable session/event storage、sandbox orchestration、多租户隔离。
- **Eval/Observability 可以是独立团队**：LangChain 的 LangSmith 岗位、Anthropic 的 eval infra、Cloudflare 的 CI quality gates；国内更多是 Harness 团队的一项能力。
- **Sandbox 是内核级工程**：Anthropic Sandboxing 要求 KVM/QEMU/Firecracker/gVisor/runc；国内 JD 多写“容器/沙箱”一句带过。个人项目只能证明“理解边界”，不能证明“会写内核”。
- **RAG/Prompt 在海外样本中几乎不是核心**：7 份海外 JD 没有一份把 RAG 列为核心要求；国内校招/算法岗仍有。

---

## 9. 两周补强计划（按目标岗位）

### 投应用/平台（优先）

- 第 1 周：完成 MVP 竖切 + eval 40 条；补一个 100 并发压测（k6/artillery），记录 p95/错误率；把结果写进 README。
- 第 2 周：补 K8s 部署一个无状态 sidecar（eval/notification），或者用 Go 写一个 connector 的 command dispatcher；不求深，求能讲清楚。
- 简历：版本 A/B；Demo 5 分钟；准备 Q1–Q10。

### 投算法（次优）

- 第 1 周：把 eval 扩到 6 类 50 条；做 trace 失败归因；做记忆消融。
- 第 2 周：构造 500–1k 条工具调用轨迹，做一个小规模 SFT/DPO（LoRA）实验；报告工具选择准确率/任务成功率变化。
- 注意：没有训练资源就不要硬编；用“评测/失败归因”定位自己，而不是“RL 算法”。

### 投 Infra（不推荐作为主项目）

- 需要额外做：K8s + vLLM/SGLang 部署、推理压测、GPU 利用率、KV cache、量化；这个项目本身不覆盖。
- 可以把 personal agent 作为“Agent runtime 使用方”来讲，但主项目应是推理/平台。

---

## 10. 关键来源

- 小红书 2027 Agent 平台全栈：https://job.xiaohongshu.com/campus/position/22059
- 360 27 秋招 Agent 智能体开发：https://360campus.zhiye.com/campus/detail?jobAdId=e72712e9-7de3-4a3e-94b3-942da0c1a360
- 字节火山方舟 AI Agent 应用研发：https://jobs.bytedance.com/campus/position/7672671254742157621/detail
- 字节 Aime 大模型 Agent 算法：https://jobs.bytedance.com/campus/position/7668355065707219253/detail
- 阿里云 Qoder Agent Harness：https://careers.aliyun.com/off-campus/position-detail?positionId=100004083014
- 腾讯高级 Agent 工程师：https://careers.tencent.com/jobdesc.html?postId=2108442094254338048
- 小米 Agent 工程师（2027 校招）：https://www.nowcoder.com/jobs/detail/461750
- 面壁 Agent Harness：https://modelbest.jobs.feishu.cn/career/position/7698973064822540595/detail
- Manus Agent Harness：https://careers.manus.im/en/job/664b475a-ca34-46d2-9846-c52f347857e6
- 月之暗面 Kimi Code：https://app.mokahr.com/apply/moonshot/148506#/job/82f07bb3-8bdc-4714-805f-43b1a22c238f
- 字节 Seed Multi-Agent Harness：https://jobs.bytedance.com/experienced/position/7650342480791095557/detail
- 腾讯混元 Agent Harness：https://careers.tencent.com/jobdesc.html?postId=2052685072754196480
- Anthropic agent evals：https://www.anthropic.com/research/demystifying-evals-for-ai-agents
- OWASP LLM Top 10 2025：https://genai.owasp.org/llm-top-10/
- MCP security best practices：https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
