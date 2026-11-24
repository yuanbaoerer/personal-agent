import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { describe, it, type TestContext } from "node:test";

import { CodingRelay } from "../src/coding/relay.ts";
import type {
  ActorType,
  ChatType,
  InboxRecord,
  InboxStatus,
} from "../src/domain/types.ts";
import { APP_ID, OWNER_OPEN_ID, createStore } from "./helpers.ts";

const TEST_TIMEOUT = { timeout: 5_000 };
const START = new Date("2026-01-01T00:00:00.000Z");
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

function ownerOf(store: ReturnType<typeof createStore>) {
  const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
  assert.ok(owner);
  return owner;
}

function conversationFor(
  store: ReturnType<typeof createStore>,
  platformConversationId = "oc_1",
  kind: ChatType = "p2p",
) {
  return store.upsertConversation({
    ownerId: ownerOf(store).id,
    channel: "feishu",
    accountId: APP_ID,
    platformConversationId,
    kind,
    createdAt: START.toISOString(),
  });
}

interface EventOptions {
  text?: string;
  id?: string;
  chatType?: ChatType;
  actorType?: ActorType;
  status?: InboxStatus;
  actorId?: string;
  platform?: string;
  conversationId?: string;
}

function eventFor(
  store: ReturnType<typeof createStore>,
  options: EventOptions = {},
): InboxRecord {
  const id = options.id ?? nextId("inbox");
  const platform = options.platform ?? "oc_1";
  const conversationId =
    options.conversationId ?? conversationFor(store, platform).id;
  return {
    id,
    channel: "feishu",
    accountId: APP_ID,
    platformEventId: `evt_${id}`,
    ownerId: ownerOf(store).id,
    conversationId,
    platformConversationId: platform,
    actorId: options.actorId ?? OWNER_OPEN_ID,
    actorType: options.actorType ?? "user",
    eventType: "im.message.receive_v1",
    chatType: options.chatType ?? "p2p",
    text: options.text ?? "",
    status: options.status ?? "accepted",
    receivedAt: START.toISOString(),
    traceId: `trace_${id}`,
  };
}

interface FrameWaiter {
  resolve: (frame: unknown) => void;
  reject: (error: Error) => void;
}

class TestClient {
  readonly socket: Socket;
  #buffer = "";
  #frames: unknown[] = [];
  #waiters: FrameWaiter[] = [];
  #closed = false;
  #closeWaiters: Array<() => void> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: Buffer | string) => {
      this.#buffer +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim().length === 0) {
          continue;
        }
        try {
          this.#push(JSON.parse(line) as unknown);
        } catch {
          // The relay only writes JSON frames.
        }
      }
    });
    socket.on("error", () => this.#markClosed());
    socket.on("close", () => this.#markClosed());
  }

  static open(socketPath: string): Promise<TestClient> {
    const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
    const socket = createConnection(socketPath);
    const client = new TestClient(socket);
    socket.once("connect", () => resolve(client));
    socket.once("error", reject);
    return promise;
  }

  send(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(data: string): void {
    this.socket.write(data);
  }

  next(): Promise<unknown> {
    const frame = this.#frames.shift();
    if (frame !== undefined) {
      return Promise.resolve(frame);
    }
    if (this.#closed) {
      return Promise.reject(new Error("socket closed"));
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#waiters.push({ resolve, reject });
    return promise;
  }

  pendingFrames(): number {
    return this.#frames.length;
  }

  waitClosed(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#closeWaiters.push(resolve);
    return promise;
  }

  close(): void {
    this.socket.destroy();
  }

  #push(frame: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(frame);
      return;
    }
    this.#frames.push(frame);
  }

  #markClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error("socket closed"));
    }
    for (const resolve of this.#closeWaiters.splice(0)) {
      resolve();
    }
  }
}

function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Yield through the I/O phases until the relay has persisted the row. */
async function waitFor<T>(
  read: () => T | undefined,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await tick();
  }
  throw new Error(`timeout waiting for ${label}`);
}

