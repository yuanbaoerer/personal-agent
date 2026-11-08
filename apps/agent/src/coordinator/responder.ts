import type { InboxRecord, ReplyDraft } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";

export interface InboundHandler {
  handle(event: InboxRecord, store: Store): Promise<ReplyDraft[]>;
}

/** Deterministic commands that must not wait for a model or a Worker. */
export class CommandResponder implements InboundHandler {
  async handle(event: InboxRecord, store: Store): Promise<ReplyDraft[]> {
    const text = event.text?.trim() ?? "";

    if (text === "/status" || text === "状态") {
      const accepted = store.countInbox("accepted");
      const rejected = store.countInbox("rejected");
      const pending = store.countOutbox("pending");
      const unknown = store.countOutbox("unknown");
      const manual = store.countOutbox("needs_manual");
      return [
        {
          purpose: "status",
          text:
            `服务运行中。受理 ${accepted} 条，拒绝 ${rejected} 条；` +
            `待发送 ${pending} 条，待核对 ${unknown} 条，需人工 ${manual} 条。`,
        },
      ];
    }

    return [{ purpose: "ack", text: "已收到。" }];
  }
}
