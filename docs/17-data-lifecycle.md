# 17 · 备份、导出、恢复与删除

> 状态：PA-14 的确定性部分 E1。覆盖 agent.sqlite 与 pi.sqlite 的一致性备份、完整性校验、空目录恢复、JSON 导出和 manifest 元数据。真实故障注入、加密/保留策略、Pi/Provider 第三方数据删除仍未完成。

## 1. 备份

```bash
npm run backup -- --data ./data --out ./backups/2026-11-18
```

- 使用 `VACUUM INTO` 生成 agent.sqlite 与 pi.sqlite 的一致副本；复制后执行 `PRAGMA integrity_check`。
- manifest v2 记录 SHA-256、字节数、schema_version、appVersion、commitSha、SDK 依赖版本、非敏感表行数和 Pi 表数量；v1 manifest 仍可校验。
- 目录/文件权限 700/600；拒绝非空目标目录。
- `VACUUM INTO` 不包含 WAL 中尚未 checkpoint 的旧页，但会生成当前逻辑快照；备份期间仍建议降低写入（维护窗口）。

## 2. 校验与恢复

```bash
npm run backup -- --verify ./backups/2026-11-18
npm run backup -- --restore ./backups/2026-11-18 --target ./restored
```

- verify 重算每个文件的哈希并检查 SQLite 完整性。
- restore 只写入新的空目录；拒绝路径型文件名、较高 schema、非空目标。
- 恢复后先用 `npm run preflight` 或直接以只读方式核对行数/业务记录；不要覆盖原库。
- 恢复不会自动启动应用；确认 manifest 的 commit/schema/SDK 与目标 build 兼容后再启动。
- schema 较新时安全停止并保留原数据；降级不受支持。

## 3. JSON 导出

```bash
npm run export:data -- --data ./data --out ./exports/agent.json
```

- 导出 agent 业务表（身份、会话、Inbox/Outbox、任务、审批、提醒、记忆、计划、审计等）为可读 JSON。
- 不读取环境变量，不导出 secret；Pi/Provider 原始会话 **不在 JSON 中**，其表数量仅作提示。
- 目标已存在时拒绝覆盖；文件 600。
- 导出用于审阅/迁移辅助，不等于完整恢复包；完整恢复使用备份目录。

## 4. 删除与保留边界

- `forget` 是软删除（status=deleted），审计和版本仍保留；不能称为“永久清除”。
- 个人记忆删除、历史对话/审计保留期、Pi 会话删除、Provider 侧数据删除需主人决策（D13/D14）。
- 第三方 Provider/模型服务保存的数据不受本应用删除承诺覆盖；文档不得暗示可远程清除。
- 备份副本中的旧数据会继续存在，直到按保留策略销毁。

## 5. 故障与安全停止

| 现象 | 处理 |
| --- | --- |
| verify 哈希/完整性失败 | 不要恢复；保留现场，尝试上一份备份 |
| schema 高于 build | 停止启动，升级 build 或使用匹配版本；禁止手改 schema_version |
| 恢复目标非空 | 换新目录；不要 `rm -rf` 原数据 |
| 迁移失败 | 应用启动失败；恢复 pre-upgrade 备份，保留日志 |
| Pi 文件缺失 | agent 可恢复但会话引用可能不可用；按 manifest 核对 pi.sqlite |

## 6. 未完成

- 定期备份调度、加密、异地副本、保留期自动化、删除执行器。
- SIGKILL/写入中备份、Pi SDK 跨版本修复流程、真实 Cloudflare PITR。
- 新实例启动后的 Task/Reminder/Memory 全量业务核对脚本（当前为行数/样例读取）。
