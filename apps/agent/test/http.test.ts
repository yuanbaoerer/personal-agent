import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import type { FeishuConfig } from "../src/channels/feishu/types.ts";
import { IngressService } from "../src/coordinator/ingress.ts";
import { CommandResponder } from "../src/coordinator/responder.ts";
import { createHttpServer, type AppLogger } from "../src/server.ts";
import { createStore } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const TOKEN = "verification-token";

const quietLogger: AppLogger = {
  info() {},
  error() {},
};

const config: FeishuConfig = {
  appId: "app_1",
  appSecret: "app-secret",
  verificationToken: TOKEN,
  accountId: "app_1",
};

function messagePayload(openId = "ou_owner", eventId = "evt_http_1"): string {
  return JSON.stringify({
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      token: TOKEN,
      app_id: "app_1",
      create_time: "1767225600000",
    },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: `om_${eventId}`,
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1767225600000",
      },
    },
  });
}

async function startServer(feishu: FeishuAdapter) {
  const store = createStore();
  const ingress = new IngressService({
    store,
    handler: new CommandResponder(),
    now: () => NOW,
  });
  const server = createHttpServer({ feishu, ingress, logger: quietLogger });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      store.close();
    },
  };
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("Feishu webhook HTTP seam", () => {
  it("answers health checks", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const response = await fetch(`${app.url}/healthz`);

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    await app.close();
  });

  it("answers the URL verification challenge without creating inbox work", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const response = await post(
      `${app.url}/webhooks/feishu`,
      JSON.stringify({ type: "url_verification", challenge: "challenge-1", token: TOKEN }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: "challenge-1" });
    assert.equal(app.store.countInbox("accepted"), 0);
    await app.close();
  });

  it("accepts a bound owner event and deduplicates a platform retry", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const body = messagePayload();

    const first = await post(`${app.url}/webhooks/feishu`, body);
    const second = await post(`${app.url}/webhooks/feishu`, body);

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { status: "accepted" });
    assert.deepEqual(await second.json(), { status: "duplicate" });
    assert.equal(app.store.countInbox("accepted"), 1);
    assert.equal(app.store.countOutbox("pending"), 1);
    await app.close();
  });

  it("deduplicates repeated Feishu pushes even when event_id changes", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const first = messagePayload();
    const second = messagePayload();
    const event = (JSON.parse(second) as { header: { event_id: string } });
    event.header.event_id = "evt_http_retry";
    const secondBody = JSON.stringify(event);

    const firstResponse = await post(`${app.url}/webhooks/feishu`, first);
    const secondResponse = await post(`${app.url}/webhooks/feishu`, secondBody);

    assert.deepEqual(await firstResponse.json(), { status: "accepted" });
    assert.deepEqual(await secondResponse.json(), { status: "duplicate" });
    assert.equal(app.store.countInbox("accepted"), 1);
    assert.equal(app.store.countOutbox("pending"), 1);
    await app.close();
  });

  it("rejects a forged verification token before touching application state", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const body = messagePayload().replace(TOKEN, "forged-token");
    const response = await post(`${app.url}/webhooks/feishu`, body);

    assert.equal(response.status, 401);
    assert.equal(app.store.countInbox("accepted"), 0);
    assert.equal(app.store.countOutbox("pending"), 0);
    await app.close();
  });

  it("rejects malformed JSON with 400", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const response = await post(`${app.url}/webhooks/feishu`, "{not json");

    assert.equal(response.status, 400);
    await app.close();
  });

  it("rejects an unbound sender with 200 but no reply", async () => {
    const app = await startServer(new FeishuAdapter(config, { now: () => NOW }));
    const response = await post(
      `${app.url}/webhooks/feishu`,
      messagePayload("ou_stranger", "evt_http_stranger"),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "rejected" });
    assert.equal(app.store.countInbox("rejected"), 1);
    assert.equal(app.store.countOutbox("pending"), 0);
    await app.close();
  });
});
