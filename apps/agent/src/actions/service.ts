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
import type { PreauthorizationService } from "../personal/preauthorizations.ts";
import type { SchedulePolicyService } from "../personal/schedule-policies.ts";
import {
  ToolRejectedError,
  ToolTimeoutError,
  ToolUnknownError,
  hashArgs,
  type ActionTool,
  type ToolExecutionContext,
  type ToolRegistry,
} from "./tools.ts";
import { STATE_RESOURCE, isStateToolName } from "./state.ts";

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
  preauthorizations?: PreauthorizationService;
  schedulePolicies?: SchedulePolicyService;
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
  readonly #preauthorizations?: PreauthorizationService;
  readonly #schedulePolicies?: SchedulePolicyService;
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
    this.#preauthorizations = deps.preauthorizations;
    this.#schedulePolicies = deps.schedulePolicies;
    this.#onSettled = deps.onSettled ?? (() => {});
  }

  install(dispatcher: EffectDispatcher): void {
    dispatcher.register("action.execute", (effect) => this.handleExecute(effect.payload));
    dispatcher.register("action.reconcile", (effect) =>
      this.handleReconcile(effect.payload, effect.attempts),
    );
  }

  proposeForReport(
    task: TaskRecord,
    assignment: AssignmentRecord,
    proposed: ProposedAction[],
  ): { count: number; autoApprove: string[] } {
    let count = 0;
    const autoApprove: string[] = [];
    for (const item of proposed) {
      const canonical = this.#canonicalProposal(task, item);
      if (canonical === undefined) {
        continue;
      }
      // A stable hash of the canonical tool call dedupes a retried report even
      // when the Worker reorders its proposals. Assignment scope keeps two
      // tasks (and two revisions) from sharing an action row.
      const sourceKey = `${assignment.id}:proposal:${hashArgs(canonical.tool.name, canonical.args)}`;
      const inserted = this.#insertProposal(
        task,
        assignment,
        canonical.tool,
        canonical.args,
        sourceKey,
        true,
      );
      if (inserted?.created) {
        count += 1;
        if (inserted.autoApprove) {
          autoApprove.push(inserted.action.id);
        }
      }
    }
    return { count, autoApprove };
  }

  /**
   * Called after the report transaction commits. Approving inside the report
   * transaction would nest BEGIN statements, so auto-approved reads are
   * finalized here; failures fall back to a normal approval card.
   */
  finalizeReportedActions(actionIds: readonly string[]): void {
    for (const id of actionIds) {
      const action = this.#actions.get(id);
      if (action === undefined || action.status !== "proposed") {
        continue;
      }
      if (this.#autoApproveReadOnly(action)) {
        continue;
      }
      const revokedReason = this.#readAuthorizationRevoked(action);
      if (revokedReason !== undefined) {
        this.#actions.supersede(action.id, revokedReason, this.#now().toISOString());
        this.#auditAction(action, "action.superseded", { reason: revokedReason });
        this.#reply(action, "failure", "只读授权已撤销、过期或计划已变更，未执行。", "superseded");
        this.#onSettled(action.taskId);
        continue;
      }
      this.#sendApprovalCard(action);
    }
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
    return this.#insertProposal(
      task,
      assignment,
      canonical.tool,
      canonical.args,
      sourceKey,
      false,
    )?.action;
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

    if (
      tool.resource !== undefined &&
      !task.mandate.resources.includes(tool.resource)
    ) {
      this.#store.recordAudit({
        event: "action.proposal_rejected",
        subjectType: "task",
        subjectId: task.id,
        after: {
          reason: "resource_outside_mandate",
          tool: tool.name,
          resource: tool.resource,
        },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      return undefined;
    }

    try {
      return {
        tool,
        args: tool.canonicalize(proposed.args, executionContext(task)),
      };
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
    deferAutoApprove: boolean,
  ):
    | { action: ActionRecord; autoApprove: boolean; created: boolean }
    | undefined {
    const now = this.#now().toISOString();
    const authorization = this.#findReadAuthorization(task, tool, args);
    const internalStateRead = this.#isInternalStateRead(task, tool);
    if (
      task.schedulePolicyId !== undefined &&
      authorization?.schedulePolicyId === undefined
    ) {
      // A task created by a plan is bound to that plan's exact repo and
      // version. If its provenance no longer matches, do not insert an
      // approval-card fallback: an owner click must not widen the confirmed
      // scope, and an unstamped action would skip the execution-time check.
      this.#store.recordAudit({
        event: "action.proposal_rejected",
        subjectType: "task",
        subjectId: task.id,
        after: {
          tool: tool.name,
          args,
          schedulePolicyId: task.schedulePolicyId,
          reason: "schedule_scope_violation",
        },
        traceId: `task:${task.id}`,
        occurredAt: now,
      });
      return undefined;
    }
    const { action, created } = this.#actions.insert({
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
      preauthorizationId: authorization?.preauthorizationId,
      schedulePolicyId: authorization?.schedulePolicyId,
      schedulePolicyVersion: authorization?.schedulePolicyVersion,
      createdAt: now,
    });

    if (!created) {
      // A replayed report must not re-approve or re-card an existing row.
      return { action, autoApprove: false, created: false };
    }

    this.#store.recordAudit({
      event: "action.proposed",
      subjectType: "action",
      subjectId: action.id,
      after: { tool: action.tool, args: action.args, taskId: task.id },
      traceId: `action:${action.id}`,
      occurredAt: now,
    });

    if (authorization !== undefined || internalStateRead) {
      if (deferAutoApprove) {
        return { action, autoApprove: true, created: true };
      }
      if (this.#autoApproveReadOnly(action)) {
        return { action, autoApprove: true, created: true };
      }
    }

    this.#sendApprovalCard(action);
    return { action, autoApprove: false, created: true };
  }

  #findReadAuthorization(
    task: TaskRecord,
    tool: ActionTool,
    args: Record<string, unknown>,
  ):
    | {
        preauthorizationId?: string;
        schedulePolicyId?: string;
        schedulePolicyVersion?: number;
      }
    | undefined {
    if (
      tool.name !== "github.read" ||
      tool.readOnly !== true ||
      typeof args.repo !== "string"
    ) {
      return undefined;
    }
    if (task.schedulePolicyId !== undefined) {
      if (this.#schedulePolicies === undefined) {
        return undefined;
      }
      const policy = this.#schedulePolicies.readAuthorization(
        task.schedulePolicyId,
        task.ownerId,
        args.repo,
      );
      if (policy !== undefined) {
        return {
          schedulePolicyId: policy.id,
          schedulePolicyVersion: policy.version,
        };
      }
      // A paused/edited/expired plan must not fall through to a different
      // authorization path or send an approval card for out-of-scope work.
      return undefined;
    }
    if (this.#preauthorizations === undefined) {
      return undefined;
    }
    const grant = this.#preauthorizations.findActive(task.ownerId, tool.name, args.repo);
    return grant === undefined ? undefined : { preauthorizationId: grant.id };
  }

  #sendApprovalCard(action: ActionRecord): void {
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
      this.#auditAction(action, "action.failed", { reason: "unknown_tool" });
      this.#reply(action, "failure", "动作失败：未知工具。", "failed");
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    try {
      const result = await this.#runTool(tool, action.args, this.#executionContext(action));
      const marked = this.#actions.markSucceeded(
        action.id,
        result.evidence,
        result.externalRef,
        this.#now().toISOString(),
      );
      if (marked) {
        this.#auditAction(action, "action.succeeded");
      }
      this.#reply(action, "result", `动作已完成：${JSON.stringify(result.evidence)}`, "succeeded");
      this.#onSettled(action.taskId);
      return { status: "done" };
    } catch (error) {
      const at = this.#now().toISOString();
      if (error instanceof ToolRejectedError) {
        this.#actions.markFailed(action.id, error.message, at);
        this.#auditAction(action, "action.failed", { reason: error.message });
        this.#reply(action, "failure", `动作失败：${error.message}`, "failed");
        this.#onSettled(action.taskId);
        return { status: "done" };
      }

      const reason =
        error instanceof ToolUnknownError
          ? error.message
          : `unexpected tool error: ${error instanceof Error ? error.message : String(error)}`;
      const marked = this.#actions.markUnknown(action.id, reason, at);
      if (marked) {
        this.#auditAction(action, "action.unknown", { reason });
      }
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
      this.#auditAction(action, "action.needs_manual", { reason: "unknown_tool" });
      this.#reply(action, "failure", "动作需要人工核对：工具不存在。", "needs_manual");
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    this.#actions.markReconciling(action.id, this.#now().toISOString());
    let verification;
    try {
      verification = await tool.verify(action.args, this.#executionContext(action));
    } catch (error) {
      if (effectAttempts >= this.#maxAttempts) {
        this.#actions.markNeedsManual(
          action.id,
          `reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
          this.#now().toISOString(),
        );
        this.#auditAction(action, "action.needs_manual", {
          reason: "reconcile_verify_failed",
        });
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
      const marked = this.#actions.markSucceeded(
        action.id,
        { ...verification.evidence, reconciled: true },
        undefined,
        this.#now().toISOString(),
      );
      if (marked) {
        this.#auditAction(action, "action.reconciled");
      }
      this.#reply(
        action,
        "result",
        `动作已核对为完成：${JSON.stringify(verification.evidence)}`,
        "reconciled",
      );
      this.#onSettled(action.taskId);
      return { status: "done" };
    }

    if (tool.replayPolicy !== "verify") {
      this.#actions.markNeedsManual(
        action.id,
        "tool does not declare verified replay; refusing to repeat the write",
        this.#now().toISOString(),
      );
      this.#auditAction(action, "action.needs_manual", {
        reason: "replay_policy_missing",
      });
      this.#reply(
        action,
        "failure",
        "动作结果无法判定，需要人工核对；不会重复执行。",
        "needs_manual",
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
      this.#auditAction(action, "action.needs_manual", {
        reason: "retry_budget_exhausted",
      });
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
        this.#auditAction(action, "action.needs_manual", {
          reason: "unauthorized",
        });
      } else {
        this.#auditAction(action, "action.superseded", { reason: "unauthorized" });
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

    // Verify runs before this retry. A timed-out write may still land
    // afterwards; re-applying is safe only when the tool declares
    // replayPolicy="verify" and its verify is reliable.
    try {
      const result = await this.#runTool(tool, action.args, this.#executionContext(action));
      const marked = this.#actions.markSucceeded(
        action.id,
        { ...result.evidence, retried: true },
        result.externalRef,
        this.#now().toISOString(),
      );
      if (marked) {
        this.#auditAction(action, "action.reconciled", { retried: true });
      }
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
        this.#auditAction(action, "action.needs_manual", {
          reason: `reconcile_retry_failed: ${reason}`,
        });
        this.#reply(
          action,
          "failure",
          "动作重试后仍无法确认结果，需要人工核对。",
          "needs_manual",
        );
        this.#onSettled(action.taskId);
        return { status: "done" };
      }
      const marked = this.#actions.markUnknown(action.id, reason, at);
      if (marked) {
        this.#auditAction(action, "action.unknown", {
          reason: `reconcile_retry_failed: ${reason}`,
        });
      }
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
        this.#auditAction(action, "action.expired");
        this.#reply(action, "failure", "动作审批已过期。", "expired");
        this.#onSettled(action.taskId);
      }
    }

    for (const action of this.#actions.listExpiredExecuting(now)) {
      if (this.#actions.markExecutingExpired(action.id, now, "execution lease expired")) {
        this.#auditAction(action, "action.unknown", {
          reason: "execution_lease_expired",
        });
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
      return "task_guard_unavailable";
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
      task.status === "succeeded" ||
      task.status === "needs_review"
    ) {
      return "task_not_executable";
    }
    if (!task.mandate.tools.includes(action.tool)) {
      return "tool_outside_mandate";
    }
    const tool = this.#tools.get(action.tool);
    if (
      tool?.resource !== undefined &&
      !task.mandate.resources.includes(tool.resource)
    ) {
      return "resource_outside_mandate";
    }
    if (action.preauthorizationId !== undefined) {
      if (this.#preauthorizations?.isGrantActive(action.preauthorizationId) !== true) {
        return "preauthorization_revoked";
      }
    }
    if (action.schedulePolicyId !== undefined) {
      if (
        action.schedulePolicyVersion === undefined ||
        typeof action.args.repo !== "string" ||
        this.#schedulePolicies?.readAuthorization(
          action.schedulePolicyId,
          action.ownerId,
          action.args.repo,
          action.schedulePolicyVersion,
        ) === undefined
      ) {
        return "schedule_policy_inactive";
      }
    }
    return undefined;
  }

  #executionContext(action: ActionRecord): ToolExecutionContext {
    const task = this.#tasks?.get(action.taskId);
    return {
      ownerId: action.ownerId,
      taskId: action.taskId,
      project: task?.mandate.project,
    };
  }

  async #runTool(
    tool: ActionTool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    const queuedAt = this.#now().getTime();
    await this.#acquireToolSlot();
    const waitMs = Math.max(0, this.#now().getTime() - queuedAt);
    const remainingMs = this.#leaseMs - 1_000 - waitMs;
    if (remainingMs <= 0) {
      this.#releaseToolSlot();
      throw tool.readOnly === true
        ? new ToolRejectedError("tool queue wait exceeded the execution lease")
        : new ToolUnknownError("tool queue wait exceeded the execution lease; outcome unknown");
    }
    const timeoutMs = Math.min(tool.timeoutMs ?? 15_000, remainingMs);
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => timeout.reject(new ToolTimeoutError(`tool timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const running = tool.execute(args, context);
      // If the timeout wins, the tool may still settle later; do not surface an
      // unhandled rejection from the abandoned promise.
      void running.catch(() => {});
      return await Promise.race([running, timeout.promise]);
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        throw tool.readOnly === true
          ? new ToolRejectedError(error.message)
          : new ToolUnknownError(`${error.message}; outcome unknown`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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

  #auditAction(
    action: ActionRecord,
    event: string,
    after: Record<string, unknown> = {},
  ): void {
    this.#store.recordAudit({
      event,
      subjectType: "action",
      subjectId: action.id,
      after: { tool: action.tool, ...after },
      traceId: `action:${action.id}`,
      occurredAt: this.#now().toISOString(),
    });
  }

  #readAuthorizationRevoked(action: ActionRecord): string | undefined {
    if (
      action.preauthorizationId !== undefined &&
      this.#preauthorizations?.isGrantActive(action.preauthorizationId) !== true
    ) {
      return "preauthorization_revoked";
    }
    if (action.schedulePolicyId !== undefined) {
      if (
        action.schedulePolicyVersion === undefined ||
        typeof action.args.repo !== "string" ||
        this.#schedulePolicies?.readAuthorization(
          action.schedulePolicyId,
          action.ownerId,
          action.args.repo,
          action.schedulePolicyVersion,
        ) === undefined
      ) {
        return "schedule_policy_inactive";
      }
    }
    return undefined;
  }

  #isInternalStateRead(task: TaskRecord, tool: ActionTool): boolean {
    return (
      tool.readOnly === true &&
      tool.resource === STATE_RESOURCE &&
      isStateToolName(tool.name) &&
      task.mandate.tools.includes(tool.name) &&
      task.mandate.resources.includes(STATE_RESOURCE)
    );
  }

  #autoApproveReadOnly(action: ActionRecord): boolean {
    const tool = this.#tools.get(action.tool);
    if (tool?.readOnly !== true) {
      return false;
    }
    const task = this.#tasks?.get(action.taskId);
    if (task === undefined) {
      return false;
    }

    let description: string;
    let authorization: "preauthorization" | "schedule_policy" | "internal_state";
    if (this.#isInternalStateRead(task, tool)) {
      authorization = "internal_state";
      description = `已按任务授权读取内部状态（${action.tool}）。`;
    } else if (action.tool === "github.read" && typeof action.args.repo === "string") {
      if (action.schedulePolicyId !== undefined) {
        if (
          action.schedulePolicyVersion === undefined ||
          this.#schedulePolicies?.readAuthorization(
            action.schedulePolicyId,
            action.ownerId,
            action.args.repo,
            action.schedulePolicyVersion,
          ) === undefined
        ) {
          return false;
        }
        authorization = "schedule_policy";
        description = `已按周期计划授权执行 ${action.tool}（${action.args.repo}）。`;
      } else {
        if (
          this.#preauthorizations === undefined ||
          action.preauthorizationId === undefined
        ) {
          return false;
        }
        const grant = this.#preauthorizations.findActiveById(action.preauthorizationId);
        if (
          grant === undefined ||
          grant.ownerId !== action.ownerId ||
          grant.tool !== action.tool ||
          grant.repo !== action.args.repo.trim().toLowerCase()
        ) {
          return false;
        }
        authorization = "preauthorization";
        description = `已按只读预授权执行 ${action.tool}（${action.args.repo}）。`;
      }
    } else {
      return false;
    }

    const result = this.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: action.ownerId,
      conversationId: action.conversationId,
      expectedArgsHash: action.argsHash,
      expectedTaskRevision: action.taskRevision,
    });
    if (!result.ok) {
      return false;
    }
    this.#store.recordAudit({
      event: "action.auto_approved",
      subjectType: "action",
      subjectId: action.id,
      after: {
        tool: action.tool,
        repo: action.args.repo,
        authorization,
        schedulePolicyId: action.schedulePolicyId,
        taskProject: task.mandate.project,
      },
      traceId: `action:${action.id}`,
      occurredAt: this.#now().toISOString(),
    });
    this.#reply(action, "status", description, "auto_approved");
    return true;
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
      traceId: `task:${action.taskId}`,
    });
  }
}

function executionContext(task: TaskRecord): ToolExecutionContext {
  return {
    ownerId: task.ownerId,
    taskId: task.id,
    project: task.mandate.project,
  };
}
