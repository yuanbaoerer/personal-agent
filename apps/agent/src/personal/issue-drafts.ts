import { createHash, randomUUID } from "node:crypto";

import type { CredentialBroker } from "../actions/credentials.ts";
import type {
  ActionRecord,
  AssignmentRecord,
  IssueDraft,
  IssueDraftSnapshot,
  ProjectFinding,
  TaskRecord,
} from "../domain/types.ts";
import type { IssueDraftRepository } from "../storage/issue-drafts.ts";
import { isActiveDraftStatus } from "../storage/issue-drafts.ts";
import type { ProjectRepository } from "../storage/projects.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { Store } from "../storage/store.ts";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_BEFORE_SUMMARY = 500;

export interface RecordVerifiedDraftsInput {
  task: TaskRecord;
  assignment: AssignmentRecord;
  findings: readonly ProjectFinding[];
  drafts: readonly IssueDraft[];
  actions: readonly ActionRecord[];
}

export interface RecordedDrafts {
  recorded: IssueDraftSnapshot[];
  deduplicated: number;
  superseded: number;
}

export interface IssueDraftView extends IssueDraftSnapshot {
  /** Revalidated at read time; older credentials/bindings never look valid. */
  validity: "valid" | "expired" | "superseded" | "inactive";
}

/**
 * Persists verifier-approved issue drafts as owner-scoped approval objects.
 * This is not an approval service: it never executes, and every read/approval
 * re-checks the live binding, credential epoch and source task revision.
 */
