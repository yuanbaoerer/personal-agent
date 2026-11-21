import type { CredentialBroker } from "../actions/credentials.ts";
import type { ActionRecord, IssueDraftSnapshot } from "../domain/types.ts";
import type { ActionService } from "../actions/service.ts";
import type { CapabilityView } from "../plugins/fence.ts";
import type { IssueDraftRepository } from "../storage/issue-drafts.ts";
import type { ActionRepository } from "../storage/actions.ts";
import type { Store } from "../storage/store.ts";
import type { TaskService } from "../coordinator/tasks.ts";
import type { IssueDraftService, IssueDraftView } from "./issue-drafts.ts";

const TOOL_FOR_ACTION = {
  create: "github.issue.create",
  update: "github.issue.update",
  comment: "github.issue.comment",
} as const;

export interface DraftApprovalResult {
  ok: boolean;
  reason?: string;
  draft?: IssueDraftView;
  action?: ActionRecord;
  taskId?: string;
}

/**
 * Converts an owner-approved DraftSnapshot into one typed ActionService
 * write. Approval binds the exact payloadHash, source revision, repository
 * identity and credential epoch. The bridge never writes to GitHub directly;
 * the tool performs read-after-write and the bridge settles the task.
 */
export class IssueDraftApprovalBridge {
  readonly #store: Store;
  readonly #drafts: IssueDraftRepository;
  readonly #actions: ActionRepository;
  readonly #draftService: IssueDraftService;
  readonly #taskService: TaskService;
  readonly #actionService: ActionService;
  readonly #credentials: CredentialBroker;
  readonly #capabilities: CapabilityView;
  readonly #writeCredentialRef: string;
  readonly #now: () => Date;

