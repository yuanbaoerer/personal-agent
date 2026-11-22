import type {
  PlanBudget,
  PlanDiff,
  PlanRecord,
  PlanStatus,
  PlanStepDiff,
  PlanStepRecord,
  PlanStepSpec,
  PlanView,
  TaskRecord,
} from "../domain/types.ts";
import type { CapabilityView } from "../plugins/fence.ts";
import { PlanRepository } from "../storage/plans.ts";
import type { Store } from "../storage/store.ts";
import type { TaskRepository } from "../storage/tasks.ts";

export const PLAN_MIN_STEPS = 3;
export const PLAN_MAX_STEPS = 5;
export const PLAN_MAX_ATTEMPTS_PER_STEP = 3;
export const PLAN_DEFAULT_TIMEOUT_MS = 300_000;
export const PLAN_MAX_TIMEOUT_MS = 3_600_000;

export type PlanErrorCode =
  | "plan_not_found"
  | "plan_forbidden"
  | "task_not_found"
  | "task_terminal"
  | "invalid_plan"
  | "task_revision_changed"
  | "stale_task_input"
  | "conflict_active_plan"
  | "invalid_transition";

export class PlanError extends Error {
  readonly code: PlanErrorCode;

  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export interface PlanSpecInput {
  steps: PlanStepSpec[];
  budget?: Partial<PlanBudget>;
}

export interface ResolvedPlanSpec {
  steps: Required<PlanStepSpec>[];
  budget: PlanBudget;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskRecord["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  // Acknowledgement is the only exit from needs_review; a plan must not
  // resurrect or re-execute work whose result is already delivered.
  "needs_review",
]);

const STEP_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function uniqueStrings(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) {
      throw new PlanError("invalid_plan", `${field} must not contain an empty value`);
    }
    if (!CAPABILITY_PATTERN.test(value)) {
      throw new PlanError("invalid_plan", `${field} value ${value} is not a valid capability name`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function compareStepFields(
  left: Required<PlanStepSpec>,
  right: Required<PlanStepSpec>,
): string[] {
  const fields: string[] = [];
  if (left.goal !== right.goal) fields.push("goal");
  if (!sameList(left.dependsOn, right.dependsOn)) fields.push("dependsOn");
  if (!sameList(left.tools, right.tools)) fields.push("tools");
  if (!sameList(left.resources, right.resources)) fields.push("resources");
  if (left.verifierId !== right.verifierId) fields.push("verifierId");
  if (left.completionCriteria !== right.completionCriteria) fields.push("completionCriteria");
  if (left.maxAttempts !== right.maxAttempts) fields.push("maxAttempts");
  if (left.timeoutMs !== right.timeoutMs) fields.push("timeoutMs");
  return fields;
}

function normalizeBudget(steps: readonly PlanStepSpec[], input?: Partial<PlanBudget>): PlanBudget {
  const maxSteps = input?.maxSteps ?? steps.length;
  if (!Number.isInteger(maxSteps) || maxSteps < steps.length || maxSteps > PLAN_MAX_STEPS) {
    throw new PlanError(
      "invalid_plan",
      `budget.maxSteps must be between ${steps.length} and ${PLAN_MAX_STEPS}`,
    );
  }
  const maxAttemptsPerStep = input?.maxAttemptsPerStep ?? 1;
  if (
    !Number.isInteger(maxAttemptsPerStep) ||
    maxAttemptsPerStep < 1 ||
    maxAttemptsPerStep > PLAN_MAX_ATTEMPTS_PER_STEP
  ) {
    throw new PlanError(
      "invalid_plan",
      `budget.maxAttemptsPerStep must be between 1 and ${PLAN_MAX_ATTEMPTS_PER_STEP}`,
    );
  }
  const timeoutMs = input?.timeoutMs ?? PLAN_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > PLAN_MAX_TIMEOUT_MS) {
    throw new PlanError(
      "invalid_plan",
      `budget.timeoutMs must be between 1000 and ${PLAN_MAX_TIMEOUT_MS}`,
    );
  }
  const budget: PlanBudget = { maxSteps, maxAttemptsPerStep, timeoutMs };
  if (input?.maxToolCalls !== undefined) {
    if (
      !Number.isInteger(input.maxToolCalls) ||
      input.maxToolCalls < 1 ||
      input.maxToolCalls > 200
    ) {
      throw new PlanError("invalid_plan", "budget.maxToolCalls must be between 1 and 200");
    }
    budget.maxToolCalls = input.maxToolCalls;
  }
  if (input?.maxCostUsd !== undefined) {
    if (
      !Number.isFinite(input.maxCostUsd) ||
      input.maxCostUsd <= 0 ||
      input.maxCostUsd > 1_000
    ) {
      throw new PlanError("invalid_plan", "budget.maxCostUsd must be in (0, 1000]");
    }
    budget.maxCostUsd = input.maxCostUsd;
  }
  return budget;
}

/** A replan may shrink but never refresh or expand an existing plan budget. */
function assertBudgetNotExpanded(next: PlanBudget, current: PlanBudget): void {
  const required: { key: "maxSteps" | "maxAttemptsPerStep" | "timeoutMs"; label: string }[] = [
    { key: "maxSteps", label: "maxSteps" },
    { key: "maxAttemptsPerStep", label: "maxAttemptsPerStep" },
    { key: "timeoutMs", label: "timeoutMs" },
  ];
  for (const { key, label } of required) {
    if (next[key] > current[key]) {
      throw new PlanError("invalid_plan", `replan cannot increase budget.${label}`);
    }
  }
  for (const key of ["maxToolCalls", "maxCostUsd"] as const) {
    const currentValue = current[key];
    const nextValue = next[key];
    if (
      currentValue !== undefined &&
      (nextValue === undefined || nextValue > currentValue)
    ) {
      throw new PlanError("invalid_plan", `replan cannot increase budget.${key}`);
    }
  }
}

/**
 * Validate a model- or owner-proposed plan against the parent task mandate
 * and the live capability catalog. The program never lets a plan widen
 * authority, add unknown tools, exceed the small-DAG bounds, or contain a
 * cycle.
 */
export function resolvePlanSpec(
  input: PlanSpecInput,
  task: TaskRecord,
  capabilities?: CapabilityView,
): ResolvedPlanSpec {
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length < PLAN_MIN_STEPS || steps.length > PLAN_MAX_STEPS) {
    throw new PlanError(
      "invalid_plan",
      `a plan must contain between ${PLAN_MIN_STEPS} and ${PLAN_MAX_STEPS} steps`,
    );
  }
  const budget = normalizeBudget(steps, input.budget);

  const parentTools = new Set(task.mandate.tools);
  const parentResources = new Set(task.mandate.resources);
  const catalogTools =
    capabilities === undefined ? undefined : new Set(capabilities.toolNames());
  const catalogResources =
    capabilities === undefined ? undefined : new Set(capabilities.resources());

  const normalized: Required<PlanStepSpec>[] = [];
  const keys = new Set<string>();
  for (const raw of steps) {
    const key = raw.key.trim();
    if (!STEP_KEY_PATTERN.test(key)) {
      throw new PlanError("invalid_plan", `step key ${key || "(empty)"} is not valid`);
    }
    if (keys.has(key)) {
      throw new PlanError("invalid_plan", `duplicate step key ${key}`);
    }
    keys.add(key);

    const goal = raw.goal.trim();
    if (goal.length === 0 || goal.length > 500) {
      throw new PlanError("invalid_plan", `step ${key} goal must be 1–500 characters`);
    }
    const verifierId = raw.verifierId.trim();
    if (!VERIFIER_PATTERN.test(verifierId)) {
      throw new PlanError("invalid_plan", `step ${key} verifierId is not valid`);
    }
    const completionCriteria = (raw.completionCriteria ?? "").trim();
    if (completionCriteria.length > 2_000) {
      throw new PlanError(
        "invalid_plan",
        `step ${key} completionCriteria must be at most 2000 characters`,
      );
    }
    if (completionCriteria.startsWith("{")) {
      let criteria: unknown;
      try {
        criteria = JSON.parse(completionCriteria);
      } catch {
        throw new PlanError("invalid_plan", `step ${key} completionCriteria is not valid JSON`);
      }
      if (typeof criteria === "object" && criteria !== null) {
        const declared = (criteria as Record<string, unknown>).verifier;
        if (typeof declared === "string" && declared !== verifierId) {
          throw new PlanError(
            "invalid_plan",
            `step ${key} completionCriteria verifier ${declared} does not match ${verifierId}`,
          );
        }
      }
    }

    const tools = uniqueStrings(raw.tools, `step ${key} tools`);
    const resources = uniqueStrings(raw.resources, `step ${key} resources`);
    const dependsOn = uniqueStrings(raw.dependsOn, `step ${key} dependsOn`);

    for (const tool of tools) {
      if (!parentTools.has(tool)) {
        throw new PlanError(
          "invalid_plan",
          `step ${key} requests tool ${tool} outside the parent mandate`,
        );
      }
      if (catalogTools !== undefined && !catalogTools.has(tool)) {
        throw new PlanError("invalid_plan", `step ${key} requests disabled tool ${tool}`);
      }
      if (catalogResources !== undefined && capabilities !== undefined) {
        const resource = capabilities.resourceForTool(tool);
        if (resource !== undefined && !resources.includes(resource)) {
          throw new PlanError(
            "invalid_plan",
            `step ${key} must include resource ${resource} for tool ${tool}`,
          );
        }
      }
    }
    for (const resource of resources) {
      if (!parentResources.has(resource)) {
        throw new PlanError(
          "invalid_plan",
          `step ${key} requests resource ${resource} outside the parent mandate`,
        );
      }
      if (catalogResources !== undefined && !catalogResources.has(resource)) {
        throw new PlanError("invalid_plan", `step ${key} requests disabled resource ${resource}`);
      }
    }
    if (dependsOn.includes(key)) {
      throw new PlanError("invalid_plan", `step ${key} cannot depend on itself`);
    }

    const maxAttempts = raw.maxAttempts ?? 1;
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > budget.maxAttemptsPerStep
    ) {
      throw new PlanError(
        "invalid_plan",
        `step ${key} maxAttempts must be between 1 and ${budget.maxAttemptsPerStep}`,
      );
    }
    const timeoutMs = raw.timeoutMs ?? budget.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > budget.timeoutMs) {
      throw new PlanError(
        "invalid_plan",
        `step ${key} timeoutMs must be between 1000 and ${budget.timeoutMs}`,
      );
    }

