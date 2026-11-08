import { randomUUID } from "node:crypto";

import type { Clock, InboundEnvelope, InboxRecord } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";
import type { InboundHandler } from "./responder.ts";

export interface IngressResult {
  outcome: "accepted" | "duplicate" | "rejected";
  inboxId: string;
  processed: boolean;
  reason?: string;
}

export interface IngressDeps {
  store: Store;
  handler: InboundHandler;
  now?: Clock;
}

/**
 * Ingress is the only owner check for chat events. A trigger is persisted
 * before any model work; duplicate platform events return the original record.
 */
export class IngressService {
  readonly #store: Store;
  readonly #handler: InboundHandler;
  readonly #now: Clock;

  constructor(deps: IngressDeps) {
    this.#store = deps.store;
    this.#handler = deps.handler;
    this.#now = deps.now ?? (() => new Date());
  }

  async accept(envelope: InboundEnvelope): Promise<IngressResult> {
    const now = this.#now();
    const receivedAt = now.toISOString();
    const owner =
      envelope.actorType === "user"
        ? this.#store.findOwner(envelope.channel, envelope.accountId, envelope.actorId)
        : undefined;

    let rejectReason: string | undefined;
    if (envelope.actorType !== "user") {
      rejectReason = "actor_not_user";
    } else if (envelope.chatType !== "p2p") {
      rejectReason = "chat_not_p2p";
    } else if (owner === undefined) {
      rejectReason = "actor_not_bound";
    }

    const conversation =
      rejectReason === undefined && owner !== undefined
        ? this.#store.upsertConversation({
            ownerId: owner.id,
            channel: envelope.channel,
            accountId: envelope.accountId,
            platformConversationId: envelope.platformConversationId,
            kind: envelope.chatType,
            createdAt: receivedAt,
          })
        : undefined;

    const traceId = randomUUID();
    const { inserted, record } = this.#store.insertInbox({
      channel: envelope.channel,
      accountId: envelope.accountId,
      platformEventId: envelope.platformEventId,
      ownerId: owner?.id,
      conversationId: conversation?.id,
      platformConversationId: envelope.platformConversationId,
      actorId: envelope.actorId,
      actorType: envelope.actorType,
      eventType: envelope.eventType,
      chatType: envelope.chatType,
      replyTo: envelope.replyTo,
      text: envelope.text,
      status: rejectReason === undefined ? "accepted" : "rejected",
      rejectReason,
      occurredAt: envelope.occurredAt,
      receivedAt,
      traceId,
    });

    if (!inserted) {
      if (record.status === "accepted" && record.processedAt === undefined) {
        await this.#process(record);
      }
      return {
        outcome: "duplicate",
        inboxId: record.id,
        processed: true,
        reason: record.rejectReason,
      };
    }

    this.#store.recordAudit({
      actorId: envelope.actorId,
      event: record.status === "accepted" ? "inbox.accepted" : "inbox.rejected",
      subjectType: "inbox",
      subjectId: record.id,
      after: {
        status: record.status,
        rejectReason: record.rejectReason,
        platformEventId: record.platformEventId,
      },
      traceId,
      occurredAt: receivedAt,
    });

    if (record.status === "rejected") {
      return {
        outcome: "rejected",
        inboxId: record.id,
        processed: true,
        reason: record.rejectReason,
      };
    }

    await this.#process(record);
    return { outcome: "accepted", inboxId: record.id, processed: true };
  }

  async recoverPending(limit = 50): Promise<number> {
    const pending = this.#store.listPendingInbox(limit);
    let processed = 0;

    for (const inbox of pending) {
      try {
        await this.#process(inbox);
        processed += 1;
      } catch (error) {
        this.#store.recordAudit({
          actorId: inbox.actorId,
          event: "inbox.process_failed",
          subjectType: "inbox",
          subjectId: inbox.id,
          after: {
            message: error instanceof Error ? error.message : String(error),
          },
          traceId: inbox.traceId,
          occurredAt: this.#now().toISOString(),
        });
      }
    }

    return processed;
  }

  async #process(inbox: InboxRecord): Promise<void> {
    if (inbox.processedAt !== undefined || inbox.status !== "accepted") {
      return;
    }
    const ownerId = inbox.ownerId;
    const conversationId = inbox.conversationId;
    if (ownerId === undefined || conversationId === undefined) {
      throw new Error(`accepted inbox ${inbox.id} has no owner or conversation`);
    }

    const replies = await this.#handler.handle(inbox, this.#store);
    const now = this.#now().toISOString();

    for (const [index, reply] of replies.entries()) {
      this.#store.enqueueOutbox({
        businessKey: `inbox:${inbox.id}:reply:${index}`,
        ownerId,
        channel: inbox.channel,
        accountId: inbox.accountId,
        // The outbox sends with the platform address, not the internal row id.
        conversationId: inbox.platformConversationId,
        purpose: reply.purpose,
        text: reply.text,
        createdAt: now,
      });
    }

    this.#store.markInboxProcessed(inbox.id, now);
  }
}
