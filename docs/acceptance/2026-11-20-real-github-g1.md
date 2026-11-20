# Real GitHub G1 evidence — 2026-11-20

> Scope: real read-only calls through the Extension Platform catalog/action path on the private repository `yuanbaoerer/personal-agent`, plus one Feishu outbound delivery. This is not a substitute for Feishu inbound acceptance, real OAuth negative paths, write, or full #41 acceptance.

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

## Feishu outbound delivery

After the read-only run, one message was sent through the existing Feishu app to the owner's latest bound p2p conversation:

- Text: `[G1 acceptance] GitHub read-only: yuanbaoerer/personal-agent, commit 75df684, PR #74, plugin github@0.1.0. Feishu outbound delivery check.`
- Feishu message ID: `om_x100b7f…eb61` (full ID kept only in the operator's acceptance log, not in the repository)
- Accepted at: `2026-11-20T15:14:09.550Z`
- Conversation: `feishu` / `p2p`
- Result: Feishu API returned a message ID (accepted). No message history was read; no inbound event was replayed.

## On-demand skill with real GitHub read

A second real task requested `mandate.skills = ["github.project-review"]` and used the same private repository:

| Check | Observed |
| --- | --- |
| Skill binding | `github.project-review@1.0.0`, digest `3c1d6f518bea251ce47982efe60463fa7ae2d689c0307a894280002087fd2d64` |
| Rejections | none |
| Worker prompt | contained “Selected skills”, `skill github.project-review`, `observed vs inferred` guidance and the “not authority” warning |
| GitHub action | `github.read` repo succeeded; source `https://github.com/yuanbaoerer/personal-agent`; `pluginId=github`, generation `1` |
| Model execution | deterministic `FakeRuntime` captured the prompt; no real model call was made, so model adherence is not claimed |

This verifies host-level on-demand skill selection/injection plus a real GitHub read in the same task revision. It does not claim that a real model followed the skill or that a project review was completed.

## Verdict

**PARTIAL / PASS for real read-only GitHub G1, Feishu outbound, and host-level skill injection.**

Passed: private-repo repo/PR/commit reads through the plugin catalog, task-bound plugin digest, action-bound plugin/generation, real API source URLs, explicit truncation, one accepted Feishu outbound message, and host-level skill selection/injection with a real GitHub read.

Not verified in this run:

- Feishu inbound event → Agent → outbound G1 reply (only the outbound leg was exercised here).
- Real model adherence to the injected skill (the prompt was captured with `FakeRuntime`).
- Real OAuth login/revoke/account-switch negative paths against a real account.
- Write capabilities (not implemented).
- Long-running/restart recovery for this specific task.
- Real CI checks (check-runs API is not part of this `github.read` operation).

## Reproduce

1. Ensure local `gh` is authenticated to the owner account and the token can read the private repo.
2. Run an in-memory `createApp` with `github: { token, allowedRepos: ["yuanbaoerer/personal-agent"] }`.
3. Create a task with `mandate.tools = ["github.read"]`, propose `{operation:"repo"|"pull"|"commits"}`, approve, drain effects.
4. Assert `status=succeeded`, `pluginId=github`, stable `pluginDigest`, and evidence source URLs. Do not log the token.

The actual run used the same path as `apps/agent/test/github.test.ts` and `apps/agent/test/plugins.test.ts`, but with the real API instead of a fake fetch.
