import { randomUUID } from "node:crypto";

import type { EffectRecord, EffectStatus } from "../domain/types.ts";
import type { Db } from "./db.ts";

interface EffectRow {
  id: string;
  kind: string;
  business_key: string;
  payload_json: string;
  status: EffectStatus;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapEffect(row: EffectRow): EffectRecord {
  return {
    id: row.id,
    kind: row.kind,
    businessKey: row.business_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewEffectInput {
  kind: string;
  businessKey: string;
  payload: Record<string, unknown>;
  nextAttemptAt: string;
  createdAt: string;
}

export class EffectRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  enqueue(input: NewEffectInput): { inserted: boolean; effect: EffectRecord } {
    const inserted = this.#db.all<EffectRow>(
      `INSERT INTO pa_effects
        (id, kind, business_key, payload_json, status, attempts, next_attempt_at,
         lease_until, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
       ON CONFLICT (business_key) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.kind,
      input.businessKey,
      JSON.stringify(input.payload),
      input.nextAttemptAt,
      input.createdAt,
      input.createdAt,
    )[0];

    if (inserted !== undefined) {
      return { inserted: true, effect: mapEffect(inserted) };
    }

    const existing = this.getByBusinessKey(input.businessKey);
    if (existing === undefined) {
      throw new Error(`effect ${input.businessKey} conflicted without a row`);
    }
    return { inserted: false, effect: existing };
  }

  get(id: string): EffectRecord | undefined {
    const row = this.#db.all<EffectRow>("SELECT * FROM pa_effects WHERE id = ?", id)[0];
    return row === undefined ? undefined : mapEffect(row);
  }

  getByBusinessKey(businessKey: string): EffectRecord | undefined {
    const row = this.#db.all<EffectRow>(
      "SELECT * FROM pa_effects WHERE business_key = ?",
      businessKey,
    )[0];
    return row === undefined ? undefined : mapEffect(row);
  }

  claimNext(now: string, leaseUntil: string): EffectRecord | undefined {
    const row = this.#db.all<EffectRow>(
      `UPDATE pa_effects
       SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE rowid = (
         SELECT candidate.rowid FROM pa_effects candidate
         WHERE candidate.status = 'pending' AND candidate.next_attempt_at <= ?
         ORDER BY candidate.next_attempt_at ASC, candidate.created_at ASC, candidate.rowid ASC
         LIMIT 1
       )
       RETURNING *`,
      leaseUntil,
      now,
      now,
    )[0];

    return row === undefined ? undefined : mapEffect(row);
  }

  recoverExpired(now: string, limit = 50): number {
    return this.#db.run(
      `UPDATE pa_effects
       SET status = 'pending', lease_until = NULL, next_attempt_at = ?,
           last_error = COALESCE(last_error, 'effect lease expired'), updated_at = ?
       WHERE id IN (
         SELECT id FROM pa_effects
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
         ORDER BY lease_until ASC
         LIMIT ?
       )`,
      now,
      now,
      now,
      limit,
    );
  }

  markDone(id: string, now: string): void {
    this.#db.run(
      `UPDATE pa_effects
       SET status = 'done', lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      now,
      id,
    );
  }

  markRetry(id: string, nextAttemptAt: string, reason: string): void {
    this.#db.run(
      `UPDATE pa_effects
       SET status = 'pending', lease_until = NULL, next_attempt_at = ?,
           last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      nextAttemptAt,
      reason,
      nextAttemptAt,
      id,
    );
  }

  markFailed(id: string, reason: string, now: string): void {
    this.#db.run(
      `UPDATE pa_effects
       SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      reason,
      now,
      id,
    );
  }

  cancel(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_effects
         SET status = 'cancelled', lease_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
        now,
        id,
      ) > 0
    );
  }

  listPending(limit = 100): EffectRecord[] {
    return this.#db
      .all<EffectRow>(
        `SELECT * FROM pa_effects
         WHERE status = 'pending'
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
        limit,
      )
      .map(mapEffect);
  }

  nextDueAt(): string | undefined {
    const row = this.#db.all<{ next: string | null }>(
      `SELECT MIN(next_attempt_at) AS next FROM pa_effects WHERE status = 'pending'`,
    )[0];
    return row?.next ?? undefined;
  }

  count(status: EffectStatus): number {
    const row = this.#db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pa_effects WHERE status = ?",
      status,
    )[0];
    return Number(row?.count ?? 0);
  }

  statusCounts(): Record<string, number> {
    const rows = this.#db.all<{ status: string; count: number }>(
      "SELECT status, COUNT(*) AS count FROM pa_effects GROUP BY status",
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }
}
