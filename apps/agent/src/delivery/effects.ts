import type { EffectRecord } from "../domain/types.ts";
import type { EffectRepository } from "../storage/effects.ts";

export type EffectOutcome =
  | { status: "done" }
  | {
      status: "retry";
      at: string;
      reason: string;
      /** Long waits (capacity, a running model) override the global cap. */
      maxAttempts?: number;
    }
  | { status: "failed"; reason: string };

export type EffectHandler = (effect: EffectRecord) => Promise<EffectOutcome>;

export interface EffectDrainResult {
  done: number;
  retried: number;
  failed: number;
  recovered: number;
}

/**
 * Durable background work. Every handler is keyed by a stable business key
 * and must be safe to run again after a crash; repositories enforce the
 * one-time transitions where that matters.
 */
export class EffectDispatcher {
  readonly #effects: EffectRepository;
  readonly #handlers = new Map<string, EffectHandler>();
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;

  constructor(deps: {
    effects: EffectRepository;
    now?: () => Date;
    leaseMs?: number;
    maxAttempts?: number;
    retryBaseMs?: number;
  }) {
    this.#effects = deps.effects;
    this.#now = deps.now ?? (() => new Date());
    this.#leaseMs = deps.leaseMs ?? 30_000;
    this.#maxAttempts = deps.maxAttempts ?? 5;
    this.#retryBaseMs = deps.retryBaseMs ?? 1_000;
  }

  register(kind: string, handler: EffectHandler): void {
    this.#handlers.set(kind, handler);
  }

  async drain(max = 20): Promise<EffectDrainResult> {
    const recovered = this.#effects.recoverExpired(this.#now().toISOString(), 50);
    const result: EffectDrainResult = { done: 0, retried: 0, failed: 0, recovered };

    for (let index = 0; index < max; index += 1) {
      // Refresh the clock so an effect enqueued by the previous iteration is
      // eligible in this same drain, not only on the next maintenance tick.
      const now = this.#now();
      const effect = this.#effects.claimNext(
        now.toISOString(),
        new Date(now.getTime() + this.#leaseMs).toISOString(),
      );
      if (effect === undefined) {
        break;
      }

      const handler = this.#handlers.get(effect.kind);
      if (handler === undefined) {
        this.#effects.markFailed(effect.id, `no handler for effect kind ${effect.kind}`, now.toISOString());
        result.failed += 1;
        continue;
      }

      try {
        const outcome = await handler(effect);
        const at = this.#now().toISOString();
        if (outcome.status === "done") {
          this.#effects.markDone(effect.id, at);
          result.done += 1;
        } else if (outcome.status === "retry") {
          const cap = outcome.maxAttempts ?? this.#maxAttempts;
          if (effect.attempts >= cap) {
            this.#effects.markFailed(effect.id, outcome.reason, at);
            result.failed += 1;
          } else {
            this.#effects.markRetry(effect.id, outcome.at, outcome.reason);
            result.retried += 1;
          }
        } else {
          this.#effects.markFailed(effect.id, outcome.reason, at);
          result.failed += 1;
        }
      } catch (error) {
        const at = this.#now();
        const reason = error instanceof Error ? error.message : String(error);
        if (effect.attempts >= this.#maxAttempts) {
          this.#effects.markFailed(effect.id, reason, at.toISOString());
          result.failed += 1;
        } else {
          const delay = Math.min(
            60_000,
            this.#retryBaseMs * 2 ** Math.max(0, effect.attempts - 1),
          );
          this.#effects.markRetry(
            effect.id,
            new Date(at.getTime() + delay).toISOString(),
            reason,
          );
          result.retried += 1;
        }
      }
    }

    return result;
  }
}
