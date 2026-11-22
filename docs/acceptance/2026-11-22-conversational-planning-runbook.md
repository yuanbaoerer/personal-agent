# 2026-11-22 · Conversational & Autonomous Planning runbook execution

> Scope: execute `docs/22-mvp-acceptance-runbook.md` §9 against merged main and record exactly how far the real E3/E4 path could proceed.
> **Result: prerequisites PASS; every owner-interactive E3 case and the GitHub case remain BLOCKED.** No mock, injected Feishu event, or synthetic owner message was used. This record must not be read as a Pilot pass.

## Environment

| Field | Value |
| --- | --- |
| main | `a0b6bdf` (merge #110; stack #106–#110 merged) |
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
| C01–C03, C05–C10 | BLOCKED | Require owner messages typed in the real Feishu private chat. No inbound messages were generated for this run; fake/injected events are not E3 |
| C04 bounded read-only execution | BLOCKED | No GitHub ProjectBinding / allowed repo / credential; state-only plan execution was not substituted for the runbook |
| C11 real GitHub project review | BLOCKED | `github` plugin disabled and unconfigured; `GITHUB_ALLOWED_REPOS` empty; no binding |
| C12 cost/effects baseline | BLOCKED | No real conversation/plan run; no token/latency data to record |
| E4 plan recovery | NOT TESTED | Service restart succeeded, but no active plan/step existed to recover |

No E3/E4 PASS is claimed. The run did prove that merged main starts on the existing live database, migrates it, and exposes the plan/status surfaces.

## Owner prerequisites for the next run

1. Configure a read-only GitHub repository allowlist and credential, then bind a project (per runbook §6), or explicitly accept that C04/C11 stay blocked.
2. In the owner Feishu private chat, send the six-turn C01 sequence and the C02/C03 plan-draft sequence.
3. Approve one read-only plan for C04, then exercise progress/pause/resume/replan for C05–C07.
4. Perform the controlled restart for C08 and record Plan/Step/Outbox ids before/after.
5. Record Feishu message ids, Task/Step/Action ids, model/cost, and the actual commit in this file; only then move rows to E3/E4.

## Service state after the run

The merged-main service is left running on `127.0.0.1:8787` with the migrated database. The pre-run database backup remains at `data/agent.sqlite.pre-runbook.bak` (local, not committed).
