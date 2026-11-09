import type { Mandate, RouterDecision, RouterInput } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";
import type { AgentRuntime } from "../runtime/types.ts";
import type { RouterModel } from "./router.ts";

const ROUTER_SESSION_KEY = "router.session_id";

const ALLOWED_RESOURCES: Record<string, true> = { chat: true, weather: true };
const ALLOWED_TOOLS: Record<string, true> = { "lamp.set_brightness": true };

/**
 * Model-backed Router. It uses one long-lived Pi session; each inbox gets a
 * stable operation id, so retrying the effect does not submit twice.
 */
export class PiRouterModel implements RouterModel {
  readonly #store: Store;
  readonly #runtime: AgentRuntime;

  constructor(store: Store, runtime: AgentRuntime) {
    this.#store = store;
    this.#runtime = runtime;
  }

  async decide(input: RouterInput): Promise<RouterDecision> {
    try {
      return await this.#decideOnce(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a stale session id after a database reset cannot recover by
      // retrying the same id; drop it and open a fresh Router session once.
      // Transient runtime failures keep the session so context survives.
      const missingSession =
        message.includes("Unknown pi session") || message.toLowerCase().includes("not_found");
      if (!missingSession) {
        throw error;
      }
      console.warn("router_session_retry", { message });
      this.#store.metaSet(ROUTER_SESSION_KEY, "");
      return this.#decideOnce(input);
    }
  }

  async #decideOnce(input: RouterInput): Promise<RouterDecision> {
    const sessionId = await this.#ensureSession();
    const operationId = `router:${input.inboxId}`;
    await this.#runtime.submit(
      sessionId,
      routerPrompt(input),
      operationId,
      "app.router",
    );
    const answer = await this.#runtime.wait(sessionId, operationId, 20_000);
    if (answer.status === "pending") {
      // The effect dispatcher will retry; the submission is already durable.
      throw new Error("router model still pending");
    }
    if (answer.status === "unanswered") {
      console.warn("router_model_unanswered", { reason: answer.reason });
      return { action: "reply", text: "这次没有理解成功，请再说一次。" };
    }

    const decision = parseRouterDecision(answer.text);
    if (decision === undefined) {
      console.warn("router_decision_invalid", {
        preview: answer.text.slice(0, 500),
      });
      return {
        action: "reply",
        text: "请把目标、完成条件和允许使用的工具说得更具体一些。",
      };
    }
    console.info("router_decision", {
      action: decision.action,
      goal: decision.task?.goal,
    });
    return decision;
  }

  async #ensureSession(): Promise<string> {
    const existing = this.#store.metaGet(ROUTER_SESSION_KEY);
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const opened = await this.#runtime.open({
      role: "router",
      brief: "Personal assistant Router",
    });
    this.#store.metaSet(ROUTER_SESSION_KEY, opened.id);
    return opened.id;
  }
}

export function routerPrompt(input: RouterInput): string {
  return [
    "You are the Router for a personal assistant.",
    "Understand the owner's message and return one JSON object only.",
    "Allowed actions:",
    '- {"action":"reply","text":"..."} for chat or clarification.',
    '- {"action":"create_task","text":"ack","task":{"goal":"...","completionCriteria":"text or JSON {\\"requiredEvidenceKinds\\":[\\"...\\"]}","mandate":{"resources":["chat"],"tools":[]},"priority":0}}',
    '- {"action":"supplement_task","taskId":"...","text":"..."} when the owner answers a waiting task question.',
    '- {"action":"revise_task","taskId":"...","changes":{"goal":"...","completionCriteria":"..."}} when the owner explicitly changes an existing task.',
    '- {"action":"cancel_task","taskId":"..."}',
    '- {"action":"query_status"}',
    '- {"action":"save_memory","key":"...","value":"..."}',
    '- {"action":"remind","dueAt":"ISO-8601","timezone":"Asia/Shanghai","text":"..."}',
    "Rules:",
    "- Do not approve or execute actions; the owner does that explicitly.",
    "- Include a tool in mandate.tools only when the owner explicitly asks for that capability.",
    "- Use a task when the request needs sustained work; use reply for chat.",
    "- Use revise_task only when the owner explicitly asks to change an existing task's goal, completion criteria, mandate, or priority.",
    "- Use save_memory only when the owner explicitly asks you to remember something.",
    "- Use remind only when the owner explicitly asks for a reminder.",
    "- Never infer personal facts, preferences, or plans; only remember what the owner explicitly asks to remember.",
    "- If it is unclear whether the owner wants something remembered, a reminder set, or just a reply, reply and ask for confirmation.",
    `Owner message: ${input.text}`,
  ].join("\n");
}

export function parseRouterDecision(text: string): RouterDecision | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (
    action !== "reply" &&
    action !== "create_task" &&
    action !== "supplement_task" &&
    action !== "revise_task" &&
    action !== "cancel_task" &&
    action !== "query_status" &&
    action !== "save_memory" &&
    action !== "remind"
  ) {
    return undefined;
  }

  const decision: RouterDecision = {
    action,
    text: typeof record.text === "string" ? record.text : "",
  };

  if (typeof record.taskId === "string") {
    decision.taskId = record.taskId;
  }
  if (typeof record.changes === "object" && record.changes !== null) {
    const changes = record.changes as Record<string, unknown>;
    const parsed: NonNullable<RouterDecision["changes"]> = {};
    if (typeof changes.goal === "string" && changes.goal.trim().length > 0) {
      parsed.goal = changes.goal;
    }
    if (
      typeof changes.completionCriteria === "string" &&
      changes.completionCriteria.trim().length > 0
    ) {
      parsed.completionCriteria = changes.completionCriteria;
    }
    if (typeof changes.priority === "number") {
      parsed.priority = changes.priority;
    }
    if (typeof changes.mandate === "object" && changes.mandate !== null) {
      parsed.mandate = sanitizeMandate(changes.mandate);
    }
    if (Object.keys(parsed).length > 0) {
      decision.changes = parsed;
    }
  }
  if (typeof record.key === "string") {
    decision.key = record.key;
  }
  if (typeof record.value === "string") {
    decision.value = record.value;
  }
  if (typeof record.dueAt === "string") {
    decision.dueAt = record.dueAt;
  }
  if (typeof record.timezone === "string") {
    decision.timezone = record.timezone;
  }

  if (typeof record.task === "object" && record.task !== null) {
    const task = record.task as Record<string, unknown>;
    if (typeof task.goal === "string" && task.goal.trim().length > 0) {
      const mandate = sanitizeMandate(task.mandate);
      decision.task = {
        goal: task.goal,
        completionCriteria:
          typeof task.completionCriteria === "string" ? task.completionCriteria : "",
        mandate,
        priority: typeof task.priority === "number" ? task.priority : undefined,
      };
    }
  }

  return decision;
}

function sanitizeMandate(value: unknown): Mandate {
  if (typeof value !== "object" || value === null) {
    return { resources: ["chat"], tools: [] };
  }
  const record = value as Record<string, unknown>;
  const resources = Array.isArray(record.resources)
    ? record.resources.filter(
        (item): item is string =>
          typeof item === "string" && Object.hasOwn(ALLOWED_RESOURCES, item),
      )
    : [];
  const tools = Array.isArray(record.tools)
    ? record.tools.filter(
        (item): item is string =>
          typeof item === "string" && Object.hasOwn(ALLOWED_TOOLS, item),
      )
    : [];
  return {
    resources: resources.length > 0 ? resources : ["chat"],
    tools,
    notes: typeof record.notes === "string" ? record.notes : undefined,
  };
}
