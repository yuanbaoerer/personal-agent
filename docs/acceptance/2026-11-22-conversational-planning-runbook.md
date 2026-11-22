# 2026-11-22 · Conversational & Autonomous Planning runbook execution

> Scope: execute `docs/22-mvp-acceptance-runbook.md` §9 against merged main and record exactly how far the real E3/E4 path could proceed.
> **Result: prerequisites PASS; C01 is E3 PASS; C02–C10 remain pending; C04/C11/C12 and E4 remain BLOCKED.** No mock, injected Feishu event, or synthetic owner message was used. This record must not be read as a full Pilot pass.

## Environment

| Field | Value |
| --- | --- |
| main | `cd4cb16` (all CX/PL/CX-02 work merged; docs-only merge after `acc5bd6`) |
| Service | `npm start`, long connection, health OK |
| Model | `opencode-go/deepseek-v4.1-flash` |
| Feishu | app credentials configured; event mode `long_connection`; owner bound |
| Database | live `data/agent.sqlite`, schema `17 → 25` after restart; backup taken before migration |
| GitHub plugin | `disabled`, connection `unconfigured` (`no allowed repositories`) |
| ProjectBinding | none |
| Writes | none |

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
| C02/C03 plan draft/revision | PENDING | Draft/revision E1 exists; requires the owner to send the C02/C03 Feishu turns next |
| C05–C10 remaining chat cases | PENDING | Require further owner Feishu turns (progress, pause/replan, restart, isolation) |
| C04 bounded read-only execution | BLOCKED | No GitHub ProjectBinding / allowed repo / credential; state-only plan execution was not substituted for the runbook |
| C11 real GitHub project review | BLOCKED | `github` plugin disabled and unconfigured; `GITHUB_ALLOWED_REPOS` empty; no binding |
| C12 cost/effects baseline | BLOCKED | No real conversation/plan run; no token/latency data to record |
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

Only C01 is claimed E3 PASS. C02–C12 and E4 are not. The run also proved that merged main starts on the existing live database, migrates it, and exposes the plan/status surfaces.

## Owner prerequisites for the next run

1. Configure a read-only GitHub repository allowlist and credential, then bind a project (per runbook §6), or explicitly accept that C04/C11 stay blocked.
2. C01 is complete; next send the C02/C03 plan-draft/revision sequence in the owner Feishu private chat.
3. Approve one read-only plan for C04, then exercise progress/pause/resume/replan for C05–C07.
4. Perform the controlled restart for C08 and record Plan/Step/Outbox ids before/after.
5. Record Feishu message ids, Task/Step/Action ids, model/cost, and the actual commit in this file; only then move rows to E3/E4.

## Service state after the run

The merged-main service is left running on `127.0.0.1:8787` with the migrated database. The pre-run database backup remains at `data/agent.sqlite.pre-runbook.bak` (local, not committed).
