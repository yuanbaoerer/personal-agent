import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActionRecord, ScheduleRecord, TaskRecord } from "../src/domain/types.ts";
import { initialTuiState, renderFrame } from "../src/tui.ts";

const task = {
  id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
  status: "queued",
  revision: 1,
  goal: "check the lamp",
  completionCriteria: "lamp changed",
  ownerId: "owner",
  conversationId: "conversation",
  sourceKey: "source",
  mandate: { resources: ["chat"], tools: [] },
  priority: 0,
  attempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as TaskRecord;

const action = {
  id: "abcdef12-aaaa-bbbb-cccc-dddddddddddd",
  taskId: task.id,
  taskRevision: 1,
  tool: "lamp.set_brightness",
  args: { brightness: 40 },
  argsHash: "hash",
  nonce: "nonce",
  status: "proposed",
  expiresAt: "2026-01-01T01:00:00.000Z",
  ownerId: "owner",
  conversationId: "conversation",
  fencingToken: 1,
  executionAttempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as ActionRecord;

const reminder = {
  id: "reminder-1",
  ownerId: "owner",
  conversationId: "conversation",
  runKey: "run-1",
  dueAt: "2026-11-20T09:00:00.000Z",
  timezone: "Asia/Shanghai",
  text: "drink water",
  purpose: "reminder",
  expiresAt: "2026-11-20T10:00:00.000Z",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as ScheduleRecord;

describe("TUI frame", () => {
  it("renders selected tasks and keeps the approval binding visible", () => {
    const state = initialTuiState();
    state.tasks = [task];
    state.detail = {
      task,
      assignments: [],
      actions: [action],
      inputs: [],
    };
    state.status = {
      usage: { tasks: { queued: 1 } },
      diagnostics: { unknownActions: [], effects: { pending: 0, failed: 0 } },
    };
    state.message = "Ready.";
    const frame = renderFrame(state, 100, 30);
    assert.match(frame, /> 12345678/);
    assert.match(frame, /check the lamp/);
    assert.match(frame, /lamp.set_brightness/);
    assert.match(frame, /\[s\] supplement/);
    assert.match(frame, /\[v\] revise/);
    assert.match(frame, /\[c\] cancel/);
  });

  it("renders a one-line supplement prompt without executing it", () => {
    const state = initialTuiState();
    state.tasks = [task];
    state.input = {
      kind: "supplement",
      label: "Supplement",
      taskId: task.id,
      revision: 1,
      value: "also check the plug",
    };
    state.message = "";
    const frame = renderFrame(state, 100, 30);
    assert.match(frame, /> Supplement: also check the plug/);
  });

  it("shows reminders and their create/cancel controls", () => {
    const state = initialTuiState();
    state.mode = "reminders";
    state.reminders = [reminder];
    state.status = { diagnostics: { effects: {} } };
    state.message = "Ready.";
    const frame = renderFrame(state, 100, 24);
    assert.match(frame, /Reminders/);
    assert.match(frame, /drink water/);
    assert.match(frame, /\[n\] new/);
    assert.match(frame, /\[e\] edit/);
    assert.match(frame, /\[d\] due/);
    assert.match(frame, /\[x\] cancel/);
  });

  it("wraps long detail and exposes a scroll indicator", () => {
    const state = initialTuiState();
    const longTask = {
      ...task,
      goal: "check a very long goal that must wrap across several terminal rows without overflowing",
      completionCriteria:
        "criteria that also needs wrapping and should remain visible while the detail viewport moves",
    } as TaskRecord;
    state.tasks = [longTask];
    state.detail = { task: longTask, assignments: [], actions: [action], inputs: [] };
    state.detailOffset = 1;
    state.status = { diagnostics: { effects: {} } };
    state.message = "Ready.";
    const frame = renderFrame(state, 52, 12);
    assert.match(frame, /↑/);
    assert.match(frame, /criteria|goal/);
  });

  it("keeps the prompt visible when the terminal is short", () => {
    const state = initialTuiState();
    state.tasks = [task];
    state.detail = { task, assignments: [], actions: [action], inputs: [] };
    state.input = {
      kind: "reminder",
      step: "due",
      label: "Due at (ISO)",
      value: "2026-11-20T09:00:00Z",
      reminderText: "drink water",
    };
    state.message = "";
    const frame = renderFrame(state, 60, 8);
    assert.match(frame, /> Due at \(ISO\): 2026-11-20T09:00:00Z/);
  });

  it("shows approval args and nonce without requiring another view", () => {
    const state = initialTuiState();
    state.mode = "approvals";
    state.approvals = [action];
    state.status = { diagnostics: { effects: {} } };
    state.message = "Ready.";
    const frame = renderFrame(state, 80, 24);
    assert.match(frame, /Approvals/);
    assert.match(frame, /brightness/);
    assert.match(frame, /nonce/);
    assert.match(frame, /\[a\] approve/);
  });
});
