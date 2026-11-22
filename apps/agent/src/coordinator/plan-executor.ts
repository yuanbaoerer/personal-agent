import type {
  PlanRecord,
  PlanStepRecord,
  ProjectBinding,
  TaskRecord,
  TaskVerification,
} from "../domain/types.ts";
import { normalizeGithubCriteria } from "./router.ts";
import type { EffectRepository } from "../storage/effects.ts";
import type { PlanRepository } from "../storage/plans.ts";
import type { ProjectRepository } from "../storage/projects.ts";
import type { Store } from "../storage/store.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { EffectDispatcher, EffectOutcome } from "../delivery/effects.ts";
import type { WakeScheduler } from "../runtime/types.ts";
import type { TaskService } from "./tasks.ts";

const PLAN_TICK_KIND = "plan.tick";
const TICK_DELAY_MS = 1_000;

export interface PlanExecutorDeps {
  store: Store;
  plans: PlanRepository;
  tasks: TaskRepository;
  taskService: TaskService;
  effects: EffectRepository;
  projects?: ProjectRepository;
  wake?: WakeScheduler;
  now?: () => Date;
  /** Tests use 0; production polls once a second while children run. */
  tickDelayMs?: number;
}

/**
 * Bounded, sequential plan driver. Each ready step becomes a normal child
 * Task, so assignment leases, fencing, budgets, actions, approvals and the
 * completion verifier are all reused. The executor only advances DAG state
 * and settles the parent from a verified final step.
 */
export class PlanExecutor {
  readonly #store: Store;
  readonly #plans: PlanRepository;
  readonly #tasks: TaskRepository;
  readonly #taskService: TaskService;
  readonly #effects: EffectRepository;
  readonly #projects?: ProjectRepository;
  readonly #wake?: WakeScheduler;
  readonly #now: () => Date;
  readonly #tickDelayMs: number;

  constructor(deps: PlanExecutorDeps) {
    this.#store = deps.store;
    this.#plans = deps.plans;
    this.#tasks = deps.tasks;
    this.#taskService = deps.taskService;
    this.#effects = deps.effects;
    this.#projects = deps.projects;
    this.#wake = deps.wake;
    this.#now = deps.now ?? (() => new Date());
    this.#tickDelayMs = deps.tickDelayMs ?? TICK_DELAY_MS;
  }

  install(dispatcher: EffectDispatcher): void {
    dispatcher.register(PLAN_TICK_KIND, (effect) => this.handleTick(effect.payload));
  }

