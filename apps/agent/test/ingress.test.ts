import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IngressService } from "../src/coordinator/ingress.ts";
import { CommandResponder } from "../src/coordinator/responder.ts";
import type { InboxRecord, ReplyDraft } from "../src/domain/types.ts";
import type { InboundHandler } from "../src/coordinator/responder.ts";
import type { Store } from "../src/storage/store.ts";
import { createStore, inbound } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

class FailOnceHandler implements InboundHandler {
  calls = 0;

  async handle(): Promise<ReplyDraft[]> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error("process interrupted after inbox commit");
    }
    return [{ purpose: "ack", text: "recovered" }];
  }
}

function setup(handler: InboundHandler = new CommandResponder()): {
  store: Store;
  ingress: IngressService;
} {
  const store = createStore();
  const ingress = new IngressService({ store, handler, now: () => NOW });
  return { store, ingress };
}

describe("inbound identity and inbox", () => {
  it("accepts one bound owner p2p event and queues one acknowledgement", async () => {
    const { store, ingress } = setup();
    const result = await ingress.accept(inbound());

    assert.equal(result.outcome, "accepted");
    assert.equal(store.countInbox("accepted"), 1);
    assert.equal(store.countOutbox("pending"), 1);

    const reply = store.getOutboxByBusinessKey(`inbox:${result.inboxId}:reply:0`);
    assert.equal(reply?.purpose, "ack");
    assert.equal(reply?.text, "已收到。");
    assert.equal(store.listPendingInbox(10).length, 0);
    store.close();
  });

  it("deduplicates the same platform event into one inbox row and one reply", async () => {
    const { store, ingress } = setup();
    const first = await ingress.accept(inbound({ platformEventId: "evt_same" }));
    const second = await ingress.accept(
      inbound({ platformEventId: "evt_same", text: "edited text" }),
    );

    assert.equal(first.outcome, "accepted");
    assert.equal(second.outcome, "duplicate");
    assert.equal(store.countInbox("accepted"), 1);
    assert.equal(store.countOutbox("pending"), 1);
    store.close();
  });

  it("rejects an unbound sender without creating a task or a reply", async () => {
    const { store, ingress } = setup();
    const result = await ingress.accept(
      inbound({ actorId: "ou_stranger", platformEventId: "evt_stranger" }),
    );

    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "actor_not_bound");
    assert.equal(store.countInbox("rejected"), 1);
    assert.equal(store.countOutbox("pending"), 0);
    store.close();
  });

  it("rejects group messages, app senders, and unbound actors", async () => {
    const { store, ingress } = setup();

    await ingress.accept(inbound({ chatType: "group", platformEventId: "evt_group" }));
    await ingress.accept(
      inbound({ actorType: "app", platformEventId: "evt_app" }),
    );
    await ingress.accept(
      inbound({ actorId: "ou_other", platformEventId: "evt_other" }),
    );

    assert.equal(store.countInbox("rejected"), 3);
    assert.equal(store.countOutbox("pending"), 0);
    store.close();
  });

  it("recovers an accepted inbox row after the handler crashes before enqueueing a reply", async () => {
    const handler = new FailOnceHandler();
    const { store, ingress } = setup(handler);

    await assert.rejects(ingress.accept(inbound({ platformEventId: "evt_crash" })), {
      message: "process interrupted after inbox commit",
    });
    assert.equal(store.countInbox("accepted"), 1);
    assert.equal(store.countOutbox("pending"), 0);

    const recovered = await ingress.recoverPending(10);
    assert.equal(recovered, 1);
    assert.equal(store.countOutbox("pending"), 1);
    assert.equal(store.listPendingInbox(10).length, 0);

    await ingress.recoverPending(10);
    assert.equal(store.countOutbox("pending"), 1);
    store.close();
  });

  it("answers a status command through the deterministic path", async () => {
    const { store, ingress } = setup();
    const result = await ingress.accept(
      inbound({ platformEventId: "evt_status", text: "/status" }),
    );

    const reply = store.getOutboxByBusinessKey(`inbox:${result.inboxId}:reply:0`);
    assert.equal(reply?.purpose, "status");
    assert.match(reply?.text ?? "", /服务运行中/);
    store.close();
  });
});

describe("outbox recovery seam", () => {
  it("keeps the inbox row but processes it later when the first handler call fails", async () => {
    const calls: InboxRecord[] = [];
    const handler: InboundHandler = {
      async handle(event: InboxRecord): Promise<ReplyDraft[]> {
        calls.push(event);
        return [{ purpose: "ack", text: "ok" }];
      },
    };
    const { store, ingress } = setup(handler);

    await ingress.accept(inbound({ platformEventId: "evt_once" }));
    await ingress.accept(inbound({ platformEventId: "evt_once" }));

    assert.equal(calls.length, 1);
    store.close();
  });
});
