import { randomUUID } from "node:crypto";

import type {
  ActionRecord,
  ActionStatus,
  ApprovalRecord,
} from "../domain/types.ts";
import type { Db } from "./db.ts";

interface ActionRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  task_id: string;
  task_revision: number;
  fencing_token: number;
  tool: string;
  args_json: string;
  args_hash: string;
  status: ActionStatus;
  expires_at: string;
  nonce: string;
  approved_at: string | null;
  approved_by: string | null;
  execution_attempts: number;
  lease_until: string | null;
  external_ref: string | null;
  evidence_json: string | null;
  last_error: string | null;
  preauthorization_id: string | null;
  schedule_policy_id: string | null;
  schedule_policy_version: number | null;
  plugin_id: string | null;
  plugin_version: string | null;
  plugin_digest: string | null;
  catalog_generation: number | null;
  source_key: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  action_id: string;
  decision: "approved" | "denied";
  approver_id: string;
  conversation_id: string;
  args_hash: string;
  task_revision: number;
  nonce: string;
  consumed_at: string | null;
  created_at: string;
}

function mapAction(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    taskRevision: Number(row.task_revision),
    fencingToken: Number(row.fencing_token),
    tool: row.tool,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    argsHash: row.args_hash,
    status: row.status,
    expiresAt: row.expires_at,
    nonce: row.nonce,
    approvedAt: row.approved_at ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    executionAttempts: Number(row.execution_attempts),
    leaseUntil: row.lease_until ?? undefined,
    externalRef: row.external_ref ?? undefined,
    evidence:
      row.evidence_json === null
        ? undefined
        : (JSON.parse(row.evidence_json) as Record<string, unknown>),
    lastError: row.last_error ?? undefined,
    preauthorizationId: row.preauthorization_id ?? undefined,
    schedulePolicyId: row.schedule_policy_id ?? undefined,
    schedulePolicyVersion:
      row.schedule_policy_version === null ? undefined : Number(row.schedule_policy_version),
    pluginId: row.plugin_id ?? undefined,
    pluginVersion: row.plugin_version ?? undefined,
    pluginDigest: row.plugin_digest ?? undefined,
    catalogGeneration:
      row.catalog_generation === null ? undefined : Number(row.catalog_generation),
    ...(row.source_key === null ? {} : { sourceKey: row.source_key }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    decision: row.decision,
    approverId: row.approver_id,
    conversationId: row.conversation_id,
    argsHash: row.args_hash,
    taskRevision: Number(row.task_revision),
    nonce: row.nonce,
    consumedAt: row.consumed_at ?? undefined,
    createdAt: row.created_at,
  };
}

export interface NewActionInput {
  ownerId: string;
  conversationId: string;
  taskId: string;
  taskRevision: number;
  fencingToken: number;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  expiresAt: string;
  nonce: string;
  sourceKey?: string;
  preauthorizationId?: string;
  schedulePolicyId?: string;
  schedulePolicyVersion?: number;
  pluginId?: string;
  pluginVersion?: string;
  pluginDigest?: string;
  catalogGeneration?: number;
  createdAt: string;
}

export type ApprovalResult =
  | { ok: true; action: ActionRecord }
  | { ok: false; reason: string };

export type ClaimExecutionResult =
  | { ok: true; action: ActionRecord }
  | {
      ok: false;
      reason: string;
      action?: ActionRecord;
      /** True when the claim itself revoked the approved action. */
      revoked?: boolean;
    };

