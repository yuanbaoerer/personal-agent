import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ActionService } from "../src/actions/service.ts";
import {
  createDefaultToolRegistry,
  type MockLampTool,
} from "../src/actions/tools.ts";
import { EffectDispatcher } from "../src/delivery/effects.ts";
import type { ActionRecord, AssignmentRecord, TaskRecord } from "../src/domain/types.ts";
import { noopWake } from "../src/runtime/types.ts";
import { createServices, type TestServices } from "./services.ts";

const TOOL = "lamp.set_brightness";

interface Fixture {
  services: TestServices;
  actionService: ActionService;
  lamp: MockLampTool;
}

function setup(options: { maxExecutionAttempts?: number } = {}): Fixture {
  const services = createServices();
  const { registry, lamp } = createDefaultToolRegistry(services.store, services.now);
  const actionService = new ActionService({
    store: services.store,
    actions: services.actions,
    effects: services.effects,
    tools: registry,
    wake: noopWake,
    now: services.now,
    tasks: services.tasks,
    maxExecutionAttempts: options.maxExecutionAttempts,
    onSettled: (taskId) => services.taskService.onActionSettled(taskId),
  });
  const dispatcher = new EffectDispatcher({
    effects: services.effects,
    now: services.now,
    maxAttempts: 20,
  });
  actionService.install(dispatcher);
  return { services, actionService, lamp };
}

function createTask(fixture: Fixture, sourceKey = "source:actions"): {
  task: TaskRecord;
  assignment: AssignmentRecord;
} {
  const { services } = fixture;
  const task = services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey,
    goal: "set the lamp",
    completionCriteria: "lamp is at the requested brightness",
    mandate: { resources: ["chat"], tools: [TOOL] },
  });
  const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
  assert.ok(claimed);
  return { task, assignment: claimed.assignment };
}

function propose(fixture: Fixture, brightness = 80): {
  task: TaskRecord;
  assignment: AssignmentRecord;
  action: ActionRecord;
} {
  const { task, assignment } = createTask(fixture);
  const action = fixture.actionService.propose(task, assignment, {
    tool: TOOL,
    args: { brightness },
  });
  assert.ok(action);
  return { task, assignment, action };
}

function approve(fixture: Fixture, action: ActionRecord): void {
  const result = fixture.actionService.approve({
    actionId: action.id,
    nonce: action.nonce,
    approverId: fixture.services.owner.id,
    conversationId: fixture.services.conversation.id,
  });
  assert.equal(result.ok, true);
}

/** Marks the action's execution outcome unknown without running the dispatcher. */
function interrupt(fixture: Fixture, action: ActionRecord): void {
  const now = fixture.services.now().toISOString();
  assert.ok(
    fixture.services.actions.claimForExecution(action.id, now, 30_000),
    "action should be claimable after approval",
  );
  assert.equal(fixture.services.actions.markUnknown(action.id, "simulated crash", now), true);
}

function pendingReconciles(fixture: Fixture): number {
  return fixture.services.effects
    .listPending(200)
    .filter((effect) => effect.kind === "action.reconcile").length;
}

describe("action reconciliation bounds", () => {
  it("stops after the effect attempt budget instead of enqueuing forever", async () => {
    const fixture = setup({ maxExecutionAttempts: 2 });
    const { action } = propose(fixture);
    approve(fixture, action);
    interrupt(fixture, action);
    fixture.lamp.failBefore = true;

    const first = await fixture.actionService.handleReconcile({ actionId: action.id }, 1);
    assert.equal(first.status, "retry");
    assert.equal(fixture.services.actions.get(action.id)?.status, "unknown");
    assert.equal(pendingReconciles(fixture), 0);

    const second = await fixture.actionService.handleReconcile({ actionId: action.id }, 2);
    assert.equal(second.status, "done");
    const settled = fixture.services.actions.get(action.id);
    assert.equal(settled?.status, "needs_manual");
    assert.match(settled?.lastError ?? "", /retry budget is exhausted/);
    assert.equal(pendingReconciles(fixture), 0);
    assert.equal(fixture.lamp.getState().brightness, 0);
  });

  it("does not execute a reconciliation after the task was cancelled", async () => {
    const fixture = setup();
    const { task, action } = propose(fixture);
    approve(fixture, action);
    interrupt(fixture, action);

    fixture.services.taskService.cancel(task.id);
    assert.equal(fixture.services.tasks.get(task.id)?.status, "cancelling");

    fixture.lamp.failBefore = false;
    const outcome = await fixture.actionService.handleReconcile({ actionId: action.id }, 1);

    assert.equal(outcome.status, "done");
    assert.equal(fixture.services.actions.get(action.id)?.status, "superseded");
    assert.equal(fixture.lamp.getState().brightness, 0);
  });

  it("does not execute a reconciliation after the task revision changed", async () => {
    const fixture = setup();
    const { task, action } = propose(fixture);
    approve(fixture, action);
    interrupt(fixture, action);

    fixture.services.taskService.revise(task.id, { goal: "set a different lamp" });
    fixture.lamp.failBefore = false;
    const outcome = await fixture.actionService.handleReconcile({ actionId: action.id }, 1);

    assert.equal(outcome.status, "done");
    assert.equal(fixture.services.actions.get(action.id)?.status, "superseded");
    assert.equal(fixture.lamp.getState().brightness, 0);
  });
});

