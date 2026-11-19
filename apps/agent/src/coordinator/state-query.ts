import type {
  SchedulePolicyRecord,
  ScheduleRecord,
  StateQuery,
  StateQueryTarget,
  TaskRecord,
  TaskStatus,
} from "../domain/types.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import {
  formatStateSummary,
  type StateSnapshot,
} from "../actions/state.ts";

const TARGETS: readonly StateQueryTarget[] = [
  "summary",
  "tasks",
  "task",
  "reminders",
  "memories",
  "schedules",
];
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
const PROJECT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PREFIX_SCAN_LIMIT = 1_000;
const AMBIGUOUS_LIST_LIMIT = 5;

export type StateQueryParse =
  | { ok: true; query: StateQuery }
  | { ok: false; reason: string };

interface QueryFieldRule {
  taskId?: true;
  taskRef?: true;
  project?: true;
  status?: true;
  limit?: true;
  offset?: true;
}

const FIELD_RULES: Record<StateQueryTarget, QueryFieldRule> = {
  summary: { project: true },
  tasks: { project: true, status: true, limit: true, offset: true },
  task: { taskId: true, taskRef: true, project: true },
  reminders: { limit: true, offset: true },
  memories: { project: true, limit: true, offset: true },
  schedules: { limit: true, offset: true },
};

/**
 * Validate a model-proposed query. Unknown or inapplicable fields are
 * rejected instead of silently ignored, so the owner is asked rather than
 * shown a different scope than requested.
 */
export function parseStateQuery(value: unknown): StateQueryParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "查询参数必须是对象。" };
  }
  const raw = value as Record<string, unknown>;
  const target = raw.target;
  if (
    typeof target !== "string" ||
    !(TARGETS as readonly string[]).includes(target)
  ) {
    return {
      ok: false,
      reason: "请说明要查询：整体状态、任务列表、指定任务、提醒、记忆或周期计划。",
    };
  }
  const queryTarget = target as StateQueryTarget;
  const rules = FIELD_RULES[queryTarget];
  const allowed = new Set<string>(["target", ...Object.keys(rules)]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        reason: `查询“${queryTarget}”不支持字段“${key}”。`,
      };
    }
  }

  const query: StateQuery = { target: queryTarget };
  if (raw.taskId !== undefined) {
    if (typeof raw.taskId !== "string" || raw.taskId.trim().length === 0 || raw.taskId.length > 64) {
      return { ok: false, reason: "taskId 必须是 1–64 位字符串。" };
    }
    query.taskId = raw.taskId.trim();
  }
  if (raw.taskRef !== undefined) {
    if (typeof raw.taskRef !== "string" || raw.taskRef.trim().length === 0 || raw.taskRef.length > 200) {
      return { ok: false, reason: "任务指代必须是 1–200 位字符串。" };
    }
    query.taskRef = raw.taskRef.trim();
  }
  if (raw.project !== undefined) {
    if (typeof raw.project !== "string" || !PROJECT_PATTERN.test(raw.project)) {
      return { ok: false, reason: "项目名只允许 1–64 位字母、数字、点、下划线或连字符。" };
    }
    query.project = raw.project;
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !(TASK_STATUSES as readonly string[]).includes(raw.status)) {
      return { ok: false, reason: "任务状态不在允许范围内。" };
    }
    query.status = raw.status as TaskStatus;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 20) {
      return { ok: false, reason: "limit 必须是 1–20 的整数。" };
    }
    query.limit = raw.limit;
  }
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 0 || raw.offset > 10_000) {
      return { ok: false, reason: "offset 必须是 0–10000 的整数。" };
    }
    query.offset = raw.offset;
  }
  return { ok: true, query };
}

const ORDINAL_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseOrdinal(value: string): number | undefined {
  const token = value.trim();
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  if (token === "十") {
    return 10;
  }
  const ten = /^十([一二三四五六七八九])$/.exec(token);
  if (ten !== null) {
    return 10 + (ORDINAL_DIGITS[ten[1] as string] ?? 0);
  }
  return ORDINAL_DIGITS[token];
}

export type TaskIdResolution =
  | { status: "ok"; id: string }
  | { status: "ambiguous"; ids: string[] }
  | { status: "not_found" };

/**
 * Task lists print the first 8 characters of an id, so commands accept either
 * a full id or a unique prefix. Ownership is checked for both.
 */
