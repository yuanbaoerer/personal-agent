import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createServices, sendText } from "./services.ts";

describe("K05: owner commands do not wait for a worker slot", () => {
  it("answers status and persists cancellation while a worker is running", async () => {
    const services = createServices({ maxActiveWorkers: 1 });
    const first = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "k05:first",
      goal: "long task",
      completionCriteria: "done",
    });
    const second = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "k05:second",
      goal: "cancel me",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 1);
    assert.ok(claimed);
    const running = claimed.task.id;
    const other = running === first.id ? second : first;

    await sendText(services, "/status", "k05-status");
    await sendText(services, `/cancel ${other.id}`, "k05-cancel");

    assert.equal(services.tasks.get(running)?.status, "running");
    assert.equal(services.tasks.get(other.id)?.status, "cancelled");
    assert.ok(services.store.countOutbox("pending") >= 1);
  });
});

describe("K06: two tasks keep separate sessions and contexts", () => {
  it("runs two workers without mixing prompts", async () => {
    const services = createServices({ maxActiveWorkers: 2 });
    const first = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "k06:first",
      goal: "summarize alpha",
      completionCriteria: "alpha summary",
    });
    const second = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "k06:second",
      goal: "summarize beta",
      completionCriteria: "beta summary",
    });

    await services.effectDispatcher.drain(100);

    assert.equal(services.tasks.get(first.id)?.status, "succeeded");
    assert.equal(services.tasks.get(second.id)?.status, "succeeded");
    assert.equal(services.runtime.opened.length, 2);
    assert.equal(services.runtime.submissions.length, 2);
    const prompts = services.runtime.submissions.map((item) => item.text).join("\n");
    assert.match(prompts, /summarize alpha/);
    assert.match(prompts, /summarize beta/);
    assert.notEqual(
      services.runtime.submissions[0]?.sessionId,
      services.runtime.submissions[1]?.sessionId,
    );
  });
});

describe("K09: approval binding checks", () => {
  function setup() {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "k09:action",
      goal: "lamp",
      completionCriteria: "brightness set",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "lamp.set_brightness",
      args: { brightness: 40 },
    });
    assert.ok(action);
    return { services, action };
  }

  it("rejects a different approver and a different conversation", () => {
    const { services, action } = setup();
    const wrongOwner = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: "ou_other",
      conversationId: services.conversation.id,
    });
    assert.equal(wrongOwner.reason, "approver_not_owner");

    const wrongConversation = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: "oc_other",
    });
    assert.equal(wrongConversation.reason, "conversation_mismatch");
    assert.equal(services.actions.get(action.id)?.status, "proposed");
  });
});
