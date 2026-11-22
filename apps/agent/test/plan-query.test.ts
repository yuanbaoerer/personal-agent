import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPlanProgressQuery } from "../src/coordinator/router.ts";
import { taskFocusKey } from "../src/coordinator/state-query.ts";
import type { PlanStepSpec, TaskRecord } from "../src/domain/types.ts";
import { createServices, sendText, type TestServices } from "./services.ts";
import { inbound } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function steps(): PlanStepSpec[] {
  return [
    {
      key: "A",
      goal: "read evidence",
      dependsOn: [],
      tools: [],
      resources: [],
      verifierId: "structural",
    },
    {
      key: "B",
      goal: "analyze evidence",
      dependsOn: ["A"],
      tools: [],
      resources: [],
      verifierId: "structural",
    },
    {
      key: "C",
      goal: "write report",
      dependsOn: ["B"],
      tools: [],
      resources: [],
      verifierId: "structural",
    },
  ];
}

function setup(): {
  services: TestServices;
  parent: TaskRecord;
  planId: string;
} {
  const services = createServices({ now: () => NOW });
  const parent = services.tasks.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `plan-query-${Math.random().toString(36).slice(2)}`,
    goal: "parent goal",
    completionCriteria: "provide a checked result",
    mandate: { resources: ["chat"], tools: [] },
    createdAt: NOW.toISOString(),
  }).task;
  const plan = services.planService.create(services.owner.id, parent.id, {
    steps: steps(),
  });
  services.planService.activate(services.owner.id, plan.plan.id);
  return { services, parent, planId: plan.plan.id };
}

function lastOutbox(services: TestServices): string {
  return services.store.listRecentOutbox(5)[0]?.text ?? "";
}

