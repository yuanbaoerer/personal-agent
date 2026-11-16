import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inbound } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const READY_REPORT = {
  status: "ready" as const,
  summary: "done",
  evidence: [{ kind: "test", value: "ok" }],
};

describe("task and assignment coordination", () => {
  it("creates a task through the Router and completes it through a Worker report", async () => {
    const services = createServices();
    services.model.push({
      action: "create_task",
      text: "已接单。",
      task: {
        goal: "整理资料",
        completionCriteria: "输出摘要",
        mandate: { resources: ["chat"], tools: [] },
      },
    });

    await sendText(services, "帮我整理这些资料", "evt_create");

    const tasks = services.tasks.listByOwner(services.owner.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "succeeded");
    assert.equal(tasks[0]?.resultRef, "fake result");
    assert.equal(services.runtime.opened.length, 1);
    assert.ok(services.store.countOutbox("pending") >= 2);
  });

  it("rejects a stale report after a revision and keeps the new revision queued", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:stale",
      goal: "v1",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(
      services.now().toISOString(),
      60_000,
      2,
    );
    assert.ok(claimed);

    services.taskService.revise(task.id, { goal: "v2" });
    const outcome = services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      READY_REPORT,
    );

    assert.equal(outcome.status, "done");
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "queued");
    assert.equal(current?.revision, 2);
    assert.equal(current?.goal, "v2");
  });

  it("gives a new assignment a higher fencing token after revision", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:fence",
      goal: "v1",
      completionCriteria: "done",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.revise(task.id, { goal: "v2" });
    const second = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(second);
    assert.ok(second.assignment.fencingToken > first.assignment.fencingToken);
  });

  it("persists cancellation before interrupting the runtime", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:cancel",
      goal: "cancel me",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const sessionId = "fake-session-cancel";
    services.tasks.setAssignmentSession(
      claimed.assignment.id,
      sessionId,
      services.now().toISOString(),
    );

    const cancelling = services.taskService.cancel(task.id);
    assert.equal(cancelling?.status, "cancelling");
    assert.equal(
      services.tasks.getAssignment(claimed.assignment.id)?.status,
      "cancelled",
    );

    await services.effectDispatcher.drain(50);
    assert.equal(services.tasks.get(task.id)?.status, "cancelled");
    assert.deepEqual(services.runtime.interrupted, [sessionId]);
  });

  it("does not emit cancel side effects for an already terminal task", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:cancel-terminal",
      goal: "already done",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");

    const outboxBefore = services.store.countOutbox("pending");
    const effectsBefore = services.effects.count("pending");
    const interruptedBefore = services.runtime.interrupted.length;

    const result = services.taskService.cancel(task.id);

    assert.equal(result?.status, "succeeded");
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
    assert.equal(services.store.countOutbox("pending"), outboxBefore);
    assert.equal(services.effects.count("pending"), effectsBefore);
    assert.equal(services.runtime.interrupted.length, interruptedBefore);
  });

  it("retries a wait while the runtime reports pending", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:pending-wait",
      goal: "slow worker",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);

    const calls: { sessionId: string; operationId: string; timeoutMs?: number }[] = [];
    services.runtime.wait = async (sessionId, operationId, timeoutMs) => {
      calls.push({ sessionId, operationId, timeoutMs });
      return { status: "pending" as const };
    };

    const outcome = await services.taskService.handleWait({
      assignmentId: claimed.assignment.id,
      sessionId: "fake-session-wait",
      operationId: `assignment:${claimed.assignment.id}`,
    });

    assert.equal(outcome.status, "retry");
    assert.equal(outcome.status === "retry" ? outcome.reason : "", "runtime still pending");
    assert.equal(calls[0]?.timeoutMs, 20_000);
    assert.equal(services.tasks.get(task.id)?.status, "running");
  });

  it("supplements a waiting_user task and requeues it", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:supplement",
      goal: "pick a room",
      completionCriteria: "lamp set",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      { status: "waiting_user", summary: "which room?", evidence: [] },
    );
    assert.equal(services.tasks.get(task.id)?.status, "waiting_user");

    const supplemented = services.taskService.supplement(
      task.id,
      "the living room",
      "evt_supplement_1",
    );
    assert.equal(supplemented?.task.status, "queued");
    assert.equal(supplemented?.input.seq, 1);
    assert.equal(supplemented?.input.text, "the living room");

    const again = services.taskService.supplement(
      task.id,
      "and the kitchen",
      "evt_supplement_2",
    );
    assert.equal(again?.input.seq, 2);
    assert.deepEqual(
      services.tasks.listInputs(task.id).map((input) => input.text),
      ["the living room", "and the kitchen"],
    );
    assert.ok(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a2`),
    );
  });

  it("does not duplicate an input for a retried platform message", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:supplement-idempotent",
      goal: "pick a room",
      completionCriteria: "lamp set",
    });

    const first = services.taskService.supplement(task.id, "the living room", "inbox:dup");
    const retry = services.taskService.supplement(task.id, "the living room", "inbox:dup");

    assert.equal(first?.inserted, true);
    assert.equal(retry?.inserted, false);
    assert.equal(retry?.input.seq, 1);
    assert.equal(services.tasks.listInputs(task.id).length, 1);
    assert.equal(
      services.effects
        .listPending()
        .filter((effect) => effect.payload.taskId === task.id).length,
      1,
    );
  });

  it("rejects a stale ready report until a new assignment covers the input", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13",
      goal: "summarize the folder",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    const other = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-other",
      goal: "summarize the archive",
      completionCriteria: "summary",
    });
    const otherAssignment = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(otherAssignment);
    assert.equal(otherAssignment.task.id, other.id);

    const added = services.taskService.supplement(
      task.id,
      "include the blue folder",
      "inbox:k13",
    );
    assert.equal(added?.task.status, "running");
    assert.equal(added?.input.seq, 1);

    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );

    assert.equal(services.tasks.get(task.id)?.status, "queued");
    assert.equal(
      services.tasks.getAssignment(first.assignment.id)?.consumedInputSeq,
      0,
    );

    services.taskService.report(
      otherAssignment.assignment.id,
      otherAssignment.assignment.fencingToken,
      otherAssignment.assignment.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(other.id)?.status, "succeeded");

    assert.equal((await services.taskService.handleDispatch({ taskId: task.id })).status, "done");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);
    assert.equal(second.dispatchedInputSeq, 1);
    assert.match(
      services.runtime.submissions.at(-1)?.text ?? "",
      /Owner input[^\n]*:\n#1 [^\n]*include the blue folder/,
    );

    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
    assert.equal(services.tasks.getAssignment(second.id)?.consumedInputSeq, 1);
  });

  it("does not steal a task from a newer assignment when a report replays", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-replay",
      goal: "long task",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.supplement(task.id, "late input", "inbox:k13-replay");
    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );

    assert.equal((await services.taskService.handleDispatch({ taskId: task.id })).status, "done");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);

    // The wait effect for `first` can replay after the barrier redispatched.
    const replay = services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );

    assert.equal(replay.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "running");
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a3`),
      undefined,
    );
    await services.taskService.handleDispatch({ taskId: task.id });
    assert.equal(services.runtime.opened.length, 1);
    assert.equal(services.tasks.listActiveAssignments(task.id).length, 1);
    assert.equal(services.tasks.listActiveAssignments(task.id)[0]?.id, second.id);

    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("re-enqueues dispatch when a duplicated supplement finds a queued task", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-crash-window",
      goal: "long task",
      completionCriteria: "summary",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      { status: "waiting_user", summary: "need details", evidence: [] },
    );
    // Remove the task's create-time dispatch; this key was already consumed
    // by the direct claim above. Simulate a crash after the input transaction
    // committed but before the next dispatch effect was enqueued.
    for (const effect of services.effects.listPending()) {
      services.effects.cancel(effect.id, services.now().toISOString());
    }
    const added = services.tasks.addInput({
      taskId: task.id,
      text: "accepted before the crash",
      sourceInboxId: "inbox:k13-crash-window",
      createdAt: services.now().toISOString(),
    });
    assert.equal(added?.inserted, true);
    assert.equal(services.tasks.get(task.id)?.status, "queued");
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a2`),
      undefined,
    );

    const retry = services.taskService.supplement(
      task.id,
      "accepted before the crash",
      "inbox:k13-crash-window",
    );

    assert.equal(retry?.inserted, false);
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a2`)?.status,
      "pending",
    );
  });

  it("does not requeue after a newer attempt has already reported", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-newer-report",
      goal: "long task",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.supplement(task.id, "late input", "inbox:k13-newer");
    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );
    assert.equal((await services.taskService.handleDispatch({ taskId: task.id })).status, "done");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);
    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      { status: "waiting_user", summary: "which folder?", evidence: [] },
    );
    assert.equal(services.tasks.get(task.id)?.status, "waiting_user");

    const replay = services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );

    assert.equal(replay.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "waiting_user");
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a3`),
      undefined,
    );
  });

  it("does not revive a cancelling task from a replayed report", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-cancelling",
      goal: "set the lamp",
      completionCriteria: "lamp set",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      {
        status: "ready",
        summary: "need approval",
        evidence: [{ kind: "test", value: "ok" }],
        proposedActions: [{ tool: "lamp.set_brightness", args: { brightness: 80 } }],
      },
    );
    const action = services.actions.listByTask(task.id)[0];
    assert.ok(action);
    services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.ok(
      services.actions.claimForExecution(action.id, services.now().toISOString(), 30_000),
    );
    services.taskService.supplement(task.id, "use 50 instead", "inbox:k13-cancel");
    services.taskService.cancel(task.id);
    assert.equal(services.tasks.get(task.id)?.status, "cancelling");

    const replay = services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      {
        status: "ready",
        summary: "stale proposal",
        evidence: [{ kind: "test", value: "ok" }],
        proposedActions: [{ tool: "lamp.set_brightness", args: { brightness: 80 } }],
      },
    );

    assert.equal(replay.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "cancelling");
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a2`),
      undefined,
    );
  });

  it("re-dispatches a failed report that never saw the supplement", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-failed-report",
      goal: "long task",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.supplement(task.id, "more detail", "inbox:k13-failed");

    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      { status: "failed", summary: "stale failure", evidence: [] },
    );

    assert.equal(services.tasks.get(task.id)?.status, "queued");
    const outcome = await services.taskService.handleDispatch({ taskId: task.id });
    assert.equal(outcome.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "running");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);
    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("fences the old report and keeps the input after a revision", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-revise",
      goal: "v1",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.supplement(task.id, "use the blue folder", "inbox:k13-revise");

    const revised = services.taskService.revise(task.id, { goal: "v2" });
    assert.equal(revised?.status, "queued");
    assert.equal(revised?.revision, 2);

    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "queued");

    assert.equal((await services.taskService.handleDispatch({ taskId: task.id })).status, "done");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);
    assert.equal(second.taskRevision, 2);
    assert.equal(second.dispatchedInputSeq, 1);
    assert.match(
      services.runtime.submissions.at(-1)?.text ?? "",
      /use the blue folder/,
    );
    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("requeues a fresh working report", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:working-report",
      goal: "long task",
      completionCriteria: "summary",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);

    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      { status: "working", summary: "still going", evidence: [] },
    );

    assert.equal(services.tasks.get(task.id)?.status, "queued");
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a2`)?.status,
      "pending",
    );
  });

  it("grants a supplemented task a work round beyond the retry cap", async () => {
    const services = createServices({ maxTaskAttempts: 1 });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:k13-attempt-budget",
      goal: "long task",
      completionCriteria: "summary",
    });
    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(first);
    services.taskService.supplement(task.id, "more detail", "inbox:k13-attempts");
    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );

    const outcome = await services.taskService.handleDispatch({ taskId: task.id });

    assert.equal(outcome.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "running");
    const second = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(second);
    services.taskService.report(
      second.id,
      second.fencingToken,
      second.taskRevision,
      READY_REPORT,
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("includes owner input in the next worker prompt", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:owner-input",
      goal: "set the lamp",
      completionCriteria: "lamp set",
    });
    services.taskService.supplement(task.id, "the living room");

    const outcome = await services.taskService.handleDispatch({ taskId: task.id });

    assert.equal(outcome.status, "done");
    assert.ok(services.runtime.submissions[0]?.text.includes("the living room"));
  });

  it("adopts a running assignment instead of dispatching a second worker", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:late-dispatch",
      goal: "keep working",
      completionCriteria: "done",
    });

    await services.taskService.handleDispatch({ taskId: task.id });
    const assignment = services.tasks.listActiveAssignments(task.id)[0];
    assert.ok(assignment);
    assert.notEqual(assignment.sessionId, "");

    const outcome = await services.taskService.handleDispatch({ taskId: task.id });

    assert.equal(outcome.status, "done");
    assert.equal(services.runtime.opened.length, 1);
    const waits = services.effects
      .listPending()
      .filter(
        (effect) =>
          effect.kind === "assignment.wait" &&
          effect.payload.assignmentId === assignment.id,
      );
    assert.equal(waits.length, 1);
  });

  it("fails a task when an expired assignment reaches the attempt limit", () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({ now: () => current });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:attempt-limit",
      goal: "never answers",
      completionCriteria: "done",
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = services.tasks.claimNext(current.toISOString(), 1_000, 2);
      assert.ok(claimed);
      current = new Date(current.getTime() + 2_000);
      services.taskService.sweep();
    }

    const failed = services.tasks.get(task.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 3);
    assert.ok(failed?.lastError?.includes("expired"));
    assert.equal(
      services.effects.getByBusinessKey(`task:${task.id}:dispatch:r1:a4`),
      undefined,
    );
  });

  it("fails a task past its deadline instead of dispatching", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({ now: () => current });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:deadline",
      goal: "too late",
      completionCriteria: "done",
      deadline: "2026-01-01T00:00:10.000Z",
    });

    current = new Date("2026-01-01T00:00:20.000Z");
    const outcome = await services.taskService.handleDispatch({ taskId: task.id });

    assert.equal(outcome.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "failed");
    assert.equal(services.runtime.opened.length, 0);
  });

  it("waits for an in-flight action after a revision before dispatching again", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:revise-in-flight",
      goal: "lamp v1",
      completionCriteria: "brightness set",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "lamp.set_brightness",
      args: { brightness: 30 },
    });
    assert.ok(action);
    services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.ok(
      services.actions.claimForExecution(
        action.id,
        services.now().toISOString(),
        30_000,
      ),
    );

    const revised = services.taskService.revise(task.id, { goal: "lamp v2" });
    assert.equal(revised?.revision, 2);
    assert.equal(revised?.status, "waiting_external");

    services.actions.markSucceeded(
      action.id,
      { brightness: 30 },
      undefined,
      services.now().toISOString(),
    );
    services.taskService.onActionSettled(task.id);
    assert.equal(services.tasks.get(task.id)?.status, "queued");
  });

  it("revises a running task through chat and fences the old assignment", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:revise-chat",
      goal: "v1 goal",
      completionCriteria: "v1 criteria",
    });
    const claimed = services.tasks.claimNext(
      services.now().toISOString(),
      60_000,
      2,
    );
    assert.ok(claimed);
    services.tasks.setAssignmentSession(
      claimed.assignment.id,
      "session-old",
      services.now().toISOString(),
    );

    await services.ingress.accept(
      inbound({
        platformEventId: "evt_revise_chat",
        text: `/修改 ${task.id.slice(0, 8)} 目标=v2 goal 完成条件=v2 criteria`,
      }),
    );

    const revised = services.tasks.get(task.id);
    assert.equal(revised?.revision, 2);
    assert.equal(revised?.goal, "v2 goal");
    assert.equal(revised?.completionCriteria, "v2 criteria");
    assert.equal(revised?.status, "queued");
    assert.equal(
      services.tasks.getAssignment(claimed.assignment.id)?.status,
      "superseded",
    );

    const stale = services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      READY_REPORT,
    );
    assert.equal(stale.status, "done");
    assert.equal(services.tasks.get(task.id)?.status, "queued");

    await services.effectDispatcher.drain(50);
    assert.deepEqual(services.runtime.interrupted, ["session-old"]);
    assert.equal(services.tasks.get(task.id)?.revision, 2);
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("revises through a model decision and rejects a terminal task", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:revise-model",
      goal: "v1 goal",
      completionCriteria: "v1 criteria",
    });
    services.model.push({
      action: "revise_task",
      text: "",
      taskId: task.id,
      changes: { goal: "v2 goal" },
    });
    await sendText(services, "把任务目标改成 v2 goal", "evt_revise_model");

    assert.equal(services.tasks.get(task.id)?.revision, 2);
    assert.equal(services.tasks.get(task.id)?.goal, "v2 goal");

    await sendText(services, `/修改 ${task.id.slice(0, 8)} 目标=too late`, "evt_revise_terminal");
    const terminal = services.tasks.get(task.id);
    assert.equal(terminal?.revision, 2);
    assert.equal(terminal?.goal, "v2 goal");
  });

  it("extends a live assignment lease while the runtime is pending", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({
      now: () => current,
      assignmentLeaseMs: 1_000,
      assignmentMaxLifetimeMs: 5_000,
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:heartbeat",
      goal: "long model call",
      completionCriteria: "done",
    });
    const claimed = services.tasks.claimNext(current.toISOString(), 1_000, 2);
    assert.ok(claimed);
    services.runtime.defaultAnswer = { status: "pending" };

    current = new Date(current.getTime() + 600);
    const outcome = await services.taskService.handleWait({
      assignmentId: claimed.assignment.id,
      sessionId: "real-session",
      operationId: "assignment:test",
    });
    assert.equal(outcome.status, "retry");
    const extended = services.tasks.getAssignment(claimed.assignment.id);
    assert.equal(extended?.status, "active");
    assert.ok(
      Date.parse(extended?.leaseUntil ?? "") >
        Date.parse(claimed.assignment.leaseUntil),
    );

    current = new Date(current.getTime() + 5_000);
    await services.taskService.handleWait({
      assignmentId: claimed.assignment.id,
      sessionId: "real-session",
      operationId: "assignment:test",
    });
    assert.equal(services.tasks.get(task.id)?.status, "failed");
    assert.match(services.tasks.get(task.id)?.lastError ?? "", /lifetime/);
  });

  it("never exceeds the worker cap", () => {
    const services = createServices({ maxActiveWorkers: 1 });
    for (const sourceKey of ["cap:1", "cap:2"]) {
      services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey,
        goal: sourceKey,
        completionCriteria: "done",
      });
    }

    const first = services.tasks.claimNext(services.now().toISOString(), 60_000, 1);
    assert.ok(first);
    assert.equal(
      services.tasks.claimNext(services.now().toISOString(), 60_000, 1),
      undefined,
    );

    services.taskService.report(
      first.assignment.id,
      first.assignment.fencingToken,
      first.assignment.taskRevision,
      READY_REPORT,
    );
    const second = services.tasks.claimNext(services.now().toISOString(), 60_000, 1);
    assert.ok(second);
    assert.notEqual(second.task.id, first.task.id);
  });
});

describe("approval and action execution", () => {
  function setupAction(options: { actionTtlMs?: number } = {}) {
    const services = createServices(options);
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:action",
      goal: "set the lamp",
      completionCriteria: "lamp is at the requested brightness",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "lamp.set_brightness",
      args: { brightness: 80 },
    });
    assert.ok(action);
    return { services, task, claimed, action };
  }

  it("consumes an approval once and executes the action", async () => {
    const { services, action } = setupAction();
    const first = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(first.ok, true);

    const second = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(second.reason, "action_approved");

    await services.effectDispatcher.drain(50);
    assert.equal(services.actions.get(action.id)?.status, "succeeded");
    assert.equal(services.lamp.getState().brightness, 80);
  });

  it("rejects a wrong nonce and a denied action", () => {
    const { services, action } = setupAction();
    const wrong = services.actionService.approve({
      actionId: action.id,
      nonce: "wrong",
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(wrong.reason, "nonce_mismatch");

    const denied = services.actionService.deny({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(denied.ok, true);
    assert.equal(services.actions.get(action.id)?.status, "denied");

    const afterDeny = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(afterDeny.reason, "action_denied");
  });

  it("rejects an expired approval", () => {
    const { services, action } = setupAction({ actionTtlMs: -1_000 });
    const result = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    assert.equal(result.reason, "action_expired");
    assert.equal(services.actions.get(action.id)?.status, "expired");
  });

  it("enters unknown after the effect landed, then reconciles to succeeded", async () => {
    const { services, action } = setupAction();
    services.lamp.failAfter = true;

    services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    await services.actionService.handleExecute({ actionId: action.id });

    assert.equal(services.actions.get(action.id)?.status, "unknown");
    assert.equal(services.lamp.getState().brightness, 80);

    services.lamp.failAfter = false;
    await services.effectDispatcher.drain(50);
    const settled = services.actions.get(action.id);
    assert.equal(settled?.status, "succeeded");
    assert.equal(settled?.evidence?.reconciled, true);
  });

  it("reprocesses a retried report without duplicating actions", () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:report-retry",
      goal: "lamp",
      completionCriteria: "brightness set",
      mandate: { resources: ["chat"], tools: ["lamp.set_brightness"] },
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const report = {
      status: "waiting_external" as const,
      summary: "propose the action",
      evidence: [{ kind: "test", value: "ok" }],
      proposedActions: [{ tool: "lamp.set_brightness", args: { brightness: 50 } }],
    };

    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      report,
    );
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      report,
    );

    assert.equal(services.actions.listByTask(task.id).length, 1);
  });

  it("keeps a task cancelling while an action is in flight, then cancels", () => {
    const { services, task, action } = setupAction();
    services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });
    const claimedAction = services.actions.claimForExecution(
      action.id,
      services.now().toISOString(),
      30_000,
    );
    assert.ok(claimedAction);

    services.taskService.cancel(task.id);
    assert.equal(services.tasks.get(task.id)?.status, "cancelling");

    services.actions.markSucceeded(
      action.id,
      { brightness: 80 },
      undefined,
      services.now().toISOString(),
    );
    services.taskService.onActionSettled(task.id);
    assert.equal(services.tasks.get(task.id)?.status, "cancelled");
  });
});

describe("chat routing integration", () => {
  it("resumes a waiting task with an 8-character task id and carries owner input", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "chat:supplement",
      goal: "plan a trip",
      completionCriteria: "a plan",
    });
    const claimed = services.tasks.claimNext(services.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      {
        status: "waiting_user",
        summary: "need the destination",
        evidence: [{ kind: "test", value: "ok" }],
        questions: ["Which city?"],
      },
    );
    assert.equal(services.tasks.get(task.id)?.status, "waiting_user");

    await sendText(
      services,
      `/补充 ${task.id.slice(0, 8)} Shanghai`,
      "evt_supplement",
    );

    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.equal(services.tasks.listInputs(task.id)[0]?.text, "Shanghai");
    assert.match(
      services.runtime.submissions.at(-1)?.text ?? "",
      /Owner input[^\n]*:\n#1 [^\n]*Shanghai/,
    );
  });

  it("cancels by the displayed task prefix", async () => {
    const services = createServices();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "chat:prefix-cancel",
      goal: "cancel by prefix",
      completionCriteria: "done",
    });

    await sendText(services, `/cancel ${task.id.slice(0, 8)}`, "evt_prefix_cancel");
    assert.equal(services.tasks.get(task.id)?.status, "cancelled");
  });

  it("lists and cancels reminders from chat", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({ now: () => current });
    await sendText(
      services,
      "/remind 2026-01-01T01:00:00.000Z drink tea",
      "evt_remind_create",
    );
    const schedule = services.schedules.listByOwner(services.owner.id)[0];
    assert.ok(schedule);

    await sendText(services, "/reminders", "evt_remind_list");
    const listed = services.store
      .listRecentOutbox(10)
      .some((row) => row.text.includes(schedule.id));
    assert.equal(listed, true);

    await sendText(
      services,
      `/cancel-reminder ${schedule.id}`,
      "evt_remind_cancel",
    );
    assert.equal(services.schedules.get(schedule.id)?.status, "cancelled");
  });
});

describe("reminders", () => {
  it("deduplicates a runKey and fires once", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({ now: () => current });

    const first = await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "drink water",
      dueAt: "2026-01-01T00:00:01.000Z",
      timezone: "Asia/Shanghai",
      runKey: "run:one",
    });
    const second = await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "drink water",
      dueAt: "2026-01-01T00:00:01.000Z",
      timezone: "Asia/Shanghai",
      runKey: "run:one",
    });
    assert.equal(second.id, first.id);

    current = new Date("2026-01-01T00:00:02.000Z");
    await services.reminders.fire(first.id);
    await services.reminders.fire(first.id);

    assert.equal(services.schedules.get(first.id)?.status, "fired");
    assert.ok(services.store.getOutboxByBusinessKey("reminder:run:one"));
  });

  it("skips an expired reminder without sending", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const services = createServices({ now: () => current });
    const schedule = await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "too late",
      dueAt: "2026-01-01T00:00:05.000Z",
      timezone: "Asia/Shanghai",
      runKey: "run:expired",
      ttlMs: 1_000,
    });

    current = new Date("2026-01-01T00:00:10.000Z");
    await services.reminders.fire(schedule.id);

    assert.equal(services.schedules.get(schedule.id)?.status, "skipped");
    assert.equal(services.store.getOutboxByBusinessKey("reminder:run:expired"), undefined);
  });

  it("does not fire a cancelled reminder", async () => {
    const services = createServices();
    const schedule = await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "cancel me",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: "Asia/Shanghai",
      runKey: "run:cancelled",
    });

    const cancelled = await services.reminders.cancel(schedule.id, services.owner.id);
    assert.equal(cancelled.ok, true);
    await services.reminders.fire(schedule.id);
    assert.equal(services.schedules.get(schedule.id)?.status, "cancelled");
    assert.equal(services.store.getOutboxByBusinessKey("reminder:run:cancelled"), undefined);
  });
});

describe("explicit memory", () => {
  it("saves, updates, lists and forgets one value", () => {
    const services = createServices();
    const first = services.memory.save(services.owner.id, "city", "Shanghai", "evt_1");
    assert.equal(first.version, 1);

    const updated = services.memory.save(services.owner.id, "city", "Beijing", "evt_2");
    assert.equal(updated.version, 2);
    assert.equal(services.memory.list(services.owner.id).length, 1);

    services.memory.forget(services.owner.id, "city");
    assert.equal(services.memory.list(services.owner.id).length, 0);
    assert.equal(services.memory.get(services.owner.id, "city")?.status, "deleted");
  });

  it("handles deterministic memory commands without the model", async () => {
    const services = createServices();
    await sendText(services, "/remember city=Shanghai", "evt_mem_1");
    assert.equal(services.memory.get(services.owner.id, "city")?.value, "Shanghai");

    await sendText(services, "/memory", "evt_mem_2");
    assert.ok(services.router.statusText(services.owner.id).includes("服务运行中"));

    await sendText(services, "/forget city", "evt_mem_3");
    assert.equal(services.memory.list(services.owner.id).length, 0);
  });
});
