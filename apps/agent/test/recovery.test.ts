import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FakeChannel } from "../src/channels/fake.ts";
import { IngressService } from "../src/coordinator/ingress.ts";
import { StaticRouterModel } from "../src/coordinator/router.ts";
import type { InboundHandler } from "../src/coordinator/responder.ts";
import { OutboxDispatcher } from "../src/delivery/outbox.ts";
import { openStore } from "../src/storage/node.ts";
import { APP_ID, OWNER_OPEN_ID, inbound } from "./helpers.ts";
import { createServices, type TestServices } from "./services.ts";

async function withDir(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pa-recovery-"));
  try {
    await fn(join(dir, "agent.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Mirrors the Node maintenance tick so restart behavior is exercised. */
async function maintain(
  services: TestServices,
  dispatcher: OutboxDispatcher,
): Promise<void> {
  await services.ingress.recoverPending(20);
  services.taskService.sweep();
  services.actionService.sweep();
  await services.reminders.fireDue();
  await services.effectDispatcher.drain(20);
  await dispatcher.drain(10);
}

describe("process restart recovery", () => {
  it("processes an accepted inbox row after a crash before routing", async () => {
    await withDir(async (path) => {
      const now = () => new Date("2026-01-01T00:00:00.000Z");
      let store = openStore(path);
      createServices({ store, now });

      const crashing: InboundHandler = {
        async handle() {
          throw new Error("crash before the router persisted its effect");
        },
      };
      const ingress = new IngressService({ store, handler: crashing, now });
      await assert.rejects(
        ingress.accept(inbound({ platformEventId: "evt_restart_inbox", text: "/status" })),
        /crash before the router/,
      );
      assert.equal(store.countInbox("accepted"), 1);
      const pending = store.listPendingInbox(1)[0];
      assert.ok(pending);
      store.close();

      store = openStore(path);
      const services = createServices({ store, now });
      const channel = new FakeChannel();
      const dispatcher = new OutboxDispatcher({ store, channel, now });

      await maintain(services, dispatcher);

      assert.ok(services.store.getInbox(pending.id)?.processedAt !== undefined);
      assert.equal(services.store.countInbox("accepted"), 1);
      assert.equal(services.store.listPendingInbox(10).length, 0);
      assert.equal(channel.sent.length, 1);
      assert.match(channel.sent[0]?.text ?? "", /服务运行中/);
      assert.equal(services.store.countOutbox("accepted"), 1);
      store.close();
    });
  });

  it("requeues a task whose assignment lease expired during the crash", async () => {
    await withDir(async (path) => {
      let current = new Date("2026-01-01T00:00:00.000Z");
      const now = () => current;
      let store = openStore(path);
      let services = createServices({ store, now, assignmentLeaseMs: 60_000 });
      const task = services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: "source:restart-task",
        goal: "survive a restart",
        completionCriteria: "done",
      });
      await services.effectDispatcher.drain(1);
      const first = services.tasks.listActiveAssignments(task.id)[0];
      assert.ok(first);
      assert.notEqual(first.sessionId, "");
      store.close();

      current = new Date(current.getTime() + 61_000);
      store = openStore(path);
      services = createServices({ store, now, assignmentLeaseMs: 60_000 });
      const channel = new FakeChannel();
      const dispatcher = new OutboxDispatcher({ store, channel, now });

      services.taskService.sweep();
      services.taskService.report(
        first.id,
        first.fencingToken,
        first.taskRevision,
        {
          status: "ready",
          summary: "stale worker",
          evidence: [{ kind: "test", value: "stale" }],
        },
      );
      assert.equal(services.tasks.get(task.id)?.status, "queued");

      await maintain(services, dispatcher);

      assert.equal(services.tasks.get(task.id)?.status, "succeeded");
      const assignments = store.db.all<{
        status: string;
        attempt: number;
        session_id: string;
      }>(
        "SELECT status, attempt, session_id FROM pa_assignments WHERE task_id = ? ORDER BY attempt",
        task.id,
      );
      assert.equal(assignments.length, 2);
      assert.equal(assignments[0]?.status, "expired");
      assert.equal(assignments[1]?.status, "reported");
      assert.notEqual(assignments[0]?.session_id, assignments[1]?.session_id);
      assert.equal(services.store.countOutbox("pending"), 0);
      assert.equal(channel.sent.length, 1);
      store.close();
    });
  });

  it("recovers a running effect after its lease expires", async () => {
    await withDir(async (path) => {
      let current = new Date("2026-01-01T00:00:00.000Z");
      const now = () => current;
      let store = openStore(path);
      let services = createServices({ store, now });
      const task = services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: "source:restart-effect",
        goal: "survive an effect lease",
        completionCriteria: "done",
      });
      const effect = store.db.all<{ id: string }>(
        "SELECT id FROM pa_effects WHERE business_key = ?",
        `task:${task.id}:dispatch:r1:a1`,
      )[0];
      assert.ok(effect);
      const claimed = services.effects.claimNext(
        now().toISOString(),
        new Date(now().getTime() + 1_000).toISOString(),
      );
      assert.equal(claimed?.id, effect.id);
      store.close();

      current = new Date(current.getTime() + 1_001);
      store = openStore(path);
      services = createServices({ store, now });
      const result = await services.effectDispatcher.drain(20);

      assert.equal(result.recovered, 1);
      assert.equal(services.tasks.get(task.id)?.status, "succeeded");
      store.close();
    });
  });

  it("repairs a task whose dispatch effect was lost after creation", async () => {
    await withDir(async (path) => {
      const now = () => new Date("2026-01-01T00:00:00.000Z");
      const decision = {
        action: "create_task" as const,
        text: "已接单。",
        task: {
          goal: "repair the missing dispatch",
          completionCriteria: "done",
          mandate: { resources: ["chat"], tools: [] },
        },
      };
      const payload = {
        inboxId: "inbox:lost-dispatch",
        ownerId: "",
        conversationId: "",
        text: "please handle this",
      };
      let store = openStore(path);
      const firstModel = new StaticRouterModel();
      firstModel.push(decision);
      let services = createServices({ store, now, model: firstModel });
      payload.ownerId = services.owner.id;
      payload.conversationId = services.conversation.id;

      await services.router.handleRoute(payload);
      const task = services.tasks.getBySourceKey(
        "inbox:inbox:lost-dispatch:task",
      );
      assert.ok(task);
      const key = `task:${task.id}:dispatch:r1:a1`;
      services.store.db.run("DELETE FROM pa_effects WHERE business_key = ?", key);
      store.close();

      store = openStore(path);
      const replayModel = new StaticRouterModel();
      replayModel.push(decision);
      services = createServices({ store, now, model: replayModel });
      await services.router.handleRoute(payload);

      assert.equal(
        services.store.db.all<{ status: string }>(
          "SELECT status FROM pa_effects WHERE business_key = ?",
          key,
        )[0]?.status,
        "pending",
      );
      const channel = new FakeChannel();
      const dispatcher = new OutboxDispatcher({ store, channel, now });
      await maintain(services, dispatcher);
      assert.equal(services.tasks.get(task.id)?.status, "succeeded");
      store.close();
    });
  });

  it("fires a due reminder exactly once across a restart", async () => {
    await withDir(async (path) => {
      let current = new Date("2026-01-01T00:00:00.000Z");
      const now = () => current;
      let store = openStore(path);
      let services = createServices({ store, now });
      const schedule = await services.reminders.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        text: "drink water",
        dueAt: new Date(current.getTime() + 60_000).toISOString(),
        timezone: "Asia/Shanghai",
      });
      store.close();

      current = new Date(current.getTime() + 61_000);
      store = openStore(path);
      services = createServices({ store, now });
      const channel = new FakeChannel();
      const dispatcher = new OutboxDispatcher({ store, channel, now });

      await maintain(services, dispatcher);
      assert.equal(
        channel.sent.filter((request) => request.text === "drink water").length,
        1,
      );
      assert.equal(services.schedules.get(schedule.id)?.status, "fired");

      await maintain(services, dispatcher);
      assert.equal(
        channel.sent.filter((request) => request.text === "drink water").length,
        1,
      );
      assert.equal(services.store.countOutbox("pending"), 0);
      store.close();
    });
  });

  it("reconciles an action whose external write landed before the crash", async () => {
    await withDir(async (path) => {
      const now = () => new Date("2026-01-01T00:00:00.000Z");
      let store = openStore(path);
      let services = createServices({ store, now });
      const task = services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: "source:restart-action",
        goal: "set the lamp",
        completionCriteria: "lamp set",
        mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
      });
      const claimed = services.tasks.claimNext(
        services.now().toISOString(),
        60_000,
        2,
      );
      assert.ok(claimed);
      const action = services.actionService.propose(task, claimed.assignment, {
        tool: "lamp.set_brightness",
        args: { brightness: 80 },
      });
      assert.ok(action);
      services.actionService.approve({
        actionId: action.id,
        nonce: action.nonce,
        approverId: services.owner.id,
        conversationId: services.conversation.id,
      });
      services.lamp.failAfter = true;
      await services.actionService.handleExecute({ actionId: action.id });
      assert.equal(services.actions.get(action.id)?.status, "unknown");
      assert.equal(services.lamp.getState().brightness, 80);
      store.close();

      store = openStore(path);
      services = createServices({ store, now });
      const channel = new FakeChannel();
      const dispatcher = new OutboxDispatcher({ store, channel, now });

      await maintain(services, dispatcher);

      const settled = services.actions.get(action.id);
      assert.equal(settled?.status, "succeeded");
      assert.equal(settled?.evidence?.reconciled, true);
      assert.equal(services.lamp.getState().brightness, 80);
      store.close();
    });
  });

  it("surfaces needs_manual deliveries in the owner status", () => {
    const services = createServices();
    const row = services.store.enqueueOutbox({
      businessKey: "manual:status",
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: APP_ID,
      conversationId: services.conversation.id,
      purpose: "result",
      text: "unclear delivery",
      createdAt: services.now().toISOString(),
    }).record;
    const claimed = services.store.claimNextOutbox(
      services.now().toISOString(),
      new Date(services.now().getTime() + 1_000).toISOString(),
    );
    assert.ok(claimed);
    services.store.markOutboxNeedsManual(row.id, "cannot verify", services.now().toISOString());

    assert.match(services.router.statusText(services.owner.id), /需人工 1 条/);
    services.store.close();
  });
});