export function resolveTaskId(
  ownerId: string,
  input: string,
  tasks: Pick<TaskRepository, "get" | "listByOwner">,
): TaskIdResolution {
  const value = input.trim();
  if (value.length === 0) {
    return { status: "not_found" };
  }
  const exact = tasks.get(value);
  if (exact !== undefined && exact.ownerId === ownerId) {
    return { status: "ok", id: exact.id };
  }
  const matches = tasks
    .listByOwner(ownerId, PREFIX_SCAN_LIMIT)
    .filter((task) => task.id.startsWith(value));
  const [match] = matches;
  if (matches.length === 1 && match !== undefined) {
    return { status: "ok", id: match.id };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", ids: matches.map((task) => task.id) };
  }
  return { status: "not_found" };
}

export type TaskReferenceResolution =
  | { status: "ok"; task: TaskRecord }
  | { status: "ambiguous"; candidates: TaskRecord[] }
  | { status: "not_found"; reason: string };

function active(task: TaskRecord): boolean {
  return (
    task.status !== "succeeded" &&
    task.status !== "failed" &&
    task.status !== "cancelled"
  );
}

const DEICTIC = /^(?:刚才|刚刚|上一个|上次|之前|前面|那个|这个|它)/;
const CONTINUE = /(?:继续|接着|往下|恢复)/;
const ORDINAL = /第\s*([0-9]+|[一二两三四五六七八九十]+)\s*(?:个|项|条)?\s*(?:任务)?/;
const TASK_NUMBER = /(?:task|任务)\s*#?\s*(\d+)/i;
const KEYWORD_NOISE =
  /(?:刚才|刚刚|上一个|上次|之前|前面|那个|这个|任务|目标|继续|接着|处理|一下|帮我|把|的|先|再|请)/g;

function keywordTaskRef(ref: string): string | undefined {
  const keyword = ref
    .replace(KEYWORD_NOISE, " ")
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .trim();
  return keyword.length >= 2 ? keyword : undefined;
}

function unique(
  candidates: TaskRecord[],
  reason: string,
): TaskReferenceResolution {
  if (candidates.length === 1) {
    return { status: "ok", task: candidates[0] as TaskRecord };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", candidates };
  }
  return { status: "not_found", reason };
}

/**
 * Resolve a natural language task reference against tasks the owner can
 * access. The same conversation is preferred for deictic and continuation
 * references; explicit ids and ordinals use the owner-visible list order
 * (newest first), matching task.list output.
 */
export function resolveTaskReference(
  ownerId: string,
  conversationId: string,
  ref: string | undefined,
  tasks: Pick<TaskRepository, "get" | "listByOwner">,
  options: { activeOnly?: boolean; preferredTaskId?: string } = {},
): TaskReferenceResolution {
  const value = (ref ?? "").trim();
  const all = tasks.listByOwner(ownerId, PREFIX_SCAN_LIMIT);
  const scoped = all.filter((task) => task.conversationId === conversationId);

  if (/^[0-9a-f]{8,64}$/i.test(value) || /^[0-9a-f][0-9a-f-]{7,63}$/i.test(value)) {
    const resolved = resolveTaskId(ownerId, value, tasks);
    if (resolved.status === "ok") {
      const task = all.find((item) => item.id === resolved.id);
      return task === undefined
        ? { status: "not_found", reason: "找不到属于你的该任务。" }
        : { status: "ok", task };
    }
    if (resolved.status === "ambiguous") {
      return {
        status: "ambiguous",
        candidates: all.filter((task) => resolved.ids.includes(task.id)),
      };
    }
    return { status: "not_found", reason: "找不到属于你的该任务。" };
  }

  const ordinalMatch = ORDINAL.exec(value) ?? TASK_NUMBER.exec(value);
  if (ordinalMatch !== null) {
    const ordinal = parseOrdinal(ordinalMatch[1] as string);
    if (ordinal === undefined || ordinal < 1) {
      return { status: "not_found", reason: "无法理解任务序号。" };
    }
    if (ordinal > all.length) {
      return {
        status: "not_found",
        reason: `当前只有 ${all.length} 个任务，找不到第 ${ordinal} 个。`,
      };
    }
    return { status: "ok", task: all[ordinal - 1] as TaskRecord };
  }

  const prefer = (candidates: TaskRecord[]): TaskReferenceResolution | undefined => {
    if (options.preferredTaskId === undefined) {
      return undefined;
    }
    const focused = candidates.find((task) => task.id === options.preferredTaskId);
    return focused === undefined ? undefined : { status: "ok", task: focused };
  };

  if (DEICTIC.test(value)) {
    const base = scoped.length > 0 ? scoped : all;
    const focused = prefer(base);
    if (focused !== undefined) {
      return focused;
    }
    const candidates = CONTINUE.test(value) || options.activeOnly === true
      ? base.filter(active)
      : base;
    return unique(candidates, "没有找到可以继续处理的任务。");
  }

  const keyword = keywordTaskRef(value);
  if (keyword !== undefined) {
    const scopedMatches = scoped
      .filter((task) => task.goal.includes(keyword))
      .filter((task) => options.activeOnly !== true || active(task));
    if (scopedMatches.length > 0) {
      return unique(scopedMatches, "没有找到匹配该目标的任务。");
    }
    const ownerMatches = all
      .filter((task) => task.goal.includes(keyword))
      .filter((task) => options.activeOnly !== true || active(task));
    return unique(ownerMatches, "没有找到匹配该目标的任务。");
  }

  const base = scoped.length > 0 ? scoped : all;
  const focused = prefer(base);
  if (focused !== undefined) {
    return focused;
  }
  const candidates = base.filter(active);
  return unique(candidates, "当前没有可处理的任务。");
}

