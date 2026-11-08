import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { FeishuAdapter } from "./channels/feishu/adapter.ts";
import type { IngressService } from "./coordinator/ingress.ts";
import {
  FeishuAuthError,
  FeishuRequestError,
} from "./domain/errors.ts";

const MAX_BODY_BYTES = 1_048_576;

export interface AppLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface HttpServerDeps {
  feishu: FeishuAdapter;
  ingress: IngressService;
  logger: AppLogger;
}

class BodyTooLargeError extends Error {}

export function createHttpServer(deps: HttpServerDeps): Server {
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    let status = 500;

    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/healthz") {
        status = 200;
        sendJson(response, status, { ok: true, uptimeSeconds: process.uptime() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/webhooks/feishu") {
        status = await handleFeishuWebhook(request, response, deps);
        return;
      }

      status = 404;
      sendJson(response, status, { error: "not_found" });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        status = 413;
        sendJson(response, status, { error: "body_too_large" });
      } else if (error instanceof FeishuAuthError) {
        status = 401;
        sendJson(response, status, { error: "invalid_signature" });
      } else if (error instanceof FeishuRequestError) {
        status = 400;
        sendJson(response, status, { error: "invalid_request" });
      } else {
        status = 500;
        deps.logger.error("http_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          sendJson(response, status, { error: "internal_error" });
        }
      }
    } finally {
      deps.logger.info("http_request", {
        method: request.method,
        path: request.url,
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

async function handleFeishuWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HttpServerDeps,
): Promise<number> {
  const rawBody = await readRawBody(request);
  const parsed = deps.feishu.parseRequest({ headers: request.headers, rawBody });

  if (parsed.kind === "challenge") {
    deps.logger.info("feishu_challenge", {});
    sendJson(response, 200, { challenge: parsed.challenge });
    return 200;
  }

  if (parsed.kind === "ignored") {
    deps.logger.info("feishu_ignored", { reason: parsed.reason });
    sendJson(response, 200, { status: "ignored" });
    return 200;
  }

  const result = await deps.ingress.accept(parsed.event);
  deps.logger.info("feishu_event", {
    outcome: result.outcome,
    reason: result.reason,
  });
  sendJson(response, 200, { status: result.outcome });
  return 200;
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError("request body exceeds limit");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