  constructor(deps: {
    store: Store;
    drafts: IssueDraftRepository;
    actions: ActionRepository;
    draftService: IssueDraftService;
    taskService: TaskService;
    actionService: ActionService;
    credentials: CredentialBroker;
    capabilities: CapabilityView;
    writeCredentialRef: string;
    now?: () => Date;
  }) {
    this.#store = deps.store;
    this.#drafts = deps.drafts;
    this.#actions = deps.actions;
    this.#draftService = deps.draftService;
    this.#taskService = deps.taskService;
    this.#actionService = deps.actionService;
    this.#credentials = deps.credentials;
    this.#capabilities = deps.capabilities;
    this.#writeCredentialRef = deps.writeCredentialRef;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Restart recovery: a crash after the external write but before settlement
   * leaves the draft in `executing`. Re-read the action and settle it without
   * issuing another write.
   */
  reconcileOwner(ownerId: string): number {
    let settled = 0;
    for (const draft of this.#drafts.list(ownerId, { status: "executing" })) {
      if (draft.writeActionId === undefined) {
        continue;
      }
      const action = this.#actions.get(draft.writeActionId);
      if (action === undefined) {
        this.#drafts.updateStatus(draft.id, "failed", this.#now().toISOString());
        settled += 1;
        continue;
      }
      if (
        action.status === "succeeded" ||
        action.status === "failed" ||
        action.status === "needs_manual" ||
        action.status === "expired" ||
        action.status === "superseded" ||
        action.status === "denied"
      ) {
        this.onActionSettled(action);
        settled += 1;
      }
    }
    return settled;
  }

  install(): void {
    this.#actionService.setSettledListener((action) => {
      this.onActionSettled(action);
    });
  }

  approve(input: {
    ownerId: string;
    conversationId: string;
    draftId: string;
    payloadHash: string;
    actorId: string;
  }): DraftApprovalResult {
    const draft = this.#draftService.get(input.ownerId, input.draftId);
    if (draft === undefined) {
      return { ok: false, reason: "draft_not_found" };
    }
    if (draft.status !== "pending_approval" || draft.validity !== "valid") {
      return { ok: false, reason: `draft_${draft.status}`, draft };
    }
    if (draft.payloadHash !== input.payloadHash) {
      return { ok: false, reason: "payload_hash_mismatch", draft };
    }
    if (draft.credentialRef !== this.#writeCredentialRef) {
      return { ok: false, reason: "write_credential_not_bound", draft };
    }
    const credential = this.#credentials.status(draft.credentialRef);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      draft.credentialVersion === undefined ||
      credential.version !== draft.credentialVersion
    ) {
      return { ok: false, reason: "credential_changed", draft };
    }
    const tool = TOOL_FOR_ACTION[draft.action];
    const info = this.#capabilities.toolInfo(tool);
    if (
      info === undefined ||
      info.readOnly !== false ||
      !info.permissions.includes("issues.write")
    ) {
      return { ok: false, reason: "issue_write_capability_unavailable", draft };
    }

    const task = this.#taskService.createExternalActionTask({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sourceKey: `draft:${draft.id}:write:v${draft.payloadHash.slice(0, 16)}`,
      goal: `执行已批准的 GitHub ${draft.action}: ${draft.title}`,
      completionCriteria: JSON.stringify({
        verifier: "action-receipt",
        requiredEvidenceKinds: [],
      }),
      mandate: {
        resources: ["chat", "github"],
        tools: [tool],
        project: draft.projectKey,
      },
    });
    const proposed = this.#actionService.proposeApprovedWrite({
      task,
      tool,
      args: actionArgs(draft),
      sourceKey: `draft:${draft.id}:action:${draft.payloadHash}`,
    });
    if (proposed === undefined) {
      this.#taskService.finishExternalAction(task.id, {
        status: "failed",
        summary: "无法创建经过批准的类型化写入动作。",
        verification: verification("failed", ["action_proposal"], []),
      });
      return { ok: false, reason: "action_proposal_failed", draft };
    }
    if (proposed.action.status === "succeeded") {
      // A replay of the same approval after the write already landed.
      this.#drafts.updateStatus(draft.id, "approved", this.#now().toISOString());
      return {
        ok: true,
        draft: this.#draftService.get(input.ownerId, draft.id),
        action: proposed.action,
        taskId: task.id,
      };
    }
    if (proposed.action.status !== "proposed") {
      return {
        ok: false,
        reason: `action_${proposed.action.status}`,
        draft,
        action: proposed.action,
        taskId: task.id,
      };
    }
    const approved = this.#actionService.approve({
      actionId: proposed.action.id,
      nonce: proposed.action.nonce,
      approverId: input.actorId,
      conversationId: input.conversationId,
      expectedArgsHash: proposed.action.argsHash,
      expectedTaskRevision: proposed.action.taskRevision,
    });
    if (!approved.ok) {
      this.#taskService.finishExternalAction(task.id, {
        status: "failed",
        summary: `动作批准失败：${approved.reason ?? "unknown"}`,
        verification: verification("failed", ["action_approval"], []),
      });
      return {
        ok: false,
        reason: approved.reason ?? "approval_failed",
        draft,
        action: proposed.action,
        taskId: task.id,
      };
    }
    const updated = this.#drafts.updateStatus(
      draft.id,
      "executing",
      this.#now().toISOString(),
      { writeTaskId: task.id, writeActionId: proposed.action.id },
    );
    this.#store.recordAudit({
      actorId: input.actorId,
      event: "issue_draft.approved",
      subjectType: "issue_draft",
      subjectId: draft.id,
      after: {
        payloadHash: draft.payloadHash,
        actionId: proposed.action.id,
        taskId: task.id,
        repositoryId: draft.repositoryId,
        credentialVersion: draft.credentialVersion,
      },
      traceId: `issue-draft:${draft.id}`,
      occurredAt: this.#now().toISOString(),
    });
    return {
      ok: true,
      draft:
        updated === undefined
          ? undefined
          : this.#draftService.get(input.ownerId, draft.id),
      action: proposed.action,
      taskId: task.id,
    };
  }

  reject(
    ownerId: string,
    id: string,
    actorId: string,
  ): { ok: boolean; reason?: string; draft?: IssueDraftView } {
    return this.#draftService.reject(ownerId, id, actorId);
  }

  private onActionSettled(action: ActionRecord): void {
    const draft = this.#drafts.findByActionId(action.id);
    if (draft === undefined) {
      return;
    }
    const at = this.#now().toISOString();
    const evidence = action.evidence ?? {};
    const externalRef =
      action.externalRef ??
      (typeof evidence.issueUrl === "string" ? evidence.issueUrl : undefined);
    if (action.status === "succeeded") {
      this.#drafts.updateStatus(draft.id, "approved", at);
      if (draft.writeTaskId !== undefined) {
        this.#taskService.finishExternalAction(draft.writeTaskId, {
          status: "succeeded",
          summary:
            `GitHub ${draft.action} 已写入并完成写后读取核对` +
            (externalRef === undefined ? "。" : `：${externalRef}`),
          verification: {
            verifier: "action-receipt",
            verifierVersion: "2026-11-22.1",
            verdict: "succeeded",
            reason: "approved write action succeeded and read-after-write passed",
            checked: ["action_succeeded", "binding_scope", "payload_hash", "read_after_write"],
            missing: [],
            evidenceRefs:
              externalRef === undefined ? [`action:${action.id}`] : [externalRef],
            externalFactsVerified: true,
            verifiedAt: at,
          },
          resultRef: externalRef,
        });
      }
      return;
    }

    if (action.status === "unknown" || action.status === "reconciling") {
      // The action may have landed. Wait for reconcile/read-after-write;
      // marking the draft failed here would strand a successful write.
      return;
    }
    const mapping: Record<string, IssueDraftSnapshot["status"]> = {
      failed: "failed",
      needs_manual: "failed",
      expired: "expired",
      superseded: "superseded",
      denied: "rejected",
    };
    const next = mapping[action.status] ?? "failed";
    this.#drafts.updateStatus(draft.id, next, at);
    if (draft.writeTaskId !== undefined) {
      const needsReview = action.status === "needs_manual";
      this.#taskService.finishExternalAction(draft.writeTaskId, {
        status: needsReview ? "needs_review" : "failed",
        summary:
          action.status === "needs_manual"
            ? "GitHub 写入结果未知，必须先人工核对；不会自动重复 POST。"
            : `GitHub 写入未完成：${action.status}${action.lastError === undefined ? "" : ` (${action.lastError})`}`,
        verification: verification(
          needsReview ? "needs_review" : "failed",
          ["action_settled"],
          [action.status],
          externalRef,
        ),
      });
    }
  }
}