export type ItemReferenceResolution<T> =
  | { status: "ok"; item: T }
  | { status: "ambiguous"; items: T[] }
  | { status: "not_found"; reason: string };

function matchesReference(
  ref: string,
  id: string,
  text: string,
): boolean {
  if (ref.length === 0) {
    return true;
  }
  if (id.startsWith(ref) || id.slice(0, 8) === ref) {
    return true;
  }
  return ref.length >= 2 && text.includes(ref);
}

/** Resolve a pending reminder without ever leaving the owner's scope. */
export function resolveReminderReference(
  ownerId: string,
  ref: string | undefined,
  reminders: ScheduleRecord[],
): ItemReferenceResolution<ScheduleRecord> {
  const value = (ref ?? "").trim();
  const pending = reminders.filter(
    (reminder) => reminder.ownerId === ownerId && reminder.status === "pending",
  );
  if (value.length === 0) {
    if (pending.length === 0) {
      return { status: "not_found", reason: "当前没有待发送提醒。" };
    }
    if (pending.length === 1) {
      return { status: "ok", item: pending[0] as ScheduleRecord };
    }
    return { status: "ambiguous", items: pending };
  }
  const ordinalMatch = ORDINAL.exec(value);
  if (ordinalMatch !== null) {
    const ordinal = parseOrdinal(ordinalMatch[1] as string);
    if (ordinal === undefined || ordinal < 1 || ordinal > pending.length) {
      return { status: "not_found", reason: "找不到对应的提醒序号。" };
    }
    return { status: "ok", item: pending[ordinal - 1] as ScheduleRecord };
  }
  const matches = pending.filter((reminder) =>
    matchesReference(value, reminder.id, reminder.text),
  );
  if (matches.length === 1) {
    return { status: "ok", item: matches[0] as ScheduleRecord };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", items: matches };
  }
  return { status: "not_found", reason: "找不到属于你的该提醒。" };
}

export type ScheduleAction = "confirm" | "cancel";

/** Resolve a schedule policy by exact id, unique prefix, goal, or time. */
export function resolveScheduleReference(
  ownerId: string,
  ref: string | undefined,
  policies: SchedulePolicyRecord[],
  action: ScheduleAction,
): ItemReferenceResolution<SchedulePolicyRecord> {
  const value = (ref ?? "").trim();
  const eligible = policies.filter((policy) => {
    if (policy.ownerId !== ownerId) {
      return false;
    }
    return action === "confirm"
      ? policy.status === "draft"
      : policy.status !== "cancelled" && policy.status !== "expired";
  });
  if (value.length === 0) {
    if (eligible.length === 0) {
      return {
        status: "not_found",
        reason: action === "confirm" ? "当前没有待确认的计划草稿。" : "当前没有可取消的周期计划。",
      };
    }
    if (eligible.length === 1) {
      return { status: "ok", item: eligible[0] as SchedulePolicyRecord };
    }
    return { status: "ambiguous", items: eligible };
  }
  const ordinalMatch = ORDINAL.exec(value);
  if (ordinalMatch !== null) {
    const ordinal = parseOrdinal(ordinalMatch[1] as string);
    if (ordinal === undefined || ordinal < 1 || ordinal > eligible.length) {
      return { status: "not_found", reason: "找不到对应的计划序号。" };
    }
    return { status: "ok", item: eligible[ordinal - 1] as SchedulePolicyRecord };
  }
  const matches = eligible.filter(
    (policy) =>
      matchesReference(value, policy.id, policy.goal) ||
      matchesReference(value, policy.id, policy.repo) ||
      matchesReference(value, policy.id, policy.localTime),
  );
  if (matches.length === 1) {
    return { status: "ok", item: matches[0] as SchedulePolicyRecord };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", items: matches };
  }
  return { status: "not_found", reason: "找不到属于你的该计划。" };
}

