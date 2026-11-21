import type {
  Mandate,
  RouterDecision,
  RouterInput,
  ScheduleIntent,
} from "../domain/types.ts";
import { isStateToolName } from "../actions/state.ts";
import { parseStateQuery } from "./state-query.ts";
import type { Store } from "../storage/store.ts";
import type { AgentRuntime } from "../runtime/types.ts";
import type { RouterModel } from "./router.ts";
import type { CapabilityView } from "../plugins/fence.ts";

const ROUTER_SESSION_KEY = "router.session_id";

/** One router poll slice; the durable submission is re-attached on retry. */
export const ROUTER_WAIT_SLICE_MS = 250;
export const ROUTER_RETRY_BASE_MS = 250;
export const ROUTER_RETRY_MAX_MS = 2_000;
export const ROUTER_MAX_ATTEMPTS = 1_000;

export class RouterPendingError extends Error {
  constructor() {
    super("router model still pending");
    this.name = "RouterPendingError";
  }
}

const ALLOWED_RESOURCES: Record<string, true> = {
  chat: true,
  weather: true,
  github: true,
  state: true,
};
const ALLOWED_TOOLS: Record<string, true> = {
  "lamp.set_brightness": true,
  "github.read": true,
  "state.summary": true,
  "task.list": true,
  "task.get": true,
  "reminder.list": true,
  "memory.list": true,
  "schedule.list": true,
};

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

  async decide(
    input: RouterInput,
    capabilities?: CapabilityView,
  ): Promise<RouterDecision> {
    try {
      return await this.#decideOnce(input, capabilities);
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
      return this.#decideOnce(input, capabilities);
    }
  }

  async #decideOnce(
    input: RouterInput,
    capabilities?: CapabilityView,
  ): Promise<RouterDecision> {
    const sessionId = await this.#ensureSession();
    const operationId = `router:${input.inboxId}`;
    await this.#runtime.submit(
      sessionId,
      routerPrompt(input, capabilities),
      operationId,
      "app.router",
    );
    const answer = await this.#runtime.wait(sessionId, operationId, ROUTER_WAIT_SLICE_MS);
    if (answer.status === "pending") {
      // The effect retry re-attaches to the same durable submission.
      throw new RouterPendingError();
    }
    if (answer.status === "unanswered") {
      console.warn("router_model_unanswered", { reason: answer.reason });
      return { action: "reply", text: "这次没有理解成功，请再说一次。" };
    }

    const decision = parseRouterDecision(answer.text, capabilities);
    if (decision === undefined) {
      console.warn("router_decision_invalid", {
        // Never log model output: it can contain private chat or secrets.
        outputLength: answer.text.length,
      });
      return {
        action: "reply",
        text: "请把目标、完成条件和允许使用的工具说得更具体一些。",
      };
    }
    console.info("router_decision", {
      action: decision.action,
      hasTask: decision.task !== undefined,
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

export function routerPrompt(
  input: RouterInput,
  capabilities?: CapabilityView,
): string {
  const taskLines = (input.taskContext ?? []).slice(0, 10).map(
    (task) =>
      `- id=${task.id} status=${task.status}${task.project === undefined ? "" : ` project=${task.project}`} goal=${task.goal.slice(0, 120)}`,
  );
  const projectLines = (input.projectContext ?? []).slice(0, 20).map(
    (project) =>
      `- projectKey=${project.projectKey} repo=${project.repositoryFullName} repoId=${project.repositoryId} branch=${project.defaultBranch}`,
  );
  const tools =
    capabilities === undefined
      ? Object.keys(ALLOWED_TOOLS).sort()
      : capabilities.toolNames();
  const resources =
    capabilities === undefined
      ? Object.keys(ALLOWED_RESOURCES).sort()
      : capabilities.resources();
  const githubEnabled = tools.includes("github.read");
  return [
    "You are the Router for a personal assistant.",
    "Understand the owner's message and return one JSON object only.",
    "Allowed actions:",
    '- {"action":"reply","text":"..."} for chat, clarification, or asking the owner to split a compound request.',
    '- {"action":"create_task","text":"ack","task":{"goal":"...","completionCriteria":"text or JSON {\"requiredEvidenceKinds\":[\"...\"]}","mandate":{"resources":["chat"],"tools":[]},"priority":0}} for sustained background work.',
    '- {"action":"supplement_task","taskId":"exact id","taskRef":"optional natural reference","text":"..."} when the owner answers a waiting task question or adds requirements.',
    '- {"action":"revise_task","taskId":"exact id","taskRef":"optional natural reference","changes":{"goal":"...","completionCriteria":"..."}} when the owner explicitly changes an existing task.',
    '- {"action":"cancel_task","taskId":"exact id","taskRef":"optional natural reference"}',
    '- {"action":"query_status","query":{"target":"summary|tasks|task|reminders|memories|schedules","taskId":"optional","taskRef":"optional","project":"optional","status":"queued|running|waiting_user|waiting_external|succeeded|needs_review|failed|cancelling|cancelled","limit":5,"offset":0}}',
    '- {"action":"save_memory","key":"...","value":"...","project":"optional-project"}',
    '- {"action":"forget_memory","key":"...","project":"optional-project"}',
    '- {"action":"remind","dueAt":"ISO-8601","timezone":"Asia/Shanghai","text":"..."}',
    '- {"action":"cancel_reminder","reminderRef":"exact id or natural reference"}',
    '- {"action":"draft_schedule","schedule":{"repo":"owner/name","localTime":"HH:MM","cadence":"daily|weekdays","goal":"...","timezone":"Area/City","until":"YYYY-MM-DD"}}',
    '- {"action":"confirm_schedule","scheduleId":"exact id or unique prefix","scheduleRef":"optional natural reference"}',
    '- {"action":"cancel_schedule","scheduleId":"exact id or unique prefix","scheduleRef":"optional natural reference"}',
    "Rules:",
    "- Do not approve or execute actions; the owner does that explicitly.",
    "- Include a tool in mandate.tools only when the owner explicitly asks for that capability.",
    `- Enabled tools (only these may appear in mandate.tools): ${tools.join(", ") || "none"}.`,
    `- Enabled resources (only these may appear in mandate.resources): ${resources.join(", ") || "chat"}.`,
    "- Use a task when the request needs sustained work; use reply for chat.",
    "- Read-only questions about current tasks, reminders, memories, schedules or service status must use query_status with the most specific target. Never answer state questions from memory or create a Worker just to restate state.",
    "- query_status fields are validated by the program. Omit fields the target does not support; do not invent task ids or project names.",
    "- For a specific task question, use target=task with an exact taskId or a short taskRef such as \"第二个\" or \"刚才那个\". For lists use target=tasks with optional status/limit/project.",
    "- If a request combines independent mutations or a mutation plus a query, do not execute a partial plan: reply and ask the owner to split it.",
    "- Task references must come from the real owner-scoped task list below or the current conversation. If several tasks match, the program will ask; do not guess.",
    "- For 继续处理/接着做/先停一下/刚才那个引用, use supplement_task, cancel_task, or revise_task with taskRef; never create a duplicate task just to continue prior work.",
    "- Use revise_task only when the owner explicitly asks to change an existing task's goal, completion criteria, mandate, or priority.",
    "- Use save_memory only when the owner explicitly asks you to remember something; use forget_memory only when the owner explicitly asks to forget it. Both require confirmation.",
    "- Set save_memory/forget_memory/task mandate project only when the owner explicitly names a project (or uses --project=name); otherwise omit it. Project memories must not be mixed.",
    "- Use remind only when the owner explicitly asks for a reminder; use cancel_reminder only when the owner explicitly asks to cancel one.",
    "- For draft_schedule, use the existing GitHub schedule policy: repo, local wall-clock time, daily/weekdays cadence, goal, timezone and optional until. If any required field is missing or ambiguous, reply and ask instead of guessing. A draft never activates until the owner confirms.",
    ...(githubEnabled
      ? [
          "- For read-only GitHub requests, set mandate.resources to include \"github\" and mandate.tools to [\"github.read\"]; do not promise write access.",
          "- For github.read tasks, completionCriteria must be JSON with repo set to the exact owner/name requested (for example {\"repo\":\"owner/name\",\"requiredEvidenceKinds\":[\"github\"]}); never omit repo.",
          "- For 项目评估/审查/对照规划 requests, resolve the owner's project mention against the real bindings below. If exactly one projectKey or repository full name is named, create_task with mandate.project=<projectKey>, tools [\"github.read\"], and state that only evidence-backed findings and drafts will be produced. Never ask for owner/name when the binding already determines it. Do not guess a different repository. Never claim tests or CI passed without a receipt.",
        ]
      : [
          "- The GitHub plugin is not enabled in this generation; do not promise GitHub reads or create a GitHub task.",
        ]),
    "- Internal read-only state tools: state.summary, task.list, task.get, reminder.list, memory.list, schedule.list. They are owner-scoped; never use them for another person's data.",
    "- Only when a task needs current state for further work, put the needed state tools in mandate.tools and include \"state\" in mandate.resources. For those tasks set completionCriteria to JSON with {\"verifier\":\"state-read\",\"requiredEvidenceKinds\":[\"state_snapshot\"]}.",
    "- Never infer personal facts, preferences, or plans; only remember what the owner explicitly asks to remember.",
    "- If it is unclear whether the owner wants something remembered, a reminder set, a schedule drafted, or just a reply, reply and ask for confirmation.",
    ...(projectLines.length === 0
      ? []
      : [
          "Owner project bindings (real, owner-scoped; projectKey and repository full name are authoritative):",
          ...projectLines,
        ]),
    ...(taskLines.length === 0
      ? []
      : ["Recent owner tasks (real, owner-scoped; newest first):", ...taskLines]),
    `Owner message: ${input.text}`,
  ].join("\n");
}

export function parseRouterDecision(
  text: string,
  capabilities?: CapabilityView,
): RouterDecision | undefined {
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
    action !== "forget_memory" &&
    action !== "remind" &&
    action !== "cancel_reminder" &&
    action !== "draft_schedule" &&
    action !== "confirm_schedule" &&
    action !== "cancel_schedule"
  ) {
    return undefined;
  }

  const decision: RouterDecision = {
    action,
    text: typeof record.text === "string" ? record.text : "",
  };

  if (typeof record.taskId === "string" && record.taskId.trim().length > 0) {
    decision.taskId = record.taskId.trim();
  }
  if (typeof record.taskRef === "string" && record.taskRef.trim().length > 0) {
    decision.taskRef = record.taskRef.trim();
  }
  if (typeof record.reminderRef === "string" && record.reminderRef.trim().length > 0) {
    decision.reminderRef = record.reminderRef.trim();
  }
  if (typeof record.scheduleId === "string" && record.scheduleId.trim().length > 0) {
    decision.scheduleId = record.scheduleId.trim();
  }
  if (typeof record.scheduleRef === "string" && record.scheduleRef.trim().length > 0) {
    decision.scheduleRef = record.scheduleRef.trim();
  }
  if (record.query !== undefined) {
    const parsedQuery = parseStateQuery(record.query);
    if (parsedQuery.ok) {
      decision.query = parsedQuery.query;
    } else {
      decision.queryError = parsedQuery.reason;
    }
  }
  if (typeof record.schedule === "object" && record.schedule !== null) {
    const schedule = parseScheduleIntent(record.schedule);
    if (schedule !== undefined) {
      decision.schedule = schedule;
    }
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
      parsed.mandate = sanitizeMandate(changes.mandate, capabilities);
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
  if (
    typeof record.project === "string" &&
    /^[A-Za-z0-9._-]{1,64}$/.test(record.project)
  ) {
    decision.project = record.project;
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
      const mandate = sanitizeMandate(task.mandate, capabilities);
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

function parseScheduleIntent(value: unknown): ScheduleIntent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const intent: ScheduleIntent = {};
  if (typeof record.repo === "string" && record.repo.trim().length > 0) {
    intent.repo = record.repo.trim();
  }
  if (typeof record.localTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(record.localTime)) {
    intent.localTime = record.localTime;
  }
  if (record.cadence === "daily" || record.cadence === "weekdays") {
    intent.cadence = record.cadence;
  }
  if (typeof record.goal === "string" && record.goal.trim().length > 0) {
    intent.goal = record.goal.trim();
  }
  if (typeof record.timezone === "string" && record.timezone.trim().length > 0) {
    intent.timezone = record.timezone.trim();
  }
  if (typeof record.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.until)) {
    intent.until = record.until;
  }
  return Object.keys(intent).length === 0 ? undefined : intent;
}

/** Derive required resources from the exact tool set; never trust model text. */
export function ensureMandateResources(
  mandate: Mandate,
  capabilities?: CapabilityView,
): Mandate {
  const resources = [...mandate.resources];
  if (capabilities !== undefined) {
    for (const tool of mandate.tools) {
      const resource = capabilities.resourceForTool(tool);
      if (resource !== undefined && !resources.includes(resource)) {
        resources.push(resource);
      }
    }
  } else if (
    mandate.tools.includes("github.read") &&
    !resources.includes("github")
  ) {
    resources.push("github");
  }
  if (mandate.tools.some(isStateToolName) && !resources.includes("state")) {
    resources.push("state");
  }
  return { ...mandate, resources: resources.length > 0 ? resources : ["chat"] };
}

function sanitizeMandate(value: unknown, capabilities?: CapabilityView): Mandate {
  if (typeof value !== "object" || value === null) {
    return { resources: ["chat"], tools: [] };
  }
  const record = value as Record<string, unknown>;
  const allowedResources = capabilities?.resources();
  const allowedTools = capabilities?.toolNames();
  const resources = Array.isArray(record.resources)
    ? record.resources.filter(
        (item): item is string =>
          typeof item === "string" &&
          (allowedResources === undefined
            ? Object.hasOwn(ALLOWED_RESOURCES, item)
            : allowedResources.includes(item)),
      )
    : [];
  const tools = Array.isArray(record.tools)
    ? record.tools.filter(
        (item): item is string =>
          typeof item === "string" &&
          (allowedTools === undefined
            ? Object.hasOwn(ALLOWED_TOOLS, item)
            : allowedTools.includes(item)),
      )
    : [];
  return ensureMandateResources(
    {
      resources,
      tools,
      notes: typeof record.notes === "string" ? record.notes : undefined,
      project:
        typeof record.project === "string" &&
        /^[A-Za-z0-9._-]{1,64}$/.test(record.project)
          ? record.project
          : undefined,
    },
    capabilities,
  );
}
