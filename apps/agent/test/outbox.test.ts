import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeChannel, FakeChannelWithoutQuery } from "../src/channels/fake.ts";
import type { ChannelAdapter } from "../src/channels/adapter.ts";
import { OutboxDispatcher } from "../src/delivery/outbox.ts";
import type { OutboxRecord } from "../src/domain/types.ts";
import type { Store } from "../src/storage/store.ts";
import { APP_ID, createStore, toSendRequest } from "./helpers.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

interface Setup {
  store: Store;
  channel: ChannelAdapter;
  dispatcher: OutboxDispatcher;
  conversationId: string;
  now: () => Date;
  advance: (ms: number) => void;
  enqueue: (businessKey: string, createdAt?: Date, taskId?: string) => OutboxRecord;
}

function setup(channel: ChannelAdapter, maxAttempts = 5): Setup {
  const store = createStore();
  const owner = store.findOwner("feishu", APP_ID, "ou_owner");
  assert.ok(owner);

  const conversation = store.upsertConversation({
    ownerId: owner.id,
    channel: "feishu",
    accountId: APP_ID,
    platformConversationId: "oc_1",
    kind: "p2p",
    createdAt: START.toISOString(),
  });

  let current = START;
  const dispatcher = new OutboxDispatcher({
    store,
    channel,
    now: () => current,
    leaseMs: 1_000,
    maxAttempts,
    retryBaseMs: 1_000,
  });

  return {
    store,
    channel,
    dispatcher,
    conversationId: conversation.id,
    now: () => current,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    enqueue(businessKey, createdAt = current, taskId) {
      return store.enqueueOutbox({
        businessKey,
        ownerId: owner.id,
        channel: "feishu",
        accountId: APP_ID,
        conversationId: conversation.id,
        taskId,
        purpose: "ack",
        text: `text-${businessKey}`,
        createdAt: createdAt.toISOString(),
      }).record;
    },
  };
}

