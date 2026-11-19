# 15 · 实施进度与待决策事项

> 更新：2026-11-19。仅列需要主人/产品负责人决定的事项；工程可确定的内容仍直接实施。

## 1. 当前进度

| 项 | 状态 | 证据 |
| --- | --- | --- |
| PA-01～PA-09 核心闭环 | E1，部分 E2 | 262 个确定性测试；见各 Issue |
| PA-10 确认/项目记忆 | E1 | `e9aee02` + `4f9047a`；记忆 global/project 隔离、修订保留 project、Worker 注入 |
| PA-11 固定 40 场景目录 + JSON/Markdown 报告 | E1 | `evals/scenarios.ts`、`scripts/eval-report.ts`；37/40 确定性执行通过，3 条真实 pending |
| PA-11 真实模型 10×3、G1–G3 E3、7 天自用 | 未开始 | 需 D01–D04 决策与真实凭据 |
| PA-12 Docker 自托管 | E1 | `5c56462`；Dockerfile/Compose/preflight/健康检查；本地拉取阻塞，镜像构建/容器健康/E3/E4 pending |
| PA-13 扩展契约 | E1 部分 | `a6269b2`；Provider 配置校验、实验期 Tool/Runtime/Channel contract v1、ToolRegistry.describe；第二 Provider/入站 Channel pending |
| PA-14 数据资产 | E1 部分 | `7fe4f07`；备份 manifest v2、双库校验/恢复、agent JSON 导出；加密/保留/Pi 修复 pending |
| PA-15 开源治理 | E1 部分 | `7017ca4`；SECURITY/CONTRIBUTING/CHANGELOG/模板、工作树/history secret scan、许可清单；LICENSE/历史/visibility pending |
| 真实飞书验证修复 | 已提交 | `9f2e9a1` 裸 `ack`；`1ef8e81` 多行 slash 命令；短提醒投递通过 |
| GitHub OAuth | E1 已实现，当前未配置 | `c0cf4d5` + `b83ca96`；OAuth App start/callback/status/disconnect、浏览器 admin 登录、AES-GCM token、执行时 provider；真实 OAuth/G1 pending |
| PA-17 Client API / PA-18 CLI | E1 最小实现 | 待提交（2026-11-19）；`/api/v1`、device token/scope/revoke、幂等/修订/审批绑定、事件 cursor、`pa` CLI；远程 TLS/SSE 与 E3 pending |
| PA-19 TUI | E1 最小实现 | 待提交（2026-11-19）；任务/审批切换、取消/批准/拒绝二次确认、PTY smoke；平台终端与完整操作 pending |
| PA-12/PA-13 部分 | E1/pending | 见路线图 |

固定 40 场景分类为渠道 8、任务 10、权限 10、恢复 8、记忆 4。K01–K14 映射由 `evals/scenarios.ts` 维护；pending 不计入成功分母。报告命令：

```bash
npm run eval:report           # JSON + Markdown，37 条确定性执行
npm run eval:report:critical  # CI 关键集
```

## 2. 待决策事项（需要主人审核）

### D01 真实模型评测的 Provider、模型与预算

- 现状：默认 `opencode-go`；真实 10 个任务 ×3 次尚未运行。
- 需决定：使用 Direct OpenCode Go 还是 Magpie Gateway；固定模型/参数；单次与总预算上限；超限停止策略。
- 建议：固定一个模型，禁止评测中途切换；以 Magpie 配额/用量为准，达到预算即停止并保留失败样本。
- [ ] 已审核：________________

### D02 10 个代表任务清单

- 建议清单：
  1. GitHub 仓库只读摘要（含来源 URL）
  2. Issue 列表分类/优先级建议
  3. 单个 PR 只读审查摘要
  4. 生成 release notes 草稿
  5. 周期计划（工作日）GitHub 摘要
  6. 带项目记忆的任务（验证不串项目）
  7. 运行中补充输入后继续
  8. 危险写操作被拒绝/审批
  9. 工具超时/失败后的可解释失败
  10. 长任务重启恢复
- 需决定：是否采用以上 10 项、是否替换、每项的客观判据与样例数据。
- [ ] 已审核：________________

### D03 真实 E3 环境与 7 天自用

- 需决定：是否授权使用真实飞书应用、GitHub token/仓库、Cloudflare 部署和本地 Node 入口；7 天自用从哪天开始；允许的外部副作用范围（建议只读 + 明确审批的测试 Issue）。
- 建议：测试仓库单独创建；只读 token 为主；写操作只对测试 Issue，且每次审批。
- [ ] 已审核：________________

### D04 真实模型成功判定与人审

