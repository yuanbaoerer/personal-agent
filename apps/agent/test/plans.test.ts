import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlanError, PlanService, resolvePlanSpec } from "../src/coordinator/plans.ts";
import type {
  ConversationRecord,
  OwnerIdentity,
  PlanStepSpec,
  TaskRecord,
} from "../src/domain/types.ts";
import type { CapabilityView } from "../src/plugins/fence.ts";
import { PlanRepository } from "../src/storage/plans.ts";
import { TaskRepository } from "../src/storage/tasks.ts";
import { ActionRepository } from "../src/storage/actions.ts";
import type { Store } from "../src/storage/store.ts";
import { createStore } from "./helpers.ts";

const APP = "app_1";
const NOW = "2026-01-01T00:00:00.000Z";

function bindOwner(store: Store, actorId: string): OwnerIdentity {
  return (
    store.findOwner("feishu", APP, actorId) ??
    store.bindOwner({
      channel: "feishu",
      accountId: APP,
      actorId,
      verifiedAt: NOW,
    })
  );
}

function conversation(store: Store, owner: OwnerIdentity): ConversationRecord {
  return store.upsertConversation({
    ownerId: owner.id,
    channel: "feishu",
    accountId: APP,
    platformConversationId: "oc_plans",
    kind: "p2p",
    createdAt: NOW,
  });
}

function capabilities(overrides: Partial<CapabilityView> = {}): CapabilityView {
  const tools = overrides.toolNames?.() ?? ["github.read", "state.summary"];
  const resources = overrides.resources?.() ?? ["chat", "github", "state"];
  const mapping: Record<string, string> = {
    "github.read": "github",
    "state.summary": "state",
  };
  return {
    generation: () => 1,
    toolNames: () => tools,
    resources: () => resources,
    resourceForTool: (name) => mapping[name],
    toolInfo: () => undefined,
    ...overrides,
  };
}

function makeTask(
  store: Store,
  owner: OwnerIdentity,
  conv: ConversationRecord,
  options: { goal?: string; budget?: Record<string, unknown>; mandate?: TaskRecord["mandate"] } = {},
): TaskRecord {
  return new TaskRepository(store.db).insert({
    ownerId: owner.id,
    conversationId: conv.id,
    sourceKey: `task:${Math.random().toString(36).slice(2)}`,
    goal: options.goal ?? "parent goal",
    completionCriteria: "criteria",
    mandate: options.mandate ?? {
      resources: ["chat", "github", "state"],
      tools: ["github.read", "state.summary"],
    },
    budget: options.budget,
    createdAt: NOW,
  }).task;
}

function steps(): PlanStepSpec[] {
  return [
    {
      key: "A",
      goal: "read evidence",
      dependsOn: [],
      tools: ["github.read"],
      resources: ["github"],
      verifierId: "project-review",
    },
    {
      key: "B",
      goal: "read state",
      dependsOn: ["A"],
      tools: ["state.summary"],
      resources: ["state"],
      verifierId: "state-read",
    },
    {
      key: "C",
      goal: "summarize",
      dependsOn: ["A"],
      tools: [],
      resources: [],
      verifierId: "text-report",
    },
  ];
}

function setup() {
  const store = createStore();
  const owner = bindOwner(store, "ou_owner");
  const conv = conversation(store, owner);
  const task = makeTask(store, owner, conv);
  const service = new PlanService({
    store,
    plans: new PlanRepository(store.db),
    tasks: new TaskRepository(store.db),
    actions: new ActionRepository(store.db),
    capabilities: capabilities(),
    now: () => new Date(NOW),
  });
  return { store, owner, conv, task, service };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof PlanError ? error.code : `unexpected:${String(error)}`;
  }
}

