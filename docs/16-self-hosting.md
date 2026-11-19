# 16 · 自托管部署（Node + Docker）

> 状态：E1 工程路径。ADR-0001 仍为 provisional；真实飞书 E3、SIGKILL/DO 驱逐证据未齐备。Docker 镜像未发布到 registry，Cloudflare DO 仍是可选/实验路径。

## 0. Clean-install smoke

在开发机上用隔离临时副本验证安装链：

```bash
npm run install:smoke
```

脚本排除 `.git`、`node_modules`、`data`、`.env`、backups/exports/reports，执行 `npm ci`、typecheck、275 tests、`pa help`，再用合成 env 临时启动并检查 `/healthz`/API health。CI 的 `install-smoke` job 会执行同一脚本（首次 run `44509079800` 通过）。它不代表第二开发者或真实 OS 安装包验收。

## 1. 前提

- Docker 27+ 与 Compose v2；Linux amd64 已验证目标，arm64 未验证。
- 飞书自建应用：App ID、App Secret、Verification Token；可选 Encrypt Key。
- 唯一的 owner `open_id`；不要从昵称或模型输出推断。
- 首次建议 `FEISHU_EVENT_MODE=long_connection`，无需公网回调/TLS；webhook 模式需要自行提供反向代理。
- GitHub OAuth App 的 callback 必须能从浏览器访问：本机用 `http://127.0.0.1:8787/oauth/github/callback`，远程部署用公网 HTTPS 地址并同步 `GITHUB_OAUTH_REDIRECT_URI`。OAuth token 用 `GITHUB_OAUTH_ENCRYPTION_KEY` 加密；该 key 不随备份保存。OAuth start/status/disconnect 必须配置 `ADMIN_TOKEN`，只接受 Bearer header。

## 2. 启动

```bash
cp .env.example .env
# 编辑 .env：
# FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN
# OWNER_FEISHU_OPEN_ID
# FEISHU_EVENT_MODE=long_connection
# 可选 OPENCODE_API_KEY、GITHUB_TOKEN/GITHUB_ALLOWED_REPOS、MAGPIE_URL

docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
docker compose logs -f agent
```

`preflight` 在监听前检查配置、owner 和两个数据目录；缺少 Feishu 凭据或 owner 会直接退出，容器进入重启循环并在日志中给出 `preflight_failed`，不会带着半配置运行。

## 3. 数据与重启

- 命名卷 `agent-data` 挂载到容器 `/data`；`agent.sqlite`（应用状态）与 `pi.sqlite`（Pi 会话）必须成对保留。命名卷由 Docker 初始化，避免 Linux 主机上非 root 用户无法写 bind mount。
- `docker compose restart` / 重建容器不会丢数据；删除 `./data` 等于删除全部状态。
- 备份（需先固定一个版本，恢复只面向空目录）：

```bash
docker compose exec agent node scripts/backup.ts --data /data --out /data/backups
docker compose cp agent:/data/backups ./backups
```

- 需查看卷位置时用 `docker volume inspect personal-agent_agent-data`；备份副本用 `docker compose cp` 取出。
- 容器内以 `node` 用户运行、根文件系统只读、丢弃全部 capabilities、`no-new-privileges`；secrets 只从运行时 environment/`env_file` 注入，`.dockerignore` 排除 `.env` 和数据文件。

## 4. 诊断

| 现象 | 处理 |
| --- | --- |
| `preflight_failed` missing FEISHU_* | 补全 `.env`，`docker compose up -d --force-recreate` |
| `preflight_failed` OWNER_FEISHU_OPEN_ID | 设置唯一 owner open_id |
| `config_invalid` | 检查 `FEISHU_EVENT_MODE`、`PORT`、目录权限 |
| 容器 unhealthy | `docker compose logs agent`；`/healthz` 只证明进程存活，不代表飞书回调已接通 |
| 无模型结果 | 未设置 `OPENCODE_API_KEY` 时确定性命令可用、模型任务显式失败 |
| webhook 无回调 | 检查公网 TLS/反向代理与飞书回调 URL；长连接模式不需要公网入口 |
| 升级 schema 失败 | 先备份；恢复脚本拒绝高于当前 build 的 schema |

## 5. 未完成/需决策

- 镜像是否发布到 registry、支持哪些架构（见 D08）。
- webhook + TLS 反向代理是否作为标准部署，还是 long_connection 优先（D07）。
- ADR-0001 是否在真实 E3/E4 前定稿（D09）。
- 定期备份/加密/保留期、容器健康指标与自动升级仍 pending；不把 Docker 启动成功当作生产可用。
