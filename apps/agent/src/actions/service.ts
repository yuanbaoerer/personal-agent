import { randomUUID } from "node:crypto";

import type {
  ActionRecord,
  AssignmentRecord,
  ProposedAction,
  TaskRecord,
} from "../domain/types.ts";
import type { EffectDispatcher, EffectOutcome } from "../delivery/effects.ts";
import type { EffectRepository } from "../storage/effects.ts";
import type { ActionRepository } from "../storage/actions.ts";
import type { Store } from "../storage/store.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { WakeScheduler } from "../runtime/types.ts";
import {
  ToolRejectedError,
  ToolUnknownError,
  hashArgs,
  type ActionTool,
  type ToolRegistry,
} from "./tools.ts";

export interface ActionServiceDeps {
  store: Store;
  actions: ActionRepository;
  effects: EffectRepository;
  tools: ToolRegistry;
  wake: WakeScheduler;
  now?: () => Date;
  actionTtlMs?: number;
  executionLeaseMs?: number;
  maxExecutionAttempts?: number;
  /** Bounds concurrent external writes from a single agent instance. */
  maxConcurrentTools?: number;
  tasks?: TaskRepository;
  onSettled?: (taskId: string) => void;
}

export interface ApprovalInput {
  actionId: string;
  nonce: string;
  approverId: string;
  conversationId: string;
  /** When provided, binds the decision to the exact canonical arguments. */
  expectedArgsHash?: string;
  /** When provided, binds the decision to the exact task revision. */
  expectedTaskRevision?: number;
}

/**
 * Approval is a one-time, parameter-bound decision. The model never receives
 * the approval credential; only the explicit owner command carries the nonce.
 */
export class ActionService {
  readonly #store: Store;
  readonly #actions: ActionRepository;
  readonly #effects: EffectRepository;
  readonly #tools: ToolRegistry;
  readonly #wake: WakeScheduler;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #maxConcurrentTools: number;
  readonly #tasks?: TaskRepository;
  readonly #onSettled: (taskId: string) => void;
  #activeTools = 0;
  readonly #toolWaiters: (() => void)[] = [];

  constructor(deps: ActionServiceDeps) {
    this.#store = deps.store;
    this.#actions = deps.actions;
    this.#effects = deps.effects;
    this.#tools = deps.tools;
    this.#wake = deps.wake;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.actionTtlMs ?? 10 * 60_000;
    this.#leaseMs = deps.executionLeaseMs ?? 30_000;
    this.#maxAttempts = deps.maxExecutionAttempts ?? 3;
    this.#maxConcurrentTools = Math.max(1, deps.maxConcurrentTools ?? 2);
    this.#tasks = deps.tasks;
    this.#onSettled = deps.onSettled ?? (() => {});
  }

  install(dispatcher: EffectDispatcher): void {
    dispatcher.register("action.execute", (effect) => this.handleExecute(effect.payload));
    dispatcher.register("action.reconcile", (effect) =>
      this.handleReconcile(effect.payload, effect.attempts),
    );
  }

  /** Returns the number of valid proposed actions that were persisted. */
  proposeForReport(
    task: TaskRecord,
    assignment: AssignmentRecord,
    proposed: ProposedAction[],
  ): number {
    let count = 0;
    for (const item of proposed) {
      const canonical = this.#canonicalProposal(task, item);
      if (canonical === undefined) {
        continue;
      }
      // A stable hash of the canonical tool call dedupes a retried report even
      // when the Worker reorders its proposals. Assignment scope keeps two
      // tasks (and two revisions) from sharing an action row.
      const sourceKey = `${assignment.id}:proposal:${hashArgs(canonical.tool.name, canonical.args)}`;
      this.#insertProposal(task, assignment, canonical.tool, canonical.args, sourceKey);
      count += 1;
    }
    return count;
  }

  propose(
    task: TaskRecord,
    assignment: AssignmentRecord,
    proposed: ProposedAction,
    sourceKey?: string,
  ): ActionRecord | undefined {
    const canonical = this.#canonicalProposal(task, proposed);
    if (canonical === undefined) {
      return undefined;
    }
    return this.#insertProposal(task, assignment, canonical.tool, canonical.args, sourceKey);
  }

