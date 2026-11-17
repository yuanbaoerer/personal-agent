import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDiagnostics, formatDiagnostics } from "../src/observability/diagnostics.ts";
import { CONVERSATION_ID, inbound } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");
const SECRET = "private owner text / token should never appear";

describe("operator diagnostics", () => {
  it("reports stuck and unknown work without message content", async () => {
    let current = START;
    const services = createServices({ now: () => current });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:diagnostics",
      goal: SECRET,
      completionCriteria: SECRET,
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(START.toISOString(), 1_000, 2);
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
    assert.equal(
      services.actions.claimForExecution(action.id, START.toISOString(), 30_000).ok,
      true,
    );
    services.actions.markUnknown(action.id, "external result unknown", START.toISOString());
    services.tasks.updateTask(task.id, task.revision, {
      lastError: SECRET,
      updatedAt: START.toISOString(),
    });

    const manual = services.store.enqueueOutbox({
      businessKey: "diagnostics:manual",
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: "app_1",
      conversationId: CONVERSATION_ID,
      purpose: "result",
      text: SECRET,
      createdAt: START.toISOString(),
      traceId: `task:${task.id}`,
    }).record;
    const leaseUntil = new Date(START.getTime() + 1_000).toISOString();
    for (let index = 0; index < 10; index += 1) {
      const claimed = services.store.claimNextOutbox(START.toISOString(), leaseUntil);
      if (claimed === undefined || claimed.id === manual.id) {
        break;
      }
      services.store.markOutboxPending(
        claimed.id,
        new Date(START.getTime() + 60_000).toISOString(),
        "test cleanup",
      );
    }
    services.store.markOutboxNeedsManual(
      manual.id,
      "platform receipt unclear",
      START.toISOString(),
    );

    await sendText(services, "/status", "evt_diagnostics_status");
    current = new Date(START.getTime() + 5_000);
    assert.equal(services.tasks.listExpiredAssignments(current.toISOString()).length, 1);

    const snapshot = buildDiagnostics(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
      },
      current.toISOString(),
      { ownerId: services.owner.id },
    );
    const text = formatDiagnostics(snapshot);

    assert.match(text, /过期 Assignment 1 条/);
    assert.match(text, /未知 Action 1 条/);
    assert.match(text, /需核对投递/);
    assert.ok(snapshot.outbox.some((row) => row.status === "needs_manual"));
    assert.match(text, /needs_manual attempts 1/);
    assert.ok(!text.includes("platform receipt unclear"));
    assert.ok(!text.includes("external result unknown"));
    assert.ok(!JSON.stringify(snapshot).includes(SECRET));
    assert.ok(!JSON.stringify(snapshot).includes("external result unknown"));
    assert.ok(!JSON.stringify(snapshot).includes("platform receipt unclear"));
    assert.ok(!text.includes(SECRET));
    assert.ok(!JSON.stringify(snapshot).includes('"args"'));
    assert.ok(!JSON.stringify(snapshot).includes('"brightness"'));
    assert.ok(
      services.store
        .listRecentOutbox(1)[0]
        ?.traceId?.startsWith("inbox:"),
    );

    await services.ingress.accept(
      inbound({ platformEventId: "evt_diagnostics_command", text: "/诊断" }),
    );
    const reply = services.store
      .listRecentOutbox(20)
      .find((row) => row.text.includes("诊断快照"));
    assert.ok(reply);
    assert.match(reply.text, /诊断快照/);
    assert.ok(!reply.text.includes(SECRET));
  });
});
