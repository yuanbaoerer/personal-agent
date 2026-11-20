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
