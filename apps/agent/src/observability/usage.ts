import type {
  ActionStatus,
  EffectStatus,
  OutboxStatus,
  TaskStatus,
} from "../domain/types.ts";
import type { ActionRepository } from "../storage/actions.ts";
import type { ConfirmationService } from "../personal/confirmations.ts";
import type { EffectRepository } from "../storage/effects.ts";
import type { Store } from "../storage/store.ts";
import type { TaskRepository } from "../storage/tasks.ts";

export const TOKEN_COST_LINE_PREFIX = "token/费用：";

export interface UsageDeps {
  store: Store;
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  confirmations: ConfirmationService;
}

export interface UsageSnapshot {
  generatedAt: string;
  /** Token/cost accounting is not implemented yet; never invent amounts. */
  tokens: "not_collected";
  tasks: Record<TaskStatus, number>;
  effects: Record<EffectStatus, number>;
  actions: Record<ActionStatus, number>;
  actionsByTool: { tool: string; count: number }[];
  outbox: Record<OutboxStatus, number>;
  confirmations: Record<string, number>;
}

const TASK_STATUSES: TaskStatus[] = [
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
const EFFECT_STATUSES: EffectStatus[] = ["pending", "running", "done", "failed", "cancelled"];
const ACTION_STATUSES: ActionStatus[] = [
  "proposed",
  "approved",
  "denied",
  "expired",
  "superseded",
  "executing",
  "succeeded",
  "failed",
  "unknown",
  "reconciling",
  "needs_manual",
];
const OUTBOX_STATUSES: OutboxStatus[] = [
  "pending",
  "sending",
  "accepted",
  "failed",
  "unknown",
  "needs_manual",
  "cancelled",
];

export function buildUsage(deps: UsageDeps, now: string): UsageSnapshot {
  const tasks = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, deps.tasks.countByStatus(status)]),
  ) as Record<TaskStatus, number>;
  const effectCounts = deps.effects.statusCounts();
  const effects = Object.fromEntries(
    EFFECT_STATUSES.map((status) => [status, Number(effectCounts[status] ?? 0)]),
  ) as Record<EffectStatus, number>;
  const actionCounts = deps.actions.statusCounts();
  const actions = Object.fromEntries(
    ACTION_STATUSES.map((status) => [status, Number(actionCounts[status] ?? 0)]),
  ) as Record<ActionStatus, number>;
  const outbox = Object.fromEntries(
    OUTBOX_STATUSES.map((status) => [status, deps.store.countOutbox(status)]),
  ) as Record<OutboxStatus, number>;

  return {
    generatedAt: now,
    tokens: "not_collected",
    tasks,
    effects,
    actions,
    actionsByTool: deps.actions.countByTool(),
    outbox,
    confirmations: {
      ...deps.confirmations.statusCounts(),
      // Expired-but-unreaped rows are not actionable pending work.
      pending: deps.confirmations.countPending(),
    },
  };
}

export function formatUsage(snapshot: UsageSnapshot): string {
  const lines = [
    `用量快照 ${snapshot.generatedAt}`,
    `Task：排队 ${snapshot.tasks.queued}，运行 ${snapshot.tasks.running}，` +
      `成功 ${snapshot.tasks.succeeded}，待核对 ${snapshot.tasks.needs_review}，失败 ${snapshot.tasks.failed}。`,
    `Action：成功 ${snapshot.actions.succeeded}，失败 ${snapshot.actions.failed}，` +
      `unknown ${snapshot.actions.unknown}，需人工 ${snapshot.actions.needs_manual}。`,
    `Effect：pending ${snapshot.effects.pending}，running ${snapshot.effects.running}，` +
      `failed ${snapshot.effects.failed}。`,
    `Outbox：pending ${snapshot.outbox.pending}，accepted ${snapshot.outbox.accepted}，` +
      `unknown ${snapshot.outbox.unknown}，needs_manual ${snapshot.outbox.needs_manual}。`,
    `${TOKEN_COST_LINE_PREFIX}未采集（不展示估算金额）。`,
  ];
  if (snapshot.actionsByTool.length > 0) {
    lines.push("按工具：");
    for (const row of snapshot.actionsByTool) {
      lines.push(`- ${row.tool}: ${row.count}`);
    }
  }
  const pendingConfirmations = snapshot.confirmations.pending ?? 0;
  lines.push(`待确认项：${pendingConfirmations} 条。`);
  return lines.join("\n");
}
