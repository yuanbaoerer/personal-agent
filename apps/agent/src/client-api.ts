import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AppServices } from "./app.ts";
import {
  ClientTokenRepository,
  CLIENT_SCOPES,
  type ClientScope,
  type ClientTokenRecord,
} from "./storage/client-tokens.ts";
import { stableStringify } from "./actions/tooling.ts";
import { buildDiagnostics } from "./observability/diagnostics.ts";
import { buildUsage } from "./observability/usage.ts";
import { PluginNotFoundError, PluginNotConfiguredError } from "./plugins/catalog.ts";
import type { AuditFeedItem, Store } from "./storage/store.ts";
import type {
  ActionRecord,
  ExtensionPolicy,
  Mandate,
  TaskRecord,
  TaskStatus,
} from "./domain/types.ts";
import { ExtensionPolicyError } from "./domain/errors.ts";

export const CLIENT_API_VERSION = 1;
const API_PREFIX = "/api/v1";
const MAX_LIMIT = 100;
const TOKEN_PREFIX = "pa_";

const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting_user",
  "waiting_external",
  "succeeded",
  "needs_review",
  "failed",
  "cancelling",
  "cancelled",
];

export interface ClientApiRequest {
  method: string;
  /** Pathname only, beginning with /api/v1. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Socket remote address, used for the per-IP guard. */
  remoteAddress?: string;
  /** UTF-8 JSON body for non-GET requests. */
  body?: string;
}

export interface ClientApiResponse {
  status: number;
  body: unknown;
}

export type EventStreamSetup =
  | { ok: true; after: number; limit: number }
  | { ok: false; status: number; body: unknown };

export interface ClientApiDeps {
  store: Store;
  services: Pick<
    AppServices,
    | "tasks"
    | "actions"
    | "effects"
    | "taskService"
    | "actionService"
    | "memory"
    | "reminders"
    | "confirmation"
    | "plugins"
    | "skills"
  >;
  ownerId: string;
  /** Local bootstrap credential; device token hashes are also accepted. */
  adminToken?: string;
  /** Per-credential fixed-window request limit; defaults to 600/min. */
  rateLimitPerMinute?: number;
  /** Per-IP fixed-window request limit; defaults to 1200/min. */
  ipRateLimitPerMinute?: number;
  now?: () => Date;
}

type Auth =
  | { kind: "admin" }
  | { kind: "token"; record: ClientTokenRecord };

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function errorResponse(error: unknown): ClientApiResponse {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message },
    };
  }
  // Do not expose SQL/stack details to a client. The HTTP layer logs only
  // method/path/status; the owning process has the server error log.
  return { status: 500, body: { error: "internal_error" } };
}

function hasScope(auth: Auth, scope: ClientScope): boolean {
  return auth.kind === "admin" || auth.record.scopes.includes(scope);
}

function bearer(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  if (raw === undefined || !raw.startsWith("Bearer ")) {
    return undefined;
  }
  return raw.slice("Bearer ".length);
}

function tokenHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const MANDATE_PROJECT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function parseMandate(value: unknown): Mandate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_mandate", "mandate must be an object");
  }
  const object = value as Record<string, unknown>;
  const resources = parseStringArray(object.resources, "mandate.resources");
  const tools = parseStringArray(object.tools, "mandate.tools");
  const skills =
    object.skills === undefined
      ? undefined
      : parseStringArray(object.skills, "mandate.skills");
  if (skills !== undefined) {
    for (const skill of skills) {
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(skill)) {
        throw new ApiError(400, "invalid_mandate", "mandate.skills must be dotted skill ids");
      }
    }
  }
  const notes = object.notes === undefined ? undefined : parseString(object.notes, "mandate.notes", 2_000);
  const project =
    object.project === undefined
      ? undefined
      : parseString(object.project, "mandate.project", 64);
  if (
    project !== undefined &&
    !MANDATE_PROJECT_PATTERN.test(project)
  ) {
    throw new ApiError(
      400,
      "invalid_mandate",
      "mandate.project must be 1-64 letters, digits, dot, underscore or dash",
    );
  }
  return { resources, tools, skills, notes, project };
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(400, "invalid_request", `${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", `${name} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ApiError(400, "invalid_request", `${name} must be 1-${max} characters`);
  }
  return trimmed;
}

function parseLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) {
    return 20;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > MAX_LIMIT) {
    throw new ApiError(400, "invalid_limit", `limit must be 1-${MAX_LIMIT}`);
  }
  return value;
}

function parseCursor(query: URLSearchParams): number {
  const raw = query.get("after") ?? query.get("cursor") ?? "0";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new ApiError(400, "invalid_cursor", "after must be a non-negative integer");
  }
  return value;
}

function parseStatus(query: URLSearchParams): TaskStatus | undefined {
  const raw = query.get("status");
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  if (!(TASK_STATUSES as readonly string[]).includes(raw)) {
    throw new ApiError(400, "invalid_status", `status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return raw as TaskStatus;
}

function idempotencyKey(request: ClientApiRequest): string {
  const raw = request.headers["idempotency-key"] ?? request.headers["Idempotency-Key"];
  if (raw === undefined) {
    throw new ApiError(400, "idempotency_key_required", "Idempotency-Key header is required");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-128 safe characters");
  }
  return raw;
}

function sameTaskRequest(
  task: TaskRecord,
  goal: string,
  completionCriteria: string,
  mandate: Mandate,
  priority: number,
  deadline: string | undefined,
  extensionPolicy: ExtensionPolicy | undefined,
): boolean {
  return (
    task.goal === goal &&
    task.completionCriteria === completionCriteria &&
    task.priority === priority &&
    task.deadline === deadline &&
    task.mandate.resources.join("\u0000") === mandate.resources.join("\u0000") &&
    task.mandate.tools.join("\u0000") === mandate.tools.join("\u0000") &&
    (task.mandate.skills ?? []).join("\u0000") === (mandate.skills ?? []).join("\u0000") &&
    task.mandate.notes === mandate.notes &&
    task.mandate.project === mandate.project &&
    policyKey(task.extension?.policy) === policyKey(extensionPolicy)
  );
}

function policyKey(policy: ExtensionPolicy | undefined): string {
  if (policy === undefined) {
    return "null";
  }
  return stableStringify({
    ...(policy.plugins === undefined ? {} : { plugins: policy.plugins }),
    ...(policy.skills === undefined ? {} : { skills: policy.skills }),
    ...(policy.permissions === undefined
      ? {}
      : { permissions: policy.permissions }),
  });
}

function parseExtensionPolicy(value: unknown): ExtensionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_extension_policy", "extensionPolicy must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["plugins", "skills", "permissions"].includes(key)) {
      throw new ApiError(400, "invalid_extension_policy", `unknown extensionPolicy key: ${key}`);
    }
  }
  const plugins =
    record.plugins === undefined
      ? undefined
      : parseStringArray(record.plugins, "extensionPolicy.plugins");
  const skills =
    record.skills === undefined
      ? undefined
      : parseStringArray(record.skills, "extensionPolicy.skills");
  if (plugins !== undefined && plugins.length > 20) {
    throw new ApiError(400, "invalid_extension_policy", "extensionPolicy.plugins has too many entries");
  }
  if (skills !== undefined && skills.length > 20) {
    throw new ApiError(400, "invalid_extension_policy", "extensionPolicy.skills has too many entries");
  }
  for (const plugin of plugins ?? []) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(plugin)) {
      throw new ApiError(400, "invalid_extension_policy", `invalid plugin id: ${plugin}`);
    }
  }
  for (const skill of skills ?? []) {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(skill)) {
      throw new ApiError(400, "invalid_extension_policy", `invalid skill id: ${skill}`);
    }
  }
  let permissions: Record<string, "allow" | "require_approval" | "deny"> | undefined;
  if (record.permissions !== undefined) {
    if (
      typeof record.permissions !== "object" ||
      record.permissions === null ||
      Array.isArray(record.permissions)
    ) {
      throw new ApiError(400, "invalid_extension_policy", "extensionPolicy.permissions must be an object");
    }
    const entries = Object.entries(record.permissions);
    if (entries.length > 50) {
      throw new ApiError(400, "invalid_extension_policy", "extensionPolicy.permissions has too many entries");
    }
    permissions = {};
    for (const [permission, decision] of entries) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(permission)) {
        throw new ApiError(400, "invalid_extension_policy", `invalid permission: ${permission}`);
      }
      if (decision !== "allow" && decision !== "require_approval" && decision !== "deny") {
        throw new ApiError(400, "invalid_extension_policy", `invalid decision for ${permission}`);
      }
      permissions[permission] = decision;
    }
  }
  return { plugins, skills, permissions };
}

function parseJsonBody(request: ClientApiRequest): Record<string, unknown> {
  if (request.body === undefined || request.body.trim().length === 0) {
    return {};
  }
  try {
    const value = JSON.parse(request.body) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_json",
      error instanceof Error ? error.message : "body must be a JSON object",
    );
  }
}

/** Public view of an action; nonce/args are owner-visible for decisions. */
function actionView(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    taskId: action.taskId,
    taskRevision: action.taskRevision,
    tool: action.tool,
    args: action.args,
    argsHash: action.argsHash,
    nonce: action.nonce,
    status: action.status,
    expiresAt: action.expiresAt,
    externalRef: action.externalRef,
    lastError: action.lastError,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function tokenView(record: ClientTokenRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    expiresAt: record.expiresAt,
  };
}

/**
 * Local authenticated control/event API. It deliberately delegates every
 * mutation to TaskService/ActionService/reminder services; it never writes
 * pa_* state directly except for client token metadata.
 */
export class ClientApiService {
  readonly #store: Store;
  readonly #services: ClientApiDeps["services"];
  readonly #ownerId: string;
  readonly #adminToken?: string;
  readonly #now: () => Date;
  readonly #tokens: ClientTokenRepository;
  readonly #rateLimit: number;
  readonly #ipRateLimit: number;
  readonly #rateWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(deps: ClientApiDeps) {
    this.#store = deps.store;
    this.#services = deps.services;
    this.#ownerId = deps.ownerId;
    this.#adminToken = deps.adminToken;
    this.#now = deps.now ?? (() => new Date());
    this.#tokens = new ClientTokenRepository(deps.store.db);
    this.#rateLimit = Math.max(1, deps.rateLimitPerMinute ?? 600);
    this.#ipRateLimit = Math.max(1, deps.ipRateLimitPerMinute ?? 1_200);
  }

  async handle(request: ClientApiRequest): Promise<ClientApiResponse> {
    try {
      if (!request.path.startsWith(`${API_PREFIX}/`)) {
        throw new ApiError(404, "not_found");
      }
      const auth = this.#authenticate(request);
      const relative = request.path.slice(API_PREFIX.length);
      let segments: string[];
      try {
        segments = relative
          .split("/")
          .filter((part) => part.length > 0)
          .map(decodeURIComponent);
      } catch {
        throw new ApiError(400, "invalid_path");
      }
      return await this.#route(request, auth, segments);
    } catch (error) {
      return errorResponse(error);
    }
  }

  /**
   * HTTP servers use this before switching a response to text/event-stream.
   * Reuses the same bearer/scope checks as the JSON API; Last-Event-ID is
   * honored only when no explicit `after` query is present.
   */
  prepareEventStream(request: ClientApiRequest): EventStreamSetup {
    try {
      this.#require(this.#authenticate(request), "read");
      if (request.method.toUpperCase() !== "GET") {
        throw new ApiError(405, "method_not_allowed");
      }
      const query = new URLSearchParams(request.query);
      if (!query.has("after") && !query.has("cursor")) {
        const lastEventId = request.headers["last-event-id"];
        if (lastEventId !== undefined) {
          query.set("after", lastEventId);
        }
      }
      return { ok: true, after: parseCursor(query), limit: parseLimit(query) };
    } catch (error) {
      const mapped = errorResponse(error);
      return { ok: false, status: mapped.status, body: mapped.body };
    }
  }

  eventsSince(after: number, limit: number): AuditFeedItem[] {
    return this.#store.listAuditAfter(after, limit);
  }

  #authenticate(request: ClientApiRequest): Auth {
    this.#checkRate(
      `ip:${request.remoteAddress ?? "unknown"}`,
      this.#ipRateLimit,
    );
    const raw = bearer(request.headers);
    if (raw === undefined || raw.length === 0) {
      throw new ApiError(401, "unauthorized");
    }
    if (this.#adminToken !== undefined && safeEqual(this.#adminToken, raw)) {
      this.#checkRate("admin", this.#rateLimit);
      return { kind: "admin" };
    }
    if (raw.startsWith(TOKEN_PREFIX)) {
      const record = this.#tokens.findByHash(tokenHash(raw));
      if (
        record === undefined ||
        record.ownerId !== this.#ownerId ||
        (record.expiresAt !== undefined && record.expiresAt <= this.#now().toISOString())
      ) {
        throw new ApiError(401, "unauthorized");
      }
      this.#tokens.touch(record.id, this.#now().toISOString());
      this.#checkRate(`token:${record.id}`, this.#rateLimit);
      return { kind: "token", record };
    }
    throw new ApiError(401, "unauthorized");
  }

  #checkRate(key: string, limit: number): void {
    const now = this.#now().getTime();
    const current = this.#rateWindows.get(key);
    if (current === undefined || now - current.startedAt >= 60_000) {
      this.#rateWindows.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= limit) {
      throw new ApiError(429, "rate_limited", `at most ${limit} requests/minute`);
    }
    current.count += 1;
  }

  #require(auth: Auth, scope: ClientScope): void {
    if (!hasScope(auth, scope)) {
      throw new ApiError(403, "forbidden", `token lacks ${scope} scope`);
    }
  }

  async #route(
    request: ClientApiRequest,
    auth: Auth,
    segments: string[],
  ): Promise<ClientApiResponse> {
    const [resource, id, action] = segments;
    const method = request.method.toUpperCase();

    if (resource === "health" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return { status: 200, body: { ok: true, apiVersion: CLIENT_API_VERSION, ownerId: this.#ownerId } };
    }

    if (resource === "status" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return { status: 200, body: this.#status() };
    }
    if (resource === "diagnostics" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return { status: 200, body: this.#diagnostics() };
    }
    if (resource === "usage" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return { status: 200, body: this.#usage() };
    }

    if (resource === "tasks") {
      if (id === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { tasks: this.#listTasks(request) } };
      }
      if (id === undefined && method === "POST") {
        this.#require(auth, "write");
        return this.#createTask(request);
      }
      if (id !== undefined && action === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: this.#getTask(id) };
      }
      if (id !== undefined && action === "cancel" && method === "POST") {
        this.#require(auth, "write");
        return this.#cancelTask(id);
      }
      if (id !== undefined && action === "revise" && method === "POST") {
        this.#require(auth, "write");
        return this.#reviseTask(id, request);
      }
      if (id !== undefined && action === "supplement" && method === "POST") {
        this.#require(auth, "write");
        return this.#supplementTask(id, request);
      }
    }

    if (resource === "approvals") {
      if (id === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { approvals: this.#listApprovals() } };
      }
      if (id !== undefined && action === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { approval: this.#getApproval(id) } };
      }
      if (id !== undefined && action === "approve" && method === "POST") {
        this.#require(auth, "approve");
        return this.#decideApproval(id, request, true);
      }
      if (id !== undefined && action === "deny" && method === "POST") {
        this.#require(auth, "approve");
        return this.#decideApproval(id, request, false);
      }
    }

    if (resource === "memories") {
      if (id === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { memories: this.#services.memory.list(this.#ownerId, request.query.get("project") ?? undefined) } };
      }
      if (id === undefined && method === "POST") {
        this.#require(auth, "write");
        return this.#saveMemory(request);
      }
      if (id !== undefined && method === "DELETE") {
        this.#require(auth, "write");
        return this.#forgetMemory(id, request.query.get("project") ?? undefined);
      }
    }

    if (resource === "reminders") {
      if (id === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { reminders: this.#services.reminders.list(this.#ownerId) } };
      }
      if (id === undefined && method === "POST") {
        this.#require(auth, "write");
        return this.#createReminder(request);
      }
      if (id !== undefined && method === "DELETE") {
        this.#require(auth, "write");
        return this.#cancelReminder(id);
      }
      if (id !== undefined && method === "PATCH") {
        this.#require(auth, "write");
        return this.#updateReminder(id, request);
      }
    }

    if (resource === "plugins") {
      if (id === undefined && method === "GET") {
        this.#require(auth, "read");
        return { status: 200, body: { plugins: await this.#services.plugins.list() } };
      }
      if (id !== undefined && action === undefined && method === "GET") {
        this.#require(auth, "read");
        const plugin = await this.#services.plugins.get(id);
        if (plugin === undefined) {
          throw new ApiError(404, "plugin_not_found");
        }
        return { status: 200, body: { plugin } };
      }
      if (
        id !== undefined &&
        (action === "enable" || action === "disable") &&
        method === "POST"
      ) {
        this.#require(auth, "write");
        const actorId =
          auth.kind === "admin" ? "admin" : `token:${auth.record.id}`;
        try {
          const result =
            action === "enable"
              ? await this.#services.plugins.enable(id, actorId)
              : await this.#services.plugins.disable(id, actorId);
          return { status: 200, body: result };
        } catch (error) {
          if (error instanceof PluginNotFoundError) {
            throw new ApiError(404, "plugin_not_found");
          }
          if (error instanceof PluginNotConfiguredError) {
            throw new ApiError(409, "plugin_not_configured");
          }
          throw error;
        }
      }
    }

    if (resource === "skills" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return {
        status: 200,
        body: {
          available: this.#services.skills !== undefined,
          skills: this.#services.skills?.list() ?? [],
        },
      };
    }

    if (resource === "events" && id === undefined && method === "GET") {
      this.#require(auth, "read");
      return { status: 200, body: this.#events(request) };
    }

    if (resource === "tokens") {
      if (auth.kind !== "admin") {
        throw new ApiError(403, "forbidden", "admin credential required");
      }
      if (id === undefined && method === "GET") {
        return { status: 200, body: { tokens: this.#tokens.listByOwner(this.#ownerId).map(tokenView) } };
      }
      if (id === undefined && method === "POST") {
        return this.#createToken(request);
      }
      if (id !== undefined && method === "DELETE") {
        const at = this.#now().toISOString();
        const revoked = this.#tokens.revoke(id, this.#ownerId, at);
        if (revoked) {
          this.#store.recordAudit({
            event: "client_token.revoked",
            subjectType: "client_token",
            subjectId: id,
            traceId: `client_token:${id}`,
            occurredAt: at,
          });
        }
        return { status: 200, body: { revoked } };
      }
    }

    throw new ApiError(404, "not_found");
  }

  #listTasks(request: ClientApiRequest): TaskRecord[] {
    const status = parseStatus(request.query);
    const limit = parseLimit(request.query);
    return status === undefined
      ? this.#services.tasks.listByOwner(this.#ownerId, limit)
      : this.#services.tasks.listByOwnerStatus(this.#ownerId, status, limit);
  }

  #getTask(taskId: string): Record<string, unknown> {
    const task = this.#requireTask(taskId);
    return {
      task,
      assignments: this.#services.tasks.listAssignments(taskId),
      actions: this.#services.actions.listByTask(taskId).map(actionView),
      inputs: this.#services.tasks.listInputs(taskId),
    };
  }

  #requireTask(taskId: string): TaskRecord {
    const task = this.#services.tasks.get(taskId);
    if (task === undefined || task.ownerId !== this.#ownerId) {
      throw new ApiError(404, "task_not_found");
    }
    return task;
  }

  #createTask(request: ClientApiRequest): ClientApiResponse {
    const body = parseJsonBody(request);
    const key = idempotencyKey(request);
    const goal = parseString(body.goal, "goal", 10_000);
    const completionCriteria = parseString(body.completionCriteria, "completionCriteria", 10_000);
    const mandate =
      body.mandate === undefined
        ? { resources: ["chat"], tools: [] }
        : parseMandate(body.mandate);
    const extensionPolicy = parseExtensionPolicy(body.extensionPolicy);
    const priority = body.priority === undefined ? 0 : this.#parseInteger(body.priority, "priority", 0, 100);
    const deadline =
      body.deadline === undefined
        ? undefined
        : this.#parseFutureDateTime(body.deadline, "deadline");
    const conversation = this.#store.latestConversation(this.#ownerId);
    if (conversation === undefined) {
      throw new ApiError(409, "no_owner_conversation", "the owner has no bound conversation for task replies");
    }
    const sourceKey = `api:${this.#ownerId}:${key}`;
    const existing = this.#services.tasks.getBySourceKey(sourceKey);
    if (existing !== undefined) {
      if (!sameTaskRequest(existing, goal, completionCriteria, mandate, priority, deadline, extensionPolicy)) {
        throw new ApiError(409, "idempotency_conflict");
      }
      return { status: 200, body: { task: existing } };
    }
    let task: TaskRecord;
    try {
      task = this.#services.taskService.create({
        ownerId: this.#ownerId,
        conversationId: conversation.id,
        sourceKey,
        goal,
        completionCriteria,
        mandate,
        priority,
        deadline,
        extensionPolicy,
      });
    } catch (error) {
      if (error instanceof ExtensionPolicyError) {
        throw new ApiError(400, "invalid_extension_policy", error.message);
      }
      throw error;
    }
    return { status: 201, body: { task } };
  }

  #cancelTask(taskId: string): ClientApiResponse {
    this.#requireTask(taskId);
    const task = this.#services.taskService.cancel(taskId);
    if (task === undefined) {
      throw new ApiError(404, "task_not_found");
    }
    return { status: 200, body: { task } };
  }

  #reviseTask(taskId: string, request: ClientApiRequest): ClientApiResponse {
    const existing = this.#requireTask(taskId);
    const body = parseJsonBody(request);
    const expectedRevision = this.#parseInteger(body.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    if (existing.revision !== expectedRevision) {
      throw new ApiError(409, "revision_mismatch", `current revision is ${existing.revision}`);
    }
    const changes: Parameters<AppServices["taskService"]["revise"]>[1] = {};
    if (body.goal !== undefined) {
      changes.goal = parseString(body.goal, "goal", 10_000);
    }
    if (body.completionCriteria !== undefined) {
      changes.completionCriteria = parseString(body.completionCriteria, "completionCriteria", 10_000);
    }
    if (body.mandate !== undefined) {
      changes.mandate = parseMandate(body.mandate);
    }
    if (body.priority !== undefined) {
      changes.priority = this.#parseInteger(body.priority, "priority", 0, 100);
    }
    if (Object.keys(changes).length === 0) {
      throw new ApiError(400, "no_changes");
    }
    let task: TaskRecord | undefined;
    try {
      task = this.#services.taskService.revise(taskId, changes);
    } catch (error) {
      if (error instanceof ExtensionPolicyError) {
        throw new ApiError(400, "invalid_extension_policy", error.message);
      }
      throw error;
    }
    if (task === undefined) {
      throw new ApiError(404, "task_not_found");
    }
    return { status: 200, body: { task } };
  }

  #supplementTask(taskId: string, request: ClientApiRequest): ClientApiResponse {
    const task = this.#requireTask(taskId);
    const key = idempotencyKey(request);
    const body = parseJsonBody(request);
    const text = parseString(body.text, "text", 10_000);
    const sourceId = `api:${key}`;
    const existing = this.#services.tasks
      .listInputs(task.id)
      .find((input) => input.sourceInboxId === sourceId);
    if (existing !== undefined) {
      if (existing.text !== text) {
        throw new ApiError(409, "idempotency_conflict");
      }
      return { status: 200, body: { input: existing, task } };
    }
    const added = this.#services.taskService.supplement(task.id, text, sourceId);
    if (added === undefined) {
      throw new ApiError(409, "task_not_accepting_input");
    }
    return { status: 201, body: { input: added.input, task: added.task } };
  }

  #listApprovals(): Record<string, unknown>[] {
    return this.#services.actions
      .listProposedByOwner(this.#ownerId, this.#now().toISOString())
      .map(actionView);
  }

  #getApproval(actionId: string): Record<string, unknown> {
    const action = this.#services.actions.get(actionId);
    if (action === undefined || action.ownerId !== this.#ownerId) {
      throw new ApiError(404, "approval_not_found");
    }
    return actionView(action);
  }

  #decideApproval(
    actionId: string,
    request: ClientApiRequest,
    approve: boolean,
  ): ClientApiResponse {
    const action = this.#services.actions.get(actionId);
    if (action === undefined || action.ownerId !== this.#ownerId) {
      throw new ApiError(404, "approval_not_found");
    }
    const body = parseJsonBody(request);
    const nonce = parseString(body.nonce, "nonce", 256);
    const argsHash = parseString(body.argsHash, "argsHash", 256);
    const taskRevision = this.#parseInteger(body.taskRevision, "taskRevision", 1, Number.MAX_SAFE_INTEGER);
    if (action.nonce !== nonce || action.argsHash !== argsHash || action.taskRevision !== taskRevision) {
      throw new ApiError(409, "approval_binding_mismatch");
    }
    // The approval is still bound to the original conversation; the API is
    // an authenticated owner control plane, not a new conversation identity.
    if (approve) {
      const result = this.#services.actionService.approve({
        actionId,
        nonce,
        approverId: this.#ownerId,
        conversationId: action.conversationId,
        expectedArgsHash: argsHash,
        expectedTaskRevision: taskRevision,
      });
      if (!result.ok) {
        throw new ApiError(409, result.reason ?? "approval_failed");
      }
      return {
        status: 200,
        body: { action: result.action ?? this.#services.actions.get(actionId) },
      };
    }
    const result = this.#services.actionService.deny({
      actionId,
      nonce,
      approverId: this.#ownerId,
      conversationId: action.conversationId,
      expectedArgsHash: argsHash,
      expectedTaskRevision: taskRevision,
    });
    if (!result.ok) {
      throw new ApiError(409, result.reason ?? "approval_failed");
    }
    return {
      status: 200,
      body: { action: this.#services.actions.get(actionId) },
    };
  }

  #saveMemory(request: ClientApiRequest): ClientApiResponse {
    const body = parseJsonBody(request);
    const key = parseString(body.key, "key", 64);
    const value = parseString(body.value, "value", 1_000);
    const project = body.project === undefined ? undefined : parseString(body.project, "project", 64);
    try {
      const memory = this.#services.memory.save(this.#ownerId, key, value, undefined, project);
      return { status: 200, body: { memory } };
    } catch (error) {
      throw new ApiError(400, "invalid_memory", error instanceof Error ? error.message : String(error));
    }
  }

  #forgetMemory(key: string, project: string | undefined): ClientApiResponse {
    try {
      const memory = this.#services.memory.forget(this.#ownerId, key, project);
      if (memory === undefined) {
        throw new ApiError(404, "memory_not_found");
      }
      return { status: 200, body: { memory } };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "invalid_memory", error instanceof Error ? error.message : String(error));
    }
  }

  async #createReminder(request: ClientApiRequest): Promise<ClientApiResponse> {
    const body = parseJsonBody(request);
    const text = parseString(body.text, "text", 1_000);
    const dueAt = this.#parseFutureDateTime(body.dueAt, "dueAt");
    const timezone = body.timezone === undefined ? "UTC" : parseString(body.timezone, "timezone", 100);
    const conversation = this.#store.latestConversation(this.#ownerId);
    if (conversation === undefined) {
      throw new ApiError(409, "no_owner_conversation", "the owner has no bound conversation for reminders");
    }
    try {
      const reminder = await this.#services.reminders.create({
        ownerId: this.#ownerId,
        conversationId: conversation.id,
        text,
        dueAt,
        timezone,
      });
      return { status: 201, body: { reminder } };
    } catch (error) {
      throw new ApiError(400, "invalid_reminder", error instanceof Error ? error.message : String(error));
    }
  }

  async #updateReminder(id: string, request: ClientApiRequest): Promise<ClientApiResponse> {
    const body = parseJsonBody(request);
    const changes: { text?: string; dueAt?: string; timezone?: string } = {};
    if (body.text !== undefined) changes.text = parseString(body.text, "text", 1_000);
    if (body.dueAt !== undefined) {
      changes.dueAt = this.#parseFutureDateTime(body.dueAt, "dueAt");
    }
    if (body.timezone !== undefined) {
      changes.timezone = parseString(body.timezone, "timezone", 100);
    }
    if (Object.keys(changes).length === 0) {
      throw new ApiError(400, "no_changes");
    }
    const result = await this.#services.reminders.update(id, this.#ownerId, changes);
    if (!result.ok) {
      throw new ApiError(
        result.reason === "schedule_not_found" ? 404 : 409,
        result.reason ?? "reminder_failed",
      );
    }
    return { status: 200, body: { reminder: result.schedule } };
  }

  async #cancelReminder(id: string): Promise<ClientApiResponse> {
    const result = await this.#services.reminders.cancel(id, this.#ownerId);
    if (!result.ok) {
      throw new ApiError(result.reason === "schedule_not_found" ? 404 : 409, result.reason ?? "reminder_failed");
    }
    return { status: 200, body: { reminder: result.schedule } };
  }

  #events(request: ClientApiRequest): Record<string, unknown> {
    const after = parseCursor(request.query);
    const limit = parseLimit(request.query);
    const events = this.#store.listAuditAfter(after, limit);
    const last = events.at(-1);
    return {
      events,
      nextCursor: last?.cursor ?? after,
    };
  }

  #status(): Record<string, unknown> {
    return {
      apiVersion: CLIENT_API_VERSION,
      ownerId: this.#ownerId,
      generatedAt: this.#now().toISOString(),
      diagnostics: this.#diagnostics(),
      usage: this.#usage(),
    };
  }

  #diagnostics(): unknown {
    return buildDiagnostics(
      {
        store: this.#store,
        tasks: this.#services.tasks,
        actions: this.#services.actions,
        effects: this.#services.effects,
        confirmations: this.#services.confirmation,
      },
      this.#now().toISOString(),
      { ownerId: this.#ownerId, limit: 20 },
    );
  }

  #usage(): unknown {
    return buildUsage(
      {
        store: this.#store,
        tasks: this.#services.tasks,
        actions: this.#services.actions,
        effects: this.#services.effects,
        confirmations: this.#services.confirmation,
      },
      this.#now().toISOString(),
    );
  }

  #createToken(request: ClientApiRequest): ClientApiResponse {
    const body = parseJsonBody(request);
    const name = parseString(body.name, "name", 64);
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new ApiError(400, "invalid_request", "name contains control characters");
    }
    const scopes = this.#parseScopes(body.scopes);
    const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const createdAt = this.#now().toISOString();
    const ttlDays =
      body.ttlDays === undefined
        ? undefined
        : this.#parseInteger(body.ttlDays, "ttlDays", 1, 365);
    const record = this.#tokens.create({
      ownerId: this.#ownerId,
      name,
      tokenHash: tokenHash(raw),
      scopes,
      createdAt,
      expiresAt:
        ttlDays === undefined
          ? undefined
          : new Date(this.#now().getTime() + ttlDays * 86_400_000).toISOString(),
    });
    this.#store.recordAudit({
      event: "client_token.created",
      subjectType: "client_token",
      subjectId: record.id,
      after: { name: record.name, scopes: record.scopes },
      traceId: `client_token:${record.id}`,
      occurredAt: createdAt,
    });
    return { status: 201, body: { token: raw, record: tokenView(record) } };
  }

  #parseScopes(value: unknown): ClientScope[] {
    if (value === undefined) {
      return ["read"];
    }
    const raw = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\s,]+/)
        : undefined;
    if (raw === undefined || raw.length === 0) {
      throw new ApiError(400, "invalid_scopes");
    }
    const scopes = raw.filter((item): item is string => typeof item === "string");
    const invalid = scopes.filter(
      (scope) => !(CLIENT_SCOPES as readonly string[]).includes(scope),
    );
    if (invalid.length > 0) {
      throw new ApiError(400, "invalid_scopes", `allowed scopes: ${CLIENT_SCOPES.join(", ")}`);
    }
    return [...new Set(scopes as ClientScope[])];
  }

  #parseInteger(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ApiError(400, "invalid_request", `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }

  #parseFutureDateTime(value: unknown, name: string): string {
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_request", `${name} must be an ISO timestamp`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getTime() <= this.#now().getTime()) {
      throw new ApiError(400, "invalid_request", `${name} must be in the future`);
    }
    return date.toISOString();
  }
}