- 需决定：10×3 的通过阈值（docs/08 目标 ≥85%）、由谁按什么 rubric 判定、是否允许独立 evaluator、争议如何记录。
- 建议：外部/人审判据优先，LLM 自述和合法 JSON 不算成功；逐次报告，失败不剔除。
- [ ] 已审核：________________

### D05 报告与数据保留

- 需决定：`evals/reports/` 是否只保留在 CI artifact，还是提交摘要；保留多久；真实模型原始输入/输出是否脱敏后入库。
- 建议：原始报告不入库，仅提交不含敏感内容的摘要与复现命令；CI 保留 30 天。
- [ ] 已审核：________________

### D06 发布阻断

- 需决定：是否确认“任何真实越权外部写或 K13/K14 关键恢复失败阻断 v0.3”为硬门槛。
- 建议：确认阻断；pending 不能当通过；真实权限失败不得用 mock 成功抵消。
- [ ] 已审核：________________

### D07 标准飞书接入方式

- 现状：Node 支持 webhook 与 long_connection；Docker 默认示例建议 long_connection。
- 需决定：标准 Quickstart 是否只承诺 long_connection（无需公网入口），还是把 webhook + TLS 反向代理作为生产默认。
- 建议：v0.3 先承诺 long_connection；webhook 作为需要自有 TLS 的可选部署，不宣称开箱即用。
- [ ] 已审核：________________

### D08 镜像发布与架构

- 需决定：是否发布到 ghcr/Docker Hub、支持 linux/amd64 与 arm64 的优先级、镜像标签/保留策略。
- 建议：先本地构建；amd64 取得 E3 证据后再发布，arm64 验证前不承诺。
- [ ] 已审核：________________

### D09 ADR-0001 是否定稿

- 现状：Node + SQLite 为 provisional 默认；真实 E3/E4 未齐。
- 需决定：是否在真实飞书 E3 与 SIGKILL/恢复证据前把 ADR 改为 Accepted，或继续保持 provisional。
- 建议：保持 provisional，直到 D03 的真实 E3/E4 证据完成；Docker 启动成功不能替代。
- [ ] 已审核：________________

### D10 第二个真实 Provider

- 现状：只注册 `opencode-go`；`MODEL_PROVIDER` 可配置但未知值拒绝。
- 需决定：第二 Provider 选型（OpenAI 兼容/其他）、凭据与模型、是否允许评测期切换。
- 建议：先不扩第二 Provider；等 D01 真实模型预算确定后，用同一契约集验证一次，再决定是否进入默认配置。
- [ ] 已审核：________________

### D11 扩展 API 稳定性

- 现状：Tool/Runtime/Channel `CONTRACT_VERSION=1`，但未有第三方实现。
- 需决定：现在承诺 v1 稳定，还是标记 experimental 直到至少一个外部只读工具/Channel 实现通过。
- 建议：保持 experimental（文档已标注 E1），不改版本号；出现第二个实现后再宣布 v1 兼容承诺。
- [ ] 已审核：________________

### D12 通用入站 ChannelAdapter

- 现状：出站 `ChannelAdapter` 已抽象；入站仍是飞书专用解析/验签。
- 需决定：是否为 CLI/第二 IM 立即抽取通用入站事件契约，还是先以飞书参考实现交付。
- 建议：先交付飞书；CLI 走本地 Intent 入口，不强行抽象事件协议；第二 IM 时再抽取并加契约测试。
- [ ] 已审核：________________

### D13 备份加密、保留期与调度

- 现状：备份为明文 700/600，需手动执行；无自动保留/异地副本。
- 需决定：是否加密备份、保留多少份/多少天、多久执行一次、是否异地存储；密钥由谁保管。
- 建议：先手动 + 30 天保留测试；加密和自动调度等真实使用稳定后再启用，避免密钥丢失导致不可恢复。
- [ ] 已审核：________________

### D14 删除/导出范围与 Pi/Provider 数据

- 现状：`forget` 是软删除；JSON 导出不含 Pi 会话；Provider 侧数据不可控。
- 需决定：个人记忆/历史对话/审计的保留与永久清除范围；是否提供 Pi 会话导出；如何向用户说明第三方 Provider 不受本应用删除控制。
- 建议：文档明确软删除与备份副本边界；提供导出但默认不含 Pi；不承诺远程删除 Provider 数据。
- [ ] 已审核：________________

### D15 schema 升级策略

- 现状：启动时自动迁移；恢复拒绝较新 schema；迁移事务回滚，但无自动 pre-upgrade 备份。
- 需决定：生产是否要求显式 `upgrade` 命令并在迁移前强制备份，还是允许启动自动迁移。
- 建议：v0.4 自托管默认在文档中要求先备份再启动；保留启动自动迁移，增加升级前 preflight/备份步骤。
- [ ] 已审核：________________

