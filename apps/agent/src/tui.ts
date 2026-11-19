import { emitKeypressEvents } from "node:readline";

import { ClientApiClient } from "./client/sdk.ts";
import type { TaskDetail } from "./client/sdk.ts";
import type { ActionRecord, TaskRecord } from "./domain/types.ts";

type Mode = "tasks" | "approvals";
type PendingAction =
  | { kind: "cancel"; taskId: string }
  | { kind: "approve" | "deny"; approval: ActionRecord }
  | undefined;

export interface TuiState {
  mode: Mode;
  selected: number;
  tasks: TaskRecord[];
  approvals: ActionRecord[];
  detail?: TaskDetail;
  status?: unknown;
  message: string;
  busy: boolean;
}

export function initialTuiState(): TuiState {
  return {
    mode: "tasks",
    selected: 0,
    tasks: [],
    approvals: [],
    message: "Loading…",
    busy: true,
  };
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  // Goals and tool args are model/tool output; never let control characters
  // rewrite the terminal or inject ANSI sequences.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean.length <= width ? clean : `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function diagnosticsSummary(status: unknown): string {
  const value = status as
    | {
        diagnostics?: {
          tasks?: unknown[];
          unknownActions?: unknown[];
          effects?: Record<string, number>;
          confirmations?: { pending?: number };
          outbox?: unknown[];
        };
        usage?: { tasks?: Record<string, number> };
      }
    | undefined;
  const tasks = value?.usage?.tasks ?? {};
  const effects = value?.diagnostics?.effects ?? {};
  return (
    `queued ${tasks.queued ?? 0}  running ${tasks.running ?? 0}  ` +
    `waiting ${tasks.waiting_user ?? 0}  review ${tasks.needs_review ?? 0}  ` +
    `failed ${tasks.failed ?? 0}  | effects ${effects.pending ?? 0}/${effects.failed ?? 0}  ` +
    `unknown ${value?.diagnostics?.unknownActions?.length ?? 0}  ` +
    `confirm ${value?.diagnostics?.confirmations?.pending ?? 0}`
  );
}

/** Pure frame builder used by the real TTY loop and tests. */
export function renderFrame(state: TuiState, width: number, height: number): string {
  const widthSafe = Math.max(40, width);
  const lines: string[] = [];
  lines.push(`Personal Agent  ${state.busy ? "[busy]" : ""}`);
  lines.push(truncate(diagnosticsSummary(state.status), widthSafe));
  lines.push(
    state.mode === "tasks"
      ? "Tasks  [tab] approvals  [j/k] select  [c] cancel  [r] refresh  [q] quit"
      : "Approvals  [tab] tasks  [j/k] select  [a] approve  [d] deny  [r] refresh  [q] quit",
  );
  lines.push("─".repeat(widthSafe));

  const items = state.mode === "tasks" ? state.tasks : state.approvals;
  const maxRows = Math.max(3, Math.min(items.length, Math.floor(height * 0.45)));
  if (items.length === 0) {
    lines.push(state.mode === "tasks" ? "No tasks." : "No pending approvals.");
  } else {
    const selected = Math.min(state.selected, items.length - 1);
    const start = Math.max(0, Math.min(selected - maxRows + 1, items.length - maxRows));
    for (let index = start; index < Math.min(items.length, start + maxRows); index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      if (state.mode === "tasks") {
        const task = item as TaskRecord;
        lines.push(
          truncate(
            `${index === selected ? ">" : " "} ${shortId(task.id)}  ${task.status.padEnd(16)} ` +
              `rev ${task.revision}  ${task.goal}`,
            widthSafe,
          ),
        );
      } else {
        const action = item as ActionRecord;
        lines.push(
          truncate(
            `${index === selected ? ">" : " "} ${shortId(action.id)}  ${action.tool.padEnd(20)} ` +
              `task ${shortId(action.taskId)}  ${JSON.stringify(action.args)}`,
            widthSafe,
          ),
        );
      }
    }
  }

  lines.push("─".repeat(widthSafe));
  if (state.mode === "tasks" && state.detail !== undefined) {
    const task = state.detail.task;
    lines.push(truncate(`Selected ${task.id}  ${task.status}  revision ${task.revision}`, widthSafe));
    lines.push(truncate(`goal: ${task.goal}`, widthSafe));
    lines.push(truncate(`criteria: ${task.completionCriteria}`, widthSafe));
    if (state.detail.actions.length > 0) {
      lines.push("actions:");
      for (const action of state.detail.actions.slice(0, 5)) {
        lines.push(
          truncate(
            `- ${shortId(action.id)} ${action.tool} ${action.status}`,
            widthSafe,
          ),
        );
      }
    }
  } else if (state.mode === "approvals" && state.approvals.length > 0) {
    const action = state.approvals[Math.min(state.selected, state.approvals.length - 1)];
    if (action !== undefined) {
      lines.push(truncate(`Selected ${action.id}  ${action.tool}`, widthSafe));
      lines.push(truncate(`args: ${JSON.stringify(action.args)}`, widthSafe));
      lines.push(truncate(`expires: ${action.expiresAt}`, widthSafe));
      lines.push(truncate(`nonce: ${action.nonce}`, widthSafe));
      lines.push(truncate(`binding: ${action.argsHash} rev ${action.taskRevision}`, widthSafe));
    }
  }
  lines.push(truncate(state.message, widthSafe));
  return lines.slice(0, Math.max(1, height)).join("\n");
}

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Minimal read/approve/cancel TUI. It only speaks the authenticated Client
 * API; it does not open SQLite or create a second coordinator.
 */
