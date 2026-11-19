import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClientApiService } from "../src/client-api.ts";
import { hashArgs } from "../src/actions/tools.ts";
import type { ClientApiRequest } from "../src/client-api.ts";
import { createServices, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

function fixture() {
  const services = createServices({ now: () => NOW });
  const api = new ClientApiService({
    store: services.store,
    services,
    ownerId: services.owner.id,
    adminToken: ADMIN,
    now: () => NOW,
  });
  return { services, api };
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(options.query),
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  return api.handle(request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

function createTask(
  api: ClientApiService,
  key = "task-1",
  token = ADMIN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return call(api, "POST", "/api/v1/tasks", {
    token,
    headers: { "idempotency-key": key },
    body: {
      goal: "check lamp",
      completionCriteria: "lamp reports a result",
      mandate: { resources: ["chat"], tools: [] },
    },
  });
}

describe("client API", () => {
  it("requires a bearer token and distinguishes admin from scoped devices", async () => {
    const { api } = fixture();
    assert.equal((await call(api, "GET", "/api/v1/health")).status, 401);
    const admin = await call(api, "GET", "/api/v1/health", { token: ADMIN });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.apiVersion, 1);
    const stream = api.prepareEventStream({
      method: "GET",
      path: "/api/v1/events/stream",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${ADMIN}`, "last-event-id": "5" },
    });
    assert.equal(stream.ok, true);
    if (stream.ok) assert.equal(stream.after, 5);

    const created = await call(api, "POST", "/api/v1/tokens", {
      token: ADMIN,
      body: { name: "laptop", scopes: ["read"] },
    });
    assert.equal(created.status, 201);
    const raw = created.body.token as string;
    assert.match(raw, /^pa_/);

    const read = await call(api, "GET", "/api/v1/tasks", { token: raw });
    assert.equal(read.status, 200);
    const denied = await createTask(api, "token-write", raw);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "forbidden");

    const tokens = await call(api, "GET", "/api/v1/tokens", { token: ADMIN });
    const record = (tokens.body.tokens as { id: string }[])[0] as { id: string };
    assert.equal((await call(api, "DELETE", `/api/v1/tokens/${record.id}`, { token: ADMIN })).status, 200);
    assert.equal((await call(api, "GET", "/api/v1/tasks", { token: raw })).status, 401);
  });

  it("creates idempotent tasks and exposes detail/cancel", async () => {
    const { api } = fixture();
    const first = await createTask(api);
    assert.equal(first.status, 201);
    const task = first.body.task as { id: string; status: string };
    assert.equal(task.status, "queued");

    const retry = await createTask(api);
    assert.equal(retry.status, 200);
    assert.equal((retry.body.task as { id: string }).id, task.id);

    const conflict = await call(api, "POST", "/api/v1/tasks", {
      token: ADMIN,
      headers: { "idempotency-key": "task-1" },
      body: { goal: "different", completionCriteria: "different" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "idempotency_conflict");

    const list = await call(api, "GET", "/api/v1/tasks", { token: ADMIN });
    assert.equal((list.body.tasks as unknown[]).length, 1);
    const detail = await call(api, "GET", `/api/v1/tasks/${task.id}`, { token: ADMIN });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.assignments, []);
    assert.deepEqual(detail.body.inputs, []);

    const supplement = await call(api, "POST", `/api/v1/tasks/${task.id}/supplement`, {
      token: ADMIN,
      headers: { "idempotency-key": "input-1" },
      body: { text: "also check the plug" },
    });
    assert.equal(supplement.status, 201);
    const retried = await call(api, "POST", `/api/v1/tasks/${task.id}/supplement`, {
      token: ADMIN,
      headers: { "idempotency-key": "input-1" },
      body: { text: "also check the plug" },
    });
    assert.equal(retried.status, 200);
    const changed = await call(api, "POST", `/api/v1/tasks/${task.id}/supplement`, {
      token: ADMIN,
      headers: { "idempotency-key": "input-1" },
      body: { text: "different" },
    });
    assert.equal(changed.status, 409);

    const revised = await call(api, "POST", `/api/v1/tasks/${task.id}/revise`, {
      token: ADMIN,
      body: { expectedRevision: 1, goal: "check both" },
    });
    assert.equal(revised.status, 200);
    assert.equal((revised.body.task as { revision: number }).revision, 2);
    const stale = await call(api, "POST", `/api/v1/tasks/${task.id}/revise`, {
      token: ADMIN,
      body: { expectedRevision: 1, goal: "stale" },
    });
    assert.equal(stale.status, 409);

    const cancelled = await call(api, "POST", `/api/v1/tasks/${task.id}/cancel`, { token: ADMIN });
    assert.equal(cancelled.status, 200);
    assert.ok(["cancelled", "cancelling"].includes((cancelled.body.task as { status: string }).status));
  });

  it("lists, binds and decides approvals without changing conversation identity", async () => {
    const { services, api } = fixture();
    const created = await call(api, "POST", "/api/v1/tasks", {
      token: ADMIN,
      headers: { "idempotency-key": "approval-task" },
      body: {
        goal: "set lamp",
        completionCriteria: "lamp changed",
        mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
      },
    });
    const task = created.body.task as { id: string; revision: number; conversationId: string };
    const args = { brightness: 42 };
    const action = services.actions.insert({
      ownerId: services.owner.id,
      conversationId: task.conversationId,
      taskId: task.id,
      taskRevision: task.revision,
      fencingToken: 1,
      tool: "lamp.set_brightness",
      args,
      argsHash: hashArgs("lamp.set_brightness", args),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: "nonce-1",
      createdAt: NOW.toISOString(),
    }).action;

    const list = await call(api, "GET", "/api/v1/approvals", { token: ADMIN });
    assert.equal((list.body.approvals as unknown[]).length, 1);
    const binding = {
      nonce: action.nonce,
      argsHash: action.argsHash,
      taskRevision: action.taskRevision,
    };
    const mismatch = await call(api, "POST", `/api/v1/approvals/${action.id}/approve`, {
      token: ADMIN,
      body: { ...binding, argsHash: "wrong" },
    });
    assert.equal(mismatch.status, 409);

    const approved = await call(api, "POST", `/api/v1/approvals/${action.id}/approve`, {
      token: ADMIN,
      body: binding,
    });
    assert.equal(approved.status, 200);
    assert.equal((approved.body.action as { status: string }).status, "approved");
    const repeat = await call(api, "POST", `/api/v1/approvals/${action.id}/approve`, {
      token: ADMIN,
      body: binding,
    });
    assert.equal(repeat.status, 409);
    assert.equal(services.actions.get(action.id)?.approvedBy, services.owner.id);
  });

  it("lets only one of two concurrent clients consume an approval", async () => {
    const { services, api } = fixture();
    const created = await call(api, "POST", "/api/v1/tasks", {
      token: ADMIN,
      headers: { "idempotency-key": "concurrent-approval" },
      body: {
        goal: "set lamp",
        completionCriteria: "lamp changed",
        mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
      },
    });
    const task = created.body.task as { id: string; revision: number; conversationId: string };
    const args = { brightness: 7 };
    const action = services.actions.insert({
      ownerId: services.owner.id,
      conversationId: task.conversationId,
      taskId: task.id,
      taskRevision: task.revision,
      fencingToken: 1,
      tool: "lamp.set_brightness",
      args,
      argsHash: hashArgs("lamp.set_brightness", args),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: "concurrent-nonce",
      createdAt: NOW.toISOString(),
    }).action;
    const binding = {
      nonce: action.nonce,
      argsHash: action.argsHash,
      taskRevision: action.taskRevision,
    };
    const results = await Promise.all([
      call(api, "POST", `/api/v1/approvals/${action.id}/approve`, { token: ADMIN, body: binding }),
      call(api, "POST", `/api/v1/approvals/${action.id}/approve`, { token: ADMIN, body: binding }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(services.actions.get(action.id)?.status, "approved");
  });

  it("exposes memory, reminders, diagnostics and a replayable event cursor", async () => {
    const { api } = fixture();
    const memory = await call(api, "POST", "/api/v1/memories", {
      token: ADMIN,
      body: { key: "city", value: "Shanghai", project: "alpha" },
    });
    assert.equal(memory.status, 200);
    const memories = await call(api, "GET", "/api/v1/memories", {
      token: ADMIN,
      query: { project: "alpha" },
    });
    assert.equal((memories.body.memories as unknown[]).length, 1);
    assert.equal((await call(api, "DELETE", "/api/v1/memories/city", {
      token: ADMIN,
      query: { project: "alpha" },
    })).status, 200);

    const reminder = await call(api, "POST", "/api/v1/reminders", {
      token: ADMIN,
      body: {
        text: "drink water",
        dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        timezone: "UTC",
      },
    });
    assert.equal(reminder.status, 201);
    const reminders = await call(api, "GET", "/api/v1/reminders", { token: ADMIN });
    assert.equal((reminders.body.reminders as unknown[]).length, 1);
    const schedule = reminder.body.reminder as { id: string };
    assert.equal((await call(api, "DELETE", `/api/v1/reminders/${schedule.id}`, { token: ADMIN })).status, 200);

    const status = await call(api, "GET", "/api/v1/status", { token: ADMIN });
    assert.equal(status.status, 200);
    assert.ok(status.body.diagnostics !== undefined);
    assert.ok(status.body.usage !== undefined);

    const events = await call(api, "GET", "/api/v1/events", { token: ADMIN });
    assert.equal(events.status, 200);
    assert.ok((events.body.events as unknown[]).length > 0);
    const cursor = events.body.nextCursor as number;
    const later = await call(api, "GET", "/api/v1/events", {
      token: ADMIN,
      query: { after: String(cursor) },
    });
    assert.equal(later.status, 200);
    assert.equal((later.body.events as unknown[]).length, 0);
  });

  it("does not expose another owner's task", async () => {
    const { services, api } = fixture();
    const outsider = services.store.bindOwner({
      channel: "feishu",
      accountId: "other-app",
      actorId: "other-user",
      verifiedAt: NOW.toISOString(),
    });
    const conversation = services.store.upsertConversation({
      ownerId: outsider.id,
      channel: "feishu",
      accountId: "other-app",
      platformConversationId: "other-chat",
      kind: "p2p",
      createdAt: NOW.toISOString(),
    });
    const task = services.taskService.create({
      ownerId: outsider.id,
      conversationId: conversation.id,
      sourceKey: "other-task",
      goal: "secret",
      completionCriteria: "secret",
      mandate: { resources: ["chat"], tools: [] },
    });
    assert.equal((await call(api, "GET", `/api/v1/tasks/${task.id}`, { token: ADMIN })).status, 404);
  });
});

export type { TestServices };
