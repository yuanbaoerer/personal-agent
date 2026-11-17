import { randomUUID } from "node:crypto";

import type {
  ActorType,
  ChatType,
  ConversationRecord,
  InboxRecord,
  InboxStatus,
  OutboxPurpose,
  OutboxRecord,
  OutboxStatus,
  OwnerIdentity,
} from "../domain/types.ts";
import { NodeDb, type Db } from "./db.ts";
import { migrate } from "./schema.ts";

export interface NewInbox {
  channel: string;
  accountId: string;
  platformEventId: string;
  ownerId?: string;
  conversationId?: string;
  platformConversationId: string;
  actorId: string;
  actorType: ActorType;
  eventType: string;
  chatType: ChatType;
  replyTo?: string;
  text?: string;
  status: InboxStatus;
  rejectReason?: string;
  occurredAt?: string;
  receivedAt: string;
  traceId: string;
}

export interface NewOutbox {
  businessKey: string;
  ownerId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  taskId?: string;
  purpose: OutboxPurpose;
  text: string;
  createdAt: string;
  nextAttemptAt?: string;
  traceId?: string;
}

export interface OutboxDiagnostic {
  id: string;
  businessKey: string;
  ownerId: string;
  purpose: OutboxPurpose;
  status: OutboxStatus;
  attempts: number;
  traceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  actorId?: string;
  event: string;
  subjectType?: string;
  subjectId?: string;
  before?: unknown;
  after?: unknown;
  traceId: string;
  occurredAt: string;
}

interface IdentityRow {
  id: string;
  channel: string;
  account_id: string;
  actor_id: string;
  display_name: string | null;
  verified_at: string;
  revoked_at: string | null;
}

interface ConversationRow {
  id: string;
  owner_id: string;
  channel: string;
  account_id: string;
  platform_conversation_id: string;
  kind: ChatType;
  created_at: string;
}

interface InboxRow {
  id: string;
  channel: string;
  account_id: string;
  platform_event_id: string;
  owner_id: string | null;
  conversation_id: string | null;
  platform_conversation_id: string;
  actor_id: string;
  actor_type: ActorType;
  event_type: string;
  chat_type: ChatType;
  reply_to: string | null;
  text: string | null;
  status: InboxStatus;
  reject_reason: string | null;
  occurred_at: string | null;
  received_at: string;
  processed_at: string | null;
  trace_id: string;
}

interface OutboxRow {
  id: string;
  business_key: string;
  owner_id: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  task_id: string | null;
  purpose: OutboxPurpose;
  text: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  trace_id: string | null;
  platform_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

function mapIdentity(row: IdentityRow): OwnerIdentity {
  return {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    actorId: row.actor_id,
    displayName: row.display_name ?? undefined,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    channel: row.channel,
    accountId: row.account_id,
    platformConversationId: row.platform_conversation_id,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function mapInbox(row: InboxRow): InboxRecord {
  return {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    platformEventId: row.platform_event_id,
    ownerId: row.owner_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    platformConversationId: row.platform_conversation_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    eventType: row.event_type,
    chatType: row.chat_type,
    replyTo: row.reply_to ?? undefined,
    text: row.text ?? undefined,
    status: row.status,
    rejectReason: row.reject_reason ?? undefined,
    occurredAt: row.occurred_at ?? undefined,
    receivedAt: row.received_at,
    processedAt: row.processed_at ?? undefined,
    traceId: row.trace_id,
  };
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    businessKey: row.business_key,
    ownerId: row.owner_id,
    channel: row.channel,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    taskId: row.task_id ?? undefined,
    purpose: row.purpose,
    text: row.text,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until ?? undefined,
    traceId: row.trace_id ?? undefined,
    platformMessageId: row.platform_message_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    readAt: row.read_at ?? undefined,
  };
}

export class Store {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    migrate(db);
  }

  get db(): Db {
    return this.#db;
  }

  close(): void {
    if (this.#db instanceof NodeDb) {
      this.#db.close();
    }
  }

  metaGet(key: string): string | undefined {
    const row = this.#db.all<{ value: string }>(
      "SELECT value FROM pa_meta WHERE key = ?",
      key,
    )[0];
    return row?.value;
  }

