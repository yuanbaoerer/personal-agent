import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isDiscussionOnly,
  StaticRouterModel,
  type RouterModel,
} from "../src/coordinator/router.ts";
import { parseRouterDecision } from "../src/coordinator/pi-router.ts";
import type { RouterDecision, RouterInput } from "../src/domain/types.ts";
import { createServices, sendText } from "./services.ts";
import { inbound } from "./helpers.ts";

function taskCount(services: ReturnType<typeof createServices>): number {
  return services.tasks.listByOwner(services.owner.id).length;
}

/**
 * Simulates platform delivery so the next turn can see the assistant reply.
 * The real outbox dispatcher does this after Feishu accepts the message.
 */
function acceptPendingOutbox(services: ReturnType<typeof createServices>): void {
  services.store.db.run(
    `UPDATE pa_outbox
     SET status = 'accepted', accepted_at = created_at
     WHERE status = 'pending'`,
  );
}

class RecordingRouterModel implements RouterModel {
  readonly inputs: RouterInput[] = [];
  readonly #decisions: RouterDecision[];

  constructor(decisions: RouterDecision[]) {
    this.#decisions = [...decisions];
  }

  async decide(input: RouterInput): Promise<RouterDecision> {
    this.inputs.push(input);
    return (
      this.#decisions.shift() ?? {
        action: "reply",
        replyKind: "chat",
        text: "好的。",
      }
    );
  }
}

describe("discussion-only guard", () => {
  it("classifies hypothetical, negated and discussion messages", () => {
    assert.equal(isDiscussionOnly("如果我们做这个方案，会有什么风险？"), true);
    assert.equal(isDiscussionOnly("假设预算只有一半，你会怎么排？"), true);
    assert.equal(isDiscussionOnly("咱们先讨论一下方案，不执行"), true);
    assert.equal(isDiscussionOnly("不要创建任务，先聊聊"), true);
    assert.equal(isDiscussionOnly("别帮我执行，我只是问问"), true);
    assert.equal(isDiscussionOnly("这个方案值不值得做？"), true);
  });

  it("does not classify concrete requests or explicit starts as discussion", () => {
    assert.equal(isDiscussionOnly("能不能帮我检查一下项目"), false);
    assert.equal(isDiscussionOnly("先讨论，然后开始执行"), false);
    assert.equal(isDiscussionOnly("如果没问题就开始执行这个方案"), false);
    assert.equal(isDiscussionOnly("帮我创建一个后台任务分析状态"), false);
  });
});

describe("router reply kinds", () => {
  it("parses only known kinds for action=reply", () => {
    const clarify = parseRouterDecision(
      JSON.stringify({ action: "reply", replyKind: "clarify", text: "请补充范围" }),
    );
    assert.equal(clarify?.replyKind, "clarify");

    const invalid = parseRouterDecision(
      JSON.stringify({ action: "reply", replyKind: "execute_now", text: "x" }),
    );
    assert.equal(invalid?.replyKind, undefined);

    const nonReply = parseRouterDecision(
      JSON.stringify({
        action: "create_task",
        replyKind: "plan_proposal",
        text: "ack",
        task: { goal: "g", completionCriteria: "c" },
      }),
    );
    assert.equal(nonReply?.replyKind, undefined);
  });

  it("stores clarify/chat/plan replies with non-ack purposes", async () => {
    const model = new StaticRouterModel();
    const services = createServices({ model });

    model.push({ action: "reply", replyKind: "clarify", text: "需要补充范围。" });
    await sendText(services, "帮我做个事情");
    const clarify = services.store
      .listRecentOutbox(5)
      .find((row) => row.text === "需要补充范围。");
    assert.equal(clarify?.purpose, "clarify");

    model.push({ action: "reply", replyKind: "plan_proposal", text: "三步方案。" });
    await sendText(services, "先给我一个方案");
    const plan = services.store
      .listRecentOutbox(5)
      .find((row) => row.text === "三步方案。");
    assert.equal(plan?.purpose, "result");
    assert.equal(taskCount(services), 0);
  });

  it("blocks create_task for a hypothetical even when the model proposes it", async () => {
    const model = new StaticRouterModel();
    const services = createServices({ model });
    model.push({
      action: "create_task",
      text: "已接单",
      task: { goal: "执行一个假设方案", completionCriteria: "完成" },
    });

    await sendText(services, "如果我们做这个方案，会有什么风险？");

    assert.equal(taskCount(services), 0);
    const reply = services.store
      .listRecentOutbox(5)
      .find((row) => row.purpose === "clarify");
    assert.match(reply?.text ?? "", /讨论或假设/);
  });

  it("still creates a task when the owner explicitly starts work", async () => {
    const model = new StaticRouterModel();
    const services = createServices({ model });
    model.push({
      action: "create_task",
      text: "已接单",
      task: { goal: "执行方案", completionCriteria: "完成" },
    });

    await sendText(services, "如果没问题就开始执行这个方案");

    assert.equal(taskCount(services), 1);
  });
});

