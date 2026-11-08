# Pi Durable smoke spike

验证四件事：

1. Pi Durable 能把 transcript 落到 SQLite；
2. 工具调用会经过 `beforeTool` hook；
3. hook 能在副作用发生前阻断，模型收到结构化 error result；
4. 在任务结束后正常关闭运行时，再打开同一个 SQLite 文件时，root session 与 entries 仍在；
5. 子进程在提交会话后被 `SIGKILL`，重新打开同一数据库仍能恢复同一 root；
6. 同一 Harness 中一个 Router 与两个 Worker 使用独立 session；Worker A 阻塞在工具时，Router 仍能回复、Worker B 仍能完成，三份 context 不串输入；
7. 通过本地 `OPENCODE_API_KEY` 调用真实 `opencode-go/deepseek-v4.1-flash`；
8. 用真实模型并发运行 Router + 两个 Worker，三者都完成且答案互不串扰。

脚本已对上述性质逐项断言。它仍不是完整应用；当前方向见 [产品规划](../../docs/00-product-plan.md)。

## 运行

```bash
cd spikes/pi-durable-smoke
npm install
npm run smoke
npm run kill
npm run multi
npm run real
npm run real:multi
```

环境：Node 26.12.0、`@earendil-works/pi-durable@1.5.0`、faux provider（不需要 API key）。

## 实测输出（2026-11-04）

`npm run smoke`：

```json
{
  "dir": "/var/folders/.../pa-pi-durable-...",
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

`npm run kill`：

```json
{
  "dbPath": "/var/folders/.../pa-pi-kill-.../agent.sqlite",
  "killedWith": "SIGKILL",
  "rootId": 1,
  "entryCount": 2,
  "reopenedSameRoot": true
}
```

`npm run multi`（faux provider，单进程、单 Harness）：

```json
{
  "conversationIds": {
    "router": 1,
    "workerA": 7,
    "workerB": 13
  },
  "concurrency": {
    "routerAnsweredWhileWorkerABusy": true,
    "workerBFinishedWhileWorkerABusy": true,
    "workerASettledAfterRelease": true
  },
  "contexts": {
    "router": ["router input", "router reply"],
    "workerA": ["worker A input", "hold released", "worker A reply"],
    "workerB": ["worker B input", "worker B reply"]
  }
}
```

脚本断言：三个会话 ID 不同；Worker A 在工具中阻塞时，Router 与 Worker B 均已完成；三份 context 只包含各自输入与回复。

`npm run real`（真实模型，读取仓库根目录 `.env` 的 `OPENCODE_API_KEY`）：

```json
{
  "provider": "opencode-go",
  "modelId": "deepseek-v4.1-flash",
  "status": "done",
  "text": "PA_REAL_MODEL_OK",
  "elapsedMs": 5426,
  "entryCount": 2
}
```

`npm run real:multi`（真实模型并发三个会话）：

```json
{
  "provider": "opencode-go",
  "modelId": "deepseek-v4.1-flash",
  "elapsedMs": 6938,
  "statuses": {
    "router": "done",
    "workerA": "done",
    "workerB": "done"
  },
  "answers": {
    "router": "ROUTER_REAL_OK",
    "workerA": "WORKER_A_REAL_OK",
    "workerB": "WORKER_B_REAL_OK"
  }
}
```

两个真实模型脚本都断言各自 context 不含其他会话的输入或答案。`.env` 不入库；OpenCode Go key 来自当前 omp 登录，换账号或轮换密钥后需要更新。

## 这个 spike 没有证明什么

- 没有验证 Cloudflare `PiHarness` 的真实部署（需要账号/凭据）；只验证了 Pi Durable 本地语义。
- `beforeTool` 的 `block` 是“阻断 + 错误结果”，不是“暂停后恢复执行”。真正的审批需要持久动作、经验证的主人决定与宿主执行器，具体权限校验见[架构文档](../../docs/02-architecture.md)。
- 没有测试真实模型的工具调用；faux provider 是脚本化响应。
- `kill` 只验证已提交 transcript 在独立进程被杀后的持久性；没有验证未完成任务、待审批状态、多 Worker 和聊天消息恢复。
- `multi` 使用 faux provider、单进程与单 Harness；验证的是 Pi 会话隔离/并发语义，不是 Cloudflare DO 的 alarm、跨进程并发、真实模型请求或平台保证。
- `real` / `real:multi` 使用个人 OpenCode Go key，不是 CI 用例；没有验证费用上限、限流、模型波动或 Cloudflare DO。
- 脚本只覆盖本地 SQLite；不能把局部通过推广为 Cloudflare/DO 的平台保证。

下一轮技术门槛补真实飞书、Cloudflare DO 上的真实模型多会话，以及未完成任务/待审批状态在运行中断后的恢复；验收规则见 [构建计划](../../docs/04-build-plan.md)。
