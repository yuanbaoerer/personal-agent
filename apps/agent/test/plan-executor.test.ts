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

function setup(options: { budget?: CallBudget; deadline?: string } = {}): {
  services: TestServices;
  parent: TaskRecord;
  executor: PlanExecutor;
  advance: (ms?: number) => void;
  now: () => Date;
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
    deadline: options.deadline,
    createdAt: NOW.toISOString(),
  }).task;
  const executor = new PlanExecutor({
    store: services.store,
    plans: services.plans,
    tasks: services.tasks,
    taskService: services.taskService,
    planService: services.planService,
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
    now: () => new Date(clock),
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
      planService: services.planService,
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

  it("sweep stops orphan children of a committed replan", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    const child = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "replan-orphan-child",
      goal: "orphan child",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      planId: plan.plan.id,
      planStepKey: "A",
      createdAt: NOW.toISOString(),
    }).task;
    assert.ok(
      services.plans.bindStepTask(plan.plan.id, "A", child.id, NOW.toISOString()),
    );

    // Commit the replan without the Router's post-commit child cancellation.
    services.planService.replan(
      services.owner.id,
      plan.plan.id,
      { steps: steps() },
      { stopOpenSteps: true },
    );
    assert.equal(services.tasks.get(child.id)?.status, "queued");

    executor.sweep();
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
      planService: services.planService,
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

  it("turns a mid-run supplement into a new plan version", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);
    const firstChild = childTasks(services, parent)[0];
    assert.ok(firstChild);
    assert.equal(firstChild.status, "queued");

    services.taskService.supplement(
      parent.id,
      "only cite evidence, ignore GUI",
      "inbox:supplement-plan",
    );
    const outcome = await executor.tick(plan.plan.id);
    assert.equal(outcome.status, "done");

    const versions = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
      limit: 10,
    });
    assert.deepEqual(
      versions.map((version) => [version.planVersion, version.status]),
      [
        [2, "active"],
        [1, "superseded"],
      ],
    );
    const revised = services.planService.get(services.owner.id, versions[0]!.id);
    assert.equal(revised?.plan.inputSeq, 1);
    assert.equal(revised?.steps[0]?.status, "ready");
    assert.match(revised?.steps[0]?.goal ?? "", /only cite evidence, ignore GUI/);
    assert.equal(services.tasks.get(parent.id)?.planId, versions[0]?.id);
    assert.notEqual(services.tasks.get(firstChild.id)?.status, "queued");
    assert.equal(
      services.plans.listSteps(plan.plan.id)[0]?.status,
      "cancelled",
    );
    const events = services.store.listAuditAfter(0, 200).map((item) => item.event);
    assert.ok(events.includes("plan.replanned"));
  });

  it("fails closed when the parent revision changes mid-plan", async () => {
    const { services, parent, executor } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    services.tasks.revise(parent.id, { goal: "new goal" }, NOW.toISOString());
    const outcome = await executor.tick(plan.plan.id);
    assert.equal(outcome.status, "done");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
    assert.equal(services.tasks.get(parent.id)?.status, "needs_review");
  });

  it("automatically replans once after a retryable external failure", async () => {
    const { services, parent, advance } = setup();
    let calls = 0;
    services.runtime.wait = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "answered",
          text: JSON.stringify({
            status: "failed",
            summary: "github rate limit exceeded (429)",
            evidence: [{ kind: "http", value: 429 }],
          }),
        };
      }
      return {
        status: "answered",
        text: JSON.stringify({
          status: "ready",
          summary: "step ok",
          evidence: [{ kind: "test", value: "ok" }],
        }),
      };
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const versions = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
      limit: 10,
    });
    assert.deepEqual(
      versions.map((version) => [version.planVersion, version.status]),
      [
        [2, "completed"],
        [1, "superseded"],
      ],
    );
    assert.equal(versions[0]?.autoReplans, 1);
    assert.equal(services.tasks.get(parent.id)?.status, "succeeded");
    const diff = services.planService.diff(
      services.owner.id,
      versions[0]!.id,
      1,
      2,
    );
    assert.deepEqual(
      diff.steps.map((step) => [step.key, step.change]),
      [
        ["A", "changed"],
        ["B", "unchanged"],
        ["C", "unchanged"],
      ],
    );
    assert.ok(
      services.store
        .listAuditAfter(0, 300)
        .some((item) => item.event === "plan.auto_replanned"),
    );
  });

  it("recovers once from a stale head failure", async () => {
    const { services, parent, advance } = setup();
    let calls = 0;
    services.runtime.wait = async () => {
      calls += 1;
      return calls === 1
        ? {
            status: "answered",
            text: JSON.stringify({
              status: "failed",
              summary: "pull request head changed (stale head)",
              evidence: [{ kind: "github", value: "head-moved" }],
            }),
          }
        : {
            status: "answered",
            text: JSON.stringify({
              status: "ready",
              summary: "step ok",
              evidence: [{ kind: "test", value: "ok" }],
            }),
          };
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const versions = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
      limit: 10,
    });
    assert.deepEqual(
      versions.map((version) => [version.planVersion, version.status]),
      [
        [2, "completed"],
        [1, "superseded"],
      ],
    );
    assert.match(
      services.planService.get(services.owner.id, versions[0]!.id)?.steps[0]?.goal ??
        "",
      /stale head/,
    );
    assert.equal(services.tasks.get(parent.id)?.status, "succeeded");
  });

  it("asks the owner instead of replanning on a permission failure", async () => {
    const { services, parent, advance } = setup();
    services.runtime.defaultAnswer = {
      status: "answered",
      text: JSON.stringify({
        status: "failed",
        summary: "github permission denied (403)",
        evidence: [{ kind: "http", value: 403 }],
      }),
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const versions = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
      limit: 10,
    });
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.status, "paused");
    assert.equal(services.tasks.get(parent.id)?.status, "needs_review");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.steps[0]?.status,
      "needs_review",
    );
    assert.ok(
      !services.store
        .listAuditAfter(0, 300)
        .some((item) => item.event === "plan.auto_replanned"),
    );
  });

  it("stops after one automatic recovery and asks for review", async () => {
    const { services, parent, advance } = setup();
    services.runtime.defaultAnswer = {
      status: "answered",
      text: JSON.stringify({
        status: "failed",
        summary: "github rate limit exceeded (429)",
        evidence: [{ kind: "http", value: 429 }],
      }),
    };
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await drain(services, advance);

    const versions = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
      limit: 10,
    });
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.autoReplans, 1);
    assert.equal(versions[0]?.status, "paused");
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
      planService: services.planService,
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

  it("caps a step deadline at the parent deadline", async () => {
    const deadline = new Date(NOW.getTime() + 10_000).toISOString();
    const { services, parent, executor } = setup({ deadline });
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, timeoutMs: 60_000 })),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);

    const child = childTasks(services, parent)[0];
    assert.equal(child?.deadline, deadline);
  });

  it("fails a ready step without dispatch once the parent deadline passed", async () => {
    const deadline = new Date(NOW.getTime() + 5_000).toISOString();
    const { services, parent, executor, advance } = setup({ deadline });
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    advance(5_000);
    await executor.tick(plan.plan.id);

    assert.equal(childTasks(services, parent).length, 0);
    assert.equal(services.runtime.opened.length, 0);
    assert.equal(services.plans.getStep(plan.plan.id, "A")?.status, "failed");
    assert.equal(services.plans.getStep(plan.plan.id, "B")?.status, "blocked");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
    assert.equal(services.tasks.get(parent.id)?.status, "failed");
  });

  it("does not hand a queued step to a Worker after its deadline", async () => {
    const { services, parent, executor, advance } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, timeoutMs: 1_000 })),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);

    const child = childTasks(services, parent)[0];
    assert.ok(child);
    assert.equal(child.deadline, new Date(NOW.getTime() + 1_000).toISOString());
    advance(1_000);
    // Simulate a dispatch effect delayed to the attempt deadline.
    await services.taskService.handleDispatch({ taskId: child.id });

    assert.equal(services.runtime.opened.length, 0);
    assert.equal(services.tasks.get(child.id)?.status, "failed");
    assert.equal(services.tasks.get(child.id)?.attempts, 0);

    await executor.tick(plan.plan.id);
    assert.equal(services.plans.getStep(plan.plan.id, "A")?.status, "failed");
    assert.equal(services.plans.getStep(plan.plan.id, "B")?.status, "blocked");
    assert.equal(
      services.planService.get(services.owner.id, plan.plan.id)?.plan.status,
      "paused",
    );
  });

  it("rejects a late report and keeps dependents blocked", async () => {
    const { services, parent, executor, advance } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, timeoutMs: 1_000 })),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);

    const child = childTasks(services, parent)[0];
    assert.ok(child);
    await services.taskService.handleDispatch({ taskId: child.id });
    assert.equal(services.tasks.get(child.id)?.status, "running");
    const assignment = services.tasks.listActiveAssignments(child.id)[0];
    assert.ok(assignment);
    advance(1_000);

    const outcome = services.taskService.report(
      assignment.id,
      assignment.fencingToken,
      assignment.taskRevision,
      {
        status: "ready",
        summary: "late result",
        evidence: [{ kind: "test", value: "late" }],
      },
    );

    assert.equal(outcome.status, "done");
    const expired = services.tasks.get(child.id);
    assert.equal(expired?.status, "failed");
    assert.equal(expired?.resultRef, undefined);
    assert.equal(expired?.verification, undefined);
    assert.equal(services.tasks.getAssignment(assignment.id)?.status, "expired");

    await executor.tick(plan.plan.id);
    assert.equal(services.plans.getStep(plan.plan.id, "A")?.status, "failed");
    assert.equal(services.plans.getStep(plan.plan.id, "B")?.status, "blocked");
    assert.notEqual(services.tasks.get(parent.id)?.status, "succeeded");
  });

  it("keeps the same attempt deadline across executor recovery", async () => {
    const { services, parent, executor, advance, now } = setup();
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, timeoutMs: 60_000 })),
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    await executor.tick(plan.plan.id);

    const child = childTasks(services, parent)[0];
    assert.ok(child);
    const deadline = child.deadline;
    assert.ok(deadline);

    advance(30_000);
    const recovered = new PlanExecutor({
      store: services.store,
      plans: services.plans,
      tasks: services.tasks,
      taskService: services.taskService,
      planService: services.planService,
      effects: services.effects,
      projects: services.projects,
      now,
      tickDelayMs: 1_000,
    });
    await recovered.tick(plan.plan.id);
    assert.equal(childTasks(services, parent).length, 1);
    assert.equal(services.tasks.get(child.id)?.deadline, deadline);

    advance(30_000);
    await recovered.tick(plan.plan.id);
    assert.equal(services.runtime.opened.length, 0);
    assert.equal(services.tasks.get(child.id)?.status, "failed");
    assert.equal(services.plans.getStep(plan.plan.id, "A")?.status, "failed");
    assert.equal(services.plans.getStep(plan.plan.id, "B")?.status, "blocked");
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
