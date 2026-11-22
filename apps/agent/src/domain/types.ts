export type ChannelName = string;
export type ActorType = "user" | "app" | "unknown";
export type ChatType = "p2p" | "group" | "unknown";

export interface OwnerIdentity {
  id: string;
  channel: ChannelName;
  accountId: string;
  actorId: string;
  displayName?: string;
  verifiedAt: string;
  revokedAt?: string;
}

export interface ConversationRecord {
  id: string;
  ownerId: string;
  channel: ChannelName;
  accountId: string;
  platformConversationId: string;
  kind: ChatType;
  createdAt: string;
}

export interface InboundEnvelope {
  channel: ChannelName;
  accountId: string;
  platformEventId: string;
  eventType: string;
  chatType: ChatType;
  actorType: ActorType;
  actorId: string;
  platformConversationId: string;
  replyTo?: string;
  occurredAt?: string;
  text?: string;
}

export type InboxStatus = "accepted" | "rejected";

export interface InboxRecord {
  id: string;
  channel: ChannelName;
  accountId: string;
  platformEventId: string;
  ownerId?: string;
  conversationId?: string;
  platformConversationId: string;
  actorId: string;
  actorType: ActorType;
  eventType: string;
  chatType: ChatType;
  replyTo?: string;
  text?: string;
  status: InboxStatus;
  rejectReason?: string;
  occurredAt?: string;
  receivedAt: string;
  processedAt?: string;
  traceId: string;
}

export type OutboxPurpose =
  | "ack"
  | "status"
  | "clarify"
  | "approval"
  | "result"
  | "failure"
  | "reminder";

export type OutboxStatus =
  | "pending"
  | "sending"
  | "accepted"
  | "failed"
  | "unknown"
  | "needs_manual"
  | "cancelled";

export interface OutboxRecord {
  id: string;
  businessKey: string;
  ownerId: string;
  channel: ChannelName;
  accountId: string;
  conversationId: string;
  taskId?: string;
  purpose: OutboxPurpose;
  text: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  /** Inbox/task/action correlation id for the causal chain. */
  traceId?: string;
  platformMessageId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  deliveredAt?: string;
  readAt?: string;
}

export interface ReplyDraft {
  purpose: OutboxPurpose;
  text: string;
}

export interface DeliveryReceipt {
  businessKey: string;
  platformMessageId: string;
  acceptedAt: string;
}