export class IssueDraftService {
  readonly #store: Store;
  readonly #drafts: IssueDraftRepository;
  readonly #projects: ProjectRepository;
  readonly #tasks: TaskRepository;
  readonly #credentials?: CredentialBroker;
  readonly #writeCredentialRef?: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(deps: {
    store: Store;
    drafts: IssueDraftRepository;
    projects: ProjectRepository;
    tasks: TaskRepository;
    credentials?: CredentialBroker;
    /** Separate Issues-write ref; never the binding's read credential. */
    writeCredentialRef?: string;
    now?: () => Date;
    ttlMs?: number;
  }) {
    this.#store = deps.store;
    this.#drafts = deps.drafts;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#credentials = deps.credentials;
    this.#writeCredentialRef = deps.writeCredentialRef;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Called only after the project-review verifier accepted the report. Drafts
   * are keyed by repository + program-derived idempotency key: re-running the
   * same evaluation reuses the row, changed content supersedes it.
   */
  recordVerified(input: RecordVerifiedDraftsInput): RecordedDrafts {
    const projectKey = input.task.mandate.project;
    if (projectKey === undefined) {
      return { recorded: [], deduplicated: 0, superseded: 0 };
    }
    const binding = this.#projects.findActiveByKey(
      input.task.ownerId,
      projectKey,
    );
    if (binding === undefined) {
      return { recorded: [], deduplicated: 0, superseded: 0 };
    }
    const bodies = issueBodies(input.actions);
    const now = this.#now();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
    const writeCredentialRef =
      this.#writeCredentialRef ?? binding.credentialRef;
    const credential = this.#credentials?.status(writeCredentialRef);
    const supersededForRevision = this.#drafts.supersedeForTask(
      input.task.id,
      input.task.revision,
      at,
    );

    const recorded: IssueDraftSnapshot[] = [];
    let deduplicated = 0;
    let superseded = supersededForRevision > 0 ? 1 : 0;
    for (const draft of input.drafts) {
      if (draft.idempotencyKey === undefined) {
        continue;
      }
      const linked = input.findings.filter((finding, index) =>
        draft.findingIds.includes(
          finding.id ?? `finding-${index + 1}`,
        ),
      );
      const first = linked[0];
      if (first === undefined) {
        continue;
      }
      if (
        linked.some(
          (finding) =>
            finding.repositoryId !== first.repositoryId ||
            finding.commitSha !== first.commitSha,
        )
      ) {
        continue;
      }
      if (first.repositoryId !== binding.repositoryId) {
        continue;
      }
      const before = draft.targetIssue === undefined
        ? undefined
        : bodies.get(draft.targetIssue);
      const beforeHash =
        before === undefined
          ? draft.beforeHash
          : (before.beforeHash ?? issueBeforeHash(before.title, before.body));
      if (draft.action === "update" && beforeHash === undefined) {
        continue;
      }
      const payloadHash = issueDraftPayloadHash({
        repositoryId: binding.repositoryId,
        commitSha: first.commitSha,
        action: draft.action,
        targetIssue: draft.targetIssue,
        title: draft.title,
        body: draft.body,
        idempotencyKey: draft.idempotencyKey,
      });
      const existing = this.#drafts.findActiveByKey(
        input.task.ownerId,
        binding.repositoryId,
        draft.idempotencyKey,
      );
      if (
        existing !== undefined &&
        existing.payloadHash === payloadHash &&
        existing.sourceTaskRevision === input.task.revision &&
        existing.commitSha === first.commitSha &&
        sameStrings(existing.findingIds, draft.findingIds)
      ) {
        deduplicated += 1;
        recorded.push(existing);
        continue;
      }
      if (existing !== undefined) {
        this.#drafts.updateStatus(existing.id, "superseded", at);
        superseded += 1;
        this.#audit("issue_draft.superseded", existing, {
          reason: "new_verified_revision",
          replacement: draft.idempotencyKey,
        });
      }
      const snapshot: IssueDraftSnapshot = {
        id: randomUUID(),
        ownerId: input.task.ownerId,
        projectKey,
        repositoryId: binding.repositoryId,
        repositoryFullName: binding.repositoryFullName,
        sourceTaskId: input.task.id,
        sourceTaskRevision: input.task.revision,
        sourceAssignmentId: input.assignment.id,
        commitSha: first.commitSha,
        findingIds: [...draft.findingIds],
        action: draft.action,
        ...(draft.targetIssue === undefined
          ? {}
          : { targetIssue: draft.targetIssue }),
        ...(beforeHash === undefined ? {} : { beforeHash }),
        ...(before === undefined
          ? {}
          : { beforeSummary: truncate(before.body, MAX_BEFORE_SUMMARY) }),
        title: draft.title,
        body: draft.body,
        payloadHash,
        idempotencyKey: draft.idempotencyKey,
        credentialRef: writeCredentialRef,
        ...(credential === undefined
          ? {}
          : { credentialVersion: credential.version }),
        status: "pending_approval",
        createdAt: at,
        expiresAt,
        updatedAt: at,
      };
      this.#drafts.insert(snapshot);
      this.#audit("issue_draft.created", snapshot, {
        action: draft.action,
        targetIssue: draft.targetIssue,
        commitSha: first.commitSha,
      });
      recorded.push(snapshot);
    }
    return { recorded, deduplicated, superseded };
  }

  list(
    ownerId: string,
    filter: {
      status?: IssueDraftSnapshot["status"];
      projectKey?: string;
      repositoryId?: number;
      limit?: number;
    } = {},
  ): IssueDraftView[] {
    this.expireDue();
    return this.#drafts
      .list(ownerId, filter)
      .map((draft) => this.#revalidate(ownerId, draft));
  }

  get(ownerId: string, id: string): IssueDraftView | undefined {
    this.expireDue();
    const draft = this.#drafts.get(ownerId, id);
    return draft === undefined ? undefined : this.#revalidate(ownerId, draft);
  }

  /** Rejection is final; a new approved review can create a new snapshot. */
  reject(
    ownerId: string,
    id: string,
    actorId: string,
  ): { ok: boolean; reason?: string; draft?: IssueDraftView } {
    const draft = this.get(ownerId, id);
    if (draft === undefined) {
      return { ok: false, reason: "draft_not_found" };
    }
    if (
      draft.status !== "draft" &&
      draft.status !== "pending_approval"
    ) {
      return { ok: false, reason: `draft_${draft.status}`, draft };
    }
    const at = this.#now().toISOString();
    const updated = this.#drafts.updateStatus(
      draft.id,
      "rejected",
      at,
      {},
      ["draft", "pending_approval"],
    );
    if (updated === undefined) {
      return { ok: false, reason: "draft_not_found" };
    }
    this.#audit("issue_draft.rejected", updated, { actorId });
    return { ok: true, draft: { ...updated, validity: "inactive" } };
  }

  supersedeForTask(taskId: string, keepRevision: number | undefined): number {
    return this.#drafts.supersedeForTask(
      taskId,
      keepRevision,
      this.#now().toISOString(),
    );
  }

  supersedeForRepository(ownerId: string, repositoryId: number): number {
    const at = this.#now().toISOString();
    const count = this.#drafts.supersedeForRepository(ownerId, repositoryId, at);
    if (count > 0) {
      this.#store.recordAudit({
        actorId: ownerId,
        event: "issue_draft.superseded",
        subjectType: "issue_draft",
        subjectId: `${ownerId}:${repositoryId}`,
        after: { reason: "project_binding_changed", count },
        traceId: `issue-draft:${repositoryId}`,
        occurredAt: at,
      });
    }
    return count;
  }

  supersedeForCredential(ownerId: string, credentialRef: string): number {
    const at = this.#now().toISOString();
    const count = this.#drafts.supersedeForCredential(
      ownerId,
      credentialRef,
      at,
    );
    if (count > 0) {
      this.#store.recordAudit({
        actorId: ownerId,
        event: "issue_draft.superseded",
        subjectType: "issue_draft",
        subjectId: `${ownerId}:${credentialRef}`,
        after: { reason: "credential_changed", count },
        traceId: `issue-draft:${credentialRef}`,
        occurredAt: at,
      });
    }
    return count;
  }

  expireDue(): number {
    const at = this.#now().toISOString();
    const count = this.#drafts.expireDue(at);
    if (count > 0) {
      this.#store.recordAudit({
        event: "issue_draft.expired",
        subjectType: "issue_draft",
        after: { count },
        traceId: "issue-draft:expire",
        occurredAt: at,
      });
    }
    return count;
  }

  #revalidate(ownerId: string, draft: IssueDraftSnapshot): IssueDraftView {
    if (!isActiveDraftStatus(draft.status)) {
      return { ...draft, validity: draft.status === "expired" ? "expired" : "inactive" };
    }
    const at = this.#now().toISOString();
    const supersede = (reason: string): IssueDraftView => {
      const updated = this.#drafts.updateStatus(draft.id, "superseded", at) ?? draft;
      this.#audit("issue_draft.superseded", updated, { reason });
      return { ...updated, validity: "superseded" };
    };
    if (draft.expiresAt <= at) {
      const updated = this.#drafts.updateStatus(draft.id, "expired", at) ?? draft;
      return { ...updated, validity: "expired" };
    }
    const task = this.#tasks.get(draft.sourceTaskId);
    if (
      task === undefined ||
      task.ownerId !== ownerId ||
      task.revision !== draft.sourceTaskRevision ||
      task.status === "cancelled" ||
      task.status === "cancelling" ||
      task.status === "failed"
    ) {
      return supersede("source_task_changed");
    }
    if (draft.writeTaskId !== undefined) {
      const writeTask = this.#tasks.get(draft.writeTaskId);
      if (
        writeTask === undefined ||
        // The bridge creates the write task at revision 1; any revise means
        // it no longer authorizes the approved action.
        writeTask.revision !== 1 ||
        writeTask.status === "cancelled" ||
        writeTask.status === "cancelling" ||
        writeTask.status === "failed"
      ) {
        return supersede("write_task_changed");
      }
    }
    const binding = this.#projects.findActiveByKey(ownerId, draft.projectKey);
    if (
      binding === undefined ||
      binding.repositoryId !== draft.repositoryId ||
      binding.repositoryFullName.toLowerCase() !==
        draft.repositoryFullName.toLowerCase() ||
      (this.#writeCredentialRef !== undefined &&
        this.#writeCredentialRef !== draft.credentialRef)
    ) {
      return supersede("project_binding_changed");
    }
    if (this.#credentials !== undefined) {
      const credential = this.#credentials.status(draft.credentialRef);
      if (
        credential === undefined ||
        credential.status !== "active" ||
        credential.version !== draft.credentialVersion
      ) {
        return supersede("credential_changed");
      }
    }
    return { ...draft, validity: "valid" };
  }

  #audit(
    event: string,
    draft: IssueDraftSnapshot,
    after: Record<string, unknown>,
  ): void {
    this.#store.recordAudit({
      actorId: draft.ownerId,
      event,
      subjectType: "issue_draft",
      subjectId: draft.id,
      after: {
        projectKey: draft.projectKey,
        repositoryId: draft.repositoryId,
        action: draft.action,
        targetIssue: draft.targetIssue,
        payloadHash: draft.payloadHash,
        sourceTaskId: draft.sourceTaskId,
        sourceTaskRevision: draft.sourceTaskRevision,
        ...after,
      },
      traceId: `issue-draft:${draft.id}`,
      occurredAt: this.#now().toISOString(),
    });
  }
}

