import { randomUUID } from "node:crypto";

import type { PreauthorizationRecord } from "../domain/types.ts";
import type { Db } from "./db.ts";

interface PreauthorizationRow {
  id: string;
  owner_id: string;
  tool: string;
  repo: string;
  status: "active" | "revoked" | "expired";
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function map(row: PreauthorizationRow): PreauthorizationRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    tool: row.tool,
    repo: row.repo,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PreauthorizationRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  upsert(input: {
    ownerId: string;
    tool: string;
    repo: string;
    expiresAt: string;
    now: string;
  }): PreauthorizationRecord {
    const row = this.#db.all<PreauthorizationRow>(
      `INSERT INTO pa_preauthorizations
        (id, owner_id, tool, repo, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (owner_id, tool, repo) DO UPDATE SET
         status = 'active', expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.tool,
      input.repo,
      input.expiresAt,
      input.now,
      input.now,
    )[0];
    if (row === undefined) {
      throw new Error("preauthorization upsert returned no row");
    }
    return map(row);
  }

  findActive(
    ownerId: string,
    tool: string,
    repo: string,
    now: string,
  ): PreauthorizationRecord | undefined {
    const row = this.#db.all<PreauthorizationRow>(
      `SELECT * FROM pa_preauthorizations
       WHERE owner_id = ? AND tool = ? AND repo = ?
         AND status = 'active' AND expires_at > ?
       LIMIT 1`,
      ownerId,
      tool,
      repo,
      now,
    )[0];
    return row === undefined ? undefined : map(row);
  }

  get(id: string): PreauthorizationRecord | undefined {
    const row = this.#db.all<PreauthorizationRow>(
      "SELECT * FROM pa_preauthorizations WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : map(row);
  }

  revoke(ownerId: string, tool: string, repo: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_preauthorizations
         SET status = 'revoked', updated_at = ?
         WHERE owner_id = ? AND tool = ? AND repo = ? AND status = 'active'`,
        now,
        ownerId,
        tool,
        repo,
      ) > 0
    );
  }

  list(ownerId: string): PreauthorizationRecord[] {
    return this.#db
      .all<PreauthorizationRow>(
        `SELECT * FROM pa_preauthorizations
         WHERE owner_id = ? ORDER BY repo ASC, tool ASC`,
        ownerId,
      )
      .map(map);
  }
}
