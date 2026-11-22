import type {
  InboxRecord,
  Mandate,
  OutboxPurpose,
  ProjectBinding,
  ReplyDraft,
  RouterDecision,
  SchedulePolicyRecord,
  RouterInput,
  ScheduleRecord,
  StateQuery,
  TaskRecord,
} from "../domain/types.ts";
import {
  CONVERSATION_TURN_CHARS,
  CONVERSATION_WINDOW_CHARS,
  CONVERSATION_WINDOW_TURNS,
} from "../domain/types.ts";
import type { ActionRepository } from "../storage/actions.ts";
import type { EffectRepository } from "../storage/effects.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { Store } from "../storage/store.ts";
import type { MemoryService } from "../personal/memory.ts";
import type { ConfirmationService } from "../personal/confirmations.ts";
import type { PreauthorizationService } from "../personal/preauthorizations.ts";
import type { SchedulePolicyService } from "../personal/schedule-policies.ts";
import { assertTimezone, formatInTimezone } from "../personal/reminders.ts";
import type { ReminderService } from "../personal/reminders.ts";
import type { EffectDispatcher, EffectOutcome } from "../delivery/effects.ts";
import type { ActionService } from "../actions/service.ts";
import { buildDiagnostics, formatDiagnostics } from "../observability/diagnostics.ts";
import {
  TOKEN_COST_LINE_PREFIX,
  buildUsage,
  formatUsage,
} from "../observability/usage.ts";
import type { BudgetService } from "../observability/magpie.ts";
import { isStateToolName, type StateReadService } from "../actions/state.ts";
import type { TaskService } from "./tasks.ts";
import {
  extractProjectFlag,
  formatTaskCandidates,
  formatTaskNotFound,
  inferStateQuery,
  invalidProjectFlag,
  isCompoundControlRequest,
  resolveTaskId,
  resolveTaskReference,
  taskFocusKey,
} from "./state-query.ts";
export { resolveTaskId } from "./state-query.ts";
import { PersonalIntentHandler } from "./personal-intents.ts";
import { StateQueryHandler } from "./state-query-handler.ts";
import {
  RouterPendingError,
  ROUTER_MAX_ATTEMPTS,
  ROUTER_RETRY_BASE_MS,
  ROUTER_RETRY_MAX_MS,
  ensureMandateResources,
} from "./pi-router.ts";
import {
  describeReminderCancelFailure,
  formatSchedulePolicy,
  formatSchedules,
} from "./intent-format.ts";
export {
  describeReminderCancelFailure,
  formatSchedulePolicy,
  formatSchedules,
} from "./intent-format.ts";
import type { InboundHandler } from "./responder.ts";
import type { WakeScheduler } from "../runtime/types.ts";
import type { CapabilityView } from "../plugins/fence.ts";
import type { IssueDraftService, IssueDraftView } from "../personal/issue-drafts.ts";
import type { IssueDraftApprovalBridge } from "../personal/draft-approval.ts";

export interface RouterModel {
  decide(input: RouterInput, capabilities?: CapabilityView): Promise<RouterDecision>;
}

/**
 * Read-only view of owner project bindings. The Router never guesses a
 * repository: a project key or full name must resolve to an active binding.
 */
export interface ProjectCatalog {
  list(ownerId: string, status?: "active"): ProjectBinding[];
  findActiveByKey(ownerId: string, projectKey: string): ProjectBinding | undefined;
}

/** Deterministic model used by tests and by the local Node fallback. */
export class StaticRouterModel implements RouterModel {
  readonly #decisions: RouterDecision[] = [];

  push(decision: RouterDecision): void {
    this.#decisions.push(decision);
  }

  async decide(): Promise<RouterDecision> {
    const decision = this.#decisions.shift();
    if (decision === undefined) {
      return { action: "reply", text: "已收到。" };
    }
    return decision;
  }
}

export interface RouterDeps {
  store: Store;
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  taskService: TaskService;
  actionService: ActionService;
  reminders: ReminderService;
  memory: MemoryService;
  confirmation: ConfirmationService;
  preauthorization: PreauthorizationService;
  schedulePolicy?: SchedulePolicyService;
  state: StateReadService;
  budget?: BudgetService;
  model: RouterModel;
  wake: WakeScheduler;
  now?: () => Date;
  defaultTimezone?: string;
  /** Live catalog; models may only request currently enabled capabilities. */
  capabilities?: CapabilityView;
  /** Owner project bindings used to resolve projectKeys deterministically. */
  projects?: ProjectCatalog;
  /** Persisted verifier-approved drafts and the approval-to-write bridge. */
  issueDrafts?: IssueDraftService;
  issueDraftApproval?: IssueDraftApprovalBridge;
}

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REMIND_TIME_HINT =
  /(?:\d{1,2}\s*[点:：时]|今天|明天|后天|大后天|下周|上午|下午|中午|晚上|早上)/;
const REDIRECTABLE_CONTROL_ACTIONS: ReadonlySet<RouterDecision["action"]> = new Set([
  "supplement_task",
  "revise_task",
  "cancel_task",
  "save_memory",
  "forget_memory",
  "remind",
  "cancel_reminder",
  "draft_schedule",
  "confirm_schedule",
  "cancel_schedule",
]);

/**
 * The router model supplies completion criteria, but a github.read task must
 * carry the exact repo for the verifier. Prefer an active binding or an
 * owner-supplied repo before consulting the model's goal and criteria.
 */
