import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "../src/app.ts";
import type { ActionTool, ToolRegistry } from "../src/actions/tools.ts";
import { ToolRejectedError } from "../src/actions/tools.ts";
import { StaticRouterModel } from "../src/coordinator/router.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { noopWake } from "../src/runtime/types.ts";
import { APP_ID, CONVERSATION_ID, OWNER_OPEN_ID, createStore } from "./helpers.ts";

class ClockTool implements ActionTool {
  readonly name = "time.now";
  readonly resource = "clock";
  readonly readOnly = true;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs = 2_000;

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    if (Object.keys(args).length > 0) {
      throw new ToolRejectedError("time.now takes no arguments");
    }
    return {};
  }

  async execute() {
    return { evidence: { now: "2026-01-01T00:00:00.000Z" } };
  }

  async verify() {
    return { satisfied: false, evidence: { readOnly: true } };
  }
}

function build(register: (registry: ToolRegistry) => void) {
  const store = createStore();
  const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
  assert.ok(owner);
  const conversation = store.upsertConversation({
    ownerId: owner.id,
    channel: "feishu",
    accountId: APP_ID,
    platformConversationId: CONVERSATION_ID,
    kind: "p2p",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const app = createApp({
    store,
    runtime: new FakeRuntime(),
    wake: noopWake,
    model: new StaticRouterModel(),
    registerTools: register,
  });
  return { store, owner, conversation, app };
}

describe("read-only tool extension", () => {
  it("registers independently and enforces the Mandate resource", async () => {
    const { store, owner, conversation, app } = build((registry) => {
      registry.register(new ClockTool());
    });
    const allowed = app.taskService.create({
      ownerId: owner.id,
      conversationId: conversation.id,
      sourceKey: "source:clock-allowed",
      goal: "tell time",
      completionCriteria: "time",
      mandate: { resources: ["chat", "clock"], tools: ["time.now"] },
    });
    const claimed = app.tasks.claimNext("2026-01-01T00:00:00.000Z", 60_000, 2);
    assert.ok(claimed);
    const action = app.actionService.propose(allowed, claimed.assignment, {
      tool: "time.now",
      args: {},
    });
    assert.ok(action);
    app.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: owner.id,
      conversationId: conversation.id,
    });
    await app.actionService.handleExecute({ actionId: action.id });

    assert.equal(app.actions.get(action.id)?.status, "succeeded");
    assert.equal(
      app.actions.get(action.id)?.evidence?.now,
      "2026-01-01T00:00:00.000Z",
    );

    const denied = app.taskService.create({
      ownerId: owner.id,
      conversationId: conversation.id,
      sourceKey: "source:clock-denied",
      goal: "tell time",
      completionCriteria: "time",
      mandate: { resources: ["chat"], tools: ["time.now"] },
    });
    const claimedAgain = app.tasks.claimNext("2026-01-01T00:00:00.000Z", 60_000, 2);
    assert.ok(claimedAgain);
    assert.equal(
      app.actionService.propose(denied, claimedAgain.assignment, {
        tool: "time.now",
        args: {},
      }),
      undefined,
    );
    store.close();
  });

  it("rejects replacing a built-in tool name", () => {
    assert.throws(
      () =>
        build((registry) => {
          registry.register({
            name: "lamp.set_brightness",
            canonicalize: () => ({}),
            async execute() {
              return { evidence: {} };
            },
            async verify() {
              return { satisfied: true, evidence: {} };
            },
          });
        }),
      /tool already registered/,
    );
  });
});
