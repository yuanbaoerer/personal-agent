import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeLongConnectionEvent } from "../src/channels/feishu/long-connection.ts";

const EVENT = {
  event_id: "evt_ws_1",
  app_id: "cli_app",
  sender: {
    sender_id: { open_id: "ou_owner" },
    sender_type: "user",
  },
  message: {
    message_id: "om_ws_1",
    create_time: "1700000000000",
    chat_id: "oc_ws",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text: "/status" }),
  },
};

describe("Feishu long-connection normalization", () => {
  it("normalizes a p2p text message", () => {
    const envelope = normalizeLongConnectionEvent(EVENT, "cli_app");
    assert.deepEqual(envelope, {
      channel: "feishu",
      accountId: "cli_app",
      platformEventId: "om_ws_1",
      eventType: "im.message.receive_v1",
      chatType: "p2p",
      actorType: "user",
      actorId: "ou_owner",
      platformConversationId: "oc_ws",
      replyTo: undefined,
      occurredAt: "2023-11-14T22:13:20.000Z",
      text: "/status",
    });
  });

  it("keeps group and app metadata for the ingress gate", () => {
    const envelope = normalizeLongConnectionEvent(
      {
        ...EVENT,
        sender: { sender_id: { open_id: "ou_app" }, sender_type: "app" },
        message: { ...EVENT.message, chat_type: "group" },
      },
      "cli_app",
    );
    assert.equal(envelope?.chatType, "group");
    assert.equal(envelope?.actorType, "app");
  });

  it("rejects non-text and malformed messages", () => {
    assert.equal(
      normalizeLongConnectionEvent(
        { ...EVENT, message: { ...EVENT.message, message_type: "image" } },
        "cli_app",
      ),
      undefined,
    );
    assert.equal(
      normalizeLongConnectionEvent(
        { ...EVENT, sender: { sender_id: {}, sender_type: "user" } },
        "cli_app",
      ),
      undefined,
    );
    assert.equal(
      normalizeLongConnectionEvent(
        { ...EVENT, message: { ...EVENT.message, chat_id: undefined } },
        "cli_app",
      ),
      undefined,
    );
  });
});