  metaSet(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO pa_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  bindOwner(input: {
    channel: string;
    accountId: string;
    actorId: string;
    displayName?: string;
    verifiedAt: string;
  }): OwnerIdentity {
    const rows = this.#db.all<IdentityRow>(
      `INSERT INTO pa_identities
        (id, channel, account_id, actor_id, display_name, verified_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (channel, account_id, actor_id) DO UPDATE SET
         display_name = excluded.display_name,
         verified_at = excluded.verified_at,
         revoked_at = NULL
       RETURNING *`,
      randomUUID(),
      input.channel,
      input.accountId,
      input.actorId,
      input.displayName ?? null,
      input.verifiedAt,
    );

    return mapIdentity(rows[0] as IdentityRow);
  }

  findOwner(channel: string, accountId: string, actorId: string): OwnerIdentity | undefined {
    const row = this.#db.all<IdentityRow>(
      `SELECT * FROM pa_identities
       WHERE channel = ? AND account_id = ? AND actor_id = ? AND revoked_at IS NULL`,
      channel,
      accountId,
      actorId,
    )[0];

    return row === undefined ? undefined : mapIdentity(row);
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.#db.all<ConversationRow>(
      "SELECT * FROM pa_conversations WHERE id = ?",
      id,
    )[0];
    return row === undefined ? undefined : mapConversation(row);
  }

  upsertConversation(input: {
    ownerId: string;
    channel: string;
    accountId: string;
    platformConversationId: string;
    kind: ChatType;
    createdAt: string;
  }): ConversationRecord {
    const rows = this.#db.all<ConversationRow>(
      `INSERT INTO pa_conversations
        (id, owner_id, channel, account_id, platform_conversation_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, account_id, platform_conversation_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         kind = excluded.kind
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.channel,
      input.accountId,
      input.platformConversationId,
      input.kind,
      input.createdAt,
    );

    return mapConversation(rows[0] as ConversationRow);
  }

  insertInbox(input: NewInbox): { inserted: boolean; record: InboxRecord } {
    const inserted = this.#db.all<InboxRow>(
      `INSERT INTO pa_inbox
        (id, channel, account_id, platform_event_id, owner_id, conversation_id,
         platform_conversation_id, actor_id, actor_type, event_type, chat_type,
         reply_to, text, status, reject_reason, occurred_at, received_at, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, account_id, platform_event_id) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.channel,
      input.accountId,
      input.platformEventId,
      input.ownerId ?? null,
      input.conversationId ?? null,
      input.platformConversationId,
      input.actorId,
      input.actorType,
      input.eventType,
      input.chatType,
      input.replyTo ?? null,
      input.text ?? null,
      input.status,
      input.rejectReason ?? null,
      input.occurredAt ?? null,
      input.receivedAt,
      input.traceId,
    )[0];

    if (inserted !== undefined) {
      return { inserted: true, record: mapInbox(inserted) };
    }

    const existing = this.#db.all<InboxRow>(
      `SELECT * FROM pa_inbox
       WHERE channel = ? AND account_id = ? AND platform_event_id = ?`,
      input.channel,
      input.accountId,
      input.platformEventId,
    )[0];

    return { inserted: false, record: mapInbox(existing as InboxRow) };
  }

  markInboxProcessed(id: string, processedAt: string): void {
    this.#db.run(
      `UPDATE pa_inbox SET processed_at = ?
       WHERE id = ? AND status = 'accepted' AND processed_at IS NULL`,
      processedAt,
      id,
    );
  }

  listPendingInbox(limit: number): InboxRecord[] {
    const rows = this.#db.all<InboxRow>(
      `SELECT * FROM pa_inbox
       WHERE status = 'accepted' AND processed_at IS NULL
       ORDER BY received_at ASC, id ASC
       LIMIT ?`,
      limit,
    );

    return rows.map(mapInbox);
  }

  getInbox(id: string): InboxRecord | undefined {
    const row = this.#db.all<InboxRow>("SELECT * FROM pa_inbox WHERE id = ?", id)[0];
    return row === undefined ? undefined : mapInbox(row);
  }

  enqueueOutbox(input: NewOutbox): { inserted: boolean; record: OutboxRecord } {
    const inserted = this.#db.all<OutboxRow>(
      `INSERT INTO pa_outbox
        (id, business_key, owner_id, channel, account_id, conversation_id, task_id,
         purpose, text, status, attempts, next_attempt_at, trace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
       ON CONFLICT (business_key) DO NOTHING
       RETURNING *`,
      randomUUID(),
      input.businessKey,
      input.ownerId,
      input.channel,
      input.accountId,
      input.conversationId,
      input.taskId ?? null,
      input.purpose,
      input.text,
      input.nextAttemptAt ?? input.createdAt,
      input.traceId ?? null,
      input.createdAt,
      input.createdAt,
    )[0];

    if (inserted !== undefined) {
      return { inserted: true, record: mapOutbox(inserted) };
    }

    const existing = this.#db.all<OutboxRow>(
      "SELECT * FROM pa_outbox WHERE business_key = ?",
      input.businessKey,
    )[0];

    return { inserted: false, record: mapOutbox(existing as OutboxRow) };
  }

  claimNextOutbox(now: string, leaseUntil: string): OutboxRecord | undefined {
    const row = this.#db.all<OutboxRow>(
      `UPDATE pa_outbox
       SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE rowid = (
         SELECT candidate.rowid FROM pa_outbox candidate
         WHERE candidate.status = 'pending' AND candidate.next_attempt_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM pa_outbox earlier
             WHERE COALESCE(earlier.task_id, earlier.conversation_id)
                 = COALESCE(candidate.task_id, candidate.conversation_id)
               AND earlier.rowid < candidate.rowid
               AND earlier.status IN ('pending', 'sending', 'unknown', 'needs_manual')
           )
         ORDER BY candidate.next_attempt_at ASC, candidate.created_at ASC, candidate.rowid ASC
         LIMIT 1
       )
       RETURNING *`,
      leaseUntil,
      now,
      now,
    )[0];

    return row === undefined ? undefined : mapOutbox(row);
  }

  listExpiredSending(now: string, limit: number): OutboxRecord[] {
    const rows = this.#db.all<OutboxRow>(
      `SELECT * FROM pa_outbox
       WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?
       ORDER BY lease_until ASC
       LIMIT ?`,
      now,
      limit,
    );

    return rows.map(mapOutbox);
  }

  listUnknownDue(now: string, limit: number): OutboxRecord[] {
    const rows = this.#db.all<OutboxRow>(
      `SELECT * FROM pa_outbox
       WHERE status = 'unknown' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      now,
      limit,
    );

    return rows.map(mapOutbox);
  }

  markOutboxAccepted(
    id: string,
    platformMessageId: string,
    acceptedAt: string,
  ): boolean {
    const changes = this.#db.run(
      `UPDATE pa_outbox
       SET status = 'accepted', platform_message_id = ?, accepted_at = ?,
           lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('sending', 'unknown')`,
      platformMessageId,
      acceptedAt,
      acceptedAt,
      id,
    );

    return changes > 0;
  }

  markOutboxPending(id: string, nextAttemptAt: string, reason: string): void {
    this.#db.run(
      `UPDATE pa_outbox
       SET status = 'pending', next_attempt_at = ?, lease_until = NULL,
           last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('sending', 'unknown')`,
      nextAttemptAt,
      reason,
      nextAttemptAt,
      id,
    );
  }

  markOutboxUnknown(id: string, nextAttemptAt: string, reason: string): void {
    this.#db.run(
      `UPDATE pa_outbox
       SET status = 'unknown', attempts = attempts + 1, next_attempt_at = ?,
           lease_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('sending', 'unknown')`,
      nextAttemptAt,
      reason,
      nextAttemptAt,
      id,
    );
  }

  markOutboxFailed(id: string, reason: string, at: string): void {
    this.#db.run(
      `UPDATE pa_outbox
       SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'sending', 'unknown')`,
      reason,
      at,
      id,
    );
  }

  markOutboxNeedsManual(id: string, reason: string, at: string): void {
    this.#db.run(
      `UPDATE pa_outbox
       SET status = 'needs_manual', lease_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('sending', 'unknown')`,
      reason,
      at,
      id,
    );
  }

  cancelOutboxForTask(taskId: string, at: string): number {
    return this.#db.run(
      `UPDATE pa_outbox
       SET status = 'cancelled', lease_until = NULL, updated_at = ?
       WHERE task_id = ? AND status = 'pending'`,
      at,
      taskId,
    );
  }

  cancelOutboxByBusinessKey(businessKey: string, at: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_outbox SET status = 'cancelled', lease_until = NULL, updated_at = ?
         WHERE business_key = ? AND status = 'pending'`,
        at,
        businessKey,
      ) > 0
    );
  }

  getOutboxByBusinessKey(businessKey: string): OutboxRecord | undefined {
    const row = this.#db.all<OutboxRow>(
      "SELECT * FROM pa_outbox WHERE business_key = ?",
      businessKey,
    )[0];

    return row === undefined ? undefined : mapOutbox(row);
  }

  listRecentOutbox(limit = 20): OutboxRecord[] {
    return this.#db
      .all<OutboxRow>(
        `SELECT * FROM pa_outbox ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .map(mapOutbox);
  }

  /**
   * Delivery rows needing attention, without message text. Diagnostics must
   * never leak private conversation content.
   */
  listOutboxDiagnostics(
    statuses: OutboxStatus[],
    limit = 20,
    ownerId?: string,
  ): OutboxDiagnostic[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.#db.all<{
      id: string;
      business_key: string;
      owner_id: string;
      purpose: OutboxPurpose;
      status: OutboxStatus;
      attempts: number;
      trace_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, business_key, owner_id, purpose, status, attempts,
              trace_id, created_at, updated_at
       FROM pa_outbox
       WHERE status IN (${placeholders}) AND (? IS NULL OR owner_id = ?)
       ORDER BY updated_at DESC
       LIMIT ?`,
      ...statuses,
      ownerId ?? null,
      ownerId ?? null,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      businessKey: row.business_key,
      ownerId: row.owner_id,
      purpose: row.purpose,
      status: row.status,
      attempts: Number(row.attempts),
      traceId: row.trace_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  nextOutboxDueAt(): string | undefined {
    const row = this.#db.all<{ next: string | null }>(
      `SELECT MIN(next_attempt_at) AS next FROM pa_outbox
       WHERE status IN ('pending', 'unknown')`,
    )[0];
    return row?.next ?? undefined;
  }

  countInbox(status: InboxStatus): number {
    const row = this.#db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pa_inbox WHERE status = ?",
      status,
    )[0];

    return Number(row?.count ?? 0);
  }

  countOutbox(status: OutboxStatus): number {
    const row = this.#db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pa_outbox WHERE status = ?",
      status,
    )[0];

    return Number(row?.count ?? 0);
  }

  recordAudit(event: AuditEvent): void {
    this.#db.run(
      `INSERT INTO pa_audit
        (id, occurred_at, actor_id, event, subject_type, subject_id,
         before_json, after_json, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      event.occurredAt,
      event.actorId ?? null,
      event.event,
      event.subjectType ?? null,
      event.subjectId ?? null,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.traceId,
    );
  }
}

export function openStoreFromDb(db: Db): Store {
  return new Store(db);
}
