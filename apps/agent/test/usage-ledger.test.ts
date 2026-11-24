import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeUsage } from "../src/domain/types.ts";
import { UsageRepository } from "../src/storage/usage.ts";
import { createStore } from "./helpers.ts";

const AT = "2026-01-01T00:00:00.000Z";

function usage(totalTokens: number, costTotal: number, provider = false): RuntimeUsage {
  return {
    models: {
      "provider/model": {
        input: totalTokens,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: costTotal,
          ...(costTotal > 0 ? { totalFromProvider: provider } : {}),
        },
      },
    },
    tools: {},
  };
}

function owner(store: ReturnType<typeof createStore>, actorId: string) {
  return store.bindOwner({
    channel: "feishu",
    accountId: `app-${actorId}`,
    actorId,
    verifiedAt: AT,
  });
}

describe("usage ledger", () => {
  it("stores cumulative-to-delta rows and is idempotent per operation", () => {
    const store = createStore();
    const ownerId = owner(store, "usage-owner").id;
    const repo = new UsageRepository(store.db);

    assert.equal(
      repo.record({
        ownerId,
        conversationId: "conversation",
        source: "router",
        operationId: "inbox:1",
        sessionId: "router-session",
        cumulative: usage(10, 0.01),
        at: AT,
      }),
      true,
    );
    assert.equal(
      repo.record({
        ownerId,
        conversationId: "conversation",
        source: "router",
        operationId: "inbox:2",
        sessionId: "router-session",
        cumulative: usage(25, 0.03),
        at: AT,
      }),
      true,
    );

    const summary = repo.summary(ownerId);
    assert.equal(summary.totalTokens, 25);
    assert.equal(summary.operations, 2);
    assert.equal(summary.costTotal, 0.03);
    assert.equal(summary.costKind, "catalog");

    // A replayed effect must not advance the cursor or add another row.
    assert.equal(
      repo.record({
        ownerId,
        conversationId: "conversation",
        source: "router",
        operationId: "inbox:2",
        sessionId: "router-session",
        cumulative: usage(40, 0.05),
        at: AT,
      }),
      false,
    );
    assert.equal(repo.summary(ownerId).totalTokens, 25);
    assert.equal(repo.summary(ownerId).operations, 2);
  });

  it("does not double count an unchanged long-lived session", () => {
    const store = createStore();
    const ownerId = owner(store, "usage-stable").id;
    const repo = new UsageRepository(store.db);
    for (const inbox of ["inbox:a", "inbox:b"]) {
      repo.record({
        ownerId,
        conversationId: "conversation",
        source: "router",
        operationId: inbox,
        sessionId: "stable-session",
        cumulative: usage(10, 0.01),
        at: AT,
      });
    }

    const summary = repo.summary(ownerId);
    assert.equal(summary.operations, 2);
    assert.equal(summary.totalTokens, 10);
  });

  it("separates owners and classifies provider, catalog and mixed cost", () => {
    const store = createStore();
    const first = owner(store, "usage-first").id;
    const second = owner(store, "usage-second").id;
    const repo = new UsageRepository(store.db);

    repo.record({
      ownerId: first,
      conversationId: "conversation",
      source: "worker",
      operationId: "assignment:provider",
      sessionId: "worker-1",
      cumulative: usage(10, 0.01, true),
      at: AT,
    });
    repo.record({
      ownerId: first,
      conversationId: "conversation",
      source: "worker",
      operationId: "assignment:catalog",
      sessionId: "worker-2",
      cumulative: usage(5, 0.02, false),
      at: AT,
    });

    const summary = repo.summary(first);
    assert.equal(summary.totalTokens, 15);
    assert.equal(summary.costKind, "mixed");
    assert.equal(repo.summary(second).collected, false);
  });

  it("keeps a single mixed-cost row classified as mixed", () => {
    const store = createStore();
    const ownerId = owner(store, "usage-mixed").id;
    const repo = new UsageRepository(store.db);
    const provider = usage(10, 0.01, true).models["provider/model"];
    const catalog = usage(5, 0.02, false).models["provider/model"];
    assert.ok(provider);
    assert.ok(catalog);
    repo.record({
      ownerId,
      conversationId: "conversation",
      source: "router",
      operationId: "inbox:mixed",
      sessionId: "mixed-session",
      cumulative: {
        models: { "provider/one": provider, "provider/two": catalog },
        tools: {},
      },
      at: AT,
    });

    assert.equal(repo.summary(ownerId).costKind, "mixed");
  });

  it("computes worker end-to-end latency percentiles", () => {
    const store = createStore();
    const ownerId = owner(store, "usage-latency").id;
    const repo = new UsageRepository(store.db);
    for (const [index, durationMs] of [100, 300, 200].entries()) {
      repo.record({
        ownerId,
        conversationId: "conversation",
        source: "worker",
        operationId: `assignment:${index}`,
        sessionId: `worker-${index}`,
        cumulative: usage(1, 0),
        durationMs,
        at: AT,
      });
    }

    assert.deepEqual(repo.summary(ownerId).workerLatency, {
      samples: 3,
      p50Ms: 200,
      p95Ms: 300,
      maxMs: 300,
    });
  });
});
