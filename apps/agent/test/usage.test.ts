import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClientApiService } from "../src/client-api.ts";
import { PiRouterModel } from "../src/coordinator/pi-router.ts";
import { buildUsage, formatUsage } from "../src/observability/usage.ts";
import { CONVERSATION_ID } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

describe("usage report", () => {
  it("aggregates task/action/effect/outbox counts without inventing cost", async () => {
    const services = createServices({ now: () => START });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:usage",
      goal: "usage",
      completionCriteria: "done",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "lamp.set_brightness",
      args: { brightness: 40 },
    });
    assert.ok(action);
    services.store.enqueueOutbox({
      businessKey: "usage:outbox",
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: "app_1",
      conversationId: CONVERSATION_ID,
      purpose: "status",
      text: "hello",
      createdAt: START.toISOString(),
    });
    services.confirmation.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceInboxId: "inbox:usage",
      kind: "memory_save",
      payload: { key: "k", value: "v" },
    });

    const snapshot = buildUsage(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
        confirmations: services.confirmation,
      },
      START.toISOString(),
    );

    assert.equal(snapshot.tokens.collected, false);
    assert.equal(snapshot.tasks.running, 1);
    assert.equal(snapshot.actions.proposed, 1);
    // One manual status row plus the action approval card.
    assert.equal(snapshot.outbox.pending, 2);
    assert.equal(snapshot.confirmations.pending, 1);
    assert.deepEqual(snapshot.actionsByTool, [
      { tool: "lamp.set_brightness", count: 1 },
    ]);
    assert.match(formatUsage(snapshot), /token\/费用：未采集/);
    assert.match(formatUsage(snapshot), /lamp\.set_brightness: 1/);
  });

  it("does not count expired unreaped confirmations as pending", () => {
    let current = START;
    const services = createServices({ now: () => current });
    services.confirmation.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceInboxId: "inbox:usage-expired",
      kind: "memory_save",
      payload: { key: "k", value: "v" },
    });
    current = new Date(START.getTime() + 11 * 60_000);

    const snapshot = buildUsage(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
        confirmations: services.confirmation,
      },
      current.toISOString(),
    );

    assert.equal(snapshot.confirmations.pending, 0);
  });

  it("reports collected tokens, cost provenance and worker latency", () => {
    const services = createServices({ now: () => START });
    const usage = {
      models: {
        "opencode-go/deepseek-v4.1-flash": {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 5,
          reasoning: 4,
          totalTokens: 135,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.001,
            cacheWrite: 0.002,
            total: 0.033,
            totalFromProvider: true,
          },
        },
      },
      tools: {},
    };
    services.usage.record({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      source: "worker",
      operationId: "assignment:usage",
      sessionId: "worker-session",
      taskId: "task:usage",
      assignmentId: "assignment:usage",
      cumulative: usage,
      durationMs: 120,
      at: START.toISOString(),
    });

    const snapshot = buildUsage(
      {
        store: services.store,
        tasks: services.tasks,
        actions: services.actions,
        effects: services.effects,
        confirmations: services.confirmation,
        usage: services.usage,
      },
      START.toISOString(),
      { ownerId: services.owner.id },
    );

    assert.equal(snapshot.tokens.collected, true);
    assert.equal(snapshot.tokens.totalTokens, 135);
    assert.equal(snapshot.tokens.costTotal, 0.033);
    assert.equal(snapshot.tokens.costKind, "provider");
    assert.deepEqual(snapshot.tokens.byModel, [
      {
        model: "opencode-go/deepseek-v4.1-flash",
        totalTokens: 135,
        costTotal: 0.033,
      },
    ]);
    assert.equal(snapshot.tokens.workerLatency.samples, 1);
    const text = formatUsage(snapshot);
    assert.match(text, /token\/费用：135 tokens/);
    assert.match(text, /provider 账单/);
    assert.match(text, /Worker 端到端/);
  });

  it("records the Worker conversation usage on the task attempt", async () => {
    const services = createServices({ now: () => START });
    services.runtime.defaultAnswer = {
      status: "answered",
      text: JSON.stringify({
        status: "ready",
        summary: "worker result",
        evidence: [{ kind: "test", value: "worker" }],
      }),
      usage: {
        models: {
          "opencode-go/deepseek-v4.1-flash": {
            input: 12,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        tools: {},
      },
    };
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:usage-worker",
      goal: "worker usage",
      completionCriteria: "done",
    });
    for (let index = 0; index < 20; index += 1) {
      await services.effectDispatcher.drain(20);
    }

    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
    const summary = services.usage.summary(services.owner.id);
    assert.equal(summary.totalTokens, 15);
    assert.equal(summary.bySource[0]?.source, "worker");
    assert.equal(summary.workerLatency.samples, 1);
  });

  it("records Router usage as a delta across a reused session", async () => {
    const services = createServices({ now: () => START });
    const model = new PiRouterModel(
      services.store,
      services.runtime,
      services.usage,
      () => START,
    );
    services.runtime.defaultAnswer = {
      status: "answered",
      text: JSON.stringify({ action: "reply", replyKind: "chat", text: "first" }),
      usage: {
        models: {
          "opencode-go/deepseek-v4.1-flash": {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        tools: {},
      },
    };
    await model.decide({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "first",
      inboxId: "inbox:router-usage-1",
    });
    const sessionId = services.runtime.submissions[0]?.sessionId;
    assert.ok(sessionId);
    services.runtime.enqueueAnswer(sessionId, {
      status: "answered",
      text: JSON.stringify({ action: "reply", replyKind: "chat", text: "second" }),
      usage: {
        models: {
          "opencode-go/deepseek-v4.1-flash": {
            input: 25,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        tools: {},
      },
    });
    await model.decide({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "second",
      inboxId: "inbox:router-usage-2",
    });

    const summary = services.usage.summary(services.owner.id);
    assert.equal(summary.totalTokens, 30);
    assert.equal(summary.operations, 2);
    assert.equal(summary.bySource[0]?.source, "router");
  });

  it("returns collected tokens from the API usage route", async () => {
    const services = createServices({ now: () => START });
    services.usage.record({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      source: "worker",
      operationId: "assignment:api-usage",
      sessionId: "api-usage-session",
      cumulative: {
        models: {
          "provider/model": {
            input: 9,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        tools: {},
      },
      at: START.toISOString(),
    });
    const api = new ClientApiService({
      store: services.store,
      services,
      ownerId: services.owner.id,
      adminToken: "admin-usage",
      now: () => START,
    });
    const response = (await api.handle({
      method: "GET",
      path: "/api/v1/usage",
      query: new URLSearchParams(),
      headers: { authorization: "Bearer admin-usage" },
      body: undefined,
      remoteAddress: "127.0.0.1",
    })) as { status: number; body: { tokens: { collected: boolean; totalTokens: number } } };

    assert.equal(response.status, 200);
    assert.equal(response.body.tokens.collected, true);
    assert.equal(response.body.tokens.totalTokens, 10);
  });

  it("answers /usage with collected token totals", async () => {
    const services = createServices({ now: () => START });
    services.usage.record({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      source: "router",
      operationId: "inbox:usage-command-collected",
      sessionId: "router-usage-command",
      cumulative: {
        models: {
          "opencode-go/deepseek-v4.1-flash": {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: {
              input: 0.01,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.01,
              totalFromProvider: true,
            },
          },
        },
        tools: {},
      },
      at: START.toISOString(),
    });

    await sendText(services, "/usage", "evt_usage_collected");

    const reply = services.store
      .listRecentOutbox(10)
      .find((row) => row.text.includes("用量快照"));
    assert.ok(reply);
    assert.match(reply.text, /token\/费用：12 tokens/);
    assert.match(reply.text, /provider 账单/);
  });

  it("answers /usage with the same aggregate", async () => {
    const services = createServices({ now: () => START });
    services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:usage-command",
      goal: "usage",
      completionCriteria: "done",
    });

    await sendText(services, "/usage", "evt_usage");

    const reply = services.store
      .listRecentOutbox(10)
      .find((row) => row.text.includes("用量快照"));
    assert.ok(reply);
    assert.match(reply.text, /Task：排队 1/);
    assert.match(reply.text, /token\/费用：未采集/);
  });
});
