# Changelog

All notable changes are recorded here. This project does not yet have a stable release or declared license.

## Unreleased

- Reliable core: persistent Inbox/Outbox, Task/Assignment fencing, TaskInput barriers, Action approval/claim guards, restart recovery, duplicate delivery handling.
- Read-only GitHub connector with explicit repo allowlist and revocable preauthorization.
- Sharded task completion verification with `needs_review` and `/ack`.
- Confirmed recurring schedule policies with deterministic run keys and plan-scoped read authorization.
- Global/project-scoped memory with Worker-only injection and confirmation cards.
- Optional Magpie quota/budget gating; Docker/Compose self-host path and preflight.
- Fixed 40-scenario deterministic evaluation catalog and JSON/Markdown reports.
- Backup manifest v2, verified restore, agent JSON export, secret scanner, governance/security docs.
- Local authenticated `/api/v1` Client API + TypeScript SDK, `pa` CLI, and minimal `pa tui`; device token hashes/scopes/revocation, idempotent task/input operations, bound approvals, replayable event cursor/SSE stream, device-token TTL/IP+credential rate limiting, SSE Last-Event-ID reconnect, SQLite-reopen, child and full-main SIGKILL/restart coverage, OpenAPI 3.1 contract, and a clean-install smoke, and TUI supplement/revise/reminder controls, and pending-reminder text/due-time editing, TUI wrapping/detail scrolling, and macOS/Windows CI jobs, both passing.

## Version history

No public version has been released. `package.json` version `0.1.0` is an internal development marker, not a compatibility promise. See `docs/18-open-source-governance.md`.
