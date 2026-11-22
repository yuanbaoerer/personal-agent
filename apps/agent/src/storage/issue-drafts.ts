import type { IssueDraftSnapshot, IssueDraftStatus } from "../domain/types.ts";
import type { Db } from "./db.ts";

const ACTIVE_STATUSES: readonly IssueDraftStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "executing",
];

interface IssueDraftRow {
  id: string;
  owner_id: string;
  project_key: string;
  repository_id: number;
  repository_full_name: string;
  source_task_id: string;
  source_task_revision: number;
  source_assignment_id: string;
  commit_sha: string;
  finding_ids_json: string;
  action: "create" | "update" | "comment";
  target_issue: number | null;
  before_hash: string | null;
  before_summary: string | null;
  title: string;
  body: string;
  payload_hash: string;
  idempotency_key: string;
  credential_ref: string;
  credential_version: number | null;
  status: IssueDraftStatus;
  write_task_id: string | null;
  write_action_id: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface IssueDraftFilter {
  status?: IssueDraftStatus;
  projectKey?: string;
  repositoryId?: number;
  limit?: number;
}

export class IssueDraftRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(draft: IssueDraftSnapshot): void {
    this.#db.run(
      `INSERT INTO pa_issue_drafts
        (id, owner_id, project_key, repository_id, repository_full_name,
         source_task_id, source_task_revision, source_assignment_id, commit_sha,
         finding_ids_json, action, target_issue, before_hash, before_summary,
         title, body, payload_hash, idempotency_key, credential_ref,
         credential_version, status, write_task_id, write_action_id,
         created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      draft.id,
      draft.ownerId,
      draft.projectKey,
      draft.repositoryId,
      draft.repositoryFullName,
      draft.sourceTaskId,
      draft.sourceTaskRevision,
      draft.sourceAssignmentId,
      draft.commitSha,
      JSON.stringify(draft.findingIds),
      draft.action,
      draft.targetIssue ?? null,
      draft.beforeHash ?? null,
      draft.beforeSummary ?? null,
      draft.title,
      draft.body,
      draft.payloadHash,
      draft.idempotencyKey,
      draft.credentialRef,
      draft.credentialVersion ?? null,
      draft.status,
      draft.writeTaskId ?? null,
      draft.writeActionId ?? null,
      draft.createdAt,
      draft.expiresAt,
      draft.updatedAt,
    );
  }

  get(ownerId: string, id: string): IssueDraftSnapshot | undefined {
    const row = this.#db.all<IssueDraftRow>(
      "SELECT * FROM pa_issue_drafts WHERE owner_id = ? AND id = ?",
      ownerId,
      id,
    )[0];
    return row === undefined ? undefined : mapDraft(row);
  }

  list(ownerId: string, filter: IssueDraftFilter = {}): IssueDraftSnapshot[] {
    const clauses = ["owner_id = ?"];
    const params: (string | number)[] = [ownerId];
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.projectKey !== undefined) {
      clauses.push("project_key = ?");
      params.push(filter.projectKey);
    }
    if (filter.repositoryId !== undefined) {
      clauses.push("repository_id = ?");
      params.push(filter.repositoryId);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.#db
      .all<IssueDraftRow>(
        `SELECT * FROM pa_issue_drafts
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        ...params,
        limit,
      )
      .map(mapDraft);
  }

  findActiveByKey(
    ownerId: string,
    repositoryId: number,
    idempotencyKey: string,
  ): IssueDraftSnapshot | undefined {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const row = this.#db.all<IssueDraftRow>(
      `SELECT * FROM pa_issue_drafts
       WHERE owner_id = ? AND repository_id = ? AND idempotency_key = ?
         AND status IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`,
      ownerId,
      repositoryId,
      idempotencyKey,
      ...ACTIVE_STATUSES,
    )[0];
    return row === undefined ? undefined : mapDraft(row);
  }

  findByActionId(actionId: string): IssueDraftSnapshot | undefined {
    const row = this.#db.all<IssueDraftRow>(
      "SELECT * FROM pa_issue_drafts WHERE write_action_id = ? ORDER BY created_at DESC LIMIT 1",
      actionId,
    )[0];
    return row === undefined ? undefined : mapDraft(row);
  }

  updateStatus(
    id: string,
    status: IssueDraftStatus,
    at: string,
    extra: { writeTaskId?: string; writeActionId?: string } = {},
    fromStatuses?: readonly IssueDraftStatus[],
  ): IssueDraftSnapshot | undefined {
    const allowed =
      fromStatuses === undefined || fromStatuses.length === 0
        ? ""
        : ` AND status IN (${fromStatuses.map(() => "?").join(", ")})`;
    const row = this.#db.all<IssueDraftRow>(
      `UPDATE pa_issue_drafts
       SET status = ?, updated_at = ?,
           write_task_id = COALESCE(?, write_task_id),
           write_action_id = COALESCE(?, write_action_id)
       WHERE id = ?${allowed}
       RETURNING *`,
      status,
      at,
      extra.writeTaskId ?? null,
      extra.writeActionId ?? null,
      id,
      ...(fromStatuses ?? []),
    )[0];
    return row === undefined ? undefined : mapDraft(row);
  }

  /**
   * Supersede every active draft for a task revision change/cancel, except a
   * specific surviving revision. Returns the number of rows changed.
   */
  supersedeForTask(
    taskId: string,
    keepRevision: number | undefined,
    at: string,
  ): number {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.#db.run(
      `UPDATE pa_issue_drafts
       SET status = 'superseded', updated_at = ?
       WHERE source_task_id = ?
         AND (? IS NULL OR source_task_revision <> ?)
         AND status IN (${placeholders})`,
      at,
      taskId,
      keepRevision ?? null,
      keepRevision ?? null,
      ...ACTIVE_STATUSES,
    );
  }

  /** Binding revoke/change or credential rotation invalidates approvals. */
  supersedeForRepository(
    ownerId: string,
    repositoryId: number,
    at: string,
  ): number {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.#db.run(
      `UPDATE pa_issue_drafts
       SET status = 'superseded', updated_at = ?
       WHERE owner_id = ? AND repository_id = ?
         AND status IN (${placeholders})`,
      at,
      ownerId,
      repositoryId,
      ...ACTIVE_STATUSES,
    );
  }

  supersedeForCredential(
    ownerId: string,
    credentialRef: string,
    at: string,
  ): number {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.#db.run(
      `UPDATE pa_issue_drafts
       SET status = 'superseded', updated_at = ?
       WHERE owner_id = ? AND credential_ref = ?
         AND status IN (${placeholders})`,
      at,
      ownerId,
      credentialRef,
      ...ACTIVE_STATUSES,
    );
  }

  expireDue(now: string): number {
    // Only drafts that have not already been approved/executed may expire.
    return this.#db.run(
      `UPDATE pa_issue_drafts
       SET status = 'expired', updated_at = ?
       WHERE expires_at <= ? AND status IN ('draft', 'pending_approval')`,
      now,
      now,
    );
  }
}