export class ActionRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: NewActionInput): { action: ActionRecord; created: boolean } {
    const row = this.#db.all<ActionRow>(
      `INSERT INTO pa_actions
        (id, owner_id, conversation_id, task_id, task_revision, fencing_token,
         tool, args_json, args_hash, status, expires_at, nonce, approved_at,
         approved_by, execution_attempts, lease_until, external_ref, evidence_json,
         last_error, preauthorization_id, schedule_policy_id,
         schedule_policy_version, plugin_id, plugin_version, plugin_digest,
         catalog_generation, source_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, NULL, NULL, 0,
               NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.conversationId,
      input.taskId,
      input.taskRevision,
      input.fencingToken,
      input.tool,
      JSON.stringify(input.args),
      input.argsHash,
      input.expiresAt,
      input.nonce,
      input.preauthorizationId ?? null,
      input.schedulePolicyId ?? null,
      input.schedulePolicyVersion ?? null,
      input.pluginId ?? null,
      input.pluginVersion ?? null,
      input.pluginDigest ?? null,
      input.catalogGeneration ?? null,
      input.sourceKey ?? null,
      input.createdAt,
      input.createdAt,
    )[0];

    if (row !== undefined) {
      return { action: mapAction(row), created: true };
    }

    const existing = this.#db.all<ActionRow>(
      "SELECT * FROM pa_actions WHERE source_key = ?",
      input.sourceKey ?? "",
    )[0];
    if (existing === undefined) {
      throw new Error(`action source key ${input.sourceKey ?? ""} conflicted without a row`);
    }
    return { action: mapAction(existing), created: false };
  }

  get(id: string): ActionRecord | undefined {
    const row = this.#db.all<ActionRow>("SELECT * FROM pa_actions WHERE id = ?", id)[0];
    return row === undefined ? undefined : mapAction(row);
  }

  getByNonce(nonce: string): ActionRecord | undefined {
    const row = this.#db.all<ActionRow>(
      "SELECT * FROM pa_actions WHERE nonce = ?",
      nonce,
    )[0];
    return row === undefined ? undefined : mapAction(row);
  }

  listByTask(taskId: string): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        "SELECT * FROM pa_actions WHERE task_id = ? ORDER BY created_at ASC",
        taskId,
      )
      .map(mapAction);
  }

  /** Tool calls consumed by every child that belongs to one plan. */
  countByPlan(planId: string): number {
    const row = this.#db.all<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM pa_actions a
       JOIN pa_tasks t ON t.id = a.task_id
       WHERE t.plan_id = ?`,
      planId,
    )[0];
    return Number(row?.count ?? 0);
  }

  /** Pending approvals for a plugin being disabled or replaced. */
  listPendingForTools(tools: readonly string[]): ActionRecord[] {
    if (tools.length === 0) {
      return [];
    }
    const placeholders = tools.map(() => "?").join(", ");
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE tool IN (${placeholders})
           AND status IN ('proposed', 'approved')
         ORDER BY created_at ASC`,
        ...tools,
      )
      .map(mapAction);
  }

  /** Already-executing calls that a lifecycle change cannot cancel. */
  listInFlightForTools(tools: readonly string[]): ActionRecord[] {
    if (tools.length === 0) {
      return [];
    }
    const placeholders = tools.map(() => "?").join(", ");
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE tool IN (${placeholders})
           AND status IN ('executing', 'unknown', 'reconciling')
         ORDER BY created_at ASC`,
        ...tools,
      )
      .map(mapAction);
  }

  listProposedByOwner(
    ownerId: string,
    now: string,
    limit = 50,
  ): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE owner_id = ? AND status = 'proposed' AND expires_at > ?
         ORDER BY created_at ASC
         LIMIT ?`,
        ownerId,
        now,
        limit,
      )
      .map(mapAction);
  }

  listInFlight(taskId: string): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE task_id = ? AND status IN ('executing', 'unknown', 'reconciling')
         ORDER BY created_at ASC`,
        taskId,
      )
      .map(mapAction);
  }

  /** Action counts grouped by status, for operator usage views. */
  statusCounts(): Record<string, number> {
    const rows = this.#db.all<{ status: string; count: number }>(
      "SELECT status, COUNT(*) AS count FROM pa_actions GROUP BY status",
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  countByTool(): { tool: string; count: number }[] {
    return this.#db
      .all<{ tool: string; count: number }>(
        `SELECT tool, COUNT(*) AS count FROM pa_actions
         GROUP BY tool ORDER BY count DESC, tool ASC`,
      )
      .map((row) => ({ tool: row.tool, count: Number(row.count) }));
  }

  listExpiredExecuting(now: string, limit = 50): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE status = 'executing' AND lease_until IS NOT NULL AND lease_until <= ?
         ORDER BY lease_until ASC
         LIMIT ?`,
        now,
        limit,
      )
      .map(mapAction);
  }

  listUnknown(limit = 50): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE status IN ('unknown', 'reconciling')
         ORDER BY updated_at ASC
         LIMIT ?`,
        limit,
      )
      .map(mapAction);
  }

  listExpiredProposed(now: string, limit = 50): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `SELECT * FROM pa_actions
         WHERE status = 'proposed' AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT ?`,
        now,
        limit,
      )
      .map(mapAction);
  }

  approve(
    actionId: string,
    input: {
      approverId: string;
      conversationId: string;
      argsHash: string;
      taskRevision: number;
      nonce: string;
      now: string;
    },
    afterApprove?: () => void,
  ): ApprovalResult {
    return this.#db.transaction(() => {
      const action = this.get(actionId);
      if (action === undefined) {
        return { ok: false, reason: "action_not_found" };
      }
      if (action.status !== "proposed") {
        return { ok: false, reason: `action_${action.status}` };
      }
      if (action.expiresAt <= input.now) {
        this.#db.run(
          `UPDATE pa_actions SET status = 'expired', updated_at = ?
           WHERE id = ? AND status = 'proposed'`,
          input.now,
          actionId,
        );
        return { ok: false, reason: "action_expired" };
      }
      if (action.ownerId !== input.approverId) {
        return { ok: false, reason: "approver_not_owner" };
      }
      if (action.conversationId !== input.conversationId) {
        return { ok: false, reason: "conversation_mismatch" };
      }
      if (action.argsHash !== input.argsHash) {
        return { ok: false, reason: "args_mismatch" };
      }
      if (action.taskRevision !== input.taskRevision) {
        return { ok: false, reason: "revision_mismatch" };
      }
      if (action.nonce !== input.nonce) {
        return { ok: false, reason: "nonce_mismatch" };
      }

      this.#db.run(
        `UPDATE pa_actions
         SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'proposed'`,
        input.now,
        input.approverId,
        input.now,
        actionId,
      );
      this.#db.run(
        `INSERT INTO pa_approvals
          (id, action_id, decision, approver_id, conversation_id, args_hash,
           task_revision, nonce, consumed_at, created_at)
         VALUES (?, ?, 'approved', ?, ?, ?, ?, ?, NULL, ?)`,
        randomUUID(),
        actionId,
        input.approverId,
        input.conversationId,
        input.argsHash,
        input.taskRevision,
        input.nonce,
        input.now,
      );

      // Runs inside the transaction: a throwing callback (e.g. a failed
      // effect enqueue) rolls the approval rows back.
      afterApprove?.();

      return { ok: true, action: this.get(actionId) as ActionRecord };
    });
  }

  deny(
    actionId: string,
    input: {
      approverId: string;
      conversationId: string;
      argsHash: string;
      taskRevision: number;
      nonce: string;
      now: string;
    },
  ): ApprovalResult {
    return this.#db.transaction(() => {
      const action = this.get(actionId);
      if (action === undefined) {
        return { ok: false, reason: "action_not_found" };
      }
      if (action.status !== "proposed") {
        return { ok: false, reason: `action_${action.status}` };
      }
      if (action.ownerId !== input.approverId) {
        return { ok: false, reason: "approver_not_owner" };
      }
      if (action.conversationId !== input.conversationId) {
        return { ok: false, reason: "conversation_mismatch" };
      }
      if (action.argsHash !== input.argsHash) {
        return { ok: false, reason: "args_mismatch" };
      }
      if (action.taskRevision !== input.taskRevision) {
        return { ok: false, reason: "revision_mismatch" };
      }
      if (action.nonce !== input.nonce) {
        return { ok: false, reason: "nonce_mismatch" };
      }

      this.#db.run(
        `UPDATE pa_actions
         SET status = 'denied', approved_at = ?, approved_by = ?, updated_at = ?
         WHERE id = ? AND status = 'proposed'`,
        input.now,
        input.approverId,
        input.now,
        actionId,
      );
      this.#db.run(
        `INSERT INTO pa_approvals
          (id, action_id, decision, approver_id, conversation_id, args_hash,
           task_revision, nonce, consumed_at, created_at)
         VALUES (?, ?, 'denied', ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        actionId,
        input.approverId,
        input.conversationId,
        input.argsHash,
        input.taskRevision,
        input.nonce,
        input.now,
        input.now,
      );

      return { ok: true, action: this.get(actionId) as ActionRecord };
    });
  }

  /**
   * Consume the one-time approval and move approved -> executing in the same
   * transaction that leases the action for the executor. The optional
   * `authorize` guard runs inside that transaction and must re-check the
   * current Task before the external call is allowed.
   */
  claimForExecution(
    actionId: string,
    now: string,
    leaseMs: number,
    authorize?: (action: ActionRecord) => string | undefined,
  ): ClaimExecutionResult {
    return this.#db.transaction(() => {
      const action = this.get(actionId);
      if (action === undefined) {
        return { ok: false, reason: "action_not_found" };
      }
      if (action.status !== "approved") {
        // A replayed claim must still be able to settle its task (for example
        // after a crash between the first claim's commit and onSettled), but
        // it must not re-audit or re-notify an already-closed action.
        return {
          ok: false,
          reason: `action_${action.status}`,
          action: action.status === "expired" ? action : undefined,
        };
      }
      if (action.expiresAt <= now) {
        // An approved action that misses its execution window must not stay
        // approved forever; close it and its one-time approval together.
        this.#db.run(
          `UPDATE pa_actions
           SET status = 'expired', lease_until = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND status = 'approved'`,
          "action expired before execution",
          now,
          actionId,
        );
        this.#consumeApproval(actionId, now);
        return {
          ok: false,
          reason: "action_expired",
          action: this.get(actionId),
          revoked: true,
        };
      }

      const reason = authorize?.(action);
      if (reason !== undefined) {
        // The approval is valid but its authority is gone. Revoke the action
        // and close the approval in the same transaction as the claim.
        this.supersede(actionId, reason, now);
        this.#consumeApproval(actionId, now);
        return {
          ok: false,
          reason,
          action: this.get(actionId),
          revoked: true,
        };
      }

      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
      const changes = this.#db.run(
        `UPDATE pa_actions
         SET status = 'executing', execution_attempts = execution_attempts + 1,
             lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'approved' AND expires_at > ?`,
        leaseUntil,
        now,
        actionId,
        now,
      );
      if (changes === 0) {
        return { ok: false, reason: "action_claim_conflict" };
      }

      this.#consumeApproval(actionId, now);
      return { ok: true, action: this.get(actionId) as ActionRecord };
    });
  }

  #consumeApproval(actionId: string, now: string): void {
    this.#db.run(
      `UPDATE pa_approvals SET consumed_at = ?
       WHERE action_id = ? AND consumed_at IS NULL`,
      now,
      actionId,
    );
  }

  /** Revoke an action whose approval no longer grants execution authority. */
  supersede(actionId: string, reason: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'superseded', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('proposed', 'approved')`,
        reason,
        now,
        actionId,
      ) > 0
    );
  }

  markExecutingExpired(actionId: string, now: string, reason: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'unknown', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'executing'
           AND lease_until IS NOT NULL AND lease_until <= ?`,
        reason,
        now,
        actionId,
        now,
      ) > 0
    );
  }

  markSucceeded(
    actionId: string,
    evidence: Record<string, unknown>,
    externalRef: string | undefined,
    now: string,
  ): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'succeeded', evidence_json = ?, external_ref = COALESCE(?, external_ref),
             lease_until = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('executing', 'unknown', 'reconciling')`,
        JSON.stringify(evidence),
        externalRef ?? null,
        now,
        actionId,
      ) > 0
    );
  }

  markFailed(actionId: string, reason: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('approved', 'executing', 'unknown', 'reconciling')`,
        reason,
        now,
        actionId,
      ) > 0
    );
  }

  markUnknown(actionId: string, reason: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'unknown', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('executing', 'reconciling')`,
        reason,
        now,
        actionId,
      ) > 0
    );
  }

  markReconciling(actionId: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'reconciling', lease_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('unknown', 'reconciling')`,
        now,
        actionId,
      ) > 0
    );
  }

  markNeedsManual(actionId: string, reason: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'needs_manual', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('unknown', 'reconciling')`,
        reason,
        now,
        actionId,
      ) > 0
    );
  }

  markSuperseded(actionId: string, reason: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions
         SET status = 'superseded', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('unknown', 'reconciling')`,
        reason,
        now,
        actionId,
      ) > 0
    );
  }

  supersedeForTask(taskId: string, now: string): ActionRecord[] {
    return this.#db
      .all<ActionRow>(
        `UPDATE pa_actions
         SET status = 'superseded', updated_at = ?
         WHERE task_id = ? AND status IN ('proposed', 'approved')
         RETURNING *`,
        now,
        taskId,
      )
      .map(mapAction);
  }

  expireProposed(actionId: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_actions SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'proposed' AND expires_at <= ?`,
        now,
        actionId,
        now,
      ) > 0
    );
  }
}
