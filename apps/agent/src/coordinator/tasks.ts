import type {
  ActionRecord,
  AssignmentRecord,
  Evidence,
  ProposedAction,
  TaskInputRecord,
  MemoryRecord,
  TaskRecord,
  WorkerReport,
} from "../domain/types.ts";
import type { ActionRepository } from "../storage/actions.ts";
import type { EffectRepository } from "../storage/effects.ts";
import {
  isTerminal,
  type AddedTaskInput,
  type TaskRepository,
} from "../storage/tasks.ts";
import type { MemoryRepository } from "../storage/personal.ts";
import type { Store } from "../storage/store.ts";
import type { EffectDispatcher, EffectOutcome } from "../delivery/effects.ts";
import type { BudgetService } from "../observability/magpie.ts";
import type { AgentRuntime, WakeScheduler } from "../runtime/types.ts";
import { TaskCompletionVerifier } from "./completion.ts";

export interface ActionProposer {
  proposeForReport(
    task: TaskRecord,
    assignment: AssignmentRecord,
    proposed: ProposedAction[],
  ): { count: number; autoApprove: string[] };
  finalizeReportedActions?(actionIds: readonly string[]): void;
}

export interface TaskServiceDeps {
  store: Store;
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  runtime: AgentRuntime;
  wake: WakeScheduler;
  now?: () => Date;
  maxActiveWorkers?: number;
  assignmentLeaseMs?: number;
  /** A live Worker heartbeat may hold a slot for at most this long. */
  assignmentMaxLifetimeMs?: number;
  maxTaskAttempts?: number;
  budget?: BudgetService;
  completionVerifier?: TaskCompletionVerifier;
  memories?: MemoryRepository;
}

export interface CreateTaskInput {
  ownerId: string;
  conversationId: string;
  sourceKey: string;
  goal: string;
  completionCriteria: string;
  mandate?: {
    resources: string[];
    tools: string[];
    notes?: string;
    project?: string;
  };
  priority?: number;
  deadline?: string;
  schedulePolicyId?: string;
}

const DEFAULT_MANDATE = {
  resources: ["chat"],
  tools: [],
};

/** One poll slice; a model wait must not hold the shared effect drain. */
export const ASSIGNMENT_WAIT_SLICE_MS = 100;
const WAIT_BACKOFF_BASE_MS = 250;
const WAIT_BACKOFF_MAX_MS = 5_000;

/**
 * Owns Task and Assignment state transitions. Worker reports are accepted
 * only when their assignment is still active and the fencing token and task
 * revision match; a stale Worker cannot advance the task.
 */
export class TaskService {
  readonly #store: Store;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #effects: EffectRepository;
  readonly #runtime: AgentRuntime;
  readonly #wake: WakeScheduler;
  readonly #now: () => Date;
  readonly #maxActiveWorkers: number;
  readonly #leaseMs: number;
  readonly #maxAssignmentLifetimeMs: number;
  readonly #maxTaskAttempts: number;
  readonly #budget?: BudgetService;
  readonly #completion: TaskCompletionVerifier;
  readonly #memories?: MemoryRepository;
  #proposer: ActionProposer | undefined;

  constructor(deps: TaskServiceDeps) {
    this.#store = deps.store;
    this.#tasks = deps.tasks;
    this.#actions = deps.actions;
    this.#effects = deps.effects;
    this.#runtime = deps.runtime;
    this.#wake = deps.wake;
    this.#now = deps.now ?? (() => new Date());
    this.#maxActiveWorkers = deps.maxActiveWorkers ?? 2;
    this.#leaseMs = deps.assignmentLeaseMs ?? 120_000;
    this.#maxAssignmentLifetimeMs =
      deps.assignmentMaxLifetimeMs ?? 10 * 60_000;
    this.#maxTaskAttempts = deps.maxTaskAttempts ?? 3;
    this.#budget = deps.budget;
    this.#completion =
      deps.completionVerifier ??
      new TaskCompletionVerifier({ actions: deps.actions, now: this.#now });
    this.#memories = deps.memories;
  }

  setActionProposer(proposer: ActionProposer): void {
    this.#proposer = proposer;
  }

  install(dispatcher: EffectDispatcher): void {
    dispatcher.register("task.dispatch", (effect) => this.handleDispatch(effect.payload));
    dispatcher.register("assignment.wait", (effect) =>
      this.handleWait(effect.payload, effect.attempts),
    );
    dispatcher.register("task.interrupt", (effect) => this.handleInterrupt(effect.payload));
  }

  create(input: CreateTaskInput): TaskRecord {
    const now = this.#now().toISOString();
    const { inserted, task } = this.#tasks.insert({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sourceKey: input.sourceKey,
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      mandate: input.mandate ?? DEFAULT_MANDATE,
      priority: input.priority,
      deadline: input.deadline,
      schedulePolicyId: input.schedulePolicyId,
      createdAt: now,
    });

    if (inserted) {
      this.#store.recordAudit({
        event: "task.created",
        subjectType: "task",
        subjectId: task.id,
        after: { goal: task.goal, revision: task.revision },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      this.#enqueueDispatch(task, now);
    } else if (task.status === "queued") {
      // A crash can land between the task INSERT and the dispatch enqueue.
      // Replaying the same decision must repair the missing effect; the
      // business key keeps this idempotent when the effect already exists.
      this.#enqueueDispatch(task, now);
    }

    return task;
  }

