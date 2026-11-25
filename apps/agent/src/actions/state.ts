import { createHash } from "node:crypto";

import type {
  MemoryRecord,
  SchedulePolicyRecord,
  ScheduleRecord,
  TaskRecord,
  TaskStatus,
} from "../domain/types.ts";
import type { SchedulePolicyRepository } from "../storage/schedule-policies.ts";
import type { MemoryRepository, ScheduleRepository } from "../storage/personal.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import {
  ToolRejectedError,
  hashArgs,
  stableStringify,
  type ActionTool,
  type ToolExecutionContext,
  type ToolExecution,
  type ToolVerification,
} from "./tooling.ts";

export const STATE_RESOURCE = "state";

export const STATE_TOOL_NAMES = [
  "state.summary",
  "task.list",
  "task.get",
  "reminder.list",
  "memory.list",
  "schedule.list",
] as const;

export type StateToolName = (typeof STATE_TOOL_NAMES)[number];

export function isStateToolName(name: string): name is StateToolName {
  return (STATE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Reminders and schedule policies have no project column. Their snapshots are
 * intentionally owner-level even when the calling task is project-scoped.
 */
export function isOwnerLevelStateTool(name: string): boolean {
  return name === "reminder.list" || name === "schedule.list";
}

/** Paginated list tools; receipts must cover the first page. */
export function isListStateTool(name: string): boolean {
  return (
    name === "task.list" ||
    name === "reminder.list" ||
    name === "memory.list" ||
    name === "schedule.list"
  );
}

/** Hard caps: one receipt must fit comfortably in one model turn. */
export const STATE_MAX_ITEMS = 20;
export const STATE_DEFAULT_ITEMS = 5;
export const STATE_MAX_OFFSET = 10_000;
export const STATE_MAX_SNAPSHOT_BYTES = 8_000;
const TEXT_LIMIT = 200;
const MEMORY_VALUE_LIMIT = 300;
const RESULT_LIMIT = 500;
const PROJECT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface StateReadScope {
  ownerId: string;
  /** Task mandate project; absent means owner-level/global scope. */
  project?: string;
}

export interface StateSnapshot {
  tool: StateToolName;
  ownerId: string;
  project?: string;
  args: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  snapshotAt: string;
  byteLength: number;
}

export interface StateReadServiceDeps {
  tasks: TaskRepository;
  schedules: ScheduleRepository;
  memories: MemoryRepository;
  schedulePolicies: SchedulePolicyRepository;
  now?: () => Date;
}

interface ListArgs {
  limit: number;
  offset: number;
}

interface TaskListArgs extends ListArgs {
  status?: TaskStatus;
}

export const TASK_STATUSES: readonly TaskStatus[] = [
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

interface TaskBrief {
  id: string;
  status: TaskStatus;
  goal: string;
  revision: number;
  project: string | null;
  createdAt: string;
  updatedAt: string;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function readInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolRejectedError(`${name} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw new ToolRejectedError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function readListArgs(raw: Record<string, unknown>): ListArgs {
  return {
    limit: readInteger(raw.limit, "limit", 1, STATE_MAX_ITEMS, STATE_DEFAULT_ITEMS),
    offset: readInteger(raw.offset, "offset", 0, STATE_MAX_OFFSET, 0),
  };
}

function readStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !(TASK_STATUSES as readonly string[]).includes(value)
  ) {
    throw new ToolRejectedError("status is not a supported task status");
  }
  return value as TaskStatus;
}

function taskProject(task: TaskRecord): string | undefined {
  return task.mandate.project;
}

export class StateReadService {
  readonly #tasks: TaskRepository;
  readonly #schedules: ScheduleRepository;
  readonly #memories: MemoryRepository;
  readonly #schedulePolicies: SchedulePolicyRepository;
  readonly #now: () => Date;

  constructor(deps: StateReadServiceDeps) {
    this.#tasks = deps.tasks;
    this.#schedules = deps.schedules;
    this.#memories = deps.memories;
    this.#schedulePolicies = deps.schedulePolicies;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Owner-level summary used by deterministic status answers. */
  summary(ownerId: string, project?: string, at?: string): StateSnapshot {
    return this.read("state.summary", { ownerId, project }, {}, at);
  }

  canonicalize(
    tool: StateToolName,
    raw: Record<string, unknown>,
    _scope: StateReadScope,
  ): Record<string, unknown> {
    switch (tool) {
      case "state.summary":
        return {};
      case "task.list": {
        const { limit, offset } = readListArgs(raw);
        const status = readStatus(raw.status);
        return status === undefined
          ? { limit, offset }
          : { limit, offset, status };
      }
      case "reminder.list":
      case "memory.list":
      case "schedule.list": {
        const { limit, offset } = readListArgs(raw);
        return { limit, offset };
      }
      case "task.get": {
        const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
        if (taskId.length === 0 || taskId.length > 64) {
          throw new ToolRejectedError("taskId must be 1-64 characters");
        }
        return { taskId };
      }
    }
  }

  read(
    tool: StateToolName,
    scope: StateReadScope,
    rawArgs: Record<string, unknown>,
    at?: string,
  ): StateSnapshot {
    if (scope.ownerId.trim().length === 0) {
      throw new ToolRejectedError("state reads require an owner scope");
    }
    if (scope.project !== undefined && !PROJECT_PATTERN.test(scope.project)) {
      throw new ToolRejectedError("invalid project scope");
    }
    const args = this.canonicalize(tool, rawArgs, scope);
    const snapshotAt = at ?? this.#now().toISOString();
    let snapshot: Record<string, unknown>;
    switch (tool) {
      case "state.summary":
        snapshot = this.#summary(tool, scope, snapshotAt);
        break;
      case "task.list":
        snapshot = this.#taskList(tool, scope, args as unknown as TaskListArgs);
        break;
      case "task.get":
        snapshot = this.#taskGet(tool, scope, args.taskId as string);
        break;
      case "reminder.list":
        snapshot = this.#reminderList(tool, scope, args as unknown as ListArgs);
        break;
      case "memory.list":
        snapshot = this.#memoryList(tool, scope, args as unknown as ListArgs);
        break;
      case "schedule.list":
        snapshot = this.#scheduleList(tool, scope, args as unknown as ListArgs);
        break;
    }
    const json = JSON.stringify(snapshot);
    let byteLength = new TextEncoder().encode(json).length;
    if (byteLength > STATE_MAX_SNAPSHOT_BYTES) {
      snapshot = trimSnapshot(snapshot, STATE_MAX_SNAPSHOT_BYTES);
      byteLength = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    }
    if (byteLength > STATE_MAX_SNAPSHOT_BYTES) {
      throw new ToolRejectedError(
        `state snapshot exceeds ${STATE_MAX_SNAPSHOT_BYTES} bytes`,
      );
    }
    return {
      tool,
      ownerId: scope.ownerId,
      project: scope.project,
      args,
      snapshot,
      snapshotHash: hashSnapshot(snapshot),
      snapshotAt,
      byteLength,
    };
  }

  execute(
    tool: StateToolName,
    scope: StateReadScope,
    rawArgs: Record<string, unknown>,
  ): ToolExecution {
    const result = this.read(tool, scope, rawArgs);
    return {
      evidence: snapshotEvidence(result),
      externalRef: `state:${tool}:${result.snapshotHash.slice(0, 16)}`,
    };
  }

  /**
   * Re-check that the records named by a persisted snapshot exist for the
   * same owner. Mutable status fields may have moved on; immutable identity
   * fields must still match, so fabricated ids cannot pass as a receipt.
   */
  auditSnapshot(tool: StateToolName, snapshot: Record<string, unknown>): string[] {
    const missing: string[] = [];
    const scope = readScope(snapshot);
    if (scope === undefined) {
      return ["snapshot_scope_missing"];
    }
    switch (tool) {
      case "state.summary": {
        for (const item of listOf(snapshot.tasks, "recent")) {
          const id = stringOf(item, "id");
          const createdAt = stringOf(item, "createdAt");
          if (id === undefined || createdAt === undefined) {
            missing.push("snapshot_task_identity_missing");
            continue;
          }
          const task = this.#tasks.get(id);
          if (
            task === undefined ||
            task.ownerId !== scope.ownerId ||
            task.createdAt !== createdAt
          ) {
            missing.push(`snapshot_task_missing:${id}`);
          }
        }
        for (const item of listOf(snapshot.reminders, "next")) {
          const id = stringOf(item, "id");
          const createdAt = stringOf(item, "createdAt");
          if (id === undefined || createdAt === undefined) {
            missing.push("snapshot_reminder_identity_missing");
            continue;
          }
          const schedule = this.#schedules.get(id);
          if (
            schedule === undefined ||
            schedule.ownerId !== scope.ownerId ||
            schedule.createdAt !== createdAt
          ) {
            missing.push(`snapshot_reminder_missing:${id}`);
          }
        }
        break;
      }
      case "task.list": {
        for (const item of listOf(snapshot, "tasks")) {
          const id = stringOf(item, "id");
          const createdAt = stringOf(item, "createdAt");
          if (id === undefined || createdAt === undefined) {
            missing.push("snapshot_task_identity_missing");
            continue;
          }
          const task = this.#tasks.get(id);
          if (
            task === undefined ||
            task.ownerId !== scope.ownerId ||
            task.createdAt !== createdAt
          ) {
            missing.push(`snapshot_task_missing:${id}`);
          }
        }
        break;
      }
      case "task.get": {
        const item = recordOf(snapshot, "task");
        const id = item === undefined ? undefined : stringOf(item, "id");
        const createdAt = item === undefined ? undefined : stringOf(item, "createdAt");
        if (id === undefined || createdAt === undefined) {
          missing.push("snapshot_task_identity_missing");
          break;
        }
        const task = this.#tasks.get(id);
        if (
          task === undefined ||
          task.ownerId !== scope.ownerId ||
          task.createdAt !== createdAt
        ) {
          missing.push(`snapshot_task_missing:${id}`);
        }
        break;
      }
      case "reminder.list": {
        for (const item of listOf(snapshot, "reminders")) {
          const id = stringOf(item, "id");
          const createdAt = stringOf(item, "createdAt");
          if (id === undefined || createdAt === undefined) {
            missing.push("snapshot_reminder_identity_missing");
            continue;
          }
          const schedule = this.#schedules.get(id);
          if (
            schedule === undefined ||
            schedule.ownerId !== scope.ownerId ||
            schedule.createdAt !== createdAt
          ) {
            missing.push(`snapshot_reminder_missing:${id}`);
          }
        }
        break;
      }
      case "memory.list": {
        for (const item of listOf(snapshot, "memories")) {
          const key = stringOf(item, "key");
          const project = stringOrNull(item, "project");
          if (key === undefined || project === undefined) {
            missing.push("snapshot_memory_identity_missing");
            continue;
          }
          const memory = this.#memories.get(
            scope.ownerId,
            key,
            project === null ? undefined : project,
          );
          if (memory === undefined || memory.status !== "active") {
            missing.push(`snapshot_memory_missing:${key}`);
          }
        }
        break;
      }
      case "schedule.list": {
        for (const item of listOf(snapshot, "schedules")) {
          const id = stringOf(item, "id");
          const createdAt = stringOf(item, "createdAt");
          if (id === undefined || createdAt === undefined) {
            missing.push("snapshot_schedule_identity_missing");
            continue;
          }
          const policy = this.#schedulePolicies.get(id);
          if (
            policy === undefined ||
            policy.ownerId !== scope.ownerId ||
            policy.createdAt !== createdAt
          ) {
            missing.push(`snapshot_schedule_missing:${id}`);
          }
        }
        break;
      }
    }
    return [...new Set(missing)];
  }

  #summary(
    tool: StateToolName,
    scope: StateReadScope,
    snapshotAt: string,
  ): Record<string, unknown> {
    const ownerId = scope.ownerId;
    const project = scope.project;
    const counts =
      project === undefined
        ? this.#tasks.countsByOwner(ownerId)
        : this.#tasks.countsByOwnerProject(ownerId, project);
    const recentSource =
      project === undefined
        ? this.#tasks.listByOwner(ownerId, 3, 0)
        : this.#tasks.listByOwnerProject(ownerId, project, 3, 0);
    const reminderNext = this.#schedules.listPendingByOwner(ownerId, 3, 0);
    const policyCounts = this.#schedulePolicies.countsByOwner(ownerId);
    return {
      tool,
      scope: { ownerId, project: project ?? null, asOf: snapshotAt },
      tasks: {
        counts,
        recent: recentSource.map(taskBrief),
      },
      reminders: {
        pending: this.#schedules.countPendingByOwner(ownerId),
        next: reminderNext.map(reminderBrief),
      },
      schedules: {
        counts: policyCounts,
      },
      memories: {
        global: this.#memories.countActive(ownerId),
        project:
          project === undefined ? null : this.#memories.countActive(ownerId, project),
      },
    };
  }

  #taskList(
    tool: StateToolName,
    scope: StateReadScope,
    args: TaskListArgs,
  ): Record<string, unknown> {
    const project = scope.project;
    const status = args.status;
    const total =
      status === undefined
        ? project === undefined
          ? this.#tasks.countByOwner(scope.ownerId)
          : this.#tasks.countByOwnerProject(scope.ownerId, project)
        : project === undefined
          ? this.#tasks.countByOwnerStatus(scope.ownerId, status)
          : this.#tasks.countByOwnerProjectStatus(scope.ownerId, project, status);
    const tasks =
      status === undefined
        ? project === undefined
          ? this.#tasks.listByOwner(scope.ownerId, args.limit, args.offset)
          : this.#tasks.listByOwnerProject(
              scope.ownerId,
              project,
              args.limit,
              args.offset,
            )
        : project === undefined
          ? this.#tasks.listByOwnerStatus(
              scope.ownerId,
              status,
              args.limit,
              args.offset,
            )
          : this.#tasks.listByOwnerProjectStatus(
              scope.ownerId,
              project,
              status,
              args.limit,
              args.offset,
            );
    return {
      tool,
      scope: { ownerId: scope.ownerId, project: project ?? null },
      status: status ?? null,
      limit: args.limit,
      offset: args.offset,
      total,
      returned: tasks.length,
      tasks: tasks.map(taskBrief),
    };
  }

  #taskGet(
    tool: StateToolName,
    scope: StateReadScope,
    input: string,
  ): Record<string, unknown> {
    const exact = this.#tasks.get(input);
    const visible = (task: TaskRecord): boolean =>
      task.ownerId === scope.ownerId &&
      (scope.project === undefined || taskProject(task) === scope.project);
    let task = exact !== undefined && visible(exact) ? exact : undefined;
    if (task === undefined) {
      const matches =
        scope.project === undefined
          ? this.#tasks.findByOwnerPrefix(scope.ownerId, input, 2)
          : this.#tasks.findByOwnerProjectPrefix(
              scope.ownerId,
              scope.project,
              input,
              2,
            );
      if (matches.length > 1) {
        throw new ToolRejectedError("taskId prefix matches more than one task");
      }
      task = matches[0];
    }
    if (task === undefined) {
      throw new ToolRejectedError("task not found in owner scope");
    }
    return {
      tool,
      scope: { ownerId: scope.ownerId, project: scope.project ?? null },
      task: taskDetail(task),
    };
  }

  #reminderList(
    tool: StateToolName,
    scope: StateReadScope,
    args: ListArgs,
  ): Record<string, unknown> {
    const total = this.#schedules.countPendingByOwner(scope.ownerId);
    const reminders = this.#schedules.listPendingByOwner(
      scope.ownerId,
      args.limit,
      args.offset,
    );
    return {
      tool,
      scope: { ownerId: scope.ownerId, project: null },
      limit: args.limit,
      offset: args.offset,
      total,
      returned: reminders.length,
      reminders: reminders.map(reminderBrief),
    };
  }

  #memoryList(
    tool: StateToolName,
    scope: StateReadScope,
    args: ListArgs,
  ): Record<string, unknown> {
    const project = scope.project;
    const global = this.#memories.countActive(scope.ownerId);
    const projectCount =
      project === undefined ? 0 : this.#memories.countActive(scope.ownerId, project);
    const memories = this.#memories.listApplicable(
      scope.ownerId,
      project,
      args.limit,
      args.offset,
    );
    return {
      tool,
      scope: { ownerId: scope.ownerId, project: project ?? null },
      limit: args.limit,
      offset: args.offset,
      total: global + projectCount,
      returned: memories.length,
      memories: memories.map(memoryBrief),
    };
  }

  #scheduleList(
    tool: StateToolName,
    scope: StateReadScope,
    args: ListArgs,
  ): Record<string, unknown> {
    const total = sumCounts(this.#schedulePolicies.countsByOwner(scope.ownerId));
    const policies = this.#schedulePolicies.listByOwner(
      scope.ownerId,
      args.limit,
      args.offset,
    );
    return {
      tool,
      scope: { ownerId: scope.ownerId, project: null },
      limit: args.limit,
      offset: args.offset,
      total,
      returned: policies.length,
      schedules: policies.map(scheduleBrief),
    };
  }
}

class StateReadTool implements ActionTool {
  readonly readOnly = true;
  readonly replayPolicy = "never" as const;
  readonly resource = STATE_RESOURCE;
  readonly timeoutMs = 10_000;

  readonly taskName: StateToolName;
  readonly #service: StateReadService;

  constructor(name: StateToolName, service: StateReadService) {
    this.taskName = name;
    this.#service = service;
  }

  get name(): string {
    return this.taskName;
  }

  get description(): string {
    return "Owner-scoped internal state read. Read-only and bounded.";
  }

  canonicalize(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Record<string, unknown> {
    return this.#service.canonicalize(this.taskName, args, scopeOf(context));
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecution> {
    return this.#service.execute(this.taskName, scopeOf(context), args);
  }

  async verify(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolVerification> {
    const result = this.#service.read(this.taskName, scopeOf(context), args);
    return { satisfied: true, evidence: snapshotEvidence(result) };
  }
}

function scopeOf(context: ToolExecutionContext | undefined): StateReadScope {
  if (context === undefined || context.ownerId.trim().length === 0) {
    throw new ToolRejectedError("state tool requires a trusted owner context");
  }
  return {
    ownerId: context.ownerId,
    project: context.project,
  };
}

export function createStateTools(service: StateReadService): ActionTool[] {
  return STATE_TOOL_NAMES.map((name) => new StateReadTool(name, service));
}

export function hashSnapshot(snapshot: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableStringify(snapshot), "utf8")
    .digest("hex");
}

export interface StateEvidence {
  tool: StateToolName;
  ownerId: string;
  project: string | null;
  args: Record<string, unknown>;
  argsHash: string;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  snapshotAt: string;
  byteLength?: number;
}

/** Parse persisted executor evidence; never trust model-authored shapes. */
export function parseStateEvidence(value: unknown): StateEvidence | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "state_snapshot") {
    return undefined;
  }
  const tool = typeof record.tool === "string" ? record.tool : undefined;
  if (tool === undefined || !isStateToolName(tool)) {
    return undefined;
  }
  const ownerId = typeof record.ownerId === "string" ? record.ownerId : undefined;
  const project = record.project;
  const args = record.args;
  const argsHash = record.argsHash;
  const snapshot = record.snapshot;
  const snapshotHash = record.snapshotHash;
  const snapshotAt = record.snapshotAt;
  if (
    ownerId === undefined ||
    (project !== null && typeof project !== "string") ||
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    typeof argsHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(argsHash) ||
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    typeof snapshotHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(snapshotHash) ||
    typeof snapshotAt !== "string"
  ) {
    return undefined;
  }
  return {
    tool,
    ownerId,
    project,
    args: args as Record<string, unknown>,
    argsHash,
    snapshot: snapshot as Record<string, unknown>,
    snapshotHash,
    snapshotAt,
    byteLength:
      typeof record.byteLength === "number" ? record.byteLength : undefined,
  };
}

export function snapshotScope(
  evidence: StateEvidence,
): { ownerId: string; project: string | null } | undefined {
  return readScope(evidence.snapshot);
}

export function snapshotEvidence(result: StateSnapshot): Record<string, unknown> {
  return {
    kind: "state_snapshot",
    tool: result.tool,
    ownerId: result.ownerId,
    project: result.project ?? null,
    args: result.args,
    argsHash: hashArgs(result.tool, result.args),
    snapshot: result.snapshot,
    snapshotHash: result.snapshotHash,
    snapshotAt: result.snapshotAt,
    byteLength: result.byteLength,
  };
}

/**
 * Deterministically drop tail items until the receipt fits the byte cap.
 * Counts/scope remain; `truncated` tells the caller the page was shortened.
 */
function trimSnapshot(
  snapshot: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const working = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  // Include the marker in every size measurement so a trimmed page cannot
  // land just over the cap after the marker is added.
  working.truncated = true;
  const lists: { owner: Record<string, unknown>; key: string; countKey?: string }[] = [
    { owner: working, key: "memories", countKey: "returned" },
    { owner: working, key: "tasks", countKey: "returned" },
    { owner: working, key: "reminders", countKey: "returned" },
    { owner: working, key: "schedules", countKey: "returned" },
  ];
  const tasks = working.tasks;
  if (typeof tasks === "object" && tasks !== null) {
    lists.push({ owner: tasks as Record<string, unknown>, key: "recent" });
  }
  const reminders = working.reminders;
  if (typeof reminders === "object" && reminders !== null) {
    lists.push({ owner: reminders as Record<string, unknown>, key: "next" });
  }
  while (new TextEncoder().encode(JSON.stringify(working)).length > maxBytes) {
    let trimmed = false;
    for (const list of lists) {
      const value = list.owner[list.key];
      if (Array.isArray(value) && value.length > 0) {
        value.pop();
        if (list.countKey !== undefined) {
          list.owner[list.countKey] = value.length;
        }
        trimmed = true;
        break;
      }
    }
    if (!trimmed) {
      break;
    }
  }
  return working;
}

function taskBrief(task: TaskRecord): TaskBrief {
  return {
    id: task.id,
    status: task.status,
    goal: truncate(task.goal, TEXT_LIMIT),
    revision: task.revision,
    project: taskProject(task) ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function taskDetail(task: TaskRecord): Record<string, unknown> {
  return {
    ...taskBrief(task),
    resultRef:
      task.resultRef === undefined ? null : truncate(task.resultRef, RESULT_LIMIT),
    lastError:
      task.lastError === undefined ? null : truncate(task.lastError, RESULT_LIMIT),
    verification:
      task.verification === undefined
        ? null
        : {
            verifier: task.verification.verifier,
            verdict: task.verification.verdict,
            reason: truncate(task.verification.reason, TEXT_LIMIT),
          },
  };
}

function reminderBrief(schedule: ScheduleRecord): Record<string, unknown> {
  return {
    id: schedule.id,
    status: schedule.status,
    dueAt: schedule.dueAt,
    timezone: schedule.timezone,
    text: truncate(schedule.text, TEXT_LIMIT),
    createdAt: schedule.createdAt,
  };
}

function memoryBrief(memory: MemoryRecord): Record<string, unknown> {
  return {
    key: memory.key,
    value: truncate(memory.value, MEMORY_VALUE_LIMIT),
    project: memory.project ?? null,
    version: memory.version,
    updatedAt: memory.updatedAt,
  };
}

function scheduleBrief(policy: SchedulePolicyRecord): Record<string, unknown> {
  return {
    id: policy.id,
    status: policy.status,
    kind: policy.kind,
    cadence: policy.cadence,
    weekday: policy.weekday ?? null,
    localTime: policy.localTime,
    timezone: policy.timezone,
    repo: policy.kind === "internal" ? null : policy.repo,
    goal: truncate(policy.goal, TEXT_LIMIT),
    version: policy.version,
    nextRunAt: policy.nextRunAt ?? null,
    expiresAt: policy.expiresAt,
    createdAt: policy.createdAt,
  };
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function recordOf(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : undefined;
}

function listOf(value: unknown, key: string): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function stringOf(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function stringOrNull(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const item = value[key];
  if (item === null) {
    return null;
  }
  return typeof item === "string" ? item : undefined;
}

function readScope(
  snapshot: Record<string, unknown>,
): { ownerId: string; project: string | null } | undefined {
  const scope = recordOf(snapshot, "scope");
  if (scope === undefined) {
    return undefined;
  }
  const ownerId = stringOf(scope, "ownerId");
  // An absent project means owner-level/global scope, not a malformed scope.
  const project =
    scope.project === undefined
      ? null
      : scope.project === null
        ? null
        : typeof scope.project === "string"
          ? scope.project
          : undefined;
  if (ownerId === undefined || project === undefined) {
    return undefined;
  }
  return { ownerId, project };
}

/** Formatting for deterministic status replies; never model-authored. */
export function formatStateSummary(
  snapshot: StateSnapshot,
  timezone: string,
): string {
  if (snapshot.tool !== "state.summary") {
    return "内部状态快照不可用。";
  }
  const body = snapshot.snapshot as {
    scope?: { project?: string | null };
    tasks?: { counts?: Partial<Record<TaskStatus, number>>; recent?: TaskBrief[] };
    reminders?: { pending?: number; next?: Record<string, unknown>[] };
    schedules?: { counts?: Record<string, number> };
    memories?: { global?: number; project?: number | null };
  };
  const counts = body.tasks?.counts ?? {};
  const recent = body.tasks?.recent ?? [];
  const reminders = body.reminders?.next ?? [];
  const scope =
    body.scope?.project === null || body.scope?.project === undefined
      ? "全局"
      : `项目 ${body.scope.project}`;
  const lines: string[] = [
    `状态快照（${snapshot.snapshotAt.slice(0, 19).replace("T", " ")}Z，${timezone}，范围：${scope}）：`,
    `任务：排队 ${counts.queued ?? 0}，运行 ${counts.running ?? 0}，` +
      `等待 ${(counts.waiting_user ?? 0) + (counts.waiting_external ?? 0)}，` +
      `完成 ${counts.succeeded ?? 0}，待核对 ${counts.needs_review ?? 0}，` +
      `失败 ${counts.failed ?? 0}，取消 ${counts.cancelled ?? 0}。`,
  ];
  if (recent.length === 0) {
    lines.push("最近任务：无。");
  } else {
    lines.push("最近任务：");
    for (const task of recent) {
      lines.push(`- ${task.id.slice(0, 8)} ${task.status} ${task.goal}`);
    }
  }
  const pending = body.reminders?.pending ?? 0;
  if (pending === 0) {
    lines.push("提醒：当前没有待发送提醒。");
  } else {
    lines.push(`提醒：${pending} 条待发送。`);
    for (const reminder of reminders) {
      const dueAt = typeof reminder.dueAt === "string" ? reminder.dueAt : "";
      const text = typeof reminder.text === "string" ? reminder.text : "";
      const tz = typeof reminder.timezone === "string" ? reminder.timezone : timezone;
      let formatted = dueAt;
      try {
        formatted = new Intl.DateTimeFormat("zh-CN", {
          timeZone: tz,
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(dueAt));
      } catch {
        // Keep the ISO value when the stored timezone is invalid.
      }
      lines.push(`- ${formatted}（${tz}）${text}`);
    }
  }
  const policyCounts = body.schedules?.counts ?? {};
  const activePolicies = policyCounts.active ?? 0;
  const drafts = policyCounts.draft ?? 0;
  lines.push(`周期计划：启用 ${activePolicies}，草稿 ${drafts}。`);
  const memories = body.memories;
  if (memories !== undefined) {
    lines.push(
      `记忆：全局 ${memories.global ?? 0}` +
        (memories.project === null || memories.project === undefined
          ? "。"
          : `，当前项目 ${memories.project}。`),
    );
  }
  return lines.join("\n");
}