export function formatReminderCandidates(candidates: readonly ScheduleRecord[]): string {
  return [
    "匹配到多个提醒，请给出提醒编号后再操作：",
    ...candidates.slice(0, AMBIGUOUS_LIST_LIMIT).map(
      (reminder) =>
        `- ${reminder.id.slice(0, 8)} ${reminder.dueAt} ${reminder.text}`,
    ),
  ].join("\n");
}

export function formatScheduleCandidates(
  candidates: readonly SchedulePolicyRecord[],
  action: ScheduleAction,
): string {
  return [
    action === "confirm"
      ? "匹配到多个计划草稿，请给出计划编号后再确认："
      : "匹配到多个周期计划，请给出计划编号后再取消：",
    ...candidates.slice(0, AMBIGUOUS_LIST_LIMIT).map(
      (policy) =>
        `- ${policy.id.slice(0, 8)} [${policy.status}] ${policy.cadence} ${policy.localTime} ${policy.repo} ${policy.goal}`,
    ),
  ].join("\n");
}

export function formatTaskCandidates(candidates: readonly TaskRecord[]): string {
  const shown = candidates.slice(0, AMBIGUOUS_LIST_LIMIT);
  return [
    "匹配到多个任务，请给出任务编号后再操作：",
    ...shown.map((task) => `- ${task.id.slice(0, 8)} ${task.status} ${task.goal}`),
    ...(candidates.length > shown.length
      ? [`- 还有 ${candidates.length - shown.length} 个未显示`]
      : []),
  ].join("\n");
}

export function formatTaskNotFound(reason: string, ref: string | undefined): string {
  return ref === undefined || ref.trim().length === 0
    ? reason
    : `${reason}（指代：${ref.trim()}）`;
}

const SUMMARY_HINT =
  /(?:整体|总体|运行状态|服务状态|当前状态|现在怎么样|状态怎么样|状态如何)/;
const COMBINED_HINT =
  /(?:任务.{0,4}(?:和|与|及).{0,4}提醒|提醒.{0,4}(?:和|与|及).{0,4}任务)/;
const TASK_LIST_HINT =
  /(?:任务(?:列表|清单|有多少|有几个|数量)|(?:有哪些|有什么|列出|查看|所有|全部|最近).{0,12}任务|任务.{0,4}(?:汇总|总结))/;
const TASK_DETAIL_HINT =
  /(?:任务.{0,10}(?:怎么样|如何|进展|情况|状态|执行得|完成)|(?:怎么样|如何|进展|情况|状态).{0,6}任务)/;
const REMINDER_HINT = /(?:提醒(?:列表|清单|有哪些|有什么|多少|几个|吗|呢)|(?:有哪些|有什么|查看|列出).{0,6}提醒)/;
const MEMORY_HINT = /(?:记忆|偏好).{0,8}(?:有哪些|有什么|列表|内容|吗|呢)|(?:有哪些|有什么|查看|列出|记住).{0,20}(?:记忆|偏好)|我记住了什么/;
const SCHEDULE_HINT = /(?:周期计划|定时计划|计划).{0,8}(?:有哪些|有什么|列表|内容|吗|呢)|(?:有哪些|有什么|查看|列出).{0,6}(?:周期计划|定时计划|计划)/;
const MUTATION_HINT =
  /(?:创建|新建|添加|设置|修改|更新|改|结束|停|删除|取消|关闭|打开|清除|移除|重命名|调整|更换|保存|记录|安排|暂停|恢复|批准|拒绝|补充|回答|发送|发给|提交|提醒(?:一下|下)?我|设(?:置|个)提醒|加(?:个)?提醒|做一个|帮我做)/;