export async function runTui(client: ClientApiClient, io: TuiIo = {
  stdin: process.stdin,
  stdout: process.stdout,
}): Promise<number> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new Error("pa tui requires an interactive terminal");
  }

  const state = initialTuiState();
  let pending: PendingAction;
  let closed = false;
  let refreshing = false;
  const width = () => Math.max(40, io.stdout.columns ?? 100);
  const height = () => Math.max(10, io.stdout.rows ?? 30);
  const draw = () => {
    if (closed) return;
    try {
      io.stdout.write(`\x1b[H\x1b[2J${renderFrame(state, width(), height())}`);
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
    }
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    state.busy = true;
    try {
      const status = await client.status();
      const tasks = await client.listTasks({ limit: 50 });
      const approvals = await client.listApprovals();
      state.status = status;
      state.tasks = tasks;
      state.approvals = approvals;
      const selected = state.mode === "tasks" ? tasks[state.selected] : approvals[state.selected];
      if (state.mode === "tasks" && selected !== undefined) {
        state.detail = await client.getTask(selected.id);
      } else if (state.mode === "tasks") {
        state.detail = undefined;
      }
      state.message = "Ready.";
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      refreshing = false;
      draw();
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    io.stdin.off("keypress", onKeypress);
    io.stdout.off("resize", draw);
    if (io.stdin.isTTY) io.stdin.setRawMode(false);
    io.stdin.pause();
    io.stdout.write("\x1b[?25h\x1b[?1049l");
  };

  const finish = () => {
    cleanup();
    resolveDone(0);
  };

  const executePending = async () => {
    if (pending === undefined) return;
    const action = pending;
    pending = undefined;
    state.busy = true;
    try {
      if (action.kind === "cancel") {
        await client.cancelTask(action.taskId);
        state.message = "Task cancellation requested.";
      } else {
        const binding = {
          nonce: action.approval.nonce,
          argsHash: action.approval.argsHash,
          taskRevision: action.approval.taskRevision,
        };
        if (action.kind === "approve") {
          await client.approve(action.approval.id, binding);
          state.message = "Action approved.";
        } else {
          await client.deny(action.approval.id, binding);
          state.message = "Action denied.";
        }
      }
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
    } finally {
      await refresh();
    }
  };

  const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    if (closed) return;
    const name = key.name ?? str;
    if ((key.ctrl === true && name === "c") || name === "q") {
      finish();
      return;
    }
    if (name === "tab") {
      state.mode = state.mode === "tasks" ? "approvals" : "tasks";
      state.selected = 0;
      state.detail = undefined;
      state.message = "Switched view.";
      draw();
      void refresh();
      return;
    }
    if (name === "j" || name === "down") {
      const length = state.mode === "tasks" ? state.tasks.length : state.approvals.length;
      if (length > 0) state.selected = Math.min(length - 1, state.selected + 1);
      draw();
      void refresh();
      return;
    }
    if (name === "k" || name === "up") {
      state.selected = Math.max(0, state.selected - 1);
      draw();
      void refresh();
      return;
    }
    if (name === "r") {
      state.message = "Refreshing…";
      draw();
      void refresh();
      return;
    }
    if (name === "y") {
      void executePending();
      return;
    }
    if (name === "n" || name === "escape") {
      pending = undefined;
      state.message = "Cancelled pending confirmation.";
      draw();
      return;
    }
    if (name === "c" && state.mode === "tasks") {
      const task = state.tasks[state.selected];
      if (task === undefined) return;
      pending = { kind: "cancel", taskId: task.id };
      state.message = `Cancel ${shortId(task.id)}? Press y to confirm.`;
      draw();
      return;
    }
    if ((name === "a" || name === "d") && state.mode === "approvals") {
      const approval = state.approvals[state.selected];
      if (approval === undefined) return;
      pending = { kind: name === "a" ? "approve" : "deny", approval };
      state.message = `${name === "a" ? "Approve" : "Deny"} ${shortId(approval.id)}? Press y to confirm.`;
      draw();
    }
  };

  const done = Promise.withResolvers<number>();
  const resolveDone = done.resolve;
  let timer: NodeJS.Timeout | undefined;
  emitKeypressEvents(io.stdin);
  io.stdout.write("\x1b[?1049h\x1b[?25l");
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.on("keypress", onKeypress);
  io.stdout.on("resize", draw);
  timer = setInterval(() => void refresh(), 2_000);
  draw();
  try {
    await refresh();
    return await done.promise;
  } catch (error) {
    cleanup();
    throw error;
  }
}
