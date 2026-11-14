# ADR-0001 · 标准部署环境与 Runtime 选择（方向已定，结论待证据）

- 日期：2026-11-14
- 状态：**Accepted (provisional)** — 方向 A（Node + SQLite 为默认自托管路径），定稿条件见文末“定稿门槛”。这不是“已完成”声明：Node 路径的端到端与恢复证据尚未齐备。
- 决策范围：v0.2 单用户 Personal Agent 的**唯一默认部署路径**

## 已记录的方向（2026-11-14）

1. **默认路径选 A（Node + SQLite）**，Cloudflare DO 保留为实验/可选模式，代码继续可构建、可部署，但不作为默认安装说明，也不再同时推进两条业务实现。
2. **只改适配层，不改业务逻辑**：`apps/agent/src/app.ts` 是唯一组合根，`main.ts` 与 `infra/src/worker.ts` 只注入 `Store`、`AgentRuntime`、`WakeScheduler`、`RouterModel`、`ReminderTimer`。运行差异被限制在这些接缝上。
3. **Pi 与 `pa_*` 分库**：`PA` 状态在 `DATABASE_PATH`（默认 `./data/agent.sqlite`），Pi 在 `PI_DATABASE_PATH`（默认 `./data/pi.sqlite`）。理由：Pi 通过 `openNodeSqliteStorage` 持有自己的连接，`node:sqlite` 单写者，共用一个文件会引入 `SQLITE_BUSY` 竞态。代价是备份必须成对，见 PA-14。
4. **Node 侧模型运行时已落地**：`apps/agent/src/runtime/node-pi.ts` 用 `Harness.open` + `openNodeSqliteStorage` 实现 `AgentRuntime`，`operationId` 直接作为 Pi 的 `requestId`，因此重复提交与重启后重连都不会二次提交（K03）。当前只有 faux provider 的确定性证据（E1），真实模型与 SIGKILL 证据仍待 PA-01/PA-04。
5. **唤醒机制**：Node 没有 alarm。Pi 通过 `onWake` 交回下次需要运行的时间，进程用一个 timer 调 `resume()`；进程崩溃后由同一文件的 `Harness.open` 恢复未完成任务。

## 定稿门槛（满足其一才把状态改为 Accepted）

- A：在 Node 上取得真实飞书 p2p → Router → Worker → Outbox → 回复的 E3 证据，加 SIGKILL 后未完成任务被明确恢复或可靠失败的 E4 证据。
- B：若 A 在 PA-04 之前无法达标，改为 B 并记录失败点；不得以“已部署过”代替证据。

两条路都不得新增业务分支；差异只允许出现在 `app.ts` 的注入项。

## 背景

当前 Node 启动入口可以通过飞书长连接真实收发消息、持久化 Inbox/Outbox。方向记录后，apps/agent/src/main.ts 在配置 OPENCODE_API_KEY 时使用 apps/agent/src/runtime/node-pi.ts（pi-durable + node:sqlite），未配置时退回 LocalRuntime 占位并显式失败；真实模型端到端与崩溃恢复证据尚未取得。
Cloudflare Worker + DO 的 infra/src/worker.ts 已有真实 PiRuntime、任务编排及模型请求，部署成功；然而飞书正式云端回调入口与对象驱逐恢复缺少闭环证据。
如果将两条分别未完成的链路都宣传为产品“可用”，会增加用户排障和开源贡献成本。

## 候选方案

A. Node + SQLite 作为标准自托管部署，Cloudflare 保留实验性/可选模式。
- 优点：飞书长连接、普通服务器和 Docker 的安装路径更直接；开源复用依赖较少。
- 风险：必须接通真实 Pi Runtime；进程崩溃、长任务恢复、持久定时器和备份都要有独立证据。

B. Cloudflare DO 作为标准运行路径，Node 仅为渠道桥接或开发工具。
- 优点：已有真实 PiHarness 与 Lifecycle 接入；DO SQLite 和 alarm 体系可复用。
- 风险：飞书云端入口受阻；本地长连接需要桥接/中继；对象驱逐和凭据故障恢复未验证；部署依赖平台。

## 技术 Spike：PA-01

不得仅凭理论选择。用相同最小用例和相同验收标准验证：
1. 真实飞书主人私聊消息 → persist Inbox → model-backed Router → 独立 Worker → Outbox → 飞书回复。
2. 重复事件、重复 Runtime submit operationId、恢复到同一任务状态。
3. 两 Worker 长任务期间 status/cancel 的持久受理延迟。
4. 运行中 SIGKILL / DO 驱逐等环境适用的故障注入：至少证明未完成任务被明确恢复或可靠失败，无静默丢失。
5. 配置复杂度、安装阻塞、真实模型成本与日志可追踪性。
6. 记录模型、SDK 锁定版本、运行环境、commit 与命令；不要使用 mock 结果替代真实验证。

## 决策门槛

- 若 A 的 Pi 持久 Runtime 语义和上述端到端检查通过，选 A 为 v0.2 默认自托管，B 保留实验模式。
- 若 A 的 Runtime 兼容/恢复短期无法达标，而 B 能打通飞书和恢复，则选 B，Node 只承担必要的边缘适配。
- 若两者均未达标，暂停扩展产品功能，明确阻塞项，不在 README 中宣称完整 Personal Agent 已可长期运行。
- 不允许长期维护两套业务逻辑：提取统一 Composition Root，差异只限 Runtime、Db、Scheduler、Channel 等适配层。
- 最终定稿需附 ADR 状态变更、测试数据、失败记录与所选方案，不能仅勾选“已部署”。

## 非目标

本 ADR 不决定开发通用 Agent 框架、多个聊天渠道、向量记忆或多模型路由；不在未验证备份/恢复之前承诺生产级持久化。

## 相关文档

- docs/07-long-term-roadmap.md
- docs/08-evaluation.md
- docs/09-open-source-plan.md
- docs/04-build-plan.md
- infra/README.md
