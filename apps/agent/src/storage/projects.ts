import { randomUUID } from "node:crypto";

import type { ProjectBinding, ProjectStatus } from "../domain/types.ts";
import type { Db } from "./db.ts";

export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConflictError";
  }
}

export class ProjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStoreError";
  }
}

export interface NewProjectBinding {
  ownerId: string;
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch: string;
  credentialRef: string;
  allowedPlanPaths: string[];
  createdAt: string;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  project_key: string;
  repository_id: number;
  repository_full_name: string;
  default_branch: string;
  credential_ref: string;
  allowed_plan_paths_json: string;
  status: ProjectStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Owner-scoped persistence for GitHub repository bindings. The repository id
 * is immutable; `repository_full_name` is display/validation data and may be
 * updated by a future rename flow. Revoked rows are retained for audit.
 */
export class ProjectRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(ownerId: string, status?: ProjectStatus): ProjectBinding[] {
    const rows = status === undefined
      ? this.#db.all<ProjectRow>(
          `SELECT * FROM pa_projects
           WHERE owner_id = ?
           ORDER BY created_at ASC, id ASC`,
          ownerId,
        )
      : this.#db.all<ProjectRow>(
          `SELECT * FROM pa_projects
           WHERE owner_id = ? AND status = ?
           ORDER BY created_at ASC, id ASC`,
          ownerId,
          status,
        );
    return rows.map(mapProject);
  }

  get(ownerId: string, id: string): ProjectBinding | undefined {
    const row = this.#db.all<ProjectRow>(
      "SELECT * FROM pa_projects WHERE owner_id = ? AND id = ?",
      ownerId,
      id,
    )[0];
    return row === undefined ? undefined : mapProject(row);
  }

  findActiveByKey(ownerId: string, projectKey: string): ProjectBinding | undefined {
    const row = this.#db.all<ProjectRow>(
      `SELECT * FROM pa_projects
       WHERE owner_id = ? AND project_key = ? AND status = 'active'`,
      ownerId,
      projectKey,
    )[0];
    return row === undefined ? undefined : mapProject(row);
  }

  findActiveByRepository(
    ownerId: string,
    repositoryId: number,
  ): ProjectBinding | undefined {
    const row = this.#db.all<ProjectRow>(
      `SELECT * FROM pa_projects
       WHERE owner_id = ? AND repository_id = ? AND status = 'active'`,
      ownerId,
      repositoryId,
    )[0];
    return row === undefined ? undefined : mapProject(row);
  }

  create(input: NewProjectBinding): ProjectBinding {
    let row: ProjectRow | undefined;
    try {
      row = this.#db.all<ProjectRow>(
        `INSERT INTO pa_projects
          (id, owner_id, project_key, repository_id, repository_full_name,
           default_branch, credential_ref, allowed_plan_paths_json, status,
           version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
         RETURNING *`,
        randomUUID(),
        input.ownerId,
        input.projectKey,
        input.repositoryId,
        input.repositoryFullName,
        input.defaultBranch,
        input.credentialRef,
        JSON.stringify(input.allowedPlanPaths),
        input.createdAt,
        input.createdAt,
      )[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectConflictError(
          "an active project key or repository is already bound",
        );
      }
      throw error;
    }
    if (row === undefined) {
      throw new ProjectStoreError("project insert returned no row");
    }
    return mapProject(row);
  }

  revoke(
    ownerId: string,
    id: string,
    at: string,
  ): { project: ProjectBinding; changed: boolean } | undefined {
    const existing = this.get(ownerId, id);
    if (existing === undefined) {
      return undefined;
    }
    if (existing.status === "revoked") {
      return { project: existing, changed: false };
    }
    const row = this.#db.all<ProjectRow>(
      `UPDATE pa_projects
       SET status = 'revoked', version = version + 1, updated_at = ?
       WHERE owner_id = ? AND id = ? AND status = 'active'
       RETURNING *`,
      at,
      ownerId,
      id,
    )[0];
    if (row === undefined) {
      // A concurrent revoke won the race; return the current row if visible.
      const current = this.get(ownerId, id);
      return current === undefined
        ? undefined
        : { project: current, changed: false };
    }
    return { project: mapProject(row), changed: true };
  }

  updateRepositoryName(
    ownerId: string,
    id: string,
    repositoryFullName: string,
    at: string,
  ): ProjectBinding | undefined {
    const row = this.#db.all<ProjectRow>(
      `UPDATE pa_projects
       SET repository_full_name = ?, version = version + 1, updated_at = ?
       WHERE owner_id = ? AND id = ? AND status = 'active'
       RETURNING *`,
      repositoryFullName,
      at,
      ownerId,
      id,
    )[0];
    return row === undefined ? undefined : mapProject(row);
  }
}

function mapProject(row: ProjectRow): ProjectBinding {
  let allowedPlanPaths: string[];
  try {
    const parsed = JSON.parse(row.allowed_plan_paths_json) as unknown;
    allowedPlanPaths = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    allowedPlanPaths = [];
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectKey: row.project_key,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    credentialRef: row.credential_ref,
    allowedPlanPaths,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|constraint failed: UNIQUE/i.test(error.message)
  );
}
