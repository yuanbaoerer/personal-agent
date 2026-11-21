# 2026-11-22 · Real-model read-only Project Review (E3-partial)

> Scope: real GitHub read + real model + program verifier + Outbox. **Not** a Feishu E3: the owner did not type the message in a Feishu client, and the Outbox row was not delivered to a real Feishu conversation.

## Environment

| Field | Value |
| --- | --- |
| Repository | `yuanbaoerer/personal-agent` |
| Immutable repositoryId | `1445007789` |
| projectKey | `personal-agent` |
| Fixed ref | `heads/main` |
| Commit SHA | `345faacf803fe3d230ab1843295b18d353e5da66` |
| Model | `opencode-go/deepseek-v4.1-flash` |
| GitHub credential | owner-account read token, `repository.read`, resolved through the binding `github:default` |
| Writes | none |

## What ran

A real Router model turned the owner text into a `github.project-review` task. The real Worker proposed typed reads; ActionService executed them with the read-only preauthorization; the program Verifier accepted the final report; TaskService persisted two draft snapshots.

Real receipts included:

- `repo` → `repositoryId=1445007789`, `defaultBranch=main`.
- `ref heads/main` → `345faacf803fe3d230ab1843295b18d353e5da66`.
- Fixed-SHA `file` reads for `docs/21-mvp-functional-ready.md`, `docs/24-github-project-management.md`, `docs/25-extension-platform.md`, `apps/agent/src/actions/github.ts`, `credentials.ts`, `project-review.ts`.
- `pull_files` for open PRs #95/#96/#97 with base/head SHA and `stale=false`.
- `checks` for PR heads; the #96 head run’s test/macOS/Windows/install-smoke jobs were `success`.
- `issues`/`issue` for #7/#28/#60/#61/#62/#65/#68.

## Verifier result

Task status: `succeeded`.

```json
{
  "verifier": "project-review",
  "verdict": "succeeded",
  "reason": "project review verified 3 observed, 0 inferred and 0 unknown finding(s); 2 issue draft(s) await owner approval",
  "missing": [],
  "externalFactsVerified": true
}
```

Findings (3 observed), each cited a fixed-SHA file receipt; Issue matches were backed by issue receipts.

## Persisted drafts

| Action | Target | Status | commitSha | repositoryId | credentialVersion |
| --- | --- | --- | --- | --- | --- |
| comment | #65 | pending_approval | `345faac…` | 1445007789 | 1 |
| comment | #62 | pending_approval | `345faac…` | 1445007789 | 1 |

Each row carries `payloadHash`, `beforeHash`/`beforeSummary`, source task/revision/assignment and idempotency key. No GitHub write occurred.

## What this proves and what it does not

Proved:

- A real model can select the project-review path, use real typed GitHub reads at one fixed SHA, produce structured findings, and pass the program Verifier.
- Program-derived drafts are persisted with repository/revision/payload/credential bindings.
- The result reached Outbox with findings and “approval required” drafts.

Not proved:

- The owner received the message in Feishu (E3 delivery).
- Any real GitHub Issue write (requires an owner-designated isolation repository and separate Issues-write credential).
- Stability across repeated runs; this is one successful run after several rejected reports. The rejected runs exposed real prompt/orchestration issues (ref form, typed arg names, unstructured tool calls, non-revision-pinned evidence, mixed draft revisions, model-supplied idempotency keys), which were fixed in code/prompt rather than weakening the Verifier.
