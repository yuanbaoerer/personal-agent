import type {
  ConfirmationKind,
  ConfirmationRecord,
} from "../domain/types.ts";
import type { ConfirmationRepository } from "../storage/confirmations.ts";
import type { Store } from "../storage/store.ts";

export interface ConfirmationServiceDeps {
  store: Store;
  confirmations: ConfirmationRepository;
  now?: () => Date;
  ttlMs?: number;
}

export type PendingResolution =
  | { status: "ok"; confirmation: ConfirmationRecord }
  | { status: "failure"; reason: string };

/**
 * Model-interpreted writes (save_memory/remind) land here first. Explicit
 * slash commands stay immediate; only ambiguous natural language needs the
 * owner's confirmation.
 */
export class ConfirmationService {
  readonly #store: Store;
  readonly #confirmations: ConfirmationRepository;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(deps: ConfirmationServiceDeps) {
    this.#store = deps.store;
    this.#confirmations = deps.confirmations;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.ttlMs ?? 10 * 60_000;
  }

  create(input: {
    ownerId: string;
    conversationId: string;
    sourceInboxId: string;
    kind: ConfirmationKind;
    payload: Record<string, unknown>;
    /** Optional earlier deadline, e.g. a reminder's dueAt. */
    expiresAt?: string;
  }): { inserted: boolean; confirmation: ConfirmationRecord } {
    const now = this.#now();
    const ttlExpiry = new Date(now.getTime() + this.#ttlMs);
    const requested = input.expiresAt === undefined ? ttlExpiry : new Date(input.expiresAt);
    const expiresAt = (
      Number.isNaN(requested.getTime()) || requested > ttlExpiry ? ttlExpiry : requested
    ).toISOString();
    const result = this.#confirmations.insert({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sourceInboxId: input.sourceInboxId,
      kind: input.kind,
      payload: input.payload,
      expiresAt,
      createdAt: now.toISOString(),
    });
    if (result.inserted) {
      this.#store.recordAudit({
        event: "confirmation.created",
        subjectType: "confirmation",
        subjectId: result.confirmation.id,
        after: { kind: input.kind, expiresAt: result.confirmation.expiresAt },
        traceId: `confirmation:${result.confirmation.id}`,
        occurredAt: now.toISOString(),
      });
    }
    return result;
  }

  resolvePending(ownerId: string, idOrPrefix: string): PendingResolution {
    const matches = this.#confirmations.resolve(ownerId, idOrPrefix);
    if (matches.length === 0) {
      return { status: "failure", reason: "找不到待确认项。" };
    }
    if (matches.length > 1) {
      return { status: "failure", reason: "确认编号前缀不唯一，请提供更长编号。" };
    }
    const confirmation = matches[0] as ConfirmationRecord;
    if (confirmation.status !== "pending") {
      return {
        status: "failure",
        reason: `该确认项当前状态为 ${confirmation.status}。`,
      };
    }
    const now = this.#now();
    if (now.getTime() >= new Date(confirmation.expiresAt).getTime()) {
      this.#confirmations.markStatus(confirmation.id, "expired", now.toISOString());
      return { status: "failure", reason: "确认已过期，请重新发起。" };
    }
    return { status: "ok", confirmation };
  }

  markConfirmed(confirmation: ConfirmationRecord): ConfirmationRecord {
    const now = this.#now().toISOString();
    const updated = this.#confirmations.markStatus(confirmation.id, "confirmed", now);
    if (updated === undefined) {
      return confirmation;
    }
    this.#store.recordAudit({
      event: "confirmation.confirmed",
      subjectType: "confirmation",
      subjectId: confirmation.id,
      after: { kind: confirmation.kind },
      traceId: `confirmation:${confirmation.id}`,
      occurredAt: now,
    });
    return updated;
  }

  cancel(
    ownerId: string,
    idOrPrefix: string,
  ): { status: "cancelled"; confirmation: ConfirmationRecord } | { status: "failure"; reason: string } {
    const pending = this.resolvePending(ownerId, idOrPrefix);
    if (pending.status === "failure") {
      return pending;
    }
    const now = this.#now().toISOString();
    const cancelled = this.#confirmations.markStatus(
      pending.confirmation.id,
      "cancelled",
      now,
    );
    if (cancelled === undefined) {
      return { status: "failure", reason: "确认项已被处理。" };
    }
    this.#store.recordAudit({
      event: "confirmation.cancelled",
      subjectType: "confirmation",
      subjectId: cancelled.id,
      after: { kind: cancelled.kind },
      traceId: `confirmation:${cancelled.id}`,
      occurredAt: now,
    });
    return { status: "cancelled", confirmation: cancelled };
  }
}
