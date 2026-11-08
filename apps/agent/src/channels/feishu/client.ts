import { createHash } from "node:crypto";

import { DeliveryRejectedError, DeliveryUnknownError } from "../../domain/errors.ts";
import type { Clock, DeliveryReceipt } from "../../domain/types.ts";
import type { FeishuConfig } from "./types.ts";

interface FeishuResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: {
    message_id?: string;
  };
}

export interface FeishuClientDeps {
  fetch?: typeof fetch;
  now?: Clock;
}

const RETRYABLE_CODES = new Set([99991400, 99991661, 99991663]);

export class FeishuClient {
  readonly #config: FeishuConfig;
  readonly #fetch: typeof fetch;
  readonly #now: Clock;
  readonly #timeoutMs: number;
  readonly #apiBase: string;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(config: FeishuConfig, deps: FeishuClientDeps = {}) {
    this.#config = config;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? (() => new Date());
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#apiBase = (config.apiBase ?? "https://open.feishu.cn").replace(/\/$/, "");
  }

  async sendText(chatId: string, text: string, businessKey: string): Promise<DeliveryReceipt> {
    const accessToken = await this.#tenantAccessToken();
    const uuid = createHash("sha256").update(businessKey, "utf8").digest("hex").slice(0, 32);
    const url = `${this.#apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
          uuid,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DeliveryUnknownError("Feishu send outcome unknown", { cause: error });
    }

    const body = await readJson(response);
    if (response.status === 429 || response.status >= 500) {
      throw new DeliveryUnknownError(`Feishu HTTP ${response.status}; outcome unknown`);
    }
    const code = body?.code;
    if (code !== undefined && code !== 0) {
      throw new DeliveryRejectedError(
        `Feishu rejected send: code ${code} ${body?.msg ?? ""}`.trim(),
        RETRYABLE_CODES.has(code),
      );
    }
    if (!response.ok) {
      throw new DeliveryRejectedError(
        `Feishu rejected send: HTTP ${response.status} ${body?.msg ?? ""}`.trim(),
        false,
      );
    }
    if (body?.code !== 0) {
      throw new DeliveryUnknownError("Feishu accepted send without a parseable response");
    }
    const messageId = body.data?.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new DeliveryUnknownError("Feishu accepted send without a message id");
    }

    return {
      businessKey,
      platformMessageId: messageId,
      acceptedAt: this.#now().toISOString(),
    };
  }

  async #tenantAccessToken(): Promise<string> {
    const now = this.#now().getTime();
    if (this.#token !== undefined && this.#token.expiresAt > now) {
      return this.#token.value;
    }

    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBase}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            app_id: this.#config.appId,
            app_secret: this.#config.appSecret,
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      throw new DeliveryRejectedError("Feishu token request failed before sending", true, {
        cause: error,
      });
    }

    const body = await readJson(response);
    if (!response.ok || body?.code !== 0 || typeof body.tenant_access_token !== "string") {
      throw new DeliveryRejectedError(
        `Feishu token rejected: HTTP ${response.status} code ${body?.code ?? "unknown"}`,
        false,
      );
    }

    const expiresInSeconds = typeof body.expire === "number" ? body.expire : 7200;
    this.#token = {
      value: body.tenant_access_token,
      expiresAt: now + Math.max(60, expiresInSeconds - 60) * 1000,
    };
    return this.#token.value;
  }
}

async function readJson(response: Response): Promise<FeishuResponse | undefined> {
  try {
    return (await response.json()) as FeishuResponse;
  } catch {
    return undefined;
  }
}
