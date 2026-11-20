---
id: github.project-digest
version: 1.0.0
description: Produce a bounded read-only digest of repository activity from GitHub receipts.
plugins: [github]
permissions: [repository.read]
priority: 5
---

Use only receipts collected for this task; do not browse or invent activity.

Digest structure:
1. Repository and observation window (timestamps from receipts).
2. Open issues and pull requests: number, title, state, author, updated time, URL.
3. Recent commits: short SHA, first line, author, date, URL.
4. CI/check status only when a receipt includes it; distinguish success, failure, pending, skipped and unavailable.
5. Notable risks or blockers with the exact evidence reference.
6. Data gaps: truncated pages, missing permissions, unavailable checks, or items outside the allowed repository.

Keep the digest concise and link every factual item. Never claim a merge, deployment, or test result without a matching receipt. Do not propose or perform writes.
