# 2026-11-22 · Conversational & Autonomous Planning — E1 record (E3/E4 BLOCKED)

> Scope: deterministic/scripted E1 evidence for CX-01 (#89), PL-01 (#90) and PL-02 (#91).
> **No real Feishu inbound/outbound, real model Worker, or real GitHub read was exercised in this record.** Every E3/E4 cell below stays BLOCKED; this file must not be used to claim the Conversational/Planning MVP Pilot.

## Branch stack and commit SHAs

| Workstream | Branch | Tip | Notes |
| --- | --- | --- | --- |
| Planning docs | `main` after #94 | `de23f1d` | docs/28 P0-A…D |
| CX-01 context | `feat/conv-01-context` | `af38963` | bounded window + per-conversation session (`21a5eaf`) + causal ordering fix |
| CX-01 routing | `feat/conv-01-routing` | `a71d9a1` | replyKind, discussion guard, ack purposes, guard regression (`7f569e9`, `4a933d1`, `a71d9a1`) |
| PL-01 plan store | `feat/plan-01-store` | `1b793b0` | schema/service/API/CLI + review fixes (`20c0af7`, `7be79d5`, `1b793b0`) |
| PL-02 executor | `feat/plan-02-executor` | `0a6e883` | child-task executor, shared budgets, restart sweep |
| Acceptance record | `docs/exp-01-evidence` | this commit | docs only |

These branches are not merged. A real acceptance run must record the actual deployed/main SHA instead.

## Commands and results

| Branch | Command | Result |
| --- | --- | --- |
| `feat/conv-01-routing` | `npm run typecheck` | pass |
| `feat/conv-01-routing` | `npm test` | 534 tests pass |
| `feat/plan-01-store` | `npm run typecheck` | pass |
| `feat/plan-01-store` | `npm test` | 536 tests pass |
| `feat/plan-02-executor` | `npm run typecheck` | pass |
| `feat/plan-02-executor` | `npm test` | 541 tests pass |
| all | `node --test apps/agent/test/plans.test.ts apps/agent/test/plan-executor.test.ts apps/agent/test/plans-api.test.ts` | 21 tests pass |

Environment: macOS x64, local Node, `:memory:` SQLite for tests, `FakeRuntime` for model answers. No provider call, no Feishu send, no GitHub request.

## C01–C12 evidence

| Case | Grade | Evidence | Status |
| --- | --- | --- | --- |
| C01 普通聊天 6 轮、不误建 Task | E1 | `conv-01-routing.test.ts` — 6-turn scripted flow; only the explicit “开始执行” turn creates a Task; restart restores the window; a second chat sees an empty window | PARTIAL (E1 pass, E3 blocked) |
| C02 讨论→3–5 step Plan、草稿非执行 | E1 | `plans.test.ts` — draft creation, blocked steps, activation separate; `plans-api.test.ts` — `POST /plans` returns draft | PARTIAL — no Router/natural-language path to persist a plan yet; only API/CLI |
| C03 修改计划、PlanDiff、旧版本失效 | E1 | `plans.test.ts` “revision supersedes…”; `plans-api.test.ts` revise + diff; `pa_plan_diffs` persisted | PARTIAL (E1 pass, E3 blocked) |
| C04 依赖步骤执行、真实 receipts、Worker 不能自证 | E1 | `plan-executor.test.ts` — A→B→C chain as child Tasks; final step proves the parent completion criteria; parent settles only from that verified child | BLOCKED for E3 — uses `FakeRuntime` and no GitHub/State receipts |
| C05 忙时进度追问、不编造状态 | — | No owner-facing plan progress query (`/plan`, `/plans`, API read exists but no natural-language handler) | NOT IMPLEMENTED |
| C06 补充、暂停/继续/取消、seq/fencing | E1 | `plans.test.ts` pause/resume/cancel + stale input/revision rejection; `plan-executor.test.ts` cancel settles parent and children; TaskService retains input barriers/fencing | PARTIAL — mid-run supplement→plan revision is not wired |
| C07 429/403/head 漂移、有限重规划 | E1 | `plan-executor.test.ts` failed step → `paused` + parent failed; plan step retry limit | PARTIAL — no external-error-driven PlanDiff/replan; no 429/403 simulation |
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

- Router has no `propose_plan` → persisted `PlanService.create` bridge; `plan_proposal` is still text-only.
- No owner-facing Feishu plan query/handler (API + `pa plans` only).
- Replan is limited to revision before/while active; external-error-driven PlanDiff is not implemented.
- Steps are dispatched sequentially through child Tasks; parallel ready steps are bounded by TaskService capacity, not asserted end-to-end.
- The final step always uses the parent completion criteria; a plan without a final step that can prove them settles `needs_review`.
- Tool-call budget is shared by `ActionRepository.countByPlan`, but has no dedicated executor test yet.

## Next evidence step

Merge/redeploy the CX-01/PL-01/PL-02 stack, then execute `docs/22-mvp-acceptance-runbook.md` §9 with the real owner credentials. Only then update this table to E3/E4 and record Feishu message ids, Task/Step/Action ids, model/cost, and the exact commit.