function extractGithubRepo(text: string, requireUrl = false): string | undefined {
  const urlMatch = /https?:\/\/github\.com\/([^/\s?#]+\/[^/\s?#]+)/i.exec(text);
  const plainMatch = requireUrl || urlMatch !== null
    ? null
    : /(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[\s,.;:!?，。；：！？])/.exec(
        text.replace(/https?:\/\/\S+/g, " "),
      );
  const candidate = urlMatch?.[1] ?? plainMatch?.[1];
  return candidate !== undefined && GITHUB_REPO_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

const PROJECT_REVIEW_PATTERN =
  /(?:项目(?:评估|审查|复盘|检查|进展|状态|实施情况|完成度|差距)|(?:评估|检查|审查|复盘|对照).{0,40}(?:项目|开发进展|完成度|实施情况|实现差距|规划)|最新实施(?:情况|状态)|对照(?:规划|计划).{0,20}(?:实现|完成|差距|进展)|实施评估)/;

/** Deterministic Skill binding for an explicit project-review request. */
export function wantsProjectReview(text: string): boolean {
  return PROJECT_REVIEW_PATTERN.test(text);
}

/**
 * A project review mentions drafts and "do not modify GitHub"; the generic
 * compound-request guard would otherwise split it as state query + mutation.
 * Only an explicit read-only constraint gets this exemption.
 */
export function isReadOnlyProjectReviewRequest(text: string): boolean {
  return (
    wantsProjectReview(text) &&
    /(?:只读|不要(?:实际)?(?:修改|写入|创建|提交|评论|发送)|不(?:实际)?修改|禁止(?:写入|修改)|read[\s-]?only|no\s+writes?)/i.test(
      text,
    )
  );
}

const STATE_QUERY_PATTERNS = [
  /当前(?:的)?任务/,
  /任务(?:和|与|及)提醒/,
  /(?:任务|提醒)状态/,
  /(?:有哪些|有什么|查看|列出).{0,6}(?:任务|提醒)/,
  /(?:总结|汇总).{0,16}(?:任务|提醒)/,
  /(?:任务|提醒).{0,10}(?:总结|汇总)/,
  /(?:任务|提醒).{0,8}(?:完成|进展|情况|怎么样|如何|多少|做完|未完成)/,
  /(?:任务|提醒).{0,6}(?:吗|呢)/,
  /最近.{0,6}(?:任务|提醒)/,
];
const STATE_ACTION_VERBS =
  /(?:创建|新建|添加|设置|修改|更新|改|结束|停|删除|取消|关闭|打开|清除|移除|重命名|调整|更换|记住|保存|记录|安排|执行|开始|暂停|恢复|批准|拒绝|补充|回答|发送|发给|提交|提醒(?:一下|下)?我|设(?:置|个)提醒|加(?:个)?提醒|做一个|帮我做)/;

/**
 * Narrow, deterministic detection for explicit "what is my current state"
 * questions. It must not steal task creation or mutation requests.
 */
export function isExplicitStateQuery(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || STATE_ACTION_VERBS.test(value)) {
    return false;
  }
  return STATE_QUERY_PATTERNS.some((pattern) => pattern.test(value));
}

const EXPLICIT_EXECUTION_PATTERN =
  /(?:开始执行|执行吧|开始做|现在就(?:开始|做|执行)|立即(?:开始|执行|做)|马上(?:开始|执行|做)|照(?:这个|此|刚才的)(?:方案|计划)?(?:执行|做)|按(?:这个|此|刚才的)(?:方案|计划)?(?:执行|做)|确认(?:执行|开始)|创建任务|开工|去做吧)/;
const REQUEST_VERB_PATTERN =
  /(?:帮我|给我|替我|麻烦你|请(?:你)?|做一下|执行|开始做|创建|新建|检查|分析|评估|查一下|看一下|写一|整理|生成|跑一下|启动)/;
const HYPOTHETICAL_PATTERN =
  /(?:^|[，。！？；、\s])(?:如果|假如|假设|要是|万一|倘若)/;
const CAPABILITY_QUESTION_PATTERN =
  /(?:能不能|可不可以|会不会|是否|要不要|该不该|值不值得|行不行|有没有必要)/;
const DISCUSSION_PATTERN =
  /(?:(?:先|我们|咱们)?(?:讨论|聊聊|商量|想想|考虑)(?:一下)?|头脑风暴)/;
const NEGATED_ACTION_PATTERN =
  /(?:不要|别|不用|不必|不|先不|暂时不|先别|无需|勿)(?:帮我|给我|去|现在|马上|直接)?(?:执行|开始|创建|做|跑|启动|写|发)/;

/**
 * True for a message that only explores, supposes or declines work. The
 * program uses this as a narrow guard: even if the model emits create_task,
 * a hypothetical/negated/discussion-only message must not create a Task.
 * An explicit execution marker always wins.
 */
export function isDiscussionOnly(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) {
    return false;
  }
  // "不要创建任务" contains an execution word; negation must win first.
  if (NEGATED_ACTION_PATTERN.test(value)) {
    return true;
  }
  if (EXPLICIT_EXECUTION_PATTERN.test(value)) {
    return false;
  }
  // Framing the whole message as a hypothesis or a discussion wins over
  // verbs inside it; only an explicit start marker (handled above) escapes.
  if (HYPOTHETICAL_PATTERN.test(value) || DISCUSSION_PATTERN.test(value)) {
    return true;
  }
  // A concrete request ("能不能帮我检查一下") is an execution request even
  // when phrased as a question.
  if (REQUEST_VERB_PATTERN.test(value)) {
    return false;
  }
  return CAPABILITY_QUESTION_PATTERN.test(value);
}

export function normalizeGithubCriteria(
  criteria: string,
  goal: string,
  ownerText: string,
  mandateTools: readonly string[],
  skills: readonly string[] = [],
  project?: ProjectBinding,
): string {
  if (!mandateTools.includes("github.read")) {
    return criteria;
  }
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(criteria) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Plain text is replaced below once a repo is known.
  }
  const repo =
    project?.repositoryFullName.toLowerCase() ??
    extractGithubRepo(ownerText) ??
    extractGithubRepo(goal) ??
    (typeof parsed.repo === "string" && GITHUB_REPO_PATTERN.test(parsed.repo)
      ? parsed.repo.toLowerCase()
      : undefined);
  if (repo === undefined) {
    return criteria;
  }
  const required = new Set(
    Array.isArray(parsed.requiredEvidenceKinds)
      ? parsed.requiredEvidenceKinds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  required.add("github");
  return JSON.stringify({
    ...parsed,
    verifier: skills.includes("github.project-review")
      ? "project-review"
      : "github-read",
    repo,
    ...(project === undefined
      ? {}
      : {
          repositoryId: project.repositoryId,
          projectKey: project.projectKey,
          defaultBranch: project.defaultBranch,
          allowedPlanPaths: project.allowedPlanPaths,
          projectBindingVersion: project.version,
          credentialRef: project.credentialRef,
        }),
    requiredEvidenceKinds: [...required],
    requireStructuredClaims: true,
  });
}

export type ProjectMentionResolution =
  | { status: "resolved"; project: ProjectBinding }
  | { status: "none" }
  | {
      status: "missing" | "ambiguous" | "unavailable";
      requested?: string;
      projectKeys: string[];
    };

/**
 * Resolve a project mention without a model. Explicit `--project=` wins, then
 * an exact owner/name binding, then an exact projectKey token. Multiple
 * matches and unbound names are reported, never guessed.
 */
export function resolveProjectMention(input: {
  text: string;
  ownerId: string;
  requested?: string;
  projects?: ProjectCatalog;
  requireProject: boolean;
}): ProjectMentionResolution {
  const catalog = input.projects;
  const active = catalog?.list(input.ownerId, "active") ?? [];
  const projectKeys = active.map((project) => project.projectKey).sort();
  if (active.length === 0) {
    return input.requireProject || /项目|project/i.test(input.text)
      ? { status: "unavailable", projectKeys }
      : { status: "none" };
  }
  const explicit = extractProjectFlag(input.text);
  if (explicit !== undefined) {
    const project = active.find(
      (candidate) => candidate.projectKey === explicit.toLowerCase(),
    );
    return project === undefined
      ? { status: "missing", requested: explicit, projectKeys }
      : { status: "resolved", project };
  }

  const matches = new Map<string, ProjectBinding>();
  const lower = input.text.toLowerCase();
  for (const project of active) {
    if (
      lower.includes(project.repositoryFullName.toLowerCase()) ||
      new RegExp(
        `(^|[^a-z0-9._-])${escapeRegExp(project.projectKey)}([^a-z0-9._-]|$)`,
        "i",
      ).test(input.text)
    ) {
      matches.set(project.id, project);
    }
  }

  // A model-supplied project may narrow an ambiguous message, but it may not
  // override a different project the owner named explicitly.
  const requested = input.requested?.trim().toLowerCase();
  if (requested !== undefined && requested.length > 0) {
    const project = active.find((candidate) => candidate.projectKey === requested);
    if (project === undefined) {
      return { status: "missing", requested, projectKeys };
    }
    if (matches.size > 1) {
      return {
        status: "ambiguous",
        projectKeys: [...matches.values()]
          .map((candidate) => candidate.projectKey)
          .sort(),
      };
    }
    const mentioned = [...matches.values()][0];
    if (mentioned !== undefined && mentioned.id !== project.id) {
      return {
        status: "ambiguous",
        projectKeys: [mentioned.projectKey, project.projectKey].sort(),
      };
    }
    const namedRepo = extractGithubRepo(input.text);
    if (mentioned === undefined && namedRepo !== undefined) {
      // The owner named a repository that is not an active binding; the
      // model's project must not override that explicit mention.
      return { status: "missing", requested: namedRepo, projectKeys };
    }
    return { status: "resolved", project };
  }

  if (matches.size === 1) {
    return { status: "resolved", project: [...matches.values()][0] as ProjectBinding };
  }
  if (matches.size > 1) {
    return {
      status: "ambiguous",
      projectKeys: [...matches.values()].map((project) => project.projectKey).sort(),
    };
  }
  const unboundRepo = extractGithubRepo(input.text);
  if (unboundRepo !== undefined) {
    return { status: "missing", requested: unboundRepo, projectKeys };
  }
  if (input.requireProject || /项目|project/i.test(input.text)) {
    const named = /([a-z0-9][a-z0-9._-]{0,63})\s*项目/i.exec(input.text)?.[1];
    return {
      status: "missing",
      ...(requested !== undefined
        ? { requested }
        : named === undefined
          ? {}
          : { requested: named }),
      projectKeys,
    };
  }
  return { status: "none" };
}

export function describeProjectResolutionFailure(
  resolution: Extract<ProjectMentionResolution, { status: "missing" | "ambiguous" | "unavailable" }>,
): string {
  if (resolution.status === "unavailable") {
    return "没有可用的 GitHub 项目绑定；请主人先用 `pa projects bind` 绑定项目（immutable repositoryId）。";
  }
  if (resolution.status === "ambiguous") {
    return `项目名称不唯一：${resolution.projectKeys.join(", ")}。请用 --project=<projectKey> 指定。`;
  }
  const available =
    resolution.projectKeys.length === 0
      ? ""
      : ` 可用项目：${resolution.projectKeys.join(", ")}。`;
  return resolution.requested === undefined
    ? `请指定要检查的 projectKey。${available}`
    : `找不到项目 ${resolution.requested} 的 active 绑定，或该仓库未授权。${available}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * State tasks are verified by the state-read verifier regardless of the
 * model's criteria text; make the required citation kind explicit so a
 * structural-only report cannot pass.
 */
export function normalizeStateCriteria(
  criteria: string,
  mandateTools: readonly string[],
): string {
  if (!mandateTools.some(isStateToolName)) {
    return criteria;
  }
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(criteria) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Plain text is replaced with the verifier contract below.
  }
  const required = new Set(
    Array.isArray(parsed.requiredEvidenceKinds)
      ? parsed.requiredEvidenceKinds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  required.add("state_snapshot");
  const verifier = mandateTools.includes("github.read")
    ? parsed.verifier
    : "state-read";
  return JSON.stringify({
    ...parsed,
    ...(verifier === undefined ? {} : { verifier }),
    requiredEvidenceKinds: [...required],
    requireStructuredClaims: true,
  });
}

export interface ParsedScheduleSpec {
  repo: string;
  localTime: string;
  cadence: "daily" | "weekdays";
  goal: string;
  timezone?: string;
  until?: string;
}

export function parseScheduleSpec(
  text: string,
): { ok: true; value: ParsedScheduleSpec } | { ok: false; reason: string } {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 4) {
    return {
      ok: false,
      reason:
        "格式：/schedule new <owner/name> <HH:MM> <daily|weekdays> <内容> [--until=YYYY-MM-DD] [--tz=Area/City]",
    };
  }
  const [repo, localTime, cadenceRaw] = tokens as [string, string, string];
  const cadence =
    cadenceRaw === "weekdays" || cadenceRaw === "工作日"
      ? "weekdays"
      : cadenceRaw === "daily" || cadenceRaw === "每天"
        ? "daily"
        : undefined;
  if (cadence === undefined) {
    return { ok: false, reason: "频率应为 daily（每天）或 weekdays（工作日）。" };
  }
  let timezone: string | undefined;
  let until: string | undefined;
  const goalTokens: string[] = [];
  for (const token of tokens.slice(3)) {
    if (token.startsWith("--until=")) {
      until = token.slice("--until=".length);
    } else if (token.startsWith("--tz=")) {
      timezone = token.slice("--tz=".length);
    } else {
      goalTokens.push(token);
    }
  }
  const goal = goalTokens.join(" ").trim();
  if (goal.length === 0) {
    return { ok: false, reason: "计划内容不能为空。" };
  }
  return { ok: true, value: { repo, localTime, cadence, goal, timezone, until } };
}

/**
 * The Router is the only semantic entry point. Deterministic commands run
 * without a model; everything else becomes a durable router.route effect so
 * the platform callback returns before generation starts.
 */
export class Router implements InboundHandler {
  readonly #store: Store;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #effects: EffectRepository;
  readonly #taskService: TaskService;
  readonly #actionService: ActionService;
  readonly #reminders: ReminderService;
  readonly #memory: MemoryService;
  readonly #confirmation: ConfirmationService;
  readonly #preauthorization: PreauthorizationService;
  readonly #schedulePolicy?: SchedulePolicyService;
  readonly #state: StateReadService;
  readonly #stateQuery: StateQueryHandler;
  readonly #personalIntents: PersonalIntentHandler;
  readonly #budget?: BudgetService;
  readonly #model: RouterModel;
  readonly #wake: WakeScheduler;
  readonly #now: () => Date;
  readonly #timezone: string;
  readonly #capabilities?: CapabilityView;
  readonly #projects?: ProjectCatalog;
  readonly #issueDrafts?: IssueDraftService;
  readonly #issueDraftApproval?: IssueDraftApprovalBridge;

  constructor(deps: RouterDeps) {
    this.#store = deps.store;
    this.#tasks = deps.tasks;
    this.#actions = deps.actions;
    this.#effects = deps.effects;
    this.#taskService = deps.taskService;
    this.#actionService = deps.actionService;
    this.#reminders = deps.reminders;
    this.#memory = deps.memory;
    this.#confirmation = deps.confirmation;
    this.#preauthorization = deps.preauthorization;
    this.#schedulePolicy = deps.schedulePolicy;
    this.#state = deps.state;
    this.#budget = deps.budget;
    this.#model = deps.model;
    this.#wake = deps.wake;
    this.#now = deps.now ?? (() => new Date());
    this.#timezone = deps.defaultTimezone ?? "Asia/Shanghai";
    this.#capabilities = deps.capabilities;
    this.#projects = deps.projects;
    this.#issueDrafts = deps.issueDrafts;
    this.#issueDraftApproval = deps.issueDraftApproval;
    this.#stateQuery = new StateQueryHandler({
      tasks: deps.tasks,
      state: deps.state,
      store: deps.store,
      now: this.#now,
      timezone: this.#timezone,
    });
    this.#personalIntents = new PersonalIntentHandler({
      store: deps.store,
      memory: deps.memory,
      confirmation: deps.confirmation,
      reminders: deps.reminders,
      schedulePolicy: deps.schedulePolicy,
      now: this.#now,
      timezone: this.#timezone,
    });
  }

  install(dispatcher: EffectDispatcher): void {
    dispatcher.register("router.route", (effect) =>
      this.handleRoute(effect.payload, effect.attempts),
    );
  }

  async handle(event: InboxRecord, _store: Store): Promise<ReplyDraft[]> {
    const text = event.text?.trim() ?? "";
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 1 && lines.every((line) => line.startsWith("/"))) {
      const replies: ReplyDraft[] = [];
      for (const line of lines) {
        const result = await this.#command(event, line);
        if (result === undefined) {
          replies.push({
            purpose: "failure",
            text: `无法识别多命令中的这一行：${line.split(/\s+/)[0]}`,
          });
        } else {
          replies.push(...result);
        }
      }
      return replies;
    }

    const command = await this.#command(event, text);
    if (command !== undefined) {
      return command;
    }

    const now = this.#now().toISOString();
    this.#effects.enqueue({
      kind: "router.route",
      businessKey: `inbox:${event.id}:route`,
      payload: {
        inboxId: event.id,
        ownerId: event.ownerId,
        conversationId: event.conversationId,
        text,
      },
      nextAttemptAt: now,
      createdAt: now,
    });
    void this.#wake.wake();
    return [{ purpose: "ack", text: "已收到。" }];
  }

  async handleRoute(
    payload: Record<string, unknown>,
    attempts = 1,
  ): Promise<EffectOutcome> {
    const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : undefined;
    const conversationId =
      typeof payload.conversationId === "string" ? payload.conversationId : undefined;
    const text = typeof payload.text === "string" ? payload.text : "";
    const inboxId = typeof payload.inboxId === "string" ? payload.inboxId : "unknown";
    if (ownerId === undefined || conversationId === undefined) {
      return { status: "failed", reason: "router.route payload is incomplete" };
    }
    // Re-attaching to a run that already consumed budget must not be aborted
    // just because the window crossed the threshold while it was in flight.
    const budget = attempts <= 1 ? await this.#budget?.check({ role: "router" }) : undefined;
    if (budget !== undefined && !budget.ok) {
      // A deterministic state answer uses no model request; use it as the
      // budget-exhausted fallback instead of hiding real state behind a quota
      // message. Mutation requests still get the explicit budget stop.
      const stateQuery = inferStateQuery(text);
      if (stateQuery !== undefined) {
        this.#answerStateQuery({ ownerId, conversationId, inboxId, text }, stateQuery);
        return { status: "done" };
      }
      if (isExplicitStateQuery(text)) {
        this.#answerStateQuery({ ownerId, conversationId, inboxId, text });
        return { status: "done" };
      }
      this.#reply(
        { ownerId, conversationId, inboxId },
        `模型请求已暂停：${budget.reason ?? "订阅额度不足"}。`,
        "status",
      );
      return { status: "done" };
    }

    let decision: RouterDecision;
    try {
      decision = await this.#model.decide({
        ownerId,
        conversationId,
        text,
        inboxId,
        conversationWindow: this.#store.listConversationTurns({
          ownerId,
          conversationId,
          excludeInboxId: inboxId,
          maxTurns: CONVERSATION_WINDOW_TURNS,
          maxChars: CONVERSATION_WINDOW_CHARS,
          maxTurnChars: CONVERSATION_TURN_CHARS,
        }),
        taskContext: this.#tasks.listByOwner(ownerId, 10).map((task) => ({
          id: task.id,
          status: task.status,
          goal: task.goal,
          conversationId: task.conversationId,
          project: task.mandate.project,
        })),
        projectContext: (this.#projects?.list(ownerId, "active") ?? [])
          .slice(0, 20)
          .map((project) => ({
            projectKey: project.projectKey,
            repositoryId: project.repositoryId,
            repositoryFullName: project.repositoryFullName,
            defaultBranch: project.defaultBranch,
          })),
      }, this.#capabilities);
    } catch (error) {
      if (error instanceof RouterPendingError) {
        // The model run is still durable; poll in the background instead of
        // holding the shared effect drain for the whole generation.
        const delay = Math.min(
          ROUTER_RETRY_MAX_MS,
          ROUTER_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 3),
        );
        return {
          status: "retry",
          at: new Date(this.#now().getTime() + delay).toISOString(),
          reason: error.message,
          maxAttempts: ROUTER_MAX_ATTEMPTS,
        };
      }
      return {
        status: "retry",
        at: new Date(this.#now().getTime() + 5_000).toISOString(),
        reason: `router model failed: ${error instanceof Error ? error.message : String(error)}`,
        maxAttempts: ROUTER_MAX_ATTEMPTS,
      };
    }

    return this.#executeDecision(decision, {
      ownerId,
      conversationId,
      inboxId,
      text,
    });
  }

  async #executeDecision(
    decision: RouterDecision,
    context: { ownerId: string; conversationId: string; inboxId: string; text: string },
  ): Promise<EffectOutcome> {
    const now = this.#now().toISOString();
    if (decision.action === "create_task" && isDiscussionOnly(context.text)) {
      // A model can mistake a hypothetical or a discussion for a mandate.
      // The program keeps that boundary deterministic and non-destructive.
      this.#reply(
        context,
        "这看起来还在讨论或假设阶段，我先不创建任务。要我实际开始，请明确说“开始执行”并说明范围。",
        "clarify",
      );
      return { status: "done" };
    }
    if (
      decision.action !== "reply" &&
      decision.action !== "query_status" &&
      isCompoundControlRequest(context.text) &&
      !isReadOnlyProjectReviewRequest(context.text)
    ) {
      this.#reply(
        context,
        "这是一个复合请求：包含状态查询和改变操作。请拆成两步，先查询或先执行其中一项，我会逐项处理。",
        "failure",
      );
      return { status: "done" };
    }
    if (REDIRECTABLE_CONTROL_ACTIONS.has(decision.action)) {
      // A read-only question misrouted as a control must not mutate anything.
      const query = inferStateQuery(context.text);
      if (query !== undefined) {
        if (
          decision.action === "remind" &&
          REMIND_TIME_HINT.test(context.text)
        ) {
          // The message carries a time and a read phrase. Answering only the
          // read would silently discard the reminder; ask for two steps.
          this.#reply(
            context,
            "这条消息既包含提醒时间，又包含状态查询。请拆成两步：先说明要提醒的内容，再单独查询状态。",
            "failure",
          );
          return { status: "done" };
        }
        this.#answerStateQuery(context, query);
        return { status: "done" };
      }
    }
    if (this.#personalIntents.handles(decision.action)) {
      const outcome = await this.#personalIntents.handle(decision, {
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        inboxId: context.inboxId,
        text: context.text,
      });
      for (const item of outcome.replies) {
        this.#reply(context, item.text, item.purpose);
      }
      if (outcome.wake === true) {
        void this.#wake.wake();
      }
      return { status: "done" };
    }
    switch (decision.action) {
      case "reply": {
        // A real model may ask for owner/name even when an active binding
        // already determines it. An explicit project review with one
        // resolvable binding becomes a deterministic task here.
        if (this.#tryDeterministicProjectReview(context)) {
          return { status: "done" };
        }
        // A model reply must not invent current state. Explicit read
        // questions always come from the deterministic owner snapshot.
        if (decision.queryError !== undefined) {
          this.#reply(context, `查询参数无法使用：${decision.queryError}`, "failure");
          return { status: "done" };
        }
        const stateQuery = inferStateQuery(context.text);
        if (stateQuery !== undefined) {
          this.#answerStateQuery(context, stateQuery);
          return { status: "done" };
        }
        if (isExplicitStateQuery(context.text)) {
          this.#answerStateQuery(context);
          return { status: "done" };
        }
        this.#reply(
          context,
          decision.text || "已收到。",
          decision.replyKind === "clarify" ? "clarify" : "result",
        );
        return { status: "done" };
      }
      case "create_task": {
        if (decision.task === undefined || decision.task.goal.trim().length === 0) {
          this.#reply(context, "请补充任务目标和完成条件。");
          return { status: "done" };
        }
        const ownerProject = extractProjectFlag(context.text);
        const requested = decision.task.mandate ?? { resources: ["chat"], tools: [] };
        const directQuery = inferStateQuery(context.text);
        const sustained = /(?:分析|报告|后台|持续|定期|每天|每周|周期)/.test(
          context.text,
        );
        if (
          directQuery !== undefined &&
          !sustained &&
          requested.tools.every(isStateToolName)
        ) {
          // A simple state question must not create a Worker; answer from the
          // owner-scoped snapshot instead.
          this.#answerStateQuery(context, directQuery);
          return { status: "done" };
        }
        if (
          !sustained &&
          requested.tools.every(isStateToolName) &&
          isExplicitStateQuery(context.text)
        ) {
          // D19: never dispatch a state question to a Worker that could pass
          // structural checks without reading the owner's real state.
          this.#answerStateQuery(context);
          return { status: "done" };
        }
        const requestedMandate = ensureMandateResources(
          {
            ...requested,
            project: ownerProject ?? requested.project,
          },
          this.#capabilities,
        );
        const reviewIntent = wantsProjectReview(context.text);
        let mandate = this.#constrainMandate(requestedMandate);
        if (
          mandate.tools.includes("github.read") ||
          reviewIntent
        ) {
          const resolution = resolveProjectMention({
            text: context.text,
            ownerId: context.ownerId,
            requested: mandate.project,
            projects: this.#projects,
            requireProject: reviewIntent,
          });
          if (resolution.status === "resolved") {
            mandate.project = resolution.project.projectKey;
          } else if (resolution.status !== "none") {
            this.#reply(
              context,
              describeProjectResolutionFailure(resolution),
              "failure",
            );
            return { status: "done" };
          }
          if (reviewIntent) {
            if (resolution.status !== "resolved") {
              this.#reply(
                context,
                "请指定要检查的 projectKey，例如 `检查 personal-agent 项目的最新实施情况`。",
                "failure",
              );
              return { status: "done" };
            }
            if (!mandate.tools.includes("github.read")) {
              // An explicit read-only project review needs the GitHub read
              // capability; add it only when the live catalog still offers it.
              mandate = this.#constrainMandate(
                ensureMandateResources(
                  {
                    ...mandate,
                    tools: [...new Set([...mandate.tools, "github.read"])],
                  },
                  this.#capabilities,
                ),
              );
            }
            if (!mandate.tools.includes("github.read")) {
              this.#reply(
                context,
                "GitHub 只读能力当前未启用；请先由主人启用 github 插件。",
                "failure",
              );
              return { status: "done" };
            }
            mandate.skills = [
              ...new Set([
                ...(mandate.skills ?? []),
                "github.project-review",
              ]),
            ];
          }
        }
        const project =
          mandate.project === undefined
            ? undefined
            : this.#projects?.findActiveByKey(context.ownerId, mandate.project);
        if (reviewIntent && project === undefined) {
          this.#reply(
            context,
            "项目绑定在创建任务前失效；请重新检查项目绑定后重试。",
            "failure",
          );
          return { status: "done" };
        }
        if (requested.tools.length > 0 && mandate.tools.length === 0) {
          this.#reply(
            context,
            "所需能力当前未启用；请先由主人启用相应插件。",
            "failure",
          );
          return { status: "done" };
        }
        const task = this.#taskService.create({
          ownerId: context.ownerId,
          conversationId: context.conversationId,
          sourceKey: `inbox:${context.inboxId}:task`,
          goal: decision.task.goal,
          completionCriteria: normalizeStateCriteria(
            normalizeGithubCriteria(
              decision.task.completionCriteria || "提供可核对的结果和证据",
              decision.task.goal,
              context.text,
              mandate.tools,
              mandate.skills ?? [],
              project,
            ),
            mandate.tools,
          ),
          mandate,
          priority: decision.task.priority,
        });
        const modelAck = decision.text.trim();
        const ack =
          modelAck.length > 0 &&
          modelAck.length <= 200 &&
          !/^(?:ack|ok|received|已收到|收到)[。.!！]?$/i.test(modelAck)
            ? modelAck
            : `已接单：${task.goal}`;
        this.#rememberTaskFocus(context.conversationId, task.id);
        this.#reply(
          context,
          mandate.project === undefined
            ? ack
            : `${ack}\n项目：${mandate.project}`,
        );
        void this.#wake.wake();
        return { status: "done" };
      }
      case "supplement_task": {
        const target = this.#resolveDecisionTask(context, decision);
        if (target === undefined) {
          return { status: "done" };
        }
        const result = this.#supplementTask(
          context.ownerId,
          target.id,
          decision.text,
          context.inboxId,
        );
        this.#reply(context, result.text, result.purpose);
        return { status: "done" };
      }
      case "revise_task": {
        if (decision.changes === undefined) {
          this.#reply(context, "请提供新的目标、完成条件或授权范围。", "failure");
          return { status: "done" };
        }
        const target = this.#resolveDecisionTask(context, decision);
        if (target === undefined) {
          return { status: "done" };
        }
        const result = this.#reviseTask(context.ownerId, target.id, decision.changes);
        if (!result.ok) {
          this.#reply(context, result.reason, "failure");
        }
        return { status: "done" };
      }
      case "cancel_task": {
        const target = this.#resolveDecisionTask(context, decision);
        if (target === undefined) {
          return { status: "done" };
        }
        if (
          target.status === "succeeded" ||
          target.status === "failed" ||
          target.status === "cancelled"
        ) {
          this.#reply(
            context,
            `任务 ${target.id.slice(0, 8)} 已结束（${target.status}），无需取消。`,
            "status",
          );
          return { status: "done" };
        }
        this.#taskService.cancel(target.id);
        return { status: "done" };
      }
      case "query_status": {
        if (decision.queryError !== undefined) {
          this.#reply(
            context,
            `查询参数无法使用：${decision.queryError} 请说明要查询的对象。`,
            "failure",
          );
          return { status: "done" };
        }
        const query = decision.query ?? inferStateQuery(context.text);
        if (query === undefined) {
          this.#reply(
            context,
            "请说明要查询：整体状态、任务列表、指定任务、提醒、记忆或周期计划。",
            "failure",
          );
          return { status: "done" };
        }
        this.#answerStateQuery(context, query);
        return { status: "done" };
      }
      default: {
        this.#reply(context, "我还不能处理这个请求。");
        return { status: "done" };
      }
    }
  }

  #reviseTask(
    ownerId: string,
    taskIdInput: string,
    changes: {
      goal?: string;
      completionCriteria?: string;
      mandate?: TaskRecord["mandate"];
      priority?: number;
    },
  ): { ok: true } | { ok: false; reason: string } {
    const goal = changes.goal?.trim();
    const criteria = changes.completionCriteria?.trim();
    if (
      (goal === undefined || goal.length === 0) &&
      (criteria === undefined || criteria.length === 0) &&
      changes.mandate === undefined &&
      changes.priority === undefined
    ) {
      return { ok: false, reason: "请提供新的目标、完成条件、授权范围或优先级。" };
    }

    const resolution = resolveTaskId(ownerId, taskIdInput, this.#tasks);
    if (resolution.status === "ambiguous") {
      return {
        ok: false,
        reason: [
          "任务编号前缀匹配到多个任务，请给出更长的编号：",
          ...resolution.ids.map((id) => `- ${id}`),
        ].join("\n"),
      };
    }
    if (resolution.status === "not_found") {
      return { ok: false, reason: "找不到属于你的该任务。" };
    }

    const current = this.#tasks.get(resolution.id);
    if (current === undefined) {
      return { ok: false, reason: "找不到属于你的该任务。" };
    }
    const mandate =
      changes.mandate === undefined
        ? undefined
        : this.#constrainMandate(
            ensureMandateResources(changes.mandate, this.#capabilities),
          );
    if (
      changes.mandate !== undefined &&
      changes.mandate.tools.length > 0 &&
      mandate?.tools.length === 0
    ) {
      return { ok: false, reason: "所需能力当前未启用；未修改任务。" };
    }
    if (mandate !== undefined) {
      // The router model proposes mandate changes. A revision may extend the
      // scope, but it must never shrink tools/resources and thereby weaken the
      // completion verifier for already-authorized work.
      const nextTools = new Set(mandate.tools);
      const nextResources = new Set(mandate.resources);
      const currentTools = new Set(current.mandate.tools);
      const currentResources = new Set(current.mandate.resources);
      const nextProject = mandate.project ?? null;
      const currentProject = current.mandate.project ?? null;
      const addedTools = mandate.tools.some((tool) => !currentTools.has(tool));
      const addedResources = mandate.resources.some(
        (resource) => !currentResources.has(resource),
      );
      const removedTools = current.mandate.tools.some(
        (tool) => !nextTools.has(tool),
      );
      const removedResources = current.mandate.resources.some(
        (resource) => !nextResources.has(resource),
      );
      if (
        nextProject !== currentProject ||
        addedTools ||
        addedResources ||
        removedTools ||
        removedResources
      ) {
        return {
          ok: false,
          reason:
            "修订不能改变项目范围或增减任务授权；需要新能力或更换项目时请新建任务。",
        };
      }
    }
    const nextCriteria =
      criteria === undefined || criteria.length === 0
        ? mandate !== undefined && mandate.tools.some(isStateToolName)
          ? normalizeStateCriteria(current.completionCriteria, mandate.tools)
          : undefined
        : normalizeStateCriteria(criteria, mandate?.tools ?? current.mandate.tools);

    const task = this.#taskService.revise(resolution.id, {
      goal: goal === undefined || goal.length === 0 ? undefined : goal,
      completionCriteria: nextCriteria,
      mandate,
      priority: changes.priority,
    });
    if (task === undefined) {
      return { ok: false, reason: "该任务已结束，无法修改。" };
    }
    // TaskService.revise enqueues the owner-facing status message.
    return { ok: true };
  }

  async #confirmEntry(
    ownerId: string,
    idOrPrefix: string,
  ): Promise<ReplyDraft | undefined> {
    const pending = this.#confirmation.resolvePending(ownerId, idOrPrefix);
    if (pending.status === "failure") {
      return { purpose: "failure", text: pending.reason };
    }
    const confirmation = pending.confirmation;
    try {
      if (confirmation.kind === "memory_save") {
        const key = confirmation.payload.key;
        const project =
          typeof confirmation.payload.project === "string"
            ? confirmation.payload.project
            : undefined;
        if (confirmation.payload.operation === "forget") {
          if (typeof key !== "string" || key.trim().length === 0) {
            this.#confirmation.cancel(ownerId, confirmation.id);
            return { purpose: "failure", text: "确认内容不完整，请重新发起。" };
          }
          const current = this.#memory.get(ownerId, key.trim(), project);
          if (current === undefined) {
            this.#confirmation.cancel(ownerId, confirmation.id);
            return {
              purpose: "status",
              text: "该记忆已不存在，本次确认已失效。",
            };
          }
          if (current.updatedAt > confirmation.createdAt) {
            this.#confirmation.cancel(ownerId, confirmation.id);
            return {
              purpose: "status",
              text: "该记忆在此确认之后已被修改，本次确认已失效。",
            };
          }
          this.#memory.forget(ownerId, key.trim(), project);
          this.#confirmation.markConfirmed(confirmation);
          return {
            purpose: "status",
            text: `已忘记：${project === undefined ? "" : `[项目 ${project}] `}${key}`,
          };
        }
        const value = confirmation.payload.value;
        if (typeof key !== "string" || typeof value !== "string") {
          this.#confirmation.cancel(ownerId, confirmation.id);
          return { purpose: "failure", text: "确认内容不完整，请重新发起。" };
        }
        const current = this.#memory.get(ownerId, key.trim(), project);
        if (current !== undefined && current.updatedAt > confirmation.createdAt) {
          this.#confirmation.cancel(ownerId, confirmation.id);
          return {
            purpose: "status",
            text: "该记忆在此确认之后已被修改或删除，本次确认已失效。",
          };
        }
        this.#memory.save(ownerId, key, value, confirmation.sourceInboxId, project);
        this.#confirmation.markConfirmed(confirmation);
        return {
          purpose: "status",
          text: `已记住：${project === undefined ? "" : `[项目 ${project}] `}${key} = ${value}`,
        };
      }

      const text = confirmation.payload.text;
      const dueAt = confirmation.payload.dueAt;
      const timezone = confirmation.payload.timezone;
      const runKey = confirmation.payload.runKey;
      if (
        typeof text !== "string" ||
        typeof dueAt !== "string" ||
        typeof timezone !== "string" ||
        typeof runKey !== "string"
      ) {
        this.#confirmation.cancel(ownerId, confirmation.id);
        return { purpose: "failure", text: "确认内容不完整，请重新发起。" };
      }
      await this.#reminders.create({
        ownerId,
        conversationId: confirmation.conversationId,
        text,
        dueAt,
        timezone,
        runKey,
      });
      this.#confirmation.markConfirmed(confirmation);
      // ReminderService already produced the user-visible confirmation.
      return undefined;
    } catch (error) {
      // A confirmation whose payload can never apply must not keep advertising
      // itself as valid for the rest of the TTL.
      this.#confirmation.cancel(ownerId, confirmation.id);
      return {
        purpose: "failure",
        text: `确认失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  #cancelConfirmation(ownerId: string, idOrPrefix: string): ReplyDraft {
    const result = this.#confirmation.cancel(ownerId, idOrPrefix);
    if (result.status === "failure") {
      return { purpose: "failure", text: result.reason };
    }
    return { purpose: "status", text: "已取消该待确认项。" };
  }

  #supplementTask(
    ownerId: string,
    taskIdInput: string,
    text: string,
    sourceInboxId: string,
  ): { purpose: "status" | "failure"; text: string } {
    if (text.trim().length === 0) {
      return { purpose: "failure", text: "请补充要回答的内容。" };
    }
    const resolution = resolveTaskId(ownerId, taskIdInput, this.#tasks);
    if (resolution.status === "ambiguous") {
      return {
        purpose: "failure",
        text: [
          "任务编号前缀匹配到多个任务，请给出更长的编号：",
          ...resolution.ids.map((id) => `- ${id}`),
        ].join("\n"),
      };
    }
    if (resolution.status === "not_found") {
      return { purpose: "failure", text: "找不到属于你的该任务。" };
    }
    const added = this.#taskService.supplement(resolution.id, text, sourceInboxId);
    if (added === undefined) {
      return { purpose: "failure", text: "该任务已结束，无法继续补充。" };
    }
    if (!added.inserted) {
      return {
        purpose: "status",
        text: `该补充已受理（输入 #${added.input.seq}）。`,
      };
    }
    const timing =
      added.task.status === "running"
        ? "当前 Worker 的旧结果不会生效；结束后会按最新输入重新执行。"
        : added.task.status === "waiting_external"
          ? "在途动作核对后生效。"
          : "已继续处理。";
    return {
      purpose: "status",
      text: `已补充任务 ${added.task.id.slice(0, 8)}（输入 #${added.input.seq}），${timing}`,
    };
  }

  statusText(ownerId: string): string {
    const tasks = this.#tasks.listByOwner(ownerId, 5);
    const counts = this.#tasks.countsByOwner(ownerId);
    const lines = [
      `服务运行中。受理 ${this.#store.countInbox("accepted")} 条，拒绝 ${this.#store.countInbox("rejected")} 条；`,
      `待发送 ${this.#store.countOutbox("pending")} 条，待核对投递 ${this.#store.countOutbox("unknown")} 条，` +
        `需人工 ${this.#store.countOutbox("needs_manual")} 条。`,
      `任务：排队 ${counts.queued}，运行 ${counts.running}，` +
        `等待 ${counts.waiting_user + counts.waiting_external}，` +
        `完成 ${counts.succeeded}，待核对任务 ${counts.needs_review}，` +
        `失败 ${counts.failed}。`,
    ];
    if (tasks.length > 0) {
      lines.push("最近任务：");
      for (const task of tasks) {
        lines.push(`- ${task.id.slice(0, 8)} ${task.status} ${task.goal}`);
      }
    }
    return lines.join("\n");
  }

  #scheduleCommand(
    ownerId: string,
    conversationId: string,
    subcommandRaw: string | undefined,
    rest: string,
  ): ReplyDraft[] {
    const service = this.#schedulePolicy;
    if (service === undefined) {
      return [{ purpose: "failure", text: "当前运行未启用周期计划。" }];
    }
    const subcommand = (subcommandRaw ?? "list").toLowerCase();
    const aliases: Record<string, string> = {
      "列表": "list",
      "查看": "show",
      "新建": "new",
      "创建": "new",
      "确认": "confirm",
      "暂停": "pause",
      "恢复": "resume",
      "取消": "cancel",
      "修改": "edit",
    };
    const sub = aliases[subcommand] ?? subcommand;
    const [first, ...tail] = rest.split(/\s+/).filter((token) => token.length > 0);

    if (sub === "list") {
      const policies = service.list(ownerId);
      return [
        {
          purpose: "status",
          text:
            policies.length === 0
              ? "当前没有周期计划。创建：/schedule new <owner/name> <HH:MM> <daily|weekdays> <内容>"
              : ["周期计划：", ...policies.map((policy) => formatSchedulePolicy(policy))].join("\n"),
        },
      ];
    }

    if (sub === "new") {
      const parsed = parseScheduleSpec(rest);
      if (!parsed.ok) {
        return [{ purpose: "failure", text: parsed.reason }];
      }
      const result = service.createDraft(ownerId, conversationId, parsed.value);
      if (!result.ok) {
        return [{ purpose: "failure", text: result.reason }];
      }
      return [
        {
          purpose: "status",
          text: [
            "已创建计划草稿（未激活，不会触发任务）：",
            formatSchedulePolicy(result.policy, true),
            `收件人：当前私聊会话（${conversationId}）`,
            "确认后才会按上述频率、仓库与内容创建任务，并回传到该会话。",
            `确认：/schedule confirm ${result.policy.id}`,
            `取消：/schedule cancel ${result.policy.id}`,
          ].join("\n"),
        },
      ];
    }

    if (sub === "edit") {
      if (first === undefined) {
        return [{ purpose: "failure", text: "请提供计划编号。" }];
      }
      const parsed = parseScheduleSpec(tail.join(" "));
      if (!parsed.ok) {
        return [{ purpose: "failure", text: parsed.reason }];
      }
      const result = service.edit(ownerId, first, parsed.value);
      if (!result.ok) {
        return [{ purpose: "failure", text: result.reason }];
      }
      return [
        {
          purpose: "status",
          text: [
            "计划已修改并退回草稿，旧版本授权立即失效；确认前不会触发。",
            formatSchedulePolicy(result.policy, true),
            `重新确认：/schedule confirm ${result.policy.id}`,
          ].join("\n"),
        },
      ];
    }

    if (sub === "confirm" || sub === "pause" || sub === "resume" || sub === "cancel" || sub === "show") {
      if (first === undefined) {
        return [{ purpose: "failure", text: "请提供计划编号。" }];
      }
      if (sub === "show") {
        const policy = service.resolve(ownerId, first);
        return [
          policy === undefined
            ? { purpose: "failure", text: "找不到属于你的该计划。" }
            : { purpose: "status", text: formatSchedulePolicy(policy, true) },
        ];
      }
      const result =
        sub === "confirm"
          ? service.confirm(ownerId, first)
          : sub === "pause"
            ? service.pause(ownerId, first)
            : sub === "resume"
              ? service.resume(ownerId, first)
              : service.cancel(ownerId, first);
      if (!result.ok) {
        return [{ purpose: "failure", text: result.reason }];
      }
      if (sub === "confirm" || sub === "resume") {
        // Wake now, not at nextRunAt: the host stores one shared maintenance
        // job, so moving it forward would defer earlier effects/reminders or
        // another plan's nearer occurrence. Maintenance recomputes the true
        // earliest due time. Node uses a no-op wake and polls instead.
        void this.#wake.wake();
      }
      const action =
        sub === "confirm"
          ? "已确认并激活"
          : sub === "pause"
            ? "已暂停"
            : sub === "resume"
              ? "已恢复"
              : "已取消";
      return [
        {
          purpose: "status",
          text: `${action}。\n${formatSchedulePolicy(result.policy, true)}`,
        },
      ];
    }

    return [
      {
        purpose: "failure",
        text:
          "用法：/schedule list | new | show | confirm | pause | resume | cancel | edit",
      },
    ];
  }

  async #command(event: InboxRecord, text: string): Promise<ReplyDraft[] | undefined> {
    const now = this.#now().toISOString();
    const ownerId = event.ownerId;
    const conversationId = event.conversationId;
    if (ownerId === undefined || conversationId === undefined) {
      return undefined;
    }

    if (text === "/status" || text === "状态") {
      return [{ purpose: "status", text: this.statusText(ownerId) }];
    }

    if (text === "/诊断" || text === "诊断") {
      const snapshot = buildDiagnostics(
        {
          store: this.#store,
          tasks: this.#tasks,
          actions: this.#actions,
          effects: this.#effects,
          confirmations: this.#confirmation,
        },
        now,
        { ownerId, limit: 10 },
      );
      return [{ purpose: "status", text: formatDiagnostics(snapshot) }];
    }

    if (text === "/usage" || text === "用量") {
      const snapshot = buildUsage(
        {
          store: this.#store,
          tasks: this.#tasks,
          actions: this.#actions,
          effects: this.#effects,
          confirmations: this.#confirmation,
        },
        now,
      );
      const magpie = await this.#budget?.summaryText();
      const local = formatUsage(snapshot);
      const hasMagpieData = magpie !== undefined && !magpie.startsWith("Magpie：不可用");
      return [
        {
          purpose: "status",
          text:
            magpie === undefined
              ? local
              : `${(hasMagpieData
                  ? local
                      .split("\n")
                      .filter((line) => !line.startsWith(TOKEN_COST_LINE_PREFIX))
                      .join("\n")
                  : local)}\n\n${magpie}`,
        },
      ];
    }

    const allowRead = /^\/(?:allow-read|预授权)\s+(\S+)\s*$/i.exec(text);
    if (allowRead !== null) {
      const result = this.#preauthorization.grant(ownerId, allowRead[1] as string);
      return [
        result.ok
          ? {
              purpose: "status",
              text:
                `已允许只读查询 ${result.grant.repo}（github.read，至 ${result.grant.expiresAt}）。\n` +
                `撤销：/revoke-read ${result.grant.repo}`,
            }
          : { purpose: "failure", text: result.reason },
      ];
    }

    const revokeRead = /^\/(?:revoke-read|撤销预授权)\s+(\S+)\s*$/i.exec(text);
    if (revokeRead !== null) {
      const result = this.#preauthorization.revoke(ownerId, revokeRead[1] as string);
      return [
        {
          purpose: result.ok ? "status" : "failure",
          text: result.ok
            ? `已撤销 ${result.repo} 的只读预授权。`
            : `没有找到 ${result.repo} 的有效预授权。`,
        },
      ];
    }

    if (text === "/preauth" || text === "预授权列表") {
      const grants = this.#preauthorization.list(ownerId);
      return [
        {
          purpose: "status",
          text:
            grants.length === 0
              ? "当前没有只读预授权。"
              : grants
                  .map(
                    (grant) =>
                      `- ${grant.repo} ${grant.tool} ${grant.status} 至 ${grant.expiresAt}`,
                  )
                  .join("\n"),
        },
      ];
    }

    const schedule = /^\/(?:schedule|计划)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (schedule !== null) {
      return this.#scheduleCommand(
        ownerId,
        conversationId,
        schedule[1],
        (schedule[2] ?? "").trim(),
      );
    }

    const confirm = /^\/(?:确认|confirm)\s+(\S+)$/.exec(text);
    if (confirm !== null) {
      const reply = await this.#confirmEntry(ownerId, confirm[1] as string);
      return reply === undefined ? [] : [reply];
    }

    const cancelConfirm = /^\/(?:取消确认|cancel-confirm)\s+(\S+)$/.exec(text);
    if (cancelConfirm !== null) {
      return [this.#cancelConfirmation(ownerId, cancelConfirm[1] as string)];
    }

    if (text === "/tasks" || text === "任务") {
      const tasks = this.#tasks.listByOwner(ownerId);
      if (tasks.length === 0) {
        return [{ purpose: "status", text: "当前没有任务。" }];
      }
      return [
        {
          purpose: "status",
          text: tasks
            .map((task) => {
              const unconsumed = this.#tasks.countUnconsumedInputs(task.id);
              const suffix = unconsumed > 0 ? `（待消费输入 ${unconsumed}）` : "";
              return `- ${task.id.slice(0, 8)} ${task.status} ${task.goal}${suffix}`;
            })
            .join("\n"),
        },
      ];
    }

    const ack = /^\/(?:ack|确认完成)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
    if (ack !== null) {
      const resolution = resolveTaskId(ownerId, ack[1] as string, this.#tasks);
      if (resolution.status === "ambiguous") {
        return [
          {
            purpose: "failure",
            text: "任务编号前缀匹配到多个任务，请给出更长的编号。",
          },
        ];
      }
      if (resolution.status === "not_found") {
        return [{ purpose: "failure", text: "找不到属于你的该任务。" }];
      }
      const result = this.#taskService.acknowledge(
        resolution.id,
        ownerId,
        ack[2]?.trim(),
      );
      return result.ok ? [] : [{ purpose: "failure", text: result.reason ?? "无法确认任务。" }];
    }

    const cancel = /^\/(?:cancel|取消)\s+(\S+)$/.exec(text);
    if (cancel !== null) {
      const resolution = resolveTaskId(ownerId, cancel[1] as string, this.#tasks);
      if (resolution.status === "ambiguous") {
        return [
          {
            purpose: "failure",
            text: [
              "任务编号前缀匹配到多个任务，请给出更长的编号：",
              ...resolution.ids.map((id) => `- ${id}`),
            ].join("\n"),
          },
        ];
      }
      if (resolution.status === "not_found") {
        return [{ purpose: "failure", text: "找不到属于你的该任务。" }];
      }
      this.#taskService.cancel(resolution.id);
      return [];
    }

    const supplement = /^\/(?:补充|回答)\s+(\S+)\s+(.+)$/.exec(text);
    if (supplement !== null) {
      return [
        this.#supplementTask(
          ownerId,
          supplement[1] as string,
          supplement[2] as string,
          event.id,
        ),
      ];
    }

    const revise = /^\/(?:revise|修改)\s+(\S+)\s+(.+)$/.exec(text);
    if (revise !== null) {
      const body = (revise[2] as string).trim();
      const goal = /目标\s*[=:：]\s*(.+?)(?=\s*(?:[;；]|完成条件\s*[=:：])|$)/.exec(body)?.[1]?.trim();
      const criteria = /完成条件\s*[=:：]\s*(.+?)(?=\s*(?:[;；]|目标\s*[=:：])|$)/.exec(body)?.[1]?.trim();
      const changes: {
        goal?: string;
        completionCriteria?: string;
      } = {};
      if (goal !== undefined && goal.length > 0) {
        changes.goal = goal;
      }
      if (criteria !== undefined && criteria.length > 0) {
        changes.completionCriteria = criteria;
      }
      if (changes.goal === undefined && changes.completionCriteria === undefined) {
        changes.goal = body;
      }
      const result = this.#reviseTask(ownerId, revise[1] as string, changes);
      return result.ok ? [] : [{ purpose: "failure", text: result.reason }];
    }

    const draftCommand =
      /^\/(?:draft|drafts)\s+(list|show|approve|reject)(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(
        text,
      );
    if (draftCommand !== null) {
      return this.#handleDraftCommand(
        draftCommand,
        ownerId,
        conversationId,
      );
    }

    const approve =
      /^\/(?:approve|批准)\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+(\d+))?$/.exec(text);
    if (approve !== null) {
      const result = this.#actionService.approve({
        actionId: approve[1] as string,
        nonce: approve[2] as string,
        approverId: ownerId,
        conversationId,
        expectedArgsHash: approve[3],
        expectedTaskRevision:
          approve[4] === undefined ? undefined : Number(approve[4]),
      });
      if (!result.ok) {
        return [{ purpose: "failure", text: `无法批准：${result.reason}` }];
      }
      return [];
    }

    const deny =
      /^\/(?:deny|拒绝)\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+(\d+))?$/.exec(text);
    if (deny !== null) {
      const result = this.#actionService.deny({
        actionId: deny[1] as string,
        nonce: deny[2] as string,
        approverId: ownerId,
        conversationId,
        expectedArgsHash: deny[3],
        expectedTaskRevision:
          deny[4] === undefined ? undefined : Number(deny[4]),
      });
      if (!result.ok) {
        return [{ purpose: "failure", text: `无法拒绝：${result.reason}` }];
      }
      return [];
    }

    if (text === "/memory" || text === "记忆" || text.startsWith("/memory --project=")) {
      const project = extractProjectFlag(text);
      if (invalidProjectFlag(text, project)) {
        return [
          {
            purpose: "failure",
            text: "项目名无效：只允许 1–64 位字母、数字、点、下划线或连字符。",
          },
        ];
      }
      const memories =
        project === undefined
          ? this.#memory.list(ownerId)
          : this.#memory.listApplicable(ownerId, project);
      if (memories.length === 0) {
        return [{ purpose: "status", text: "当前没有保存的记忆。" }];
      }
      return [
        {
          purpose: "status",
          text: memories
            .map(
              (memory) =>
                `- ${memory.project === undefined ? "[全局] " : `[项目 ${memory.project}] `}` +
                `${memory.key} = ${memory.value}`,
            )
            .join("\n"),
        },
      ];
    }

    const remember =
      /^\/(?:remember|记住)\s+(?:--project=(\S+)\s+)?([^=\s]+)\s*=\s*(.+)$/.exec(
        text,
      );
    if (remember !== null) {
      const project = remember[1] ?? extractProjectFlag(text);
      if (invalidProjectFlag(text, project)) {
        return [
          {
            purpose: "failure",
            text: "项目名无效：只允许 1–64 位字母、数字、点、下划线或连字符。",
          },
        ];
      }
      try {
        this.#memory.save(
          ownerId,
          remember[2] as string,
          remember[3] as string,
          event.id,
          project,
        );
        return [
          {
            purpose: "status",
            text:
              `已记住：${project === undefined ? "" : `[项目 ${project}] `}` +
              `${remember[2]} = ${remember[3]}`,
          },
        ];
      } catch (error) {
        return [
          {
            purpose: "failure",
            text: `无法保存记忆：${error instanceof Error ? error.message : String(error)}`,
          },
        ];
      }
    }

    const forget =
      /^\/(?:forget|忘记)\s+(?:--project=(\S+)\s+)?(\S+)$/.exec(text);
    if (forget !== null) {
      const project = forget[1] ?? extractProjectFlag(text);
      if (invalidProjectFlag(text, project)) {
        return [
          {
            purpose: "failure",
            text: "项目名无效：只允许 1–64 位字母、数字、点、下划线或连字符。",
          },
        ];
      }
      const memory = this.#memory.forget(ownerId, forget[2] as string, project);
      return [
        memory === undefined
          ? { purpose: "failure", text: "没有找到这条记忆。" }
          : {
              purpose: "status",
              text:
                `已忘记：${project === undefined ? "" : `[项目 ${project}] `}` +
                `${forget[2]}`,
            },
      ];
    }

    const remind = /^\/(?:remind|提醒)\s+(\S+)\s+(.+)$/.exec(text);
    if (remind !== null) {
      try {
        await this.#reminders.create({
          ownerId,
          conversationId,
          text: remind[2] as string,
          dueAt: remind[1] as string,
          timezone: this.#timezone,
          runKey: `inbox:${event.id}:reminder`,
        });
      } catch (error) {
        this.#store.enqueueOutbox({
          businessKey: `inbox:${event.id}:reminder-error`,
          ownerId,
          channel: event.channel,
          accountId: event.accountId,
          conversationId: event.platformConversationId,
          purpose: "failure",
          text: `无法创建提醒：${error instanceof Error ? error.message : String(error)}`,
          createdAt: now,
          traceId: `inbox:${event.id}`,
        });
      }
      return [];
    }

    if (text === "/reminders" || text === "提醒列表") {
      return [
        {
          purpose: "status",
          text: formatSchedules(this.#reminders.list(ownerId)),
        },
      ];
    }

    const cancelReminder = /^\/(?:cancel-reminder|取消提醒)\s+(\S+)$/.exec(text);
    if (cancelReminder !== null) {
      const result = await this.#reminders.cancel(cancelReminder[1] as string, ownerId);
      if (!result.ok) {
        return [
          {
            purpose: "failure",
            text: `无法取消提醒：${describeReminderCancelFailure(result.reason)}`,
          },
        ];
      }
      return [];
    }

    if (text === "/help" || text === "帮助") {
      return [
        {
          purpose: "status",
          text: [
            "可用命令：",
            "/status 状态；/诊断 诊断；/usage 用量；/tasks 任务；/cancel <taskId 或前缀>",
            "/确认 <id>；/取消确认 <id>（模型发起的记忆/提醒）",
            "/allow-read <owner/repo>；/revoke-read <owner/repo>；/preauth",
            "/补充 <taskId> <内容>；/回答 <taskId> <内容>",
            "/修改 <taskId> <新目标>；/修改 <taskId> 目标=... 完成条件=...",
            "/approve <actionId> <nonce> [argsHash revision]；/deny 同上",
            "/memory [--project=名称]；/remember [--project=名称] key=value；/forget [--project=名称] key",
            "/remind <ISO时间> <内容>；/reminders 提醒列表；/cancel-reminder <id>",
          ].join("\n"),
        },
      ];
    }

    return undefined;
  }

  /**
   * Deterministic project-review entry used when the Router model replies
   * with a clarification instead of a task. It never guesses a repository:
   * the owner's mention must resolve to exactly one active ProjectBinding.
   */
  #tryDeterministicProjectReview(context: {
    ownerId: string;
    conversationId: string;
    inboxId: string;
    text?: string;
  }): boolean {
    const text = context.text ?? "";
    if (!wantsProjectReview(text)) {
      return false;
    }
    const resolution = resolveProjectMention({
      text,
      ownerId: context.ownerId,
      projects: this.#projects,
      requireProject: true,
    });
    if (resolution.status !== "resolved") {
      if (resolution.status === "none") {
        return false;
      }
      this.#reply(context, describeProjectResolutionFailure(resolution), "failure");
      return true;
    }
    const project = resolution.project;
    const mandate = this.#constrainMandate(
      ensureMandateResources(
        {
          resources: ["chat", "github"],
          tools: ["github.read"],
          skills: ["github.project-review"],
          project: project.projectKey,
        },
        this.#capabilities,
      ),
    );
    if (!mandate.tools.includes("github.read")) {
      this.#reply(
        context,
        "GitHub 只读能力当前未启用；请先由主人启用 github 插件。",
        "failure",
      );
      return true;
    }
    const task = this.#taskService.create({
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      sourceKey: `inbox:${context.inboxId}:task`,
      goal: text,
      completionCriteria: normalizeStateCriteria(
        normalizeGithubCriteria(
          "只读项目评估：给出有证据的 findings、关联已有 Issue 和待审批的修改草稿。",
          text,
          text,
          mandate.tools,
          mandate.skills ?? [],
          project,
        ),
        mandate.tools,
      ),
      mandate,
    });
    this.#rememberTaskFocus(context.conversationId, task.id);
    this.#reply(context, `已接单：${task.goal}\n项目：${project.projectKey}`, "ack");
    void this.#wake.wake();
    return true;
  }

  async #handleDraftCommand(
    match: RegExpExecArray,
    ownerId: string,
    conversationId: string,
  ): Promise<ReplyDraft[]> {
    if (this.#issueDrafts === undefined) {
      return [{ purpose: "failure", text: "还没有持久化的 Issue 草稿。" }];
    }
    const sub = match[1]?.toLowerCase();
    const id = match[2];
    if (sub === "list") {
      const drafts = this.#issueDrafts.list(ownerId, {
        status: "pending_approval",
        limit: 10,
      });
      if (drafts.length === 0) {
        return [{ purpose: "status", text: "没有待批准的 Issue 草稿。" }];
      }
      return [
        {
          purpose: "status",
          text: [
            "待批准的 Issue 草稿：",
            ...drafts.map((draft) => formatDraftSummary(draft)),
            "查看：/draft show <id>",
            "批准：/draft approve <id> <payloadHash>",
            "拒绝：/draft reject <id>",
          ].join("\n"),
        },
      ];
    }
    if (id === undefined) {
      return [{ purpose: "failure", text: "请提供 draft id。" }];
    }
    const draft = this.#issueDrafts.get(ownerId, id);
    if (draft === undefined) {
      return [{ purpose: "failure", text: "找不到属于你的该草稿。" }];
    }
    if (sub === "show") {
      return [{ purpose: "status", text: formatDraftDetail(draft) }];
    }
    if (sub === "reject") {
      const result = this.#issueDrafts.reject(ownerId, id, ownerId);
      return result.ok
        ? [{ purpose: "status", text: `已拒绝草稿 ${id.slice(0, 8)}，不会写入 GitHub。` }]
        : [{ purpose: "failure", text: `无法拒绝：${result.reason ?? "unknown"}` }];
    }
    if (sub === "approve") {
      const payloadHash = match[3];
      if (this.#issueDraftApproval === undefined) {
        return [
          {
            purpose: "failure",
            text: "Issue 写能力未启用：需要 owner 配置独立的 Issues-write 凭据与写白名单。",
          },
        ];
      }
      if (payloadHash === undefined) {
        return [
          {
            purpose: "failure",
            text: "批准必须包含完整的 payloadHash（见 /draft show）。",
          },
        ];
      }
      const result = await this.#issueDraftApproval.approve({
        ownerId,
        conversationId,
        draftId: id,
        payloadHash,
        actorId: ownerId,
      });
      if (!result.ok) {
        return [
          {
            purpose: "failure",
            text: `无法批准：${result.reason ?? "unknown"}。未执行任何 GitHub 写入。`,
          },
        ];
      }
      return [
        {
          purpose: "status",
          text:
            `已批准草稿 ${id.slice(0, 8)}，提交受控写入。` +
            "写入完成后会执行写后读取核对；结果未知时不会自动重复 POST。",
        },
      ];
    }
    return [{ purpose: "failure", text: "draft 子命令应为 list/show/approve/reject。" }];
  }

  #rememberTaskFocus(conversationId: string, taskId: string): void {
    this.#store.metaSet(taskFocusKey(conversationId), taskId);
  }

  /**
   * A model may only request capabilities that are enabled right now. This
   * runs after the static/model allow-list so a stale prompt or a disabled
   * plugin can never create a task that claims new authority.
   */
  #constrainMandate(mandate: Mandate): Mandate {
    if (this.#capabilities === undefined) {
      return mandate;
    }
    const tools = mandate.tools.filter(
      (name) => this.#capabilities?.toolInfo(name) !== undefined,
    );
    const resources = new Set(
      mandate.resources.filter((name) => this.#capabilities?.resources().includes(name)),
    );
    for (const name of tools) {
      const resource = this.#capabilities.resourceForTool(name);
      if (resource !== undefined) {
        resources.add(resource);
      }
    }
    return {
      ...mandate,
      tools,
      resources: [...resources],
    };
  }

  /**
   * Resolve the model's task id/reference against the real owner task set.
   * Ambiguity is reported, never guessed; no mutation runs without a target.
   */
  #resolveDecisionTask(
    context: {
      ownerId: string;
      conversationId: string;
      inboxId: string;
      text?: string;
    },
    decision: RouterDecision,
  ): TaskRecord | undefined {
    const text = context.text ?? "";
    const flagProject = extractProjectFlag(text);
    if (invalidProjectFlag(text, flagProject)) {
      this.#reply(
        context,
        "项目名无效：只允许 1–64 位字母、数字、点、下划线或连字符。",
        "failure",
      );
      return undefined;
    }
    const project = flagProject ?? decision.project;
    if (decision.taskId !== undefined) {
      const explicit = resolveTaskId(context.ownerId, decision.taskId, this.#tasks);
      if (explicit.status === "ok") {
        const task = this.#tasks.get(explicit.id);
        if (
          task !== undefined &&
          (project === undefined || task.mandate.project === project)
        ) {
          this.#rememberTaskFocus(context.conversationId, task.id);
          return task;
        }
      }
      if (explicit.status === "ambiguous") {
        const candidates = explicit.ids
          .map((id) => this.#tasks.get(id))
          .filter((task): task is TaskRecord => task !== undefined);
        this.#reply(context, formatTaskCandidates(candidates), "failure");
      } else {
        this.#reply(
          context,
          formatTaskNotFound("找不到属于你的该任务。", decision.taskId),
          "failure",
        );
      }
      return undefined;
    }

    const ref = decision.taskRef;
    const resolution = resolveTaskReference(
      context.ownerId,
      context.conversationId,
      ref,
      this.#tasks,
      {
        activeOnly: true,
        preferredTaskId: this.#store.metaGet(
          taskFocusKey(context.conversationId),
        ),
        project,
      },
    );
    if (resolution.status === "ok") {
      this.#rememberTaskFocus(context.conversationId, resolution.task.id);
      return resolution.task;
    }
    if (resolution.status === "ambiguous") {
      this.#reply(context, formatTaskCandidates(resolution.candidates), "failure");
    } else {
      this.#reply(context, formatTaskNotFound(resolution.reason, ref), "failure");
    }
    return undefined;
  }

  /**
   * Deterministic answer from the owner-scoped state service; no Worker and
   * no model-authored facts. All resolution/audit lives in StateQueryHandler.
   */
  #answerStateQuery(
    context: {
      ownerId: string;
      conversationId: string;
      inboxId: string;
      text?: string;
    },
    requested?: StateQuery,
  ): void {
    for (const item of this.#stateQuery.handle(context, requested)) {
      this.#reply(context, item.text, item.purpose);
    }
  }

  #reply(
    context: { ownerId: string; conversationId: string; inboxId: string },
    text: string,
    purpose: OutboxPurpose = "ack",
  ): void {
    const conversation = this.#store.getConversation(context.conversationId);
    if (conversation === undefined) {
      return;
    }
    this.#store.enqueueOutbox({
      businessKey: `inbox:${context.inboxId}:route:reply`,
      ownerId: context.ownerId,
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.platformConversationId,
      purpose,
      text,
      createdAt: this.#now().toISOString(),
      traceId: `inbox:${context.inboxId}`,
    });
  }
}