describe("action approval atomicity and binding", () => {
  it("rolls back the approval when the after-approve callback throws", () => {
    const fixture = setup();
    const { action } = propose(fixture);
    const { services } = fixture;

    const now = services.now().toISOString();
    assert.throws(
      () =>
        services.actions.approve(
          action.id,
          {
            approverId: services.owner.id,
            conversationId: services.conversation.id,
            argsHash: action.argsHash,
            taskRevision: action.taskRevision,
            nonce: action.nonce,
            now,
          },
          () => {
            throw new Error("effect enqueue failed");
          },
        ),
      /effect enqueue failed/,
    );

    assert.equal(services.actions.get(action.id)?.status, "proposed");
    assert.equal(
      services.store.db.all("SELECT id FROM pa_approvals WHERE action_id = ?", action.id)
        .length,
      0,
    );
    assert.equal(services.actions.claimForExecution(action.id, now, 30_000), undefined);
  });

  it("rejects a mismatched expected args hash or task revision", () => {
    const fixture = setup();
    const { action } = propose(fixture);
    const base = {
      actionId: action.id,
      nonce: action.nonce,
      approverId: fixture.services.owner.id,
      conversationId: fixture.services.conversation.id,
    };

    const wrongHash = fixture.actionService.approve({
      ...base,
      expectedArgsHash: "not-the-real-hash",
    });
    assert.equal(wrongHash.ok, false);
    assert.equal(wrongHash.reason, "args_mismatch");
    assert.equal(fixture.services.actions.get(action.id)?.status, "proposed");

    const wrongRevision = fixture.actionService.approve({
      ...base,
      expectedTaskRevision: action.taskRevision + 1,
    });
    assert.equal(wrongRevision.ok, false);
    assert.equal(wrongRevision.reason, "revision_mismatch");
    assert.equal(fixture.services.actions.get(action.id)?.status, "proposed");

    const bound = fixture.actionService.approve({
      ...base,
      expectedArgsHash: action.argsHash,
      expectedTaskRevision: action.taskRevision,
    });
    assert.equal(bound.ok, true);
    assert.equal(fixture.services.actions.get(action.id)?.status, "approved");
  });
});

describe("proposal source keys", () => {
  it("dedupes a retried report even when proposals are reordered", () => {
    const fixture = setup();
    const { services } = fixture;
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:reordered",
      goal: "set two lamps",
      completionCriteria: "both values applied",
      mandate: { resources: ["chat"], tools: [TOOL] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);

    const first = fixture.actionService.proposeForReport(task, claimed.assignment, [
      { tool: TOOL, args: { brightness: 10 } },
      { tool: TOOL, args: { brightness: 20 } },
    ]);
    const second = fixture.actionService.proposeForReport(task, claimed.assignment, [
      { tool: TOOL, args: { brightness: 20 } },
      { tool: TOOL, args: { brightness: 10 } },
    ]);

    assert.equal(first, 2);
    assert.equal(second, 2);
    const rows = services.actions.listByTask(task.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.args.brightness)).sort((a, b) => a - b),
      [10, 20],
    );
  });
});
