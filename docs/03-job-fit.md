# 03 · 行业 Agent 岗位适配度

> 目标：判断 personal agent 对 Agent 岗位的适配，并区分已有证据与未来目标。岗位与薪资样本为原始调研快照，本轮未重新核验招聘有效性。

> 规划已调整为“聊天渠道 + 一个主 Agent + 最多两个 Worker”，以 [00](00-product-plan.md)、[02](02-architecture.md)、[04](04-build-plan.md) 为准。下文能力映射中的勾选表示目标覆盖，不能当作当前实现清单。

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
| Memory / 长期记忆 | 5/6 | 目标：显式事实/偏好、来源与查改删；语义检索和自动抽取后置 |
| Eval / 评测 | 5/6 | 目标：TS 确定性回归 + 真实模型报告；Python 后置 |
| Multi-Agent / Subagent | 4/6 | 目标：一个 Router + 最多两个独立任务 Worker，含派工和取消 |
| 可观测性 / Trace / 失败归因 | 4/6 | 目标：结构化日志、traceId 与 eval 报告；完整 OTel 后端后置 |
| 高并发 / 流式 / 长任务 | 3/6 | ⚠️ 有长任务/流式；缺大规模压测 |
| MCP | 3/6 | ✅ 核心亮点 |
| Python | 5/6 | ⚠️ MVP 运行时与 eval 先用 TS；Python 是额外能力，不能由本项目推定 |
| TypeScript | 4/6 | ✅ |
| Go/Java | 4/6 | ❌ 无；平台岗需补 |
| K8s / 云原生 | 2/6 | ❌ 无；平台岗需补 |
| SFT/RL/后训练 | 1/6 | ❌ 无；算法岗需补 |

---

## 4. 项目 ↔ JD 映射

| JD 要求 | 项目证据（做完后） | 当前规划的可展示内容 |
| --- | --- | --- |
| 工具调用/编排 | 天气 HTTP、mock 灯 MCP、工具约束与核对 | 协议接入与最终状态判定；真机另记 |
| 长任务/durable | 持久 Task / Assignment、运行时 checkpoint、租约与恢复 | 独立进程故障注入；不把正常 close/open 当崩溃恢复 |
| 多 Agent | 一个 Router + 两个 Worker、人工输入优先、版本 fencing | 并发中补充/取消、旧报告失效、上下文隔离 |
| 审批/HITL | Mandate 与 Action 审批分开，程序执行与 reconcile | 重复/过期/越权审批、外部已生效但未落库 |
| 聊天集成 | 验签、身份、Inbox/Outbox、原对话回信 | 接收/发送故障、主动提醒，平台接受与已读区分 |
| 记忆 | 显式偏好、来源、查改删 | 先结构化记忆；向量检索与自动抽取是后续项 |
| 评测 | 40 条场景、12 项关键契约、真实模型重复运行 | fake 与真实模型分开统计，样本数与环境公开 |
| 可观测 | traceId、状态、调用、费用、故障报告 | 先结构化日志；完整 OTel 后端后置 |
| 高并发 | 单主人、两个 Worker 的有界并发 | 不据此声称已有多租户、大规模吞吐证据 |
| K8s/Go/SFT/RL | MVP 不覆盖 | 需要其他项目或实际经历证明 |



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

原则：动词 + 机制 + 实测结果 + 边界。规划和调研不能写成已实现。

### 5.0 已有 / 目标 / 缺口

| 状态 | 内容 | 可使用的表述 |
| --- | --- | --- |
| 已有代码及仓库记录 | faux spike；本地入口/投递；Router/Worker、Task/Assignment、原子审批/动作、提醒、显式记忆、DO `pa_*`、100 个确定性测试；workerd 本地真实模型 Router→Worker 任务；真实飞书 p2p `/status` 回调与回复（临时 Tunnel） | “本地实现 + 真实渠道联调”，不声称真实部署或完整崩溃恢复 |
| 设计态 | 真实 Cloudflare Worker 部署/驱逐恢复、MCP 灯/真机、40 条场景报告 | “待真实环境验证”，不能写“已完成” |
| 增强项 | 真实灯/Connector、第二渠道、完整可观测、向量检索 | 有代码与报告后再列 |
| 未覆盖 | 多租户、大规模并发、K8s/Go、训练/RL | 由其他真实经历证明，不为简历堆进 MVP |

