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
  | "failed"
  | "cancelling"
  | "cancelled";

export interface Mandate {
  /** Resources the task may read, such as "chat" or "weather". */
  resources: string[];
  /** Tools the task may use, such as "weather.get". */
  tools: string[];
  notes?: string;
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
  createdAt: string;
  updatedAt: string;
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

export interface WorkerReport {
  status: ReportStatus;
  summary: string;
  evidence: Evidence[];
  questions?: string[];
  proposedActions?: ProposedAction[];
  cost?: Record<string, unknown>;
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

export interface MemoryRecord {
  id: string;
  ownerId: string;
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

export type RouterAction =
  | "reply"
  | "create_task"
  | "supplement_task"
  | "revise_task"
  | "cancel_task"
  | "query_status"
  | "save_memory"
  | "remind";

export interface RouterDecision {
  action: RouterAction;
  text: string;
  task?: {
    goal: string;
    completionCriteria: string;
    mandate?: Mandate;
    priority?: number;
  };
  taskId?: string;
  /** Changes for an existing task; a revision bump invalidates old work. */
  changes?: {
    goal?: string;
    completionCriteria?: string;
    mandate?: Mandate;
    priority?: number;
  };
  key?: string;
  value?: string;
  dueAt?: string;
  timezone?: string;
}

export interface RouterInput {
  ownerId: string;
  conversationId: string;
  text: string;
  inboxId: string;
}

export type Clock = () => Date;

export function iso(clock: Clock): string {
  return clock().toISOString();
}

export function plusMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}
