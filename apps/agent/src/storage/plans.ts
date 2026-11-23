import { randomUUID } from "node:crypto";

import type {
  PlanBudget,
  PlanDiff,
  PlanRecord,
  PlanStatus,
  PlanStepDiff,
  PlanStepRecord,
  PlanStepStatus,
} from "../domain/types.ts";
import type { Db } from "./db.ts";

export interface NewPlan {
  ownerId: string;
  parentTaskId: string;
  taskRevision: number;
  inputSeq: number;
  planVersion: number;
  autoReplans: number;
  status: PlanStatus;
  projectKey?: string;
  approvedScopeRef?: string;
  budget: PlanBudget;
  createdAt: string;
}

export interface NewPlanStep {
  planId: string;
  stepKey: string;
  ordinal: number;
  goal: string;
  dependsOn: string[];
  tools: string[];
  resources: string[];
  verifierId: string;
  completionCriteria: string;
  maxAttempts: number;
  timeoutMs: number;
  status: PlanStepStatus;
  evidenceRefs?: string[];
  /** Preserved when a replan copies a completed step from an older version. */
  taskId?: string;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface PlanRow {
  id: string;
  owner_id: string;
  parent_task_id: string;
  task_revision: number;
  input_seq: number;
  plan_version: number;
  auto_replans: number;
  status: PlanStatus;
  project_key: string | null;
  approved_scope_ref: string | null;
  budget_json: string;
  created_at: string;
  updated_at: string;
}

interface PlanStepRow {
  id: string;
  plan_id: string;
  step_key: string;
  ordinal: number;
  goal: string;
  depends_on_json: string;
  tools_json: string;
  resources_json: string;
  verifier_id: string;
  completion_criteria: string;
  max_attempts: number;
  timeout_ms: number;
  status: PlanStepStatus;
  assignment_id: string | null;
  task_id: string | null;
  attempts: number;
  evidence_refs_json: string;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanDiffRow {
  diff_json: string;
}

function parseStrings(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    parentTaskId: row.parent_task_id,
    taskRevision: Number(row.task_revision),
    inputSeq: Number(row.input_seq),
    planVersion: Number(row.plan_version),
    autoReplans: Number(row.auto_replans),
    status: row.status,
    projectKey: row.project_key ?? undefined,
    approvedScopeRef: row.approved_scope_ref ?? undefined,
    budget: JSON.parse(row.budget_json) as PlanBudget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStep(row: PlanStepRow): PlanStepRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    key: row.step_key,
    ordinal: Number(row.ordinal),
    goal: row.goal,
    dependsOn: parseStrings(row.depends_on_json),
    tools: parseStrings(row.tools_json),
    resources: parseStrings(row.resources_json),
    verifierId: row.verifier_id,
    completionCriteria: row.completion_criteria,
    maxAttempts: Number(row.max_attempts),
    timeoutMs: Number(row.timeout_ms),
    status: row.status,
    assignmentId: row.assignment_id ?? undefined,
    taskId: row.task_id ?? undefined,
    attempts: Number(row.attempts),
    evidenceRefs: parseStrings(row.evidence_refs_json),
    lastError: row.last_error ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PlanRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insertPlan(input: NewPlan): PlanRecord {
    const row = this.#db.all<PlanRow>(
      `INSERT INTO pa_plans
        (id, owner_id, parent_task_id, task_revision, input_seq, plan_version,
         auto_replans, status, project_key, approved_scope_ref, budget_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.parentTaskId,
      input.taskRevision,
      input.inputSeq,
      input.planVersion,
      input.autoReplans,
      input.status,
      input.projectKey ?? null,
      input.approvedScopeRef ?? null,
      JSON.stringify(input.budget),
      input.createdAt,
      input.createdAt,
    )[0];
    if (row === undefined) {
      throw new Error("plan insert returned no row");
    }
    return mapPlan(row);
  }

  insertStep(input: NewPlanStep): PlanStepRecord {
    const row = this.#db.all<PlanStepRow>(
      `INSERT INTO pa_plan_steps
        (id, plan_id, step_key, ordinal, goal, depends_on_json, tools_json,
         resources_json, verifier_id, completion_criteria, max_attempts,
         timeout_ms, status, evidence_refs_json, task_id, attempts,
         started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      randomUUID(),
      input.planId,
      input.stepKey,
      input.ordinal,
      input.goal,
      JSON.stringify(input.dependsOn),
      JSON.stringify(input.tools),
      JSON.stringify(input.resources),
      input.verifierId,
      input.completionCriteria,
      input.maxAttempts,
      input.timeoutMs,
      input.status,
      JSON.stringify(input.evidenceRefs ?? []),
      input.taskId ?? null,
      input.attempts ?? 0,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.createdAt,
      input.createdAt,
    )[0];
    if (row === undefined) {
      throw new Error("plan step insert returned no row");
    }
    return mapStep(row);
  }

  getPlan(id: string): PlanRecord | undefined {
    const row = this.#db.all<PlanRow>("SELECT * FROM pa_plans WHERE id = ?", id)[0];
    return row === undefined ? undefined : mapPlan(row);
  }

  listVersions(parentTaskId: string): PlanRecord[] {
    return this.#db
      .all<PlanRow>(
        `SELECT * FROM pa_plans
         WHERE parent_task_id = ?
         ORDER BY plan_version ASC`,
        parentTaskId,
      )
      .map(mapPlan);
  }

  latestForTask(parentTaskId: string): PlanRecord | undefined {
    const row = this.#db.all<PlanRow>(
      `SELECT * FROM pa_plans
       WHERE parent_task_id = ?
       ORDER BY plan_version DESC
       LIMIT 1`,
      parentTaskId,
    )[0];
    return row === undefined ? undefined : mapPlan(row);
  }

