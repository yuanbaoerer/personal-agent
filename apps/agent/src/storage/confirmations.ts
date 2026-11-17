import { randomUUID } from "node:crypto";

import type {
  ConfirmationKind,
  ConfirmationRecord,
  ConfirmationStatus,
} from "../domain/types.ts";
import type { Db } from "./db.ts";

interface ConfirmationRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  source_inbox_id: string;
  kind: ConfirmationKind;
  payload_json: string;
  status: ConfirmationStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function mapConfirmation(row: ConfirmationRow): ConfirmationRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    sourceInboxId: row.source_inbox_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewConfirmation {
  ownerId: string;
  conversationId: string;
  sourceInboxId: string;
  kind: ConfirmationKind;
  payload: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

export class ConfirmationRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: NewConfirmation): { inserted: boolean; confirmation: ConfirmationRecord } {
    const row = this.#db.all<ConfirmationRow>(
      `INSERT INTO pa_confirmations
        (id, owner_id, conversation_id, source_inbox_id, kind, payload_json,
         status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (owner_id, source_inbox_id, kind) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.conversationId,
      input.sourceInboxId,
      input.kind,
      JSON.stringify(input.payload),
      input.expiresAt,
      input.createdAt,
      input.createdAt,
    )[0];
    if (row !== undefined) {
      return { inserted: true, confirmation: mapConfirmation(row) };
    }
    const existing = this.#db.all<ConfirmationRow>(
      `SELECT * FROM pa_confirmations
       WHERE owner_id = ? AND source_inbox_id = ? AND kind = ?`,
      input.ownerId,
      input.sourceInboxId,
      input.kind,
    )[0];
    if (existing === undefined) {
      throw new Error("confirmation insert conflicted but no row exists");
    }
    return { inserted: false, confirmation: mapConfirmation(existing) };
  }

  get(id: string): ConfirmationRecord | undefined {
    const row = this.#db.all<ConfirmationRow>(
      "SELECT * FROM pa_confirmations WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : mapConfirmation(row);
  }

  /** Exact id or unambiguous literal prefix, scoped to the owner. */
  resolve(ownerId: string, idOrPrefix: string): ConfirmationRecord[] {
    return this.#db
      .all<ConfirmationRow>(
        `SELECT * FROM pa_confirmations
         WHERE owner_id = ? AND (id = ? OR substr(id, 1, ?) = ?)
         ORDER BY created_at DESC
         LIMIT 2`,
        ownerId,
        idOrPrefix,
        idOrPrefix.length,
        idOrPrefix,
      )
      .map(mapConfirmation);
  }

  listPending(ownerId: string, limit = 20): ConfirmationRecord[] {
    return this.#db
      .all<ConfirmationRow>(
        `SELECT * FROM pa_confirmations
         WHERE owner_id = ? AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT ?`,
        ownerId,
        limit,
      )
      .map(mapConfirmation);
  }

  markStatus(
    id: string,
    status: Exclude<ConfirmationStatus, "pending">,
    now: string,
  ): ConfirmationRecord | undefined {
    const row = this.#db.all<ConfirmationRow>(
      `UPDATE pa_confirmations
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
      status,
      now,
      id,
    )[0];
    return row === undefined ? undefined : mapConfirmation(row);
  }

  /** Lazily close rows that can no longer be applied. Returns the count. */
  expirePending(now: string): number {
    return this.#db.run(
      `UPDATE pa_confirmations
       SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND expires_at <= ?`,
      now,
      now,
    );
  }

  countPending(now: string, ownerId?: string): number {
    const row = this.#db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM pa_confirmations
       WHERE status = 'pending' AND expires_at > ?
         AND (? IS NULL OR owner_id = ?)`,
      now,
      ownerId ?? null,
      ownerId ?? null,
    )[0];
    return Number(row?.count ?? 0);
  }
}