现在可写的证据：

- 构建 Pi Durable 1.5.0 本地验证脚本：使用 faux provider 演示 beforeTool 在工具执行前阻断调用，断言 `executed=false`、工具错误结果和五条 entry。
- 使用 SQLite 保存会话，在正常关闭后重开同一数据库，断言同一 root session 与 entry 数量；另用独立子进程 `SIGKILL` 验证已提交 transcript 可重开，未验证未完成任务/待审批状态恢复。
- 实现飞书事件验签、AES 解密、URL challenge、主人白名单和 `channel + account + eventId` 去重；已用真实飞书自建应用完成 p2p `/status` 回调，`message_id=om_x100b603e0219c0a0b1e2434fa552a87`，回调约 13ms。
- 实现持久 Outbox 的业务键唯一、租约、重试、unknown 和按业务键核对；真实飞书已接受回复 `platform_message_id=om_x100b603e03ccbca4c1ec6d3785d2599`，端到端约 2s。
- 本地 Pi 单 Harness 三会话实验（faux）：Worker A 阻塞在工具时，Router 与 Worker B 仍完成，三份 context 无输入串扰；尚未验证真实模型或 Cloudflare DO。
- 本地通过 `opencode-go/deepseek-v4.1-flash` 跑通真实模型单会话与三会话并发，断言各会话答案与上下文隔离；产品 Router/Worker 已在本地 workerd 用真实模型完成一次任务，尚未在真实账号的 DO 上验证。
- 实现 Task/Assignment 状态机、revision/fencingToken、租约/心跳、任务修改、原子审批、取消/修订后 reconcile 拒绝执行、提醒与显式记忆；100 个确定性测试覆盖关键契约。
- 配置 Cloudflare Durable Object + Lifecycle + PiHarness，使用 SQLite `exports` 并通过 `wrangler deploy --dry-run`；本地 `wrangler dev` 的 DO 已跑通 webhook 受理/去重、鉴权、真实模型 `/ask` 与 Router→Worker 任务，尚未真实部署或做对象驱逐恢复。

### 5.1 应用工程方向：实现后使用

- 将个人助手接入一个真实聊天渠道，完成验签、身份绑定、消息去重、原对话回信和持久提醒；记录投递失败与未知状态。
- 实现一个主 Agent 协调最多两个任务 Worker，支持后续消息路由、修改/取消和上下文隔离；提供并发与恢复测试。
- 将任务授权与动作审批分开，程序校验批准人、参数和版本；在 mock 灯上验证重复批准、取消和未知副作用核对。
- 建立 40 条场景与真实模型重复运行报告，按实际样本填写成功次数/总次数、延迟和费用。

### 5.2 Harness / 平台方向：实现后使用

- 建立 Task / Assignment 状态、租约与 fencingToken，拒绝旧 Worker 的动作和报告，提供中断点复现实验。
- 应用状态与待派工作在同一事务保存，提交后通过持久 Effect / Outbox 交付，区分运行时与平台回执。
- 以窄 AgentRuntime Interface 隔离会话、输入和中断；替代路线只有实现并通过契约后才称双实现。
- 不将 Action 幂等键描述为外部 exactly-once；报告 unknown/reconcile 与人工接管的限制。

### 5.3 评测方向：实现后使用

- 按渠道、协调、权限、恢复、记忆/提醒分类设计场景，以程序断言和外部状态判定结果。
- 对至少十项代表性真实模型任务各运行三次，报告波动、失败原因和预算；fake 结果单独列出。
- 用实际失败驱动迭代；LLM judge、记忆消融或训练实验只有实际完成后才写。

没有测得的 X/Y/Z 不进入简历。固定测试集全部通过不能写成“整体安全率 100%”。

## 6. 5 分钟 Demo 脚本

以下是目标演示，实施后才录制；mock 和真实设备必须标注。

