# Real GitHub G1 evidence — 2026-11-20

> Scope: real read-only call through the Extension Platform catalog/action path on the private repository `yuanbaoerer/personal-agent`. This is not a substitute for Feishu delivery, revocation, write, or full #41 acceptance.

## Environment

- Host: local macOS Node process, `:memory:` SQLite, no production data.
- Credential: local authenticated GitHub CLI token (`repo` scope), read from `gh auth token` in-process and passed only to `GitHubReadTool`. The token was not printed, written to the repository, or stored in SQLite.
- Repository: `yuanbaoerer/personal-agent` (private), default branch `main`.
- Composition: `createApp` → `PluginCatalog` → task extension snapshot → `ActionService` proposal/approval/execute → `GitHubReadTool` GET.
- No write, merge, settings or branch-protection call was made.

## Result

| Check | Observed |
| --- | --- |
| Plugin lifecycle | `github` enabled, connection `connected`, active tool `github.read` |
| Task extension | `catalogGeneration: 1`, `github@0.1.0`, digest `bbeddf2879b227b31b3fd97b2a585bd64923f38c27b328d733f5a1b9013d63e1` |
| Action binding | `pluginId: github`, `pluginVersion: 0.1.0`, `catalogGeneration: 1`, status `succeeded` |
| Repo read | `fullName: yuanbaoerer/personal-agent`, `defaultBranch: main`, `pushedAt: 2026-11-20T12:44:51Z`, open issues `51` |
| Repo source | <https://github.com/yuanbaoerer/personal-agent> |
| PR read | PR #74, state `open`, draft `false`, merged `false`, mergeableState `unstable`, base `main`, head `feat/ext-01-plugin-runtime` |
| PR source | <https://github.com/yuanbaoerer/personal-agent/pull/74> |
| Commit read | `75df684ce12e9085bc27329dd2adf2bab5b7836b`, “Merge pull request #66…”, `2026-11-20T11:02:29Z` |
| Commit source | <https://github.com/yuanbaoerer/personal-agent/commit/75df684ce12e9085bc27329dd2adf2bab5b7836b> |
| Truncation signal | commits list returned `truncated: true` for `limit=1`; not hidden |

## Verdict

**PARTIAL / PASS for real read-only GitHub G1.**

Passed: private-repo repo/PR/commit reads through the plugin catalog, task-bound plugin digest, action-bound plugin/generation, real API source URLs, and explicit truncation.

Not verified in this run:

- Feishu inbound/outbound delivery of the G1 result.
- OAuth login/revoke/account-switch negative paths against a real account.
- Write capabilities (not implemented).
- Long-running/restart recovery for this specific task.
- Real CI checks (check-runs API is not part of this `github.read` operation).

## Reproduce

1. Ensure local `gh` is authenticated to the owner account and the token can read the private repo.
2. Run an in-memory `createApp` with `github: { token, allowedRepos: ["yuanbaoerer/personal-agent"] }`.
3. Create a task with `mandate.tools = ["github.read"]`, propose `{operation:"repo"|"pull"|"commits"}`, approve, drain effects.
4. Assert `status=succeeded`, `pluginId=github`, stable `pluginDigest`, and evidence source URLs. Do not log the token.

The actual run used the same path as `apps/agent/test/github.test.ts` and `apps/agent/test/plugins.test.ts`, but with the real API instead of a fake fetch.
