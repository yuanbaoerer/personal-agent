# Pi Durable smoke spike

验证四件事：

1. Pi Durable 能把 transcript 落到 SQLite；
2. 工具调用会经过 `beforeTool` hook；
3. hook 能在副作用发生前阻断，模型收到结构化 error result；
4. 关闭并重新打开同一个 SQLite 文件后，root session 与 entries 仍在。

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
- `beforeTool` 的 `block` 是“阻断 + 错误结果”，不是“暂停后恢复执行”。真正的审批需要 `pending_action` + signed token + host executor（见 `docs/02-architecture.md`）。
- 没有测试真实模型的工具调用；faux provider 是脚本化响应。