    normalized.push({
      key,
      goal,
      dependsOn,
      tools,
      resources,
      verifierId,
      completionCriteria,
      maxAttempts,
      timeoutMs,
    });
  }

  for (const step of normalized) {
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency)) {
        throw new PlanError(
          "invalid_plan",
          `step ${step.key} depends on unknown step ${dependency}`,
        );
      }
    }
  }

  // Cycle detection over the validated keys.
  const byKey = new Map(normalized.map((step) => [step.key, step]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): void => {
    const current = state.get(key);
    if (current === "done") {
      return;
    }
    if (current === "visiting") {
      throw new PlanError("invalid_plan", `plan dependencies contain a cycle at ${key}`);
    }
    state.set(key, "visiting");
    const step = byKey.get(key);
    for (const dependency of step?.dependsOn ?? []) {
      visit(dependency);
    }
    state.set(key, "done");
  };
  for (const step of normalized) {
    visit(step.key);
  }

  const parentBudget = task.budget ?? {};
  const parentCost = parentBudget.maxCostUsd;
  if (
    budget.maxCostUsd !== undefined &&
    typeof parentCost === "number" &&
    budget.maxCostUsd > parentCost
  ) {
    throw new PlanError(
      "invalid_plan",
      `plan maxCostUsd ${budget.maxCostUsd} exceeds the parent task ceiling ${parentCost}`,
    );
  }

  return { steps: normalized, budget };
}