  #canonicalProposal(
    task: TaskRecord,
    proposed: ProposedAction,
  ): { tool: ActionTool; args: Record<string, unknown> } | undefined {
    const now = this.#now().toISOString();
    const tool = this.#tools.get(proposed.tool);
    if (tool === undefined) {
      this.#store.recordAudit({
        event: "action.proposal_rejected",
        subjectType: "task",
        subjectId: task.id,
        after: { reason: "unknown_tool", tool: proposed.tool },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      return undefined;
    }
    if (!task.mandate.tools.includes(tool.name)) {
      this.#store.recordAudit({
        event: "action.proposal_rejected",
        subjectType: "task",
        subjectId: task.id,
        after: { reason: "tool_outside_mandate", tool: tool.name },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      return undefined;
    }

    try {
      return { tool, args: tool.canonicalize(proposed.args) };
    } catch (error) {
      this.#store.recordAudit({
        event: "action.proposal_rejected",
        subjectType: "task",
        subjectId: task.id,
        after: {
          reason: error instanceof Error ? error.message : String(error),
          tool: proposed.tool,
        },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      return undefined;
    }
  }

  #insertProposal(
    task: TaskRecord,
    assignment: AssignmentRecord,
    tool: ActionTool,
    args: Record<string, unknown>,
    sourceKey: string | undefined,
  ): ActionRecord {
    const now = this.#now().toISOString();
    const action = this.#actions.insert({
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      taskId: task.id,
      taskRevision: task.revision,
      fencingToken: assignment.fencingToken,
      tool: tool.name,
      args,
      argsHash: hashArgs(tool.name, args),
      expiresAt: new Date(this.#now().getTime() + this.#ttlMs).toISOString(),
      nonce: randomUUID(),
      sourceKey,
      createdAt: now,
    });

    this.#store.recordAudit({
      event: "action.proposed",
      subjectType: "action",
      subjectId: action.id,
      after: { tool: action.tool, args: action.args, taskId: task.id },
      traceId: `action:${action.id}`,
      occurredAt: now,
    });

    this.#reply(
      action,
      "approval",
      [
        `需要批准动作 ${action.id}`,
        `工具：${action.tool}`,
        `参数：${JSON.stringify(action.args)}`,
        `有效期至：${action.expiresAt}`,
        `批准：/approve ${action.id} ${action.nonce} ${action.argsHash} ${action.taskRevision}`,
        `拒绝：/deny ${action.id} ${action.nonce} ${action.argsHash} ${action.taskRevision}`,
      ].join("\n"),
      "approval",
    );
    return action;
  }

  approve(input: ApprovalInput): { ok: boolean; reason?: string; action?: ActionRecord } {
    const action = this.#actions.get(input.actionId);
    if (action === undefined) {
      return { ok: false, reason: "action_not_found" };
    }

    const now = this.#now().toISOString();
    const unauthorized = this.#executionGuard(action);
    if (unauthorized !== undefined) {
      // A task that ended, was cancelled, or was revised cannot receive a new
      // execution grant just because an old approval prompt is still open.
      this.#actions.supersede(action.id, unauthorized, now);
      this.#store.recordAudit({
        event: "action.approval_rejected",
        subjectType: "action",
        subjectId: action.id,
        after: { reason: unauthorized, taskId: action.taskId },
        traceId: `action:${action.id}`,
        occurredAt: now,
      });
      this.#reply(
        action,
        "failure",
        `无法批准：${unauthorized}`,
        `approval_failed:${unauthorized}`,
      );
      this.#onSettled(action.taskId);
      return { ok: false, reason: unauthorized };
    }
    const result = this.#actions.approve(
      action.id,
      {
        approverId: input.approverId,
        conversationId: input.conversationId,
        argsHash: input.expectedArgsHash ?? action.argsHash,
        taskRevision: input.expectedTaskRevision ?? action.taskRevision,
        nonce: input.nonce,
        now,
      },
      () => {
        // The approval and its execution effect commit together; a failure
        // here rolls the approval back instead of leaving an orphan.
        this.#effects.enqueue({
          kind: "action.execute",
          businessKey: `action:${action.id}:execute`,
          payload: { actionId: action.id },
          nextAttemptAt: now,
          createdAt: now,
        });
      },
    );
    if (!result.ok) {
      this.#reply(action, "failure", `无法批准：${result.reason}`, `approval_failed:${result.reason}`);
      return { ok: false, reason: result.reason };
    }

    this.#store.recordAudit({
      event: "action.approved",
      subjectType: "action",
      subjectId: action.id,
      after: { approverId: input.approverId },
      traceId: `action:${action.id}`,
      occurredAt: now,
    });
    void this.#wake.wake();
    return { ok: true, action: result.action };
  }

  deny(input: ApprovalInput): { ok: boolean; reason?: string } {
    const action = this.#actions.get(input.actionId);
    if (action === undefined) {
      return { ok: false, reason: "action_not_found" };
    }

    const result = this.#actions.deny(action.id, {
      approverId: input.approverId,
      conversationId: input.conversationId,
      argsHash: action.argsHash,
      taskRevision: action.taskRevision,
      nonce: input.nonce,
      now: this.#now().toISOString(),
    });
    if (!result.ok) {
      this.#reply(action, "failure", `无法拒绝：${result.reason}`, `denial_failed:${result.reason}`);
      return { ok: false, reason: result.reason };
    }

    this.#store.recordAudit({
      event: "action.denied",
      subjectType: "action",
      subjectId: action.id,
      after: { approverId: input.approverId },
      traceId: `action:${action.id}`,
      occurredAt: this.#now().toISOString(),
    });
    this.#onSettled(action.taskId);
    void this.#wake.wake();
    return { ok: true };
  }

  async handleExecute(payload: Record<string, unknown>): Promise<EffectOutcome> {
    const actionId = typeof payload.actionId === "string" ? payload.actionId : undefined;
    if (actionId === undefined) {
      return { status: "failed", reason: "action.execute payload is incomplete" };
    }

    const claim = this.#actions.claimForExecution(
      actionId,
      this.#now().toISOString(),
      this.#leaseMs,
      (claimed) => this.#executionGuard(claimed),
    );
    if (!claim.ok) {
      if (claim.revoked) {
        // The approval existed, but the task no longer authorizes this write
        // or the execution window has closed.
        this.#store.recordAudit({
          event: "action.execution_rejected",
          subjectType: "action",
          subjectId: actionId,
          after: { reason: claim.reason, action: claim.action },
          traceId: `action:${actionId}`,
          occurredAt: this.#now().toISOString(),
        });
        if (claim.action !== undefined) {
          this.#reply(
            claim.action,
            "failure",
            claim.reason === "action_expired"
              ? "动作审批已过期，未执行。"
              : "该动作已不再被授权，未执行。",
            claim.reason === "action_expired" ? "expired" : "superseded",
          );
          this.#onSettled(claim.action.taskId);
        }
      } else if (claim.action?.status === "expired") {
        // Replayed claim after a crash: the action is already expired, so
        // only finish its task settlement; never re-audit or re-notify.
        this.#onSettled(claim.action.taskId);
      }
      return { status: "done" };
    }
    const action = claim.action;

    const tool = this.#tools.get(action.tool);
    if (tool === undefined) {
      this.#actions.markFailed(action.id, `unknown tool ${action.tool}`, this.#now().toISOString());
      this.#reply(action, "failure", "动作失败：未知工具。", "failed");
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    try {
      const result = await this.#runTool(tool, action.args);
      this.#actions.markSucceeded(
        action.id,
        result.evidence,
        result.externalRef,
        this.#now().toISOString(),
      );
      this.#reply(action, "result", `动作已完成：${JSON.stringify(result.evidence)}`, "succeeded");
      this.#onSettled(action.taskId);
      return { status: "done" };
    } catch (error) {
      const at = this.#now().toISOString();
      if (error instanceof ToolRejectedError) {
        this.#actions.markFailed(action.id, error.message, at);
        this.#reply(action, "failure", `动作失败：${error.message}`, "failed");
        this.#onSettled(action.taskId);
        return { status: "done" };
      }

      const reason =
        error instanceof ToolUnknownError
          ? error.message
          : `unexpected tool error: ${error instanceof Error ? error.message : String(error)}`;
      this.#actions.markUnknown(action.id, reason, at);
      this.#reply(
        action,
        "status",
        "动作结果未知，正在核对；不会盲目重复执行。",
        "unknown",
      );
      this.#enqueueReconcile(action, at);
      void this.#wake.wake();
      return { status: "done" };
    }
  }

  async handleReconcile(
    payload: Record<string, unknown>,
    effectAttempts: number,
  ): Promise<EffectOutcome> {
    const actionId = typeof payload.actionId === "string" ? payload.actionId : undefined;
    if (actionId === undefined) {
      return { status: "failed", reason: "action.reconcile payload is incomplete" };
    }

    const action = this.#actions.get(actionId);
    if (action === undefined || (action.status !== "unknown" && action.status !== "reconciling")) {
      return { status: "done" };
    }

    const tool = this.#tools.get(action.tool);
    if (tool === undefined) {
      this.#actions.markNeedsManual(action.id, `unknown tool ${action.tool}`, this.#now().toISOString());
      this.#reply(action, "failure", "动作需要人工核对：工具不存在。", "needs_manual");
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    this.#actions.markReconciling(action.id, this.#now().toISOString());
    let verification;
    try {
      verification = await tool.verify(action.args);
    } catch (error) {
      if (effectAttempts >= this.#maxAttempts) {
        this.#actions.markNeedsManual(
          action.id,
          `reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
          this.#now().toISOString(),
        );
        this.#reply(action, "failure", "动作需要人工核对。", "needs_manual");
        this.#onSettled(action.taskId);
        return { status: "done" };
      }
      return {
        status: "retry",
        at: new Date(this.#now().getTime() + 5_000).toISOString(),
        reason: `reconcile verify failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (verification.satisfied) {
      this.#actions.markSucceeded(
        action.id,
        { ...verification.evidence, reconciled: true },
        undefined,
        this.#now().toISOString(),
      );
      this.#reply(
        action,
        "result",
        `动作已核对为完成：${JSON.stringify(verification.evidence)}`,
        "reconciled",
      );
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    if (action.executionAttempts >= this.#maxAttempts || effectAttempts >= this.#maxAttempts) {
      this.#actions.markNeedsManual(
        action.id,
        "external state does not match and retry budget is exhausted",
        this.#now().toISOString(),
      );
      this.#reply(
        action,
        "failure",
        "动作结果无法判定，需要人工核对。",
        "needs_manual",
      );
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    // A cancelled or revised task revokes the action's authority even though
    // the external write may still be in doubt. Never execute on its behalf.
    if (this.#executionGuard(action) !== undefined) {
      const at = this.#now().toISOString();
      if (!this.#actions.markSuperseded(action.id, "action is no longer authorized", at)) {
        this.#actions.markNeedsManual(action.id, "action is no longer authorized", at);
      }
      this.#reply(
        action,
        "failure",
        "该动作已不再被授权，未执行。",
        "superseded",
      );
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    // An absolute set is idempotent: the mock has no delayed write that could
    // land after this retry, so re-applying the same target is safe.
    try {
      const result = await this.#runTool(tool, action.args);
      this.#actions.markSucceeded(
        action.id,
        { ...result.evidence, retried: true },
        result.externalRef,
        this.#now().toISOString(),
      );
      this.#reply(
        action,
        "result",
        `动作已重试并完成：${JSON.stringify(result.evidence)}`,
        "retried",
      );
      this.#onSettled(action.taskId);
      return { status: "done" };
    } catch (error) {
      const at = this.#now().toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      if (effectAttempts >= this.#maxAttempts) {
        this.#actions.markNeedsManual(
          action.id,
          `reconcile retry failed: ${reason}`,
          at,
        );
        this.#reply(
          action,
          "failure",
          "动作重试后仍无法确认结果，需要人工核对。",
          "needs_manual",
        );
        this.#onSettled(action.taskId);
        return { status: "done" };
      }
      this.#actions.markUnknown(action.id, reason, at);
      // Retry this same effect so its attempt counter is the bound; enqueuing a
      // fresh reconcile would reset the count and loop forever.
      return {
        status: "retry",
        at: new Date(this.#now().getTime() + 5_000).toISOString(),
        reason: `reconcile retry failed: ${reason}`,
      };
    }
  }

  sweep(): void {
    const now = this.#now().toISOString();

    for (const action of this.#actions.listExpiredProposed(now)) {
      if (this.#actions.expireProposed(action.id, now)) {
        this.#reply(action, "failure", "动作审批已过期。", "expired");
        this.#onSettled(action.taskId);
      }
    }

    for (const action of this.#actions.listExpiredExecuting(now)) {
      if (this.#actions.markExecutingExpired(action.id, now, "execution lease expired")) {
        this.#reply(action, "status", "动作执行中断，正在核对。", "unknown");
        this.#enqueueReconcile(action, now);
      }
    }

    for (const action of this.#actions.listUnknown()) {
      this.#enqueueReconcile(action, now);
    }
  }

  #enqueueReconcile(action: ActionRecord, now: string): void {
    if (this.#hasPendingReconcile(action.id)) {
      return;
    }
    const refreshed = this.#actions.get(action.id) ?? action;
    this.#effects.enqueue({
      kind: "action.reconcile",
      businessKey: `action:${action.id}:reconcile:${refreshed.executionAttempts}:${refreshed.updatedAt}`,
      payload: { actionId: action.id },
      nextAttemptAt: now,
      createdAt: now,
    });
  }

  #hasPendingReconcile(actionId: string): boolean {
    return this.#effects
      .listPending(200)
      .some(
        (effect) =>
          effect.kind === "action.reconcile" && effect.payload.actionId === actionId,
      );
  }

  /**
   * Re-read the task at every authorization boundary. Revision, ownership and
   * mandate are cheap to check and stop an approved action from outliving the
   * task state it was approved for.
   */
  #executionGuard(action: ActionRecord): string | undefined {
    if (this.#tasks === undefined) {
      return undefined;
    }
    const task = this.#tasks.get(action.taskId);
    if (task === undefined) {
      return "task_not_found";
    }
    if (task.ownerId !== action.ownerId) {
      return "task_owner_mismatch";
    }
    if (task.conversationId !== action.conversationId) {
      return "task_conversation_mismatch";
    }
    if (task.revision !== action.taskRevision) {
      return "task_revision_mismatch";
    }
    if (
      task.status === "cancelled" ||
      task.status === "cancelling" ||
      task.status === "failed" ||
      task.status === "succeeded"
    ) {
      return "task_not_executable";
    }
    if (!task.mandate.tools.includes(action.tool)) {
      return "tool_outside_mandate";
    }
    return undefined;
  }

  async #runTool(tool: ActionTool, args: Record<string, unknown>) {
    await this.#acquireToolSlot();
    try {
      return await tool.execute(args);
    } finally {
      this.#releaseToolSlot();
    }
  }

  #acquireToolSlot(): Promise<void> {
    if (this.#activeTools < this.#maxConcurrentTools) {
      this.#activeTools += 1;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#toolWaiters.push(() => resolve());
    return promise;
  }

  #releaseToolSlot(): void {
    const next = this.#toolWaiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the next waiter without decrementing.
      next();
      return;
    }
    this.#activeTools -= 1;
  }

  #reply(
    action: ActionRecord,
    purpose: "approval" | "status" | "result" | "failure",
    text: string,
    suffix: string,
  ): void {
    const conversation = this.#store.getConversation(action.conversationId);
    if (conversation === undefined) {
      return;
    }
    const now = this.#now().toISOString();
    this.#store.enqueueOutbox({
      businessKey: `action:${action.id}:${suffix}`,
      ownerId: action.ownerId,
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.platformConversationId,
      taskId: action.taskId,
      purpose,
      text,
      createdAt: now,
    });
  }
}
