# Security policy

## Supported versions

This repository is pre-release and currently supported on `main` only. No version is declared production-ready. Do not deploy a fork to untrusted users without an independent review.

## Reporting a vulnerability

Use GitHub's private security advisory flow for this repository:

`Security` → `Advisories` → `Report a vulnerability`

Do not open a public issue, paste secrets, personal identifiers, or raw provider responses. If the private flow is unavailable, contact the repository owner through GitHub and say only that you need a private security channel.

Please include: affected commit, component, minimal reproduction, expected/actual behavior, environment, and whether an external side effect may have occurred. We will acknowledge privately and coordinate disclosure; no response SLA is promised for this pre-release.

## Secrets and rotation

If a secret may have leaked (Feishu app secret, OpenCode key, GitHub token, Magpie gateway key), rotate it immediately in the provider console, update local `.env`/`infra/.dev.vars`/Worker secrets, and revoke old sessions. Do not rely on repository history rewriting as the primary containment.

## Agent-specific threat surface

- LLM output is untrusted input. Permission, completion, and external-write decisions are program-checked; report bypasses with reproduction.
- Prompt injection from web/GitHub/memory/channel content is not claimed solved. A successful write still needs the Action approval/nonce path and current Mandate.
- `/admin/*` and `/ask` require the Worker admin token; webhook identity and owner binding must not be relaxed for convenience.
- Pi/Provider third-party data retention is outside this application's deletion guarantees.

## Known limitations

See `docs/08-evaluation.md`, `docs/15-decisions-pending.md`, and the `needs_review`/unknown/needs_manual paths. Real Feishu/GitHub/Cloudflare E3/E4 evidence is incomplete.