describe("outbox delivery and recovery", () => {
  it("delivers one persisted message and records the platform message id", async () => {
    const channel = new FakeChannel();
    const context = setup(channel);
    const row = context.enqueue("biz-1");

    const result = await context.dispatcher.drain();

    assert.equal(result.accepted, 1);
    assert.equal(channel.sent.length, 1);
    const stored = context.store.getOutboxByBusinessKey("biz-1");
    assert.equal(stored?.status, "accepted");
    assert.equal(stored?.platformMessageId, "fake-message-1");
    assert.equal(stored?.attempts, 1);
    assert.equal(row.status, "pending");
    context.store.close();
  });

  it("keeps one outbox row and one send for a repeated business key", async () => {
    const channel = new FakeChannel();
    const context = setup(channel);

    context.enqueue("biz-repeat");
    context.enqueue("biz-repeat");
    await context.dispatcher.drain();
    await context.dispatcher.drain();

    assert.equal(channel.sent.length, 1);
    assert.equal(context.store.countOutbox("accepted"), 1);
    context.store.close();
  });

  it("reconciles a crash after the platform accepted the message without sending again", async () => {
    const channel = new FakeChannel();
    const context = setup(channel);
    context.enqueue("biz-crash");

    const claimed = context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    assert.ok(claimed);
    await channel.send(toSendRequest(claimed));

    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.accepted, 1);
    assert.equal(result.reconciled, 1);
    assert.equal(channel.sent.length, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-crash")?.status, "accepted");
    context.store.close();
  });

  it("records unknown instead of retrying when the channel cannot query an interrupted send", async () => {
    const channel = new FakeChannelWithoutQuery();
    const context = setup(channel);
    context.enqueue("biz-no-query");

    const claimed = context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    assert.ok(claimed);

    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.unknown, 1);
    assert.equal(channel.sent.length, 0);
    assert.equal(context.store.getOutboxByBusinessKey("biz-no-query")?.status, "unknown");
    context.store.close();
  });

  it("turns a no-query unknown into needs_manual after the retry budget", async () => {
    const channel = new FakeChannelWithoutQuery();
    const context = setup(channel, 1);
    context.enqueue("biz-manual");

    context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.manual, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-manual")?.status, "needs_manual");
    context.store.close();
  });

  it("reconciles a timeout after the platform actually accepted the message", async () => {
    const channel = new FakeChannel();
    channel.failure = "unknown";
    const context = setup(channel);
    context.enqueue("biz-timeout");

    const first = await context.dispatcher.drain();
    assert.equal(first.unknown, 1);
    assert.equal(channel.sent.length, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-timeout")?.status, "unknown");

    context.advance(1_001);
    const second = await context.dispatcher.drain();

    assert.equal(second.accepted, 1);
    assert.equal(channel.sent.length, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-timeout")?.status, "accepted");
    context.store.close();
  });

  it("retries a retryable platform rejection", async () => {
    const channel = new FakeChannel();
    channel.failure = "retryable";
    const context = setup(channel);
    context.enqueue("biz-retry");

    const first = await context.dispatcher.drain();
    assert.equal(first.retried, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-retry")?.status, "pending");

    context.advance(1_001);
    const second = await context.dispatcher.drain();
    assert.equal(second.accepted, 1);
    assert.equal(channel.sent.length, 1);
    context.store.close();
  });

  it("fails a non-retryable platform rejection", async () => {
    const channel = new FakeChannel();
    channel.failure = "fatal";
    const context = setup(channel);
    context.enqueue("biz-fatal");

    const result = await context.dispatcher.drain();

    assert.equal(result.failed, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-fatal")?.status, "failed");
    context.store.close();
  });

  it("does not let a later message overtake a delayed earlier message in the same conversation", async () => {
    const channel = new FakeChannel();
    const context = setup(channel);
    context.enqueue("biz-delayed");
    context.enqueue("biz-later", new Date(START.getTime() + 1));

    channel.failure = "retryable";
    const first = await context.dispatcher.drain();
    assert.equal(first.retried, 1);
    assert.equal(channel.sent.length, 0);

    const second = await context.dispatcher.drain();
    assert.equal(second.accepted, 0);
    assert.equal(channel.sent.length, 0);

    context.advance(1_001);
    await context.dispatcher.drain(1);
    assert.deepEqual(
      channel.sent.map((message) => message.businessKey),
      ["biz-delayed"],
    );
    context.store.close();
  });

  it("preserves enqueue order across drains", async () => {
    const channel = new FakeChannel();
    const context = setup(channel);
    context.enqueue("biz-first");
    context.enqueue("biz-second", new Date(START.getTime() + 1_000));

    await context.dispatcher.drain(1);
    assert.deepEqual(
      channel.sent.map((message) => message.businessKey),
      ["biz-first"],
    );

    context.advance(1_000);
    await context.dispatcher.drain(1);
    assert.deepEqual(
      channel.sent.map((message) => message.businessKey),
      ["biz-first", "biz-second"],
    );
    context.store.close();
  });

  it("does not block another task behind a needs_manual message in the same conversation", async () => {
    const channel = new FakeChannelWithoutQuery();
    const context = setup(channel, 1);
    context.enqueue("biz-task-a", START, "task-a");
    context.enqueue("biz-task-b", new Date(START.getTime() + 1), "task-b");

    const claimed = context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    assert.equal(claimed?.businessKey, "biz-task-a");

    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.manual, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-task-a")?.status, "needs_manual");
    assert.deepEqual(
      channel.sent.map((message) => message.businessKey),
      ["biz-task-b"],
    );
    assert.equal(context.store.getOutboxByBusinessKey("biz-task-b")?.status, "accepted");
    context.store.close();
  });

  it("does not block another task behind an unknown message in the same conversation", async () => {
    const channel = new FakeChannelWithoutQuery();
    const context = setup(channel);
    context.enqueue("biz-unknown-a", START, "task-a");
    context.enqueue("biz-unknown-b", new Date(START.getTime() + 1), "task-b");

    const claimed = context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    assert.equal(claimed?.businessKey, "biz-unknown-a");

    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.unknown, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-unknown-a")?.status, "unknown");
    assert.deepEqual(
      channel.sent.map((message) => message.businessKey),
      ["biz-unknown-b"],
    );
    assert.equal(context.store.getOutboxByBusinessKey("biz-unknown-b")?.status, "accepted");
    context.store.close();
  });

  it("keeps blocking later messages for the same task behind an unknown earlier message", async () => {
    const channel = new FakeChannelWithoutQuery();
    const context = setup(channel);
    context.enqueue("biz-group-first", START, "task-a");
    context.enqueue("biz-group-second", new Date(START.getTime() + 1), "task-a");

    const claimed = context.store.claimNextOutbox(
      context.now().toISOString(),
      new Date(context.now().getTime() + 1_000).toISOString(),
    );
    assert.equal(claimed?.businessKey, "biz-group-first");

    context.advance(1_001);
    const result = await context.dispatcher.drain();

    assert.equal(result.unknown, 1);
    assert.equal(context.store.getOutboxByBusinessKey("biz-group-first")?.status, "unknown");
    assert.equal(context.store.getOutboxByBusinessKey("biz-group-second")?.status, "pending");
    assert.equal(channel.sent.length, 0);
    context.store.close();
  });
});
