# Pi Durable smoke spike

验证四件事：

1. Pi Durable 能把 transcript 落到 SQLite；
2. 工具调用会经过 `beforeTool` hook；
3. hook 能在副作用发生前阻断，模型收到结构化 error result；
4. 在任务结束后正常关闭运行时，再打开同一个 SQLite 文件时，root session 与 entries 仍在。

这是历史可行性脚本，不是完整应用或运行中崩溃恢复测试。本轮规划整理没有重跑它；当前方向见 [产品规划](../../docs/00-product-plan.md)。

## 运行

```bash
cd spikes/pi-durable-smoke
npm install
npm run smoke
```

环境：Node 26.12.0、`@earendil-works/pi-durable@1.5.0`、faux provider（不需要 API key）。

## 实测输出（2026-11-04）

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

## 这个 spike 没有证明什么

- 没有验证 Cloudflare `PiHarness` 的真实部署（需要账号/凭据）；只验证了 Pi Durable 本地语义。
- `beforeTool` 的 `block` 是“阻断 + 错误结果”，不是“暂停后恢复执行”。真正的审批需要持久动作、经验证的主人决定与宿主执行器，具体权限校验见[架构文档](../../docs/02-architecture.md)。
- 没有测试真实模型的工具调用；faux provider 是脚本化响应。
- 没有执行独立进程 kill/restart，也没有证明未完成任务、多 Worker 和聊天消息恢复。
- 脚本主要打印 executed、entryCount、sameRoot 等字段，尚未逐项断言；不能只凭退出码判断全部性质通过。

下一轮技术门槛补真实渠道/模型、多会话、运行中故障注入和状态断言；验收规则见 [构建计划](../../docs/04-build-plan.md)。
