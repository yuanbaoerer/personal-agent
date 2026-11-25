import type {
  ScheduleCadence,
  ScheduleKind,
  SchedulePolicyRecord,
  TaskRecord,
} from "../domain/types.ts";
import type { CapabilityView } from "../plugins/fence.ts";
import type { SchedulePolicyRepository } from "../storage/schedule-policies.ts";
import type { Store } from "../storage/store.ts";
import { assertTimezone } from "./reminders.ts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface SchedulePolicyDeps {
  store: Store;
  policies: SchedulePolicyRepository;
  tasks: { create(input: {
    ownerId: string;
    conversationId: string;
    sourceKey: string;
    goal: string;
    completionCriteria: string;
    mandate: { resources: string[]; tools: string[]; notes?: string };
    schedulePolicyId?: string;
  }): TaskRecord };
  allowedRepos: readonly string[];
  defaultTimezone?: string;
  now?: () => Date;
  /** Missed occurrences older than this are skipped, not replayed. */
  maxLatenessMs?: number;
  defaultExpiryMs?: number;
  /** Hard cap on dispatched schedule runs per UTC day. */
  maxRunsPerDay?: number;
  /** Live catalog; a schedule must not fire a disabled capability. */
  capabilities?: CapabilityView;
  /**
   * False when the host has no daily model budget. Unattended runs must fail
   * closed instead of spending an unknown amount.
   */
  unattendedBudgetKnown?: boolean;
}

export interface ScheduleDraftInput {
  kind?: ScheduleKind;
  repo?: string;
  localTime: string;
  cadence: ScheduleCadence;
  /** 0 = Sunday … 6 = Saturday; required when cadence is weekly. */
  weekday?: number;
  goal: string;
  timezone?: string;
  /** Local calendar date (YYYY-MM-DD) for the last day the plan may fire. */
  until?: string;
}

export interface ScheduleEditInput extends ScheduleDraftInput {}

export type ScheduleResult =
  | { ok: true; policy: SchedulePolicyRecord }
  | { ok: false; reason: string };

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

/**
 * Resolve a local wall-clock time to a UTC instant. Returns undefined for a
 * spring-forward gap (for example 02:30 in America/New_York); callers skip
 * that day rather than firing at a surprising time.
 */
function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | undefined {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(new Date(guess), timezone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const delta = target - represented;
    if (delta === 0) {
      break;
    }
    guess += delta;
  }
  const verified = localParts(new Date(guess), timezone);
  if (
    verified.year !== year ||
    verified.month !== month ||
    verified.day !== day ||
    verified.hour !== hour ||
    verified.minute !== minute
  ) {
    return undefined;
  }
  return new Date(guess);
}

