import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActionRecord, TaskRecord } from "../src/domain/types.ts";
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
    assert.match(frame, /\[c\] cancel/);
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