describe("plan validation", () => {
  it("accepts a three-step DAG inside the parent mandate", () => {
    const { task } = setup();
    const spec = resolvePlanSpec({ steps: steps() }, task, capabilities());
    assert.equal(spec.steps.length, 3);
    assert.equal(spec.budget.maxSteps, 3);
    assert.equal(spec.budget.maxAttemptsPerStep, 1);
  });

  it("rejects size, duplicate keys, unknown dependencies and cycles", () => {
    const { task } = setup();
    const two = steps().slice(0, 2);
    assert.equal(codeOf(() => resolvePlanSpec({ steps: two }, task, capabilities())), "invalid_plan");

    const duplicate = steps();
    duplicate[1] = { ...duplicate[1]!, key: "A" };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: duplicate }, task, capabilities())),
      "invalid_plan",
    );

    const unknown = steps();
    unknown[1] = { ...unknown[1]!, dependsOn: ["missing"] };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: unknown }, task, capabilities())),
      "invalid_plan",
    );

    const cycle = steps();
    cycle[0] = { ...cycle[0]!, dependsOn: ["C"] };
    cycle[1] = { ...cycle[1]!, dependsOn: ["A"] };
    cycle[2] = { ...cycle[2]!, dependsOn: ["B"] };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: cycle }, task, capabilities())),
      "invalid_plan",
    );
  });

  it("never lets a plan widen the parent mandate or the live catalog", () => {
    const { task } = setup();
    const outsideTool = steps();
    outsideTool[0] = { ...outsideTool[0]!, tools: ["github.write"] };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: outsideTool }, task, capabilities())),
      "invalid_plan",
    );

    const outsideResource = steps();
    outsideResource[0] = { ...outsideResource[0]!, resources: ["weather"] };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: outsideResource }, task, capabilities())),
      "invalid_plan",
    );

    const missingToolResource = steps();
    missingToolResource[0] = { ...missingToolResource[0]!, resources: [] };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: missingToolResource }, task, capabilities())),
      "invalid_plan",
    );

    const disabledTool = steps();
    assert.equal(
      codeOf(() =>
        resolvePlanSpec(
          { steps: disabledTool },
          task,
          capabilities({ toolNames: () => ["state.summary"] }),
        ),
      ),
      "invalid_plan",
    );
  });

  it("bounds attempts, step timeout and cost against the parent budget", () => {
    const { task } = setup();
    const tooMany = steps();
    tooMany[0] = { ...tooMany[0]!, maxAttempts: 3 };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: tooMany, budget: { maxAttemptsPerStep: 1 } }, task, capabilities())),
      "invalid_plan",
    );

    const tooLong = steps();
    tooLong[0] = { ...tooLong[0]!, timeoutMs: 999_999 };
    assert.equal(
      codeOf(() => resolvePlanSpec({ steps: tooLong, budget: { timeoutMs: 60_000 } }, task, capabilities())),
      "invalid_plan",
    );

    const { store, owner, conv } = setup();
    const budgetTask = makeTask(store, owner, conv, { budget: { maxCostUsd: 1 } });
    assert.equal(
      codeOf(() =>
        resolvePlanSpec(
          { steps: steps(), budget: { maxCostUsd: 2 } },
          budgetTask,
          capabilities(),
        ),
      ),
      "invalid_plan",
    );
  });
});

