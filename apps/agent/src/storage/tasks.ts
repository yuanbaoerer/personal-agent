import { randomUUID } from "node:crypto";

import type {
  AssignmentRecord,
  AssignmentStatus,
  Mandate,
  TaskInputKind,
  TaskInputRecord,
  TaskRecord,
  TaskStatus,
  TaskVerification,
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
  last_error: string | null;
  verification_json: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  needs_review: number;
  schedule_policy_id: string | null;
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
  dispatched_input_seq: number;
  consumed_input_seq: number;
  report_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskInputRow {
  id: string;
  task_id: string;
  seq: number;
  kind: TaskInputKind;
  source_inbox_id: string | null;
  actor_id: string | null;
  text: string;
  created_at: string;
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
    status: Number(row.needs_review) === 1 ? "needs_review" : row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    deadline: row.deadline ?? undefined,
    budget: row.budget_json === null ? undefined : (JSON.parse(row.budget_json) as Record<string, unknown>),
    resultRef: row.result_ref ?? undefined,
    lastError: row.last_error ?? undefined,
    verification:
      row.verification_json === null
        ? undefined
        : (JSON.parse(row.verification_json) as TaskVerification),
    acknowledgedAt: row.acknowledged_at ?? undefined,
    acknowledgedBy: row.acknowledged_by ?? undefined,
    schedulePolicyId: row.schedule_policy_id ?? undefined,
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
    dispatchedInputSeq: Number(row.dispatched_input_seq),
    consumedInputSeq: Number(row.consumed_input_seq),
    report: row.report_json === null ? undefined : (JSON.parse(row.report_json) as WorkerReport),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInput(row: TaskInputRow): TaskInputRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: Number(row.seq),
    kind: row.kind,
    sourceInboxId: row.source_inbox_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    text: row.text,
    createdAt: row.created_at,
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
  schedulePolicyId?: string;
  createdAt: string;
}

export interface ClaimedTask {
  task: TaskRecord;
  assignment: AssignmentRecord;
}

export interface AddTaskInput {
  taskId: string;
  text: string;
  kind?: TaskInputKind;
  sourceInboxId?: string;
  actorId?: string;
  createdAt: string;
}

export interface AddedTaskInput {
  input: TaskInputRecord;
  task: TaskRecord;
  /** False when this platform message already produced an input. */
  inserted: boolean;
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
         schedule_policy_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, 0, ?, ?, ?, ?, ?)
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
      input.schedulePolicyId ?? null,
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

  listByOwnerStatus(
    ownerId: string,
    status: TaskStatus,
    limit = 20,
  ): TaskRecord[] {
    if (status === "needs_review") {
      return this.#db
        .all<TaskRow>(
          `SELECT * FROM pa_tasks
           WHERE owner_id = ? AND status = 'waiting_user' AND needs_review = 1
           ORDER BY created_at DESC
           LIMIT ?`,
          ownerId,
          limit,
        )
        .map(mapTask);
    }
    if (status === "waiting_user") {
      return this.#db
        .all<TaskRow>(
          `SELECT * FROM pa_tasks
           WHERE owner_id = ? AND status = 'waiting_user' AND needs_review = 0
           ORDER BY created_at DESC
           LIMIT ?`,
          ownerId,
          limit,
        )
        .map(mapTask);
    }
    return this.#db
      .all<TaskRow>(
        `SELECT * FROM pa_tasks
         WHERE owner_id = ? AND status = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        ownerId,
        status,
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
    const row =
      status === "needs_review"
        ? this.#db.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM pa_tasks WHERE status = 'waiting_user' AND needs_review = 1",
          )[0]
        : status === "waiting_user"
          ? this.#db.all<{ count: number }>(
              "SELECT COUNT(*) AS count FROM pa_tasks WHERE status = 'waiting_user' AND needs_review = 0",
            )[0]
          : this.#db.all<{ count: number }>(
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

  listAssignments(taskId: string): AssignmentRecord[] {
    return this.#db
      .all<AssignmentRow>(
        `SELECT * FROM pa_assignments
         WHERE task_id = ?
         ORDER BY created_at DESC`,
        taskId,
      )
      .map(mapAssignment);
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
      const latestInput = this.#db.all<{ seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM pa_task_inputs WHERE task_id = ?`,
        task.id,
      )[0];
      const dispatchedInputSeq = Number(latestInput?.seq ?? 0);

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
           fencing_token, dispatched_input_seq, consumed_input_seq,
           report_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, NULL, ?, ?)
         RETURNING *`,
        assignmentId,
        task.id,
        task.revision,
        "",
        attempt,
        leaseUntil,
        fencingToken,
        dispatchedInputSeq,
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
      verification?: TaskVerification;
      updatedAt: string;
    },
  ): TaskRecord | undefined {
    const current = this.get(taskId);
    if (current === undefined || current.revision !== expectedRevision) {
      return undefined;
    }

    const dbStatus =
      fields.status === undefined
        ? null
        : fields.status === "needs_review"
          ? "waiting_user"
          : fields.status;
    const needsReview =
      fields.status === undefined ? null : fields.status === "needs_review" ? 1 : 0;
    this.#db.run(
      `UPDATE pa_tasks
       SET status = COALESCE(?, status),
           needs_review = COALESCE(?, needs_review),
           result_ref = COALESCE(?, result_ref),
           last_error = ?,
           verification_json = COALESCE(?, verification_json),
           updated_at = ?
       WHERE id = ? AND revision = ?`,
      dbStatus,
      needsReview,
      fields.resultRef ?? null,
      fields.lastError ?? null,
      fields.verification === undefined ? null : JSON.stringify(fields.verification),
      fields.updatedAt,
      taskId,
      expectedRevision,
    );

    return this.get(taskId);
  }

  /** Owner acknowledgement is the only exit from needs_review. */
  acknowledge(
    taskId: string,
    ownerId: string,
    now: string,
  ): TaskRecord | undefined {
    const current = this.get(taskId);
    if (
      current === undefined ||
      current.ownerId !== ownerId ||
      current.status !== "needs_review"
    ) {
      return undefined;
    }
    this.#db.run(
      `UPDATE pa_tasks
       SET status = 'succeeded', needs_review = 0, last_error = NULL,
           acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
       WHERE id = ? AND status = 'waiting_user' AND needs_review = 1`,
      now,
      ownerId,
      now,
      taskId,
    );
    return this.get(taskId);
  }

  /**
   * Append an immutable owner input. The unique `(task_id, source_inbox_id)`
   * key makes an effect retry for the same platform message a no-op. A task
   * waiting for the owner returns to the queue; a running task keeps its
   * assignment, which the report barrier prevents from completing early.
   */
  addInput(input: AddTaskInput): AddedTaskInput | undefined {
    return this.#db.transaction(() => {
      const current = this.get(input.taskId);
      if (current === undefined || isTerminal(current.status)) {
        return undefined;
      }

      if (input.sourceInboxId !== undefined) {
        const existing = this.#db.all<TaskInputRow>(
          `SELECT * FROM pa_task_inputs
           WHERE task_id = ? AND source_inbox_id = ?`,
          input.taskId,
          input.sourceInboxId,
        )[0];
        if (existing !== undefined) {
          return { input: mapInput(existing), task: current, inserted: false };
        }
      }

      const latest = this.#db.all<{ seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM pa_task_inputs WHERE task_id = ?`,
        input.taskId,
      )[0];
      const seq = Number(latest?.seq ?? 0) + 1;
      const row = this.#db.all<TaskInputRow>(
        `INSERT INTO pa_task_inputs
           (id, task_id, seq, kind, source_inbox_id, actor_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        randomUUID(),
        input.taskId,
        seq,
        input.kind ?? "supplement",
        input.sourceInboxId ?? null,
        input.actorId ?? null,
        input.text,
        input.createdAt,
      )[0];
      if (row === undefined) {
        throw new Error(`task input for ${input.taskId} was not inserted`);
      }

      const status =
        current.status === "waiting_user" || current.status === "queued"
          ? "queued"
          : current.status;
      if (status !== current.status) {
        this.#db.run(
          `UPDATE pa_tasks SET status = ?, updated_at = ? WHERE id = ?`,
          status,
          input.createdAt,
          input.taskId,
        );
      }

      const task = this.get(input.taskId);
      if (task === undefined) {
        throw new Error(`task ${input.taskId} disappeared after adding input`);
      }
      return { input: mapInput(row), task, inserted: true };
    });
  }

  listInputs(taskId: string, upToSeq = Number.MAX_SAFE_INTEGER): TaskInputRecord[] {
    return this.#db
      .all<TaskInputRow>(
        `SELECT * FROM pa_task_inputs
         WHERE task_id = ? AND seq <= ?
         ORDER BY seq ASC`,
        taskId,
        upToSeq,
      )
      .map(mapInput);
  }

  listInputsAfter(taskId: string, seq: number): TaskInputRecord[] {
    return this.#db
      .all<TaskInputRow>(
        `SELECT * FROM pa_task_inputs
         WHERE task_id = ? AND seq > ?
         ORDER BY seq ASC`,
        taskId,
        seq,
      )
      .map(mapInput);
  }

  /** Inputs accepted but not yet covered by a report. */
  countUnconsumedInputs(taskId: string): number {
    const row = this.#db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM pa_task_inputs
       WHERE task_id = ? AND seq > COALESCE((
         SELECT MAX(consumed_input_seq) FROM pa_assignments WHERE task_id = ?
       ), 0)`,
      taskId,
      taskId,
    )[0];
    return Number(row?.count ?? 0);
  }

  /** All accepted inputs; each one grants one additional work round. */
  countInputs(taskId: string): number {
    const row = this.#db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM pa_task_inputs WHERE task_id = ?`,
      taskId,
    )[0];
    return Number(row?.count ?? 0);
  }

  markAssignmentConsumed(assignmentId: string, seq: number, now: string): void {
    this.#db.run(
      `UPDATE pa_assignments
       SET consumed_input_seq = MAX(consumed_input_seq, ?), updated_at = ?
       WHERE id = ?`,
      seq,
      now,
      assignmentId,
    );
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
  return (
    status === "succeeded" ||
    status === "needs_review" ||
    status === "failed" ||
    status === "cancelled"
  );
}