function actionArgs(draft: IssueDraftSnapshot): Record<string, unknown> {
  const base = {
    projectKey: draft.projectKey,
    repo: draft.repositoryFullName,
    repositoryId: draft.repositoryId,
    credentialRef: draft.credentialRef,
    credentialVersion: draft.credentialVersion,
    payloadHash: draft.payloadHash,
    idempotencyKey: draft.idempotencyKey,
  };
  if (draft.action === "create") {
    return { ...base, title: draft.title, body: draft.body };
  }
  if (draft.action === "comment") {
    return { ...base, targetIssue: draft.targetIssue, body: draft.body };
  }
  return {
    ...base,
    targetIssue: draft.targetIssue,
    title: draft.title,
    body: draft.body,
    beforeHash: draft.beforeHash,
  };
}

function verification(
  verdict: "succeeded" | "failed" | "needs_review",
  checked: string[],
  missing: string[],
  externalRef?: string,
): {
  verifier: string;
  verifierVersion: string;
  verdict: "succeeded" | "failed" | "needs_review";
  reason: string;
  checked: string[];
  missing: string[];
  evidenceRefs: string[];
  externalFactsVerified: boolean;
  verifiedAt: string;
} {
  return {
    verifier: "action-receipt",
    verifierVersion: "2026-11-22.1",
    verdict,
    reason:
      verdict === "succeeded"
        ? "external write succeeded"
        : "external write did not complete",
    checked,
    missing,
    evidenceRefs: externalRef === undefined ? [] : [externalRef],
    externalFactsVerified: verdict === "succeeded",
    verifiedAt: new Date().toISOString(),
  };
}
