import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "../src/app.ts";
import { StaticRouterModel } from "../src/coordinator/router.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { noopWake } from "../src/runtime/types.ts";
import type { ReminderTimer } from "../src/personal/reminders.ts";
import type { ScheduleRecord } from "../src/domain/types.ts";
import { APP_ID, OWNER_OPEN_ID, createStore, inbound } from "./helpers.ts";

function build(model: StaticRouterModel, timer?: ReminderTimer) {
  const store = createStore();
  const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
  if (owner === undefined) {
    throw new Error("test owner was not bound");
  }
  const app = createApp({
    store,
    runtime: new FakeRuntime(),
    wake: noopWake,
    model,
    reminderTimer: timer,
  });
  return { app, store, owner };
}

describe("composition root", () => {
  it("takes a chat message from ingress to a queued reply", async () => {
    const model = new StaticRouterModel();
    model.push({ action: "reply", text: "在" });
    const { app, store } = build(model);

    const result = await app.ingress.accept(inbound({ text: "在吗", platformEventId: "evt_root" }));
    assert.equal(result.outcome, "accepted");
    await app.effectDispatcher.drain(50);

    const replies = store.listRecentOutbox(10);
    assert.deepEqual(new Set(replies.map((row) => row.text)), new Set(["已收到。", "在"]));
    assert.ok(replies.every((row) => row.status === "pending"));
  });

  it("runs a task through dispatch and reports success", async () => {
    const model = new StaticRouterModel();
    model.push({
      action: "create_task",
      text: "已接单。",
      task: {
        goal: "整理资料",
        completionCriteria: "输出摘要",
        mandate: { resources: ["chat"], tools: [] },
      },
    });
    const { app, owner } = build(model);

    await app.ingress.accept(inbound({ text: "帮我整理资料", platformEventId: "evt_task" }));
    await app.effectDispatcher.drain(200);

    const tasks = app.tasks.listByOwner(owner.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "succeeded");
    assert.equal(tasks[0]?.resultRef, "fake result");
  });

  it("hands reminders to the injected host timer", async () => {
    const scheduled: ScheduleRecord[] = [];
    const timer: ReminderTimer = {
      async schedule(schedule) {
        scheduled.push(schedule);
      },
      async cancel() {},
    };
    const model = new StaticRouterModel();
    model.push({
      action: "remind",
      text: "喝水",
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "Asia/Shanghai",
    });
    const { app, owner } = build(model, timer);

    await app.ingress.accept(inbound({ text: "明天九点提醒我喝水", platformEventId: "evt_remind" }));
    await app.effectDispatcher.drain(50);

    assert.equal(scheduled.length, 0);
    const pending = app.confirmations.listPending(owner.id);
    assert.equal(pending.length, 1);

    await app.ingress.accept(
      inbound({
        text: `/确认 ${pending[0]?.id.slice(0, 8)}`,
        platformEventId: "evt_remind_confirm",
      }),
    );
    await app.effectDispatcher.drain(50);

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.text, "喝水");
  });
});