function rootsOf(steps: readonly PlanStepRecord[]): string[] {
  return steps.filter((step) => step.dependsOn.length === 0).map((step) => step.key);
}

function planStepsToSpecs(steps: readonly PlanStepRecord[]): Required<PlanStepSpec>[] {
  return steps.map((step) => ({
    key: step.key,
    goal: step.goal,
    dependsOn: step.dependsOn,
    tools: step.tools,
    resources: step.resources,
    verifierId: step.verifierId,
    completionCriteria: step.completionCriteria,
    maxAttempts: step.maxAttempts,
    timeoutMs: step.timeoutMs,
  }));
}

export function diffPlanSteps(
  from: readonly PlanStepRecord[],
  to: readonly PlanStepRecord[],
): PlanStepDiff[] {
  const fromByKey = new Map(from.map((step) => [step.key, step]));
  const toByKey = new Map(to.map((step) => [step.key, step]));
  const diffs: PlanStepDiff[] = [];
  for (const step of to) {
    const previous = fromByKey.get(step.key);
    if (previous === undefined) {
      diffs.push({ key: step.key, change: "added", fields: [] });
      continue;
    }
    const fields = compareStepFields(
      planStepsToSpecs([previous])[0] as Required<PlanStepSpec>,
      planStepsToSpecs([step])[0] as Required<PlanStepSpec>,
    );
    diffs.push({
      key: step.key,
      change: fields.length === 0 ? "unchanged" : "changed",
      fields,
    });
  }
  for (const step of from) {
    if (!toByKey.has(step.key)) {
      diffs.push({ key: step.key, change: "removed", fields: [] });
    }
  }
  return diffs;
}

