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

## Receipt identifiers

| Item | Id |
| --- | --- |
| Task | `dfb9b763-073f-4250-a8ab-794bdc733a8a` |
| repo receipt | `66b90d47-c86f-4486-8e5e-ffddc5e0438b` |
| ref receipt | `15811448-015d-4426-8248-56bb9ae2f35b` |
| file receipt (docs/21) | `1a05dd79-6a73-4952-b5e7-74908f678fc0` |
| file receipt (docs/24) | `288ef935-0654-4779-b613-307f7efd9be7` |
| tree receipt (truncated) | `fe753447-c5ee-4ce2-bc70-86cb7f9bc09f` |
| checks receipt | `4a8fb80c-f4c8-4a26-ae72-a0704b6d9632` |
| issue list receipt | `b471febb-5a73-40b8-87bc-fb9a4739c0a9` |
| issue #62 receipt | `c0018ef2-f420-4dc2-8eb0-61ab1886d77f` |
| issue #65 receipt | `9e9037ec-776a-4813-865b-7ec127ae0441` |
| PR #97 files receipt | `0561107b-8349-432b-bc59-163586a1c9db` |
| outbox result | `d48c867c-4f49-42ce-bf99-bb57a0720c11` |

## Persisted drafts

| Action | Target | Status | commitSha | repositoryId | credentialVersion |
| --- | --- | --- | --- | --- | --- |
| comment | #65 | pending_approval | `345faac…` | 1445007789 | 1 |
| comment | #62 | pending_approval | `345faac…` | 1445007789 | 1 |

Draft ids: `ddb2fa12-70a8-467f-8129-756960fe44e4` (#65, payload `72c51072…`) and `720b8244-7bbd-44a1-92b9-6d3c21419ded` (#62, payload `a4f0912c…`).

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

## Final-code repeat (2026-11-22)

After the review fixes (title+body beforeHash, read/write credential separation, revision-bound approval, truncation-specific prompt), the same real-model path was run again on the final branch.

- Code tree: `feat/l2w-02-approved-issue-writes` at `3a225df` plus the pending prompt hardening now committed with this record.
- Task: `0492edb3-1260-4b49-a158-f4c51dea5583` → `succeeded`
- repositoryId `1445007789`; `heads/main` → `345faacf803fe3d230ab1843295b18d353e5da66`
- Verifier: `project-review`, 3 observed / 0 inferred / 0 unknown, `missing=[]`, `externalFactsVerified=true`
- Drafts (all `pending_approval`, credentialVersion 1):
  - `7e8013af-7651-46fa-bf2c-a41313a7bfe5` comment #65, payload `315df090…`
  - `75bdd7cd-5bc5-426d-aac3-c7f105003d19` comment #64, payload `bb9a7366…`
  - `8957f86c-c61d-4ee6-b525-5079e8d6450d` comment #92, payload `4e424ee6…`
- Action receipts: repo `9ea8c19d…`, ref `8ca0926e…`, issues `76197b2f…`, files `fa872033…` / `932fee77…` / `bd33b548…`, tree `8befbbe4…`, checks `9c9b56b4…`
- Outbox result `e6547171-94bd-473b-a0b4-09bcdb2307e2`.
- Still no Feishu delivery and no GitHub write.

A preceding run on the same branch (`DKYGOt`) was correctly rejected by the Verifier because an observed finding cited a truncated PR-files receipt with `coverage=complete` and `truncated=false`. The Verifier was not relaxed; the prompt now requires checking the receipt truncation flag and using `limit=100` for PR files.
