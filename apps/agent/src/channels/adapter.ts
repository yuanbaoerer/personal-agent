import type { DeliveryReceipt, SendRequest } from "../domain/types.ts";

/** Experimental until D11; bump only with a documented migration. */
export const CHANNEL_CONTRACT_VERSION = 1;

/**
 * The outbound seam. A channel may optionally support looking up a message by
 * the stable business key; that is required to reconcile a local crash after
 * the platform accepted the send.
 */
export interface ChannelAdapter {
  send(request: SendRequest): Promise<DeliveryReceipt>;
  findByBusinessKey?(businessKey: string): Promise<DeliveryReceipt | null>;
}
