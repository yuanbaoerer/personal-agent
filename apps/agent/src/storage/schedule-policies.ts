import { randomUUID } from "node:crypto";

import type {
  ScheduleCadence,
  SchedulePolicyRecord,
  SchedulePolicyRunRecord,
  SchedulePolicyStatus,
  ScheduleRunStatus,
} from "../domain/types.ts";
import type { Db } from "./db.ts";

interface PolicyRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  timezone: string;
  cadence: ScheduleCadence;
  local_time: string;
  repo: string;
  goal: string;
  status: SchedulePolicyStatus;
  version: number;
  expires_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  policy_id: string;
  scheduled_at: string;
  task_id: string | null;
  status: ScheduleRunStatus;
  created_at: string;
}

function mapPolicy(row: PolicyRow): SchedulePolicyRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    timezone: row.timezone,
    cadence: row.cadence,
    localTime: row.local_time,
    repo: row.repo,
    goal: row.goal,
    status: row.status,
    version: Number(row.version),
    expiresAt: row.expires_at,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): SchedulePolicyRunRecord {
  return {
    policyId: row.policy_id,
    scheduledAt: row.scheduled_at,
    taskId: row.task_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface NewSchedulePolicyInput {
  ownerId: string;
  conversationId: string;
  timezone: string;
  cadence: ScheduleCadence;
  localTime: string;
  repo: string;
  goal: string;
  expiresAt: string;
  createdAt: string;
}

export interface SchedulePolicyChanges {
  timezone: string;
  cadence: ScheduleCadence;
  localTime: string;
  repo: string;
  goal: string;
  expiresAt: string;
}

export class SchedulePolicyRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insertDraft(input: NewSchedulePolicyInput): SchedulePolicyRecord {
    const row = this.#db.all<PolicyRow>(
      `INSERT INTO pa_schedule_policies
        (id, owner_id, conversation_id, timezone, cadence, local_time, repo, goal,
         status, version, expires_at, next_run_at, last_run_at, confirmed_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, NULL, NULL, NULL, ?, ?)
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.conversationId,
      input.timezone,
      input.cadence,
      input.localTime,
      input.repo,
      input.goal,
      input.expiresAt,
      input.createdAt,
      input.createdAt,
    )[0];
    if (row === undefined) {
      throw new Error("schedule policy insert returned no row");
    }
    return mapPolicy(row);
  }

  get(id: string): SchedulePolicyRecord | undefined {
    const row = this.#db.all<PolicyRow>(
      "SELECT * FROM pa_schedule_policies WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : mapPolicy(row);
  }

  listByOwner(ownerId: string, limit = 50, offset = 0): SchedulePolicyRecord[] {
    return this.#db
      .all<PolicyRow>(
        `SELECT * FROM pa_schedule_policies
         WHERE owner_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
        ownerId,
        limit,
        offset,
      )
      .map(mapPolicy);
  }

  countsByOwner(ownerId: string): Record<SchedulePolicyStatus, number> {
    const counts: Record<SchedulePolicyStatus, number> = {
      draft: 0,
      active: 0,
      paused: 0,
      cancelled: 0,
      expired: 0,
    };
    const rows = this.#db.all<{ status: SchedulePolicyStatus; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM pa_schedule_policies
       WHERE owner_id = ?
       GROUP BY status`,
      ownerId,
    );
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  listDue(now: string, limit = 50): SchedulePolicyRecord[] {
    return this.#db
      .all<PolicyRow>(
        `SELECT * FROM pa_schedule_policies
         WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
        now,
        limit,
      )
      .map(mapPolicy);
  }

  nextDueAt(): string | undefined {
    return this.#db.all<{ next_run_at: string }>(
      `SELECT next_run_at FROM pa_schedule_policies
       WHERE status = 'active' AND next_run_at IS NOT NULL
       ORDER BY next_run_at ASC LIMIT 1`,
    )[0]?.next_run_at;
  }

  /**
   * Any edit invalidates the prior confirmation: status returns to draft and
   * the version increments. Old in-flight actions fail their provenance check.
   */
  updateToDraft(
    id: string,
    ownerId: string,
    changes: SchedulePolicyChanges,
    now: string,
  ): SchedulePolicyRecord | undefined {
    const row = this.#db.all<PolicyRow>(
      `UPDATE pa_schedule_policies
       SET timezone = ?, cadence = ?, local_time = ?, repo = ?, goal = ?,
           expires_at = ?, status = 'draft', version = version + 1,
           next_run_at = NULL, confirmed_at = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status IN ('draft', 'active', 'paused')
       RETURNING *`,
      changes.timezone,
      changes.cadence,
      changes.localTime,
      changes.repo,
      changes.goal,
      changes.expiresAt,
      now,
      id,
      ownerId,
    )[0];
    return row === undefined ? undefined : mapPolicy(row);
  }

  activate(
    id: string,
    ownerId: string,
    expectedVersion: number,
    nextRunAt: string,
    now: string,
  ): SchedulePolicyRecord | undefined {
    const row = this.#db.all<PolicyRow>(
      `UPDATE pa_schedule_policies
       SET status = 'active', next_run_at = ?, confirmed_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'draft' AND version = ?
       RETURNING *`,
      nextRunAt,
      now,
      now,
      id,
      ownerId,
      expectedVersion,
    )[0];
    return row === undefined ? undefined : mapPolicy(row);
  }

  pause(id: string, ownerId: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedule_policies
         SET status = 'paused', next_run_at = NULL, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'active'`,
        now,
        id,
        ownerId,
      ) > 0
    );
  }

  resume(
    id: string,
    ownerId: string,
    nextRunAt: string,
    now: string,
  ): SchedulePolicyRecord | undefined {
    const row = this.#db.all<PolicyRow>(
      `UPDATE pa_schedule_policies
       SET status = 'active', next_run_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'paused'
       RETURNING *`,
      nextRunAt,
      now,
      id,
      ownerId,
    )[0];
    return row === undefined ? undefined : mapPolicy(row);
  }

  cancel(id: string, ownerId: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedule_policies
         SET status = 'cancelled', next_run_at = NULL, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status IN ('draft', 'active', 'paused')`,
        now,
        id,
        ownerId,
      ) > 0
    );
  }

  markExpired(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedule_policies
         SET status = 'expired', next_run_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('draft', 'active', 'paused')`,
        now,
        id,
      ) > 0
    );
  }

  /**
   * Compare-and-swap on the occurrence that was just fired, so a duplicate
   * alarm cannot advance the same policy twice or create a second task.
   */
  advance(
    id: string,
    scheduledAt: string,
    nextRunAt: string | undefined,
    now: string,
  ): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedule_policies
         SET last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND next_run_at = ?`,
        scheduledAt,
        nextRunAt ?? null,
        now,
        id,
        scheduledAt,
      ) > 0
    );
  }

  recordRun(
    policyId: string,
    scheduledAt: string,
    status: ScheduleRunStatus,
    taskId: string | undefined,
    now: string,
  ): { inserted: boolean; run: SchedulePolicyRunRecord } {
    const row = this.#db.all<RunRow>(
      `INSERT INTO pa_schedule_policy_runs
        (policy_id, scheduled_at, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (policy_id, scheduled_at) DO NOTHING
       RETURNING *`,
      policyId,
      scheduledAt,
      taskId ?? null,
      status,
      now,
    )[0];
    if (row !== undefined) {
      return { inserted: true, run: mapRun(row) };
    }
    const existing = this.getRun(policyId, scheduledAt);
    if (existing === undefined) {
      throw new Error("schedule run conflicted without a row");
    }
    return { inserted: false, run: existing };
  }

  getRun(policyId: string, scheduledAt: string): SchedulePolicyRunRecord | undefined {
    const row = this.#db.all<RunRow>(
      `SELECT * FROM pa_schedule_policy_runs
       WHERE policy_id = ? AND scheduled_at = ?`,
      policyId,
      scheduledAt,
    )[0];
    return row === undefined ? undefined : mapRun(row);
  }

  attachTask(policyId: string, scheduledAt: string, taskId: string): void {
    this.#db.run(
      `UPDATE pa_schedule_policy_runs SET task_id = ?, status = 'dispatched'
       WHERE policy_id = ? AND scheduled_at = ?`,
      taskId,
      policyId,
      scheduledAt,
    );
  }

  listRuns(policyId: string, limit = 20): SchedulePolicyRunRecord[] {
    return this.#db
      .all<RunRow>(
        `SELECT * FROM pa_schedule_policy_runs
         WHERE policy_id = ? ORDER BY scheduled_at DESC LIMIT ?`,
        policyId,
        limit,
      )
      .map(mapRun);
  }
}
