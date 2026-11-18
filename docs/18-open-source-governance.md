# 18 · 开源治理、安全与公开前检查

> 状态：PA-15 的确定性部分 E1。仓库仍为 private；本文件不改变可见性。

## 1. 已落地

| 项 | 文件/命令 |
| --- | --- |
| 漏洞报告与支持范围 | `SECURITY.md` |
| 贡献流程（当前不接收第三方源码，许可证未定） | `CONTRIBUTING.md` |
| Issue/PR 模板 | `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md` |
| 变更与版本说明 | `CHANGELOG.md` |
| 直接依赖许可清单 | `THIRD_PARTY_NOTICES.md` |
| 工作树秘密扫描 | `npm run scan:secrets`；CI 强制执行 |
| 历史扫描 | `npm run scan:secrets:history`；不打印匹配值 |

直接运行时依赖在当前锁定版本均为 MIT；这不是完整传递依赖审计，也不等于项目已选择许可证。

## 2. 机密与历史扫描结果（2026-11-18）

- 当前跟踪工作树 + 未忽略的新文件：**0 findings**。
- 历史扫描：脱敏前 2 个提交引入真实 Feishu owner open_id / message_id（当前 HEAD 文档已替换为 `<redacted-...>`）；`git log -G` 也会计入本次脱敏提交。未检测到 Feishu app secret、OpenCode/GitHub token、fine-grained PAT 或私钥。
- 历史提交仍含这些个人标识；是否重写历史、如何通知/轮换由 D17 决定。当前仓库 private，未公开。
- 扫描器只输出规则、文件/行或提交号，不输出匹配内容；测试使用拼接字符串避免把样本密钥写入仓库。

## 3. 权限与日志复核

- `/admin/*`、`/ask` 需要 Worker admin token；webhook 验签、owner 绑定、群聊/app sender 拒绝由确定性测试覆盖。
- K09/K14：错误审批人/会话/参数/过期、重复审批、任务结束/修订/取消后执行前重核；见 `actions.test.ts`、`contracts.test.ts`、`coordinator.test.ts`。
- Router 不记录模型输出；日志错误只记录消息，不记录 prompt/secret。部署日志仍可能含平台错误码/ID，公开报告需脱敏。
- CI `permissions: contents: read`；不自动修改仓库 visibility，不向外部上传源码。

## 4. 版本与维护政策

- 现状：`0.1.0` 是内部开发标记，不是稳定版本；无兼容性承诺，仅支持 `main`。
- 稳定版采用 SemVer；破坏性变更需在 `CHANGELOG.md` 说明，并提供迁移/回滚说明。
- 维护范围：单 owner 项目，无 SLA；安全报告尽力私下响应，不承诺时限。
- 依赖更新：锁定版本；升级需跑确定性测试、eval report、Docker/Worker 构建；安全更新优先但不静默破坏 schema。

## 5. 公开发布清单（未签收）

- [ ] D16 选择 LICENSE，确认直接/传递依赖与第三方片段兼容。
- [ ] D17 决定历史重写/个人标识处理与必要的凭据轮换。
- [ ] D18 仓库所有者显式决定 visibility；CI/脚本不得自动执行。
- [ ] 完成真实 E3/E4 与可复现安装（PA-11/PA-12）。
- [ ] 英文 Quickstart、`SECURITY.md`、`CONTRIBUTING.md`、issue/PR 模板可读。
- [ ] 全历史 secret scan 复测无未处理高风险项。
- [ ] 发布签名/来源/SBOM 与版本 tag（PA-27）另行完成。

## 6. 未完成

许可证选择与法律审查、传递依赖许可审计、历史重写、仓库公开、GitHub main 分支保护/CODEOWNERS、定期依赖扫描、SBOM/签名、英文文档与对外安全响应流程。
