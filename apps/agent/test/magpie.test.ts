import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MagpieBudget } from "../src/observability/magpie.ts";
import { createServices, sendText } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function budgetFixture(options: {
  remaining?: number;
  limited?: boolean;
  cardProvider?: string;
  cardName?: string;
  cardPlan?: string;
  limitLimited?: boolean;
} = {}) {
  const calls: { path: string; auth: string | null }[] = [];
  const fetcher = async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({
      path: `${url.pathname}${url.search}`,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (url.pathname === "/api/hello") {
      return Response.json({ name: "magpie", version: "0.1.0" });
    }
    if (url.pathname === "/v1/magpie/quotas") {
      return Response.json({
        data: [
          {
            provider: options.cardProvider ?? "opencode",
            name:
              options.cardName ??
              ((options.cardProvider ?? "opencode") === "codex" ? "Codex" : "OpenCode Go"),
            plan: options.cardPlan ?? "go",
            windows: [
              {
                name: "5 hours",
                used: 10,
                remaining: options.remaining ?? 90,
                resetsAt: "2026-01-01T06:00:00+08:00",
                limited: options.limited === true,
              },
            ],
          },
          { provider: "codex", name: "Codex", windows: [{ name: "7 days", remaining: 0 }] },
        ],
      });
    }
    if (url.pathname === "/v1/magpie/usage") {
      return Response.json({
        period: "today",
        calls: 3,
        input: 1000,
        output: 200,
        cache_read: 50,
        cost: 0.0123,
        unpriced: 1,
        errors: 0,
      });
    }
    if (url.pathname === "/v1/magpie/limit") {
      return Response.json({ limited: options.limitLimited === true, limits: null });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetcher as typeof fetch, calls };
}

function budget(fixture: ReturnType<typeof budgetFixture>): MagpieBudget {
  return new MagpieBudget({
    baseUrl: "http://127.0.0.1:3425",
    gatewayKey: "magpie-personal-agent",
    minRemainingPercent: 5,
    fetch: fixture.fetch,
  });
}

describe("Magpie usage adapter", () => {
  it("reads OpenCode Go quotas and today's usage without other cards", async () => {
    const fixture = budgetFixture();
    const gateway = budget(fixture);

    const check = await gateway.check();
    const text = await gateway.summaryText();

    assert.deepEqual(check, { ok: true });
    assert.equal(fixture.calls.length, 4);
    assert.ok(fixture.calls.every((call) => call.auth === "Bearer magpie-personal-agent"));
    assert.match(text, /OpenCode Go/);
    assert.match(text, /剩余 90%/);
    assert.match(text, /请求 3/);
    assert.match(text, /费用 \$0\.0123/);
    assert.match(text, /1 条未定价/);
    assert.ok(!text.includes("Codex"));
  });

  it("blocks when an OpenCode Go window is exhausted or limited", async () => {
    const exhausted = budget(budgetFixture({ remaining: 0 }));
    const limited = budget(budgetFixture({ limited: true }));

    assert.equal((await exhausted.check()).ok, false);
    assert.match((await exhausted.check()).reason ?? "", /0% left/);
    assert.equal((await limited.check()).ok, false);
    assert.match((await limited.check()).reason ?? "", /limited/);
  });

  it("blocks when the gateway key budget is exhausted", async () => {
    const gateway = budget(budgetFixture({ limitLimited: true }));
    const check = await gateway.check();
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /gateway key budget/);
  });

  it("uses a single OpenCode card even when its label omits the word go", async () => {
    const gateway = budget(
      budgetFixture({ cardName: "OpenCode", cardPlan: "", remaining: 0 }),
    );
    const check = await gateway.check();
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /0% left/);
  });

  it("degrades instead of blocking when Magpie is unreachable", async () => {
    const unreachable = new MagpieBudget({
      baseUrl: "http://127.0.0.1:3425",
      fetch: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });

    const check = await unreachable.check();
    assert.equal(check.ok, true);
    assert.equal(check.degraded, true);
    assert.match(await unreachable.summaryText(), /不可用/);
  });

  it("does not let another provider's window block OpenCode", async () => {
    const gateway = budget(budgetFixture({ cardProvider: "codex" }));
    assert.deepEqual(await gateway.check(), { ok: true });
  });

  it("gates worker dispatch and route model calls", async () => {
    const blocked = {
      async check() {
        return { ok: false as const, reason: "subscription exhausted" };
      },
      async summaryText() {
        return "Magpie blocked";
      },
    };
    const services = createServices({ budget: blocked, now: () => START });
    services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:budget-gate",
      goal: "blocked",
      completionCriteria: "blocked",
    });
    const drained = await services.effectDispatcher.drain(5);
    assert.equal(drained.retried, 1);
    assert.equal(services.runtime.opened.length, 0);
    assert.equal(services.tasks.listRecent(5)[0]?.status, "queued");

    await sendText(services, "hello", "evt_budget_route");
    assert.ok(
      services.store
        .listRecentOutbox(10)
        .some((row) => row.text.includes("模型请求已暂停")),
    );

    await sendText(services, "/usage", "evt_budget_usage");
    const usageReply = services.store
      .listRecentOutbox(10)
      .find((row) => row.text.includes("Magpie blocked"));
    assert.ok(usageReply);
    assert.ok(!usageReply.text.includes("token/费用：未采集"));
  });
});
