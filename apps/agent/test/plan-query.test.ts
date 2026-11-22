import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPlanProgressQuery } from "../src/coordinator/router.ts";
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
