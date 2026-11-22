import type { OutboxPurpose } from "../domain/types.ts";

export interface IntentContext {
  ownerId: string;
  conversationId: string;
  inboxId: string;
  text: string;
}

export interface IntentReply {
  text: string;
  purpose: OutboxPurpose;
}

export interface IntentOutcome {
  replies: IntentReply[];
  /** The caller must wake the host after a confirmed schedule. */
  wake?: boolean;
}
