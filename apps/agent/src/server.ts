import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { FeishuAdapter } from "./channels/feishu/adapter.ts";
import type { IngressService } from "./coordinator/ingress.ts";
import type { GitHubOAuthStatus } from "./personal/github-oauth.ts";
import {
  FeishuAuthError,
  FeishuRequestError,
} from "./domain/errors.ts";

const MAX_BODY_BYTES = 1_048_576;

export interface AppLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface GitHubOAuthHttpHandler {
  start(): string;
  complete(code: string, state: string): Promise<GitHubOAuthStatus>;
  status(): GitHubOAuthStatus;
  disconnect(): boolean;
}

export interface HttpServerDeps {
  feishu: FeishuAdapter;
  ingress: IngressService;
  logger: AppLogger;
  oauth?: GitHubOAuthHttpHandler;
  adminToken?: string;
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

      if (url.pathname.startsWith("/oauth/github")) {
        status = await handleGitHubOAuth(request, response, url, deps);
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
        // Never log query strings: OAuth/admin tokens may be there.
        path: (() => {
          try {
            return new URL(request.url ?? "/", "http://localhost").pathname;
          } catch {
            return "/invalid";
          }
        })(),
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

function requestIsAuthorized(
  request: IncomingMessage,
  _url: URL,
  adminToken: string | undefined,
): boolean {
  if (adminToken === undefined || adminToken.length === 0) {
    return false;
  }
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
  if (bearer === undefined) {
    return false;
  }
  const expected = Buffer.from(adminToken);
  const actual = Buffer.from(bearer);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function handleGitHubOAuth(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: HttpServerDeps,
): Promise<number> {
  if (deps.oauth === undefined) {
    sendJson(response, 404, { error: "github_oauth_not_configured" });
    return 404;
  }
  if (url.pathname === "/oauth/github/start") {
    if (request.method !== "GET" || !requestIsAuthorized(request, url, deps.adminToken)) {
      sendJson(response, 401, { error: "unauthorized" });
      return 401;
    }
    response.statusCode = 302;
    response.setHeader("location", deps.oauth.start());
    response.setHeader("cache-control", "no-store");
    response.end();
    return 302;
  }
  if (url.pathname === "/oauth/github/callback") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return 405;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null) {
      sendHtml(response, 400, "GitHub authorization was cancelled or incomplete.");
      return 400;
    }
    try {
      const result = await deps.oauth.complete(code, state);
      sendHtml(
        response,
        200,
        `GitHub connected as ${escapeHtml(result.login ?? "unknown")}. You can close this window.`,
      );
      return 200;
    } catch (error) {
      deps.logger.error("github_oauth_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      sendHtml(response, 400, "GitHub authorization failed. Start the connection again.");
      return 400;
    }
  }
  if (url.pathname === "/oauth/github/status") {
    if (request.method !== "GET" || !requestIsAuthorized(request, url, deps.adminToken)) {
      sendJson(response, 401, { error: "unauthorized" });
      return 401;
    }
    sendJson(response, 200, deps.oauth.status());
    return 200;
  }
  if (url.pathname === "/oauth/github/disconnect") {
    if (request.method !== "POST" || !requestIsAuthorized(request, url, deps.adminToken)) {
      sendJson(response, 401, { error: "unauthorized" });
      return 401;
    }
    sendJson(response, 200, { disconnected: deps.oauth.disconnect() });
    return 200;
  }
  sendJson(response, 404, { error: "not_found" });
  return 404;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function sendHtml(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`<!doctype html><title>GitHub</title><p>${message}</p>`);
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
