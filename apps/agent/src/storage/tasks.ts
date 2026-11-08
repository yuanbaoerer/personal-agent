import { randomUUID } from "node:crypto";

import type {
  AssignmentRecord,
  AssignmentStatus,
  Mandate,
  TaskRecord,
  TaskStatus,
  WorkerReport,
} from "../domain/types.ts";
import type { Db, SqlRow } from "./db.ts";

interface TaskRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  source_key: string;
  goal: string;
  completion_criteria: string;
  mandate_json: string;
  revision: number;
  status: TaskStatus;
  priority: number;
  attempts: number;
  deadline: string | null;
  budget_json: string | null;
  result_ref: string | null;
  owner_input: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: string;
  task_id: string;
  task_revision: number;
  session_id: string;
  attempt: number;
  status: AssignmentStatus;
  lease_until: string;
  fencing_token: number;
  report_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    sourceKey: row.source_key,
    goal: row.goal,
    completionCriteria: row.completion_criteria,
    mandate: JSON.parse(row.mandate_json) as Mandate,
    revision: Number(row.revision),
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    deadline: row.deadline ?? undefined,
    budget: row.budget_json === null ? undefined : (JSON.parse(row.budget_json) as Record<string, unknown>),
    resultRef: row.result_ref ?? undefined,
    ownerInput: row.owner_input ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskRevision: Number(row.task_revision),
    sessionId: row.session_id,
    attempt: Number(row.attempt),
    status: row.status,
    leaseUntil: row.lease_until,
    fencingToken: Number(row.fencing_token),
    report: row.report_json === null ? undefined : (JSON.parse(row.report_json) as WorkerReport),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewTaskInput {
  ownerId: string;
  conversationId: string;
  sourceKey: string;
  goal: string;
  completionCriteria: string;
  mandate: Mandate;
  priority?: number;
  deadline?: string;
  budget?: Record<string, unknown>;
  createdAt: string;
}

export interface ClaimedTask {
  task: TaskRecord;
  assignment: AssignmentRecord;
}

