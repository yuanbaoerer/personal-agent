# 2026-11-22 · Conversational & Autonomous Planning runbook execution

> Scope: execute `docs/22-mvp-acceptance-runbook.md` §9 against merged main and record exactly how far the real E3/E4 path could proceed.
> **Result: prerequisites PASS; C01–C03 are E3 PASS; C04 is PARTIAL (A/B real GitHub reads verified, final synthesis failed); C11 is PARTIAL; C05–C10 remain pending; C12 and E4 remain BLOCKED.** No mock, injected Feishu event, or synthetic owner message was used. This record must not be read as a full Pilot pass.

## Environment

| Field | Value |
| --- | --- |
| main | `015de75` (verifier CJK URL fix merged; run used the fix on top of `fcdd278`) |
| Service | `npm start`, long connection, health OK |
| Model | `opencode-go/deepseek-v4.1-flash` |
| Feishu | app credentials configured; event mode `long_connection`; owner bound |
| Database | live `data/agent.sqlite`, schema `17 → 25` after restart; backup taken before migration |
| GitHub plugin | `enabled`, generation 2, connection `connected`, `activeTools=["github.read"]` |
| ProjectBinding | `personal-agent → yuanbaoerer/personal-agent`, repoId `1445007789`, branch `main`, credential `github:default` |
| Writes | none; all GitHub actions were `github.read` GETs |

## Executed

1. Backed up the live database, stopped the previous 3-day-old service, started the merged-main service.
2. `npm run preflight` → `preflight_ok`; checks `config_parsed`, `owner_bound`, `agent_data_writable`, `pi_data_writable`; warning `MAGPIE_URL is unset`.
3. `GET /healthz` → `{"ok":true}` after restart; service log: `listening`, `event-dispatch is ready`.
4. Live schema check → `schema_version=25`; `pa_plans`, `pa_plan_steps`, `pa_plan_diffs` all exist.
5. `pa status` → no queued/running/failed tasks, no pending effects or confirmations.
6. `pa projects list` → “No projects.”
7. `pa plugins status github --json` → `disabled`, connection `unconfigured` (“no allowed repositories”), `activeTools=[]`.

## C01–C12 result

| Case | Result | Evidence / blocker |
| --- | --- | --- |
| Prerequisites / restart | PASS | Health OK; live DB migrated 17→25; no pending work lost; service log shows long-connection dispatcher ready |
| C01 six-turn chat, no unintended Task | **PASS (E3)** | 6 real inbound / 6 real result outbound in the owner Feishu p2p chat; 0 new Task/Action/Plan; turn 5 referenced the earlier “先做减法” advice; turn 6 produced a three-step summary. See evidence table below |
| C02 three-step plan draft, non-executing | **PASS (E3)** | Real Feishu turn produced a 3-step A→B→C draft with deps/tools/resources/verifier and 0 actions; parent task remained queued. Evidence below |
| C03 revise draft + PlanDiff | **PASS (E3)** | Follow-up turn produced v2 draft, v1 superseded, persisted `PlanDiff v1 -> v2` (A unchanged, B/C goal changed), 0 actions. Evidence below |
| C05–C10 remaining chat cases | PENDING | Require further owner Feishu turns (progress, pause/replan, restart, isolation) |
| C04 bounded read-only execution | **PARTIAL (E3)** | Plan `e1ba272e` v1 on parent `543a1221`; A `a4d5f457` PASS `github-read`; B `90438db5` PASS `github-read` with 14 structured claims; C `2cc28839` FAILED after 3 attempts. 23 `github.read` GET receipts, 0 POST. Details below |
| C11 real GitHub project review | **PARTIAL** | Real issues/pulls/checks/file reads succeeded and B verified; no final review report because C failed. Not a C11 PASS |
| C12 cost/effects baseline | BLOCKED | Real conversations and a partial plan ran, but model usage/cost was not persisted and no complete cost and latency baseline was recorded. |
| E4 plan recovery | NOT TESTED | Service restart succeeded, but no active plan/step existed to recover |

### C01 evidence (2026-11-22T12:44:10Z–12:53:33Z)

| # | inbox prefix | outbox prefix | platform msg prefix | turn |
| --- | --- | --- | --- | --- |
| 1 | `8e83fd44-bcd` | `781207bc-f77` | `om_x100b7f1a74f0` | GitHub issue/PR request → fail-closed refusal |
| 2 | `81518063-fe7` | `97cf5331-551` | `om_x100b7f1a72bd` | capability list |
| 3 | `4b6b0dc7-b93` | `22db0b6f-6aa` | `om_x100b7f1a0f83` | personal-project advice |
| 4 | `8e2213f9-010` | `06c8ecc2-133` | `om_x100b7f1a03fc` | code-edit request → refusal |
| 5 | `e9d94c51-76f` | `75096b78-ecc` | `om_x100b7f1a1519` | “第一步” referenced the earlier “先做减法” advice |
| 6 | `b6162943-914` | `5d90b9bf-b4d` | `om_x100b7f1a1228` | three-step summary, explicitly non-executing |

