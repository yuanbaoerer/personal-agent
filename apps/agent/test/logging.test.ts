import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PiRouterModel } from "../src/coordinator/pi-router.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";
import { createStore } from "./helpers.ts";

const SECRET = "private owner text / token";

function runtimeReturning(text: string): AgentRuntime {
  return {
    async open() {
      return { id: "router-session" };
    },
    async submit(_sessionId, _text, operationId) {
      return { operationId };
    },
    async wait() {
      return { status: "answered", text };
    },
    async interrupt() {},
  };
}

async function captureConsole<T>(
  method: "warn" | "info",
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const original = console[method];
  const lines: string[] = [];
  console[method] = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console[method] = original;
  }
}

const input = {
  ownerId: "owner",
  conversationId: "conversation",
  text: "hello",
  inboxId: "inbox:logging",
};

describe("router logging redaction", () => {
  it("does not log model output when the decision is invalid", async () => {
    const model = new PiRouterModel(createStore(), runtimeReturning(SECRET));

    const { lines } = await captureConsole("warn", () => model.decide(input));

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /router_decision_invalid/);
    assert.ok(!lines.join("\n").includes(SECRET));
  });

  it("does not log the task goal when the decision is valid", async () => {
    const model = new PiRouterModel(
      createStore(),
      runtimeReturning(
        JSON.stringify({
          action: "create_task",
          text: "ok",
          task: {
            goal: SECRET,
            completionCriteria: "done",
            mandate: { resources: ["chat"], tools: [] },
          },
        }),
      ),
    );

    const { lines } = await captureConsole("info", () => model.decide(input));

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /router_decision/);
    assert.ok(!lines.join("\n").includes(SECRET));
  });
});
