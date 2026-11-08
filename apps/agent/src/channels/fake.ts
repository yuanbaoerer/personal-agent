import { DeliveryRejectedError, DeliveryUnknownError } from "../domain/errors.ts";
import type { DeliveryReceipt, SendRequest } from "../domain/types.ts";
import type { ChannelAdapter } from "./adapter.ts";

export type FakeFailure = "unknown" | "retryable" | "fatal";

/**
 * Deterministic channel used by the contract tests. `sent` is the external
 * side effect; the dispatcher under test never sees it directly.
 */
export class FakeChannel implements ChannelAdapter {
  readonly sent: SendRequest[] = [];
  readonly #receipts = new Map<string, DeliveryReceipt>();
  #counter = 0;

  failure: FakeFailure | undefined;
  supportsQuery = true;

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    const failure = this.failure;
    this.failure = undefined;

    if (failure === "fatal") {
      throw new DeliveryRejectedError("fake rejected", false);
    }
    if (failure === "retryable") {
      throw new DeliveryRejectedError("fake retryable", true);
    }

    this.#counter += 1;
    const receipt: DeliveryReceipt = {
      businessKey: request.businessKey,
      platformMessageId: `fake-message-${this.#counter}`,
      acceptedAt: new Date().toISOString(),
    };
    this.sent.push(request);
    this.#receipts.set(request.businessKey, receipt);

    if (failure === "unknown") {
      throw new DeliveryUnknownError("fake timeout after platform accepted");
    }

    return receipt;
  }

  async findByBusinessKey(businessKey: string): Promise<DeliveryReceipt | null> {
    if (!this.supportsQuery) {
      return null;
    }
    return this.#receipts.get(businessKey) ?? null;
  }
}

/** A channel with no query capability; used to assert conservative recovery. */
export class FakeChannelWithoutQuery implements ChannelAdapter {
  readonly sent: SendRequest[] = [];
  #counter = 0;

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    this.#counter += 1;
    this.sent.push(request);
    return {
      businessKey: request.businessKey,
      platformMessageId: `fake-no-query-${this.#counter}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}
