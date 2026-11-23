# 2026-11-22 · Conversational & Autonomous Planning — E1 record (E3/E4 BLOCKED)

> Scope: deterministic/scripted E1 evidence for CX-01 (#89), PL-01 (#90) and PL-02 (#91).
> **No real Feishu inbound/outbound, real model Worker, or real GitHub read was exercised in this record.** Every E3/E4 cell below stays BLOCKED; this file must not be used to claim the Conversational/Planning MVP Pilot.

## Branch stack and commit SHAs

| Workstream | Branch | Tip | Notes |
| --- | --- | --- | --- |
| Planning docs | `main` after #94 | `de23f1d` | docs/28 P0-A…D |
| CX-01 context | `feat/conv-01-context` | `af38963` | bounded window + per-conversation session (`21a5eaf`) + causal ordering fix |
| CX-01 routing | `feat/conv-01-routing` | `a71d9a1` | replyKind, discussion guard, ack purposes, guard regression (`7f569e9`, `4a933d1`, `a71d9a1`) |
| PL-01 plan store | `feat/plan-01-store` | `5c8fece` | schema/service/API/CLI + review fixes, rebased on CX-01 (`26fb0f5`, `ef362cc`, `5c8fece`) |
| PL-02 executor | `feat/plan-02-executor` | `40891da` | child-task executor, shared budgets, progress/replan, model-proposed drafts, review-hardened cancellation/settlement and idempotent schema upgrade (`5ef92ed`…`40891da`) |
| Acceptance record | `docs/exp-01-evidence` | merged via #110 | docs only |
| CX-02 revision | `feat/cx-02-plan-revision` | merged via #112 (`acc5bd6`) | chat draft revision + atomic running-safe /plan replan with durable orphan cleanup + PlanDiff, budget-preserving, conversation-scoped refs |

CX-01/PL-01/PL-02 were merged to main at `a0b6bdf` via #106–#110; CX-02 was merged via #112 at `acc5bd6`. A real acceptance run must record the actual deployed/main SHA instead of a branch tip.

## Implementation progress (2026-11-22)

| Workstream | Status | Evidence |
| --- | --- | --- |
| CX-01 conversation context/routing | ✅ merged #106–#107 | `conversation-window.test.ts`, `conv-01-routing.test.ts` |
| CX-02 plan draft/revision UX | ✅ merged #112 | `plan-query.test.ts` draft/revise/replan/diff cases |
| PL-01 Plan store/DAG/API/CLI | ✅ merged #108 | `plans.test.ts`, `plans-api.test.ts`, `cli.test.ts` |
| PL-02 bounded execution | ✅ merged #109 | `plan-executor.test.ts`, tool-budget case |
| PL-03 replan/pause/resume/cancel/recovery | ✅ delivered with PL-02/CX-02 | bounded replan, running-safe stop, superseded/orphan sweep, phase tests |
| ACC-01 real acceptance | 🔶 prerequisites PASS; E3/E4 BLOCKED | runbook record; #92 remains open |

## Commands and results

| Branch | Command | Result |
| --- | --- | --- |
| `feat/conv-01-routing` | `npm run typecheck` | pass |
| `feat/conv-01-routing` | `npm test` | 534 tests pass |
| `feat/plan-01-store` | `npm run typecheck` | pass |
| `feat/plan-01-store` | `npm test` | 536 tests pass |
| `feat/plan-02-executor` | `npm run typecheck` | pass |
| `feat/plan-02-executor` | `npm test` | 582 tests pass |
| `feat/cx-02-plan-revision` | `npm test` | 600 tests pass |
| all | `node --test apps/agent/test/plans.test.ts apps/agent/test/plan-executor.test.ts apps/agent/test/plans-api.test.ts` | 39 tests pass |

Environment: macOS x64, local Node, `:memory:` SQLite for tests, `FakeRuntime` for model answers. No provider call, no Feishu send, no GitHub request.

## C01–C12 evidence

| Case | Grade | Evidence | Status |
| --- | --- | --- | --- |
| C01 普通聊天 6 轮、不误建 Task | E1 | `conv-01-routing.test.ts` — 6-turn scripted flow; only the explicit “开始执行” turn creates a Task; restart restores the window; a second chat sees an empty window | PARTIAL (E1 pass, E3 blocked) |
| C02 讨论→3–5 step Plan、草稿非执行 | E1 | `plan-query.test.ts` — a `draft_plan` Router decision persists a validated draft and creates no child task; a misrouted state question is redirected before any draft; `plans.test.ts`/`plans-api.test.ts` cover creation/activation separation | PARTIAL (E1 pass, E3 blocked) |
| C03 修改计划、PlanDiff、旧版本失效 | E1 | `plans.test.ts` “revision supersedes…”; `plans-api.test.ts` pause+revise+diff, partial budget merge, superseded 409, explicit stopOpenSteps; `plan-query.test.ts` chat `revise_plan` + PlanDiff, atomic running-safe `/plan replan <id> confirm`, stale-replan rollback, completed/budget preservation, natural/ordinal/exact/conversation-scoped task refs, multi-draft/draft+active asks, parent-aware guidance; `plan-executor.test.ts` superseded sweep stops post-commit orphan children | PARTIAL (E1 pass, E3 blocked) |
| C04 依赖步骤执行、真实 receipts、Worker 不能自证 | E1 | `plan-executor.test.ts` — A→B→C chain as child Tasks; final step proves the parent completion criteria; parent settles only from that verified child | BLOCKED for E3 — uses `FakeRuntime` and no GitHub/State receipts |
| C05 忙时进度追问、不编造状态 | E1 | `plan-query.test.ts` — natural progress question answers from persisted Plan/Step state with no Worker/model call; `/plans`, `/plan <id>`, `/plan diff`; cross-conversation isolation | PARTIAL (E1 pass, no real busy-Worker E3) |
| C06 补充、暂停/继续/取消、seq/fencing | E1 | `plans.test.ts` pause/resume/cancel + stale input/revision rejection; `plan-executor.test.ts` mid-run supplement creates a new active version, cancels the stale child, and preserves completed steps; `plan-query.test.ts` chat supplement/`revise_plan` produce a PlanDiff; TaskService retains input barriers/fencing | PARTIAL (E1 pass for supplement/revision wiring, real Feishu E3 pending) |
| C07 429/403/head 漂移、有限重规划 | E1 | `plan-executor.test.ts` one bounded recovery version on 429, permission 403 pauses for owner review, recovery cap stops a second automatic attempt; `plans.test.ts` preserves completed steps and refuses budget expansion; real 429/head-drift input still pending | PARTIAL (E1 pass for automatic recovery/classification, real external failure E3 pending) |
| C08 重启恢复、不重复外部写 | E1 | `plan-executor.test.ts` sweep re-arms an active plan; Plan/Step/child rows persist | PARTIAL — no process-kill/E4 run |
| C09 权限与预算、fail-closed | E1 | `plan-executor.test.ts` shared model-call budget: second step cannot call the model; no external write path in tests | PARTIAL — real credential/scope and unattended budget gates not exercised |
| C10 多项目/跨会话隔离、歧义不猜 | E1 | `conversation-window.test.ts` owner/conversation window isolation; `plans.test.ts` owner-scoped get/list/activate; plan projectKey inherited from the parent mandate | PARTIAL — no multi-project real run |
| C11 真实 GitHub 项目评估、草稿不写 Issue | E3 | Existing real read-only review record: `docs/acceptance/2026-11-22-real-project-review.md` (not through this plan/conversation stack) | BLOCKED for this stack — requires owner-authorized binding + real model + Feishu |
| C12 效果与成本 baseline | — | No real model/token/cost/latency record for these flows | BLOCKED |

## E3/E4 blockers

The following are required before any C01–C12 case can be marked E3/E4 PASS:

- Owner Feishu app credentials and a real inbound/outbound private chat (`FEISHU_APP_ID/SECRET`, `OWNER_FEISHU_OPEN_ID`, long connection, `/healthz` ok).
- A real model provider key and explicit budget authorization for unattended/paid calls.
- An active owner-scoped ProjectBinding with a read credential and immutable repository id; a real GitHub read run at a fixed SHA.
- For C06/C07/C08: a controlled process restart and external failure simulation on the real channel.
- For C12: real usage/cost/latency capture; no number may be estimated.

No `.env`, token, chat text or provider response is recorded here.

## Known gaps before claiming PL-01/PL-02 complete

- A plan draft must target an existing task; creating a new task and a plan in one model decision is not supported.
- Automatic recovery is limited to one new version per lineage and only for retryable external errors; real 429/head-drift input and the resulting PlanDiff still need E3 evidence.
- Permission/credential failures and exhausted automatic recovery pause the plan and move the parent task to `needs_review`; owner acknowledgement/cancellation remains the exit.
- Plan progress is deterministic chat/API output; it is not a model-generated conversational answer (intentionally avoids inventing state).
- Ready steps dispatch as child Tasks under the global Worker cap; the tests exercise dependent chains, not parallel-ready-step contention end-to-end.
- Review hardening added: stable parent-task budget lineage, ExtensionPolicy inheritance, activation/revise guards, final-step parent mandate, stale-tick fail-closed, and atomic/sweep-repaired settlement. These are E1-only until a real run repeats them.
- The final step always uses the parent completion criteria; a plan without a final step that can prove them settles `needs_review`.
- The final step deliberately runs with the parent mandate so the parent verifier cannot be weakened; a final step declared with no tools may therefore invoke parent read tools. External writes still require ActionService approval.
- Migration compatibility is covered from schema 18 and from both schema-23 shapes (column absent and column already present); the upgrade is conditional (sqlite_master, not PRAGMA) and backfills legacy plan-step children to `plan:<parentTaskId>`.
- Sweep clears running/ready steps under superseded versions from intermediate-branch data, so a later version can activate; revise/resume reject an in-flight parent action in tests.

## Next evidence step

Merge/redeploy the CX-01/PL-01/PL-02 stack, then execute `docs/22-mvp-acceptance-runbook.md` §9 with the real owner credentials. Only then update this table to E3/E4 and record Feishu message ids, Task/Step/Action ids, model/cost, and the exact commit.
