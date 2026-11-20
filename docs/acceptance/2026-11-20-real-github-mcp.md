# Real GitHub MCP evidence — 2026-11-20

> Scope: read-only remote MCP through `apps/agent/src/plugins/mcp.ts`. This validates the MCP host and static allowlist against the official GitHub MCP endpoint; it is not a write or OAuth acceptance.

## Environment

- Host: local macOS Node process.
- Credential: local authenticated GitHub CLI token (`repo` scope), read in-process and passed only as `PA_MCP_GITHUB_TOKEN`. Not printed, persisted, or committed.
- Endpoint: `https://api.githubcopilot.com/mcp/` (Streamable HTTP).
- Proxy note: local DNS maps the hostname to `198.18.1.19`, which is a reserved benchmarking range. The server config therefore used the explicit exact-host opt-in `trustedHosts: ["api.githubcopilot.com"]`; without it the host correctly failed closed with “MCP url resolves to a private address”.
- The remote advertised 46 tools; the host allowlisted exactly two read tools: `get_commit` and `list_pull_requests`. All remote write tools (create/merge/delete/comment) were ignored.
- Remote tool descriptions were not used in the manifest; the two host-authored descriptions were used.

## Result

| Tool | Observed |
| --- | --- |
| `get_commit` | Host tool `github-mcp.get_commit` succeeded for `75df684ce12e9085bc27329dd2adf2bab5b7836b`; evidence contained the SHA and “Merge pull request #66…”, 2026-11-20T11:02:29Z; 2,026 bytes, not truncated |
| `list_pull_requests` | Host tool `github-mcp.list_pull_requests` succeeded for `owner=yuanbaoerer`, `repo=personal-agent`, `state=open`, `perPage=5`; evidence contained PR #74; 11,608 bytes, not truncated |
| REST comparison | The same commit SHA and PR #74 were independently read through `github.read`; see `2026-11-20-real-github-g1.md` |
| Write calls | None |
| Token exposure | None in stdout, evidence, manifest, or repository |

## Verdict

**PARTIAL / PASS for real read-only GitHub MCP.**

Passed: real Streamable HTTP connection, `tools/list`, static tool allowlist, host-authored metadata, static argument validation, two real `tools/call` reads, result bounding, and consistency with REST evidence.

Not verified:

- MCP OAuth discovery/PKCE/refresh; the run used a PAT-like bearer token.
- stdio transport, notifications/resume, cancellation and reconnects.
- Pagination beyond the configured `perPage` (the remote call itself succeeded; the host does not expose cursors).
- Any MCP write path; only read tools were declared.
- Real server-side revocation and account switch.
- GitHub MCP results as evidence for GH-02/GH-03; REST remains the verifiable path.

## Reproduce

1. Configure one server with `url: "https://api.githubcopilot.com/mcp/"`, `authEnv` matching a `PA_MCP_*` variable, `trustedHosts` only if the local proxy maps the domain to a reserved address.
2. Declare `get_commit` and `list_pull_requests` with explicit scalar argument schemas.
3. `connectMcpPlugin`, assert `configured=true`, then call `execute` with the repo/SHA/PR filters.
4. Compare the returned SHA/PR fields with the REST G1 evidence. Do not log the bearer token.
