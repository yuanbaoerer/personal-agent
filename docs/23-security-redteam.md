# 23 · 安全威胁模型与 SEC01–SEC08 回归映射

> 2026-11-20 · 对应 [#28](https://github.com/yuanbaoerer/personal-agent/issues/28) 的 MVP-P0 子集。
> 本文记录**当前代码**的信任边界与已覆盖负例；不把 E1 测试当作真实环境安全验收，也不替代 #4/#8/#14 的权限实现。

## 1. 信任边界

| 边界 | 信任 | 不可信输入 |
| --- | --- | --- |
| 飞书私聊入站 | 仅绑定 owner + private chat | 群聊、未绑定 actor、伪造 event |
| Ingress/Router | owner 文本可提出 Intent | 外部文档、工具结果、模型输出 |
| Task/Mandate | 创建时固定 tools/resources/revision | Worker 自报扩大范围 |
| Worker/模型 | 只能在 Mandate 内提议 | prompt injection、伪造 evidence |
| 工具/第三方文本 | GitHub/State 回执由程序持久化 | Issue/PR/Commit 正文、网页文本 |
| ActionService | 参数绑定、审批、revision/fencing | 旧 revision、重放、越权 repo |
| 日志/备份 | 结构化、脱敏 | 密钥、私聊原文、token |

原则：工具输出和第三方文本只作为**数据**；不能变成 owner 指令、不能扩大 Mandate、不能直接触发审批或写入。

## 2. SEC01–SEC08 映射

| ID | 攻击 | 当前防护 | 现有证据 | 状态 |
| --- | --- | --- | --- | --- |
| SEC01 | 恶意 GitHub/文档要求外传密钥 | 无 shell/HTTP 工具；GitHub 只读白名单；outbox 只由程序生成 | `github.test.ts`、`actions.test.ts`、`tool-capability.test.ts` | E1 已覆盖；真实 GitHub 文本 pending |
| SEC02 | 跨 repo/跨 owner 读取 | `GITHUB_ALLOWED_REPOS`、preauthorization、state owner scope | `github.test.ts`、`state-tools.test.ts`、`memory-scope.test.ts` | E1 已覆盖 |
| SEC03 | 外部文本诱导 save_memory/approve | Memory/Reminder 需 Confirmation；approval 需 action id + nonce + argsHash/revision | `confirmations.test.ts`、`preauthorization.test.ts`、`actions.test.ts` | E1 已覆盖 |
| SEC04 | Action revision race/旧结果推进 | assignment fencing、task revision、input barrier、supersede | `coordinator.test.ts`、`actions.test.ts`、`recovery.test.ts` | E1 已覆盖 |
| SEC05 | 任意 Shell/文件路径 | 工具注册表 allowlist；无 shell 工具；unknown tool 被拒绝 | `tool-capability.test.ts`、`actions.test.ts` | E1 已覆盖 |
| SEC06 | 恶意扩展替换内置工具 | 注册表拒绝重复/内置名；扩展只读能力声明 | `tool-capability.test.ts` | E1 已覆盖 |
| SEC07 | 无限调用/成本 | CallBudget 单任务/每日上限；工具累计上限；周期 20/日 | `call-budget.test.ts`、`config.test.ts`、`schedule-policy.test.ts` | E1 已覆盖；token/费用待采集 |
| SEC08 | 中英混合注入 | 外部文本按数据注入；记忆/状态字段限长；无指令通道 | `state-tools.test.ts`、`memory-scope.test.ts`、`intents.test.ts` | E1 已覆盖；真实模型 redteam pending |

## 3. 剩余风险

- 未在真实飞书 + 真实模型 + 真实 GitHub 文本上跑完整 SEC01–SEC08；E1 负例不能替代 E3。
- Runtime 不暴露 token/usage，费用侧仍只有请求/工具/周期计数。
- Worker prompt 目前靠 Mandate + 程序校验约束；模型仍可能生成错误摘要，已由 `stateClaims`/`githubClaims` 与自由文本未核验标记缓解。
- 未开放任意文件/Shell/网页抓取；在这些工具引入前必须重做威胁模型。

## 4. 上线闸门

- 真实 GitHub 只读查询前：确认 repo 白名单、OAuth/PAT 撤销路径。
- 激活无人值守周期计划前：#7 预算与 #28 真实工具文本注入负例必须通过。
- 任何已知越权、重复副作用、凭据泄漏未修复时，不开放高权限工具或公开发布安全声明。