Counts at check time: 6 accepted inbound, 6 accepted `result` outbound, 6 bootstrap `ack` rows; `pa_tasks` has only the pre-existing 2026-11-19 succeeded task; `pa_actions=0`, `pa_plans=0`, `pa_plan_steps=0`. Model usage/cost was not persisted, so C12 has no number.

### C02/C03 evidence (2026-11-22T13:10:49Z–13:11:24Z)

The parent task `9c5bb3d0-6025-4453-ad41-b27adec69750` was created as a **queued, undispatched** fixture so the plan had a legal Parent Task; no worker ran it.

| # | inbox prefix | outbox prefix | platform msg prefix | result |
| --- | --- | --- | --- | --- |
| C02 | `0cc951ef-444b` | `f581ead0` | `om_x100b7f1ad0a1` | plan `5b1373e9` v1 draft, 3 steps A→B→C, deps `[]/["A"]/["B"]`, tools `[]`, resources `["chat"]`, verifier `structural`, all blocked |
| C03 | `af7639d3-85a7` | `a7f9b394` | `om_x100b7f1ad118` | plan `e51e3a07` v2 draft, v1 superseded, `PlanDiff v1 -> v2`: A unchanged, B/C goal changed |

At check time: `pa_actions=0`; the only non-old task is the queued parent; no child task was created because the plan was never activated. C02/C03 are E3 PASS for plan draft/PlanDiff UX; plan execution was attempted later as C04 (PARTIAL, below).

### C04/C11 evidence (2026-11-22T16:26:22Z–16:30:39Z)

Plan `e1ba272e-8df6-40a3-a331-fb823907de3b` v1, parent `543a1221-8dbd-4f79-9fff-34baf261064a`, project `personal-agent`, budget 3 steps / 1 attempt / 300s, approved scope `task:543a1221...:rev:1:plan:1`.

| Step | Task | Result |
| --- | --- | --- |
| A | `a4d5f457` | **PASS** `github-read`; file receipts for `docs/24` and `docs/21` at `fcdd278...` with source URLs |
| B | `90438db5` | **PASS** `github-read`; issues + pulls receipts, 14 structured claims matched |
| C | `2cc28839` | **FAILED** after 3 attempts; checks `a02a53d0`, `9ceeaf34` and pull-files `16c922e3` succeeded, but the worker exhausted attempts before a verifier-ready synthesis |

All 23 actions on this plan were `github.read`; the receipt set contains `ref`, `file`, `issues`, `pulls`, `checks`, `pull_files`. No write tool, POST, issue/comment, or merge was proposed or executed. Parent `543a1221` failed with plan verdict `step C failed after 1 attempt(s)`; plan `e1ba272e` is paused.

The run also found and fixed a verifier defect: source URLs followed by Chinese punctuation (for example `source=https://github.com/owner/repo，返回`) were not recognized because the URL regex stopped only at ASCII whitespace/quotes. PR #119 (`fix(verifier): parse GitHub source URLs before CJK punctuation`) adds the parser fix and a regression test; it is merged in `015de75`.

C04 is **PARTIAL**, not PASS: A/B prove the real read-only plan path and verifier, but C did not produce the final review. C11 is likewise PARTIAL because no final project review was delivered.

Only C01–C03 are claimed E3 PASS; C04/C11 are PARTIAL. C05–C12 and E4 are not claimed.

## Owner prerequisites for the next run

1. GitHub is configured and bound; keep the read-only PAT scoped to `yuanbaoerer/personal-agent` and rotate it after acceptance.
2. C01–C03 are complete.
3. C04/C11 need a simplified final synthesis step: one read-only receipt followed by an immediate `ready` report with source URLs and claims, without extra exploratory reads. A/B are already PASS; only C remains.
4. Then exercise progress/pause/resume/replan for C05–C07.
5. Perform the controlled restart for C08 and record Plan/Step/Outbox ids before/after.
6. Record Feishu message ids, Task/Step/Action ids, model/cost, and the actual commit in this file; only then move rows to E3/E4.

## Service state after the run

The merged-main service is left running on `127.0.0.1:8787` with the migrated database. The pre-run database backup remains at `data/agent.sqlite.pre-runbook.bak` (local, not committed).
