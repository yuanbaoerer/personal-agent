# 22 · MVP 真实验收 Runbook（owner 手动执行）

> 2026-11-20 · 对应 [21 · MVP Functional Ready](21-mvp-functional-ready.md) §3 与 [#41](https://github.com/yuanbaoerer/personal-agent/issues/41)。
> 本文件只描述**真实环境**验收步骤。确定性测试、本地注入事件和 mock 结果不能替代这里的 E3 证据。

## 0. 前置条件

- 当前 main：以仓库最新提交为准（包含 MVP-01/MVP-02、事实核验与预算变更）。
- `.env` 已配置真实 `FEISHU_APP_ID/SECRET`、`OWNER_FEISHU_OPEN_ID`、`OPENCODE_API_KEY`；`FEISHU_EVENT_MODE=long_connection`。
- 重启本地服务后确认 `/healthz` 返回 ok，且长连接到飞书 443 为 ESTABLISHED。
- 不要在验收过程中修改数据库或注入 `pa_inbox` 行。

## 1. 直接状态查询（M02）

在飞书私聊发送：

```text
现在有哪些任务和提醒？
```

期望：

- 直接返回 owner-scope 快照，不创建 Worker；
- 任务计数、最近任务与 DB 一致；
- 提醒数量/时间与 `pa_schedules` 中 pending 行一致；
- 审计新增 `state.query`。

核对：

```sh
sqlite3 data/agent.sqlite "select status,count(*) from pa_tasks group by status;"
sqlite3 data/agent.sqlite "select id,due_at,timezone,status,text from pa_schedules order by due_at;"
sqlite3 data/agent.sqlite "select after_json from pa_audit where event='state.query' order by seq desc limit 1;"
```

## 2. 提醒创建与查询（M09 前置）

1. 发送：

```text
/remind 2026-11-21T02:00:00Z 验收提醒
```

2. 确认创建后发送：

```text
我有哪些提醒
```

期望：列表同时显示 `Asia/Shanghai` 本地时间与 UTC ISO 时间；到期后真实飞书收到提醒文本。

核对 `pa_outbox` 中提醒的 `status=accepted` 且 `platform_message_id` 非空。

## 3. 后台分析报告（M03 + 事实核验）

发送：

```text
创建后台任务：读取当前真实任务和提醒，完成后用三点总结。
```

期望：

- 任务 Mandate 含 `state` resource 与所需 state tools；
- completionCriteria 含 `verifier=state-read`、`requiredEvidenceKinds=["state_snapshot"]`、`requireStructuredClaims=true`；
- Worker 报告引用当前 snapshotHash，并给出 `stateClaims`；
- 报告中的计数/状态/提醒时间与快照一致；
- 最终飞书收到结果；缺少 claims 或冲突时任务进入 `needs_review`，不会假装成功。

核对：

```sh
sqlite3 data/agent.sqlite "select id,status,completion_criteria,mandate_json from pa_tasks order by created_at desc limit 1;"
sqlite3 data/agent.sqlite "select tool,status,evidence_json from pa_actions where task_id=(select id from pa_tasks order by created_at desc limit 1);"
sqlite3 data/agent.sqlite "select verification_json from pa_tasks order by created_at desc limit 1;"
```

## 4. 记忆与周期计划（M07/M10 前置）

- 发送 `记住 我的编辑器是 vim`，确认卡片后回复 `/确认 <id>`，再发送 `我记住了什么`。
- 发送 `每个工作日 09:00 总结 owner/name 的 PR`，检查草稿展示仓库、频率、时区、接收会话、截止日期；回复 `确认计划 <编号>` 后才激活。
- 激活无人值守计划前必须先完成 #7/#28 预算与安全门槛。

## 5. 证据记录

每次验收在 #41 记录：

| 字段 | 内容 |
| --- | --- |
| commit | 实际运行 commit |
| 环境 | E3（真实飞书私聊入站/出站） |
| 模型 | provider/model |
| trace | inbox/outbox/task id |
| 输入/期望 | 实际消息与预期结果 |
| 实际状态 | 任务/提醒/审计快照 |
| 外部证据 | `platform_message_id`、飞书截图/消息 |
| 成本/延迟 | 可观测部分；未知不编造 |

敏感信息脱敏；不提交密钥或个人聊天原文。全部 P0 真实通过后，才更新 M02/M03 与 #38/#39 的验收项。

## 6. 只读 GitHub 项目评估（L2-R E3）

前置：`.env` 配置 `GITHUB_ALLOWED_REPOS`、只读 PAT/OAuth（`repository.read`），并已绑定项目：

```sh
pa projects bind personal-agent yuanbaoerer/personal-agent --repo-id <real-id> \
  --branch main --credential-ref github:default \
  --plan-paths README.md,docs/24-github-project-management.md
```

1. 在飞书私聊发送（owner 只填 projectKey，不填 owner/repo）：

```text
检查 personal-agent 最新实施情况，对照项目规划、源码、PR 和 CI，指出三个主要工程缺口，关联已有 Issue，生成待办修改草稿。只读，不要实际修改 GitHub。
```

2. 期望：

- 回复先确认项目（`项目：personal-agent`），不猜仓库；
- `pa_tasks` 最新任务 `mandate.project=personal-agent`，`skills=["github.project-review"]`；
- `completion_criteria` 含真实 `repositoryId`/`repo`/`projectKey`；
- `pa_actions` 出现成功的 `github.read` typed reads（repo/ref/file/pull_files/checks/issues），每条有固定 SHA/Source URL；
- 任务最终 `succeeded` 且 `verification.verifier=project-review`；或 `needs_review` 并列出缺失证据；
- 飞书实际收到包含 finding 和待审核 Issue 草稿的结果消息；
- 全程零 GitHub 写请求。

3. 负例（同会话或 CLI）：错误 projectKey、未绑定仓库、撤销绑定、撤销凭据、PR head 漂移、截断文件。期望拒绝/`needs_review`，不生成虚假完成结论。

4. 核对：

```sh
sqlite3 data/agent.sqlite "select id,status,mandate_json,verification_json from pa_tasks order by created_at desc limit 1;"
sqlite3 data/agent.sqlite "select tool,status,args_json,evidence_json from pa_actions where task_id=(select id from pa_tasks order by created_at desc limit 1);"
sqlite3 data/agent.sqlite "select status,text from pa_outbox order by created_at desc limit 3;"
```

若 owner 未提供真实 GitHub 凭据或无法从真实飞书发送，记录 BLOCKED；不得用 mock/fake API 结果标记 E3。

## 7. 草稿审核（L2W-01，无写入）

真实只读评估完成后，owner 可通过 CLI 查看：

```sh
pa drafts list --status pending_approval
pa drafts show <draft-id>
pa drafts reject <draft-id> --yes
```

期望：列表/详情包含目标 repository/Issue、source task/revision、commit SHA、finding ids、beforeSummary、拟写入正文、payloadHash 与 expiresAt；`reject` 后状态为 `rejected`，再次 reject 返回冲突。此阶段不得出现任何 GitHub 写请求或写入成功声明。

## 8. 受控 Issue 写入（L2W-02，仅隔离测试仓库）

前置（owner 明确指定）：

- 隔离测试仓库（不是 `personal-agent` 业务仓库）。
- 独立 fine-grained PAT：仅该 repo、Metadata read + Issues write；配置 `GITHUB_ISSUE_WRITE_TOKEN`、`GITHUB_ISSUE_WRITE_REPOS=<owner/test-repo>`。
- ProjectBinding 的 `credentialRef` 仍是**只读**凭据；写入使用独立的 `GITHUB_ISSUE_WRITE_CREDENTIAL_REF`（默认 `github:issues`），不得与只读 ref 混用。
- 先完成只读评估并产生 `pending_approval` 草稿。

流程：

1. `/draft list` → `/draft show <id>`，核对仓库、目标 Issue、before/after、payloadHash。
2. `/draft approve <id> <payloadHash>`。
3. 期望：创建专用 write task；Action 参数与 payloadHash 绑定；GitHub 只收到一次 create/update/comment；写后 GET 核对 issue/comment id、URL、正文；返回结果含 URL；draft 状态 `approved`，write task `succeeded`。
4. 负例（隔离仓库）：重复 `/draft approve` 不重复 POST；`/draft reject` 零写；撤销 binding/credential 后批准零写；外部先改 Issue 后 update 暂停；模拟 429/timeout 先 reconcile。
5. 核对：

```sh
sqlite3 data/agent.sqlite "select id,status,payload_hash,write_task_id,write_action_id from pa_issue_drafts order by created_at desc limit 5;"
sqlite3 data/agent.sqlite "select id,tool,status,args_hash,external_ref,evidence_json from pa_actions where tool like 'github.issue.%' order by created_at desc limit 5;"
sqlite3 data/agent.sqlite "select event,after_json from pa_audit where event like 'issue_draft.%' or event like 'task.external_action%' order by seq desc limit 10;"
```

无 owner 写授权时记录 BLOCKED；不得把 Fake API/E1 结果标记为真实写入成功。

## 9. 新增 Conversational & Autonomous Planning 真实验收（C01–C12）

本 Runbook 原 M01–M14 不变。新增产品体验基线参见 [28 · MVP 自然对话与自主规划](28-conversational-planning-mvp.md) / [#92](https://github.com/yuanbaoerer/personal-agent/issues/92)。实现 #89–#91 **后**，在真实 Owner 飞书私聊、真实模型、受授权的 GitHub 只读项目上按下列最小顺序实测：

1. 发送普通聊天需求并追问至少 6 轮，核对上下文连续、没有意外 Task/Action（C01）。
2. 在部署 [#125](https://github.com/yuanbaoerer/personal-agent/pull/125) 对应修复后，使用没有预置任务的验收会话，不手工插入父任务。先普通聊天，再明确「先制定三步方案，不执行」；核对草稿可查询，修改一步并查询 PlanDiff，确认没有 Worker 或外部工具调用（#123 / C02–C03 的补充验收）。
3. 明确「按已批准方案在授权的 projectKey 只读执行」，记录 Plan→Step→Assignment→GitHub read→Receipt→Verifier。**同一次运行**三个步骤都须有可核验来源，第三步须形成最终报告且真实飞书已收件；记录零写入（C04/C11）。
4. 在第 2 步执行中询问“进展到哪步”；补充新限制并暂停/恢复，核对 inputSeq、planVersion、旧 Worker 输出不能推进新计划；模拟可恢复失败/429 并观察有限重规划或 needs_review（C05–C07）。
5. 关闭客户端、对处于安全状态的进程执行可控重启并核对 Plan/Step/Outbox，没有重复副作用；测试不授权、额度未知、跨 owner/project 的负例（C08–C10）。
6. 从入站开始记录总模型/工具次数、可取得的 token/费用、用户纠正、错误自动建任务、被核验证据数、最终收件及耗时（C12 / #7）。不可取得的用量及费用记为「未采集」，不等于零。

记录形式：commit SHA、Plan/Step/Task/Action/Receipt/Trace IDs、model/provider、输入与预期、actual/权限/budget、E1/E3/E4、用户真实飞书入站/出站消息 ID（脱敏）、PASS/FAIL/PARTIAL/BLOCKED。只有 Mock 或 Fake Runtime 的步骤**不能**标记真实 E3 通过。Owner 未明确授予写权限/付费无人值守时仅允许已授权只读测试。

**C12：按 Node Pi 会话取 token（本地只读）。** 使用[停机或安全检查点备份](17-data-lifecycle.md)，从同批 `agent.sqlite` 的 `pa_assignments.session_id` 找到本次各 Worker 的 Pi session；Router 的 ID 在 `pa_meta` 的 `router.session_id:<ownerId>:<conversationId>`。传 Pi 数字 ID，不传飞书会话 ID、Task ID 或凭据：

```sh
node scripts/session-usage.ts /path/to/backup/pi.sqlite 12 34
```

输出只含指定会话的计数。`observedTokens` 是可测回复的小计；`totalTokens` 仅在所选每个会话均非空、每条 assistant 记录都有正整数计量时给出。未知或零默认值不作零 token；`summary.cost: null` 表示没有账单。脚本不读取应用账单，也不把失败但没有 assistant 记录的请求算作零成本。Router 会话可能跨多轮复用：**不能把整段会话累计直接归到本次 Plan**。复用会话需留前后两个快照，确认期间无其他流量且新增记录均可测，才可取差；否则标未采集。工具回执、最终收件、耗时仍需独立留证。

### 9.1 已记录的真实证据（2026-11-22）

- E1：CX-01/PL-01/PL-02 的确定性测试与逐用例状态见 [2026-11-22 · Conversational & Autonomous Planning E1 record](acceptance/2026-11-22-conversational-planning-e1.md)。
- 2026-11-23：空会话草稿（#125）与步骤时限（#127）合并，全量 637 个确定性测试通过；未新增 E3/E4，C04/C11 仍为 PARTIAL，下一步仍是同一次只读运行中的最终报告与真实飞书收件。
- E3/E4：**C01–C03 已 PASS（E3）；C04/C11 PARTIAL**。2026-11-22 在合并后 main 上完成前置步骤与真实飞书 C01–C03；随后配置只读 GitHub、绑定 `personal-agent` 并执行 C04：Plan `e1ba272e` 的 A/B 两步均通过 `github-read`（file、issues、pulls，14 条结构化 claim），C 在 3 次尝试内未产出最终报告，plan paused；全程 23 个 `github.read` GET、0 POST。另修复 verifier 的 CJK 标点 URL 解析缺陷（PR #119）。C05–C10 仍待后续；C12 无真实成本数据；E4 未测。C06/C07 的代码接线已补：补充会生成新 active 版本与 PlanDiff，可重试的外部失败有一次自动恢复版本（`pa_plans.auto_replans`，schema 26），权限失败转 `needs_review`；但真实 Feishu 补充、429/head-drift E3 与进程重启 E4 仍需重跑并记录本节。证据见 [runbook execution](acceptance/2026-11-22-conversational-planning-runbook.md)。不得把 A/B 或 PARTIAL 记作 C04/C11 PASS 或完整 Pilot 通过；其余 E3/E4 不得据 E1 或 C01–C03 结果宣称 Pilot 通过。

## 10. 飞书配对 omp

按 [README 的本机配对步骤](../README.md#飞书使用本机-omp)准备一个干净的测试工作区，留下一个可复现的失败测试。不要使用生产凭据、业务库或待发布分支。此项检验交互式编程；不要求启用 GitHub 写权限。

| 步骤 | owner 操作 | 通过判据 |
| --- | --- | --- |
| 配对 | 终端核对工作目录和权限；在绑定的飞书私聊发送终端配对码。 | 回复显示预期工作区；错误码、群聊和非 owner 均不能提交工作。 |
| 改动与验证 | 指定失败测试，要求只修实现；核对飞书显示的工具、目录、命令，再允许该次检查。 | 独立检查文件差异；同一工作区的测试由失败变成通过；飞书收到实际工具进度和结论。不能把模型回复当测试日志。 |
| 追问 | 不重复文件名或问题背景，要求说明刚才的修复。 | 同一 omp 会话引用本轮修改，而非另开 Router Task 猜答案。 |
| 停止与撤权 | 在等待测试审批时 `/code stop`，再尝试旧审批号；本地断开连接，再从飞书发送普通文字。 | 旧审批不能启动测试；断线不转发、不重放，未确认的在途副作用按未知处理。`/code leave` 后恢复普通助手。 |

**本次本地证据（E2，非真实飞书交付）**：macOS Intel、Node 26.12.0、Bun 1.4.5、omp 19.1.1，模型 `opencode-go/deepseek-v4.1-flash`。临时工作区的 `sum(2,3)` 原返回 `-1`；合成飞书文本事件经 FeishuAdapter、owner ingress、Router 和真实 Unix socket 到达真实 omp。它读写 `sum.mjs`，收到针对 `node --test check.test.mjs` 的一次批准后执行测试，工具返回成功；独立运行该测试也从退出码 1 变为 0。下一轮无需重述即可答回前一轮的标记。结果进了本地 Outbox，未发送到真实飞书。Provider 费用未采集。

同一次隔离验收的第三轮在等待新的测试审批时收到 `/code stop`，随后用旧审批号不能完成该轮。Node 入口另以合成配置启动，`/healthz` 返回 200、Unix socket 权限 `0600`。Relay 和会话窗口的 16 个定向用例均通过，涵盖 owner/私聊隔离、超时/重复审批、重启不重放及编程文本不进入普通 Router 历史。

E3 需另记实际服务 SHA、去标识化的飞书入站和出站消息 ID、同一工作区的 diff 与测试结果；勿附配对码、审批号、私聊原文或密钥。本次按 owner 选择不启动真实飞书实例。
