import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildUsage, formatUsage } from "../src/observability/usage.ts";
import { CONVERSATION_ID } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

describe("usage report", () => {
  it("aggregates task/action/effect/outbox counts without inventing cost", async () => {
    const services = createServices({ now: () => START });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:usage",
      goal: "usage",
      completionCriteria: "done",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "lamp.set_brightness",
      args: { brightness: 40 },
    });
    assert.ok(action);
    services.store.enqueueOutbox({
      businessKey: "usage:outbox",
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: "app_1",
      conversationId: CONVERSATION_ID,
      purpose: "status",
      text: "hello",
      createdAt: START.toISOString(),
    });
    services.confirmation.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceInboxId: "inbox:usage",
      kind: "memory_save",
      payload: { key: "k", value: "v" },
    });

    const snapshot = buildUsage(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
        confirmations: services.confirmation,
      },
      START.toISOString(),
    );

    assert.equal(snapshot.tokens, "not_collected");
    assert.equal(snapshot.tasks.running, 1);
    assert.equal(snapshot.actions.proposed, 1);
    // One manual status row plus the action approval card.
    assert.equal(snapshot.outbox.pending, 2);
    assert.equal(snapshot.confirmations.pending, 1);
    assert.deepEqual(snapshot.actionsByTool, [
      { tool: "lamp.set_brightness", count: 1 },
    ]);
    assert.match(formatUsage(snapshot), /token\/费用：未采集/);
    assert.match(formatUsage(snapshot), /lamp\.set_brightness: 1/);
  });

  it("does not count expired unreaped confirmations as pending", () => {
    let current = START;
    const services = createServices({ now: () => current });
    services.confirmation.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceInboxId: "inbox:usage-expired",
      kind: "memory_save",
      payload: { key: "k", value: "v" },
    });
    current = new Date(START.getTime() + 11 * 60_000);

    const snapshot = buildUsage(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
        confirmations: services.confirmation,
      },
      current.toISOString(),
    );

    assert.equal(snapshot.confirmations.pending, 0);
  });

  it("answers /usage with the same aggregate", async () => {
    const services = createServices({ now: () => START });
    services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:usage-command",
      goal: "usage",
      completionCriteria: "done",
    });

    await sendText(services, "/usage", "evt_usage");

    const reply = services.store
      .listRecentOutbox(10)
      .find((row) => row.text.includes("用量快照"));
    assert.ok(reply);
    assert.match(reply.text, /Task：排队 1/);
    assert.match(reply.text, /token\/费用：未采集/);
  });
});
