import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "node:test";

import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import { decryptFeishuPayload } from "../src/channels/feishu/crypto.ts";
import type { FeishuConfig } from "../src/channels/feishu/types.ts";
import {
  DeliveryRejectedError,
  DeliveryUnknownError,
  FeishuAuthError,
} from "../src/domain/errors.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const TOKEN = "verification-token";
const ENCRYPT_KEY = "encrypt-key";

const baseConfig: FeishuConfig = {
  appId: "app_1",
  appSecret: "app-secret",
  verificationToken: TOKEN,
  accountId: "app_1",
};

function eventPayload(): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "evt_1",
      event_type: "im.message.receive_v1",
      token: TOKEN,
      app_id: "app_1",
      tenant_key: "tenant",
      create_time: "1767225600000",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_owner" },
        sender_type: "user",
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1767225600000",
      },
    },
  };
}

function sign(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`, "utf8")
    .digest("hex");
}

function signedHeaders(rawBody: string, encryptKey = ENCRYPT_KEY): Record<string, string> {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const nonce = "nonce-1";
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": sign(timestamp, nonce, encryptKey, rawBody),
  };
}

function encryptForTest(plaintext: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const implementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch: implementation as typeof fetch };
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sendResponse(messageId = "om_sent"): Response {
  return new Response(JSON.stringify({ code: 0, data: { message_id: messageId } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Feishu request verification", () => {
  it("decrypts the official AES-256-CBC example vector", () => {
    assert.equal(
      decryptFeishuPayload("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key"),
      "hello world",
    );
  });

  it("accepts a correctly signed URL verification challenge", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-1",
      token: TOKEN,
    });

    const parsed = adapter.parseRequest({
      headers: signedHeaders(rawBody),
      rawBody,
    });

    assert.deepEqual(parsed, { kind: "challenge", challenge: "challenge-1" });
  });

  it("accepts an unsigned URL verification challenge even when an encrypt key is configured", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-unsigned",
      token: TOKEN,
    });

    const parsed = adapter.parseRequest({ headers: {}, rawBody });

    assert.deepEqual(parsed, { kind: "challenge", challenge: "challenge-unsigned" });
  });

  it("rejects a tampered event body with the original signature", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );
    const rawBody = JSON.stringify(eventPayload());
    const headers = signedHeaders(rawBody);
    const tampered = rawBody.replace("hello", "tampered");

    assert.throws(
      () => adapter.parseRequest({ headers, rawBody: tampered }),
      FeishuAuthError,
    );
  });

  it("rejects an event without a signature when an encrypt key is configured", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );

    assert.throws(
      () =>
        adapter.parseRequest({
          headers: {},
          rawBody: JSON.stringify(eventPayload()),
        }),
      FeishuAuthError,
    );
  });

  it("rejects a stale signature timestamp", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );
    const rawBody = JSON.stringify(eventPayload());
    const timestamp = String(Math.floor(NOW.getTime() / 1000) - 301);
    const nonce = "nonce-1";

    assert.throws(
      () =>
        adapter.parseRequest({
          headers: {
            "x-lark-request-timestamp": timestamp,
            "x-lark-request-nonce": nonce,
            "x-lark-signature": sign(timestamp, nonce, ENCRYPT_KEY, rawBody),
          },
          rawBody,
        }),
      FeishuAuthError,
    );
  });

  it("requires the verification token when no encrypt key is configured", () => {
    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-1",
      token: "wrong-token",
    });

    assert.throws(
      () => adapter.parseRequest({ headers: {}, rawBody }),
      FeishuAuthError,
    );
  });

  it("decrypts and verifies an encrypted event body", () => {
    const adapter = new FeishuAdapter(
      { ...baseConfig, encryptKey: ENCRYPT_KEY },
      { now: () => NOW },
    );
    const plaintext = JSON.stringify(eventPayload());
    const rawBody = JSON.stringify({
      encrypt: encryptForTest(plaintext, ENCRYPT_KEY),
    });

    const parsed = adapter.parseRequest({
      headers: signedHeaders(rawBody),
      rawBody,
    });

    assert.equal(parsed.kind, "event");
    if (parsed.kind === "event") {
      assert.equal(parsed.event.platformEventId, "om_1");
      assert.equal(parsed.event.actorId, "ou_owner");
      assert.equal(parsed.event.text, "hello");
    }
  });
});

describe("Feishu event normalization", () => {
  it("normalizes a bound owner p2p text event", () => {
    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });
    const parsed = adapter.parseRequest({
      headers: {},
      rawBody: JSON.stringify(eventPayload()),
    });

    assert.equal(parsed.kind, "event");
    if (parsed.kind === "event") {
      assert.deepEqual(parsed.event, {
        channel: "feishu",
        accountId: "app_1",
        platformEventId: "om_1",
        eventType: "im.message.receive_v1",
        chatType: "p2p",
        actorType: "user",
        actorId: "ou_owner",
        platformConversationId: "oc_1",
        replyTo: undefined,
        occurredAt: "2026-01-01T00:00:00.000Z",
        text: "hello",
      });
    }
  });

  it("keeps group and app-sender metadata for the ingress gate", () => {
    const payload = eventPayload();
    const event = payload.event as Record<string, unknown>;
    const message = event.message as Record<string, unknown>;
    const sender = event.sender as Record<string, unknown>;
    message.chat_type = "group";
    sender.sender_type = "app";

    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });
    const parsed = adapter.parseRequest({
      headers: {},
      rawBody: JSON.stringify(payload),
    });

    assert.equal(parsed.kind, "event");
    if (parsed.kind === "event") {
      assert.equal(parsed.event.chatType, "group");
      assert.equal(parsed.event.actorType, "app");
    }
  });

  it("ignores non-text and unsupported event types", () => {
    const nonText = eventPayload();
    const nonTextEvent = nonText.event as Record<string, unknown>;
    (nonTextEvent.message as Record<string, unknown>).message_type = "image";

    const unsupported = eventPayload();
    (unsupported.header as Record<string, unknown>).event_type = "im.chat.updated_v1";

    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });

    assert.deepEqual(
      adapter.parseRequest({ headers: {}, rawBody: JSON.stringify(nonText) }),
      { kind: "ignored", reason: "unsupported message type" },
    );
    assert.equal(
      adapter.parseRequest({ headers: {}, rawBody: JSON.stringify(unsupported) }).kind,
      "ignored",
    );
  });

  it("rejects a different app id or verification token", () => {
    const wrongApp = eventPayload();
    (wrongApp.header as Record<string, unknown>).app_id = "other-app";
    const wrongToken = eventPayload();
    (wrongToken.header as Record<string, unknown>).token = "other-token";

    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });

    assert.throws(
      () =>
        adapter.parseRequest({
          headers: {},
          rawBody: JSON.stringify(wrongApp),
        }),
      FeishuAuthError,
    );
    assert.throws(
      () =>
        adapter.parseRequest({
          headers: {},
          rawBody: JSON.stringify(wrongToken),
        }),
      FeishuAuthError,
    );
  });
});

describe("Feishu outbound send", () => {
  function outbound() {
    return {
      businessKey: "biz-1",
      channel: "feishu",
      accountId: "app_1",
      conversationId: "oc_1",
      ownerId: "owner-1",
      purpose: "ack" as const,
      text: "hello",
    };
  }

  it("sends text with a stable uuid and caches the tenant token", async () => {
    const transport = fakeFetch((call) =>
      call.url.includes("tenant_access_token") ? tokenResponse() : sendResponse(),
    );
    const adapter = new FeishuAdapter(baseConfig, {
      fetch: transport.fetch,
      now: () => NOW,
    });

    const first = await adapter.send(outbound());
    const second = await adapter.send({ ...outbound(), businessKey: "biz-2" });

    assert.equal(first.platformMessageId, "om_sent");
    assert.equal(second.platformMessageId, "om_sent");
    assert.equal(transport.calls.length, 3);
    assert.equal(transport.calls[0]?.url.endsWith("/open-apis/auth/v3/tenant_access_token/internal"), true);

    const headers = transport.calls[1]?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer tenant-token");
    const body = JSON.parse(transport.calls[1]?.init?.body as string) as Record<string, unknown>;
    assert.equal(body.receive_id, "oc_1");
    assert.equal(body.msg_type, "text");
    assert.equal(body.uuid, createHash("sha256").update("biz-1").digest("hex").slice(0, 32));
    assert.deepEqual(JSON.parse(body.content as string), { text: "hello" });
  });

  it("classifies a transport timeout after token acquisition as unknown", async () => {
    let calls = 0;
    const transport = fakeFetch(() => {
      calls += 1;
      if (calls === 1) {
        return tokenResponse();
      }
      throw new Error("socket timeout");
    });
    const adapter = new FeishuAdapter(baseConfig, {
      fetch: transport.fetch,
      now: () => NOW,
    });

    await assert.rejects(adapter.send(outbound()), DeliveryUnknownError);
  });

  it("treats HTTP 5xx as unknown and HTTP 4xx as rejected", async () => {
    const serverError = fakeFetch((call) =>
      call.url.includes("tenant_access_token")
        ? tokenResponse()
        : new Response("upstream down", { status: 503 }),
    );
    const clientError = fakeFetch((call) =>
      call.url.includes("tenant_access_token")
        ? tokenResponse()
        : new Response(JSON.stringify({ code: 230001, msg: "invalid request" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
    );

    await assert.rejects(
      new FeishuAdapter(baseConfig, { fetch: serverError.fetch, now: () => NOW }).send(
        outbound(),
      ),
      DeliveryUnknownError,
    );
    await assert.rejects(
      new FeishuAdapter(baseConfig, { fetch: clientError.fetch, now: () => NOW }).send(
        outbound(),
      ),
      DeliveryRejectedError,
    );
  });

  it("treats a retryable Feishu error code as retryable", async () => {
    const transport = fakeFetch((call) =>
      call.url.includes("tenant_access_token")
        ? tokenResponse()
        : new Response(JSON.stringify({ code: 99991663, msg: "token expired" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
    );
    const adapter = new FeishuAdapter(baseConfig, {
      fetch: transport.fetch,
      now: () => NOW,
    });

    await assert.rejects(adapter.send(outbound()), (error: unknown) => {
      return error instanceof DeliveryRejectedError && error.retryable;
    });
  });

  it("refuses to send through a different account binding", async () => {
    const adapter = new FeishuAdapter(baseConfig, { now: () => NOW });

    await assert.rejects(
      adapter.send({ ...outbound(), accountId: "other-app" }),
      DeliveryRejectedError,
    );
  });
});