export class TaskRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: NewTaskInput): { inserted: boolean; task: TaskRecord } {
    const id = randomUUID();
    const rows = this.#db.all<TaskRow>(
      `INSERT INTO pa_tasks
        (id, owner_id, conversation_id, source_key, goal, completion_criteria,
         mandate_json, revision, status, priority, attempts, deadline, budget_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, 0, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING *`,
      id,
      input.ownerId,
      input.conversationId,
      input.sourceKey,
      input.goal,
      input.completionCriteria,
      JSON.stringify(input.mandate),
      input.priority ?? 0,
      input.deadline ?? null,
      input.budget === undefined ? null : JSON.stringify(input.budget),
      input.createdAt,
      input.createdAt,
    )[0];

    if (rows !== undefined) {
      return { inserted: true, task: mapTask(rows) };
    }

    const existing = this.getBySourceKey(input.sourceKey);
    if (existing === undefined) {
      throw new Error(`task source key ${input.sourceKey} conflicted without a row`);
    }
    return { inserted: false, task: existing };
  }

  get(id: string): TaskRecord | undefined {
    const row = this.#db.all<TaskRow>("SELECT * FROM pa_tasks WHERE id = ?", id)[0];
    return row === undefined ? undefined : mapTask(row);
  }

  getBySourceKey(sourceKey: string): TaskRecord | undefined {
    const row = this.#db.all<TaskRow>(
      "SELECT * FROM pa_tasks WHERE source_key = ?",
      sourceKey,
    )[0];
    return row === undefined ? undefined : mapTask(row);
  }

  listByOwner(ownerId: string, limit = 20): TaskRecord[] {
    return this.#db
      .all<TaskRow>(
        `SELECT * FROM pa_tasks
         WHERE owner_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        ownerId,
        limit,
      )
      .map(mapTask);
  }

  listRecent(limit = 20): TaskRecord[] {
    return this.#db
      .all<TaskRow>(
        `SELECT * FROM pa_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .map(mapTask);
  }

  countByStatus(status: TaskStatus): number {
    const row = this.#db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pa_tasks WHERE status = ?",
      status,
    )[0];
    return Number(row?.count ?? 0);
  }

  countActiveAssignments(): number {
    const row = this.#db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pa_assignments WHERE status = 'active'",
    )[0];
    return Number(row?.count ?? 0);
  }

  getAssignment(id: string): AssignmentRecord | undefined {
    const row = this.#db.all<AssignmentRow>(
      "SELECT * FROM pa_assignments WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : mapAssignment(row);
  }

  listActiveAssignments(taskId?: string): AssignmentRecord[] {
    const rows =
      taskId === undefined
        ? this.#db.all<AssignmentRow>(
            "SELECT * FROM pa_assignments WHERE status = 'active' ORDER BY created_at ASC",
          )
        : this.#db.all<AssignmentRow>(
            `SELECT * FROM pa_assignments
             WHERE task_id = ? AND status = 'active'
             ORDER BY created_at ASC`,
            taskId,
          );
    return rows.map(mapAssignment);
  }

  listExpiredAssignments(now: string, limit = 50): AssignmentRecord[] {
    return this.#db
      .all<AssignmentRow>(
        `SELECT * FROM pa_assignments
         WHERE status = 'active' AND lease_until <= ?
         ORDER BY lease_until ASC
         LIMIT ?`,
        now,
        limit,
      )
      .map(mapAssignment);
  }

  /**
   * Atomically move one queued task to running and create its active
   * assignment. The fencing token is monotonic per task.
   */
  claimNext(
    now: string,
    leaseMs: number,
    maxActiveWorkers: number,
    preferredTaskId?: string,
  ): ClaimedTask | undefined {
    return this.#db.transaction(() => {
      if (this.countActiveAssignments() >= maxActiveWorkers) {
        return undefined;
      }

      const taskRow = this.#db.all<TaskRow>(
        `SELECT * FROM pa_tasks
         WHERE status = 'queued' AND (? IS NULL OR id = ?)
         ORDER BY priority DESC, created_at ASC, id ASC
         LIMIT 1`,
        preferredTaskId ?? null,
        preferredTaskId ?? null,
      )[0];
      if (taskRow === undefined) {
        return undefined;
      }
      const task = mapTask(taskRow);

      const fencing = this.#db.all<{ next: number }>(
        `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next
         FROM pa_assignments WHERE task_id = ?`,
        task.id,
      )[0];
      const fencingToken = Number(fencing?.next ?? 1);
      const attempt = task.attempts + 1;
      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();

      this.#db.run(
        `UPDATE pa_tasks
         SET status = 'running', attempts = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        attempt,
        now,
        task.id,
      );

      const assignmentId = randomUUID();
      const assignmentRow = this.#db.all<AssignmentRow>(
        `INSERT INTO pa_assignments
          (id, task_id, task_revision, session_id, attempt, status, lease_until,
           fencing_token, report_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
         RETURNING *`,
        assignmentId,
        task.id,
        task.revision,
        "",
        attempt,
        leaseUntil,
        fencingToken,
        now,
        now,
      )[0];

      return {
        task: { ...task, status: "running", attempts: attempt, updatedAt: now },
        assignment: mapAssignment(assignmentRow as AssignmentRow),
      };
    });
  }

  setAssignmentSession(assignmentId: string, sessionId: string, now: string): void {
    this.#db.run(
      `UPDATE pa_assignments SET session_id = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
      sessionId,
      now,
      assignmentId,
    );
  }

  markReported(
    assignmentId: string,
    fencingToken: number,
    taskRevision: number,
    report: WorkerReport,
    now: string,
  ): AssignmentRecord | undefined {
    return this.#db.transaction(() => {
      const changes = this.#db.run(
        `UPDATE pa_assignments
         SET status = 'reported', report_json = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND fencing_token = ? AND task_revision = ?`,
        JSON.stringify(report),
        now,
        assignmentId,
        fencingToken,
        taskRevision,
      );
      if (changes === 0) {
        return undefined;
      }
      const row = this.#db.all<AssignmentRow>(
        "SELECT * FROM pa_assignments WHERE id = ?",
        assignmentId,
      )[0];
      return row === undefined ? undefined : mapAssignment(row);
    });
  }

  updateTask(
    taskId: string,
    expectedRevision: number,
    fields: {
      status?: TaskStatus;
      resultRef?: string;
      lastError?: string;
      updatedAt: string;
    },
  ): TaskRecord | undefined {
    const current = this.get(taskId);
    if (current === undefined || current.revision !== expectedRevision) {
      return undefined;
    }

    this.#db.run(
      `UPDATE pa_tasks
       SET status = COALESCE(?, status),
           result_ref = COALESCE(?, result_ref),
           last_error = ?,
           updated_at = ?
       WHERE id = ? AND revision = ?`,
      fields.status ?? null,
      fields.resultRef ?? null,
      fields.lastError ?? null,
      fields.updatedAt,
      taskId,
      expectedRevision,
    );

    return this.get(taskId);
  }

  /**
   * Append owner-supplied text for the next Worker run. A task waiting for the
   * owner returns to the queue so it can be dispatched again; any other live
   * status only records the input for the current or next assignment.
   */
  supplement(taskId: string, text: string, now: string): TaskRecord | undefined {
    return this.#db.transaction(() => {
      const current = this.get(taskId);
      if (current === undefined || isTerminal(current.status)) {
        return undefined;
      }

      const ownerInput =
        current.ownerInput === undefined || current.ownerInput.length === 0
          ? text
          : `${current.ownerInput}\n${text}`;
      const status =
        current.status === "waiting_user" || current.status === "queued"
          ? "queued"
          : current.status;

      this.#db.run(
        `UPDATE pa_tasks
         SET owner_input = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        ownerInput,
        status,
        now,
        taskId,
      );

      return this.get(taskId);
    });
  }

  /**
   * A revision change invalidates every unsent assignment and every action
   * bound to the old revision. The task returns to the queue for a fresh
   * assignment.
   */
  revise(
    taskId: string,
    changes: {
      goal?: string;
      completionCriteria?: string;
      mandate?: Mandate;
      priority?: number;
    },
    now: string,
  ): TaskRecord | undefined {
    return this.#db.transaction(() => {
      const current = this.get(taskId);
      if (current === undefined || isTerminal(current.status)) {
        return undefined;
      }

      this.#db.run(
        `UPDATE pa_assignments
         SET status = 'superseded', updated_at = ?
         WHERE task_id = ? AND status = 'active'`,
        now,
        taskId,
      );
      this.#db.run(
        `UPDATE pa_tasks
         SET goal = COALESCE(?, goal),
             completion_criteria = COALESCE(?, completion_criteria),
             mandate_json = COALESCE(?, mandate_json),
             priority = COALESCE(?, priority),
             revision = revision + 1,
             status = 'queued',
             attempts = 0,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
        changes.goal ?? null,
        changes.completionCriteria ?? null,
        changes.mandate === undefined ? null : JSON.stringify(changes.mandate),
        changes.priority ?? null,
        now,
        taskId,
      );

      return this.get(taskId);
    });
  }

  /** Persist the cancellation decision before any runtime interrupt. */
  beginCancel(taskId: string, now: string): TaskRecord | undefined {
    return this.#db.transaction(() => {
      const current = this.get(taskId);
      if (current === undefined || isTerminal(current.status)) {
        return current;
      }

      this.#db.run(
        `UPDATE pa_assignments
         SET status = 'cancelled', updated_at = ?
         WHERE task_id = ? AND status = 'active'`,
        now,
        taskId,
      );
      this.#db.run(
        `UPDATE pa_tasks
         SET status = 'cancelling', updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
        now,
        taskId,
      );
      return this.get(taskId);
    });
  }

  markCancelled(taskId: string, now: string): TaskRecord | undefined {
    this.#db.run(
      `UPDATE pa_tasks
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND status = 'cancelling'`,
      now,
      taskId,
    );
    return this.get(taskId);
  }

  extendAssignmentLease(id: string, leaseUntil: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_assignments SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        leaseUntil,
        now,
        id,
      ) > 0
    );
  }

  markAssignmentExpired(id: string, now: string): void {
    this.#db.run(
      `UPDATE pa_assignments SET status = 'expired', updated_at = ?
       WHERE id = ? AND status = 'active'`,
      now,
      id,
    );
  }

  requeueExpiredTask(taskId: string, now: string): void {
    this.#db.run(
      `UPDATE pa_tasks SET status = 'queued', updated_at = ?
       WHERE id = ? AND status = 'running'`,
      now,
      taskId,
    );
  }

  supersedeActionsForTask(taskId: string, now: string): number {
    return this.#db.run(
      `UPDATE pa_actions
       SET status = 'superseded', updated_at = ?
       WHERE task_id = ? AND status IN ('proposed', 'approved')`,
      now,
      taskId,
    );
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