function outbox(
  store: ReturnType<typeof createStore>,
  inboxId: string,
  suffix: string,
) {
  return store.getOutboxByBusinessKey(`coding:inbox:${inboxId}:${suffix}`);
}

async function waitOutbox(
  store: ReturnType<typeof createStore>,
  inboxId: string,
  suffix: string,
) {
  return waitFor(
    () => outbox(store, inboxId, suffix),
    `outbox coding:inbox:${inboxId}:${suffix}`,
  );
}

interface Context {
  store: ReturnType<typeof createStore>;
  relay: CodingRelay;
  socketPath: string;
  event: (options?: EventOptions) => InboxRecord;
  track: (relay: CodingRelay) => void;
}

function createContext(t: TestContext, now?: () => Date): Context {
  const store = createStore();
  const dir = mkdtempSync(join(tmpdir(), "pa-relay-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "relay.sock");
  const relay = new CodingRelay(store, now === undefined ? {} : { now });
  const relays = [relay];
  t.after(() => {
    for (const item of relays.reverse()) {
      item.close();
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    relay,
    socketPath,
    event: (options = {}) => eventFor(store, options),
    track: (item) => {
      relays.push(item);
    },
  };
}

async function pair(
  relay: CodingRelay,
  client: TestClient,
  store: ReturnType<typeof createStore>,
  workspace = "/Users/alice/private/project-x",
): Promise<{ code: string; pairEvent: InboxRecord }> {
  client.send({ type: "hello", workspace });
  const offer = (await client.next()) as { type: string; code: string };
  assert.equal(offer.type, "offer");
  assert.match(offer.code, /^[A-HJ-NP-Z2-9]{10}$/);
  const pairEvent = eventFor(store, {
    text: `/code pair ${offer.code.toLowerCase()}`,
  });
  assert.deepEqual(relay.handle(pairEvent), []);
  assert.deepEqual(await client.next(), { type: "paired" });
  return { code: offer.code, pairEvent };
}

describe("CodingRelay", { skip: process.platform === "win32" && "POSIX socket permissions required" }, () => {
  it("consumes only accepted owner P2P messages and reserves /code", async (t) => {
    const ctx = createContext(t);

    const ineligible = [
      ctx.event({ text: "hi", chatType: "group" }),
      ctx.event({ text: "/code", actorType: "app" }),
      ctx.event({ text: "hi", status: "rejected" }),
      ctx.event({ text: "hi", actorId: "ou_someone_else" }),
    ];
    for (const event of ineligible) {
      assert.equal(ctx.relay.handle(event), undefined);
      assert.equal(ctx.store.metaGet(`coding:inbox:${event.id}`), undefined);
    }

    const plain = ctx.event({ text: "hello there" });
    assert.equal(ctx.relay.handle(plain), undefined);
    assert.equal(ctx.store.metaGet(`coding:inbox:${plain.id}`), undefined);

    const help = ctx.event({ text: "/code", id: "help_1" });
    assert.deepEqual(ctx.relay.handle(help), []);
    assert.equal(ctx.store.metaGet("coding:inbox:help_1"), "code:help");
    const reply = ctx.store.getOutboxByBusinessKey("coding:inbox:help_1:help");
    assert.ok(reply);
    assert.equal(reply.purpose, "status");
    assert.equal(reply.traceId, "coding:inbox:help_1");
    assert.match(reply.text, /\/code pair/);
  });

  it("pairs over a private socket and relays one turn with bounded progress", TEST_TIMEOUT, async (t) => {
    const ctx = createContext(t);
    await ctx.relay.listen(ctx.socketPath);
    const client = await TestClient.open(ctx.socketPath);
    t.after(() => client.close());

    const { pairEvent } = await pair(ctx.relay, client, ctx.store);
    const ack = await waitOutbox(ctx.store, pairEvent.id, "pair-ok");
    assert.match(ack.text, /project-x/);
    assert.doesNotMatch(ack.text, /\/Users\/alice/);

    const coreCommand = ctx.event({ id: "core_status", text: "/status" });
    assert.equal(ctx.relay.handle(coreCommand), undefined);
    assert.equal(
      ctx.store.metaGet(`coding:inbox:${coreCommand.id}`),
      undefined,
    );
    assert.equal(client.pendingFrames(), 0);

    const promptEvent = ctx.event({
      id: "prompt_a",
      text: "fix the failing tests",
    });
    assert.deepEqual(ctx.relay.handle(promptEvent), []);
    assert.deepEqual(await client.next(), {
      type: "prompt",
      id: "prompt_a",
      text: "fix the failing tests",
    });
    assert.equal(ctx.store.metaGet("coding:inbox:prompt_a"), "prompt");

    const busy = ctx.event({ id: "busy_a", text: "second" });
    assert.deepEqual(ctx.relay.handle(busy), []);
    assert.ok(await waitOutbox(ctx.store, "busy_a", "busy"));
    assert.equal(client.pendingFrames(), 0);

    client.send({ type: "progress", id: "other_prompt", text: "should drop" });
    client.send({ type: "progress", id: "prompt_a", text: "reading files" });
    await waitOutbox(ctx.store, "prompt_a", "progress:1");
    assert.equal(
      ctx.store.getOutboxByBusinessKey(
        "coding:inbox:other_prompt:progress:1",
      ),
      undefined,
    );

    client.send({
      type: "progress",
      id: "prompt_a",
      text: `read package.json\n${"x".repeat(1_000)}\u0000`,
    });
    const progress = await waitOutbox(ctx.store, "prompt_a", "progress:2");
    assert.equal(progress.purpose, "status");
    assert.equal(progress.traceId, "coding:inbox:prompt_a");
    assert.ok(progress.text.length <= 500);
    assert.doesNotMatch(progress.text, /[\u0000-\u001f\u007f]/);

    client.send({ type: "result", id: "other_prompt", text: "wrong turn" });
    client.send({
      type: "result",
      id: "prompt_a",
      text: "Done.\n\n\n\nAll tests pass.\u0000",
    });
    const result = await waitOutbox(ctx.store, "prompt_a", "result");
    assert.equal(result.purpose, "result");
    assert.match(result.text, /All tests pass\./);
    assert.doesNotMatch(result.text, /\u0000/);
    assert.equal(outbox(ctx.store, "other_prompt", "result"), undefined);

    const next = ctx.event({ id: "prompt_b", text: "next" });
    assert.deepEqual(ctx.relay.handle(next), []);
    assert.deepEqual(await client.next(), {
      type: "prompt",
      id: "prompt_b",
      text: "next",
    });
  });

  it("fails closed while disconnected and after a host restart without a socket", TEST_TIMEOUT, async (t) => {
    const ctx = createContext(t);
    await ctx.relay.listen(ctx.socketPath);
    const client = await TestClient.open(ctx.socketPath);
    await pair(ctx.relay, client, ctx.store);

    const prompt = ctx.event({ id: "prompt_disconnect", text: "run it" });
    assert.deepEqual(ctx.relay.handle(prompt), []);
    await client.next();
    client.close();

    const unknown = await waitOutbox(
      ctx.store,
      "prompt_disconnect",
      "disconnect",
    );
    assert.equal(unknown.purpose, "failure");
    assert.match(unknown.text, /结果未知/);

    const offline = ctx.event({ id: "offline_1", text: "still there?" });
    assert.deepEqual(ctx.relay.handle(offline), []);
    const offlineReply = await waitOutbox(ctx.store, "offline_1", "offline");
    assert.match(offlineReply.text, /未转发/);
    assert.equal(offlineReply.traceId, "coding:inbox:offline_1");

    ctx.relay.close();
    const restarted = new CodingRelay(ctx.store);
    ctx.track(restarted);

    const afterRestart = ctx.event({ id: "offline_2", text: "you there?" });
    assert.deepEqual(restarted.handle(afterRestart), []);
    const afterRestartReply = await waitOutbox(
      ctx.store,
      "offline_2",
      "offline",
    );
    assert.match(afterRestartReply.text, /未转发/);

    const status = ctx.event({ id: "status_restart", text: "/code status" });
    assert.deepEqual(restarted.handle(status), []);
    const statusReply = await waitOutbox(ctx.store, "status_restart", "status");
    assert.match(statusReply.text, /PA_CODING_SOCKET/);
    assert.match(statusReply.text, /project-x/);

    const stillBlocked = ctx.event({ id: "offline_3", text: "general chat?" });
    assert.deepEqual(restarted.handle(stillBlocked), []);

    const leave = ctx.event({ id: "leave_restart", text: "/code leave" });
    assert.deepEqual(restarted.handle(leave), []);
    assert.ok(await waitOutbox(ctx.store, "leave_restart", "leave-ok"));
    assert.equal(ctx.store.metaGet("coding:pair"), undefined);

    const free = ctx.event({ id: "free_after_leave", text: "hello again" });
    assert.equal(restarted.handle(free), undefined);
  });

  it("allows one client, rejects bad hello, and bounds frames", TEST_TIMEOUT, async (t) => {
    const ctx = createContext(t);
    await ctx.relay.listen(ctx.socketPath);

    const first = await TestClient.open(ctx.socketPath);
    first.send({ type: "hello", workspace: "/home/alice/private/proj-y" });
    const offer = (await first.next()) as { type: string; code: string };
    assert.equal(offer.type, "offer");

    const second = await TestClient.open(ctx.socketPath);
    t.after(() => second.close());
    await second.waitClosed();

    first.sendRaw("x".repeat(70_000));
    await first.waitClosed();

    const third = await TestClient.open(ctx.socketPath);
    t.after(() => third.close());
    third.send({ type: "hello", workspace: "/home/alice/proj-z" });
    const nextOffer = (await third.next()) as { type: string; code: string };
    assert.equal(nextOffer.type, "offer");
    third.close();
    await third.waitClosed();

    const bad = await TestClient.open(ctx.socketPath);
    t.after(() => bad.close());
    bad.send({ type: "hello", workspace: ".." });
    await bad.waitClosed();
  });

  it("expires offers and blocks repeated wrong codes", TEST_TIMEOUT, async (t) => {
    let current = new Date(START);
    const ctx = createContext(t, () => current);
    await ctx.relay.listen(ctx.socketPath);

    const first = await TestClient.open(ctx.socketPath);
    t.after(() => first.close());
    first.send({ type: "hello", workspace: "/tmp/private/project" });
    const offer = (await first.next()) as { type: string; code: string };
    current = new Date(current.getTime() + 5 * 60_000 + 1);

    const expired = ctx.event({
      id: "pair_expired",
      text: `/code pair ${offer.code}`,
    });
    assert.deepEqual(ctx.relay.handle(expired), []);
    const expiredReply = await waitOutbox(ctx.store, "pair_expired", "pair-expired");
    assert.match(expiredReply.text, /过期/);
    await first.waitClosed();
    assert.equal(ctx.store.metaGet("coding:pair"), undefined);

    const second = await TestClient.open(ctx.socketPath);
    t.after(() => second.close());
    second.send({ type: "hello", workspace: "/tmp/private/project" });
    const secondOffer = (await second.next()) as { type: string; code: string };
    const wrongCode =
      secondOffer.code === "ZZZZZZZZZZ" ? "YYYYYYYYYY" : "ZZZZZZZZZZ";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const wrong = ctx.event({
        id: `pair_wrong_${attempt}`,
        text: `/code pair ${wrongCode}`,
      });
      assert.deepEqual(ctx.relay.handle(wrong), []);
    }
    assert.ok(await waitOutbox(ctx.store, "pair_wrong_5", "pair-attempts"));
    await second.waitClosed();
    assert.equal(ctx.store.metaGet("coding:pair"), undefined);
  });

  it("requires the paired owner conversation for one-shot approvals", TEST_TIMEOUT, async (t) => {
    let current = new Date(START);
    const ctx = createContext(t, () => current);
    await ctx.relay.listen(ctx.socketPath);
    const client = await TestClient.open(ctx.socketPath);
    t.after(() => client.close());
    await pair(ctx.relay, client, ctx.store);

    const prompt = ctx.event({ id: "prompt_appr", text: "change files" });
    assert.deepEqual(ctx.relay.handle(prompt), []);
    await client.next();

    const nonceA = "a".repeat(32);
    client.send({
      type: "approval",
      id: "prompt_appr",
      nonce: nonceA,
      text: "Bash: rm -rf /tmp/x\n\u0000details",
    });
    const approval = await waitOutbox(
      ctx.store,
      "prompt_appr",
      `approval:${nonceA}`,
    );
    assert.equal(approval.purpose, "approval");
    assert.match(approval.text, new RegExp(nonceA));
    assert.match(approval.text, /允许：\/code allow/);
    assert.doesNotMatch(approval.text, /\u0000/);

    const nonceB = "b".repeat(32);
    client.send({
      type: "approval",
      id: "prompt_appr",
      nonce: nonceB,
      text: "second pending must be ignored",
    });
    client.send({ type: "progress", id: "prompt_appr", text: "barrier" });
    await waitOutbox(ctx.store, "prompt_appr", "progress:1");
    assert.equal(
      outbox(ctx.store, "prompt_appr", `approval:${nonceB}`),
      undefined,
    );

    const otherConversation = conversationFor(ctx.store, "oc_2");
    const foreign = ctx.event({
      id: "allow_foreign",
      text: `/code allow ${nonceA}`,
      platform: "oc_2",
      conversationId: otherConversation.id,
    });
    assert.deepEqual(ctx.relay.handle(foreign), []);
    assert.ok(await waitOutbox(ctx.store, "allow_foreign", "decision-scope"));
    assert.equal(client.pendingFrames(), 0);

    const wrong = ctx.event({
      id: "deny_wrong",
      text: `/code deny ${"c".repeat(32)}`,
    });
    assert.deepEqual(ctx.relay.handle(wrong), []);
    assert.ok(await waitOutbox(ctx.store, "deny_wrong", "decision-mismatch"));
    assert.equal(client.pendingFrames(), 0);

    const allow = ctx.event({ id: "allow_a", text: `/code allow ${nonceA}` });
    assert.deepEqual(ctx.relay.handle(allow), []);
    assert.deepEqual(await client.next(), {
      type: "decision",
      id: "prompt_appr",
      nonce: nonceA,
      allow: true,
    });
    assert.ok(await waitOutbox(ctx.store, "allow_a", "decision-allow"));

    const duplicate = ctx.event({
      id: "allow_duplicate",
      text: `/code allow ${nonceA}`,
    });
    assert.deepEqual(ctx.relay.handle(duplicate), []);
    assert.ok(await waitOutbox(ctx.store, "allow_duplicate", "decision-none"));
    assert.equal(client.pendingFrames(), 0);

    const nonceC = "c".repeat(32);
    client.send({
      type: "approval",
      id: "prompt_appr",
      nonce: nonceC,
      text: "third approval",
    });
    await waitOutbox(ctx.store, "prompt_appr", `approval:${nonceC}`);
    current = new Date(current.getTime() + 60_000);
    const expired = ctx.event({
      id: "allow_expired",
      text: `/code allow ${nonceC}`,
    });
    assert.deepEqual(ctx.relay.handle(expired), []);
    assert.ok(await waitOutbox(ctx.store, "allow_expired", "decision-expired"));
    assert.equal(client.pendingFrames(), 0);

    const nonceD = "d".repeat(32);
    client.send({
      type: "approval",
      id: "prompt_appr",
      nonce: nonceD,
      text: "fourth approval",
    });
    await waitOutbox(ctx.store, "prompt_appr", `approval:${nonceD}`);
    const stop = ctx.event({ id: "stop_appr", text: "/code stop" });
    assert.deepEqual(ctx.relay.handle(stop), []);
    assert.deepEqual(await client.next(), { type: "stop", id: "prompt_appr" });
    assert.ok(await waitOutbox(ctx.store, "stop_appr", "stop-ok"));

    const afterStop = ctx.event({
      id: "allow_after_stop",
      text: `/code allow ${nonceD}`,
    });
    assert.deepEqual(ctx.relay.handle(afterStop), []);
    assert.ok(
      await waitOutbox(ctx.store, "allow_after_stop", "decision-idle"),
    );
    assert.equal(client.pendingFrames(), 0);
  });

  it("never replays a forwarded prompt after a crash or re-pair", TEST_TIMEOUT, async (t) => {
    const ctx = createContext(t);
    await ctx.relay.listen(ctx.socketPath);
    const first = await TestClient.open(ctx.socketPath);
    t.after(() => first.close());
    await pair(ctx.relay, first, ctx.store);

    const prompt = ctx.event({
      id: "prompt_crash",
      text: "write the fix",
    });
    assert.deepEqual(ctx.relay.handle(prompt), []);
    await first.next();
    ctx.relay.close();

    const restarted = new CodingRelay(ctx.store);
    ctx.track(restarted);
    assert.deepEqual(restarted.handle(prompt), []);
    const unknown = await waitOutbox(ctx.store, "prompt_crash", "unknown");
    assert.match(unknown.text, /无法确认/);

    const stale = { ...ctx.event({ text: "old workspace request" }), occurredAt: "2025-12-31T23:59:59.000Z" };
    await restarted.listen(ctx.socketPath);
    const second = await TestClient.open(ctx.socketPath);
    t.after(() => second.close());
    await pair(restarted, second, ctx.store, "/tmp/private/other");

    assert.deepEqual(restarted.handle(prompt), []);
    assert.equal(second.pendingFrames(), 0);
    assert.deepEqual(restarted.handle(stale), []);
    assert.ok(await waitOutbox(ctx.store, stale.id, "stale"));
    assert.equal(
      ctx.store
        .listRecentOutbox(50)
        .filter((row) => row.businessKey === "coding:inbox:prompt_crash:unknown")
        .length,
      1,
    );
  });

  it("fails closed on a corrupt persisted pairing and can reset it", async (t) => {
    const store = createStore();
    store.metaSet("coding:pair", "{not-json");
    const relay = new CodingRelay(store);
    t.after(() => {
      relay.close();
      store.close();
    });

    const blocked = eventFor(store, { id: "corrupt_1", text: "hello" });
    assert.deepEqual(relay.handle(blocked), []);
    const reply = store.getOutboxByBusinessKey("coding:inbox:corrupt_1:corrupt");
    assert.ok(reply);
    assert.match(reply.text, /无法读取/);

    const leave = eventFor(store, { id: "corrupt_leave", text: "/code leave" });
    assert.deepEqual(relay.handle(leave), []);
    assert.equal(store.metaGet("coding:pair"), undefined);

    const free = eventFor(store, { id: "corrupt_free", text: "normal chat" });
    assert.equal(relay.handle(free), undefined);
  });

  it("refuses insecure socket paths without deleting them", async (t) => {
    const store = createStore();
    const dir = mkdtempSync(join(tmpdir(), "pa-relay-"));
    const socketPath = join(dir, "relay.sock");
    const relay = new CodingRelay(store);
    t.after(() => {
      relay.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    chmodSync(dir, 0o755);
    await assert.rejects(relay.listen(socketPath), /private/);

    chmodSync(dir, 0o700);
    writeFileSync(socketPath, "not a socket");
    await assert.rejects(relay.listen(socketPath), /non-socket/);
    assert.equal(lstatSync(socketPath).isFile(), true);
    rmSync(socketPath);

    const target = join(dir, "target");
    writeFileSync(target, "target");
    symlinkSync(target, socketPath);
    await assert.rejects(relay.listen(socketPath), /symlink/);
    assert.equal(lstatSync(socketPath).isSymbolicLink(), true);
    rmSync(socketPath);

    await assert.rejects(relay.listen("relative.sock"), /absolute/);
  });
});