describe("multi-turn conversation E1", () => {
  it("carries turns across messages, keeps tasks out of discussion, and isolates chats", async () => {
    const model = new RecordingRouterModel([
      { action: "reply", replyKind: "chat", text: "你好，我在。" },
      { action: "reply", replyKind: "plan_proposal", text: "第一步读代码，第二步核验，第三步汇报。" },
      { action: "reply", replyKind: "chat", text: "按刚才的三步方案，先不执行。" },
      {
        action: "create_task",
        text: "已接单",
        task: { goal: "检查项目证据", completionCriteria: "给出证据" },
      },
      { action: "reply", replyKind: "clarify", text: "需要指定哪个项目。" },
      { action: "reply", replyKind: "chat", text: "收到。" },
    ]);
    const services = createServices({ routerModel: model });

    await sendText(services, "你好", "evt_1");
    acceptPendingOutbox(services);
    await sendText(services, "先给我一个三步方案，先不执行", "evt_2");
    acceptPendingOutbox(services);
    await sendText(services, "按刚才的第二步再细化一下", "evt_3");
    acceptPendingOutbox(services);

    assert.equal(taskCount(services), 0);
    const third = model.inputs[2]?.conversationWindow;
    assert.deepEqual(
      third?.turns.map((turn) => [turn.role, turn.text]),
      [
        ["user", "你好"],
        ["assistant", "你好，我在。"],
        ["user", "先给我一个三步方案，先不执行"],
        ["assistant", "第一步读代码，第二步核验，第三步汇报。"],
      ],
    );

    await sendText(services, "开始执行这个方案", "evt_4");
    assert.equal(taskCount(services), 1);
    assert.ok(
      model.inputs[3]?.conversationWindow?.turns.some((turn) => /细化/.test(turn.text)),
    );

    await sendText(services, "补充：只读", "evt_5");
    await sendText(services, "继续", "evt_6");

    // A second chat with the same owner must not see the first chat.
    const second = services.store.upsertConversation({
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: services.conversation.accountId,
      platformConversationId: "oc_second",
      kind: "p2p",
      createdAt: services.now().toISOString(),
    });
    await services.ingress.accept(
      inbound({
        platformEventId: "evt_second",
        platformConversationId: second.platformConversationId,
        text: "这个会话的第一句",
      }),
    );
    await services.effectDispatcher.drain(200);
    const secondInput = model.inputs.at(-1);
    assert.equal(secondInput?.conversationId, second.id);
    assert.deepEqual(secondInput?.conversationWindow?.turns, []);
  });

  it("restores the window from the store after a restart", async () => {
    const firstModel = new RecordingRouterModel([
      { action: "reply", replyKind: "chat", text: "记住了。" },
    ]);
    const first = createServices({ routerModel: firstModel });
    await sendText(first, "记住我们在讨论方案", "evt_restart_1");
    acceptPendingOutbox(first);

    const secondModel = new RecordingRouterModel([
      { action: "reply", replyKind: "chat", text: "继续。" },
    ]);
    const restarted = createServices({ store: first.store, routerModel: secondModel });
    await sendText(restarted, "继续刚才的讨论", "evt_restart_2");

    assert.deepEqual(
      secondModel.inputs[0]?.conversationWindow?.turns.map((turn) => turn.text),
      ["记住我们在讨论方案", "记住了。"],
    );
  });
});
