# 2026-11-24 · Empty-conversation draft/revise E3

## Environment

- Remote main `efb68b0` (includes #125, #127, #128, #129, #130, #131), run from a clean detached worktree.
- Node 26.12.0, real `.env`, live `data/agent.sqlite`, Feishu long connection reported `feishu_ws_ready`.
- The three inbound events below are real owner Feishu messages. No mock inbound, no synthetic chat.
- The service was started for this run and left running; no deploy to a remote host.

## Inbound and outbound

| Turn | Inbound ID | Platform event ID | Received (UTC) | Inbound state | Outbox receipts |
| --- | --- | --- | --- | --- | --- |
| Ordinary chat | `8861fc05-9ac9-4105-8350-b4133499fc1f` | `om_x100b7f66…` | 06:31:15.446 | accepted | ack `8544d0b1…`; result `5eb63fb4…`; both accepted |
| Draft request | `f13cf224-e808-40a9-83db-6e66737dba81` | `om_x100b7f67…` | 06:47:40.819 | accepted | ack `6816522e…`; status `70462964…`; both accepted |
| Revise request | `a3b1584b-2923-4a48-a657-923f745999f3` | `om_x100b7f67…` | 07:25:39.852 | accepted | ack `0f83bc69…`; status `7bcbea1b…`; both accepted |

Message text is intentionally not copied into this record. Full platform message IDs are kept only in the operator's live database; this record uses truncated prefixes.

## Draft correctness

- The ordinary chat created **no Task**: `pa_tasks` has 0 rows whose source key references the chat inbox.
- The draft request created parent Task `e837fa62-0e3f-4ace-8559-8186343d4d5f`
  (`inbox:f13cf224…:plan-parent`, status `waiting_external`, attempts 0) and Plan
  `da65e9ba-26dd-4073-a4be-91abe0598326` (version 1, status `draft`).
- The revise request created Plan `d4411e6d-8a76-4b93-8fbe-687554432cb0` (version 2, status `draft`),
  superseded version 1, rebound the same parent, and wrote PlanDiff
  `d4411e6d…` 1→2. The diff reports step B and C `changed` with field `goal`; step A is `unchanged`.
- Version 2 step B now says “只读检查…不修改、不写入、不登记任何内容”. The plan remains a draft.
- Parent mandate is `resources=["chat"]`, `tools=[]`; both plan versions have all steps `blocked`,
  `tools=[]`, `resources=["chat"]`, `verifierId="structural"`.
- **0 assignments and 0 actions** exist for the parent or either plan version. No Worker or external tool ran.
- The parent Task was not claimed by ordinary dispatch (`attempts=0`), and the draft is not execution authority.

## Usage snapshot

`/api/v1/usage` after the three turns:

- `tokens.collected=true`; source `router`, 3 operations.
- Total `508462` tokens; catalog-estimated cost `0.036784068`.
- No provider-billed total (`costKind=catalog`); no Worker latency samples.
- This is a Router-only snapshot for the draft turns. It is not a full C12 plan-execution cost baseline.

## Boundary

- This record is E3 for the **empty-conversation draft/revise** path (C02/C03 under the #125 path).
  It is not C04/C11, not a full plan execution, and not the complete MVP Pilot.
- The live database has project `personal-agent` bound to `yuanbaoerer/personal-agent`
  (repository ID `1445007789`, branch `main`), but `pa_github_credentials` is empty and
  `.env` has no `GITHUB_TOKEN`, `GITHUB_ALLOWED_REPOS`, or `GITHUB_CONNECTION_ENCRYPTION_KEY`.
  C04/C11 remains blocked until the owner connects a read credential and restarts the service.
- C05–C10, C12 full-run cost/latency, and E4 remain pending.
