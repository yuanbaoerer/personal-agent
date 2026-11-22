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

    // Maintenance must not turn a failed plan into cancelled; the owner can
    // still replan it.
    const executor = new PlanExecutor({
      store: services.store,
      plans: services.plans,
      tasks: services.tasks,
      taskService: services.taskService,
      effects: services.effects,
      projects: services.projects,
      now: () => NOW,
      tickDelayMs: 0,
    });
    executor.install(services.effectDispatcher);
    executor.sweep();
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
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

  it("shares the plan tool-call budget across step children", () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-tool-budget",
      goal: "tool budget parent",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat", "state"], tools: ["state.summary"] },
      createdAt: NOW.toISOString(),
    }).task;
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({
        ...step,
        tools: ["state.summary"],
        resources: ["state"],
        verifierId: "state-read",
      })),
      budget: { maxToolCalls: 1 },
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    const createChild = (key: string) =>
      services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: `plan-tool-budget:${key}`,
        goal: `child ${key}`,
        completionCriteria: '{"verifier":"state-read","requiredEvidenceKinds":["state_snapshot"]}',
        mandate: { resources: ["state"], tools: ["state.summary"] },
        planId: plan.plan.id,
        planStepKey: key,
        budgetKey: `plan:${parent.id}`,
        dispatch: false,
      });
    createChild("A");
    createChild("B");

    const firstClaim = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(firstClaim);
    const first = services.actionService.proposeForReport(
      firstClaim.task,
      firstClaim.assignment,
      [{ tool: "state.summary", args: {} }],
    );
    assert.equal(first.count, 1);

    const secondClaim = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(secondClaim);
    const second = services.actionService.proposeForReport(
      secondClaim.task,
      secondClaim.assignment,
      [{ tool: "state.summary", args: {} }],
    );
    assert.equal(second.count, 0);
    assert.ok(second.rejected > 0);
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

  it("does not cancel the parent when a draft or another version is cancelled", async () => {
    const { services, parent, executor } = setup();
    const draft = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.cancel(services.owner.id, draft.plan.id);
    await executor.tick(draft.plan.id);
    assert.equal(services.tasks.get(parent.id)?.status, "queued");

    const active = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, active.plan.id);
    const other = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.cancel(services.owner.id, other.plan.id);
    await executor.tick(other.plan.id);
    assert.equal(services.tasks.get(parent.id)?.status, "waiting_external");
    assert.equal(services.tasks.get(parent.id)?.planId, active.plan.id);
    assert.equal(
      services.planService.get(services.owner.id, active.plan.id)?.plan.status,
      "active",
    );
  });

  it("cancels an old version's child without touching a rebound parent", async () => {
    const { services, parent, executor } = setup();
    const first = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, first.plan.id);
    await executor.tick(first.plan.id);
    const child = childTasks(services, parent)[0];
    assert.ok(child);
    services.planService.pause(services.owner.id, first.plan.id);
    const second = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    // Simulate a rebind that bypassed the normal activation guard.
    assert.ok(services.tasks.bindPlan(parent.id, second.plan.id, NOW.toISOString()));

    services.planService.cancel(services.owner.id, first.plan.id);
    await executor.tick(first.plan.id);

    assert.equal(services.tasks.get(child.id)?.status === "queued", false);
    assert.equal(services.tasks.get(parent.id)?.planId, second.plan.id);
    assert.equal(services.tasks.get(parent.id)?.status, "waiting_external");
  });

  it("stops a paused plan when the parent is cancelled directly", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);
    const child = childTasks(services, parent)[0];
    assert.ok(child);
    services.planService.pause(services.owner.id, plan.plan.id);

    services.taskService.cancel(parent.id);
    executor.sweep();

    assert.equal(services.tasks.get(parent.id)?.status, "cancelled");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "cancelled",
    );
    assert.notEqual(services.tasks.get(child.id)?.status, "queued");
  });

  it("stops the plan when the parent is cancelled directly", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);
    const child = childTasks(services, parent)[0];
    assert.ok(child);

    services.taskService.cancel(parent.id);
    await executor.tick(plan.plan.id);

    assert.equal(services.tasks.get(parent.id)?.status, "cancelled");
    assert.equal(services.tasks.get(parent.id)?.planId, undefined);
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "cancelled",
    );
    assert.notEqual(services.tasks.get(child.id)?.status, "queued");
  });

  it("clears legacy running steps under a superseded plan", async () => {
    const { services, parent, executor } = setup();
    const first = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, first.plan.id);
    await executor.tick(first.plan.id);
    const child = childTasks(services, parent)[0];
    assert.ok(child);
    assert.ok(
      services.plans.setPlanStatus(
        first.plan.id,
        ["active"],
        "superseded",
        NOW.toISOString(),
      ),
    );

    executor.sweep();
    assert.notEqual(
      services.plans.listSteps(first.plan.id)[0]?.status,
      "running",
    );
    assert.notEqual(services.tasks.get(child.id)?.status, "queued");

    const second = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    assert.doesNotThrow(() =>
      services.planService.activate(services.owner.id, second.plan.id),
    );
  });

  it("inherits the parent extension policy on every step child", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-policy-parent",
      goal: "policy parent",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      extensionPolicy: { plugins: [] },
      dispatch: false,
    });
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    const executor = new PlanExecutor({
      store: services.store,
      plans: services.plans,
      tasks: services.tasks,
      taskService: services.taskService,
      effects: services.effects,
      projects: services.projects,
      now: () => NOW,
      tickDelayMs: 0,
    });
    executor.install(services.effectDispatcher);
    await executor.tick(plan.plan.id);
    const children = childTasks(services, parent);
    assert.equal(children.length, 1);
    assert.deepEqual(children[0]?.extension?.policy, { plugins: [] });
  });

  it("fails closed when the parent revision/input changes mid-plan", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    services.tasks.addInput({
      taskId: parent.id,
      actorId: services.owner.actorId,
      text: "new constraint",
      createdAt: NOW.toISOString(),
    });
    const outcome = await executor.tick(plan.plan.id);
    assert.equal(outcome.status, "done");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
    assert.equal(services.tasks.get(parent.id)?.status, "needs_review");
  });

  it("keeps budgets consumed across a replan of the same parent", async () => {
    const store = createStore();
    const budget = new CallBudget({ store, maxCallsPerTask: 2, now: () => NOW });
    const { services, parent, advance } = setup({ budget });
    let modelCalls = 0;
    const success = {
      status: "answered" as const,
      text: JSON.stringify({
        status: "ready",
        summary: "step ok",
        evidence: [{ kind: "test", value: "ok" }],
      }),
    };
    const failure = {
      status: "answered" as const,
      text: JSON.stringify({
        status: "failed",
        summary: "step failed",
        evidence: [{ kind: "test", value: "fail" }],
      }),
    };
    services.runtime.wait = async () => {
      modelCalls += 1;
      return modelCalls === 1 ? success : failure;
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);
    assert.equal(services.runtime.submissions.length, 2);
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );

    const replanned = services.planService.replan(services.owner.id, plan.plan.id, {
      steps: steps().map((step) =>
        step.key === "B" ? { ...step, goal: "retry with narrower scope" } : step,
      ),
    });
    await drain(services, advance);
    // The shared plan budget is already exhausted; no third model call.
    assert.equal(services.runtime.submissions.length, 2);
    assert.equal(
      services.planService.get(services.owner.id, replanned.plan.id)?.plan.status,
      "paused",
    );
  });

  it("encodes step verifiers explicitly", async () => {
    const { services, parent } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, verifierId: "text-review" })),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await services.effectDispatcher.drain(20);
    const first = childTasks(services, parent)[0];
    assert.match(first?.completionCriteria ?? "", /"verifier":"text-review"/);
  });

  it("runs the final step with the parent mandate and verifier", async () => {
    let clock = NOW.getTime();
    const services = createServices({ now: () => new Date(clock) });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-final-mandate",
      goal: "state-aware parent",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat", "state"], tools: ["state.summary"] },
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
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.setLifecycleHook((planId) => executor.start(planId));
    services.planService.activate(services.owner.id, plan.plan.id);
    for (let index = 0; index < 80; index += 1) {
      clock += 1_000;
      await services.effectDispatcher.drain(50);
    }
    const final = childTasks(services, parent).find((task) => task.planStepKey === "C");
    assert.ok(final);
    assert.deepEqual(final.mandate.tools, ["state.summary"]);
    assert.deepEqual(final.mandate.resources, ["chat", "state"]);
    // The stronger state-read verifier cannot be satisfied by the fake report,
    // so the plan must fail closed instead of claiming success.
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
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
