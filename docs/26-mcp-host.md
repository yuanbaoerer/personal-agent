# 26 · MCP Host（EXT-03，只读 V1）

> 2026-11-21 · [#69](https://github.com/yuanbaoerer/personal-agent/issues/69) / [#80](https://github.com/yuanbaoerer/personal-agent/issues/80) · 本次实现的是 **Node 只读远程 MCP**。远程工具只有在编译期只读契约中经过 provider、endpoint、contractVersion 和 remoteName 核验后才暴露；任意配置的 remoteName 不再自动获得 `readOnly`。仍不包含任意 MCP 安装、写入穿透、stdio 本地子进程或 OAuth discovery/PKCE。

## 1. 范围与安全边界

MCP Host 把显式配置的远程 MCP server 暴露为受信内置插件。Discovery 只用于确认声明工具存在，**不会**因为 `tools/list` 出现新工具就扩大权限；远程工具的 description、annotations、schema 和返回内容全部视为不可信数据。

- 只允许 `https://` URL；仅当配置显式 `allowInsecureLocalhost: true` 时允许 `http://localhost`/`127.0.0.1`/`::1` 测试服务器。
- URL 不得包含 username/password；DNS 解析到 loopback、私网、link-local、组播或保留地址时拒绝。HTTP 重定向设为 `error`。唯一的例外是 owner 显式配置的 `trustedHosts` 精确 hostname 列表（用于代理/内网 MCP）；它会跳过私网 DNS 拒绝，必须确认目标可信，默认留空。
- Bearer token 只能来自 `PA_MCP_*` 环境变量；manifest、任务、日志和模型参数都不能提供 token。禁止把宿主其他凭据透传给 MCP server。
- **只读语义必须由编译期契约证明**：server 必须声明 `provider` 与 `contractVersion`，URL hostname 和每个 `remoteName` 都必须在 `McpReadOnlyContract` 中列明。未知 provider、version、endpoint 或工具在连接前 fail closed；仅有 remoteName、远程 annotations 或配置里的布尔值都不算证明。
- 每个 server 必须在配置中列出 `tools[]`、本地名称、resource 和允许参数；未列出的远程工具永远不注册。参数按显式 `type/required/maxLength/min/max/enum` 校验，未知参数拒绝。
- 通过契约的工具固定 `readOnly: true`、`replayPolicy: "verify"`；不提供 MCP 写操作。写入仍必须走 Core typed Action 审批/核验，当前未开放。契约中的工具也仍需 owner 审批，不会因为 `readOnly` 自动落库。
- 单次调用有 timeout；每次 HTTP 请求（连接、list、call）重新做 URL/DNS 校验，并把连接 lookup 固定到已校验地址（undici Agent），避免校验与连接使用两次解析；响应流在 2 MiB 处硬失败；文本再截断到 32KB，图片/音频只记录类型，不把 base64 注入 prompt。最多 20 个 server、每 server 50 个工具。
- `trustedHosts` 会显式跳过私网检查和 IP pinning（用于代理/内网/真实 GitHub MCP），必须由 owner 确认；非 trusted host 仍做 pinning。MCP server 不是安全沙箱，也不是权限系统。禁用插件仍通过 catalog generation 撤销待审批动作。
- 契约只证明“该 provider 的该 endpoint 上，这个 remoteName 的已验证语义是只读”，不能阻止被攻陷的 provider 改变实现；因此仍必须使用最小权限 token，并保留写路径的 Core 审批。当前唯一内置契约是 `github@1` 的 `get_commit` / `list_pull_requests`。

## 2. 配置

`PA_MCP_CONFIG` 指向 JSON 文件；示例见仓库根 `mcp.servers.example.json`。

```json
{
  "servers": [
    {
      "id": "github-mcp",
      "name": "GitHub official MCP (verified read-only contract)",
      "version": "0.1.0",
      "provider": "github",
      "contractVersion": "1",
      "url": "https://api.githubcopilot.com/mcp/",
      "authEnv": "PA_MCP_GITHUB_TOKEN",
      "allowInsecureLocalhost": false,
      "trustedHosts": [],
      "timeoutMs": 15000,
      "tools": [
        {
          "remoteName": "get_commit",
          "name": "get_commit",
          "description": "Read one Git commit by repository and SHA.",
          "args": {
            "owner": { "type": "string", "required": true, "maxLength": 200 },
            "repo": { "type": "string", "required": true, "maxLength": 200 },
            "sha": { "type": "string", "required": true, "maxLength": 200 }
          }
        },
        {
          "remoteName": "list_pull_requests",
          "name": "list_pull_requests",
          "description": "List pull requests in one repository.",
          "args": {
            "owner": { "type": "string", "required": true, "maxLength": 200 },
            "repo": { "type": "string", "required": true, "maxLength": 200 },
            "state": { "type": "string", "enum": ["open", "closed", "all"] },
            "perPage": { "type": "number", "min": 1, "max": 100 }
          }
        }
      ]
    }
  ]
}
```

- `id`：插件/catalog namespace；工具本地名为 `<id>.<name>`。
- `provider` / `contractVersion`：必填，必须对应宿主编译期 `McpReadOnlyContract`。当前只有 `github@1`；自定义 server 需要先在代码中增加并审查契约，不能通过 JSON 自行声明。
- `authEnv`：可选，必须匹配 `PA_MCP_[A-Z0-9_]+`。缺失 token 时 fail closed，不尝试匿名连接；GitHub 应使用只读最小 scope token。
- `trustedHosts`：可选，精确 hostname 数组（最多 10 个）。仅用于 owner 信任的代理/内网映射；会跳过私网 DNS 拒绝，默认不要设置。GitHub MCP 在本地代理把域名映射到 `198.18.x` 时曾显式使用该字段。它不会改变契约的 endpoint hostname 校验。
- `timeoutMs`：连接、`tools/list`、`tools/call` 的上限；单工具可覆盖。
- `name`/`description`：宿主配置文本，不采用远程描述；契约可提供默认 description。
- 配置变化会改变 manifest digest；新进程启动后 catalog generation 递增，旧审批在 claim/execute 时失效。

## 3. 生命周期与观测

启动时 `connectMcpPlugins` 连接每个 server，校验声明工具存在；连接失败仍安装 manifest，但 `createTools()` 抛错，catalog 将其标记为 `error` 并移除工具。成功时连接状态为 `connected`，工具进入同一 `pa_plugins`/catalog generation。`pa plugins list/status/disable` 可查看/停用；禁用后待执行动作被 supersede。

## 4. 验证与未完成

已用官方 `@modelcontextprotocol/sdk` 1.32.2 的 Streamable HTTP client，对本地 fake server 测试：

- 契约校验：未知 provider/version/endpoint/remoteName 在连接前拒绝；fake server 上的 `create_issue` 和伪装成 `get_*` 的写方法都不会进入 manifest 或工具注册；未验证失败时 manifest 不声明任何工具。
- `listTools` 只暴露静态 allowlist；远程额外工具不出现。
- 远程恶意 description 不进入 manifest；使用宿主配置或契约 description。
- bearer token 只从 `PA_MCP_*` 读取并发送到配置 server；缺失时 fail closed。
- 未知参数、超长参数、私有/insecure URL、慢调用 timeout、catalog 热禁用。
- 2 MiB 传输层响应上限与 32KB 文本截断；每次请求前 DNS/URL 复核，非 trusted 连接固定到已校验 IP。
- 工具结果截断与错误映射。

2026-11-20 对真实 `https://api.githubcopilot.com/mcp/` 做了只读探测：远端 46 个工具，宿主只 allowlist `get_commit` / `list_pull_requests`，两次真实 `tools/call` 成功，返回的 commit SHA、message 与 PR #74 和 REST G1 证据一致；远端写工具未注册。2026-11-21 进一步把这些工具改为 `github@1` 编译期契约，不再仅凭配置声明 `readOnly`。该环境代理把域名解析到 `198.18.1.19`，因此显式配置了 `trustedHosts: ["api.githubcopilot.com"]`；否则宿主按设计拒绝私网映射。记录见 `docs/acceptance/2026-11-20-real-github-mcp.md`。

未完成/阻塞：

- MCP OAuth discovery/PKCE/resource/refresh、stdio 本地 transport、分页/通知/resume、SSE 断线重连未实现。
- 未做 MCP 写穿透；`#61` 仍要求 typed action/审批/幂等/verify。
- 当前只支持 `github@1` 的两个只读工具；新增 provider/tool 必须补代码契约、来源与负例，不能只改 JSON。
- DNS rebinding、MCP server 自身被攻陷、跨调用数据残留仍是 residual risk；V2 才评估第三方隔离。
