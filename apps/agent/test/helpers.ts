import type { InboundEnvelope, OutboxRecord, SendRequest } from "../src/domain/types.ts";
import { openStore } from "../src/storage/node.ts";
import type { Store } from "../src/storage/store.ts";

export const OWNER_OPEN_ID = "ou_owner";
export const APP_ID = "app_1";
export const CONVERSATION_ID = "oc_1";

export function createStore(): Store {
  const store = openStore(":memory:");
  store.bindOwner({
    channel: "feishu",
    accountId: APP_ID,
    actorId: OWNER_OPEN_ID,
    verifiedAt: "2026-01-01T00:00:00.000Z",
  });
  return store;
}

export function inbound(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    channel: "feishu",
    accountId: APP_ID,
    platformEventId: "evt_1",
    eventType: "im.message.receive_v1",
    chatType: "p2p",
    actorType: "user",
    actorId: OWNER_OPEN_ID,
    platformConversationId: CONVERSATION_ID,
    text: "hello",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function toSendRequest(row: OutboxRecord): SendRequest {
  return {
    businessKey: row.businessKey,
    channel: row.channel,
    accountId: row.accountId,
    conversationId: row.conversationId,
    ownerId: row.ownerId,
    purpose: row.purpose,
    text: row.text,
  };
}