  /** Called after activation/resume/cancel; idempotent per plan update. */
  start(planId: string): void {
    const plan = this.#plans.getPlan(planId);
    if (plan === undefined) {
      return;
    }
    const now = this.#now().toISOString();
    this.#effects.enqueue({
      kind: PLAN_TICK_KIND,
      businessKey: `plan:${planId}:tick:${plan.updatedAt}`,
      payload: { planId },
      nextAttemptAt: now,
      createdAt: now,
    });
    void this.#wake?.wake();
  }

  /** Restart recovery and repair of a settlement interrupted by a crash. */
  sweep(): void {
    const now = this.#now();
    const bucket = Math.floor(now.getTime() / 60_000);
    for (const plan of this.#plans.listPlansByStatus("active")) {
      this.#effects.enqueue({
        kind: PLAN_TICK_KIND,
        businessKey: `plan:${plan.id}:sweep:${bucket}`,
        payload: { planId: plan.id },
        nextAttemptAt: now.toISOString(),
        createdAt: now.toISOString(),
      });
    }
    for (const plan of this.#plans.listPlansByStatus("paused")) {
      const parent = this.#tasks.get(plan.parentTaskId);
      if (
        parent === undefined ||
        parent.planId !== plan.id ||
        parent.status !== "waiting_external"
      ) {
        continue;
      }
      const steps = this.#plans.listSteps(plan.id);
      const needsReview = steps.find((step) => step.status === "needs_review");
      if (needsReview !== undefined) {
        this.#settleNeedsReview(
          plan,
          parent,
          `step ${needsReview.key} needs review: ${needsReview.lastError ?? "no verifier evidence"}`,
        );
        continue;
      }
      const failed = steps.find(
        (step) => step.status === "failed" && step.attempts >= step.maxAttempts,
      );
      if (failed !== undefined) {
        this.#settleFailed(
          plan,
          parent,
          `step ${failed.key} failed after ${failed.attempts} attempt(s)`,
        );
      }
    }
    for (const plan of this.#plans.listPlansByStatus("cancelled")) {
      const parent = this.#tasks.get(plan.parentTaskId);
      if (parent !== undefined && parent.planId === plan.id) {
        this.#settleCancelled(plan);
      }
    }
    for (const plan of this.#plans.listPlansByStatus("completed")) {
      const parent = this.#tasks.get(plan.parentTaskId);
      if (
        parent !== undefined &&
        parent.planId === plan.id &&
        parent.status === "waiting_external"
      ) {
        this.#settleCompleted(plan, parent, this.#plans.listSteps(plan.id));
      }
    }
    void this.#wake?.wake();
  }

  async handleTick(payload: Record<string, unknown>): Promise<EffectOutcome> {
    const planId = typeof payload.planId === "string" ? payload.planId : undefined;
    if (planId === undefined) {
      return { status: "done" };
    }
    return this.tick(planId);
  }

  async tick(planId: string): Promise<EffectOutcome> {
    const plan = this.#plans.getPlan(planId);
    if (plan === undefined) {
      return { status: "done" };
    }
    if (plan.status === "cancelled") {
      this.#settleCancelled(plan);
      return { status: "done" };
    }
    // The parent may be gone; settle this plan's own children above.
    if (plan.status === "completed") {
      const parent = this.#tasks.get(plan.parentTaskId);
      if (parent !== undefined && parent.planId === plan.id) {
        this.#settleCompleted(plan, parent, this.#plans.listSteps(plan.id));
      }
      return { status: "done" };
    }
    if (plan.status !== "active") {
      return { status: "done" };
    }
    const parent = this.#tasks.get(plan.parentTaskId);
    if (parent === undefined) {
      this.#plans.setPlanStatus(plan.id, ["active"], "cancelled", this.#now().toISOString());
      return { status: "done" };
    }
    if (
      parent.status === "cancelling" ||
      parent.status === "cancelled" ||
      parent.status === "failed" ||
      parent.status === "succeeded" ||
      parent.status === "needs_review"
    ) {
      // A direct task cancel/revision terminal state stops the plan and its
      // children; settlement also clears the binding so a cancelling parent
      // can finish through onActionSettled.
      this.#plans.setPlanStatus(
        plan.id,
        ["active", "paused"],
        "cancelled",
        this.#now().toISOString(),
      );
      this.#settleCancelled(plan);
      return { status: "done" };
    }
    // A revision or supplement after activation invalidates the stored plan
    // scope; do not keep dispatching children from stale authority.
    if (
      parent.revision !== plan.taskRevision ||
      this.#plans.maxInputSeq(parent.id) > plan.inputSeq
    ) {
      this.#settleNeedsReview(
        plan,
        parent,
        "plan is stale relative to the parent task revision or input",
      );
      return { status: "done" };
    }

    let steps = this.#plans.listSteps(plan.id);
    const now = this.#now().toISOString();

    // Repair a crash between recording a terminal step outcome and settling
    // the plan/parent.
    for (const step of steps) {
      if (step.status === "needs_review") {
        this.#settleNeedsReview(
          plan,
          parent,
          `step ${step.key} needs review: ${step.lastError ?? "no verifier evidence"}`,
        );
        return { status: "done" };
      }
      if (step.status === "failed") {
        if (step.attempts < step.maxAttempts) {
          this.#plans.resetStepForRetry(
            plan.id,
            step.key,
            step.lastError ?? "step failed",
            now,
          );
          continue;
        }
        this.#settleFailed(
          plan,
          parent,
          `step ${step.key} failed after ${step.attempts} attempt(s)`,
        );
        return { status: "done" };
      }
    }
    steps = this.#plans.listSteps(plan.id);

    for (const step of steps) {
      if (step.status !== "running" || step.taskId === undefined) {
        continue;
      }
      const child = this.#tasks.get(step.taskId);
      if (child === undefined) {
        this.#settleNeedsReview(plan, parent, `step ${step.key} lost its child task`);
        return { status: "done" };
      }
      if (child.status === "succeeded") {
        this.#plans.setStepOutcome(
          plan.id,
          step.key,
          "completed",
          evidenceRefsOf(child),
          undefined,
          now,
        );
        this.#audit(plan, step, "plan.step_completed", {
          taskId: child.id,
          verifier: child.verification?.verifier,
        });
        continue;
      }
      if (child.status === "needs_review") {
        this.#plans.setStepOutcome(
          plan.id,
          step.key,
          "needs_review",
          evidenceRefsOf(child),
          child.lastError ?? "step needs review",
          now,
        );
        this.#settleNeedsReview(
          plan,
          parent,
          `step ${step.key} needs review: ${child.lastError ?? "no verifier evidence"}`,
        );
        return { status: "done" };
      }
      if (child.status === "cancelled" || child.status === "cancelling") {
        this.#plans.setStepOutcome(plan.id, step.key, "cancelled", [], "step cancelled", now);
        this.#settleNeedsReview(plan, parent, `step ${step.key} was cancelled`);
        return { status: "done" };
      }
      if (child.status === "failed") {
        if (step.attempts < step.maxAttempts) {
          // A crash between the child's failure and this retry is repaired
          // by the failed-step pass at the top of the next tick.
          this.#plans.resetStepForRetry(
            plan.id,
            step.key,
            child.lastError ?? "step failed",
            now,
          );
          this.#audit(plan, step, "plan.step_retry", {
            taskId: child.id,
            attempt: step.attempts,
            maxAttempts: step.maxAttempts,
          });
          steps = this.#plans.listSteps(plan.id);
          continue;
        }
        this.#plans.setStepOutcome(
          plan.id,
          step.key,
          "failed",
          evidenceRefsOf(child),
          child.lastError ?? "step failed",
          now,
        );
        this.#settleFailed(
          plan,
          parent,
          `step ${step.key} failed after ${step.attempts} attempt(s)`,
        );
        return { status: "done" };
      }
    }

    steps = this.#plans.listSteps(plan.id);
    const completed = new Set(
      steps.filter((step) => step.status === "completed").map((step) => step.key),
    );

    // Dependencies are program-checked; a failed or cancelled dependency
    // never becomes ready.
    for (const step of steps) {
      if (step.status !== "blocked") {
        continue;
      }
      if (step.dependsOn.every((dependency) => completed.has(dependency))) {
        this.#plans.setStepsStatus(plan.id, [step.key], "ready", now);
      }
    }
    steps = this.#plans.listSteps(plan.id);

    const finalKey = steps.at(-1)?.key;
    for (const step of steps) {
      if (step.status !== "ready") {
        continue;
      }
      if (step.attempts >= step.maxAttempts) {
        this.#plans.setStepOutcome(plan.id, step.key, "failed", [], "attempt limit", now);
        this.#settleFailed(plan, parent, `step ${step.key} exhausted its attempts`);
        return { status: "done" };
      }
      const isFinal = step.key === finalKey;
      const criteria = this.#criteriaFor(plan, parent, step, isFinal);
      const goal = isFinal
        ? `${step.goal}\n\nVerified prior steps:\n${this.#priorStepSummary(plan.id)}`
        : step.goal;
      const child = this.#taskService.create({
        ownerId: plan.ownerId,
        conversationId: parent.conversationId,
        sourceKey: `plan:${plan.id}:step:${step.key}:attempt:${step.attempts + 1}`,
        goal,
        completionCriteria: criteria,
        // The final step must be able to satisfy the parent verifier, so it
        // runs with the parent's full (already authorized) mandate. Other
        // steps stay inside their declared subset.
        mandate: isFinal
          ? {
              resources: parent.mandate.resources,
              tools: parent.mandate.tools,
              ...(parent.mandate.skills === undefined
                ? {}
                : { skills: parent.mandate.skills }),
              ...(plan.projectKey === undefined ? {} : { project: plan.projectKey }),
            }
          : {
              resources: step.resources,
              tools: step.tools,
              ...(parent.mandate.skills === undefined
                ? {}
                : { skills: parent.mandate.skills }),
              ...(plan.projectKey === undefined ? {} : { project: plan.projectKey }),
            },
        extensionPolicy: parent.extension?.policy,
        planId: plan.id,
        planStepKey: step.key,
        budgetKey: `plan:${plan.parentTaskId}`,
      });
      const bound = this.#plans.bindStepTask(plan.id, step.key, child.id, now);
      if (bound === undefined) {
        // Another tick won the race; the extra child has no plan authority.
        this.#tasks.updateTask(child.id, child.revision, {
          status: "cancelled",
          lastError: "plan step was already dispatched",
          updatedAt: now,
        });
        continue;
      }
      this.#audit(plan, bound, "plan.step_dispatched", { taskId: child.id });
      steps = this.#plans.listSteps(plan.id);
    }

    if (steps.length > 0 && steps.every((step) => step.status === "completed")) {
      this.#settleCompleted(plan, parent, steps);
      return { status: "done" };
    }

    return {
      status: "retry",
      at: new Date(this.#now().getTime() + this.#tickDelayMs).toISOString(),
      reason: "plan steps still running",
      maxAttempts: 100_000,
    };
  }

  #criteriaFor(
    plan: PlanRecord,
    parent: TaskRecord,
    step: PlanStepRecord,
    isFinal: boolean,
  ): string {
    // The final step must prove the parent's own completion criteria; this is
    // the only path to a succeeded plan.
    if (isFinal) {
      return parent.completionCriteria;
    }
    if (step.completionCriteria.trim().length > 0) {
      return step.completionCriteria;
    }
    switch (step.verifierId) {
      case "state-read":
        return JSON.stringify({
          verifier: "state-read",
          requiredEvidenceKinds: ["state_snapshot"],
        });
      case "github-read":
      case "project-review": {
        const project = this.#project(plan);
        const normalized = normalizeGithubCriteria(
          "",
          step.goal,
          step.goal,
          step.tools,
          parent.mandate.skills ?? [],
          project,
        );
        // Without a resolvable repo the normalizer returns plain text; keep
        // the declared verifier explicit so it cannot fall back to structural.
        return normalized.trim().startsWith("{")
          ? normalized
          : JSON.stringify({ verifier: step.verifierId });
      }
      case "structural":
      case "text-review":
      case "action-receipt":
        return JSON.stringify({ verifier: step.verifierId });
      default:
        return JSON.stringify({ verifier: step.verifierId });
    }
  }

  #priorStepSummary(planId: string): string {
    const steps = this.#plans.listSteps(planId);
    const lines: string[] = [];
    for (const step of steps) {
      if (step.status !== "completed" || step.taskId === undefined) {
        continue;
      }
      const child = this.#tasks.get(step.taskId);
      lines.push(
        `- ${step.key}: ${child?.resultRef ?? step.goal}` +
          (step.evidenceRefs.length === 0 ? "" : ` (evidence: ${step.evidenceRefs.join(", ")})`),
      );
    }
    return lines.length === 0 ? "- none" : lines.join("\n");
  }

  #project(plan: PlanRecord): ProjectBinding | undefined {
    if (plan.projectKey === undefined || this.#projects === undefined) {
      return undefined;
    }
    return this.#projects.findActiveByKey(plan.ownerId, plan.projectKey);
  }

  #settleCompleted(
    plan: PlanRecord,
    parent: TaskRecord,
    steps: PlanStepRecord[],
  ): void {
    const now = this.#now().toISOString();
    const final = steps.at(-1);
    const child = final?.taskId === undefined ? undefined : this.#tasks.get(final.taskId);
    if (final === undefined || child === undefined || child.status !== "succeeded") {
      this.#settleNeedsReview(plan, parent, "final step has no verified receipt");
      return;
    }
    // The plan status and the parent result are one durable outcome.
    this.#store.db.transaction(() => {
      this.#plans.setPlanStatus(plan.id, ["active", "completed"], "completed", now);
      this.#taskService.finishExternalAction(parent.id, {
        status: "succeeded",
        summary: child.resultRef ?? `plan completed (${steps.length} steps)`,
        verification:
          child.verification ??
          planVerification("succeeded", "final step completed", now),
        resultRef: child.resultRef,
      });
      this.#audit(plan, final, "plan.completed", { stepCount: steps.length });
    });
  }

  #settleNeedsReview(plan: PlanRecord, parent: TaskRecord, reason: string): void {
    const now = this.#now().toISOString();
    // Child cancellation uses its own transaction; do it before the
    // plan/parent outcome transaction to avoid nested BEGIN.
    this.#cancelSiblings(plan, now);
    this.#store.db.transaction(() => {
      this.#plans.setPlanStatus(plan.id, ["active", "paused", "completed"], "paused", now);
      if (!isTerminal(parent.status)) {
        this.#taskService.finishExternalAction(parent.id, {
          status: "needs_review",
          summary: reason,
          verification: planVerification("needs_review", reason, now),
        });
      }
      this.#store.recordAudit({
        event: "plan.needs_review",
        subjectType: "plan",
        subjectId: plan.id,
        after: { reason },
        traceId: `plan:${plan.id}`,
        occurredAt: now,
      });
    });
  }

  #settleFailed(plan: PlanRecord, parent: TaskRecord, reason: string): void {
    const now = this.#now().toISOString();
    this.#cancelSiblings(plan, now);
    this.#store.db.transaction(() => {
      this.#plans.setPlanStatus(plan.id, ["active", "paused", "completed"], "paused", now);
      if (!isTerminal(parent.status)) {
        this.#taskService.finishExternalAction(parent.id, {
          status: "failed",
          summary: reason,
          verification: planVerification("failed", reason, now),
        });
      }
      this.#store.recordAudit({
        event: "plan.failed",
        subjectType: "plan",
        subjectId: plan.id,
        after: { reason },
        traceId: `plan:${plan.id}`,
        occurredAt: now,
      });
    });
  }

  #settleCancelled(plan: PlanRecord): void {
    const parent = this.#tasks.get(plan.parentTaskId);
    const ownsParent = parent !== undefined && parent.planId === plan.id;
    const now = this.#now().toISOString();
    // Always stop this plan's own children, even when a newer version has
    // already taken over the parent task.
    for (const step of this.#plans.listSteps(plan.id)) {
      if (
        step.status === "blocked" ||
        step.status === "ready" ||
        step.status === "running"
      ) {
        this.#plans.setStepOutcome(
          plan.id,
          step.key,
          "cancelled",
          step.evidenceRefs,
          "plan cancelled",
          now,
        );
      }
      if (step.taskId !== undefined) {
        const child = this.#tasks.get(step.taskId);
        if (child !== undefined && !isTerminal(child.status)) {
          this.#taskService.cancel(child.id);
        }
      }
    }
    if (!ownsParent || parent === undefined) {
      return;
    }
    // The parent is a plan parent, so it has no assignment of its own; the
    // task cancellation path still clears actions/effects if any appeared.
    if (parent.status !== "cancelling" && !isTerminal(parent.status)) {
      this.#taskService.cancel(parent.id);
    }
    this.#tasks.clearPlanBinding(parent.id, now);
  }

  /** Pause/cancel every not-yet-finished sibling before settling the plan. */
  #cancelSiblings(plan: PlanRecord, now: string): void {
    for (const step of this.#plans.listSteps(plan.id)) {
      if (step.status !== "running" && step.status !== "ready") {
        continue;
      }
      if (step.taskId !== undefined) {
        const child = this.#tasks.get(step.taskId);
        if (child !== undefined && !isTerminal(child.status)) {
          this.#taskService.cancel(child.id);
        }
      }
      this.#plans.setStepOutcome(
        plan.id,
        step.key,
        "cancelled",
        step.evidenceRefs,
        "plan paused",
        now,
      );
    }
  }

  #audit(
    plan: PlanRecord,
    step: PlanStepRecord,
    event: string,
    after: Record<string, unknown>,
  ): void {
    this.#store.recordAudit({
      event,
      subjectType: "plan",
      subjectId: plan.id,
      after: { step: step.key, planVersion: plan.planVersion, ...after },
      traceId: `plan:${plan.id}`,
      occurredAt: this.#now().toISOString(),
    });
  }
}

function isTerminal(status: TaskRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function evidenceRefsOf(task: TaskRecord): string[] {
  const refs = task.verification?.evidenceRefs ?? [];
  return refs.length > 0 ? refs : [`task:${task.id}`];
}

function planVerification(
  verdict: "succeeded" | "failed" | "needs_review",
  reason: string,
  at: string,
): TaskVerification {
  return {
    verifier: "plan",
    verifierVersion: "1",
    verdict,
    reason,
    checked: ["plan_steps"],
    missing: [reason],
    evidenceRefs: [],
    externalFactsVerified: false,
    verifiedAt: at,
  };
}
