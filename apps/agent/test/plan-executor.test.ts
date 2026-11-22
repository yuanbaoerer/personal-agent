import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlanExecutor } from "../src/coordinator/plan-executor.ts";
import { CallBudget } from "../src/observability/call-budget.ts";
import type { PlanStepSpec, TaskRecord } from "../src/domain/types.ts";
import { createServices, type TestServices } from "./services.ts";
import { createStore } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function steps(): PlanStepSpec[] {
  return [
    {
      key: "A",
      goal: "collect evidence",
      dependsOn: [],
      tools: [],
      resources: [],
      verifierId: "structural",
      maxAttempts: 1,
    },
    {
      key: "B",
      goal: "analyze evidence",
      dependsOn: ["A"],
      tools: [],
      resources: [],
      verifierId: "structural",
      maxAttempts: 1,
    },
    {
      key: "C",
      goal: "write final report",
      dependsOn: ["B"],
      tools: [],
      resources: [],
      verifierId: "structural",
      maxAttempts: 1,
    },
  ];
}

function setup(options: { budget?: CallBudget } = {}): {
  services: TestServices;
  parent: TaskRecord;
  executor: PlanExecutor;
  advance: (ms?: number) => void;
} {
  let clock = NOW.getTime();
  const services = createServices({
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    now: () => new Date(clock),
  });
  const parent = services.tasks.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `plan-parent-${Math.random().toString(36).slice(2)}`,
    goal: "parent goal",
    completionCriteria: "provide a checked result",
    mandate: { resources: ["chat"], tools: [] },
    createdAt: NOW.toISOString(),
  }).task;
  const executor = new PlanExecutor({
    store: services.store,
    plans: services.plans,
    tasks: services.tasks,
    taskService: services.taskService,
    effects: services.effects,
    projects: services.projects,
    now: () => new Date(clock),
    tickDelayMs: 1_000,
  });
  executor.install(services.effectDispatcher);
  services.planService.setLifecycleHook((planId) => executor.start(planId));
  return {
    services,
    parent,
    executor,
    advance: (ms = 1_000) => {
      clock += ms;
    },
  };
}

async function drain(
  services: TestServices,
  advance: () => void,
): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    advance();
    const result = await services.effectDispatcher.drain(50);
    if (
      result.done === 0 &&
      result.retried === 0 &&
      result.failed === 0 &&
      result.recovered === 0
    ) {
      return;
    }
  }
  throw new Error("effect drain did not settle");
}

function childTasks(services: TestServices, parent: TaskRecord): TaskRecord[] {
  return services.tasks
    .listByOwner(services.owner.id, 50)
    .filter((task) => task.id !== parent.id && task.planId !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

describe("plan executor", () => {
  it("runs a dependent chain as verified child tasks and settles the parent", async () => {
    const { services, parent, executor, advance } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const view = services.planService.get(services.owner.id, plan.plan.id);
    assert.equal(view?.plan.status, "completed");
    assert.deepEqual(
      view?.steps.map((step) => [step.key, step.status]),
      [
        ["A", "completed"],
        ["B", "completed"],
        ["C", "completed"],
      ],
    );
    const settledParent = services.tasks.get(parent.id);
    assert.equal(settledParent?.status, "succeeded");
    assert.equal(settledParent?.verification?.verdict, "succeeded");

    const children = childTasks(services, parent);
    assert.equal(children.length, 3);
    assert.deepEqual(
      children.map((task) => task.planStepKey),
      ["A", "B", "C"],
    );
    assert.ok(children.every((task) => task.status === "succeeded"));

    const events = services.store
      .listAuditAfter(0, 200)
      .map((item) => item.event);
    assert.equal(events.filter((event) => event === "plan.step_dispatched").length, 3);
    assert.ok(events.includes("plan.completed"));
    const outcome = await executor.tick(plan.plan.id);
    assert.equal(outcome.status, "done");
  });

  it("stops at a failed step and settles the parent as failed", async () => {
    const { services, parent, advance } = setup();
    services.runtime.defaultAnswer = {
      status: "answered",
      text: JSON.stringify({
        status: "failed",
        summary: "child failed",
        evidence: [{ kind: "test", value: "failure" }],
      }),
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const view = services.planService.get(services.owner.id, plan.plan.id);
    assert.equal(view?.plan.status, "paused");
    assert.equal(view?.steps[0]?.status, "failed");
    assert.equal(services.tasks.get(parent.id)?.status, "failed");
    assert.equal(childTasks(services, parent).length, 1);
  });

  it("shares the parent plan's model-call budget across steps", async () => {
    const store = createStore();
    const budget = new CallBudget({ store, maxCallsPerTask: 1, now: () => NOW });
    const { services, parent, advance } = setup({ budget });
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    assert.equal(services.runtime.submissions.length, 1);
    const view = services.planService.get(services.owner.id, plan.plan.id);
    assert.equal(view?.plan.status, "paused");
    assert.equal(services.tasks.get(parent.id)?.status, "failed");
    const children = childTasks(services, parent);
    assert.deepEqual(
      children.map((task) => task.status),
      ["succeeded", "failed"],
    );
  });

  it("cancels remaining steps and the parent when the plan is cancelled", async () => {
    const { services, parent, advance } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    services.planService.cancel(services.owner.id, plan.plan.id);
    await drain(services, advance);

    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "cancelled",
    );
    assert.equal(services.tasks.get(parent.id)?.status, "cancelled");
    assert.equal(childTasks(services, parent).length, 0);
    assert.equal(services.tasks.get(parent.id)?.planId, undefined);
  });

  it("recovers an active plan through sweep after a restart", async () => {
    const { services, parent, executor, advance } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    // Activate before installing the hook: persistence must be enough.
    services.planService.setLifecycleHook(() => {});
    services.planService.activate(services.owner.id, plan.plan.id);
    executor.sweep();
    await drain(services, advance);

    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "completed",
    );
    assert.equal(services.tasks.get(parent.id)?.status, "succeeded");
  });
});