/** The approved pre-image of an issue update. Title is included so a title
 * edit after review also invalidates the approval. */
export function issueBeforeHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex");
}

/** Deterministic payload identity shown to the owner and bound on approval. */
export function issueDraftPayloadHash(input: {
  repositoryId: number;
  commitSha: string;
  action: "create" | "update" | "comment";
  targetIssue?: number;
  title: string;
  body: string;
  idempotencyKey: string;
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        repositoryId: input.repositoryId,
        commitSha: input.commitSha.toLowerCase(),
        action: input.action,
        targetIssue: input.targetIssue ?? null,
        title: input.title,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest("hex");
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function issueBodies(
  actions: readonly ActionRecord[],
): Map<number, { title: string; body: string; beforeHash?: string }> {
  const bodies = new Map<
    number,
    { title: string; body: string; beforeHash?: string }
  >();
  for (const action of actions) {
    if (action.status !== "succeeded" || action.tool !== "github.read") {
      continue;
    }
    const operation = action.args.operation;
    if (operation !== "issue" && operation !== "issues") {
      continue;
    }
    const evidence = action.evidence;
    if (evidence === undefined) {
      continue;
    }
    const entries = [
      evidence.item,
      ...(Array.isArray(evidence.items) ? evidence.items : []),
    ];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.number === "number" &&
        Number.isSafeInteger(record.number) &&
        typeof record.body === "string" &&
        typeof record.title === "string" &&
        !bodies.has(record.number)
      ) {
        bodies.set(record.number, {
          title: record.title,
          body: record.body,
          ...(typeof record.beforeHash === "string"
            ? { beforeHash: record.beforeHash }
            : {}),
        });
      }
    }
  }
  return bodies;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