export interface SendRequest {
  businessKey: string;
  channel: ChannelName;
  accountId: string;
  conversationId: string;
  ownerId: string;
  purpose: OutboxPurpose;
  text: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_external"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "cancelling"
  | "cancelled";

export type ProjectStatus = "active" | "revoked";

/**
 * Owner-scoped mapping between a stable local project key and one GitHub
 * repository. `repositoryId` is GitHub's immutable numeric id; the full name
 * is display/validation data and may change on rename.
 */
export interface ProjectBinding {
  id: string;
  ownerId: string;
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch: string;
  credentialRef: string;
  allowedPlanPaths: string[];
  status: ProjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Mandate {
  /** Resources the task may read, such as "chat" or "weather". */
  resources: string[];
  /** Tools the task may use, such as "weather.get". */
  tools: string[];
  /** Requested SKILL.md ids; the host resolves them to pinned digests. */
  skills?: string[];
  notes?: string;
  /** Optional project scope for project memories; absent means global. */
  project?: string;
}

/** Plugin identity pinned when a task revision is created. */
export interface TaskExtensionBinding {
  id: string;
  version: string;
  digest: string;
}

export interface SkillBinding {
  id: string;
  version: string;
  digest: string;
}

export interface SkillRejection {
  id: string;
  reason: string;
}

export type ExtensionPermissionDecision = "allow" | "require_approval" | "deny";

/**
 * Host-supplied narrowing policy. It only removes capabilities the Core
 * already granted; it never adds tools, resources or approvals.
 */
export interface ExtensionPolicy {
  plugins?: string[];
  skills?: string[];
  permissions?: Record<string, ExtensionPermissionDecision>;
}

export interface TaskExtensionSnapshot {
  catalogGeneration: number;
  plugins: TaskExtensionBinding[];
  skills?: SkillBinding[];
  rejectedSkills?: SkillRejection[];
  policy?: ExtensionPolicy;
}

export interface TaskRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  sourceKey: string;
  goal: string;
  completionCriteria: string;
  mandate: Mandate;
  revision: number;
  status: TaskStatus;
  priority: number;
  attempts: number;
  deadline?: string;
  budget?: Record<string, unknown>;
  resultRef?: string;
  lastError?: string;
  /** Program verifier output; absent for tasks that never reached ready. */
  verification?: TaskVerification;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  /** Set when this task was created by an authorized schedule policy. */
  schedulePolicyId?: string;
  /** Capability catalog identity pinned at task creation/revision. */
  extension?: TaskExtensionSnapshot;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persistent, versioned workflow plan. A plan never grants authority: every
 * step is limited by the parent task Mandate and the live capability catalog.
 */
export type PlanStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "superseded";

export type PlanStepStatus =
  | "blocked"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "needs_review"
  | "cancelled";

export interface PlanBudget {
  /** Bounded to 3–5 because the first plan runtime only supports small DAGs. */
  maxSteps: number;
  maxAttemptsPerStep: number;
  maxToolCalls?: number;
  maxCostUsd?: number;
  timeoutMs: number;
}

export interface PlanStepSpec {
  /** Stable model-facing key, for example "A" or "collect-evidence". */
  key: string;
  goal: string;
  dependsOn: string[];
  /** Subset of the parent task mandate tools. */
  tools: string[];
  /** Subset of the parent task mandate resources, including tool resources. */
  resources: string[];
  verifierId: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface PlanRecord {
  id: string;
  ownerId: string;
  parentTaskId: string;
  /** Parent task revision this plan was drafted against. */
  taskRevision: number;
  /** Highest parent task input seq covered by this plan. */
  inputSeq: number;
  planVersion: number;
  status: PlanStatus;
  projectKey?: string;
  /** Deterministic reference stamped on activation; absent for drafts. */
  approvedScopeRef?: string;
  budget: PlanBudget;
  createdAt: string;
  updatedAt: string;
}

export interface PlanStepRecord extends PlanStepSpec {
  id: string;
  planId: string;
  ordinal: number;
  maxAttempts: number;
  timeoutMs: number;
  status: PlanStepStatus;
  assignmentId?: string;
  attempts: number;
  evidenceRefs: string[];
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanView {
  plan: PlanRecord;
  steps: PlanStepRecord[];
}

export interface PlanStepDiff {
  key: string;
  change: "added" | "removed" | "changed" | "unchanged";
  /** Changed field names, for example ["dependsOn", "tools"]. */
  fields: string[];
}

export interface PlanDiff {
  parentTaskId: string;
  fromVersion: number;
  toVersion: number;
  steps: PlanStepDiff[];
  createdAt: string;
}

export type CompletionVerdict = "succeeded" | "needs_review" | "failed";

export interface TaskVerification {
  verifier: string;
  verifierVersion: string;
  verdict: CompletionVerdict;
  reason: string;
  /** Program checks that actually ran, not model claims. */
  checked: string[];
  /** Facts/evidence the verifier could not confirm. */
  missing: string[];
  /** References to persisted evidence (action/tool source), not free text. */
  evidenceRefs: string[];
  externalFactsVerified: boolean;
  verifiedAt: string;
}

export type TaskInputKind = "supplement";

/**
 * Immutable owner input for a task. `seq` is monotonic per task; an
 * Assignment records the highest seq it was dispatched with so a report can
 * never complete a task while newer input is still unread.
 */
export interface TaskInputRecord {
  id: string;
  taskId: string;
  seq: number;
  kind: TaskInputKind;
  /** Inbox id, the idempotency key for one platform message. */
  sourceInboxId?: string;
  actorId?: string;
  text: string;
  createdAt: string;
}

export type AssignmentStatus =
  | "active"
  | "reported"
  | "superseded"
  | "cancelled"
  | "expired";

export interface AssignmentRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  sessionId: string;
  attempt: number;
  status: AssignmentStatus;
  leaseUntil: string;
  fencingToken: number;
  /** Highest TaskInput seq included in this assignment's prompt. */
  dispatchedInputSeq: number;
  /** Highest TaskInput seq this assignment's report actually covered. */
  consumedInputSeq: number;
  report?: WorkerReport;
  createdAt: string;
  updatedAt: string;
}

export type ReportStatus =
  | "working"
  | "waiting_user"
  | "waiting_external"
  | "ready"
  | "failed";

export interface Evidence {
  kind: string;
  value: string;
}

export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
}

export type StateClaim =
  | {
      kind: "count";
      snapshotHash: string;
      /** Dot path into the snapshot, e.g. tasks.counts.running. */
      path: string;
      value: number;
    }
  | {
      kind: "task_status";
      snapshotHash: string;
      taskId: string;
      status: TaskStatus;
    }
  | {
      kind: "reminder_due";
      snapshotHash: string;
      reminderId: string;
      dueAt: string;
    };

export type GithubItemClaim = {
  kind: "github_item";
  repo: string;
  operation: "issues" | "pulls" | "commits";
  /** Issue/PR number or commit SHA, as a string. */
  item: string;
  field: "state" | "title" | "message" | "author" | "url" | "merged" | "draft" | "date";
  value: string | number | boolean;
};

/**
 * A fact from a typed read. `revision` is the commit SHA for file/tree/checks
 * and the observed head SHA for pull_files; stale receipts cannot satisfy it.
 */
export type GithubTypedClaim = {
  kind: "github_typed";
  repo: string;
  projectKey: string;
  operation: "file" | "tree" | "pull_files" | "checks";
  revision: string;
  /** Repository path, PR filename or check-run name. */
  target: string;
  field:
    | "exists"
    | "sha"
    | "type"
    | "status"
    | "conclusion"
    | "changes"
    | "contentIncludes";
  value: string | number | boolean;
};

export type GithubClaim = GithubItemClaim | GithubTypedClaim;

export type ProjectFindingClassification = "observed" | "inferred" | "unknown";
export type ProjectFindingSeverity = "critical" | "high" | "medium" | "low";

/**
 * A project-review finding. `observed` facts must resolve to a receipt at the
 * same repository/revision; `unknown` findings must explain the evidence gap.
 */
export interface ProjectFinding {
  id?: string;
  requirementRef: string;
  classification: ProjectFindingClassification;
  severity: ProjectFindingSeverity;
  repositoryId: number;
  commitSha: string;
  evidenceRefs: string[];
  expected: string;
  actual: string;
  impact: string;
  existingIssueMatches: number[];
  suggestedAction: string;
  evidenceGap?: string;
  path?: string;
  line?: number;
  sourceUrl?: string;
  coverage?: "complete" | "partial" | "unknown";
  truncated?: boolean;
  requiresOwnerApproval?: boolean;
}

/** A proposed issue write. Drafts never execute in the read-only phase. */
export interface IssueDraft {
  action: "create" | "update" | "comment";
  targetIssue?: number;
  title: string;
  body: string;
  findingIds: string[];
  /** Derived by the host from verified repo/revision/requirements. */
  idempotencyKey?: string;
  requiresOwnerApproval: true;
  beforeHash?: string;
}

export type IssueDraftStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded"
  | "executing"
  | "failed";

/**
 * Persisted, verifier-approved proposal for one GitHub issue write. The
 * snapshot binds payload, target, source task revision, repository identity
 * and credential epoch. Approval must match payloadHash exactly.
 */
export interface IssueDraftSnapshot {
  id: string;
  ownerId: string;
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  sourceTaskId: string;
  sourceTaskRevision: number;
  sourceAssignmentId: string;
  commitSha: string;
  findingIds: string[];
  action: "create" | "update" | "comment";
  targetIssue?: number;
  beforeHash?: string;
  /** Bounded excerpt of the issue body before the proposed write. */
  beforeSummary?: string;
  title: string;
  body: string;
  payloadHash: string;
  idempotencyKey: string;
  credentialRef: string;
  credentialVersion?: number;
  status: IssueDraftStatus;
  writeTaskId?: string;
  writeActionId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface WorkerReport {
  status: ReportStatus;
  summary: string;
  evidence: Evidence[];
  questions?: string[];
  proposedActions?: ProposedAction[];
  cost?: Record<string, unknown>;
  completionReason?: string;
  evidenceRef?: string;
  verifierVersion?: string;
  unverifiedClaims?: string[];
  /** Structured facts the program can compare with executor receipts. */
  stateClaims?: StateClaim[];
  githubClaims?: GithubClaim[];
  /** Read-only project-review output, verified against GitHub receipts. */
  findings?: ProjectFinding[];
  issueDrafts?: IssueDraft[];
}

export type ActionStatus =
  | "proposed"
  | "approved"
  | "denied"
  | "expired"
  | "superseded"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "reconciling"
  | "needs_manual";

export interface ActionRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  taskId: string;
  taskRevision: number;
  fencingToken: number;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  status: ActionStatus;
  expiresAt: string;
  nonce: string;
  approvedAt?: string;
  approvedBy?: string;
  executionAttempts: number;
  leaseUntil?: string;
  externalRef?: string;
  evidence?: Record<string, unknown>;
  lastError?: string;
  preauthorizationId?: string;
  /** Plan-scoped read authorization for tasks created by a schedule. */
  schedulePolicyId?: string;
  schedulePolicyVersion?: number;
  /** Plugin identity and catalog generation pinned at proposal time. */
  pluginId?: string;
  pluginVersion?: string;
  pluginDigest?: string;
  catalogGeneration?: number;
  /** Stable proposal origin; draft bridge writes must start with `draft:`. */
  sourceKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  actionId: string;
  decision: "approved" | "denied";
  approverId: string;
  conversationId: string;
  argsHash: string;
  taskRevision: number;
  nonce: string;
  consumedAt?: string;
  createdAt: string;
}

export type EffectStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface EffectRecord {
  id: string;
  kind: string;
  businessKey: string;
  payload: Record<string, unknown>;
  status: EffectStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleStatus = "pending" | "fired" | "cancelled" | "skipped";

export interface ScheduleRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  runKey: string;
  dueAt: string;
  timezone: string;
  text: string;
  purpose: "reminder";
  expiresAt: string;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

export type SchedulePolicyStatus =
  | "draft"
  | "active"
  | "paused"
  | "cancelled"
  | "expired";

export type ScheduleCadence = "daily" | "weekdays";

/**
 * An explicitly confirmed recurring task. The owner authorizes the exact
 * time, cadence, target conversation, read-only scope and goal; each
 * occurrence creates at most one Task with a deterministic source key.
 */
export interface SchedulePolicyRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  timezone: string;
  cadence: ScheduleCadence;
  /** Local wall-clock time in HH:MM. */
  localTime: string;
  repo: string;
  goal: string;
  status: SchedulePolicyStatus;
  version: number;
  expiresAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunStatus = "dispatched" | "skipped";

export interface SchedulePolicyRunRecord {
  policyId: string;
  scheduledAt: string;
  taskId?: string;
  status: ScheduleRunStatus;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  ownerId: string;
  project?: string;
  key: string;
  value: string;
  sourceEventId?: string;
  version: number;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export type ConfirmationKind = "memory_save" | "reminder_create";
export type ConfirmationStatus = "pending" | "confirmed" | "cancelled" | "expired";

/** A revocable owner grant for a bounded read-only tool scope. */
export interface PreauthorizationRecord {
  id: string;
  ownerId: string;
  tool: string;
  repo: string;
  status: "active" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A model-interpreted write awaiting the owner's explicit confirmation. */
export interface ConfirmationRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  sourceInboxId: string;
  kind: ConfirmationKind;
  payload: Record<string, unknown>;
  status: ConfirmationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type StateQueryTarget =
  | "summary"
  | "tasks"
  | "task"
  | "reminders"
  | "memories"
  | "schedules";

/**
 * Model-proposed read intent. The Router validates every field and reads
 * through StateReadService; the model never supplies state data itself.
 */
export interface StateQuery {
  target: StateQueryTarget;
  taskId?: string;
  /** Natural reference such as "刚才那个" or "第二个"; resolved by the program. */
  taskRef?: string;
  project?: string;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface ScheduleIntent {
  repo?: string;
  localTime?: string;
  cadence?: "daily" | "weekdays";
  goal?: string;
  timezone?: string;
  until?: string;
}

export type RouterAction =
  | "reply"
  | "create_task"
  | "supplement_task"
  | "revise_task"
  | "cancel_task"
  | "query_status"
  | "save_memory"
  | "forget_memory"
  | "remind"
  | "cancel_reminder"
  | "draft_schedule"
  | "confirm_schedule"
  | "cancel_schedule";

/** Non-authorizing classification of a plain reply. */
export type RouterReplyKind = "chat" | "clarify" | "plan_proposal";

export interface RouterDecision {
  action: RouterAction;
  text: string;
  /**
   * Set only for action=reply. `plan_proposal` is a text outline: it never
   * creates a Plan record, a Task, or an execution authorization.
   */
  replyKind?: RouterReplyKind;
  task?: {
    goal: string;
    completionCriteria: string;
    mandate?: Mandate;
    priority?: number;
  };
  taskId?: string;
  /** Natural task reference; the program resolves it against owner tasks. */
  taskRef?: string;
  /** Changes for an existing task; a revision bump invalidates old work. */
  changes?: {
    goal?: string;
    completionCriteria?: string;
    mandate?: Mandate;
    priority?: number;
  };
  /** Validated read intent. */
  query?: StateQuery;
  /** Model-proposed query that failed validation; ask instead of guessing. */
  queryError?: string;
  key?: string;
  value?: string;
  /** Optional project scope for memory intents; owner-visible at confirmation. */
  project?: string;
  dueAt?: string;
  timezone?: string;
  /** Natural reminder reference for cancellation. */
  reminderRef?: string;
  scheduleId?: string;
  /** Natural schedule reference for confirm/cancel. */
  scheduleRef?: string;
  schedule?: ScheduleIntent;
}

export interface RouterTaskContext {
  id: string;
  status: TaskStatus;
  goal: string;
  conversationId: string;
  project?: string;
}

/** One persisted message from this owner's side of a single conversation. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Source inbox row; set exactly when role is "user". */
  inboxId?: string;
  /** Source delivered outbox row; set exactly when role is "assistant". */
  outboxId?: string;
  /** Task input sequence when this message was accepted into a task. */
  taskInputSeq?: number;
}

export interface ConversationWindow {
  /** Oldest first; never includes the inbox currently being routed. */
  turns: ConversationTurn[];
  /** Eligible turns older than the window or dropped by the character cap. */
  omittedTurns: number;
  /** True when at least one included turn was shortened. */
  truncated: boolean;
}

export interface ConversationWindowQuery {
  ownerId: string;
  /** Internal pa_conversations id, not the platform conversation id. */
  conversationId: string;
  /** The message being routed; it is rendered separately as the live input. */
  excludeInboxId?: string;
  maxTurns: number;
  maxChars: number;
  maxTurnChars: number;
}

/** Router history defaults: small enough for cost, large enough for 6-turn chat. */
export const CONVERSATION_WINDOW_TURNS = 12;
export const CONVERSATION_WINDOW_CHARS = 4_000;
export const CONVERSATION_TURN_CHARS = 400;

export interface RouterInput {
  ownerId: string;
  conversationId: string;
  text: string;
  inboxId: string;
  /** Real owner-scoped candidates; the model may reference but not alter them. */
  taskContext?: RouterTaskContext[];
  /** Real owner-scoped project bindings; projectKey -> immutable repository. */
  projectContext?: RouterProjectContext[];
  /** Bounded transcript of this owner and conversation; continuity only. */
  conversationWindow?: ConversationWindow;
}

export interface RouterProjectContext {
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch: string;
}

export type Clock = () => Date;

export function iso(clock: Clock): string {
  return clock().toISOString();
}

export function plusMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}