describe("plan progress queries", () => {
  it("detects natural progress questions without stealing plan creation", () => {
    assert.equal(isPlanProgressQuery("当前计划到哪一步了？"), true);
    assert.equal(isPlanProgressQuery("刚才那个计划进展如何"), true);
    assert.equal(isPlanProgressQuery("方案状态"), true);
    assert.equal(isPlanProgressQuery("plan status"), true);
    assert.equal(isPlanProgressQuery("先给我一个三步方案，先不执行"), false);
    assert.equal(isPlanProgressQuery("制定一个计划"), false);
    assert.equal(isPlanProgressQuery("那个计划怎么样"), false);
  });

  it("answers progress from persisted steps without calling the model", async () => {
    const { services, planId } = setup();
    await sendText(services, "当前计划到哪一步了？", "evt_plan_progress");

    const text = lastOutbox(services);
    assert.match(text, new RegExp(`计划 ${planId.slice(0, 8)}`));
    assert.match(text, /步骤：/);
    assert.match(text, /A \[ready\]/);
    assert.match(text, /下一步：A/);
    assert.ok(!services.runtime.submissions.some((item) => item.entryKind === "app.router"));
  });

  it("lists, shows, diffs and cancels plans over chat", async () => {
    const { services, planId } = setup();
    await sendText(services, "/plans", "evt_plans_list");
    assert.match(lastOutbox(services), /计划：/);
    assert.match(lastOutbox(services), new RegExp(planId.slice(0, 8)));

    await sendText(services, `/plan ${planId.slice(0, 8)}`, "evt_plan_show");
    assert.match(lastOutbox(services), /v1\s+active/);

    services.planService.pause(services.owner.id, planId);
    const revised = services.planService.revise(services.owner.id, planId, {
      steps: steps().map((step) =>
        step.key === "B" ? { ...step, goal: "analyze more evidence" } : step,
      ),
    });
    await sendText(
      services,
      `/plan diff ${revised.plan.id.slice(0, 8)} 1 2`,
      "evt_plan_diff",
    );
    assert.match(lastOutbox(services), /PlanDiff v1 -> v2/);
    assert.match(lastOutbox(services), /~ B\s+changed: goal/);

    await sendText(services, `/plan cancel ${revised.plan.id}`, "evt_plan_cancel_ask");
    assert.match(lastOutbox(services), /confirm/);
    await sendText(
      services,
      `/plan cancel ${revised.plan.id} confirm`,
      "evt_plan_cancel",
    );
    assert.match(lastOutbox(services), /cancelled/);
    assert.equal(
      services.planService.get(services.owner.id, revised.plan.id)?.plan.status,
      "cancelled",
    );
  });

  it("persists a model-proposed plan as a non-executing draft", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-draft-from-model",
      goal: "plan target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.model.push({
      action: "draft_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });

    await sendText(services, "先给我这个任务的三步计划，不要执行", "evt_plan_draft");

    const plans = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.status, "draft");
    assert.match(lastOutbox(services), /计划草稿 v1（未执行）/);
    assert.equal(
      services.tasks.listByOwner(services.owner.id, 20).filter((task) => task.planStepKey !== undefined)
        .length,
      0,
    );
  });

  it("redirects a misrouted plan decision for a state question", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-draft-redirect",
      goal: "redirect target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.model.push({
      action: "draft_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });

    await sendText(services, "现在有哪些任务", "evt_plan_redirect");

    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      0,
    );
    assert.match(lastOutbox(services), /任务/);
    assert.ok(!lastOutbox(services).includes("计划草稿"));
  });

  it("revises a draft plan into a new version with a PlanDiff", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-revision",
      goal: "revision target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.model.push({
      action: "draft_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await sendText(services, "先给我三步计划", "evt_revise_1");
    const first = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    })[0];
    assert.equal(first?.planVersion, 1);

    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: {
        steps: steps().map((step) =>
          step.key === "B" ? { ...step, goal: "read-only analysis" } : step,
        ),
      },
    });
    await sendText(services, "第二步改成只读评估，先给我 diff", "evt_revise_2");

    const plans = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    });
    assert.deepEqual(
      plans.map((plan) => [plan.planVersion, plan.status]),
      [
        [2, "draft"],
        [1, "superseded"],
      ],
    );
    assert.match(lastOutbox(services), /计划草稿已更新为 v2/);
    assert.match(lastOutbox(services), /PlanDiff v1 -> v2/);
    assert.match(lastOutbox(services), /~ B\s+changed: goal/);
    assert.equal(
      services.tasks
        .listByOwner(services.owner.id, 20)
        .filter((task) => task.planStepKey !== undefined).length,
      0,
    );
  });

  it("preserves a non-default source budget during chat revision", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-budget-revision",
      goal: "budget target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    const budget = {
      maxSteps: 3,
      maxAttemptsPerStep: 2,
      timeoutMs: 60_000,
      maxToolCalls: 1,
    };
    const source = services.planService.create(services.owner.id, parent.id, {
      steps: steps().map((step) => ({ ...step, maxAttempts: 2 })),
      budget,
    });

    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: {
        steps: steps().map((step) => ({
          ...step,
          maxAttempts: 2,
          ...(step.key === "B" ? { goal: "budget-safe revision" } : {}),
        })),
      },
    });
    await sendText(services, "改第二步，预算不能变", "evt_budget_revise");

    const revised = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    })[0];
    assert.equal(revised?.planVersion, 2);
    assert.deepEqual(revised?.budget, source.plan.budget);
    assert.equal(revised?.budget.maxToolCalls, 1);

    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: {
        steps: steps().map((step) => ({ ...step, maxAttempts: 3 })),
      },
    });
    await sendText(services, "再加一次重试", "evt_budget_revise_reject");
    assert.match(lastOutbox(services), /计划修改失败/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id })[0]
        ?.planVersion,
      2,
    );
  });

  it("resolves a natural planRef to the only draft", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-natural-ref",
      goal: "natural ref target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.model.push({
      action: "revise_plan",
      text: "",
      planRef: "刚才那个计划",
      plan: {
        steps: steps().map((step) =>
          step.key === "C" ? { ...step, goal: "natural ref revision" } : step,
        ),
      },
    });
    await sendText(services, "把刚才那个计划最后一步改一下", "evt_natural_ref");

    assert.match(lastOutbox(services), /计划草稿已更新为 v2/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id })[0]
        ?.planVersion,
      2,
    );
  });

  it("does not revise a task's plan from another conversation", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-cross-chat",
      goal: "cross chat target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    const otherConversation = services.store.upsertConversation({
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: services.conversation.accountId,
      platformConversationId: "oc_other_revise",
      kind: "p2p",
      createdAt: NOW.toISOString(),
    });
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await services.ingress.accept(
      inbound({
        platformEventId: "evt_cross_chat_revise",
        platformConversationId: "oc_other_revise",
        text: "改一下另一个会话的计划",
      }),
    );
    await services.effectDispatcher.drain(20);

    assert.match(lastOutbox(services), /当前会话没有(?:匹配)?这个任务|不属于当前会话/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      1,
    );
    // The refused task must not become this conversation's deictic focus.
    assert.equal(
      services.store.metaGet(taskFocusKey(otherConversation.id)),
      undefined,
    );
  });

  it("resolves a natural taskRef for revise_plan through conversation focus", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-natural-task-ref",
      goal: "natural task ref target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.store.metaSet(taskFocusKey(services.conversation.id), parent.id);
    services.model.push({
      action: "revise_plan",
      text: "",
      taskRef: "刚才那个任务",
      plan: {
        steps: steps().map((step) =>
          step.key === "C" ? { ...step, goal: "task ref revision" } : step,
        ),
      },
    });
    await sendText(services, "改一下刚才那个任务的计划", "evt_natural_task_ref");
    assert.match(lastOutbox(services), /计划草稿已更新为 v2/);
  });

  it("does not create a plan for another conversation's task", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-draft-cross-chat",
      goal: "draft cross chat",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    const otherConversation = services.store.upsertConversation({
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: services.conversation.accountId,
      platformConversationId: "oc_draft_other",
      kind: "p2p",
      createdAt: NOW.toISOString(),
    });
    services.model.push({
      action: "draft_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await services.ingress.accept(
      inbound({
        platformEventId: "evt_draft_cross_chat",
        platformConversationId: "oc_draft_other",
        text: "给另一个会话的任务做计划",
      }),
    );
    await services.effectDispatcher.drain(20);

    assert.match(lastOutbox(services), /当前会话没有这个任务/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      0,
    );
    assert.equal(
      services.store.metaGet(taskFocusKey(otherConversation.id)),
      undefined,
    );
  });

  it("asks for an id when a task has multiple drafts", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-multiple-drafts",
      goal: "multiple drafts target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await sendText(services, "改一下草稿", "evt_multiple_drafts");

    assert.match(lastOutbox(services), /多个计划草稿/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      2,
    );
  });

  it("gives ack/cancel guidance for a paused plan on a needs_review parent", async () => {
    const { services, parent, planId } = setup();
    services.planService.pause(services.owner.id, planId);
    services.tasks.updateTask(parent.id, parent.revision, {
      status: "needs_review",
      updatedAt: NOW.toISOString(),
    });
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await sendText(services, "改一下这个暂停计划", "evt_needs_review_paused");

    assert.match(lastOutbox(services), /待确认/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      1,
    );
  });

  it("replans an active plan by stopping its running step", async () => {
    const { services, parent, planId } = setup();
    const child = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-replan-child",
      goal: "running child",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      planId,
      planStepKey: "A",
      createdAt: NOW.toISOString(),
    }).task;
    assert.ok(services.plans.bindStepTask(planId, "A", child.id, NOW.toISOString()));

    await sendText(services, `/plan replan ${planId} confirm`, "evt_replan_running");
    const plans = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    });
    assert.deepEqual(
      plans.map((plan) => [plan.planVersion, plan.status]),
      [
        [2, "active"],
        [1, "superseded"],
      ],
    );
    assert.notEqual(services.tasks.get(child.id)?.status, "queued");
    assert.equal(
      services.plans.listSteps(planId)[0]?.status,
      "cancelled",
    );
  });

  it("replans a paused plan with a running step and preserves completed work/budget", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-replan-paused",
      goal: "paused replan parent",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    const plan = services.planService.create(services.owner.id, parent.id, {
      steps: steps(),
      budget: { maxToolCalls: 1 },
    });
    services.planService.activate(services.owner.id, plan.plan.id);
    assert.ok(services.plans.bindStepTask(plan.plan.id, "A", "done-child", NOW.toISOString()));
    services.plans.setStepOutcome(
      plan.plan.id,
      "A",
      "completed",
      ["task:done-child"],
      undefined,
      NOW.toISOString(),
    );
    const running = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-replan-paused-child",
      goal: "running child",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      planId: plan.plan.id,
      planStepKey: "B",
      createdAt: NOW.toISOString(),
    }).task;
    services.plans.setStepsStatus(
      plan.plan.id,
      ["B"],
      "ready",
      NOW.toISOString(),
    );
    assert.ok(
      services.plans.bindStepTask(
        plan.plan.id,
        "B",
        running.id,
        NOW.toISOString(),
      ),
    );
    services.planService.pause(services.owner.id, plan.plan.id);

    await sendText(
      services,
      `/plan replan ${plan.plan.id} confirm`,
      "evt_replan_paused_running",
    );
    const replanned = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    })[0];
    assert.equal(replanned?.status, "active");
    assert.equal(replanned?.budget.maxToolCalls, 1);
    const replannedSteps = services.planService.get(
      services.owner.id,
      replanned?.id ?? "",
    )?.steps;
    assert.equal(
      replannedSteps?.find((step) => step.key === "A")?.status,
      "completed",
    );
    assert.equal(
      replannedSteps?.find((step) => step.key === "A")?.taskId,
      "done-child",
    );
  });

  it("asks when a task has both a draft and an active plan", async () => {
    const { services, parent } = setup();
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await sendText(services, "改一下草稿", "evt_draft_and_active");

    assert.match(lastOutbox(services), /同时有执行中计划 .* 和可修改的草稿/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      2,
    );
  });

  it("redirects a misrouted revise_plan for a state question", async () => {
    const services = createServices({ now: () => NOW });
    const parent = services.tasks.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plan-revise-redirect",
      goal: "redirect target",
      completionCriteria: "provide a checked result",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    }).task;
    services.planService.create(services.owner.id, parent.id, { steps: steps() });
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      plan: { steps: steps() },
    });
    await sendText(services, "现在有哪些任务", "evt_revise_redirect");

    assert.match(lastOutbox(services), /任务/);
    assert.ok(!lastOutbox(services).includes("计划草稿已更新"));
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      1,
    );
  });

  it("replans via /plan replan only after confirmation", async () => {
    const { services, parent, planId } = setup();
    services.planService.pause(services.owner.id, planId);

    await sendText(services, `/plan replan ${planId}`, "evt_replan_ask");
    assert.match(lastOutbox(services), /confirm/);
    assert.equal(
      services.planService.list(services.owner.id, { parentTaskId: parent.id }).length,
      1,
    );

    await sendText(services, `/plan replan ${planId} confirm`, "evt_replan_do");
    const plans = services.planService.list(services.owner.id, {
      parentTaskId: parent.id,
    });
    assert.deepEqual(
      plans.map((plan) => [plan.planVersion, plan.status]),
      [
        [2, "active"],
        [1, "superseded"],
      ],
    );
    assert.equal(services.tasks.get(parent.id)?.planId, plans[0]?.id);
  });

  it("refuses to revise an active plan through chat", async () => {
    const { services, parent, planId } = setup();
    services.model.push({
      action: "revise_plan",
      text: "",
      taskId: parent.id,
      planId,
      plan: { steps: steps() },
    });
    await sendText(services, "改一下刚才的计划", "evt_revise_active");
    assert.match(lastOutbox(services), /暂停|replan/);
    assert.equal(
      services.planService.get(services.owner.id, planId)?.plan.status,
      "active",
    );
  });

  it("does not expose another conversation's plan", async () => {
    const { services } = setup();
    await services.ingress.accept(
      inbound({
        platformEventId: "evt_plan_other_chat",
        platformConversationId: "oc_other_plan_chat",
        text: "当前计划进展如何",
      }),
    );
    await services.effectDispatcher.drain(20);
    // Falls through to the normal Router; the plan never leaks across chats.
    assert.ok(!lastOutbox(services).includes("parent goal"));
    assert.ok(!lastOutbox(services).includes("read evidence"));
  });
});
