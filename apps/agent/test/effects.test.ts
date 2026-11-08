import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EffectDispatcher, type EffectOutcome } from "../src/delivery/effects.ts";
import type { EffectRecord } from "../src/domain/types.ts";
import { EffectRepository } from "../src/storage/effects.ts";
import type { Store } from "../src/storage/store.ts";
import { createStore } from "./helpers.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

interface Setup {
  store: Store;
  effects: EffectRepository;
  dispatcher: EffectDispatcher;
  effect: EffectRecord;
  now: () => Date;
  advance: (ms: number) => void;
}

function setup(
  kind: string,
  handler: (effect: EffectRecord) => Promise<EffectOutcome>,
  maxAttempts = 3,
): Setup {
  const store = createStore();
  const effects = new EffectRepository(store.db);

  let current = START;
  const dispatcher = new EffectDispatcher({
    effects,
    now: () => current,
    leaseMs: 1_000,
    maxAttempts,
    retryBaseMs: 1_000,
  });
  dispatcher.register(kind, handler);

  const effect = effects.enqueue({
    kind,
    businessKey: `${kind}_1`,
    payload: {},
    nextAttemptAt: current.toISOString(),
    createdAt: current.toISOString(),
  }).effect;

  return {
    store,
    effects,
    dispatcher,
    effect,
    now: () => current,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

describe("effect retry budget", () => {
  it("honours the handler's retry schedule below the attempt cap", async () => {
    let calls = 0;
    const setupSvc = setup("always_retry", async (effect) => {
      calls += 1;
      return {
        status: "retry",
        at: new Date(setupSvc.now().getTime() + 5_000).toISOString(),
        reason: `attempt ${effect.attempts}`,
      };
    });

    const first = await setupSvc.dispatcher.drain();
    assert.deepEqual(
      { done: first.done, retried: first.retried, failed: first.failed },
      { done: 0, retried: 1, failed: 0 },
    );

    const pending = setupSvc.effects.get(setupSvc.effect.id);
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempts, 1);
    assert.equal(pending.nextAttemptAt, new Date(START.getTime() + 5_000).toISOString());
    assert.equal(pending.lastError, "attempt 1");

    // The retry is not due yet, so the same drain window claims nothing.
    const early = await setupSvc.dispatcher.drain();
    assert.deepEqual(
      { done: early.done, retried: early.retried, failed: early.failed },
      { done: 0, retried: 0, failed: 0 },
    );
    assert.equal(calls, 1);
  });

  it("fails an effect whose handler keeps returning retry past the cap", async () => {
    const setupSvc = setup("always_retry", async (effect) => ({
      status: "retry",
      at: new Date(setupSvc.now().getTime() + 1_000).toISOString(),
      reason: `still busy ${effect.attempts}`,
    }));

    for (let attempt = 1; attempt < 3; attempt += 1) {
      const result = await setupSvc.dispatcher.drain();
      assert.deepEqual(
        { retried: result.retried, failed: result.failed },
        { retried: 1, failed: 0 },
        `attempt ${attempt} should stay retryable`,
      );
      setupSvc.advance(10_000);
    }

    const exhausted = await setupSvc.dispatcher.drain();
    assert.deepEqual(
      { retried: exhausted.retried, failed: exhausted.failed },
      { retried: 0, failed: 1 },
    );

    const failed = setupSvc.effects.get(setupSvc.effect.id);
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastError, "still busy 3");

    const after = await setupSvc.dispatcher.drain();
    assert.deepEqual(
      { done: after.done, retried: after.retried, failed: after.failed },
      { done: 0, retried: 0, failed: 0 },
    );
    assert.equal(setupSvc.effects.get(setupSvc.effect.id)?.attempts, 3);
  });

  it("fails an effect whose handler keeps throwing past the cap", async () => {
    const setupSvc = setup("always_throws", async () => {
      throw new Error("boom");
    });

    for (let attempt = 1; attempt < 3; attempt += 1) {
      const result = await setupSvc.dispatcher.drain();
      assert.deepEqual(
        { retried: result.retried, failed: result.failed },
        { retried: 1, failed: 0 },
        `attempt ${attempt} should stay retryable`,
      );
      setupSvc.advance(10_000);
    }

    const exhausted = await setupSvc.dispatcher.drain();
    assert.deepEqual(
      { retried: exhausted.retried, failed: exhausted.failed },
      { retried: 0, failed: 1 },
    );

    const failed = setupSvc.effects.get(setupSvc.effect.id);
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastError, "boom");
  });
});
