import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClientApiService, type ClientApiRequest } from "../src/client-api.ts";
import type { TaskRecord } from "../src/domain/types.ts";
import { createServices, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

function fixture(): { services: TestServices; api: ClientApiService; task: TaskRecord } {
  const services = createServices({ now: () => NOW });
  const task = services.tasks.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: "api-plan-task",
    goal: "plan parent",
    completionCriteria: "criteria",
    mandate: { resources: ["chat", "state"], tools: ["state.summary"] },
    createdAt: NOW.toISOString(),
  }).task;
  const api = new ClientApiService({
    store: services.store,
    services,
    ownerId: services.owner.id,
    adminToken: ADMIN,
    now: () => NOW,
  });
  return { services, api, task };
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(options.query),
    headers: { authorization: `Bearer ${ADMIN}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const response = await api.handle(request);
  return { status: response.status, body: response.body as Record<string, unknown> };
}

function steps() {
  return [
    {
      key: "A",
      goal: "read state",
      dependsOn: [],
      tools: ["state.summary"],
      resources: ["state"],
      verifierId: "state-read",
    },
    { key: "B", goal: "summarize", dependsOn: ["A"], tools: [], resources: [], verifierId: "text-report" },
    { key: "C", goal: "review", dependsOn: ["A"], tools: [], resources: [], verifierId: "text-report" },
  ];
}

describe("plan API", () => {
  it("creates, activates, lists and diffs a plan", async () => {
    const { api, task } = fixture();
    const created = await call(api, "POST", "/api/v1/plans", {
      body: {
        parentTaskId: task.id,
        steps: steps(),
        budget: { maxToolCalls: 1 },
      },
    });
    assert.equal(created.status, 201);
    const plan = created.body.plan as { id: string; status: string; planVersion: number };
    assert.equal(plan.status, "draft");
    assert.equal(plan.planVersion, 1);

    const listed = await call(api, "GET", "/api/v1/plans", {
      query: { task: task.id },
    });
    assert.equal(listed.status, 200);
    assert.equal((listed.body.plans as unknown[]).length, 1);

    const activated = await call(api, "POST", `/api/v1/plans/${plan.id}/activate`);
    assert.equal(activated.status, 200);
    assert.equal((activated.body.plan as { status: string }).status, "active");
    assert.deepEqual(
      (activated.body.steps as { key: string; status: string }[]).map((step) => [
        step.key,
        step.status,
      ]),
      [
        ["A", "ready"],
        ["B", "blocked"],
        ["C", "blocked"],
      ],
    );

    const paused = await call(api, "POST", `/api/v1/plans/${plan.id}/pause`);
    assert.equal(paused.status, 200);

    const revised = await call(api, "POST", `/api/v1/plans/${plan.id}/revise`, {
      body: {
        budget: { maxSteps: 4 },
        steps: steps().map((step) =>
          step.key === "B" ? { ...step, goal: "summarize with evidence" } : step,
        ),
      },
    });
    assert.equal(revised.status, 200);
    const next = revised.body.plan as {
      id: string;
      planVersion: number;
      budget: { maxToolCalls?: number };
    };
    assert.equal(next.planVersion, 2);
    // A partial budget body augments, never resets, the source budget.
    assert.equal(next.budget.maxToolCalls, 1);

    const diff = await call(api, "GET", `/api/v1/plans/${next.id}/diff`);
    assert.equal(diff.status, 200);
    const stepsDiff = (diff.body.diff as { steps: { key: string; change: string }[] }).steps;
    assert.deepEqual(
      stepsDiff.map((step) => [step.key, step.change]),
      [
        ["A", "unchanged"],
        ["B", "changed"],
        ["C", "unchanged"],
      ],
    );

    const superseded = await call(api, "POST", `/api/v1/plans/${plan.id}/revise`, {
      body: { steps: steps() },
    });
    assert.equal(superseded.status, 409);
  });

  it("maps invalid plans and stale activation to owner-visible errors", async () => {
    const { services, api, task } = fixture();
    const invalid = await call(api, "POST", "/api/v1/plans", {
      body: { parentTaskId: task.id, steps: steps().slice(0, 2) },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_plan");

    const created = await call(api, "POST", "/api/v1/plans", {
      body: { parentTaskId: task.id, steps: steps() },
    });
    const planId = (created.body.plan as { id: string }).id;
    services.tasks.addInput({
      taskId: task.id,
      actorId: services.owner.actorId,
      text: "new constraint",
      createdAt: NOW.toISOString(),
    });
    const stale = await call(api, "POST", `/api/v1/plans/${planId}/activate`);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "stale_task_input");

    assert.equal((await call(api, "GET", "/api/v1/plans/missing")).status, 404);
  });
});