### D16 项目许可证

- 现状：无 LICENSE；直接运行时依赖为 MIT；未做完整传递依赖/第三方片段审计。
- 需决定：MIT / Apache-2.0 / AGPL-3.0 或其他；是否允许商业托管；贡献者许可方式。
- 建议：Apache-2.0 或 MIT（均与当前直接 MIT 依赖兼容），先完成传递依赖审计再声明；在 LICENSE 前不合并第三方源码。
- [ ] 已审核：________________

### D17 历史个人标识处理

- 现状：当前工作树已脱敏；2 个历史提交仍含真实 Feishu owner/message ID，未发现 app secret/token。
- 需决定：公开前是否重写历史；是否通知相关方；是否需要额外轮换凭据。
- 建议：公开前用 `git filter-repo` 仅替换个人 ID 并备份原历史；不强制 force-push 现有协作者（当前单 owner）。
- [ ] 已审核：________________

### D18 仓库可见性与发布

- 现状：private；PA-15 明确不自动改 visibility。
- 需决定：何时/由谁将仓库改为 public；是否先发布 private beta；main 分支保护/CODEOWNERS 要求。
- 建议：在所有 D01–D17 关键项和真实 E3/E4 完成后，由仓库所有者手动执行；CI 永不修改 visibility。
- [ ] 已审核：________________

### D19 Worker 读取任务/提醒状态的权限

- 实测问题：任务“用三点总结当前任务和提醒状态”拿到 `tools: []`，Worker 无法读取真实提醒，仍以 structural verifier 标记 succeeded；实际提醒存在。
- 需决定：新增内置只读 `state.summary`/`reminder.list` 工具并自动批准，还是每次读取都走审批，或不允许 Worker 读取状态并强制 `needs_review`。
- 建议：新增 owner-scope 只读工具，自动批准但不允许写；增加 `state-read` verifier，要求 succeeded Action 和状态快照；任务结果必须引用快照。先以 owner-only 自托管验证，不扩大资源。
- [ ] 已审核：________________

### D20 是否先修语义再进入 PA-16

- 现状：真实 Feishu/模型/提醒链路可用；任务内容可完成但状态类任务可能未读取真实数据。
- 需决定：是先实现 D19 并重跑真实任务，还是接受已知限制直接进入 PA-16 安装/发布候选。
- 建议：先完成 D19 与一次真实复测，再进入 PA-16；否则发布候选会带着已验证的语义缺口。
- [ ] 已审核：________________

### D21 GitHub 授权模型（已选择：个人开发者 OAuth App）

- 2026-11-19 主人决定：先以个人开发者为主，支持 GitHub OAuth。
- 已实现 E1：单 owner OAuth App web flow、浏览器 admin 登录页、一次性 state、AES-256-GCM 加密 token、执行时 token provider；白名单继续强制。Worker 仍使用 PAT，GitHub App/多用户绑定未实现。
- 仍需验收：真实 OAuth App 凭据、回调、撤销和 G1。私有仓库细粒度只读后续用 GitHub App 解决；OAuth `repo` scope 较宽，应用只发 GET。
- [x] 已审核：个人开发者 OAuth App

### D22 OAuth App 配置向导

- 现状：浏览器可以完成 admin 登录和 GitHub 授权，但 OAuth App 的 client id/secret 与加密 key 仍需一次性写入 env。
- 需决定：保留 env 配置，还是做 setup 网页把 client id/secret 加密存入 DB（需要 bootstrap key/文件、权限与轮换设计）。
- 建议：v0.3 保留 env（最简单、密钥不落仓库）；若面向非技术个人用户，再做受 admin 保护的 setup 向导，并明确密钥备份/恢复。
- [ ] 已审核：________________

### D23 TUI 优先级与交付顺序

- 已实施：PA-17 最小 Client API/SDK + PA-18 `pa` CLI + PA-19 最小 `pa tui`；TUI 复用 Client API，不直接访问 SQLite。
- 仍待决定：是否把 TUI 完整版（修订/提醒编辑、SSE/WS、多设备）提前到 PA-16 发布候选之前；这会扩大跨平台验收范围并推迟自托管发布。
- 建议：先以 CLI/TUI 最小版做本地验证；PA-19 完整验收和 Windows/macOS 终端证据另列，不把它们当作 Client API 的阻塞项。
- [ ] 已审核：________________

## 3. 决策后的实施顺序

1. 按 D01/D02 运行 10×3，生成逐次报告。
2. 按 D03 执行 G1–G3 E3 与 7 天自用。
3. 按 D04 完成人审/外部判据。
4. 更新 `docs/08` 发布门槛与 `evals` 报告，再决定 v0.3 是否可发布。
