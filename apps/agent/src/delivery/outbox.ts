import {
  DeliveryRejectedError,
  DeliveryUnknownError,
} from "../domain/errors.ts";
import type { Clock, OutboxRecord, SendRequest } from "../domain/types.ts";
import type { ChannelAdapter } from "../channels/adapter.ts";
import type { Store } from "../storage/store.ts";

export interface OutboxDispatcherDeps {
  store: Store;
  channel: ChannelAdapter;
  now?: Clock;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

export interface DrainResult {
  reconciled: number;
  accepted: number;
  retried: number;
  failed: number;
  unknown: number;
  manual: number;
}

/**
 * Drains persisted deliveries. The platform call is never inside a database
 * transaction; the row is leased first and the outcome is recorded after.
 */
export class OutboxDispatcher {
  readonly #store: Store;
  readonly #channel: ChannelAdapter;
  readonly #now: Clock;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;

  constructor(deps: OutboxDispatcherDeps) {
    this.#store = deps.store;
    this.#channel = deps.channel;
    this.#now = deps.now ?? (() => new Date());
    this.#leaseMs = deps.leaseMs ?? 15_000;
    this.#maxAttempts = deps.maxAttempts ?? 5;
    this.#retryBaseMs = deps.retryBaseMs ?? 1_000;
  }

  async drain(max = 10): Promise<DrainResult> {
    const result: DrainResult = {
      reconciled: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
      unknown: 0,
      manual: 0,
    };
    const now = this.#now();

    const expired = this.#store.listExpiredSending(now.toISOString(), 50);
    for (const row of expired) {
      await this.#reconcile(row, now, result);
    }
    const unknown = this.#store.listUnknownDue(now.toISOString(), 50);
    for (const row of unknown) {
      await this.#reconcile(row, now, result);
    }

    for (let index = 0; index < max; index += 1) {
      const row = this.#store.claimNextOutbox(
        now.toISOString(),
        new Date(now.getTime() + this.#leaseMs).toISOString(),
      );
      if (row === undefined) {
        break;
      }
      await this.#deliver(row, now, result);
    }

    return result;
  }

  async #deliver(row: OutboxRecord, now: Date, result: DrainResult): Promise<void> {
    const request: SendRequest = {
      businessKey: row.businessKey,
      channel: row.channel,
      accountId: row.accountId,
      conversationId: row.conversationId,
      ownerId: row.ownerId,
      purpose: row.purpose,
      text: row.text,
    };

    try {
      const receipt = await this.#channel.send(request);
      if (this.#store.markOutboxAccepted(row.id, receipt.platformMessageId, receipt.acceptedAt)) {
        result.accepted += 1;
      }
    } catch (error) {
      if (error instanceof DeliveryRejectedError) {
        if (error.retryable && row.attempts < this.#maxAttempts) {
          this.#store.markOutboxPending(
            row.id,
            this.#nextAttempt(now, row.attempts),
            error.message,
          );
          result.retried += 1;
        } else {
          this.#store.markOutboxFailed(row.id, error.message, now.toISOString());
          result.failed += 1;
        }
        return;
      }

      const message =
        error instanceof DeliveryUnknownError
          ? error.message
          : `unexpected send error: ${error instanceof Error ? error.message : String(error)}`;
      this.#store.markOutboxUnknown(
        row.id,
        this.#nextAttempt(now, row.attempts),
        message,
      );
      result.unknown += 1;
    }
  }

  async #reconcile(row: OutboxRecord, now: Date, result: DrainResult): Promise<void> {
    const query = this.#channel.findByBusinessKey?.bind(this.#channel);
    if (query === undefined) {
      if (row.attempts >= this.#maxAttempts) {
        this.#store.markOutboxNeedsManual(
          row.id,
          "delivery outcome unknown and channel cannot query",
          now.toISOString(),
        );
        result.manual += 1;
      } else {
        this.#store.markOutboxUnknown(
          row.id,
          this.#nextAttempt(now, row.attempts),
          "delivery outcome unknown and channel cannot query",
        );
        result.unknown += 1;
      }
      return;
    }

    try {
      const receipt = await query(row.businessKey);
      if (receipt !== null) {
        if (
          this.#store.markOutboxAccepted(
            row.id,
            receipt.platformMessageId,
            receipt.acceptedAt,
          )
        ) {
          result.accepted += 1;
          result.reconciled += 1;
        }
        return;
      }

      if (row.attempts >= this.#maxAttempts) {
        this.#store.markOutboxNeedsManual(
          row.id,
          "delivery not found after retry budget",
          now.toISOString(),
        );
        result.manual += 1;
      } else {
        this.#store.markOutboxPending(
          row.id,
          this.#nextAttempt(now, row.attempts),
          "delivery not found; safe to retry",
        );
        result.retried += 1;
      }
    } catch (error) {
      this.#store.markOutboxUnknown(
        row.id,
        this.#nextAttempt(now, row.attempts),
        `delivery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      result.unknown += 1;
    }
  }

  #nextAttempt(now: Date, attempts: number): string {
    const delay = Math.min(
      60_000,
      this.#retryBaseMs * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(now.getTime() + delay).toISOString();
  }
}