function addLocalDays(year: number, month: number, day: number, offset: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function parseLocalTime(value: string): { hour: number; minute: number } | undefined {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Next occurrence strictly after `afterIso`, in the policy's wall clock.
 * Weekday plans skip Saturday/Sunday in that timezone. Missing local times
 * (DST spring-forward) are skipped. Ambiguous fall-back times resolve to the
 * first matching instant.
 */
export function nextScheduledAt(
  afterIso: string,
  timezone: string,
  cadence: ScheduleCadence,
  localTime: string,
  weekday?: number,
): string | undefined {
  const after = new Date(afterIso);
  if (Number.isNaN(after.getTime())) {
    return undefined;
  }
  if (
    cadence === "weekly" &&
    (weekday === undefined ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6)
  ) {
    return undefined;
  }
  const time = parseLocalTime(localTime);
  if (time === undefined) {
    return undefined;
  }
  const start = localParts(after, timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = addLocalDays(start.year, start.month, start.day, offset);
    if (cadence === "weekdays" && (day.weekday === 0 || day.weekday === 6)) {
      continue;
    }
    if (cadence === "weekly" && day.weekday !== weekday) {
      continue;
    }
    const candidate = localToUtc(
      day.year,
      day.month,
      day.day,
      time.hour,
      time.minute,
      timezone,
    );
    if (candidate !== undefined && candidate.getTime() > after.getTime()) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

/** 23:59:59.999 on a local calendar date, used for the inclusive end date. */
export function endOfLocalDay(date: string, timezone: string): string | undefined {
  if (!UNTIL_PATTERN.test(date)) {
    return undefined;
  }
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const candidate = localToUtc(year, month, day, 23, 59, timezone);
  return candidate === undefined
    ? undefined
    : new Date(candidate.getTime() + 59_999).toISOString();
}

export class SchedulePolicyService {
  readonly #store: Store;
  readonly #policies: SchedulePolicyRepository;
  readonly #tasks: SchedulePolicyDeps["tasks"];
  readonly #allowedRepos: Set<string>;
  readonly #defaultTimezone: string;
  readonly #now: () => Date;
  readonly #maxLatenessMs: number;
  readonly #defaultExpiryMs: number;
  readonly #maxRunsPerDay: number;
  readonly #capabilities?: CapabilityView;
  readonly #unattendedBudgetKnown: boolean;

  constructor(deps: SchedulePolicyDeps) {
    this.#store = deps.store;
    this.#policies = deps.policies;
    this.#tasks = deps.tasks;
    this.#allowedRepos = new Set(deps.allowedRepos.map((repo) => repo.toLowerCase()));
    this.#defaultTimezone = deps.defaultTimezone ?? "Asia/Shanghai";
    this.#now = deps.now ?? (() => new Date());
    this.#maxLatenessMs = deps.maxLatenessMs ?? 60 * 60_000;
    this.#defaultExpiryMs = deps.defaultExpiryMs ?? 30 * 24 * 60 * 60_000;
    this.#maxRunsPerDay = Math.max(1, deps.maxRunsPerDay ?? 20);
    this.#capabilities = deps.capabilities;
    this.#unattendedBudgetKnown = deps.unattendedBudgetKnown ?? true;
  }

  createDraft(
    ownerId: string,
    conversationId: string,
    input: ScheduleDraftInput,
  ): ScheduleResult {
    const validated = this.#validate(input);
    if (!validated.ok) {
      return validated;
    }
    const now = this.#now();
    const policy = this.#policies.insertDraft({
      ownerId,
      conversationId,
      ...validated.value,
      createdAt: now.toISOString(),
    });
    this.#audit("schedule_policy.drafted", policy, now, {
      kind: policy.kind,
      repo: policy.repo,
      localTime: policy.localTime,
      cadence: policy.cadence,
      weekday: policy.weekday,
      timezone: policy.timezone,
      expiresAt: policy.expiresAt,
      version: policy.version,
    });
    return { ok: true, policy };
  }

  confirm(ownerId: string, idOrPrefix: string): ScheduleResult {
    const policy = this.resolve(ownerId, idOrPrefix);
    if (policy === undefined) {
      return { ok: false, reason: "找不到属于你的计划。" };
    }
    if (policy.status !== "draft") {
      return { ok: false, reason: `计划当前状态为 ${policy.status}，只有草稿可以确认。` };
    }
    const now = this.#now();
    if (policy.kind === "github" && !this.#repoStillAllowed(policy.repo)) {
      return { ok: false, reason: "仓库已不在 GITHUB_ALLOWED_REPOS 白名单内。" };
    }
    if (policy.expiresAt <= now.toISOString()) {
      this.#policies.markExpired(policy.id, now.toISOString());
      return { ok: false, reason: "计划已过期。" };
    }
    const next = nextScheduledAt(
      now.toISOString(),
      policy.timezone,
      policy.cadence,
      policy.localTime,
      policy.weekday,
    );
    if (next === undefined) {
      return { ok: false, reason: "无法计算下次触发时间。" };
    }
    if (next > policy.expiresAt) {
      this.#policies.markExpired(policy.id, now.toISOString());
      return { ok: false, reason: "截止时间之前没有可触发的时间。" };
    }
    const activated = this.#policies.activate(
      policy.id,
      ownerId,
      policy.version,
      next,
      now.toISOString(),
    );
    if (activated === undefined) {
      return { ok: false, reason: "计划状态已变化，请重新查看。" };
    }
    this.#audit("schedule_policy.confirmed", activated, now, {
      nextRunAt: activated.nextRunAt,
      version: activated.version,
    });
    return { ok: true, policy: activated };
  }

  edit(ownerId: string, idOrPrefix: string, input: ScheduleEditInput): ScheduleResult {
    const policy = this.resolve(ownerId, idOrPrefix);
    if (policy === undefined) {
      return { ok: false, reason: "找不到属于你的计划。" };
    }
    const validated = this.#validate(input, policy.timezone, policy.kind);
    if (!validated.ok) {
      return validated;
    }
    const now = this.#now();
    const updated = this.#policies.updateToDraft(
      policy.id,
      ownerId,
      validated.value,
      now.toISOString(),
    );
    if (updated === undefined) {
      return { ok: false, reason: "计划当前状态不允许修改。" };
    }
    this.#audit("schedule_policy.edited", updated, now, {
      fromVersion: policy.version,
      version: updated.version,
      status: updated.status,
      kind: updated.kind,
      repo: updated.repo,
      localTime: updated.localTime,
      cadence: updated.cadence,
      weekday: updated.weekday,
      expiresAt: updated.expiresAt,
    });
    return { ok: true, policy: updated };
  }

  pause(ownerId: string, idOrPrefix: string): ScheduleResult {
    const policy = this.resolve(ownerId, idOrPrefix);
    if (policy === undefined) {
      return { ok: false, reason: "找不到属于你的计划。" };
    }
    const now = this.#now();
    if (!this.#policies.pause(policy.id, ownerId, now.toISOString())) {
      return { ok: false, reason: `计划当前状态为 ${policy.status}，无法暂停。` };
    }
    const paused = this.#policies.get(policy.id) as SchedulePolicyRecord;
    this.#audit("schedule_policy.paused", paused, now, {});
    return { ok: true, policy: paused };
  }

  resume(ownerId: string, idOrPrefix: string): ScheduleResult {
    const policy = this.resolve(ownerId, idOrPrefix);
    if (policy === undefined) {
      return { ok: false, reason: "找不到属于你的计划。" };
    }
    const now = this.#now();
    if (policy.status !== "paused") {
      return { ok: false, reason: `计划当前状态为 ${policy.status}，无法恢复。` };
    }
    if (
      policy.expiresAt <= now.toISOString() ||
      (policy.kind === "github" && !this.#repoStillAllowed(policy.repo))
    ) {
      this.#policies.markExpired(policy.id, now.toISOString());
      return { ok: false, reason: "计划已过期或授权范围已失效。" };
    }
    const next = nextScheduledAt(
      now.toISOString(),
      policy.timezone,
      policy.cadence,
      policy.localTime,
      policy.weekday,
    );
    if (next === undefined || next > policy.expiresAt) {
      this.#policies.markExpired(policy.id, now.toISOString());
      return { ok: false, reason: "截止时间之前没有可触发的时间。" };
    }
    const resumed = this.#policies.resume(policy.id, ownerId, next, now.toISOString());
    if (resumed === undefined) {
      return { ok: false, reason: "计划状态已变化，请重新查看。" };
    }
    this.#audit("schedule_policy.resumed", resumed, now, { nextRunAt: next });
    return { ok: true, policy: resumed };
  }

  cancel(ownerId: string, idOrPrefix: string): ScheduleResult {
    const policy = this.resolve(ownerId, idOrPrefix);
    if (policy === undefined) {
      return { ok: false, reason: "找不到属于你的计划。" };
    }
    const now = this.#now();
    if (!this.#policies.cancel(policy.id, ownerId, now.toISOString())) {
      return { ok: false, reason: `计划当前状态为 ${policy.status}，无法取消。` };
    }
    const cancelled = this.#policies.get(policy.id) as SchedulePolicyRecord;
    this.#audit("schedule_policy.cancelled", cancelled, now, {});
    return { ok: true, policy: cancelled };
  }

  list(ownerId: string): SchedulePolicyRecord[] {
    return this.#policies.listByOwner(ownerId);
  }

  resolve(ownerId: string, idOrPrefix: string): SchedulePolicyRecord | undefined {
    const value = idOrPrefix.trim();
    if (value.length === 0) {
      return undefined;
    }
    const exact = this.#policies.get(value);
    if (exact !== undefined && exact.ownerId === ownerId) {
      return exact;
    }
    const matches = this.#policies
      .listByOwner(ownerId)
      .filter((policy) => policy.id.startsWith(value));
    return matches.length === 1 ? matches[0] : undefined;
  }

  nextDueAt(): string | undefined {
    return this.#policies.nextDueAt();
  }

  /**
   * A confirmed active plan authorizes only its owner, version and unexpired
   * scope. A policy that expired because the final occurrence was dispatched
   * still authorizes that occurrence's task until the expiry timestamp, so
   * the final report is not lost. Internal plans have no repo; GitHub plans
   * also require the current allowlist.
   */
  runAuthorization(
    policyId: string,
    ownerId: string,
    version?: number,
    taskId?: string,
  ): SchedulePolicyRecord | undefined {
    const policy = this.#policies.get(policyId);
    const now = this.#now().toISOString();
    if (
      policy === undefined ||
      policy.ownerId !== ownerId ||
      (version !== undefined && policy.version !== version)
    ) {
      return undefined;
    }
    if (policy.status === "expired") {
      if (policy.expiresAt <= now || taskId === undefined) {
        return undefined;
      }
      const finalRun = this.#policies
        .listRuns(policy.id)
        .some((run) => run.taskId === taskId && run.status === "dispatched");
      if (!finalRun) {
        return undefined;
      }
    } else if (policy.status !== "active" || policy.expiresAt <= now) {
      return undefined;
    }
    if (policy.kind === "github" && !this.#repoStillAllowed(policy.repo)) {
      return undefined;
    }
    return policy;
  }

  /**
   * A confirmed active plan authorizes only its exact repo, owner and version.
   * Called by ActionService before auto-approval and again before execution.
   */
  readAuthorization(
    policyId: string,
    ownerId: string,
    repo: string,
    version?: number,
    taskId?: string,
  ): SchedulePolicyRecord | undefined {
    const policy = this.runAuthorization(policyId, ownerId, version, taskId);
    if (
      policy === undefined ||
      policy.kind !== "github" ||
      policy.repo !== repo.trim().toLowerCase()
    ) {
      return undefined;
    }
    return policy;
  }

  fireDue(): number {
    const now = this.#now();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    let used = this.#policies.countDispatchedSince(dayStart);
    let created = 0;
    for (const due of this.#policies.listDue(now.toISOString())) {
      if (!this.#unattendedBudgetKnown) {
        const scheduledAt = due.nextRunAt;
        if (scheduledAt !== undefined) {
          this.#policies.recordRun(
            due.id,
            scheduledAt,
            "skipped",
            undefined,
            now.toISOString(),
          );
          this.#advanceAfterRun(due, scheduledAt, now, undefined, now.toISOString());
        }
        this.#audit("schedule_policy.skipped", due, now, {
          reason: "budget_unknown",
        });
        continue;
      }
      try {
        if (used >= this.#maxRunsPerDay) {
          const scheduledAt = due.nextRunAt;
          if (scheduledAt !== undefined) {
            this.#policies.recordRun(
              due.id,
              scheduledAt,
              "skipped",
              undefined,
              now.toISOString(),
            );
            this.#advanceAfterRun(due, scheduledAt, now, undefined, now.toISOString());
          }
          this.#audit("schedule_policy.skipped", due, now, {
            reason: "daily_run_budget",
            maxRunsPerDay: this.#maxRunsPerDay,
          });
          continue;
        }
        const fired = this.#fireOne(due, now);
        created += fired;
        used += fired;
      } catch (error) {
        this.#audit("schedule_policy.fire_failed", due, now, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return created;
  }

  #fireOne(due: SchedulePolicyRecord, now: Date): number {
    const policy = this.#policies.get(due.id);
    if (policy === undefined || policy.status !== "active" || policy.nextRunAt === undefined) {
      return 0;
    }
    const scheduledAt = policy.nextRunAt;
    const nowIso = now.toISOString();
    if (policy.kind === "github" && !this.#repoStillAllowed(policy.repo)) {
      this.#policies.markExpired(policy.id, nowIso);
      this.#audit("schedule_policy.expired", policy, now, {
        scheduledAt,
        reason: "repo_no_longer_allowed",
      });
      return 0;
    }
    if (policy.expiresAt < nowIso || scheduledAt > policy.expiresAt) {
      this.#policies.markExpired(policy.id, nowIso);
      this.#audit("schedule_policy.expired", policy, now, { scheduledAt });
      return 0;
    }

    if (now.getTime() - new Date(scheduledAt).getTime() > this.#maxLatenessMs) {
      this.#policies.recordRun(policy.id, scheduledAt, "skipped", undefined, nowIso);
      // Jump over every occurrence that was missed during downtime instead of
      // replaying one stale task per maintenance tick.
      this.#advanceAfterRun(policy, scheduledAt, now, undefined, nowIso);
      this.#audit("schedule_policy.skipped", policy, now, {
        scheduledAt,
        reason: "missed_by_more_than_grace",
      });
      return 0;
    }

    const requiredTool = policy.kind === "github" ? "github.read" : "state.summary";
    if (
      this.#capabilities !== undefined &&
      this.#capabilities.toolInfo(requiredTool) === undefined
    ) {
      this.#policies.recordRun(policy.id, scheduledAt, "skipped", undefined, nowIso);
      this.#advanceAfterRun(policy, scheduledAt, now, undefined, nowIso);
      this.#audit("schedule_policy.skipped", policy, now, {
        scheduledAt,
        reason: "capability_unavailable",
      });
      return 0;
    }

    const claimed = this.#policies.recordRun(
      policy.id,
      scheduledAt,
      "dispatched",
      undefined,
      nowIso,
    );
    if (!claimed.inserted) {
      if (claimed.run.taskId !== undefined || claimed.run.status === "skipped") {
        this.#advanceAfterRun(policy, scheduledAt, now, undefined);
        return 0;
      }
      // A crash can land after the run claim but before the task insert.
    }

    const task = this.#tasks.create({
      ownerId: policy.ownerId,
      conversationId: policy.conversationId,
      sourceKey: this.#runKey(policy.id, scheduledAt),
      goal: this.#taskGoal(policy),
      completionCriteria: JSON.stringify(
        policy.kind === "github"
          ? {
              verifier: "github-read",
              repo: policy.repo,
              requiredEvidenceKinds: ["github"],
            }
          : {
              verifier: "state-read",
              requiredEvidenceKinds: ["state_snapshot"],
              requireStructuredClaims: true,
            },
      ),
      mandate:
        policy.kind === "github"
          ? {
              resources: ["chat", "github"],
              tools: ["github.read"],
              notes: `由已确认的周期计划 ${policy.id}（版本 ${policy.version}）授权只读访问 ${policy.repo}`,
            }
          : {
              resources: ["chat", "state"],
              tools: ["state.summary"],
              notes: `由已确认的周期计划 ${policy.id}（版本 ${policy.version}）授权读取 owner 内部状态`,
            },
      schedulePolicyId: policy.id,
    });
    this.#policies.attachTask(policy.id, scheduledAt, task.id);

    this.#advanceAfterRun(policy, scheduledAt, now, task.id);
    this.#audit("schedule_policy.fired", policy, now, {
      scheduledAt,
      taskId: task.id,
      nextRunAt: this.#policies.get(policy.id)?.nextRunAt,
    });
    return 1;
  }

  #advanceAfterRun(
    policy: SchedulePolicyRecord,
    scheduledAt: string,
    now: Date,
    taskId: string | undefined,
    nextBase = scheduledAt,
  ): void {
    const next = nextScheduledAt(
      nextBase,
      policy.timezone,
      policy.cadence,
      policy.localTime,
      policy.weekday,
    );
    const nextRunAt = next !== undefined && next <= policy.expiresAt ? next : undefined;
    const advanced = this.#policies.advance(
      policy.id,
      scheduledAt,
      nextRunAt,
      now.toISOString(),
    );
    if (advanced && nextRunAt === undefined) {
      this.#policies.markExpired(policy.id, now.toISOString());
      this.#audit("schedule_policy.expired", policy, now, {
        scheduledAt,
        taskId,
        reason: "no_next_run_before_expiry",
      });
    }
  }

  #runKey(policyId: string, scheduledAt: string): string {
    return `schedule:${policyId}:${scheduledAt}`;
  }

  #taskGoal(policy: SchedulePolicyRecord): string {
    if (policy.kind === "internal") {
      return [
        `内部状态日报：${policy.goal}`,
        "只使用 state.summary 读取当前 owner 的任务与提醒状态；不要提出写操作。",
        `列出关键计数、待处理任务和即将到期提醒，并引用 state_snapshot 的 snapshotHash。计划 ${policy.id}，版本 ${policy.version}。`,
      ].join("\n");
    }
    return [
      `周期检查 ${policy.repo}：${policy.goal}`,
      `只使用 github.read 读取 ${policy.repo}；不要提出写操作。`,
      `列出关键事实、待处理 Issue/PR 及来源 URL。计划 ${policy.id}，版本 ${policy.version}。`,
    ].join("\n");
  }

  #validate(
    input: ScheduleDraftInput,
    fallbackTimezone?: string,
    fallbackKind: ScheduleKind = "github",
  ):
    | {
        ok: true;
        value: {
          kind: ScheduleKind;
          timezone: string;
          cadence: ScheduleCadence;
          weekday?: number;
          localTime: string;
          repo: string;
          goal: string;
          expiresAt: string;
        };
      }
    | { ok: false; reason: string } {
    const timezone = (input.timezone ?? fallbackTimezone ?? this.#defaultTimezone).trim();
    try {
      assertTimezone(timezone);
    } catch {
      return { ok: false, reason: "时区无效，请使用 IANA 名称，例如 Asia/Shanghai。" };
    }
    const kind: ScheduleKind = input.kind ?? fallbackKind;
    if (kind !== "github" && kind !== "internal") {
      return { ok: false, reason: "计划类型应为 github 或 internal。" };
    }
    if (
      input.cadence !== "daily" &&
      input.cadence !== "weekdays" &&
      input.cadence !== "weekly"
    ) {
      return { ok: false, reason: "频率应为 daily、weekdays 或 weekly。" };
    }
    if (parseLocalTime(input.localTime) === undefined) {
      return { ok: false, reason: "时间应为 HH:MM（24 小时制）。" };
    }
    let weekday: number | undefined;
    if (input.cadence === "weekly") {
      if (
        input.weekday === undefined ||
        !Number.isInteger(input.weekday) ||
        input.weekday < 0 ||
        input.weekday > 6
      ) {
        return { ok: false, reason: "weekly 计划需要 weekday（0=周日 … 6=周六）。" };
      }
      weekday = input.weekday;
    } else if (input.weekday !== undefined) {
      return { ok: false, reason: "只有 weekly 计划需要 weekday。" };
    }
    let repo = "";
    if (kind === "github") {
      repo = (input.repo ?? "").trim().toLowerCase();
      if (
        !REPO_PATTERN.test(repo) ||
        repo.split("/").some((part) => part === "." || part === "..")
      ) {
        return { ok: false, reason: "仓库格式应为 owner/name。" };
      }
      if (!this.#repoStillAllowed(repo)) {
        return { ok: false, reason: "仓库不在 GITHUB_ALLOWED_REPOS 白名单内。" };
      }
    } else if ((input.repo ?? "").trim().length > 0) {
      return { ok: false, reason: "内部状态计划不接受仓库参数。" };
    }
    const goal = input.goal.trim();
    if (goal.length === 0 || goal.length > 2_000) {
      return { ok: false, reason: "计划内容不能为空且不能超过 2000 字符。" };
    }
    const now = this.#now();
    let expiresAt: string;
    if (input.until === undefined) {
      expiresAt = new Date(now.getTime() + this.#defaultExpiryMs).toISOString();
    } else {
      const end = endOfLocalDay(input.until, timezone);
      if (end === undefined) {
        return { ok: false, reason: "截止日期应为 YYYY-MM-DD。" };
      }
      expiresAt = end;
    }
    if (expiresAt <= now.toISOString()) {
      return { ok: false, reason: "截止时间必须晚于当前时间。" };
    }
    return {
      ok: true,
      value: {
        kind,
        timezone,
        cadence: input.cadence,
        ...(weekday === undefined ? {} : { weekday }),
        localTime: input.localTime,
        repo,
        goal,
        expiresAt,
      },
    };
  }

  #repoStillAllowed(repo: string): boolean {
    return this.#allowedRepos.has(repo.trim().toLowerCase());
  }

  #audit(
    event: string,
    policy: SchedulePolicyRecord,
    now: Date,
    after: Record<string, unknown>,
  ): void {
    this.#store.recordAudit({
      event,
      subjectType: "schedule_policy",
      subjectId: policy.id,
      after: { ...after },
      traceId: `schedule-policy:${policy.id}`,
      occurredAt: now.toISOString(),
    });
  }
}