export interface PlanServiceDeps {
  store: Store;
  plans: PlanRepository;
  tasks: TaskRepository;
  capabilities?: CapabilityView;
  now?: () => Date;
}

/**
 * Owner-facing plan lifecycle. Drafts never execute anything: activation is
 * an explicit owner command, every mutation is audited, and a plan is bound
 * to the parent task revision/input seq it was validated against.
 */
export class PlanService {
  readonly #store: Store;
  readonly #plans: PlanRepository;
  readonly #tasks: TaskRepository;
  readonly #capabilities?: CapabilityView;
  readonly #now: () => Date;
  #onLifecycle?: (planId: string) => void;

  constructor(deps: PlanServiceDeps) {
    this.#store = deps.store;
    this.#plans = deps.plans;
    this.#tasks = deps.tasks;
    this.#capabilities = deps.capabilities;
    this.#now = deps.now ?? (() => new Date());
  }

  /** The host wires this to the executor; tests can omit it. */
  setLifecycleHook(handler: (planId: string) => void): void {
    this.#onLifecycle = handler;
  }

  create(ownerId: string, parentTaskId: string, input: PlanSpecInput): PlanView {
    const task = this.#task(ownerId, parentTaskId);
    this.#assertTaskOpen(task);
    const spec = resolvePlanSpec(input, task, this.#capabilities);
    const latest = this.#plans.latestForTask(task.id);
    const now = this.#now().toISOString();
    const view = this.#store.db.transaction(() => {
      const plan = this.#plans.insertPlan({
        ownerId,
        parentTaskId: task.id,
        taskRevision: task.revision,
        inputSeq: this.#plans.maxInputSeq(task.id),
        planVersion: (latest?.planVersion ?? 0) + 1,
        status: "draft",
        projectKey: task.mandate.project,
        budget: spec.budget,
        createdAt: now,
      });
      const steps = spec.steps.map((step, ordinal) =>
        this.#plans.insertStep({
          planId: plan.id,
          stepKey: step.key,
          ordinal,
          goal: step.goal,
          dependsOn: step.dependsOn,
          tools: step.tools,
          resources: step.resources,
          verifierId: step.verifierId,
          completionCriteria: step.completionCriteria,
          maxAttempts: step.maxAttempts,
          timeoutMs: step.timeoutMs,
          status: "blocked",
          createdAt: now,
        }),
      );
      return { plan, steps };
    });
    this.#audit("plan.created", view.plan, { steps: view.steps.length });
    return view;
  }

  revise(ownerId: string, planId: string, input: PlanSpecInput): PlanView {
    const source = this.#ownedPlan(ownerId, planId);
    if (source.status === "completed" || source.status === "cancelled") {
      throw new PlanError("invalid_transition", `cannot revise a ${source.status} plan`);
    }
    const task = this.#task(ownerId, source.parentTaskId);
    this.#assertTaskOpen(task);
    const spec = resolvePlanSpec(input, task, this.#capabilities);
    const oldSteps = this.#plans.listSteps(source.id);
    if (oldSteps.some((step) => step.status === "running")) {
      throw new PlanError("invalid_transition", "pause the plan before revising it");
    }
    const latest = this.#plans.latestForTask(task.id);
    const now = this.#now().toISOString();
    const planVersion = (latest?.planVersion ?? source.planVersion) + 1;

    const view = this.#store.db.transaction(() => {
      if (source.status !== "superseded") {
        this.#plans.setPlanStatus(source.id, ["draft", "active", "paused"], "superseded", now);
      }
      const plan = this.#plans.insertPlan({
        ownerId,
        parentTaskId: task.id,
        taskRevision: task.revision,
        inputSeq: this.#plans.maxInputSeq(task.id),
        planVersion,
        status: "draft",
        projectKey: task.mandate.project,
        budget: spec.budget,
        createdAt: now,
      });
      const steps = spec.steps.map((step, ordinal) =>
        this.#plans.insertStep({
          planId: plan.id,
          stepKey: step.key,
          ordinal,
          goal: step.goal,
          dependsOn: step.dependsOn,
          tools: step.tools,
          resources: step.resources,
          verifierId: step.verifierId,
          completionCriteria: step.completionCriteria,
          maxAttempts: step.maxAttempts,
          timeoutMs: step.timeoutMs,
          status: "blocked",
          createdAt: now,
        }),
      );
      const diff: PlanDiff = {
        parentTaskId: task.id,
        fromVersion: source.planVersion,
        toVersion: plan.planVersion,
        steps: diffPlanSteps(oldSteps, steps),
        createdAt: now,
      };
      this.#plans.insertDiff(plan.id, diff);
      return { plan, steps };
    });
    this.#audit("plan.revised", view.plan, {
      fromVersion: source.planVersion,
      fromPlanId: source.id,
    });
    this.#onLifecycle?.(source.id);
    return view;
  }

  /**
   * Owner-initiated replan after a paused/failed step. Completed steps are
   * immutable and copied into the new version; budgets can only shrink.
   * The new version becomes active immediately under the owner's explicit
   * command and keeps the same parent task/authorization.
   */
  replan(ownerId: string, planId: string, input: PlanSpecInput): PlanView {
    const source = this.#ownedPlan(ownerId, planId);
    if (source.status !== "paused" && source.status !== "active") {
      throw new PlanError("invalid_transition", `cannot replan a ${source.status} plan`);
    }
    const task = this.#task(ownerId, source.parentTaskId);
    if (
      task.status === "succeeded" ||
      task.status === "cancelled" ||
      task.status === "needs_review"
    ) {
      throw new PlanError("task_terminal", `parent task is ${task.status}`);
    }
    if (source.taskRevision !== task.revision) {
      throw new PlanError("task_revision_changed", "parent task revision changed");
    }
    const latestInput = this.#plans.maxInputSeq(task.id);
    if (latestInput > source.inputSeq) {
      throw new PlanError("stale_task_input", "parent task has newer input");
    }
    const oldSteps = this.#plans.listSteps(source.id);
    if (oldSteps.some((step) => step.status === "running")) {
      throw new PlanError("invalid_transition", "pause the plan before replanning");
    }
    const spec = resolvePlanSpec(input, task, this.#capabilities);
    assertBudgetNotExpanded(spec.budget, source.budget);

    for (const step of oldSteps) {
      if (step.status !== "completed") {
        continue;
      }
      const replacement = spec.steps.find((candidate) => candidate.key === step.key);
      if (replacement === undefined) {
        throw new PlanError(
          "invalid_plan",
          `completed step ${step.key} cannot be removed by a replan`,
        );
      }
      const comparison = diffPlanSteps([step], [
        {
          ...step,
          goal: replacement.goal,
          dependsOn: replacement.dependsOn,
          tools: replacement.tools,
          resources: replacement.resources,
          verifierId: replacement.verifierId,
          completionCriteria: replacement.completionCriteria,
          maxAttempts: replacement.maxAttempts,
          timeoutMs: replacement.timeoutMs,
        },
      ])[0];
      if (comparison?.change !== "unchanged") {
        throw new PlanError(
          "invalid_plan",
          `completed step ${step.key} cannot be changed by a replan`,
        );
      }
    }

    const completed = new Set(
      oldSteps.filter((step) => step.status === "completed").map((step) => step.key),
    );
    const completedByKey = new Map(
      oldSteps.filter((step) => step.status === "completed").map((step) => [step.key, step]),
    );
    const latest = this.#plans.latestForTask(task.id);
    const now = this.#now().toISOString();
    const view = this.#store.db.transaction(() => {
      this.#plans.setPlanStatus(
        source.id,
        ["active", "paused"],
        "superseded",
        now,
      );
      const plan = this.#plans.insertPlan({
        ownerId,
        parentTaskId: task.id,
        taskRevision: task.revision,
        inputSeq: this.#plans.maxInputSeq(task.id),
        planVersion: (latest?.planVersion ?? source.planVersion) + 1,
        status: "active",
        projectKey: task.mandate.project,
        approvedScopeRef: `task:${task.id}:rev:${task.revision}:plan:${(latest?.planVersion ?? source.planVersion) + 1}`,
        budget: spec.budget,
        createdAt: now,
      });
      if (this.#tasks.bindPlan(task.id, plan.id, now) === undefined) {
        throw new PlanError("invalid_transition", "parent task could not be rebound");
      }
      const steps = spec.steps.map((step, ordinal) => {
        const previous = completedByKey.get(step.key);
        if (previous !== undefined) {
          return this.#plans.insertStep({
            planId: plan.id,
            stepKey: step.key,
            ordinal,
            goal: step.goal,
            dependsOn: step.dependsOn,
            tools: step.tools,
            resources: step.resources,
            verifierId: step.verifierId,
            completionCriteria: step.completionCriteria,
            maxAttempts: step.maxAttempts,
            timeoutMs: step.timeoutMs,
            status: "completed",
            evidenceRefs: previous.evidenceRefs,
            taskId: previous.taskId,
            attempts: previous.attempts,
            startedAt: previous.startedAt,
            completedAt: previous.completedAt,
            createdAt: now,
          });
        }
        return this.#plans.insertStep({
          planId: plan.id,
          stepKey: step.key,
          ordinal,
          goal: step.goal,
          dependsOn: step.dependsOn,
          tools: step.tools,
          resources: step.resources,
          verifierId: step.verifierId,
          completionCriteria: step.completionCriteria,
          maxAttempts: step.maxAttempts,
          timeoutMs: step.timeoutMs,
          status: step.dependsOn.every((dependency) => completed.has(dependency))
            ? "ready"
            : "blocked",
          createdAt: now,
        });
      });
      const diff: PlanDiff = {
        parentTaskId: task.id,
        fromVersion: source.planVersion,
        toVersion: plan.planVersion,
        steps: diffPlanSteps(oldSteps, steps),
        createdAt: now,
      };
      this.#plans.insertDiff(plan.id, diff);
      return { plan, steps };
    });
    this.#audit("plan.replanned", view.plan, {
      fromVersion: source.planVersion,
      fromPlanId: source.id,
    });
    this.#onLifecycle?.(view.plan.id);
    return view;
  }

  activate(ownerId: string, planId: string): PlanView {
    const plan = this.#ownedPlan(ownerId, planId);
    if (plan.status !== "draft") {
      throw new PlanError("invalid_transition", `cannot activate a ${plan.status} plan`);
    }
    const task = this.#task(ownerId, plan.parentTaskId);
    this.#assertFresh(plan, task);
    if (this.#plans.activeForTask(task.id) !== undefined) {
      throw new PlanError("conflict_active_plan", "another plan version is already active");
    }
    if (
      task.status === "running" ||
      this.#tasks.listActiveAssignments(task.id).length > 0
    ) {
      throw new PlanError(
        "invalid_transition",
        "parent task already has an active Worker; wait for or cancel it before activating a plan",
      );
    }
    const steps = this.#plans.listSteps(plan.id);
    resolvePlanSpec(
      { steps: planStepsToSpecs(steps), budget: plan.budget },
      task,
      this.#capabilities,
    );
    const now = this.#now().toISOString();
    const roots = rootsOf(steps);
    const view = this.#store.db.transaction(() => {
      const changed = this.#plans.setPlanStatus(plan.id, ["draft"], "active", now);
      if (!changed) {
        throw new PlanError("invalid_transition", "plan status changed concurrently");
      }
      this.#plans.setStepsStatus(plan.id, roots, "ready", now);
      const activated = this.#plans.getPlan(plan.id);
      if (activated === undefined) {
        throw new PlanError("plan_not_found", "plan disappeared during activation");
      }
      const stamped = this.#plans.setApprovedScope(
        plan.id,
        `task:${task.id}:rev:${plan.taskRevision}:plan:${plan.planVersion}`,
        now,
      );
      if (stamped === undefined) {
        throw new PlanError("plan_not_found", "plan disappeared during activation");
      }
      // Reserve the parent task before any dispatch effect can claim it.
      if (this.#tasks.bindPlan(task.id, plan.id, now) === undefined) {
        throw new PlanError(
          "invalid_transition",
          "parent task is already bound to another active plan",
        );
      }
      return { plan: stamped, steps: this.#plans.listSteps(plan.id) };
    });
    this.#audit("plan.activated", view.plan, { roots });
    this.#onLifecycle?.(view.plan.id);
    return view;
  }

  pause(ownerId: string, planId: string): PlanView {
    return this.#transition(ownerId, planId, ["active"], "paused", "plan.paused");
  }

  resume(ownerId: string, planId: string): PlanView {
    const plan = this.#ownedPlan(ownerId, planId);
    const task = this.#task(ownerId, plan.parentTaskId);
    this.#assertFresh(plan, task);
    if (this.#plans.activeForTask(task.id) !== undefined) {
      throw new PlanError("conflict_active_plan", "another plan version is already active");
    }
    // The catalog can change without a task revision; re-check the steps
    // against the live mandate/capabilities before making them runnable.
    resolvePlanSpec(
      {
        steps: planStepsToSpecs(this.#plans.listSteps(plan.id)),
        budget: plan.budget,
      },
      task,
      this.#capabilities,
    );
    return this.#transition(ownerId, planId, ["paused"], "active", "plan.resumed");
  }

  cancel(ownerId: string, planId: string): PlanView {
    const plan = this.#ownedPlan(ownerId, planId);
    if (plan.status === "completed" || plan.status === "cancelled") {
      throw new PlanError("invalid_transition", `cannot cancel a ${plan.status} plan`);
    }
    const now = this.#now().toISOString();
    const view = this.#store.db.transaction(() => {
      const changed = this.#plans.setPlanStatus(
        plan.id,
        ["draft", "active", "paused"],
        "cancelled",
        now,
      );
      if (!changed) {
        throw new PlanError("invalid_transition", "plan status changed concurrently");
      }
      const steps = this.#plans.listSteps(plan.id);
      this.#plans.setStepsStatus(
        plan.id,
        steps
          .filter((step) => step.status === "blocked" || step.status === "ready" || step.status === "running")
          .map((step) => step.key),
        "cancelled",
        now,
      );
      const cancelled = this.#plans.getPlan(plan.id);
      if (cancelled === undefined) {
        throw new PlanError("plan_not_found", "plan disappeared during cancellation");
      }
      return { plan: cancelled, steps: this.#plans.listSteps(plan.id) };
    });
    this.#audit("plan.cancelled", view.plan, {});
    this.#onLifecycle?.(view.plan.id);
    return view;
  }

  get(ownerId: string, planId: string): PlanView | undefined {
    const plan = this.#plans.getPlan(planId);
    if (plan === undefined || plan.ownerId !== ownerId) {
      return undefined;
    }
    return { plan, steps: this.#plans.listSteps(plan.id) };
  }

  list(
    ownerId: string,
    options: { parentTaskId?: string; status?: PlanStatus; limit?: number } = {},
  ): PlanRecord[] {
    return this.#plans.listByOwner(ownerId, options);
  }

  activeForTask(ownerId: string, parentTaskId: string): PlanView | undefined {
    const plan = this.#plans.activeForTask(parentTaskId);
    if (plan === undefined || plan.ownerId !== ownerId) {
      return undefined;
    }
    return { plan, steps: this.#plans.listSteps(plan.id) };
  }

  diff(
    ownerId: string,
    planId: string,
    fromVersion?: number,
    toVersion?: number,
  ): PlanDiff {
    const plan = this.#ownedPlan(ownerId, planId);
    const versions = this.#plans.listVersions(plan.parentTaskId);
    const to = toVersion ?? plan.planVersion;
    const from = fromVersion ?? to - 1;
    const fromPlan = versions.find((version) => version.planVersion === from);
    const toPlan = versions.find((version) => version.planVersion === to);
    if (fromPlan === undefined || toPlan === undefined) {
      throw new PlanError("plan_not_found", "plan version not found");
    }
    const stored = this.#plans.getDiff(toPlan.id, from, to);
    if (stored !== undefined) {
      return stored;
    }
    return {
      parentTaskId: plan.parentTaskId,
      fromVersion: from,
      toVersion: to,
      steps: diffPlanSteps(
        this.#plans.listSteps(fromPlan.id),
        this.#plans.listSteps(toPlan.id),
      ),
      createdAt: this.#now().toISOString(),
    };
  }

  #transition(
    ownerId: string,
    planId: string,
    expected: readonly PlanStatus[],
    next: PlanStatus,
    event: string,
  ): PlanView {
    const plan = this.#ownedPlan(ownerId, planId);
    const now = this.#now().toISOString();
    const view = this.#store.db.transaction(() => {
      const changed = this.#plans.setPlanStatus(plan.id, expected, next, now);
      if (!changed) {
        throw new PlanError("invalid_transition", "plan status changed concurrently");
      }
      const updated = this.#plans.getPlan(plan.id);
      if (updated === undefined) {
        throw new PlanError("plan_not_found", "plan disappeared during transition");
      }
      return { plan: updated, steps: this.#plans.listSteps(plan.id) };
    });
    this.#audit(event, view.plan, {});
    this.#onLifecycle?.(view.plan.id);
    return view;
  }

  #task(ownerId: string, taskId: string): TaskRecord {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new PlanError("task_not_found", "parent task not found");
    }
    if (task.ownerId !== ownerId) {
      // Do not reveal another owner's task existence.
      throw new PlanError("task_not_found", "parent task not found");
    }
    return task;
  }

  #ownedPlan(ownerId: string, planId: string): PlanRecord {
    const plan = this.#plans.getPlan(planId);
    if (plan === undefined || plan.ownerId !== ownerId) {
      throw new PlanError("plan_not_found", "plan not found");
    }
    return plan;
  }

  #assertTaskOpen(task: TaskRecord): void {
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new PlanError("task_terminal", `parent task is ${task.status}`);
    }
  }

  #assertFresh(plan: PlanRecord, task: TaskRecord): void {
    this.#assertTaskOpen(task);
    if (plan.taskRevision !== task.revision) {
      throw new PlanError(
        "task_revision_changed",
        `plan targets task revision ${plan.taskRevision}, current is ${task.revision}`,
      );
    }
    const latestInput = this.#plans.maxInputSeq(task.id);
    if (latestInput > plan.inputSeq) {
      throw new PlanError(
        "stale_task_input",
        `task has input seq ${latestInput}, plan covers ${plan.inputSeq}`,
      );
    }
  }

  #audit(event: string, plan: PlanRecord, after: Record<string, unknown>): void {
    this.#store.recordAudit({
      event,
      subjectType: "plan",
      subjectId: plan.id,
      after: {
        parentTaskId: plan.parentTaskId,
        planVersion: plan.planVersion,
        status: plan.status,
        ...after,
      },
      traceId: `plan:${plan.id}`,
      occurredAt: this.#now().toISOString(),
    });
  }
}