export function isActiveDraftStatus(status: IssueDraftStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function mapDraft(row: IssueDraftRow): IssueDraftSnapshot {
  let findingIds: string[];
  try {
    const parsed = JSON.parse(row.finding_ids_json) as unknown;
    findingIds = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    findingIds = [];
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectKey: row.project_key,
    repositoryId: Number(row.repository_id),
    repositoryFullName: row.repository_full_name,
    sourceTaskId: row.source_task_id,
    sourceTaskRevision: Number(row.source_task_revision),
    sourceAssignmentId: row.source_assignment_id,
    commitSha: row.commit_sha,
    findingIds,
    action: row.action,
    ...(row.target_issue === null ? {} : { targetIssue: Number(row.target_issue) }),
    ...(row.before_hash === null ? {} : { beforeHash: row.before_hash }),
    ...(row.before_summary === null ? {} : { beforeSummary: row.before_summary }),
    title: row.title,
    body: row.body,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
    credentialRef: row.credential_ref,
    ...(row.credential_version === null
      ? {}
      : { credentialVersion: Number(row.credential_version) }),
    status: row.status,
    ...(row.write_task_id === null ? {} : { writeTaskId: row.write_task_id }),
    ...(row.write_action_id === null ? {} : { writeActionId: row.write_action_id }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}