  activeForTask(parentTaskId: string): PlanRecord | undefined {
    const row = this.#db.all<PlanRow>(
      `SELECT * FROM pa_plans
       WHERE parent_task_id = ? AND status = 'active'
       LIMIT 1`,
      parentTaskId,
    )[0];
    return row === undefined ? undefined : mapPlan(row);
  }

  listByOwner(
    ownerId: string,
    options: { parentTaskId?: string; status?: PlanStatus; limit?: number } = {},
  ): PlanRecord[] {
    const clauses = ["owner_id = ?"];
    const params: (string | number)[] = [ownerId];
    if (options.parentTaskId !== undefined) {
      clauses.push("parent_task_id = ?");
      params.push(options.parentTaskId);
    }
    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    params.push(options.limit ?? 20);
    return this.#db
      .all<PlanRow>(
        `SELECT * FROM pa_plans
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, plan_version DESC
         LIMIT ?`,
        ...params,
      )
      .map(mapPlan);
  }

  listSteps(planId: string): PlanStepRecord[] {
    return this.#db
      .all<PlanStepRow>(
        `SELECT * FROM pa_plan_steps
         WHERE plan_id = ?
         ORDER BY ordinal ASC`,
        planId,
      )
      .map(mapStep);
  }

  maxInputSeq(taskId: string): number {
    const row = this.#db.all<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM pa_task_inputs WHERE task_id = ?",
      taskId,
    )[0];
    return Number(row?.seq ?? 0);
  }

  setPlanStatus(
    id: string,
    expected: readonly PlanStatus[],
    next: PlanStatus,
    at: string,
  ): boolean {
    if (expected.length === 0) {
      return false;
    }
    const placeholders = expected.map(() => "?").join(", ");
    const changes = this.#db.run(
      `UPDATE pa_plans
       SET status = ?, updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
      next,
      at,
      id,
      ...expected,
    );
    return changes === 1;
  }

  setApprovedScope(
    id: string,
    approvedScopeRef: string,
    at: string,
  ): PlanRecord | undefined {
    const row = this.#db.all<PlanRow>(
      `UPDATE pa_plans
       SET approved_scope_ref = ?, updated_at = ?
       WHERE id = ? AND status = 'active'
       RETURNING *`,
      approvedScopeRef,
      at,
      id,
    )[0];
    return row === undefined ? undefined : mapPlan(row);
  }

  setStepsStatus(
    planId: string,
    stepKeys: readonly string[],
    next: PlanStepStatus,
    at: string,
  ): number {
    if (stepKeys.length === 0) {
      return 0;
    }
    const placeholders = stepKeys.map(() => "?").join(", ");
    return this.#db.run(
      `UPDATE pa_plan_steps
       SET status = ?, updated_at = ?
       WHERE plan_id = ? AND step_key IN (${placeholders})`,
      next,
      at,
      planId,
      ...stepKeys,
    );
  }

  getStep(planId: string, stepKey: string): PlanStepRecord | undefined {
    const row = this.#db.all<PlanStepRow>(
      "SELECT * FROM pa_plan_steps WHERE plan_id = ? AND step_key = ?",
      planId,
      stepKey,
    )[0];
    return row === undefined ? undefined : mapStep(row);
  }

  bindStepTask(
    planId: string,
    stepKey: string,
    taskId: string,
    at: string,
  ): PlanStepRecord | undefined {
    const row = this.#db.all<PlanStepRow>(
      `UPDATE pa_plan_steps
       SET task_id = ?, status = 'running', attempts = attempts + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE plan_id = ? AND step_key = ? AND status = 'ready'
       RETURNING *`,
      taskId,
      at,
      at,
      planId,
      stepKey,
    )[0];
    return row === undefined ? undefined : mapStep(row);
  }

  setStepAssignment(
    planId: string,
    stepKey: string,
    assignmentId: string,
    at: string,
  ): void {
    this.#db.run(
      `UPDATE pa_plan_steps
       SET assignment_id = ?, updated_at = ?
       WHERE plan_id = ? AND step_key = ?`,
      assignmentId,
      at,
      planId,
      stepKey,
    );
  }

  setStepOutcome(
    planId: string,
    stepKey: string,
    status: PlanStepStatus,
    evidenceRefs: readonly string[],
    lastError: string | undefined,
    at: string,
  ): PlanStepRecord | undefined {
    const row = this.#db.all<PlanStepRow>(
      `UPDATE pa_plan_steps
       SET status = ?, evidence_refs_json = ?, last_error = ?,
           completed_at = CASE
             WHEN ? IN ('completed', 'failed', 'needs_review', 'cancelled') THEN ?
             ELSE completed_at
           END,
           updated_at = ?
       WHERE plan_id = ? AND step_key = ?
       RETURNING *`,
      status,
      JSON.stringify(evidenceRefs),
      lastError ?? null,
      status,
      at,
      at,
      planId,
      stepKey,
    )[0];
    return row === undefined ? undefined : mapStep(row);
  }

  resetStepForRetry(
    planId: string,
    stepKey: string,
    lastError: string,
    at: string,
  ): PlanStepRecord | undefined {
    const row = this.#db.all<PlanStepRow>(
      `UPDATE pa_plan_steps
       SET status = 'ready', last_error = ?, updated_at = ?
       WHERE plan_id = ? AND step_key = ? AND status = 'running'
       RETURNING *`,
      lastError,
      at,
      planId,
      stepKey,
    )[0];
    return row === undefined ? undefined : mapStep(row);
  }

  listPlansByStatus(status: PlanStatus, limit = 50): PlanRecord[] {
    return this.#db
      .all<PlanRow>(
        `SELECT * FROM pa_plans
         WHERE status = ?
         ORDER BY updated_at ASC
         LIMIT ?`,
        status,
        limit,
      )
      .map(mapPlan);
  }

  insertDiff(planId: string, diff: PlanDiff): void {
    this.#db.run(
      `INSERT INTO pa_plan_diffs
        (id, plan_id, from_version, to_version, diff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (plan_id, from_version, to_version) DO NOTHING`,
      randomUUID(),
      planId,
      diff.fromVersion,
      diff.toVersion,
      JSON.stringify(diff),
      diff.createdAt,
    );
  }

  getDiff(planId: string, fromVersion: number, toVersion: number): PlanDiff | undefined {
    const row = this.#db.all<PlanDiffRow>(
      `SELECT diff_json FROM pa_plan_diffs
       WHERE plan_id = ? AND from_version = ? AND to_version = ?`,
      planId,
      fromVersion,
      toVersion,
    )[0];
    if (row === undefined) {
      return undefined;
    }
    return JSON.parse(row.diff_json) as PlanDiff;
  }
}
