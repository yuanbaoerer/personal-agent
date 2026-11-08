import { timingSafeEqual } from "node:crypto";

import {
  DeliveryRejectedError,
  FeishuAuthError,
  FeishuRequestError,
} from "../../domain/errors.ts";
import type { Clock, DeliveryReceipt, SendRequest } from "../../domain/types.ts";
import type { ChannelAdapter } from "../adapter.ts";
import { FeishuClient, type FeishuClientDeps } from "./client.ts";
import { decryptFeishuPayload, verifyFeishuSignature } from "./crypto.ts";
import type { FeishuConfig, FeishuParseResult, FeishuRawRequest } from "./types.ts";

export interface FeishuAdapterDeps extends FeishuClientDeps {
  now?: Clock;
  signatureToleranceSeconds?: number;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly #config: FeishuConfig;
  readonly #accountId: string;
  readonly #client: FeishuClient;
  readonly #now: Clock;
  readonly #toleranceSeconds: number;

  constructor(config: FeishuConfig, deps: FeishuAdapterDeps = {}) {
    this.#config = config;
    this.#accountId = config.accountId ?? config.appId;
    this.#client = new FeishuClient(config, deps);
    this.#now = deps.now ?? (() => new Date());
    this.#toleranceSeconds = deps.signatureToleranceSeconds ?? 300;
  }

  parseRequest(request: FeishuRawRequest): FeishuParseResult {
    let payload = parseJsonObject(request.rawBody);

    // Feishu excludes URL verification from signature verification. The
    // challenge still has to carry the configured verification token.
    if (payload.type === "url_verification") {
      assertToken(payload.token, this.#config.verificationToken);
      if (typeof payload.challenge !== "string") {
        throw new FeishuAuthError("missing Feishu challenge");
      }
      return { kind: "challenge", challenge: payload.challenge };
    }

    if (this.#config.encryptKey !== undefined) {
      const timestamp = readHeader(request.headers, "x-lark-request-timestamp");
      const nonce = readHeader(request.headers, "x-lark-request-nonce");
      const signature = readHeader(request.headers, "x-lark-signature");
      verifyFeishuSignature({
        timestamp,
        nonce,
        signature,
        encryptKey: this.#config.encryptKey,
        rawBody: request.rawBody,
        now: this.#now,
        toleranceSeconds: this.#toleranceSeconds,
      });
    }

    if (typeof payload.encrypt === "string") {
      if (this.#config.encryptKey === undefined) {
        throw new FeishuAuthError("encrypted event but FEISHU_ENCRYPT_KEY is not configured");
      }
      try {
        payload = parseJsonObject(decryptFeishuPayload(payload.encrypt, this.#config.encryptKey));
      } catch (error) {
        if (error instanceof FeishuAuthError) {
          throw error;
        }
        throw new FeishuRequestError("invalid Feishu encrypted payload");
      }
    }

    if (payload.type === "url_verification") {
      assertToken(payload.token, this.#config.verificationToken);
      if (typeof payload.challenge !== "string") {
        throw new FeishuAuthError("missing Feishu challenge");
      }
      return { kind: "challenge", challenge: payload.challenge };
    }

    const header = asRecord(payload.header);
    if (header === undefined) {
      return { kind: "ignored", reason: "not a Feishu 2.0 event" };
    }

    assertToken(header.token, this.#config.verificationToken);
    if (header.app_id !== this.#config.appId) {
      throw new FeishuAuthError("Feishu app_id mismatch");
    }
    if (header.event_type !== "im.message.receive_v1") {
      return { kind: "ignored", reason: `unsupported event ${String(header.event_type)}` };
    }
    if (typeof header.event_id !== "string" || header.event_id.length === 0) {
      throw new FeishuAuthError("missing Feishu event_id");
    }

    const event = asRecord(payload.event);
    const message = asRecord(event?.message);
    const sender = asRecord(event?.sender);
    const senderId = asRecord(sender?.sender_id);
    const openId = senderId?.open_id;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;

    if (typeof openId !== "string" || openId.length === 0) {
      return { kind: "ignored", reason: "message event without sender open_id" };
    }
    if (typeof chatId !== "string" || chatId.length === 0) {
      return { kind: "ignored", reason: "message event without chat_id" };
    }
    if (message?.message_type !== "text") {
      return { kind: "ignored", reason: "unsupported message type" };
    }

    // Feishu can push the same message more than once with different event_id
    // values. Its event documentation requires message_id for deduplication.
    const platformEventId =
      typeof messageId === "string" && messageId.length > 0
        ? messageId
        : header.event_id;

    const text = extractText(message.content);
    const occurredAt = formatFeishuTime(message.create_time);
    const replyTo =
      typeof message.parent_id === "string"
        ? message.parent_id
        : typeof message.root_id === "string"
          ? message.root_id
          : undefined;

    return {
      kind: "event",
      event: {
        channel: "feishu",
        accountId: this.#accountId,
        platformEventId,
        eventType: header.event_type,
        chatType: normalizeChatType(message.chat_type),
        actorType: normalizeActorType(sender?.sender_type),
        actorId: openId,
        platformConversationId: chatId,
        replyTo,
        occurredAt,
        text,
      },
    };
  }

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    if (request.accountId !== this.#accountId) {
      throw new DeliveryRejectedError("outbox account does not match Feishu app", false);
    }
    return this.#client.sendText(request.conversationId, request.text, request.businessKey);
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FeishuRequestError("invalid Feishu JSON body");
  }
  const object = asRecord(value);
  if (object === undefined) {
    throw new FeishuRequestError("Feishu body must be a JSON object");
  }
  return object;
}

function assertToken(value: unknown, expected: string): void {
  if (typeof value !== "string") {
    throw new FeishuAuthError("missing Feishu verification token");
  }
  const actualBuffer = Buffer.from(value, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new FeishuAuthError("invalid Feishu verification token");
  }
}

function extractText(content: unknown): string | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  try {
    const parsed = asRecord(JSON.parse(content));
    return typeof parsed?.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

function formatFeishuTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Number.parseInt(value, 10);
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }
  return new Date(milliseconds).toISOString();
}

function normalizeChatType(value: unknown): "p2p" | "group" | "unknown" {
  if (value === "p2p") {
    return "p2p";
  }
  if (value === "group" || value === "topic_group") {
    return "group";
  }
  return "unknown";
}

function normalizeActorType(value: unknown): "user" | "app" | "unknown" {
  if (value === "user") {
    return "user";
  }
  if (value === "app") {
    return "app";
  }
  return "unknown";
}
