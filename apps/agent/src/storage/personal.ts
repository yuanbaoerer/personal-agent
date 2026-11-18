import { randomUUID } from "node:crypto";

import type { MemoryRecord, ScheduleRecord, ScheduleStatus } from "../domain/types.ts";
import type { Db } from "./db.ts";

interface ScheduleRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  run_key: string;
  due_at: string;
  timezone: string;
  text: string;
  purpose: "reminder";
  expires_at: string;
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  project: string;
  key: string;
  value: string;
  source_event_id: string | null;
  version: number;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

function mapSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    runKey: row.run_key,
    dueAt: row.due_at,
    timezone: row.timezone,
    text: row.text,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    project: row.project.length === 0 ? undefined : row.project,
    key: row.key,
    value: row.value,
    sourceEventId: row.source_event_id ?? undefined,
    version: Number(row.version),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewScheduleInput {
  ownerId: string;
  conversationId: string;
  runKey: string;
  dueAt: string;
  timezone: string;
  text: string;
  expiresAt: string;
  createdAt: string;
}

export class ScheduleRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(input: NewScheduleInput): { inserted: boolean; schedule: ScheduleRecord } {
    const inserted = this.#db.all<ScheduleRow>(
      `INSERT INTO pa_schedules
        (id, owner_id, conversation_id, run_key, due_at, timezone, text, purpose,
         expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reminder', ?, 'pending', ?, ?)
       ON CONFLICT (run_key) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.conversationId,
      input.runKey,
      input.dueAt,
      input.timezone,
      input.text,
      input.expiresAt,
      input.createdAt,
      input.createdAt,
    )[0];

    if (inserted !== undefined) {
      return { inserted: true, schedule: mapSchedule(inserted) };
    }

    const existing = this.getByRunKey(input.runKey);
    if (existing === undefined) {
      throw new Error(`schedule ${input.runKey} conflicted without a row`);
    }
    return { inserted: false, schedule: existing };
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.#db.all<ScheduleRow>(
      "SELECT * FROM pa_schedules WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : mapSchedule(row);
  }

  getByRunKey(runKey: string): ScheduleRecord | undefined {
    const row = this.#db.all<ScheduleRow>(
      "SELECT * FROM pa_schedules WHERE run_key = ?",
      runKey,
    )[0];
    return row === undefined ? undefined : mapSchedule(row);
  }

  listByOwner(ownerId: string, limit = 20): ScheduleRecord[] {
    return this.#db
      .all<ScheduleRow>(
        `SELECT * FROM pa_schedules
         WHERE owner_id = ?
         ORDER BY due_at ASC
         LIMIT ?`,
        ownerId,
        limit,
      )
      .map(mapSchedule);
  }

  listDue(now: string, limit = 50): ScheduleRecord[] {
    return this.#db
      .all<ScheduleRow>(
        `SELECT * FROM pa_schedules
         WHERE status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC
         LIMIT ?`,
        now,
        limit,
      )
      .map(mapSchedule);
  }

  /** Conditional transition: only one caller can fire a schedule. */
  markFired(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedules SET status = 'fired', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        now,
        id,
      ) > 0
    );
  }

  markSkipped(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedules SET status = 'skipped', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        now,
        id,
      ) > 0
    );
  }

  cancel(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_schedules SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        now,
        id,
      ) > 0
    );
  }

  nextDueAt(): string | undefined {
    const row = this.#db.all<{ next: string | null }>(
      `SELECT MIN(due_at) AS next FROM pa_schedules WHERE status = 'pending'`,
    )[0];
    return row?.next ?? undefined;
  }
}

export class MemoryRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  upsert(input: {
    ownerId: string;
    project?: string;
    key: string;
    value: string;
    sourceEventId?: string;
    now: string;
  }): MemoryRecord {
    const row = this.#db.all<MemoryRow>(
      `INSERT INTO pa_memories
        (id, owner_id, project, key, value, source_event_id, version, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)
       ON CONFLICT (owner_id, project, key) DO UPDATE SET
         value = excluded.value,
         source_event_id = excluded.source_event_id,
         version = pa_memories.version + 1,
         status = 'active',
         updated_at = excluded.updated_at
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.project ?? "",
      input.key,
      input.value,
      input.sourceEventId ?? null,
      input.now,
      input.now,
    )[0];

    return mapMemory(row as MemoryRow);
  }

  get(ownerId: string, key: string, project?: string): MemoryRecord | undefined {
    const row = this.#db.all<MemoryRow>(
      "SELECT * FROM pa_memories WHERE owner_id = ? AND project = ? AND key = ?",
      ownerId,
      project ?? "",
      key,
    )[0];
    return row === undefined ? undefined : mapMemory(row);
  }

  listActive(ownerId: string, project?: string): MemoryRecord[] {
    return this.#db
      .all<MemoryRow>(
        `SELECT * FROM pa_memories
         WHERE owner_id = ? AND status = 'active' AND (? IS NULL OR project = ?)
         ORDER BY project ASC, updated_at DESC, key ASC`,
        ownerId,
        project ?? null,
        project ?? "",
      )
      .map(mapMemory);
  }

  /** Global memories plus the task's project; never another project. */
  listApplicable(ownerId: string, project?: string): MemoryRecord[] {
    return this.#db
      .all<MemoryRow>(
        `SELECT * FROM pa_memories
         WHERE owner_id = ? AND status = 'active'
           AND (project = '' OR project = ?)
         ORDER BY project ASC, updated_at DESC, key ASC`,
        ownerId,
        project ?? "",
      )
      .map(mapMemory);
  }

  softDelete(
    ownerId: string,
    key: string,
    project: string | undefined,
    now: string,
  ): MemoryRecord | undefined {
    this.#db.run(
      `UPDATE pa_memories
       SET status = 'deleted', version = version + 1, updated_at = ?
       WHERE owner_id = ? AND project = ? AND key = ? AND status = 'active'`,
      now,
      ownerId,
      project ?? "",
      key,
    );
    return this.get(ownerId, key, project);
  }
}
