import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CallBudget } from "../src/observability/call-budget.ts";
import type { BudgetService } from "../src/observability/magpie.ts";
import { createStore } from "./helpers.ts";
import { createServices } from "./services.ts";

const NOW = new Date("2026-01-01T12:00:00.000Z");

describe("persistent model-call budget", () => {
  it("enforces a per-task limit and survives a new instance", async () => {
    const store = createStore();
    const first = new CallBudget({
      store,
      maxCallsPerTask: 2,
      now: () => NOW,
    });
    assert.equal((await first.check({ role: "worker", taskId: "task-a" })).ok, true);
    assert.equal((await first.check({ role: "worker", taskId: "task-a" })).ok, true);
    const rejected = await first.check({ role: "worker", taskId: "task-a" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.permanent, true);
    assert.match(rejected.reason ?? "", /上限/);

    const restarted = new CallBudget({
      store,
      maxCallsPerTask: 2,
      now: () => NOW,
    });
    const stillRejected = await restarted.check({
      role: "worker",
      taskId: "task-a",
    });
    assert.equal(stillRejected.ok, false);
    assert.equal(stillRejected.permanent, true);
  });

  it("enforces a daily limit with a next-midnight retry time", async () => {
    const store = createStore();
    const budget = new CallBudget({
      store,
      maxCallsPerTask: 10,
      maxCallsPerDay: 2,
      now: () => NOW,
    });
    assert.equal((await budget.check({ role: "router" })).ok, true);
    assert.equal((await budget.check({ role: "worker", taskId: "task-a" })).ok, true);
    const rejected = await budget.check({ role: "worker", taskId: "task-b" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.permanent, undefined);
    assert.equal(rejected.retryAt, "2026-01-02T00:00:00.000Z");
    assert.match(await budget.summaryText(), /今日 2\/2 次/);
  });

  it("reports usage even when no daily cap is configured", async () => {
    const store = createStore();
    const budget = new CallBudget({
      store,
      maxCallsPerTask: 10,
      now: () => NOW,
    });
    assert.equal((await budget.check({ role: "router" })).ok, true);
    assert.equal((await budget.check({ role: "worker", taskId: "task-a" })).ok, true);
    assert.match(await budget.summaryText(), /今日 2 次（每日上限未配置）/);
  });

  it("does not consume quota when an upstream check fails", async () => {
    const store = createStore();
    let upstreamOk = false;
    const upstream: BudgetService = {
      async check() {
        return upstreamOk ? { ok: true } : { ok: false, reason: "quota" };
      },
      async summaryText() {
        return "upstream";
      },
    };
    const budget = new CallBudget({
      store,
      maxCallsPerTask: 1,
      maxCallsPerDay: 1,
      upstream,
      now: () => NOW,
    });
    assert.equal((await budget.check({ role: "worker", taskId: "task-a" })).ok, false);
    upstreamOk = true;
    assert.equal((await budget.check({ role: "worker", taskId: "task-a" })).ok, true);
    assert.equal((await budget.check({ role: "worker", taskId: "task-a" })).ok, false);
    assert.match(await budget.summaryText(), /upstream/);
  });

  it("caps cumulative action proposals for one task", () => {
    const services = createServices({
      now: () => NOW,
      maxToolCallsPerTask: 1,
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "budget:tool-calls",
      goal: "tool budget target",
      completionCriteria: "done",
      mandate: {
        resources: ["chat", "state"],
        tools: ["state.summary", "reminder.list"],
      },
    });
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const result = services.actionService.proposeForReport(
      claimed.task,
      claimed.assignment,
      [
        { tool: "state.summary", args: {} },
        { tool: "reminder.list", args: { limit: 5, offset: 0 } },
      ],
    );
    assert.equal(result.count, 1);
    assert.equal(result.rejected, 1);
    assert.equal(services.actions.listByTask(task.id).length, 1);
    assert.equal(
      services.actionService.propose(
        claimed.task,
        claimed.assignment,
        { tool: "state.summary", args: {} },
      ),
      undefined,
    );
  });

  it("requeues a timed budget pause without consuming an attempt", async () => {
    let checks = 0;
    const services = createServices({
      now: () => NOW,
      budget: {
        async check() {
          checks += 1;
          return checks === 1
            ? {
                ok: false,
                retryAt: "2026-01-02T00:00:00.000Z",
                reason: "今日模型请求已达上限（1 次）",
              }
            : { ok: true };
        },
        async summaryText() {
          return "budget";
        },
      },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "budget:timed",
      goal: "budget target",
      completionCriteria: "done",
    });
    await services.effectDispatcher.drain(20);
    const paused = services.tasks.get(task.id);
    assert.equal(paused?.status, "queued");
    assert.equal(paused?.attempts, 0);
    assert.match(
      services.store
        .listRecentOutbox(20)
        .map((row) => row.text)
        .join("\n"),
      /预计 2026-01-02T00:00:00.000Z 后恢复/,
    );
  });

  it("fails a task permanently when its worker budget is exhausted", async () => {
    const services = createServices({
      now: () => NOW,
      budget: {
        async check() {
          return { ok: false, permanent: true, reason: "任务模型请求已达上限（1 次）" };
        },
        async summaryText() {
          return "budget";
        },
      },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "budget:permanent",
      goal: "budget target",
      completionCriteria: "done",
    });
    await services.effectDispatcher.drain(20);
    assert.equal(services.tasks.get(task.id)?.status, "failed");
    assert.match(
      services.store
        .listRecentOutbox(20)
        .map((row) => row.text)
        .join("\n"),
      /任务已停止/,
    );
  });
});
