import { randomUUID } from "node:crypto";
import { emitKeypressEvents } from "node:readline";

import { ClientApiClient } from "./client/sdk.ts";
import type { TaskDetail } from "./client/sdk.ts";
import type { ActionRecord, ScheduleRecord, TaskRecord } from "./domain/types.ts";

type Mode = "tasks" | "approvals" | "reminders";
type PendingAction =
  | { kind: "cancel"; taskId: string }
  | { kind: "approve" | "deny"; approval: ActionRecord }
  | { kind: "cancel-reminder"; reminderId: string }
  | undefined;

type InputState =
  | {
      kind: "supplement" | "revise";
      label: string;
      taskId: string;
      revision: number;
      value: string;
    }
  | {
      kind: "reminder";
      step: "text" | "due";
      label: string;
      value: string;
      reminderText?: string;
    }
  | {
      kind: "reminder-edit";
      label: string;
      reminderId: string;
      value: string;
    }
  | {
      kind: "reminder-due-edit";
      label: string;
      reminderId: string;
      value: string;
    };

export interface TuiState {
  mode: Mode;
  selected: number;
  tasks: TaskRecord[];
  approvals: ActionRecord[];
  reminders: ScheduleRecord[];
  detail?: TaskDetail;
  status?: unknown;
  input?: InputState;
  detailOffset: number;
  message: string;
  busy: boolean;
}

