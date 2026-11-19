# 19 · GitHub OAuth（个人开发者，E1）

> 面向单 owner / 个人开发者自托管。当前 OAuth 只在 Node 入口实现；Cloudflare Worker 仍使用 `GITHUB_TOKEN` PAT。仓库仍 private，OAuth 凭据需真实 GitHub OAuth App 才能验收。

## 1. 创建 GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App：

- Homepage URL：`http://127.0.0.1:8787`
- Authorization callback URL：`http://127.0.0.1:8787/oauth/github/callback`（必须与 `GITHUB_OAUTH_REDIRECT_URI` 完全一致）
- 如部署在服务器/容器，使用公网 HTTPS 回调地址，并完成 TLS/反向代理。

## 2. 配置

```bash
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
GITHUB_OAUTH_ENCRYPTION_KEY="$(openssl rand -base64 32)"
GITHUB_OAUTH_REDIRECT_URI=http://127.0.0.1:8787/oauth/github/callback
GITHUB_OAUTH_SCOPES=read:user,public_repo
GITHUB_ALLOWED_REPOS=owner/repo
ADMIN_TOKEN=...
```

- 加密密钥必须是 32 字节（base64 或 64 位 hex）；用于 AES-256-GCM，token 不以明文入库。备份数据库会包含密文；恢复实例必须复用同一 `GITHUB_OAUTH_ENCRYPTION_KEY`，否则只能重新授权。
- 默认 `public_repo` 只覆盖公共仓库。需要私有仓库时显式改为 `read:user,repo`；`repo` 允许私有仓库读写，本应用只发 GET，但 OAuth token 本身权限更宽。需要私有细粒度只读时，GitHub OAuth App 无法表达，应优先考虑 GitHub App（D21 后续）。
- `ADMIN_TOKEN` 是 OAuth start/status/disconnect 的必需认证；没有它配置启动会失败，不能依赖 loopback 信任（反向代理/隧道会让远端请求看起来来自本机）。
- `GITHUB_ALLOWED_REPOS` 仍是第二道白名单：OAuth 授权不等于允许访问所有仓库。

## 3. 连接

服务启动后，用 admin token 打开授权入口：

```bash
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/oauth/github/start
```

把响应中的 `Location` 复制到浏览器打开。管理 token 只放在 `Authorization: Bearer` 头中，不接受 URL query token，避免上游代理/浏览器历史泄漏。

授权回调后应看到 `GitHub connected as <login>`。回调只接受一次性 state（10 分钟），重复/过期 state 会被拒绝。

查看/断开：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/oauth/github/status
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/oauth/github/disconnect
```

断开只删除本地密文；要撤销 GitHub 侧授权，请到 GitHub Settings → Applications 撤销。

## 4. 使用

连接后，仍需：

```text
/allow-read owner/repo
检查 owner/repo 的 open issues 和最新 commit，并给出可点击来源。
```

`github.read` 会在每次执行时通过 token provider 解密当前 OAuth token；失败不会把 token 写进日志。

## 5. 边界

- 单 owner；不支持多用户各自绑定 GitHub。
- 无 token 自动刷新/轮换；OAuth App token 失效后重新授权。
- Worker/DO 未接 OAuth，继续用 PAT。
- 未接 GitHub App，因此私有仓库的细粒度只读权限仍受 OAuth scope 限制。
- 真实 OAuth App、回调、token 撤销和 G1 端到端仍需 D21 凭据验收。
