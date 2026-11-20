# Changelog

All notable changes are recorded here. This project does not yet have a stable release or declared license.

## Unreleased

- Reliable core: persistent Inbox/Outbox, Task/Assignment fencing, TaskInput barriers, Action approval/claim guards, restart recovery, duplicate delivery handling.
- Read-only GitHub connector with explicit repo allowlist and revocable preauthorization.
- Sharded task completion verification with `needs_review` and `/ack`.
- Confirmed recurring schedule policies with deterministic run keys and plan-scoped read authorization.
- Global/project-scoped memory with Worker-only injection and confirmation cards.
- Optional Magpie quota/budget gating; persistent local model-request limits per task/day cumulative tool-call limits, and a 20/day schedule-run cap; Docker/Compose self-host path and preflight.
- Fixed 40-scenario deterministic evaluation catalog and JSON/Markdown reports.
- Backup manifest v2, verified restore, agent JSON export, secret scanner, governance/security docs.
- Local authenticated `/api/v1` Client API + TypeScript SDK, `pa` CLI, and minimal `pa tui`; device token hashes/scopes/revocation, idempotent task/input operations, bound approvals, replayable event cursor/SSE stream, device-token TTL/IP+credential rate limiting, SSE Last-Event-ID reconnect, SQLite-reopen, child and full-main SIGKILL/restart coverage, OpenAPI 3.1 contract, and a clean-install smoke (also in CI), and TUI supplement/revise/reminder controls, and pending-reminder text/due-time editing, TUI wrapping/detail scrolling, and macOS/Windows CI jobs, both passing.
- MVP-02 natural-language entry: validated structured state-query targets, owner/conversation-scoped task references, deterministic state answers without Workers, confirmation-backed memory/reminder changes, schedule draft/confirm/cancel, misrouted-read and compound-request guards.
- MVP-01/03 fact checks: Worker `stateClaims` for counts/task statuses/reminder times are compared with the cited executor snapshot; `githubClaims` for issue/PR/commit fields are compared with the GitHub receipt. Conflicts require review; new Router tasks require structured claims and free text is never marked verified.
- Extension Platform V1 foundation: manifest schema and builtin plugin catalog with persisted lifecycle, atomic capability snapshot/generation, task/action plugin-version fences, hot enable/disable (Node), `pa plugins` and `/api/v1/plugins`; GitHub migrated to the first builtin Integration Plugin while preserving `github.read`, PAT/OAuth, allowlist and preauthorization. OAuth login/logout/account switch advances the catalog generation and revokes pending approvals. MCP Host, third-party isolation and the full WorkProfile ExtensionPolicy remain pending; real GitHub G1 remains blocked without owner credentials.
- EXT-04 skills loader (Node): `SKILL.md` metadata index, digest/version/path/byte/plugin/permission checks, on-demand body injection into Worker prompts, pinned skill bindings on tasks, `GET /api/v1/skills` and `pa skills list`; built-in read-only `github.project-review`, `github.issue-management` and `github.project-digest` skills. Skill files never execute code and cannot grant tools or approvals.

## Version history

No public version has been released. `package.json` version `0.1.0` is an internal development marker, not a compatibility promise. See `docs/18-open-source-governance.md`.