export function initialTuiState(): TuiState {
  return {
    mode: "tasks",
    selected: 0,
    tasks: [],
    approvals: [],
    reminders: [],
    detailOffset: 0,
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

function wrapText(value: string, width: number): string[] {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const limit = Math.max(1, width);
  const words = clean.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) return [""];
  // A single long token (URL/JSON) still must not overflow the row.
  return lines.flatMap((line) => {
    if (line.length <= limit) return [line];
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += limit) {
      chunks.push(line.slice(index, index + limit));
    }
    return chunks;
  });
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
  const controls =
    state.mode === "tasks"
      ? "Tasks  [tab] next  [j/k] select  [s] supplement  [v] revise  [c] cancel  [/] scroll  [r] refresh  [q] quit"
      : state.mode === "approvals"
        ? "Approvals  [tab] next  [j/k] select  [a] approve  [d] deny  [/] scroll  [r] refresh  [q] quit"
        : "Reminders  [tab] next  [j/k] select  [n] new  [e] edit  [d] due  [x] cancel  [/] scroll  [r] refresh  [q] quit";
  lines.push(truncate(controls, widthSafe));
  lines.push("─".repeat(widthSafe));

  const items =
    state.mode === "tasks"
      ? state.tasks
      : state.mode === "approvals"
        ? state.approvals
        : state.reminders;
  const maxRows = Math.max(3, Math.min(items.length, Math.floor(height * 0.45)));
  if (items.length === 0) {
    lines.push(
      state.mode === "tasks"
        ? "No tasks."
        : state.mode === "approvals"
          ? "No pending approvals."
          : "No reminders.",
    );
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
      } else if (state.mode === "approvals") {
        const action = item as ActionRecord;
        lines.push(
          truncate(
            `${index === selected ? ">" : " "} ${shortId(action.id)}  ${action.tool.padEnd(20)} ` +
              `task ${shortId(action.taskId)}  ${JSON.stringify(action.args)}`,
            widthSafe,
          ),
        );
      } else {
        const reminder = item as ScheduleRecord;
        lines.push(
          truncate(
            `${index === selected ? ">" : " "} ${shortId(reminder.id)}  ${reminder.status.padEnd(8)} ` +
              `${reminder.dueAt}  ${reminder.text}`,
            widthSafe,
          ),
        );
      }
    }
  }

  lines.push("─".repeat(widthSafe));
  const detailLines: string[] = [];
  if (state.mode === "tasks" && state.detail !== undefined) {
    const task = state.detail.task;
    detailLines.push(`Selected ${task.id}  ${task.status}  revision ${task.revision}`);
    detailLines.push(...wrapText(`goal: ${task.goal}`, widthSafe));
    detailLines.push(...wrapText(`criteria: ${task.completionCriteria}`, widthSafe));
    if (state.detail.actions.length > 0) {
      detailLines.push("actions:");
      for (const action of state.detail.actions) {
        detailLines.push(
          ...wrapText(`- ${shortId(action.id)} ${action.tool} ${action.status} ${JSON.stringify(action.args)}`, widthSafe),
        );
      }
    }
  } else if (state.mode === "reminders" && state.reminders.length > 0) {
    const reminder = state.reminders[Math.min(state.selected, state.reminders.length - 1)];
    if (reminder !== undefined) {
      detailLines.push(`Selected ${reminder.id}  ${reminder.status}`);
      detailLines.push(...wrapText(`due: ${reminder.dueAt}  timezone: ${reminder.timezone}`, widthSafe));
      detailLines.push(...wrapText(`text: ${reminder.text}`, widthSafe));
    }
  } else if (state.mode === "approvals" && state.approvals.length > 0) {
    const action = state.approvals[Math.min(state.selected, state.approvals.length - 1)];
    if (action !== undefined) {
      detailLines.push(`Selected ${action.id}  ${action.tool}`);
      detailLines.push(...wrapText(`args: ${JSON.stringify(action.args)}`, widthSafe));
      detailLines.push(...wrapText(`expires: ${action.expiresAt}`, widthSafe));
      detailLines.push(...wrapText(`nonce: ${action.nonce}`, widthSafe));
      detailLines.push(...wrapText(`binding: ${action.argsHash} rev ${action.taskRevision}`, widthSafe));
    }
  }
  const available = Math.max(0, Math.max(1, height) - lines.length - 1);
  if (available > 0 && detailLines.length > 0) {
    const maxOffset = Math.max(0, detailLines.length - available);
    const offset = Math.min(Math.max(0, state.detailOffset), maxOffset);
    const visible = detailLines.slice(offset, offset + available);
    if (offset > 0 && visible.length > 0) {
      visible[0] = truncate(`↑ ${visible[0]}`, widthSafe);
    }
    if (offset + available < detailLines.length && visible.length > 0) {
      visible[visible.length - 1] = truncate(`${visible[visible.length - 1]} ↓`, widthSafe);
    }
    lines.push(...visible);
  }
  const footer =
    state.input !== undefined
      ? truncate(`> ${state.input.label}: ${state.input.value}█`, widthSafe)
      : truncate(state.message, widthSafe);
  // Reserve the last row for the prompt/message; a short terminal must not
  // hide the input line behind task details.
  const body = lines.slice(0, Math.max(0, Math.max(1, height) - 1));
  body.push(footer);
  return body.join("\n");
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
      const reminders = await client.listReminders();
      state.status = status;
      state.tasks = tasks;
      state.approvals = approvals;
      state.reminders = reminders;
      const selected =
        state.mode === "tasks"
          ? tasks[state.selected]
          : state.mode === "approvals"
            ? approvals[state.selected]
            : reminders[state.selected];
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
      } else if (action.kind === "cancel-reminder") {
        await client.cancelReminder(action.reminderId);
        state.message = "Reminder cancelled.";
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

  const submitInput = async (input: InputState) => {
    if (input.kind === "reminder") return;
    state.busy = true;
    try {
      if (input.kind === "reminder-edit") {
        await client.updateReminder(input.reminderId, { text: input.value });
        state.message = "Reminder updated.";
      } else if (input.kind === "reminder-due-edit") {
        if (Number.isNaN(new Date(input.value).getTime())) {
          state.message = "Due time must be a valid ISO timestamp.";
          return;
        }
        await client.updateReminder(input.reminderId, {
          dueAt: new Date(input.value).toISOString(),
        });
        state.message = "Reminder due time updated.";
      } else if (input.kind === "supplement") {
        await client.supplementTask(input.taskId, input.value, randomUUID());
        state.message = "Supplement accepted.";
      } else {
        await client.reviseTask(input.taskId, {
          expectedRevision: input.revision,
          goal: input.value,
        });
        state.message = "Task revised.";
      }
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      await refresh();
    }
  };

  const submitReminder = async (text: string, dueAt: string) => {
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) {
      state.message = "Due time must be a valid ISO timestamp.";
      draw();
      return;
    }
    state.busy = true;
    try {
      await client.createReminder({
        text,
        dueAt: due.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      state.message = "Reminder created.";
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      await refresh();
    }
  };

  const handleInputKey = (
    str: string | undefined,
    key: { name?: string; ctrl?: boolean },
  ): boolean => {
    const input = state.input;
    if (input === undefined) return false;
    if (key.ctrl === true && key.name === "c") {
      finish();
      return true;
    }
    if (key.name === "escape") {
      state.input = undefined;
      state.message = "Input cancelled.";
      draw();
      return true;
    }
    if (key.name === "backspace") {
      input.value = input.value.slice(0, -1);
      draw();
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      if (input.value.trim().length === 0) {
        state.message = "Input cannot be empty.";
        draw();
        return true;
      }
      if (input.kind === "reminder-edit" || input.kind === "reminder-due-edit") {
        if (
          input.kind === "reminder-due-edit" &&
          Number.isNaN(new Date(input.value).getTime())
        ) {
          state.message = "Due time must be a valid ISO timestamp.";
          draw();
          return true;
        }
        state.input = undefined;
        state.message = "Updating reminder…";
        void submitInput(input);
        draw();
        return true;
      }
      if (input.kind === "reminder" && input.step === "text") {
        state.input = {
          kind: "reminder",
          step: "due",
          label: "Due at (ISO)",
          value: "",
          reminderText: input.value,
        };
        state.message = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`;
        draw();
        return true;
      }
      if (input.kind === "reminder" && Number.isNaN(new Date(input.value).getTime())) {
        state.message = "Due time must be a valid ISO timestamp.";
        draw();
        return true;
      }
      state.input = undefined;
      if (input.kind === "reminder") {
        state.message = "Creating reminder…";
        void submitReminder(input.reminderText ?? "", input.value);
      } else {
        state.message =
          input.kind === "supplement" ? "Submitting supplement…" : "Submitting revision…";
        void submitInput(input);
      }
      draw();
      return true;
    }
    if (str !== undefined && str.length > 0 && !/[\u0000-\u001f\u007f]/.test(str)) {
      if (input.value.length + str.length <= 10_000) {
        input.value += str;
        draw();
      }
      return true;
    }
    return true;
  };

  const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    if (closed) return;
    if (handleInputKey(str, key)) return;
    const name = key.name ?? str;
    if (key.ctrl === true && name === "c") {
      finish();
      return;
    }
    if (name === "q") {
      finish();
      return;
    }
    if (name === "tab") {
      const modes: Mode[] = ["tasks", "approvals", "reminders"];
      const next = (modes.indexOf(state.mode) + 1) % modes.length;
      state.mode = modes[next] ?? "tasks";
      state.selected = 0;
      state.detailOffset = 0;
      state.detail = undefined;
      state.message = "Switched view.";
      draw();
      void refresh();
      return;
    }
    if (name === "j" || name === "down") {
      state.detailOffset = 0;
      const length =
        state.mode === "tasks"
          ? state.tasks.length
          : state.mode === "approvals"
            ? state.approvals.length
            : state.reminders.length;
      if (length > 0) state.selected = Math.min(length - 1, state.selected + 1);
      draw();
      void refresh();
      return;
    }
    if (name === "k" || name === "up") {
      state.selected = Math.max(0, state.selected - 1);
      state.detailOffset = 0;
      draw();
      void refresh();
      return;
    }
    if (name === "[" || name === "pageup") {
      state.detailOffset = Math.max(0, state.detailOffset - 3);
      draw();
      return;
    }
    if (name === "]" || name === "pagedown") {
      state.detailOffset += 3;
      draw();
      return;
    }
    if (name === "g") {
      state.detailOffset = 0;
      draw();
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
    if ((name === "n" || name === "escape") && pending !== undefined) {
      pending = undefined;
      state.message = "Cancelled pending confirmation.";
      draw();
      return;
    }
    if ((name === "s" || name === "v") && state.mode === "tasks") {
      const task = state.tasks[state.selected];
      if (task === undefined) return;
      state.input = {
        kind: name === "s" ? "supplement" : "revise",
        label: name === "s" ? "Supplement" : "New goal",
        taskId: task.id,
        revision: task.revision,
        value: "",
      };
      state.message = "";
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
      return;
    }
    if (name === "e" && state.mode === "reminders") {
      const reminder = state.reminders[state.selected];
      if (reminder === undefined || reminder.status !== "pending") return;
      state.input = {
        kind: "reminder-edit",
        label: "New reminder text",
        reminderId: reminder.id,
        value: "",
      };
      state.message = "";
      draw();
      return;
    }
    if (name === "d" && state.mode === "reminders") {
      const reminder = state.reminders[state.selected];
      if (reminder === undefined || reminder.status !== "pending") return;
      state.input = {
        kind: "reminder-due-edit",
        label: "New due at (ISO)",
        reminderId: reminder.id,
        value: "",
      };
      state.message = "";
      draw();
      return;
    }
    if (name === "n" && state.mode === "reminders") {
      state.input = { kind: "reminder", step: "text", label: "Reminder text", value: "" };
      state.message = "";
      draw();
      return;
    }
    if (name === "x" && state.mode === "reminders") {
      const reminder = state.reminders[state.selected];
      if (reminder === undefined) return;
      pending = { kind: "cancel-reminder", reminderId: reminder.id };
      state.message = `Cancel reminder ${shortId(reminder.id)}? Press y to confirm.`;
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
