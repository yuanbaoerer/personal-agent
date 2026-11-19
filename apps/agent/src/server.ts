import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { FeishuAdapter } from "./channels/feishu/adapter.ts";
import type { ClientApiService } from "./client-api.ts";
import type { IngressService } from "./coordinator/ingress.ts";
import type { GitHubOAuthStatus } from "./personal/github-oauth.ts";
import {
  FeishuAuthError,
  FeishuRequestError,
} from "./domain/errors.ts";

const MAX_BODY_BYTES = 1_048_576;
const MAX_EVENT_STREAMS = 8;

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
  /** Local authenticated control/event API; omitted means 404. */
  clientApi?: ClientApiService;
}

class BodyTooLargeError extends Error {}

const OAUTH_SESSION_COOKIE = "pa_oauth_session";
const OAUTH_SESSION_TTL_MS = 60 * 60_000;

interface OAuthSession {
  expiresAt: number;
}

export function createHttpServer(deps: HttpServerDeps): Server {
  const sessions = new Map<string, OAuthSession>();
  let activeEventStreams = 0;
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

      if (url.pathname === "/api/v1/events/stream" && deps.clientApi !== undefined) {
        if (request.method !== "GET") {
          status = 405;
          sendJson(response, status, { error: "method_not_allowed" });
          return;
        }
        const setup = deps.clientApi.prepareEventStream({
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          headers: normalizeHeaders(request),
          remoteAddress: request.socket.remoteAddress,
        });
        if (!setup.ok) {
          status = setup.status;
          sendJson(response, status, setup.body);
          return;
        }
        if (activeEventStreams >= MAX_EVENT_STREAMS) {
          status = 429;
          sendJson(response, status, { error: "too_many_event_streams" });
          return;
        }
        activeEventStreams += 1;
        status = 200;
        startEventStream(
          request,
          response,
          deps.clientApi,
          setup.after,
          setup.limit,
          () => {
            activeEventStreams = Math.max(0, activeEventStreams - 1);
          },
        );
        return;
      }

      if (url.pathname.startsWith("/api/v1/") && deps.clientApi !== undefined) {
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await readRawBody(request);
        const result = await deps.clientApi.handle({
          method: request.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: normalizeHeaders(request),
          remoteAddress: request.socket.remoteAddress,
          body,
        });
        status = result.status;
        response.setHeader("cache-control", "no-store");
        sendJson(response, status, result.body);
        return;
      }

      if (url.pathname.startsWith("/oauth/github")) {
        status = await handleGitHubOAuth(request, response, url, deps, sessions);
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

function startEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  clientApi: ClientApiService,
  after: number,
  limit: number,
  onClose: () => void,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let cursor = after;
  let closed = false;
  let poll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (poll !== undefined) clearInterval(poll);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    response.off("close", cleanup);
    request.off("aborted", cleanup);
    onClose();
  };
  const flush = () => {
    if (closed || response.writableEnded) {
      cleanup();
      return;
    }
    try {
      const events = clientApi.eventsSince(cursor, limit);
      for (const event of events) {
        response.write(
          `id: ${event.cursor}\nevent: audit\ndata: ${JSON.stringify(event)}\n\n`,
        );
        cursor = event.cursor;
      }
    } catch {
      cleanup();
      response.end();
    }
  };
  response.write("retry: 2000\n\n");
  flush();
  poll = setInterval(flush, 1_000);
  heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) {
      response.write(": keep-alive\n\n");
    }
  }, 15_000);
  response.on("close", cleanup);
  response.on("error", cleanup);
  request.on("aborted", cleanup);
  // SSE is intentionally long-lived; do not let a socket idle timeout drop it.
  response.socket?.setTimeout(0);
}

function normalizeHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.cookie;
  if (typeof header !== "string") {
    return cookies;
  }
  for (const part of header.split(";")) {
    const [name, ...values] = part.trim().split("=");
    if (name !== undefined && name.length > 0) {
      cookies.set(name, decodeURIComponent(values.join("=")));
    }
  }
  return cookies;
}

