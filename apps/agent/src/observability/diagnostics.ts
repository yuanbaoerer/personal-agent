import type { ActionRepository } from "../storage/actions.ts";
import type { EffectRepository } from "../storage/effects.ts";
import type { Store } from "../storage/store.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { ConfirmationService } from "../personal/confirmations.ts";

export interface DiagnosticsDeps {
  store: Store;
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  confirmations: ConfirmationService;
}

export interface DiagnosticsSnapshot {
  generatedAt: string;
  ownerId?: string;
  tasks: {
    id: string;
    status: string;
    revision: number;
    attempts: number;
    updatedAt: string;
  }[];
  expiredAssignments: {
    id: string;
    taskId: string;
    attempt: number;
    leaseUntil: string;
  }[];
  unknownActions: {
    id: string;
    taskId: string;
    tool: string;
    status: string;
    updatedAt: string;
  }[];
  outbox: {
    id: string;
    businessKey: string;
    purpose: string;
    status: string;
    attempts: number;
    traceId?: string;
    createdAt: string;
    updatedAt: string;
  }[];
  effects: {
    pending: number;
    running: number;
    failed: number;
  };
  confirmations: {
    pending: number;
  };
}

/**
 * Build an operator-safe snapshot. Never include message text, goals, action
 * args, model output, credentials, or platform tokens.
 */
export function buildDiagnostics(
  deps: DiagnosticsDeps,
  now: string,
  options: { ownerId?: string; limit?: number } = {},
): DiagnosticsSnapshot {
  const limit = options.limit ?? 20;
  const tasks =
    options.ownerId === undefined
      ? deps.tasks.listRecent(limit)
      : deps.tasks.listByOwner(options.ownerId, limit);

  return {
    generatedAt: now,
    ownerId: options.ownerId,
    tasks: tasks.map((task) => ({
      id: task.id,
      status: task.status,
      revision: task.revision,
      attempts: task.attempts,
      updatedAt: task.updatedAt,
    })),
    expiredAssignments: deps.tasks
      .listExpiredAssignments(now, limit)
      .map((assignment) => ({
        id: assignment.id,
        taskId: assignment.taskId,
        attempt: assignment.attempt,
        leaseUntil: assignment.leaseUntil,
      })),
    unknownActions: deps.actions.listUnknown(limit).map((action) => ({
      id: action.id,
      taskId: action.taskId,
      tool: action.tool,
      status: action.status,
      updatedAt: action.updatedAt,
    })),
    outbox: deps.store
      .listOutboxDiagnostics(["unknown", "needs_manual", "failed"], limit, options.ownerId)
      .map((row) => ({
        id: row.id,
        businessKey: row.businessKey,
        purpose: row.purpose,
        status: row.status,
        attempts: row.attempts,
        traceId: row.traceId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    effects: {
      pending: deps.effects.count("pending"),
      running: deps.effects.count("running"),
      failed: deps.effects.count("failed"),
    },
    confirmations: {
      pending: deps.confirmations.countPending(options.ownerId),
    },
  };
}

export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const lines = [
    `诊断快照 ${snapshot.generatedAt}`,
    `任务：${snapshot.tasks.length} 条（最近）；过期 Assignment ${snapshot.expiredAssignments.length} 条；` +
      `未知 Action ${snapshot.unknownActions.length} 条。`,
    `Effect：pending ${snapshot.effects.pending}，running ${snapshot.effects.running}，failed ${snapshot.effects.failed}。`,
    `待确认项：${snapshot.confirmations.pending} 条。`,
  ];

  if (snapshot.expiredAssignments.length > 0) {
    lines.push("过期 Assignment：");
    for (const assignment of snapshot.expiredAssignments) {
      lines.push(
        `- ${assignment.id.slice(0, 8)} task ${assignment.taskId.slice(0, 8)} ` +
          `attempt ${assignment.attempt} lease ${assignment.leaseUntil}`,
      );
    }
  }

  if (snapshot.unknownActions.length > 0) {
    lines.push("未知 Action：");
    for (const action of snapshot.unknownActions) {
      lines.push(
        `- ${action.id.slice(0, 8)} task ${action.taskId.slice(0, 8)} ` +
          `${action.tool} ${action.status}`,
      );
    }
  }

  if (snapshot.outbox.length > 0) {
    lines.push("需核对投递：");
    for (const row of snapshot.outbox) {
      lines.push(
        `- ${row.id.slice(0, 8)} ${row.purpose} ${row.status} attempts ${row.attempts}` +
          `${row.traceId === undefined ? "" : ` trace ${row.traceId}`}`,
      );
    }
  } else {
    lines.push("需核对投递：无。");
  }

  lines.push("安全处理：先按 trace/平台回执核对，未知写禁止直接重放；不要粘贴密钥或私聊原文。");
  return lines.join("\n");
}