  revise(
    taskId: string,
    changes: {
      goal?: string;
      completionCriteria?: string;
      mandate?: TaskRecord["mandate"];
      priority?: number;
    },
  ): TaskRecord | undefined {
    const now = this.#now().toISOString();
    const activeSessions = this.#tasks
      .listActiveAssignments(taskId)
      .map((assignment) => assignment.sessionId)
      .filter((sessionId) => sessionId.length > 0);
    const task = this.#tasks.revise(taskId, changes, now);
    if (task === undefined) {
      return undefined;
    }

    this.#auditSuperseded(this.#actions.supersedeForTask(taskId, now), "task_revised", now);
    this.#cancelTaskEffects(taskId, now);
    this.#store.cancelOutboxForTask(taskId, now);
    if (activeSessions.length > 0) {
      // The old Worker session has no authority over the new revision; stop
      // it instead of leaving it running until it reports and is fenced out.
      this.#effects.enqueue({
        kind: "task.interrupt",
        businessKey: `task:${taskId}:interrupt:revise:${task.revision}`,
        payload: {
          taskId,
          sessionIds: activeSessions,
          finalize: false,
        },
        nextAttemptAt: now,
        createdAt: now,
      });
    }
    const inFlight = this.#actions.listInFlight(taskId);
    if (inFlight.length > 0) {
      this.#tasks.updateTask(taskId, task.revision, {
        status: "waiting_external",
        updatedAt: now,
      });
      this.#reply(
        task,
        "status",
        `任务已修改为第 ${task.revision} 版；在途动作核对后继续。`,
        `revised:${task.revision}`,
      );
    } else {
      this.#enqueueDispatch(task, now);
      this.#reply(
        task,
        "status",
        `任务已修改，正在按第 ${task.revision} 版重新派工。`,
        `revised:${task.revision}`,
      );
    }
    this.#store.recordAudit({
      event: "task.revised",
      subjectType: "task",
      subjectId: taskId,
      after: { revision: task.revision, goal: task.goal, inFlight: inFlight.length },
      traceId: `task:${taskId}`,
      occurredAt: now,
    });
    void this.#wake.wake();
    return this.#tasks.get(taskId);
  }

  /**
   * Record an immutable owner input. A queued or waiting_user task is
   * dispatched again immediately; a running or waiting_external task keeps
   * its current work, and its report is rejected by the input barrier until a
   * new assignment covers the input.
   */
  supplement(
    taskId: string,
    text: string,
    sourceInboxId?: string,
  ): AddedTaskInput | undefined {
    const now = this.#now().toISOString();
    const before = this.#tasks.get(taskId);
    if (before === undefined || isTerminal(before.status)) {
      return undefined;
    }

    const added = this.#tasks.addInput({
      taskId,
      text,
      sourceInboxId,
      actorId: before.ownerId,
      createdAt: now,
    });
    if (added === undefined) {
      return undefined;
    }
    if (!added.inserted) {
      // The same platform message was already accepted; do not append a
      // second input or reply. A crash can still leave the task queued
      // without its dispatch effect, so the idempotent enqueue is repeated.
      if (added.task.status === "queued") {
        this.#enqueueDispatch(added.task, now);
        void this.#wake.wake();
      }
      return added;
    }

    this.#store.recordAudit({
      event: "task.supplemented",
      subjectType: "task",
      subjectId: taskId,
      after: {
        status: added.task.status,
        revision: added.task.revision,
        inputSeq: added.input.seq,
      },
      traceId: `task:${taskId}`,
      occurredAt: now,
    });

    if (before.status === "waiting_user" || before.status === "queued") {
      this.#enqueueDispatch(added.task, now);
    }
    void this.#wake.wake();
    return added;
  }

  cancel(taskId: string): TaskRecord | undefined {
    const existing = this.#tasks.get(taskId);
    if (existing === undefined) {
      return undefined;
    }
    // A terminal task must not emit further effects, replies, or interrupts.
    if (isTerminal(existing.status)) {
      return existing;
    }

    const now = this.#now().toISOString();
    const active = this.#tasks.listActiveAssignments(taskId);
    const sessionIds = active
      .map((item) => item.sessionId)
      .filter((sessionId) => sessionId.length > 0);
    const task = this.#tasks.beginCancel(taskId, now);
    if (task === undefined) {
      return undefined;
    }

    this.#auditSuperseded(this.#actions.supersedeForTask(taskId, now), "task_cancelled", now);
    this.#cancelTaskEffects(taskId, now);
    this.#store.cancelOutboxForTask(taskId, now);
    this.#store.recordAudit({
      event: "task.cancel_requested",
      subjectType: "task",
      subjectId: taskId,
      after: { status: task.status, sessions: sessionIds },
      traceId: `task:${taskId}`,
      occurredAt: now,
    });

    if (sessionIds.length > 0) {
      this.#effects.enqueue({
        kind: "task.interrupt",
        businessKey: `task:${taskId}:interrupt:${task.revision}`,
        payload: { taskId, sessionIds },
        nextAttemptAt: now,
        createdAt: now,
      });
    }

    const inFlight = this.#actions.listInFlight(taskId);
    if (inFlight.length === 0 && sessionIds.length === 0) {
      this.#tasks.markCancelled(taskId, now);
      this.#reply(task, "status", "任务已取消。", `cancelled:${task.revision}`);
    } else {
      this.#reply(
        task,
        "status",
        "已停止后续执行，正在核对在途动作。",
        `cancelling:${task.revision}`,
      );
    }

    void this.#wake.wake();
    return this.#tasks.get(taskId);
  }

  /** Programmatic sweep for leases and stale dispatch. */
  sweep(): void {
    const nowDate = this.#now();
    const now = nowDate.toISOString();

    for (const assignment of this.#tasks.listExpiredAssignments(now)) {
      this.#tasks.markAssignmentExpired(assignment.id, now);
      this.#store.recordAudit({
        event: "assignment.lease_expired",
        subjectType: "assignment",
        subjectId: assignment.id,
        after: { taskId: assignment.taskId, fencingToken: assignment.fencingToken },
        traceId: `assignment:${assignment.id}`,
        occurredAt: now,
      });

      const task = this.#tasks.get(assignment.taskId);
      if (task === undefined || isTerminal(task.status)) {
        continue;
      }
      // An expired lease that already reached the attempt limit must stop the
      // task; requeueing it again would redispatch forever. Each accepted
      // owner input grants one additional work round, so a long task that is
      // supplemented is not failed as if the supplements were retries.
      if (task.attempts >= this.#maxTaskAttempts + this.#tasks.countInputs(task.id)) {
        const failed = this.#tasks.updateTask(task.id, task.revision, {
          status: "failed",
          lastError: `assignment lease expired after ${task.attempts} attempt(s)`,
          updatedAt: now,
        });
        if (failed !== undefined) {
          this.#reply(
            task,
            "failure",
            `任务失败：Worker 连续 ${task.attempts} 次未在租约内完成。`,
            `failed:${assignment.id}`,
          );
        }
        continue;
      }

      this.#tasks.requeueExpiredTask(task.id, now);
      const requeued = this.#tasks.get(task.id);
      if (requeued !== undefined) {
        this.#enqueueDispatch(requeued, now);
      }
    }
  }

  onActionSettled(taskId: string): void {
    const now = this.#now().toISOString();
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      return;
    }

    if (task.status === "cancelling") {
      this.#finalizeCancellation(taskId, now);
      return;
    }

    if (task.status === "waiting_external" && this.#actions.listInFlight(taskId).length === 0) {
      this.#tasks.updateTask(taskId, task.revision, {
        status: "queued",
        updatedAt: now,
      });
      const queued = this.#tasks.get(taskId);
      if (queued !== undefined) {
        this.#enqueueDispatch(queued, now);
        void this.#wake.wake();
      }
    }
  }

  async handleDispatch(payload: Record<string, unknown>): Promise<EffectOutcome> {
    const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
    const now = this.#now();
    if (taskId !== undefined) {
      const task = this.#tasks.get(taskId);
      if (task === undefined) {
        return { status: "done" };
      }
      if (task.status === "running") {
        // A dispatch effect that arrives after the Worker session opened must
        // still attach the wait effect; otherwise a real session is stranded.
        return this.#acceptLateDispatch(task, now);
      }
      if (task.status !== "queued") {
        return { status: "done" };
      }
      if (this.#isPastDeadline(task, now)) {
        return this.#failForDeadline(task, now);
      }
      const budget = await this.#budget?.check();
      if (budget !== undefined && !budget.ok) {
        this.#reply(
          task,
          "status",
          `订阅额度不足，任务已暂停：${budget.reason ?? "未知原因"}。额度恢复后会自动继续。`,
          `budget-paused:${task.id}`,
        );
        return {
          status: "retry",
          at: new Date(now.getTime() + 60_000).toISOString(),
          reason: `subscription budget: ${budget.reason ?? "unavailable"}`,
          maxAttempts: 30 * 24 * 60,
        };
      }
    }

    const claimed = this.#tasks.claimNext(
      now.toISOString(),
      this.#leaseMs,
      this.#maxActiveWorkers,
      taskId,
    );
    if (claimed === undefined) {
      return {
        status: "retry",
        at: new Date(now.getTime() + 1_000).toISOString(),
        reason: "no worker capacity or no queued task",
        maxAttempts: 1_000,
      };
    }

    const attemptLimit =
      this.#maxTaskAttempts + this.#tasks.countInputs(claimed.task.id);
    if (claimed.task.attempts > attemptLimit) {
      const at = this.#now().toISOString();
      this.#tasks.markAssignmentExpired(claimed.assignment.id, at);
      const failed = this.#tasks.updateTask(claimed.task.id, claimed.task.revision, {
        status: "failed",
        lastError: `task exceeded the ${attemptLimit}-attempt limit`,
        updatedAt: at,
      });
      if (failed !== undefined) {
        this.#reply(
          claimed.task,
          "failure",
          "任务多次未完成，已停止。",
          `failed:${claimed.assignment.id}`,
        );
      }
      return { status: "done" };
    }
    if (this.#isPastDeadline(claimed.task, now)) {
      this.#tasks.markAssignmentExpired(
        claimed.assignment.id,
        this.#now().toISOString(),
      );
      return this.#failForDeadline(claimed.task, now);
    }

    try {
      const opened = await this.#runtime.open({
        role: "worker",
        brief: workerBrief(claimed.task),
      });
      // Cancellation may land between the claim and the session opening.
      // Do not submit work for a task that is no longer allowed to run.
      const current = this.#tasks.get(claimed.task.id);
      if (
        current === undefined ||
        current.status === "cancelling" ||
        current.status === "cancelled"
      ) {
        await this.#runtime.interrupt(opened.id);
        return { status: "done" };
      }
      this.#tasks.setAssignmentSession(claimed.assignment.id, opened.id, now.toISOString());
      const operationId = `assignment:${claimed.assignment.id}`;
      const inputs = this.#tasks.listInputs(
        claimed.task.id,
        claimed.assignment.dispatchedInputSeq,
      );
      await this.#runtime.submit(
        opened.id,
        workerPrompt(
          claimed.task,
          inputs,
          this.#actions
            .listByTask(claimed.task.id)
            .filter((action) => action.taskRevision === claimed.task.revision),
          this.#memories?.listApplicable(
            claimed.task.ownerId,
            claimed.task.mandate.project,
          ) ?? [],
        ),
        operationId,
        "app.task",
      );
      this.#effects.enqueue({
        kind: "assignment.wait",
        businessKey: `assignment:${claimed.assignment.id}:wait`,
        payload: {
          assignmentId: claimed.assignment.id,
          sessionId: opened.id,
          operationId,
        },
        nextAttemptAt: now.toISOString(),
        createdAt: now.toISOString(),
      });
      void this.#wake.wake();
      return { status: "done" };
    } catch (error) {
      const at = this.#now().toISOString();
      this.#tasks.markAssignmentExpired(claimed.assignment.id, at);
      this.#tasks.requeueExpiredTask(claimed.task.id, at);
      return {
        status: "retry",
        at: new Date(this.#now().getTime() + 2_000).toISOString(),
        reason: `runtime dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        maxAttempts: 1_000,
      };
    }
  }

  async handleWait(
    payload: Record<string, unknown>,
    attempts = 1,
  ): Promise<EffectOutcome> {
    const assignmentId =
      typeof payload.assignmentId === "string" ? payload.assignmentId : undefined;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    const operationId =
      typeof payload.operationId === "string" ? payload.operationId : undefined;
    if (assignmentId === undefined || sessionId === undefined || operationId === undefined) {
      return { status: "failed", reason: "assignment.wait payload is incomplete" };
    }

    const assignment = this.#tasks.getAssignment(assignmentId);
    if (assignment === undefined || assignment.status !== "active") {
      return { status: "done" };
    }

    let answer;
    try {
      // Poll one short slice. The submission stays durable, so the next
      // effect retry re-attaches without submitting the work again.
      answer = await this.#runtime.wait(
        sessionId,
        operationId,
        ASSIGNMENT_WAIT_SLICE_MS,
      );
    } catch (error) {
      return {
        status: "retry",
        at: new Date(this.#now().getTime() + 5_000).toISOString(),
        reason: `runtime wait failed: ${error instanceof Error ? error.message : String(error)}`,
        maxAttempts: 1_000,
      };
    }

    if (answer.status === "pending") {
      const nowDate = this.#now();
      const createdAt = Date.parse(assignment.createdAt);
      if (
        Number.isNaN(createdAt) ||
        nowDate.getTime() - createdAt >= this.#maxAssignmentLifetimeMs
      ) {
        return this.#failAssignment(
          assignment,
          `assignment exceeded the ${this.#maxAssignmentLifetimeMs}ms lifetime`,
        );
      }
      // The Worker is demonstrably alive (its wait is still pending), so
      // extend the lease instead of freeing the slot while it runs.
      this.#tasks.extendAssignmentLease(
        assignment.id,
        new Date(nowDate.getTime() + this.#leaseMs).toISOString(),
        nowDate.toISOString(),
      );
      const delay = Math.min(
        WAIT_BACKOFF_MAX_MS,
        WAIT_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 5),
      );
      return {
        status: "retry",
        at: new Date(nowDate.getTime() + delay).toISOString(),
        reason: "runtime still pending",
        maxAttempts: 1_000,
      };
    }

    if (answer.status === "unanswered") {
      return this.#failAssignment(assignment, `runtime ended unanswered: ${answer.reason}`);
    }

    const report = parseWorkerReport(answer.text);
    if (report === undefined) {
      return this.#failAssignment(assignment, "worker report was not valid JSON");
    }

    return this.report(assignment.id, assignment.fencingToken, assignment.taskRevision, report);
  }

  async handleInterrupt(payload: Record<string, unknown>): Promise<EffectOutcome> {
    const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
    const sessionIds = Array.isArray(payload.sessionIds)
      ? payload.sessionIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    if (taskId === undefined) {
      return { status: "failed", reason: "task.interrupt payload is incomplete" };
    }

    for (const sessionId of sessionIds) {
      try {
        await this.#runtime.interrupt(sessionId);
      } catch (error) {
        return {
          status: "retry",
          at: new Date(this.#now().getTime() + 5_000).toISOString(),
          reason: `runtime interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
          maxAttempts: 1_000,
        };
      }
    }

    if (payload.finalize !== false) {
      this.#finalizeCancellation(taskId, this.#now().toISOString());
    }
    return { status: "done" };
  }

  report(
    assignmentId: string,
    fencingToken: number,
    taskRevision: number,
    report: WorkerReport,
  ): EffectOutcome {
    const now = this.#now().toISOString();
    const reported = this.#tasks.markReported(
      assignmentId,
      fencingToken,
      taskRevision,
      report,
      now,
    );
    // A retry after the report commit finds the assignment already reported.
    // Reprocessing is safe: task updates are revision-guarded, outbox keys are
    // stable, and proposed actions have a stable source key.
    const assignment = reported ?? this.#tasks.getAssignment(assignmentId);
    if (assignment === undefined || assignment.status !== "reported") {
      // Stale report: the assignment was superseded, cancelled, or fenced out.
      return { status: "done" };
    }

    const task = this.#tasks.get(assignment.taskId);
    if (task === undefined || task.revision !== assignment.taskRevision) {
      // The task was revised after this assignment reported; it has no
      // authority over the new revision.
      return { status: "done" };
    }
    if (task.attempts !== assignment.attempt || task.status === "cancelling") {
      // A newer attempt owns the task, or cancellation is already in flight.
      // A replayed report from an older assignment must not requeue, revive,
      // or otherwise advance it.
      return { status: "done" };
    }
    if (reported === undefined && task.status !== "running") {
      // A replayed report may only persist actions while the task is still
      // running (the crash window between markReported and the proposal
      // transaction). If the post-commit auto-approval itself was lost, retry
      // it here; finalized actions are no longer proposed, so this is safe.
      const unfinalized = this.#actions
        .listByTask(task.id)
        .filter(
          (action) =>
            action.status === "proposed" && action.preauthorizationId !== undefined,
        )
        .map((action) => action.id);
      if (unfinalized.length > 0) {
        this.#proposer?.finalizeReportedActions?.(unfinalized);
      }
      return { status: "done" };
    }

    const pendingInputs = this.#tasks.listInputsAfter(
      task.id,
      assignment.dispatchedInputSeq,
    );
    if (pendingInputs.length === 0) {
      this.#tasks.markAssignmentConsumed(
        assignment.id,
        assignment.dispatchedInputSeq,
        now,
      );
    } else {
      // The Worker never saw these inputs. No report status, including
      // `failed`, can stand in for input it never read: a failure produced
      // without the input is itself stale. Requeue and let a new assignment
      // cover the latest seq; that assignment's report is unbarred, so a
      // persistent failure still terminates after one extra round per input.
      //
      // A report effect may replay after the barrier already redispatched, or
      // after the task moved on for another reason. Never steal a task that
      // already has an active Worker, an in-flight action, or a terminal
      // outcome: a second dispatch would collide with the active assignment.
      if (
        isTerminal(task.status) ||
        this.#tasks.listActiveAssignments(task.id).length > 0 ||
        (task.status === "waiting_external" &&
          this.#actions.listInFlight(task.id).length > 0)
      ) {
        return { status: "done" };
      }
      if (task.status !== "queued") {
        this.#tasks.updateTask(task.id, task.revision, {
          status: "queued",
          updatedAt: now,
        });
        this.#store.recordAudit({
          event: "assignment.input_barrier",
          subjectType: "assignment",
          subjectId: assignment.id,
          after: {
            taskId: task.id,
            reportStatus: report.status,
            dispatchedInputSeq: assignment.dispatchedInputSeq,
            pendingInputSeq: pendingInputs.at(-1)?.seq ?? 0,
          },
          traceId: `assignment:${assignment.id}`,
          occurredAt: now,
        });
        this.#reply(
          task,
          "status",
          `收到新的补充输入，任务已重新排队并按最新输入执行。`,
          `input-pending:${assignment.id}`,
        );
      }
      this.#enqueueDispatch(task, now);
      void this.#wake.wake();
      return { status: "done" };
    }

    this.#store.recordAudit({
      event: "assignment.reported",
      subjectType: "assignment",
      subjectId: assignment.id,
      after: { status: report.status, taskId: task.id, revision: task.revision },
      traceId: `assignment:${assignment.id}`,
      occurredAt: now,
    });

    const proposed = report.proposedActions ?? [];
    if (proposed.length > 0) {
      // Persist the actions and the task transition atomically so a crash
      // cannot leave approved work without a waiting task (or vice versa).
      const result = this.#store.db.transaction(() => {
        const persisted = this.#proposer?.proposeForReport(task, assignment, proposed) ?? {
          count: 0,
          autoApprove: [],
        };
        const updated = this.#tasks.updateTask(task.id, task.revision, {
          status: persisted.count > 0 ? "waiting_external" : "failed",
          resultRef: persisted.count > 0 ? report.summary : undefined,
          lastError: persisted.count > 0 ? undefined : "worker proposed no valid action",
          updatedAt: now,
        });
        return { persisted: persisted.count, autoApprove: persisted.autoApprove, updated };
      });
      if (result.updated === undefined) {
        return { status: "done" };
      }
      if (result.autoApprove.length > 0) {
        // Approving inside the report transaction would nest BEGIN; finalize
        // only after the task transition has committed.
        this.#proposer?.finalizeReportedActions?.(result.autoApprove);
      }
      if (result.persisted > 0) {
        const remainingApprovals = result.persisted - result.autoApprove.length;
        this.#reply(
          task,
          remainingApprovals > 0 ? "clarify" : "status",
          remainingApprovals > 0
            ? `任务需要主人批准 ${remainingApprovals} 个动作后继续。`
            : `任务已按只读预授权执行 ${result.autoApprove.length} 个动作，等待结果。`,
          remainingApprovals > 0
            ? `approval-needed:${assignment.id}`
            : `preauthorized:${assignment.id}`,
        );
        void this.#wake.wake();
      } else {
        this.#reply(task, "failure", "任务失败：Worker 提出的动作无效。", `failed:${assignment.id}`);
      }
      return { status: "done" };
    }

    switch (report.status) {
      case "ready": {
        const completion = this.#completion.verify(task, report);
        if (completion.verdict === "failed") {
          const updated = this.#tasks.updateTask(task.id, task.revision, {
            status: "failed",
            lastError: completion.verification.reason,
            verification: completion.verification,
            updatedAt: now,
          });
          if (updated === undefined) {
            return { status: "done" };
          }
          this.#reply(
            task,
            "failure",
            `任务未通过完成条件：${completion.verification.reason}`,
            `failed:${assignment.id}`,
          );
          return { status: "done" };
        }
        if (completion.verdict === "needs_review") {
          const updated = this.#tasks.updateTask(task.id, task.revision, {
            status: "needs_review",
            resultRef: report.summary,
            lastError: completion.verification.reason,
            verification: completion.verification,
            updatedAt: now,
          });
          if (updated === undefined) {
            return { status: "done" };
          }
          this.#store.recordAudit({
            event: "task.needs_review",
            subjectType: "task",
            subjectId: task.id,
            after: {
              verifier: completion.verification.verifier,
              verifierVersion: completion.verification.verifierVersion,
              reason: completion.verification.reason,
              missing: completion.verification.missing,
              evidenceRefs: completion.verification.evidenceRefs,
            },
            traceId: `task:${task.id}`,
            occurredAt: now,
          });
          this.#reply(
            task,
            "status",
            [
              `任务完成后无法用可核对证据确认，已进入待人工核对（${completion.verification.verifier}）：${completion.verification.reason}`,
              `确认完成：/ack ${task.id} [备注]`,
            ].join("\n"),
            `needs-review:${assignment.id}`,
          );
          return { status: "done" };
        }
        const updated = this.#tasks.updateTask(task.id, task.revision, {
          status: "succeeded",
          resultRef: report.summary,
          lastError: undefined,
          verification: completion.verification,
          updatedAt: now,
        });
        if (updated === undefined) {
          return { status: "done" };
        }
        this.#reply(task, "result", `任务完成：${report.summary}`, `result:${assignment.id}`);
        return { status: "done" };
      }
      case "waiting_user": {
        const updated = this.#tasks.updateTask(task.id, task.revision, {
          status: "waiting_user",
          resultRef: report.summary,
          updatedAt: now,
        });
        if (updated === undefined) {
          return { status: "done" };
        }
        const questions = report.questions?.length
          ? report.questions.join("\n")
          : report.summary;
        this.#reply(task, "clarify", `需要主人决定：\n${questions}`, `clarify:${assignment.id}`);
        return { status: "done" };
      }
      case "waiting_external": {
        // Without an in-flight action nothing can settle later, so keeping the
        // task waiting would strand it forever.
        if (this.#actions.listInFlight(task.id).length > 0) {
          this.#tasks.updateTask(task.id, task.revision, {
            status: "waiting_external",
            resultRef: report.summary,
            updatedAt: now,
          });
          return { status: "done" };
        }
        const updated = this.#tasks.updateTask(task.id, task.revision, {
          status: "failed",
          lastError: "worker reported waiting_external with no in-flight action",
          updatedAt: now,
        });
        if (updated === undefined) {
          return { status: "done" };
        }
        this.#reply(
          task,
          "failure",
          "任务失败：Worker 报告等待外部动作，但没有在途动作。",
          `failed:${assignment.id}`,
        );
        return { status: "done" };
      }
      case "failed": {
        const updated = this.#tasks.updateTask(task.id, task.revision, {
          status: "failed",
          lastError: report.summary,
          updatedAt: now,
        });
        if (updated === undefined) {
          return { status: "done" };
        }
        this.#reply(task, "failure", `任务失败：${report.summary}`, `failed:${assignment.id}`);
        return { status: "done" };
      }
      case "working": {
        if (
          task.attempts >=
          this.#maxTaskAttempts + this.#tasks.countInputs(task.id)
        ) {
          this.#tasks.updateTask(task.id, task.revision, {
            status: "failed",
            lastError: "worker reported working after the attempt limit",
            updatedAt: now,
          });
          this.#reply(task, "failure", "任务多次未完成，已停止。", `failed:${assignment.id}`);
          return { status: "done" };
        }
        this.#tasks.updateTask(task.id, task.revision, {
          status: "queued",
          resultRef: report.summary,
          updatedAt: now,
        });
        const queued = this.#tasks.get(task.id);
        if (queued !== undefined) {
          this.#enqueueDispatch(queued, now);
          void this.#wake.wake();
        }
        return { status: "done" };
      }
    }
  }

  acknowledge(
    taskId: string,
    ownerId: string,
    note: string | undefined,
  ): { ok: boolean; reason?: string; task?: TaskRecord } {
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.ownerId !== ownerId) {
      return { ok: false, reason: "找不到属于你的该任务。" };
    }
    if (task.status !== "needs_review") {
      return {
        ok: false,
        reason: `任务当前状态为 ${task.status}，只有 needs_review 可以 /ack。`,
      };
    }
    const now = this.#now().toISOString();
    const updated = this.#tasks.acknowledge(taskId, ownerId, now);
    if (updated === undefined) {
      return { ok: false, reason: "任务状态已变化，请重新查看。" };
    }
    const superseded = this.#actions.supersedeForTask(taskId, now);
    this.#store.recordAudit({
      event: "task.acknowledged",
      subjectType: "task",
      subjectId: taskId,
      after: {
        verifier: task.verification?.verifier,
        verifierVersion: task.verification?.verifierVersion,
        note: note ?? "",
        supersededActions: superseded.length,
      },
      traceId: `task:${taskId}`,
      occurredAt: now,
    });
    this.#reply(
      updated,
      "result",
      `已确认任务完成：${updated.resultRef ?? updated.goal}`,
      "acknowledged",
    );
    return { ok: true, task: updated };
  }

  #failAssignment(assignment: AssignmentRecord, reason: string): EffectOutcome {
    return this.report(assignment.id, assignment.fencingToken, assignment.taskRevision, {
      status: "failed",
      summary: reason,
      evidence: [],
    });
  }

  #isPastDeadline(task: TaskRecord, now: Date): boolean {
    if (task.deadline === undefined) {
      return false;
    }
    const deadline = new Date(task.deadline).getTime();
    return Number.isFinite(deadline) && now.getTime() > deadline;
  }

  #failForDeadline(task: TaskRecord, now: Date): EffectOutcome {
    const updated = this.#tasks.updateTask(task.id, task.revision, {
      status: "failed",
      lastError: `task deadline ${task.deadline ?? ""} passed`,
      updatedAt: now.toISOString(),
    });
    if (updated === undefined) {
      return { status: "done" };
    }
    this.#reply(task, "failure", "任务已超过截止时间，未继续执行。", `deadline:${task.id}`);
    return { status: "done" };
  }

  /**
   * A dispatch effect can arrive after the Worker session already opened (for
   * example when the effect was delayed). Adopt the running assignment and make
   * sure exactly one wait effect will collect its report.
   */
  #acceptLateDispatch(task: TaskRecord, now: Date): EffectOutcome {
    const assignment = this.#tasks
      .listActiveAssignments(task.id)
      .find((item) => item.sessionId.length > 0);
    if (assignment === undefined) {
      return { status: "done" };
    }

    const operationId = `assignment:${assignment.id}`;
    const businessKey = `assignment:${assignment.id}:wait`;
    const existing = this.#effects.getByBusinessKey(businessKey);
    const hasPendingWait =
      (existing !== undefined &&
        (existing.status === "pending" || existing.status === "running")) ||
      this.#effects
        .listPending()
        .some(
          (effect) =>
            effect.kind === "assignment.wait" &&
            effect.payload.assignmentId === assignment.id,
        );
    if (hasPendingWait) {
      return { status: "done" };
    }

    this.#effects.enqueue({
      kind: "assignment.wait",
      businessKey,
      payload: {
        assignmentId: assignment.id,
        sessionId: assignment.sessionId,
        operationId,
      },
      nextAttemptAt: now.toISOString(),
      createdAt: now.toISOString(),
    });
    void this.#wake.wake();
    return { status: "done" };
  }

  #finalizeCancellation(taskId: string, now: string): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.status !== "cancelling") {
      return;
    }
    if (this.#actions.listInFlight(taskId).length > 0) {
      return;
    }
    this.#tasks.markCancelled(taskId, now);
    this.#reply(task, "status", "任务已取消，在途动作已核对。", `cancelled:${task.revision}`);
  }

  #enqueueDispatch(task: TaskRecord, now: string): void {
    this.#effects.enqueue({
      kind: "task.dispatch",
      businessKey: `task:${task.id}:dispatch:r${task.revision}:a${task.attempts + 1}`,
      payload: { taskId: task.id },
      nextAttemptAt: now,
      createdAt: now,
    });
  }

  #cancelTaskEffects(taskId: string, now: string): void {
    for (const effect of this.#effects.listPending()) {
      if (effect.payload.taskId === taskId) {
        this.#effects.cancel(effect.id, now);
      }
    }
  }

  #auditSuperseded(
    actions: readonly ActionRecord[],
    reason: string,
    now: string,
  ): void {
    for (const action of actions) {
      this.#store.recordAudit({
        event: "action.superseded",
        subjectType: "action",
        subjectId: action.id,
        after: { tool: action.tool, reason },
        traceId: `action:${action.id}`,
        occurredAt: now,
      });
    }
  }

  #reply(task: TaskRecord, purpose: "status" | "clarify" | "result" | "failure", text: string, suffix: string): void {
    const conversation = this.#store.getConversation(task.conversationId);
    if (conversation === undefined) {
      return;
    }
    const now = this.#now().toISOString();
    this.#store.enqueueOutbox({
      businessKey: `task:${task.id}:${suffix}`,
      ownerId: task.ownerId,
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.platformConversationId,
      taskId: task.id,
      purpose,
      text,
      createdAt: now,
      traceId: `task:${task.id}`,
    });
  }
}

function workerBrief(task: TaskRecord): string {
  return `Worker for task ${task.id}: ${task.goal}`;
}

function workerPrompt(
  task: TaskRecord,
  inputs: readonly TaskInputRecord[],
  priorActions: { tool: string; status: string; args: Record<string, unknown>; evidence?: Record<string, unknown> }[],
  memories: readonly MemoryRecord[],
): string {
  const lines = [
    "You are a task Worker with a separate context. Work only inside the Mandate.",
    "Do not claim that an external write happened. Propose writes as actions.",
    "Return one JSON object only, with this shape:",
    '{"status":"ready|working|waiting_user|waiting_external|failed",',
    ' "summary":"...", "evidence":[{"kind":"...","value":"..."}],',
    ' "questions":["..."],',
    ' "proposedActions":[{"tool":"lamp.set_brightness","args":{"brightness":80}}]}',
    `Task id: ${task.id}`,
    `Goal: ${task.goal}`,
    `Completion criteria: ${task.completionCriteria}`,
    `Mandate: ${JSON.stringify(task.mandate)}`,
  ];
  if (inputs.length > 0) {
    lines.push(
      `Owner input (authoritative, ${inputs.length} item(s); a ready report must address all of them):`,
    );
    for (const input of inputs) {
      lines.push(`#${input.seq} ${input.createdAt}: ${input.text}`);
    }
  }
  if (memories.length > 0) {
    lines.push(
      "Owner memories applicable to this task (facts, not tool permissions):",
    );
    for (const memory of memories.slice(0, 20)) {
      lines.push(
        `- ${memory.project === undefined ? "[global] " : `[project ${memory.project}] `}` +
          `${memory.key} = ${memory.value.slice(0, 1_000)}`,
      );
    }
  }
  if (task.resultRef !== undefined && task.resultRef.length > 0) {
    lines.push(`Previous worker summary: ${task.resultRef}`);
  }
  if (priorActions.length > 0) {
    lines.push("Previous action results (use these instead of proposing the same action again):");
    for (const action of priorActions) {
      lines.push(
        `- ${action.tool} ${action.status} args=${JSON.stringify(action.args)} evidence=${JSON.stringify(action.evidence ?? {})}`,
      );
    }
  }
  return lines.join("\n");
}

export function parseWorkerReport(text: string): WorkerReport | undefined {
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
  const status = record.status;
  if (
    status !== "working" &&
    status !== "waiting_user" &&
    status !== "waiting_external" &&
    status !== "ready" &&
    status !== "failed"
  ) {
    return undefined;
  }
  if (typeof record.summary !== "string") {
    return undefined;
  }
  if (!Array.isArray(record.evidence)) {
    return undefined;
  }

  const evidence: Evidence[] = [];
  for (const item of record.evidence) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const kind = (item as Record<string, unknown>).kind;
    const itemValue = (item as Record<string, unknown>).value;
    if (typeof kind === "string" && typeof itemValue === "string") {
      evidence.push({ kind, value: itemValue });
    }
  }

  const questions = Array.isArray(record.questions)
    ? record.questions.filter((item): item is string => typeof item === "string")
    : undefined;

  const proposedActions: ProposedAction[] = [];
  if (Array.isArray(record.proposedActions)) {
    for (const item of record.proposedActions) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const tool = (item as Record<string, unknown>).tool;
      const args = (item as Record<string, unknown>).args;
      if (typeof tool === "string" && typeof args === "object" && args !== null) {
        proposedActions.push({
          tool,
          args: args as Record<string, unknown>,
        });
      }
    }
  }

  return {
    status,
    summary: record.summary,
    evidence,
    questions,
    proposedActions: proposedActions.length > 0 ? proposedActions : undefined,
    cost:
      typeof record.cost === "object" && record.cost !== null
        ? (record.cost as Record<string, unknown>)
        : undefined,
    completionReason:
      typeof record.completionReason === "string" ? record.completionReason : undefined,
    evidenceRef:
      typeof record.evidenceRef === "string" ? record.evidenceRef : undefined,
    verifierVersion:
      typeof record.verifierVersion === "string" ? record.verifierVersion : undefined,
    unverifiedClaims: Array.isArray(record.unverifiedClaims)
      ? record.unverifiedClaims.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
  };
}


export { evaluateCompletion } from "./completion.ts";