function tokenMatches(expectedRaw: string, actual: string | undefined): boolean {
  if (actual === undefined) {
    return false;
  }
  const expected = Buffer.from(expectedRaw);
  const provided = Buffer.from(actual);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function hasValidSession(
  request: IncomingMessage,
  sessions: Map<string, OAuthSession>,
): boolean {
  const sessionId = parseCookies(request).get(OAUTH_SESSION_COOKIE);
  if (sessionId === undefined) {
    return false;
  }
  const session = sessions.get(sessionId);
  if (session === undefined) {
    return false;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function requestIsAuthorized(
  request: IncomingMessage,
  adminToken: string | undefined,
  sessions: Map<string, OAuthSession>,
): boolean {
  if (adminToken === undefined || adminToken.length === 0) {
    return false;
  }
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
  return tokenMatches(adminToken, bearer) || hasValidSession(request, sessions);
}

async function handleGitHubOAuth(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: HttpServerDeps,
  sessions: Map<string, OAuthSession>,
): Promise<number> {
  if (deps.oauth === undefined) {
    sendJson(response, 404, { error: "github_oauth_not_configured" });
    return 404;
  }
  if (url.pathname === "/oauth/github") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return 405;
    }
    if (!requestIsAuthorized(request, deps.adminToken, sessions)) {
      sendHtml(response, 200, oauthLoginPage(false));
      return 200;
    }
    const status = deps.oauth.status();
    sendHtml(response, 200, oauthDashboardPage(status));
    return 200;
  }
  if (url.pathname === "/oauth/github/login") {
    if (request.method !== "POST" || deps.adminToken === undefined) {
      sendHtml(response, 401, "OAuth admin login is not available.");
      return 401;
    }
    const body = new URLSearchParams(await readRawBody(request));
    if (!tokenMatches(deps.adminToken, body.get("token") ?? undefined)) {
      sendHtml(response, 401, oauthLoginPage(true));
      return 401;
    }
    const sessionId = randomBytes(24).toString("base64url");
    sessions.set(sessionId, { expiresAt: Date.now() + OAUTH_SESSION_TTL_MS });
    const secure =
      (request.socket as { encrypted?: boolean }).encrypted === true ||
      request.headers["x-forwarded-proto"] === "https";
    response.setHeader(
      "set-cookie",
      `${OAUTH_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/oauth/github; HttpOnly; SameSite=Strict; Max-Age=${OAUTH_SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`,
    );
    response.statusCode = 302;
    response.setHeader("location", "/oauth/github");
    response.end();
    return 302;
  }
  if (url.pathname === "/oauth/github/logout") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return 405;
    }
    const sessionId = parseCookies(request).get(OAUTH_SESSION_COOKIE);
    if (sessionId !== undefined) {
      sessions.delete(sessionId);
    }
    response.setHeader(
      "set-cookie",
      `${OAUTH_SESSION_COOKIE}=; Path=/oauth/github; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    response.statusCode = 302;
    response.setHeader("location", "/oauth/github");
    response.end();
    return 302;
  }
  if (url.pathname === "/oauth/github/start") {
    if (request.method !== "GET" || !requestIsAuthorized(request, deps.adminToken, sessions)) {
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
    if (request.method !== "GET" || !requestIsAuthorized(request, deps.adminToken, sessions)) {
      sendJson(response, 401, { error: "unauthorized" });
      return 401;
    }
    sendJson(response, 200, deps.oauth.status());
    return 200;
  }
  if (url.pathname === "/oauth/github/disconnect") {
    if (request.method !== "POST" || !requestIsAuthorized(request, deps.adminToken, sessions)) {
      sendJson(response, 401, { error: "unauthorized" });
      return 401;
    }
    sendJson(response, 200, { disconnected: deps.oauth.disconnect() });
    return 200;
  }
  sendJson(response, 404, { error: "not_found" });
  return 404;
}

function oauthLoginPage(failed: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>GitHub connection</title>
<h1>Connect GitHub</h1>
${failed ? "<p>Admin token was incorrect.</p>" : "<p>Enter the admin token once to open the GitHub connection page. It is kept in an HttpOnly session cookie for one hour.</p>"}
<form method="post" action="/oauth/github/login">
  <label>Admin token <input type="password" name="token" autocomplete="current-password" required></label>
  <button type="submit">Continue</button>
</form>`;
}

function oauthDashboardPage(status: GitHubOAuthStatus): string {
  const connected = status.connected
    ? `<p>Connected as <strong>${escapeHtml(status.login ?? "unknown")}</strong> (${escapeHtml(status.scopes ?? "")}).</p>
       <form method="post" action="/oauth/github/disconnect"><button type="submit">Disconnect locally</button></form>`
    : "<p>No GitHub account is connected.</p>";
  return `<!doctype html><meta charset="utf-8"><title>GitHub connection</title>
<h1>GitHub connection</h1>
${connected}
<p><a href="/oauth/github/start">Connect / re-authorize GitHub</a></p>
<form method="post" action="/oauth/github/logout"><button type="submit">Log out of this page</button></form>
${status.connected ? "<p>Disconnect deletes the local encrypted token only; revoke the grant in GitHub settings if needed.</p>" : ""}`;
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