describe("plan lifecycle", () => {
  it("creates a draft with blocked steps and activates only roots", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });

    assert.equal(draft.plan.status, "draft");
    assert.equal(draft.plan.planVersion, 1);
    assert.equal(draft.plan.taskRevision, task.revision);
    assert.equal(draft.plan.inputSeq, 0);
    assert.ok(draft.steps.every((step) => step.status === "blocked"));
    assert.equal(draft.plan.approvedScopeRef, undefined);

    const active = service.activate(owner.id, draft.plan.id);
    assert.equal(active.plan.status, "active");
    assert.equal(
      active.plan.approvedScopeRef,
      `task:${task.id}:rev:${task.revision}:plan:1`,
    );
    assert.deepEqual(
      active.steps.map((step) => [step.key, step.status]),
      [
        ["A", "ready"],
        ["B", "blocked"],
        ["C", "blocked"],
      ],
    );
    const events = store.listAuditAfter(0, 50).map((item) => item.event);
    assert.ok(events.includes("plan.created"));
    assert.ok(events.includes("plan.activated"));
  });

  it("refuses activation when the task revision or input advanced", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    new TaskRepository(store.db).addInput({
      taskId: task.id,
      text: "new constraint",
      actorId: owner.actorId,
      createdAt: NOW,
    });
    assert.equal(codeOf(() => service.activate(owner.id, draft.plan.id)), "stale_task_input");

    const second = service.create(owner.id, task.id, { steps: steps() });
    new TaskRepository(store.db).revise(task.id, { goal: "new goal" }, NOW);
    assert.equal(
      codeOf(() => service.activate(owner.id, second.plan.id)),
      "task_revision_changed",
    );
  });

  it("rejects a second active plan for the same task", () => {
    const { owner, task, service } = setup();
    const first = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, first.plan.id);
    const second = service.create(owner.id, task.id, { steps: steps() });
    assert.equal(
      codeOf(() => service.activate(owner.id, second.plan.id)),
      "conflict_active_plan",
    );
  });

  it("revision supersedes the old version and records a diff", () => {
    const { store, owner, task, service } = setup();
    const first = service.create(owner.id, task.id, {
      steps: steps(),
      budget: { maxSteps: 5 },
    });
    service.activate(owner.id, first.plan.id);
    service.pause(owner.id, first.plan.id);

    const changed = steps();
    changed[2] = { ...changed[2]!, goal: "summarize with evidence" };
    changed.push({
      key: "D",
      goal: "final review",
      dependsOn: ["B", "C"],
      tools: [],
      resources: [],
      verifierId: "text-report",
    });
    const second = service.revise(owner.id, first.plan.id, { steps: changed });

    assert.equal(second.plan.planVersion, 2);
    assert.equal(second.plan.status, "draft");
    assert.equal(service.get(owner.id, first.plan.id)?.plan.status, "superseded");
    const diff = service.diff(owner.id, second.plan.id);
    assert.equal(diff.fromVersion, 1);
    assert.equal(diff.toVersion, 2);
    assert.deepEqual(
      diff.steps.map((step) => [step.key, step.change]),
      [
        ["A", "unchanged"],
        ["B", "unchanged"],
        ["C", "changed"],
        ["D", "added"],
      ],
    );
    assert.deepEqual(diff.steps[2]?.fields, ["goal"]);

    const active = service.activate(owner.id, second.plan.id);
    assert.equal(active.plan.status, "active");
    const versions = service.list(owner.id, { parentTaskId: task.id });
    assert.equal(versions.length, 2);
    assert.ok(store.listAuditAfter(0, 50).some((item) => item.event === "plan.revised"));
  });

  it("pauses, resumes and cancels with step cleanup", () => {
    const { owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);

    assert.equal(service.pause(owner.id, draft.plan.id).plan.status, "paused");
    assert.equal(service.resume(owner.id, draft.plan.id).plan.status, "active");
    const cancelled = service.cancel(owner.id, draft.plan.id);
    assert.equal(cancelled.plan.status, "cancelled");
    assert.ok(cancelled.steps.every((step) => step.status === "cancelled"));
    assert.equal(
      codeOf(() => service.resume(owner.id, draft.plan.id)),
      "invalid_transition",
    );
  });

  it("treats needs_review as a closed parent task", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    new TaskRepository(store.db).updateTask(task.id, task.revision, {
      status: "needs_review",
      updatedAt: NOW,
    });
    assert.equal(
      codeOf(() => service.activate(owner.id, draft.plan.id)),
      "task_terminal",
    );
    assert.equal(
      codeOf(() => service.create(owner.id, task.id, { steps: steps() })),
      "task_terminal",
    );
  });

  it("refuses to resume one version while another is active", () => {
    const { owner, task, service } = setup();
    const first = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, first.plan.id);
    service.pause(owner.id, first.plan.id);

    const second = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, second.plan.id);
    assert.equal(
      codeOf(() => service.resume(owner.id, first.plan.id)),
      "conflict_active_plan",
    );
  });

  it("revalidates live capabilities before resuming", () => {
    const store = createStore();
    const owner = bindOwner(store, "ou_owner");
    const conv = conversation(store, owner);
    const task = makeTask(store, owner, conv);
    let tools = ["github.read", "state.summary"];
    const liveCapabilities: CapabilityView = {
      generation: () => 1,
      toolNames: () => tools,
      resources: () => ["chat", "github", "state"],
      resourceForTool: (name) =>
        name === "github.read" ? "github" : name === "state.summary" ? "state" : undefined,
      toolInfo: () => undefined,
    };
    const service = new PlanService({
      store,
      plans: new PlanRepository(store.db),
      tasks: new TaskRepository(store.db),
      capabilities: liveCapabilities,
      now: () => new Date(NOW),
    });
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    service.pause(owner.id, draft.plan.id);

    tools = ["state.summary"];
    assert.equal(
      codeOf(() => service.resume(owner.id, draft.plan.id)),
      "invalid_plan",
    );
  });

  it("replans a failed plan while preserving completed steps and budget", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    const plans = new PlanRepository(store.db);
    assert.ok(plans.bindStepTask(draft.plan.id, "A", "child-a", NOW));
    plans.setStepOutcome(draft.plan.id, "A", "completed", ["task:child-a"], undefined, NOW);
    new TaskRepository(store.db).updateTask(task.id, task.revision, {
      status: "failed",
      updatedAt: NOW,
    });

    const changed = steps();
    changed[1] = { ...changed[1]!, goal: "analyze revised evidence" };
    const replanned = service.replan(owner.id, draft.plan.id, { steps: changed });

    assert.equal(replanned.plan.planVersion, 2);
    assert.equal(replanned.plan.status, "active");
    assert.equal(service.get(owner.id, draft.plan.id)?.plan.status, "superseded");
    assert.deepEqual(
      replanned.steps.map((step) => [step.key, step.status]),
      [
        ["A", "completed"],
        ["B", "ready"],
        ["C", "ready"],
      ],
    );
    const preserved = replanned.steps.find((step) => step.key === "A");
    assert.equal(preserved?.taskId, "child-a");
    assert.deepEqual(preserved?.evidenceRefs, ["task:child-a"]);
    assert.equal(store.listAuditAfter(0, 100).filter((item) => item.event === "plan.replanned").length, 1);
    assert.equal(new TaskRepository(store.db).get(task.id)?.planId, replanned.plan.id);
    assert.equal(new TaskRepository(store.db).get(task.id)?.status, "waiting_external");
  });

  it("replans an active plan from a mid-run supplement with a PlanDiff", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    const plans = new PlanRepository(store.db);
    assert.ok(plans.bindStepTask(draft.plan.id, "A", "child-a", NOW));

    new TaskRepository(store.db).addInput({
      taskId: task.id,
      text: "only cite evidence, ignore GUI",
      actorId: owner.actorId,
      createdAt: NOW,
    });
    const revised = service.replanForSupplement(
      owner.id,
      draft.plan.id,
      "only cite evidence, ignore GUI",
    );

    assert.equal(revised.plan.planVersion, 2);
    assert.equal(revised.plan.status, "active");
    assert.equal(revised.plan.inputSeq, 1);
    assert.deepEqual(revised.plan.budget, draft.plan.budget);
    assert.equal(service.get(owner.id, draft.plan.id)?.plan.status, "superseded");
    assert.equal(plans.listSteps(draft.plan.id)[0]?.status, "cancelled");
    assert.deepEqual(
      revised.steps.map((step) => [step.key, step.status]),
      [
        ["A", "ready"],
        ["B", "blocked"],
        ["C", "blocked"],
      ],
    );
    const diff = service.diff(owner.id, revised.plan.id, 1, 2);
    assert.deepEqual(
      diff.steps.map((step) => [step.key, step.change, step.fields]),
      [
        ["A", "changed", ["goal"]],
        ["B", "changed", ["goal"]],
        ["C", "changed", ["goal"]],
      ],
    );
    assert.match(
      revised.steps[0]?.goal ?? "",
      /only cite evidence, ignore GUI/,
    );
    assert.equal(
      new TaskRepository(store.db).get(task.id)?.planId,
      revised.plan.id,
    );
  });

  it("keeps completed steps out of a supplement replan", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    const plans = new PlanRepository(store.db);
    assert.ok(plans.bindStepTask(draft.plan.id, "A", "child-a", NOW));
    plans.setStepOutcome(draft.plan.id, "A", "completed", ["task:child-a"], undefined, NOW);
    new TaskRepository(store.db).addInput({
      taskId: task.id,
      text: "narrow the remaining scope",
      actorId: owner.actorId,
      createdAt: NOW,
    });

    const revised = service.replanForSupplement(
      owner.id,
      draft.plan.id,
      "narrow the remaining scope",
    );
    const preserved = revised.steps.find((step) => step.key === "A");
    assert.equal(preserved?.status, "completed");
    assert.equal(preserved?.goal, "read evidence");
    assert.equal(preserved?.taskId, "child-a");
    assert.ok(
      revised.steps
        .filter((step) => step.key !== "A")
        .every((step) => step.goal.includes("narrow the remaining scope")),
    );
  });

  it("replans an active plan after an external failure only once per lineage", () => {
    const { owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);

    const revised = service.autoReplanAfterFailure(
      owner.id,
      draft.plan.id,
      "github rate limit exceeded (429)",
      { stepKey: "A" },
    );
    assert.equal(revised.plan.planVersion, 2);
    assert.equal(revised.plan.status, "active");
    assert.equal(revised.plan.autoReplans, 1);
    assert.equal(service.get(owner.id, draft.plan.id)?.plan.status, "superseded");
    assert.match(revised.steps[0]?.goal ?? "", /429/);
    assert.equal(
      codeOf(() =>
        service.autoReplanAfterFailure(
          owner.id,
          revised.plan.id,
          "github rate limit exceeded (429)",
        ),
      ),
      "replan_exhausted",
    );
  });

  it("rejects replans that change completed steps or expand the budget", () => {
    const first = setup();
    const draft = first.service.create(first.owner.id, first.task.id, { steps: steps() });
    first.service.activate(first.owner.id, draft.plan.id);
    const plans = new PlanRepository(first.store.db);
    assert.ok(plans.bindStepTask(draft.plan.id, "A", "child-a", NOW));
    plans.setStepOutcome(draft.plan.id, "A", "completed", [], undefined, NOW);

    const changedCompleted = steps();
    changedCompleted[0] = { ...changedCompleted[0]!, goal: "different completed goal" };
    assert.equal(
      codeOf(() => first.service.replan(first.owner.id, draft.plan.id, { steps: changedCompleted })),
      "invalid_plan",
    );

    const expanded = steps();
    assert.equal(
      codeOf(() =>
        first.service.replan(first.owner.id, draft.plan.id, {
          steps: expanded,
          budget: { maxAttemptsPerStep: 2 },
        }),
      ),
      "invalid_plan",
    );
  });

  it("refuses activation while the parent task has an active Worker", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    const claimed = new TaskRepository(store.db).claimNext(NOW, 60_000, 2);
    assert.ok(claimed);
    assert.equal(
      codeOf(() => service.activate(owner.id, draft.plan.id)),
      "invalid_transition",
    );
  });

  it("refuses activation over another version with a running step", () => {
    const { store, owner, task, service } = setup();
    const first = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, first.plan.id);
    assert.ok(
      new PlanRepository(store.db).bindStepTask(first.plan.id, "A", "child-running", NOW),
    );
    service.pause(owner.id, first.plan.id);

    const second = service.create(owner.id, task.id, { steps: steps() });
    assert.equal(
      codeOf(() => service.activate(owner.id, second.plan.id)),
      "invalid_transition",
    );
  });

  it("refuses activation over a superseded version with a running step", () => {
    const { store, owner, task, service } = setup();
    const first = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, first.plan.id);
    const plans = new PlanRepository(store.db);
    assert.ok(plans.bindStepTask(first.plan.id, "A", "child-running", NOW));
    assert.ok(plans.setPlanStatus(first.plan.id, ["active"], "superseded", NOW));

    const second = service.create(owner.id, task.id, { steps: steps() });
    assert.equal(
      codeOf(() => service.activate(owner.id, second.plan.id)),
      "invalid_transition",
    );
  });

  it("refuses revise/resume while the parent has an in-flight action", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    service.pause(owner.id, draft.plan.id);
    const action = new ActionRepository(store.db).insert({
      ownerId: owner.id,
      conversationId: task.conversationId,
      taskId: task.id,
      taskRevision: task.revision,
      fencingToken: 1,
      tool: "state.summary",
      args: {},
      argsHash: "in-flight-hash",
      expiresAt: "2026-01-01T01:00:00.000Z",
      nonce: "in-flight-nonce",
      createdAt: NOW,
    }).action;
    store.db.run("UPDATE pa_actions SET status = 'executing' WHERE id = ?", action.id);

    assert.equal(
      codeOf(() => service.resume(owner.id, draft.plan.id)),
      "invalid_transition",
    );
    assert.equal(
      codeOf(() => service.revise(owner.id, draft.plan.id, { steps: steps() })),
      "invalid_transition",
    );
  });

  it("refuses to revise while a step is running", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    service.activate(owner.id, draft.plan.id);
    assert.ok(
      new PlanRepository(store.db).bindStepTask(draft.plan.id, "A", "child-running", NOW),
    );
    assert.equal(
      codeOf(() => service.revise(owner.id, draft.plan.id, { steps: steps() })),
      "invalid_transition",
    );
  });

  it("keeps plans owner-scoped and survives a service restart", () => {
    const { store, owner, task, service } = setup();
    const draft = service.create(owner.id, task.id, { steps: steps() });
    const other = bindOwner(store, "ou_other");

    assert.equal(service.get(other.id, draft.plan.id), undefined);
    assert.deepEqual(service.list(other.id), []);
    assert.equal(codeOf(() => service.activate(other.id, draft.plan.id)), "plan_not_found");

    const tasks = new TaskRepository(store.db);
    const restarted = new PlanService({
      store,
      plans: new PlanRepository(store.db),
      tasks,
      capabilities: capabilities(),
      now: () => new Date(NOW),
    });
    const restored = restarted.get(owner.id, draft.plan.id);
    assert.equal(restored?.plan.planVersion, 1);
    assert.equal(restored?.steps.length, 3);
  });
});

describe("plan diff", () => {
  it("detects unchanged, changed, added and removed steps", () => {
    const { owner, task, service } = setup();
    const first = service.create(owner.id, task.id, {
      steps: steps(),
      budget: { maxSteps: 5 },
    });
    const changed = steps().slice(0, 2);
    changed[0] = { ...changed[0]!, goal: "read more evidence" };
    changed.push({
      key: "Z",
      goal: "new step",
      dependsOn: [],
      tools: [],
      resources: [],
      verifierId: "text-report",
    });
    // A 3-step minimum means the revision must stay within bounds.
    changed.push({
      key: "Y",
      goal: "another step",
      dependsOn: [],
      tools: [],
      resources: [],
      verifierId: "text-report",
    });
    const second = service.revise(owner.id, first.plan.id, { steps: changed });
    const diff = service.diff(owner.id, second.plan.id);
    assert.deepEqual(
      diff.steps.map((step) => [step.key, step.change]),
      [
        ["A", "changed"],
        ["B", "unchanged"],
        ["Z", "added"],
        ["Y", "added"],
        ["C", "removed"],
      ],
    );
  });
});
