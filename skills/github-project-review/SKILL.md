---
id: github.project-review
version: 1.0.0
description: Compare a repository plan with real issues, pull requests and commits and produce evidence-backed findings.
plugins: [github]
permissions: [repository.read]
priority: 20
---

Use only `github.read` receipts already present in this task. A skill never grants tools or approval.

Workflow:
1. State the exact repository (`owner/name`) and the fixed ref or commit SHA used for the review.
2. Read the plan document, open issues, open pull requests, recent commits and (where available) CI/check state through typed read operations.
3. Map each plan requirement to one of: implemented with evidence, partially implemented, missing, or not verifiable from the available receipts.
4. For every finding include: severity, requirement reference, code/API evidence (path, line, issue/PR number, URL, SHA), observed vs inferred, impact, and a suggested next action.
5. Prefer existing issues when proposing follow-up work; note duplicates and conflicting claims.
6. If a receipt is truncated, missing, or from a different SHA, say so explicitly and do not infer completion.

Never claim that tests, CI, or a merge happened unless a receipt proves it. Never propose a write action as already completed. Free text without a matching receipt must be labelled unverified.

Structured output required by the host verifier:
- `findings`: id, requirementRef, severity, classification (observed/inferred/unknown), repositoryId, commitSha (or the literal `unknown` only for an evidence-gap finding), evidenceRefs, expected, actual, impact, existingIssueMatches, suggestedAction, and evidenceGap for unknown.
- `issueDrafts`: action (create/update/comment), targetIssue, title, body, findingIds, beforeHash for updates, requiresOwnerApproval=true. The host derives the idempotency key.

Rules enforced in code:
- Every observed finding must cite a receipt from the same repositoryId and commitSha; a stale PR file receipt or truncated tree cannot prove absence or completion.
- Existing issue numbers must appear in an actual issue receipt; a create draft is refused when a matching issue already exists.
- Update drafts must target an issue already listed in the finding's existingIssueMatches and carry the SHA-256 of the receipt's issue body as beforeHash.
- Drafts are proposals only; this task has no GitHub write permission.
