import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { FeishuAuthError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/types.ts";

export interface FeishuSignatureInput {
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  encryptKey: string;
  rawBody: string;
  now?: Clock;
  toleranceSeconds?: number;
}

export function computeFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  rawBody: string,
): string {
  return createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`, "utf8")
    .digest("hex");
}

/**
 * Feishu documents this as SHA-256(timestamp + nonce + encrypt_key + raw body).
 * The timestamp is in seconds and must be fresh to reject replays.
 */
export function verifyFeishuSignature(input: FeishuSignatureInput): void {
  const { timestamp, nonce, signature, encryptKey, rawBody } = input;
  if (!timestamp || !nonce || !signature) {
    throw new FeishuAuthError("missing Feishu signature headers");
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new FeishuAuthError("invalid Feishu request timestamp");
  }

  const clock = input.now ?? (() => new Date());
  const tolerance = input.toleranceSeconds ?? 300;
  const skewSeconds = Math.abs(Math.floor(clock().getTime() / 1000) - timestampSeconds);
  if (skewSeconds > tolerance) {
    throw new FeishuAuthError("stale Feishu request");
  }

  const expected = computeFeishuSignature(timestamp, nonce, encryptKey, rawBody);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new FeishuAuthError("invalid Feishu signature");
  }
}

/**
 * AES-256-CBC. Key = SHA-256(encrypt_key); first 16 bytes of the payload are
 * the IV. Verified against the official "hello world" example vector.
 */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const payload = Buffer.from(encrypted, "base64");
  if (payload.length < 32 || payload.length % 16 !== 0) {
    throw new FeishuAuthError("invalid Feishu encrypted payload length");
  }

  const iv = payload.subarray(0, 16);
  const ciphertext = payload.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