const STATUS_HINTS: readonly [RegExp, TaskStatus][] = [
  [/(?:正在运行|运行中|执行中|running)/i, "running"],
  [/(?:排队|待执行|queued)/i, "queued"],
  [/(?:等待输入|等待回答|waiting_user)/i, "waiting_user"],
  [/(?:等待外部|waiting_external)/i, "waiting_external"],
  [/(?:待核对|需要核对|needs_review)/i, "needs_review"],
  [/(?:已完成|完成了|成功|succeeded)/i, "succeeded"],
  [/(?:失败|failed)/i, "failed"],
  [/(?:已取消|cancelled)/i, "cancelled"],
];

function inferStatus(text: string): TaskStatus | undefined {
  return STATUS_HINTS.find(([pattern]) => pattern.test(text))?.[1];
}

function inferProject(text: string): string | undefined {
  const match = /(?:项目|project)\s*[:：=]?\s*([A-Za-z0-9._-]{1,64})/i.exec(text);
  return match?.[1];
}

function inferLimit(text: string): number | undefined {
  const match = /(?:最近|前|显示|列出)\s*(\d{1,2})\s*(?:个|条|项)?/.exec(text);
  if (match === null) {
    return undefined;
  }
  const limit = Number(match[1]);
  return limit >= 1 && limit <= 20 ? limit : undefined;
}

/**
 * Narrow deterministic fallback for explicit read questions. Mutations are
 * deliberately excluded; the model must propose those intents.
 */
