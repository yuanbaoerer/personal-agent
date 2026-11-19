export interface IntentContext {
  ownerId: string;
  conversationId: string;
  inboxId: string;
  text: string;
}

export interface IntentReply {
  text: string;
  purpose: "ack" | "status" | "failure";
}

export interface IntentOutcome {
  replies: IntentReply[];
  /** The caller must wake the host after a confirmed schedule. */
  wake?: boolean;
}
