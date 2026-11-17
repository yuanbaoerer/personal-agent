import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActionTool } from "../src/actions/tools.ts";
import { createServices, type TestServices } from "./services.ts";

function slowTool(
  name: string,
  readOnly: boolean,
  timeoutMs = 10,
): ActionTool {
  return {
    name,
    readOnly,
    timeoutMs,
    canonicalize(args) {
      return { value: args.value };
    },
    async execute() {
      return new Promise(() => {
        // Never settles: the dispatcher timeout must win.
      });
    },
    async verify() {
      return { satisfied: true, evidence: {} };
    },
  };
}

let sequence = 0;

function prepare(services: TestServices, name: string) {
  sequence += 1;
  const task = services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `source:${name}:${sequence}`,
    goal: "run a slow tool",
    completionCriteria: "done",
    mandate: { resources: ["chat"], tools: [name] },
  });
  const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
  assert.ok(claimed);
  const action = services.actionService.propose(task, claimed.assignment, {
    tool: name,
    args: { value: "x" },
  });
  assert.ok(action);
  services.actionService.approve({
    actionId: action.id,
    nonce: action.nonce,
    approverId: services.owner.id,
    conversationId: services.conversation.id,
  });
  return action;
}

describe("tool execution timeout", () => {
  it("fails a timed-out read instead of marking an unknown outcome", async () => {
    const services = createServices();
    services.tools.register(slowTool("test.slow_read", true));
    const action = prepare(services, "test.slow_read");

    await services.actionService.handleExecute({ actionId: action.id });

    assert.equal(services.actions.get(action.id)?.status, "failed");
    assert.match(services.actions.get(action.id)?.lastError ?? "", /timed out/);
    assert.equal(
      services.effects
        .listPending()
        .some((effect) => effect.kind === "action.reconcile"),
      false,
    );
  });

  it("marks a timed-out write unknown and queues reconciliation", async () => {
    const services = createServices();
    services.tools.register(slowTool("test.slow_write", false));
    const action = prepare(services, "test.slow_write");

    await services.actionService.handleExecute({ actionId: action.id });

    assert.equal(services.actions.get(action.id)?.status, "unknown");
    assert.ok(
      services.effects
        .listPending()
        .some(
          (effect) =>
            effect.kind === "action.reconcile" &&
            effect.payload.actionId === action.id,
        ),
    );
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("动作结果未知")),
    );
  });

  it("releases the tool slot when execute throws synchronously", { timeout: 3_000 }, async () => {
    const services = createServices({ maxConcurrentTools: 1 });
    services.tools.register({
      name: "test.sync_throw",
      canonicalize(args: Record<string, unknown>) {
        return { value: args.value };
      },
      execute() {
        throw new Error("synchronous boom");
      },
      async verify() {
        return { satisfied: true, evidence: {} };
      },
    } as unknown as ActionTool);

    const first = prepare(services, "test.sync_throw");
    await services.actionService.handleExecute({ actionId: first.id });

    const second = prepare(services, "test.sync_throw");
    await services.actionService.handleExecute({ actionId: second.id });

    assert.equal(services.actions.get(first.id)?.status, "unknown");
    assert.equal(services.actions.get(second.id)?.status, "unknown");
  });
});