1. **0:00–0:40**：在首发聊天软件中发起两项资料任务，说明对外一个助手、内部两个 Worker。
2. **0:40–1:30**：后台工作时继续问天气，引用消息修改一项、取消另一项；展示旧派工失效。
3. **1:30–2:30**：请求将 mock 灯调至 40%，展示确定参数的审批、执行、核对与审计。
4. **2:30–3:20**：在运行中中断，重启后恢复任务；演示未知动作先核对、不会盲目重放。
5. **3:20–4:10**：确认一次性天气提醒，关闭聊天客户端后收到消息；显式记忆可查改删。
6. **4:10–5:00**：展示关键契约和真实模型报告，解释样本、失败、费用和实际部署环境。

若没有真机，不把 mock 成功说成物理设备已验证；若未通过真实云端中断测试，不称云端恢复已实现。

## 7. 面试问答（准备这些）

### Q1：为什么一个人需要多个 Worker？

长任务与即时对话要解耦，独立工作需要隔离上下文；一个 Router 协调两个有界 Worker。简单只读查询仍直接处理，并发收益需用相同任务与串行基线比较。

### Q2：从 dsh-superagent 借鉴了什么？

Task / Mandate 对应获准的工作，Assignment 对应一次派工；参考其 Source、持久 Effects/Outbox 和人工输入优先思路。个人助手另外要求动作审批与程序执行，不复制编码原型的广泛 Shell 权限。

### Q3：为什么选 Pi / Cloudflare？替代成本是多少？

主选利用会话持久化与 DO 托管，但多会话、幂等交付与恢复须在前三个工作日验证。替代路线由门槛决定，重新估时和测试；窄接口不代表会话格式可无成本迁移。

### Q4：如何防止 Worker 越权或使用旧授权？

工具范围、Task revision、Assignment fencingToken 与 Action 参数由代码校验。消息来源、资料内容与模型推断都不能充当身份或审批；取消后拒绝未来动作，已在途请求单独核对。

### Q5：写动作超时后为什么不能直接重试？

外部可能已经生效，只是本地未记录。进入 unknown，按外部操作回执/幂等键或状态核对，无法确定转人工；check-before-write 不能消除迟到请求和崩溃窗口。

### Q6：等待主人审批时还占 Worker 名额吗？

持久保存待决定事项，Worker 真正空闲后释放名额；不能只改状态就忽略仍运行的后台工作。动作由程序执行，结果通过持久输入唤醒任务。

### Q7：如何保证通知不丢、不重复？

Inbox/Outbox、稳定业务键和回执可以恢复投递，但平台发送与本地事务不是原子操作。超时后优先平台幂等/查询，否则记录 delivery_unknown，不能承诺 exactly-once 或用户已读。

### Q8：怎么评测？

十二项关键确定性契约必须通过；四十条场景包含权限、协调和故障。真实模型至少十项代表任务各运行三次，分别报告样本与波动；不把 10/10 当成有统计保证的 95%。

### Q9：记忆和多渠道如何避免串信息？

MVP 只有一个绑定主人私聊；显式记忆带来源。群聊后续隔离上下文，跨平台身份要经过明确验证，不能用昵称或模型推断绑定。

### Q10：这个项目证明了什么，没证明什么？

依据真实报告描述任务协调、消息投递、审批和恢复；两个 Worker 不代表大规模多租户，mock 不代表真机，运行时正常重开不代表崩溃恢复。选一个实际失败讲定位与修复。

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

## 9. MVP 后的补强（按实际目标选择）

先完成 [04](04-build-plan.md) 的核心验收，再按投递需求选一项，不叠加成新的必修清单：

- **应用 / Harness**：补真实灯、第二聊天渠道或更完整的故障对照，选择实际使用中暴露最多问题的一项。
- **平台**：有明确岗位需求再做并发压测、Go Connector 或部署实验；这些不能由单主人结果推定。
- **评测 / 算法**：先做真实模型失败归因和质量对照，有资源再开展单独的训练实验。
- **Infra**：需要额外的推理服务、GPU 或沙箱工程项目，本项目不能替代这些经历。

时间按实际产物重新估算，不再承诺两周补齐 K8s、Go、训练与完整 MVP。

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