function formatDraftSummary(draft: IssueDraftView): string {
  const target = draft.targetIssue === undefined ? "" : ` #${draft.targetIssue}`;
  return (
    `- ${draft.id.slice(0, 8)} ${draft.action}${target} ${draft.title.slice(0, 80)}` +
    ` (payload ${draft.payloadHash.slice(0, 12)}…, expires ${draft.expiresAt})`
  );
}

function formatDraftDetail(draft: IssueDraftView): string {
  const target = draft.targetIssue === undefined ? "" : ` #${draft.targetIssue}`;
  const before =
    draft.beforeSummary === undefined
      ? "-"
      : draft.beforeSummary.replace(/[\r\n\t]+/g, " ").slice(0, 500);
  const after = draft.body.replace(/[\r\n\t]+/g, " ").slice(0, 800);
  return [
    `草稿 ${draft.id}`,
    `动作：${draft.action}${target}  状态：${draft.status}/${draft.validity}`,
    `仓库：${draft.repositoryFullName} (repoId ${draft.repositoryId})`,
    `来源：task ${draft.sourceTaskId} rev ${draft.sourceTaskRevision} commit ${draft.commitSha}`,
    `凭据：${draft.credentialRef} v${draft.credentialVersion ?? "?"}`,
    `标题：${draft.title}`,
    `修改前：${before}`,
    `拟写入：${after}`,
    `payloadHash：${draft.payloadHash}`,
    `过期：${draft.expiresAt}`,
    `批准：/draft approve ${draft.id} ${draft.payloadHash}`,
  ].join("\n");
}
