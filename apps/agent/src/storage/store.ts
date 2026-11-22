import { randomUUID } from "node:crypto";

import type {
  ActorType,
  ChatType,
  ConversationRecord,
  ConversationTurn,
  ConversationWindow,
  ConversationWindowQuery,
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

export interface AuditFeedItem {
  cursor: number;
  event: string;
  subjectType?: string;
  subjectId?: string;
  traceId: string;
  occurredAt: string;
}

interface AuditRow {
  cursor: number;
  event: string;
  subject_type: string | null;
  subject_id: string | null;
  trace_id: string;
  occurred_at: string;
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

type TurnCandidate = {
  turn: ConversationTurn;
  at: string;
  id: string;
};

function compareTurns(a: TurnCandidate, b: TurnCandidate): number {
  if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  // A user message and the reply it caused can share a timestamp; the user
  // side is always the earlier turn.
  if (a.turn.role !== b.turn.role) {
    return a.turn.role === "user" ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function clipTurn(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  // Keep one turn on one prompt line: normalize control characters and
  // whitespace before clipping so history cannot forge prompt structure.
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limit = Math.max(1, maxChars);
  if (normalized.length <= limit) {
    return { text: normalized, truncated: false };
  }
  return { text: `${normalized.slice(0, limit - 1)}…`, truncated: true };
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

  /**
   * The local Client API reuses the owner's most recent bound conversation so
   * task replies and approval cards still travel through a real channel. It
   * must never invent an `api` conversation that the outbox cannot deliver.
   */
  latestConversation(ownerId: string): ConversationRecord | undefined {
    const row = this.#db.all<ConversationRow>(
      `SELECT * FROM pa_conversations
       WHERE owner_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      ownerId,
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
   * Bounded transcript for the Router. Reads durable inbox/outbox rows
   * instead of keeping a second copy of private chat text. Anything older
   * than the window or dropped by the character cap is counted in
   * `omittedTurns`; individual turns are clipped to `maxTurnChars`.
   */
  listConversationTurns(query: ConversationWindowQuery): ConversationWindow {
    const conversation = this.getConversation(query.conversationId);
    if (conversation === undefined || conversation.ownerId !== query.ownerId) {
      return { turns: [], omittedTurns: 0, truncated: false };
    }
    const maxTurns = Math.max(1, Math.trunc(query.maxTurns));
    const maxChars = Math.max(1, Math.trunc(query.maxChars));
    const maxTurnChars = Math.max(1, Math.trunc(query.maxTurnChars));

    const userWhere = `i.conversation_id = ? AND i.owner_id = ?
      AND i.actor_type = 'user' AND i.status = 'accepted'
      AND i.text IS NOT NULL AND length(trim(i.text)) > 0
      AND (? IS NULL OR i.id <> ?)`;
    const userParams = [
      query.conversationId,
      query.ownerId,
      query.excludeInboxId ?? null,
      query.excludeInboxId ?? null,
    ] as const;

    const outboxWhere = `o.owner_id = ? AND o.channel = ? AND o.account_id = ?
      AND o.conversation_id = ? AND o.status = 'accepted'
      AND o.purpose IN ('status', 'clarify', 'approval', 'result', 'failure')
      AND length(trim(o.text)) > 0`;
    const outboxParams = [
      query.ownerId,
      conversation.channel,
      conversation.accountId,
      conversation.platformConversationId,
    ] as const;

    // One extra row per side detects "there is older history" without
    // fetching the whole conversation into this process.
    const userRows = this.#db.all<{
      id: string;
      text: string;
      received_at: string;
      task_input_seq: number | null;
    }>(
      `SELECT i.id, i.text, i.received_at,
              (SELECT ti.seq FROM pa_task_inputs ti
                WHERE ti.source_inbox_id = i.id
                ORDER BY ti.seq ASC LIMIT 1) AS task_input_seq
       FROM pa_inbox i
       WHERE ${userWhere}
       ORDER BY i.received_at DESC, i.id DESC
       LIMIT ?`,
      ...userParams,
      maxTurns + 1,
    );
    const assistantRows = this.#db.all<{
      id: string;
      text: string;
      created_at: string;
    }>(
      `SELECT o.id, o.text, o.created_at
       FROM pa_outbox o
       WHERE ${outboxWhere}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ?`,
      ...outboxParams,
      maxTurns + 1,
    );

    const totals = this.#db.all<{ user_total: number; assistant_total: number }>(
      `SELECT
         (SELECT COUNT(*) FROM pa_inbox i WHERE ${userWhere}) AS user_total,
         (SELECT COUNT(*) FROM pa_outbox o WHERE ${outboxWhere}) AS assistant_total`,
      ...userParams,
      ...outboxParams,
    )[0];

    const candidates: TurnCandidate[] = [
      ...userRows.map((row) => ({
        turn: {
          role: "user" as const,
          text: row.text,
          at: row.received_at,
          inboxId: row.id,
          ...(row.task_input_seq === null
            ? {}
            : { taskInputSeq: Number(row.task_input_seq) }),
        },
        at: row.received_at,
        id: row.id,
      })),
      ...assistantRows.map((row) => ({
        turn: {
          role: "assistant" as const,
          text: row.text,
          at: row.created_at,
          outboxId: row.id,
        },
        at: row.created_at,
        id: row.id,
      })),
    ].sort(compareTurns);

    const kept: ConversationTurn[] = [];
    let chars = 0;
    let truncated = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (kept.length >= query.maxTurns) {
        break;
      }
      const candidate = candidates[index];
      if (candidate === undefined) {
        continue;
      }
      const clipped = clipTurn(candidate.turn.text, maxTurnChars);
      if (chars + clipped.text.length > maxChars && kept.length > 0) {
        // The window is contiguous: once the budget is spent, everything
        // older is omitted rather than skipped and partially re-included.
        break;
      }
      chars += clipped.text.length;
      truncated = truncated || clipped.truncated;
      kept.push({ ...candidate.turn, text: clipped.text });
    }
    kept.reverse();

    const total = Number(totals?.user_total ?? 0) + Number(totals?.assistant_total ?? 0);
    return {
      turns: kept,
      omittedTurns: Math.max(0, total - kept.length),
      truncated,
    };
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
    const next =
      this.#db.all<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM pa_audit")[0]
        ?.seq ?? 1;
    this.#db.run(
      `INSERT INTO pa_audit
        (id, occurred_at, actor_id, event, subject_type, subject_id,
         before_json, after_json, trace_id, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      event.occurredAt,
      event.actorId ?? null,
      event.event,
      event.subjectType ?? null,
      event.subjectId ?? null,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.traceId,
      Number(next),
    );
  }

  /**
   * Replayable event feed. The monotonic audit seq is the cursor (rowid can
   * change on VACUUM); payloads (goal/message text, action args) are
   * deliberately excluded so a client event subscription cannot become a
   * second leak path for private content.
   */
  listAuditAfter(cursor: number, limit = 100): AuditFeedItem[] {
    return this.#db
      .all<AuditRow>(
        `SELECT seq AS cursor, event, subject_type, subject_id, trace_id, occurred_at
         FROM pa_audit
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
        cursor,
        limit,
      )
      .map((row) => ({
        cursor: Number(row.cursor),
        event: row.event,
        subjectType: row.subject_type ?? undefined,
        subjectId: row.subject_id ?? undefined,
        traceId: row.trace_id,
        occurredAt: row.occurred_at,
      }));
  }
}

export function openStoreFromDb(db: Db): Store {
  return new Store(db);
}
