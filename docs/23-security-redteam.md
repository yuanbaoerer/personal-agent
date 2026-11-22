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
| SEC08 | 中英混合注入 | 外部文本按数据注入；记忆/状态字段限长；无指令通道 | `state-tools.test.ts`（含 mixed-language 注入）、`memory-scope.test.ts`、`intents.test.ts` | E1 已覆盖；真实模型 redteam pending |

## 3. 剩余风险

- 未在真实飞书 + 真实模型 + 真实 GitHub 文本上跑完整 SEC01–SEC08；E1 负例不能替代 E3。
- Runtime 不暴露 token/usage，费用侧仍只有请求/工具/周期计数。
- Worker prompt 目前靠 Mandate + 程序校验约束；模型仍可能生成错误摘要，已由 `stateClaims`/`githubClaims` 与自由文本未核验标记缓解。
- 未开放任意文件/Shell/网页抓取；在这些工具引入前必须重做威胁模型。

## 4. 上线闸门

- 真实 GitHub 只读查询前：确认 repo 白名单、OAuth/PAT 撤销路径。
- 激活无人值守周期计划前：#7 预算与 #28 真实工具文本注入负例必须通过。
- 任何已知越权、重复副作用、凭据泄漏未修复时，不开放高权限工具或公开发布安全声明。

## 5. 2026-11-22 凭据作用域与项目解析补强

- `pa_credential_refs` 只存 ref/owner/plugin/account/repositoryIds/scopes/status/version/expiry，不存 token。
- 未声明 scopes 的凭据不获得任何 scope；`github:default` 必须显式声明 `repository.read`，`issues.write` 必须由独立 write ref 显式声明。
- 项目读取同时校验 owner、immutable repositoryId 与 active ProjectBinding；撤销/重启不会复活 OAuth 凭据。
- Router 不再让模型补猜仓库：projectKey 必须解析到 owner 的 active binding，歧义或未绑定直接拒绝并提示 owner。
- 现有 E1 覆盖 `credentials.test.ts`、`projects.test.ts`、`github.test.ts`、`router.test.ts`、`completion-verifier.test.ts`；真实 OAuth/PAT 负例仍需 owner 环境。

## 6. 2026-11-22 Issue 写入与审批边界

- **写入口**：只有 `github.issue.create/update/comment` typed Action；无 merge/push/delete/settings/branch-protection/MCP 写。只读 PAT/OAuth 不会被复用为写 token；写入需要独立 ref、`repository.read + issues.write` scope、owner/repoId/write allowlist/plugin generation/revision fence。
- **审批来源**：ActionService 拒绝 Worker 直接提出的 `github.issue.*`；执行 guard 要求 `sourceKey` 以 `draft:` 开头。即使伪造审批卡，非 DraftSnapshot 来源的写 Action 也无法执行。
- **载荷绑定**：批准绑定 `payloadHash`、draft id、target、commit SHA、credential epoch；批准前重新读取 default branch ref，仓库已前进则旧草稿 superseded。`beforeHash` 覆盖 title+body。
- **写前/写后**：update 写前 GET 并比较 beforeHash，人工修改立即暂停；拒绝 PR-as-issue；create/comment marker 幂等；写后 GET 核对 id/URL/正文；超时/未知先 reconcile，不重复 POST；重启后从 action 状态重新 settle。
- **残余风险**：GitHub 不提供原子 CAS，写后核对只能缩小而非消除人类并发窗口；真实 OAuth 撤销/切账号、真实 Feishu E3、真实隔离仓库写入仍未执行；PAT provider 刷新不会自动 bump epoch（权限变化必须显式 rotate）。
- **E1**：500 tests passed；包含 origin fence、plugin disable、credential revoke/rotate、revision drift、429、lost POST、人工并发修改、restart reconcile。
