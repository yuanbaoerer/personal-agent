import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Router } from "../src/coordinator/router.ts";
import {
  PiRouterModel,
  ROUTER_WAIT_SLICE_MS,
  RouterPendingError,
} from "../src/coordinator/pi-router.ts";
import { ASSIGNMENT_WAIT_SLICE_MS } from "../src/coordinator/tasks.ts";
import { noopWake, type AgentRuntime } from "../src/runtime/types.ts";
import { inbound } from "./helpers.ts";
import { createServices, type TestServices } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function createTask(services: TestServices, key: string) {
  return services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `source:${key}`,
    goal: `task ${key}`,
    completionCriteria: "done",
  });
}

describe("non-blocking scheduling", () => {
  it(
    "does not let two slow worker waits starve another effect",
    { timeout: 3_000 },
    async () => {
      const services = createServices({ now: () => START });
      const first = createTask(services, "slow-1");
      const second = createTask(services, "slow-2");
      await services.effectDispatcher.drain(2);
      assert.equal(services.tasks.listActiveAssignments().length, 2);

      const waits: number[] = [];
      services.runtime.wait = async (_sessionId, _operationId, timeoutMs = 0) => {
        waits.push(timeoutMs);
        // Integration point: this test verifies the timeout slice itself, so a
        // real delay is the behavior under test. 2 × 100ms stays far below the
        // test budget while the old 20s slice would trip it.
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return { status: "pending" as const };
      };
      let fast = 0;
      services.effectDispatcher.register("test.fast", async () => {
        fast += 1;
        return { status: "done" };
      });
      services.effects.enqueue({
        kind: "test.fast",
        businessKey: "test:fast",
        payload: {},
        nextAttemptAt: services.now().toISOString(),
        createdAt: services.now().toISOString(),
      });

      const result = await services.effectDispatcher.drain(10);

      assert.equal(fast, 1);
      assert.equal(result.done, 1);
      assert.equal(result.retried, 2);
      assert.deepEqual(waits, [
        ASSIGNMENT_WAIT_SLICE_MS,
        ASSIGNMENT_WAIT_SLICE_MS,
      ]);
      assert.equal(services.tasks.get(first.id)?.status, "running");
      assert.equal(services.tasks.get(second.id)?.status, "running");
    },
  );

  it("keeps status and cancel responsive while a worker wait is blocked", async () => {
    const services = createServices({ now: () => START });
    const first = createTask(services, "responsive-1");
    createTask(services, "responsive-2");
    await services.effectDispatcher.drain(2);

    const gate = Promise.withResolvers<void>();
    services.runtime.wait = async () => {
      // Hold the handler exactly like a long model generation would, without
      // binding the test to a wall-clock duration.
      await gate.promise;
      return { status: "pending" as const };
    };
    const drain = services.effectDispatcher.drain(20);

    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const started = Date.now();
      await services.ingress.accept(
        inbound({
          platformEventId: `evt_slow_status_${index}`,
          text: "/status",
        }),
      );
      samples.push(Date.now() - started);
    }

    const cancelStarted = Date.now();
    await services.ingress.accept(
      inbound({
        platformEventId: "evt_slow_cancel",
        text: `/cancel ${first.id.slice(0, 8)}`,
      }),
    );
    const cancelElapsed = Date.now() - cancelStarted;
    const maxStatus = Math.max(...samples);

    assert.ok(maxStatus < 2_000, `status smoke sample ${maxStatus}ms`);
    assert.ok(cancelElapsed < 2_000, `cancel sample ${cancelElapsed}ms`);
    assert.equal(services.tasks.get(first.id)?.status, "cancelling");

    gate.resolve();
    await drain;
    assert.ok(services.store.countOutbox("pending") >= 11);
  });

  it("passes the bounded slice from PiRouterModel to the runtime", async () => {
    const services = createServices({ now: () => START });
    const waits: number[] = [];
    const runtime: AgentRuntime = {
      async open() {
        return { id: "router-session" };
      },
      async submit(_sessionId, _text, operationId) {
        return { operationId };
      },
      async wait(_sessionId, _operationId, timeoutMs = 0) {
        waits.push(timeoutMs);
        return { status: "pending" };
      },
      async interrupt() {},
    };
    const model = new PiRouterModel(services.store, runtime);

    await assert.rejects(
      () =>
        model.decide({
          ownerId: services.owner.id,
          conversationId: services.conversation.id,
          text: "hello",
          inboxId: "inbox:pi-pending",
        }),
      RouterPendingError,
    );
    assert.deepEqual(waits, [ROUTER_WAIT_SLICE_MS]);
  });

  it("turns a pending router model into a bounded retry", async () => {
    const services = createServices({ now: () => START });
    const router = new Router({
      store: services.store,
      tasks: services.tasks,
      actions: services.actions,
      effects: services.effects,
      taskService: services.taskService,
      actionService: services.actionService,
      reminders: services.reminders,
      memory: services.memory,
      confirmation: services.confirmation,
      model: {
        async decide() {
          throw new RouterPendingError();
        },
      },
      wake: noopWake,
      now: services.now,
    });

    const first = await router.handleRoute(
      {
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        inboxId: "inbox:router-pending",
        text: "hello",
      },
      1,
    );
    const later = await router.handleRoute(
      {
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        inboxId: "inbox:router-pending",
        text: "hello",
      },
      7,
    );

    assert.equal(first.status, "retry");
    assert.equal(first.status === "retry" ? first.reason : "", "router model still pending");
    assert.equal(first.status === "retry" ? first.maxAttempts : 0, 1_000);
    assert.equal(
      first.status === "retry" ? Date.parse(first.at) - START.getTime() : 0,
      250,
    );
    assert.equal(
      later.status === "retry" ? Date.parse(later.at) - START.getTime() : 0,
      2_000,
    );

    const transient = new Router({
      store: services.store,
      tasks: services.tasks,
      actions: services.actions,
      effects: services.effects,
      taskService: services.taskService,
      actionService: services.actionService,
      reminders: services.reminders,
      memory: services.memory,
      confirmation: services.confirmation,
      model: {
        async decide() {
          throw new Error("harness closed");
        },
      },
      wake: noopWake,
      now: services.now,
    });
    const failed = await transient.handleRoute(
      {
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        inboxId: "inbox:router-transient",
        text: "hello",
      },
      6,
    );
    assert.equal(failed.status, "retry");
    assert.equal(failed.status === "retry" ? failed.maxAttempts : 0, 1_000);
    assert.match(
      failed.status === "retry" ? failed.reason : "",
      /router model failed: harness closed/,
    );
  });
});
