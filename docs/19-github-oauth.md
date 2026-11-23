# 19 · GitHub OAuth（个人开发者，E1）

> 自托管 Node 支持个人 OAuth App 和仓库级只读 PAT。[GC-00/01](29-github-one-click-connection.md) 已将加密凭据接入连接 API 和 `pa plugins login/status/logout github`（E1）；原网页 OAuth 流程仍可用。真实授权、换号及撤销的验收由 [#68](https://github.com/yuanbaoerer/personal-agent/issues/68) 跟踪。
>
> 连接账号不等于绑定仓库或批准写入。受控 Issue 写入使用[独立写凭据及逐次审批](24-github-project-management.md)；公共 GitHub App 尚未实施。Cloudflare 宿主未接入 Node OAuth 流程。

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
- `public_repo` 限于公共仓库，但不是只读 scope；`repo` 也包含私有仓库的写权限。`github.read` 只发 GET 并不能缩小 token 本身的权限。只需读取一个私有项目时，优先用限制到该仓库的 fine-grained read-only PAT。
- `ADMIN_TOKEN` 是 OAuth start/status/disconnect 的必需认证；没有它配置启动会失败，不能依赖 loopback 信任（反向代理/隧道会让远端请求看起来来自本机）。
- `GITHUB_ALLOWED_REPOS` 仍是第二道白名单：OAuth 授权不等于允许访问所有仓库。

## 3. 连接

配置好 OAuth App 后，可以用 `pa plugins login github --oauth` 获取授权入口，或直接打开原管理页：

```text
http://127.0.0.1:8787/oauth/github
```

首次输入 `ADMIN_TOKEN`。登录只建立 **HttpOnly、SameSite=Strict、1 小时** 的页面会话，不把 admin token 写入 cookie、URL 或日志。随后点击 **Connect / re-authorize GitHub** 完成 GitHub 授权。

管理 API 仍可用 Bearer header；不接受 URL query token：

```bash
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/oauth/github/start
```

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
- OAuth App 的 client id/secret/加密 key 目前仍需一次性写入 env；网页只负责 owner 登录与 GitHub 授权，不是 OAuth App 配置向导（见 D22）。
- 无 token 自动刷新/轮换；OAuth App token 失效后重新授权。
- Worker/DO 未接 OAuth，继续用 PAT。
- 未接 GitHub App，因此私有仓库的细粒度只读权限仍受 OAuth scope 限制。
- 真实 OAuth App、回调、token 撤销和 G1 端到端仍需 D21 凭据验收。
