import * as Lark from "@larksuiteoapi/node-sdk";

import type { IngressService } from "../../coordinator/ingress.ts";
import type { InboundEnvelope } from "../../domain/types.ts";
import type { FeishuConfig } from "./types.ts";

export interface LongConnectionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LongConnectionDeps {
  config: FeishuConfig;
  ingress: IngressService;
  logger: LongConnectionLogger;
}

interface LongConnectionEventData {
  event_id?: string;
  app_id?: string;
  sender?: {
    sender_id?: { open_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

/**
 * Feishu long-connection receiver. It opens an outbound WebSocket, so the
 * process needs no public HTTPS address or request URL. Event payloads are
 * plaintext after connection authentication; the SDK handles reconnects.
 */
export class FeishuLongConnection {
  readonly #config: FeishuConfig;
  readonly #ingress: IngressService;
  readonly #logger: LongConnectionLogger;
  #client: Lark.WSClient | undefined;

  constructor(deps: LongConnectionDeps) {
    this.#config = deps.config;
    this.#ingress = deps.ingress;
    this.#logger = deps.logger;
  }

  async start(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        await this.#handle(data);
      },
    });

    this.#client = new Lark.WSClient({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      onReady: () => this.#logger.info("feishu_ws_ready"),
      onError: (error) =>
        this.#logger.error("feishu_ws_error", { message: error.message }),
      onReconnecting: () => this.#logger.info("feishu_ws_reconnecting"),
      onReconnected: () => this.#logger.info("feishu_ws_reconnected"),
    });

    await this.#client.start({ eventDispatcher: dispatcher });
  }

  stop(): void {
    this.#client?.close({ force: true });
    this.#client = undefined;
  }

  async #handle(data: LongConnectionEventData): Promise<void> {
    const envelope = normalizeLongConnectionEvent(
      data,
      this.#config.accountId ?? this.#config.appId,
    );
    if (envelope === undefined) {
      this.#logger.info("feishu_ws_ignored", { reason: "unsupported event" });
      return;
    }

    try {
      const result = await this.#ingress.accept(envelope);
      this.#logger.info("feishu_ws_event", {
        outcome: result.outcome,
        reason: result.reason,
      });
    } catch (error) {
      this.#logger.error("feishu_ws_event_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      // Rethrow so the SDK does not acknowledge an event we failed to persist.
      throw error;
    }
  }
}

export function normalizeLongConnectionEvent(
  data: LongConnectionEventData,
  accountId: string,
): InboundEnvelope | undefined {
  const sender = asRecord(data.sender);
  const senderId = asRecord(sender?.sender_id);
  const message = asRecord(data.message);
  const openId = senderId?.open_id;
  const chatId = message?.chat_id;
  const messageId = message?.message_id;
  if (
    typeof openId !== "string" ||
    openId.length === 0 ||
    typeof chatId !== "string" ||
    chatId.length === 0 ||
    typeof messageId !== "string" ||
    messageId.length === 0
  ) {
    return undefined;
  }
  if (message?.message_type !== "text") {
    return undefined;
  }

  const platformEventId = messageId;
  const text = extractText(message.content);
  const occurredAt = formatFeishuTime(message.create_time);
  const replyTo =
    typeof message.parent_id === "string"
      ? message.parent_id
      : typeof message.root_id === "string"
        ? message.root_id
        : undefined;

  return {
    channel: "feishu",
    accountId,
    platformEventId,
    eventType: "im.message.receive_v1",
    chatType: normalizeChatType(message.chat_type),
    actorType: normalizeActorType(sender?.sender_type),
    actorId: openId,
    platformConversationId: chatId,
    replyTo,
    occurredAt,
    text,
  };
}

function asRecord(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, any>;
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
