# Contributing

Thanks for helping. This is a pre-release, single-owner agent; keep changes small and evidence-backed.

## Before coding

- Open an issue describing the behavior, failure reproduction, and whether real credentials are needed.
- **License status:** the project has not declared a LICENSE yet (decision D16). Until that is resolved, maintainers should not merge third-party source contributions; bug reports, reviews, and design feedback are welcome.
- Do not include real Feishu IDs, message IDs, chat content, tokens, `.env`, or provider responses in issues, tests, or fixtures.

## Local checks

```bash
npm ci
npm run typecheck
npm test
npm run scan:secrets
npm run eval:report
npm run deploy:dry-run
```

For Docker changes, also run `docker compose config` and, when the image is available, a clean-container health/restart check.

## Pull requests

- One concern per PR; explain the failure before the fix.
- Include deterministic tests for behavior/boundaries. Do not claim real-model/E3 coverage from mocks.
- Do not weaken owner binding, approval nonce, Action execution guards, or completion verification to make a test pass.
- Update the relevant `README.md`/`docs` and `docs/15-decisions-pending.md` when a decision is still open.
- Never change repository visibility or add production secrets from CI/scripts.
- CI must be green; do not remove a failing critical case to increase the pass rate.

## Security

Report vulnerabilities privately via `SECURITY.md`, not a public issue.