export function inferStateQuery(text: string): StateQuery | undefined {
  const value = text.trim();
  if (value.length === 0 || MUTATION_HINT.test(value)) {
    return undefined;
  }
  const project = inferProject(value);
  const status = inferStatus(value);
  const limit = inferLimit(value);

  if (COMBINED_HINT.test(value)) {
    return { target: "summary", ...(project === undefined ? {} : { project }) };
  }
  if (TASK_DETAIL_HINT.test(value) || ORDINAL.test(value) && /任务/.test(value)) {
    const refMatch = ORDINAL.exec(value);
    return {
      target: "task",
      ...(refMatch === null ? { taskRef: value } : { taskRef: refMatch[0].trim() }),
      ...(project === undefined ? {} : { project }),
    };
  }
  if (REMINDER_HINT.test(value)) {
    return { target: "reminders", ...(limit === undefined ? {} : { limit }) };
  }
  if (MEMORY_HINT.test(value)) {
    return {
      target: "memories",
      ...(project === undefined ? {} : { project }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  if (SCHEDULE_HINT.test(value)) {
    return { target: "schedules", ...(limit === undefined ? {} : { limit }) };
  }
  if (TASK_LIST_HINT.test(value)) {
    return {
      target: "tasks",
      ...(project === undefined ? {} : { project }),
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  if (SUMMARY_HINT.test(value)) {
    return { target: "summary", ...(project === undefined ? {} : { project }) };
  }
  return undefined;
}

const CONTROL_MUTATION =
  /(?:取消|停|修改|更新|改|补充|删除|移除|忘记|暂停|恢复|确认|拒绝|设置提醒|加提醒|记住|保存|发送|提交)/;
const CLAUSE_SPLIT = /[，,；;。]|(?:然后|接着|顺便|同时|之后)/;

/**
 * Detect a control mutation combined with a read request in one message.
 * The Router asks the owner to split instead of silently executing half.
 */
export function isCompoundControlRequest(text: string): boolean {
  const clauses = text
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length < 2) {
    return false;
  }
  return (
    clauses.some((clause) => CONTROL_MUTATION.test(clause)) &&
    clauses.some((clause) => inferStateQuery(clause) !== undefined)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function listOf(snapshot: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = snapshot[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined)
    : [];
}

function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberLike(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function formatWhen(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function pageHeader(
  snapshot: Record<string, unknown>,
  noun: string,
): string {
  const total = numberLike(snapshot, "total") ?? 0;
  const returned = numberLike(snapshot, "returned") ?? 0;
  const offset = numberLike(snapshot, "offset") ?? 0;
  if (total === 0) {
    return `没有${noun}。`;
  }
  return `${noun}（共 ${total} 条，本次 ${returned} 条，偏移 ${offset}）`;
}

/**
 * Deterministic rendering of a validated state read. Never model-authored.
 */
export function formatStateQuery(snapshot: StateSnapshot, timezone: string): string {
  if (snapshot.tool === "state.summary") {
    return formatStateSummary(snapshot, timezone);
  }
  const body = snapshot.snapshot;
  const lines: string[] = [];
  switch (snapshot.tool) {
    case "task.list": {
      const tasks = listOf(body, "tasks");
      if (tasks.length === 0) {
        return "没有符合条件的任务。";
      }
      lines.push(pageHeader(body, "任务"));
      for (const task of tasks) {
        const id = stringOf(task, "id")?.slice(0, 8) ?? "?";
        const status = stringOf(task, "status") ?? "?";
        const goal = stringOf(task, "goal") ?? "";
        const project = task.project;
        const revision = numberLike(task, "revision");
        lines.push(
          `- ${id} [${status}]${typeof project === "string" ? ` [项目 ${project}]` : ""}${revision === undefined ? "" : ` v${revision}`} ${goal}`,
        );
      }
      return lines.join("\n");
    }
    case "task.get": {
      const task = asRecord(body.task);
      if (task === undefined) {
        return "找不到该任务。";
      }
      const id = stringOf(task, "id") ?? "?";
      const status = stringOf(task, "status") ?? "?";
      const goal = stringOf(task, "goal") ?? "";
      lines.push(`任务 ${id}（${status}${task.project === null || task.project === undefined ? "" : `，项目 ${String(task.project)}`}）：`);
      lines.push(`目标：${goal}`);
      if (typeof task.revision === "number") {
        lines.push(`版本：${task.revision}`);
      }
      if (typeof task.updatedAt === "string") {
        lines.push(`更新：${formatWhen(task.updatedAt, timezone)}（${timezone}）`);
      }
      if (typeof task.resultRef === "string" && task.resultRef.length > 0) {
        lines.push(`结果：${task.resultRef}`);
      }
      if (typeof task.lastError === "string" && task.lastError.length > 0) {
        lines.push(`错误：${task.lastError}`);
      }
      const verification = asRecord(task.verification);
      if (verification !== undefined) {
        lines.push(
          `验证：${String(verification.verifier ?? "?")} ${String(verification.verdict ?? "?")}（${String(verification.reason ?? "")}）`,
        );
      }
      return lines.join("\n");
    }
    case "reminder.list": {
      const reminders = listOf(body, "reminders");
      if (reminders.length === 0) {
        return "当前没有待发送提醒。";
      }
      lines.push(pageHeader(body, "提醒"));
      for (const reminder of reminders) {
        const dueAt = stringOf(reminder, "dueAt") ?? "";
        const tz = stringOf(reminder, "timezone") ?? timezone;
        const text = stringOf(reminder, "text") ?? "";
        lines.push(`- ${formatWhen(dueAt, tz)}（${tz}）${text}`);
      }
      return lines.join("\n");
    }
    case "memory.list": {
      const memories = listOf(body, "memories");
      if (memories.length === 0) {
        return "没有符合条件的记忆。";
      }
      lines.push(pageHeader(body, "记忆"));
      for (const memory of memories) {
        const project = memory.project;
        lines.push(
          `- ${typeof project === "string" ? `[项目 ${project}] ` : ""}${String(memory.key ?? "?")} = ${String(memory.value ?? "")}（v${String(memory.version ?? "?")}）`,
        );
      }
      return lines.join("\n");
    }
    case "schedule.list": {
      const schedules = listOf(body, "schedules");
      if (schedules.length === 0) {
        return "当前没有周期计划。";
      }
      lines.push(pageHeader(body, "周期计划"));
      for (const policy of schedules) {
        const id = stringOf(policy, "id")?.slice(0, 8) ?? "?";
        const cadence = stringOf(policy, "cadence") === "weekdays" ? "工作日" : "每天";
        const localTime = stringOf(policy, "localTime") ?? "?";
        const tz = stringOf(policy, "timezone") ?? timezone;
        const status = stringOf(policy, "status") ?? "?";
        const repo = stringOf(policy, "repo") ?? "?";
        const goal = stringOf(policy, "goal") ?? "";
        const next = stringOf(policy, "nextRunAt");
        const expires = stringOf(policy, "expiresAt") ?? "";
        lines.push(
          `- ${id} [${status}] ${cadence} ${localTime} ${tz} ${repo}：${goal}；截止 ${expires}${next === undefined ? "" : `；下次 ${next}`}`,
        );
      }
      return lines.join("\n");
    }
  }
  return "内部状态快照不可用。";
}
