import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

import { createModels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

import { createApp, type AppServices } from "../../apps/agent/src/app.ts";
import { FeishuAdapter } from "../../apps/agent/src/channels/feishu/adapter.ts";
import type { FeishuConfig } from "../../apps/agent/src/channels/feishu/types.ts";
import { decryptFeishuPayload } from "../../apps/agent/src/channels/feishu/crypto.ts";
import { PiRouterModel } from "../../apps/agent/src/coordinator/pi-router.ts";
import { OutboxDispatcher } from "../../apps/agent/src/delivery/outbox.ts";
import { FeishuAuthError, FeishuRequestError } from "../../apps/agent/src/domain/errors.ts";
import type { ReminderTimer } from "../../apps/agent/src/personal/reminders.ts";
import { PiRuntime } from "../../apps/agent/src/runtime/pi.ts";
import type { WakeScheduler } from "../../apps/agent/src/runtime/types.ts";
import { DoDb, type DurableStorageLike } from "../../apps/agent/src/storage/db.ts";
import { openStoreFromDb, type Store } from "../../apps/agent/src/storage/store.ts";

interface Env {
  OPENCODE_API_KEY: string;
  ADMIN_TOKEN?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  FEISHU_ENCRYPT_KEY?: string;
  OWNER_FEISHU_OPEN_ID?: string;
  FEISHU_API_BASE?: string;
  ASSISTANT: DurableObjectNamespace<Assistant>;
}

const MODEL_ID = "deepseek-v4.1-flash";
const MAX_BODY_BYTES = 1_048_576;

interface WorkerServices extends AppServices {
  store: Store;
  dispatcher?: OutboxDispatcher;
  feishu?: FeishuAdapter;
  ownerId?: string;
}

/**
 * One owner gets one Durable Object. PiHarness writes pi_* tables into this
 * object's SQLite database; Lifecycle owns the object's single alarm. The
 * application's pa_* tables live in the same SQLite database through DoDb.
 */
export class Assistant extends DurableObject<Env> {
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels({
        authContext: {
          env: async (name) =>
            name === "OPENCODE_API_KEY" ? this.env.OPENCODE_API_KEY : undefined,
          fileExists: async () => false,
        },
      });
      models.setProvider(opencodeGoProvider());
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context,
      );
    },
    defaults: { model: getBuiltinModel("opencode-go", MODEL_ID) },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  #app: WorkerServices | undefined;

  async onStart(): Promise<void> {
    this.#app = this.#createApp();
  }

  onRequest(request: Request): Response | Promise<Response> {
    return this.#handleRequest(request);
  }

  async ask(prompt: string): Promise<string> {
    await this.lifecycle.start();
    const { text } = await this.harness.prompt(prompt);
    return text ?? "";
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const app = this.#requireApp();

    if (job.fn === "schedule.fire") {
      const scheduleId =
        typeof job.payload === "object" &&
        job.payload !== null &&
        typeof (job.payload as Record<string, unknown>).scheduleId === "string"
          ? ((job.payload as Record<string, unknown>).scheduleId as string)
          : undefined;
      if (scheduleId !== undefined) {
        await app.reminders.fire(scheduleId);
      }
      await this.#runMaintenance();
      return undefined;
    }

    if (job.fn === "maintenance") {
      await this.#runMaintenance();
      const next = this.#nextDueAt(app);
      return next === undefined ? undefined : { rescheduleAt: next };
    }

    return undefined;
  }

  #createApp(): WorkerServices {
    const db = new DoDb(this.ctx.storage as unknown as DurableStorageLike);
    const store = openStoreFromDb(db);

    const ownerOpenId = this.env.OWNER_FEISHU_OPEN_ID?.trim();
    let ownerId: string | undefined;
    if (ownerOpenId !== undefined && ownerOpenId.length > 0) {
      const owner = store.bindOwner({
        channel: "feishu",
        accountId: this.env.FEISHU_APP_ID ?? "feishu",
        actorId: ownerOpenId,
        verifiedAt: new Date().toISOString(),
      });
      ownerId = owner.id;
    }

    const runtime = new PiRuntime(this.harness);

    const wake: WakeScheduler = {
      wake: async (at?: Date) => {
        await this.lifecycle.jobs.push({
          id: "maintenance",
          fn: "maintenance",
          time: at?.getTime() ?? Date.now(),
          payload: {},
        });
      },
    };

    // Lifecycle owns the single alarm, so a reminder is a job, not a timer.
    const timer: ReminderTimer = {
      schedule: async (schedule) => {
        await this.lifecycle.jobs.push({
          id: `schedule:${schedule.id}`,
          fn: "schedule.fire",
          time: Date.parse(schedule.dueAt),
          payload: { scheduleId: schedule.id },
        });
      },
      cancel: async (scheduleId) => {
        await this.lifecycle.jobs.cancel(`schedule:${scheduleId}`);
      },
    };

    const app = createApp({
      store,
      runtime,
      wake,
      reminderTimer: timer,
      model: new PiRouterModel(store, runtime),
    });

    const feishuConfig = readFeishuConfig(this.env);
    const feishu = feishuConfig === undefined ? undefined : new FeishuAdapter(feishuConfig);
    const dispatcher =
      feishu === undefined
        ? undefined
        : new OutboxDispatcher({
            store,
            channel: feishu,
          });

    return {
      ...app,
      store,
      dispatcher,
      feishu,
      ownerId,
    };
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const app = this.#requireApp();

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        runtime: "cloudflare-do",
        feishu: app.feishu !== undefined,
        ownerBound: app.ownerId !== undefined,
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/feishu") {
      return this.#handleFeishuWebhook(request, app);
    }

    if (request.method === "GET" && url.pathname === "/ask") {
      if (!this.#authorize(request)) {
        return this.#adminTokenConfigured()
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : Response.json(
              { error: "admin_token_not_configured" },
              { status: 503 },
            );
      }
      const prompt = url.searchParams.get("prompt") ?? "ping";
      const text = await this.ask(prompt);
      return Response.json({ text });
    }

    if (request.method === "GET" && url.pathname === "/admin/status") {
      if (!this.#authorize(request)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        status: app.ownerId === undefined ? "owner_not_bound" : app.router.statusText(app.ownerId),
        effects: app.effects.count("pending"),
        outbox: app.store.countOutbox("pending"),
      });
    }

    if (request.method === "GET" && url.pathname === "/admin/recent") {
      if (!this.#authorize(request)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        tasks: app.tasks.listRecent(20).map((task) => ({
          id: task.id,
          status: task.status,
          revision: task.revision,
          goal: task.goal,
          resultRef: task.resultRef,
          lastError: task.lastError,
        })),
        outbox: app.store.listRecentOutbox(20).map((row) => ({
          id: row.id,
          purpose: row.purpose,
          status: row.status,
          text: row.text,
          lastError: row.lastError,
        })),
      });
    }

    return new Response("not found", { status: 404 });
  }

  async #handleFeishuWebhook(request: Request, app: WorkerServices): Promise<Response> {
    if (app.feishu === undefined) {
      return Response.json(
        { error: "feishu_not_configured" },
        { status: 503 },
      );
    }

    let rawBody: string;
    try {
      rawBody = await readBody(request);
    } catch {
      return Response.json({ error: "body_too_large" }, { status: 413 });
    }

    try {
      const parsed = app.feishu.parseRequest({ headers: headerRecord(request), rawBody });
      if (parsed.kind === "challenge") {
        return Response.json({ challenge: parsed.challenge });
      }
      if (parsed.kind === "ignored") {
        return Response.json({ status: "ignored" });
      }

      const result = await app.ingress.accept(parsed.event);
      this.ctx.waitUntil(this.#runMaintenance().catch(() => undefined));
      return Response.json({ status: result.outcome });
    } catch (error) {
      if (error instanceof FeishuAuthError) {
        return Response.json({ error: "invalid_signature" }, { status: 401 });
      }
      if (error instanceof FeishuRequestError) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      throw error;
    }
  }

  async #runMaintenance(): Promise<void> {
    const app = this.#requireApp();
    await app.ingress.recoverPending(20);
    app.taskService.sweep();
    app.actionService.sweep();
    await app.reminders.fireDue();
    await app.effectDispatcher.drain(20);
    if (app.dispatcher !== undefined) {
      await app.dispatcher.drain(10);
    }
  }

  #nextDueAt(app: WorkerServices): number | undefined {
    const candidates: string[] = [];
    const effects = app.effects.nextDueAt();
    if (effects !== undefined) candidates.push(effects);
    const outbox = app.store.nextOutboxDueAt();
    if (outbox !== undefined) candidates.push(outbox);
    const schedules = app.schedules.nextDueAt();
    if (schedules !== undefined) candidates.push(schedules);
    if (app.store.listPendingInbox(1).length > 0) {
      return Date.now() + 1_000;
    }
    if (candidates.length === 0) {
      return undefined;
    }
    const times = candidates.map((value) => Date.parse(value)).filter((value) => !Number.isNaN(value));
    // Never re-arm immediately: a blocked or retrying row should not create a
    // hot alarm loop. One second is the maintenance floor.
    return times.length === 0
      ? undefined
      : Math.max(Date.now() + 1_000, Math.min(...times));
  }

  #authorize(request: Request): boolean {
    const token = this.env.ADMIN_TOKEN?.trim();
    if (token === undefined || token.length === 0) {
      return false;
    }
    const header = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${token}`;
    const actualBuffer = Buffer.from(header, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  #adminTokenConfigured(): boolean {
    const token = this.env.ADMIN_TOKEN?.trim();
    return token !== undefined && token.length > 0;
  }

  #requireApp(): WorkerServices {
    if (this.#app === undefined) {
      throw new Error("Assistant services are not initialized");
    }
    return this.#app;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, runtime: "worker" });
    }

    // Feishu's URL verification has a 3-second deadline. Answer the plaintext
    // challenge in the outer Worker so a cold Durable Object startup cannot
    // make the callback fail. Normal events still go through the DO.
    if (request.method === "POST" && url.pathname === "/webhooks/feishu") {
      const challenge = await maybeFeishuChallenge(request, env);
      if (challenge !== undefined) {
        return challenge;
      }
    }

    // The stable owner key is deliberately server-derived, not user input.
    const agent = env.ASSISTANT.getByName("owner");
    return agent.fetch(request);
  },
};

async function maybeFeishuChallenge(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const expected = env.FEISHU_VERIFICATION_TOKEN?.trim();
  if (expected === undefined || expected.length === 0) {
    return undefined;
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_BODY_BYTES) {
      return undefined;
    }
  }

  let raw: string;
  try {
    raw = await request.clone().text();
  } catch {
    return undefined;
  }
  if (raw.length > MAX_BODY_BYTES) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  let record = asRecord(payload);
  if (record === undefined) {
    return undefined;
  }

  // With an Encrypt Key configured, Feishu encrypts the URL challenge too.
  // Decrypt it here so verification never depends on a cold Durable Object.
  if (typeof record.encrypt === "string") {
    const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
    if (encryptKey === undefined || encryptKey.length === 0) {
      return undefined;
    }
    let decrypted: string;
    try {
      decrypted = decryptFeishuPayload(record.encrypt, encryptKey);
    } catch {
      return undefined;
    }
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return undefined;
    }
    record = asRecord(payload);
    if (record === undefined) {
      return undefined;
    }
  }

  if (record.type !== "url_verification") {
    return undefined;
  }

  if (
    typeof record.token !== "string" ||
    !secureEqual(record.token, expected)
  ) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  if (typeof record.challenge !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  return Response.json({ challenge: record.challenge });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function readFeishuConfig(env: Env): FeishuConfig | undefined {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
  if (
    appId === undefined ||
    appId.length === 0 ||
    appSecret === undefined ||
    appSecret.length === 0 ||
    verificationToken === undefined ||
    verificationToken.length === 0
  ) {
    return undefined;
  }
  return {
    appId,
    appSecret,
    verificationToken,
    encryptKey: env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    apiBase: env.FEISHU_API_BASE?.trim() || undefined,
    accountId: appId,
  };
}

async function readBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_BODY_BYTES) {
      throw new Error("request body exceeds limit");
    }
  }

  const body = request.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("request body exceeds limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function headerRecord(request: Request): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of request.headers.entries()) {
    headers[name] = value;
  }
  return headers;
}
