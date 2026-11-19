import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatStateQuery,
  inferStateQuery,
  parseStateQuery,
  resolveReminderReference,
  resolveScheduleReference,
  resolveTaskReference,
} from "../src/coordinator/state-query.ts";
import {
  parseRouterDecision,
  routerPrompt,
} from "../src/coordinator/pi-router.ts";
import type { TaskRecord } from "../src/domain/types.ts";
import { createServices, sendText, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const TASK_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TASK_C = "cccccccc-0000-4000-8000-000000000003";

function setup(options: Parameters<typeof createServices>[0] = {}) {
  return createServices({ now: () => NOW, ...options });
}

function insertTask(
  services: TestServices,
  id: string,
  goal: string,
  options: {
    status?: TaskRecord["status"];
    createdAt?: string;
    conversationId?: string;
    project?: string;
  } = {},
): TaskRecord {
  const { task } = services.tasks.insert({
    ownerId: services.owner.id,
    conversationId: options.conversationId ?? services.conversation.id,
    sourceKey: `intent:${id}`,
    goal,
    completionCriteria: "done",
    mandate: {
      resources: ["chat"],
      tools: [],
      project: options.project,
    },
    createdAt: options.createdAt ?? NOW.toISOString(),
  });
  if (options.status !== undefined && options.status !== "queued") {
    services.tasks.updateTask(task.id, task.revision, {
      status: options.status,
      updatedAt: NOW.toISOString(),
    });
  }
  return services.tasks.get(task.id) as TaskRecord;
}

function outbox(services: TestServices): string {
  return services.store
    .listRecentOutbox(50)
    .map((row) => row.text)
    .join("\n");
}

describe("structured state query parsing", () => {
  it("accepts a validated task list filter", () => {
    assert.deepEqual(
      parseStateQuery({
        target: "tasks",
        status: "running",
        project: "alpha",
        limit: 3,
        offset: 1,
      }),
      {
        ok: true,
        query: {
          target: "tasks",
          status: "running",
          project: "alpha",
          limit: 3,
          offset: 1,
        },
      },
    );
  });

  it("rejects unknown targets, unsupported fields, and invalid values", () => {
    const unknownTarget = parseStateQuery({ target: "everything" });
    assert.equal(unknownTarget.ok, false);
    const unsupported = parseStateQuery({ target: "reminders", status: "running" });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) {
      assert.match(unsupported.reason, /不支持字段/);
    }
    const badLimit = parseStateQuery({ target: "tasks", limit: 99 });
    assert.equal(badLimit.ok, false);
    const badStatus = parseStateQuery({ target: "tasks", status: "done" });
    assert.equal(badStatus.ok, false);
    const badTaskId = parseStateQuery({ target: "task", taskId: "" });
    assert.equal(badTaskId.ok, false);
  });
});

describe("deterministic state query fallback", () => {
  it("distinguishes reminders, memories, schedules, tasks, and combined summary", () => {
    assert.deepEqual(inferStateQuery("我有哪些提醒"), { target: "reminders" });
    assert.deepEqual(inferStateQuery("查看项目 alpha 的记忆"), {
      target: "memories",
      project: "alpha",
    });
    assert.deepEqual(inferStateQuery("周期计划有哪些"), { target: "schedules" });
    assert.deepEqual(inferStateQuery("最近 3 个正在运行的任务"), {
      target: "tasks",
      status: "running",
      limit: 3,
    });
    assert.deepEqual(inferStateQuery("现在有哪些任务和提醒"), { target: "summary" });
  });

  it("does not steal mutations or vague analysis requests", () => {
    assert.equal(inferStateQuery("把刚才的任务目标修改一下"), undefined);
    assert.equal(inferStateQuery("刚才那个任务先停一下"), undefined);
    assert.equal(inferStateQuery("分析时再关注数据库性能"), undefined);
    assert.equal(inferStateQuery("第二个任务再关注数据库性能"), undefined);
    assert.equal(inferStateQuery("我的任务都完成了吗"), undefined);
    assert.equal(inferStateQuery("记住我喜欢咖啡"), undefined);
  });

  it("extracts an ordinal task reference without summarizing everything", () => {
    const query = inferStateQuery("第二个任务执行得怎么样了");
    assert.equal(query?.target, "task");
    assert.match(query?.taskRef ?? "", /第二/);
  });
});

describe("task reference resolution", () => {
  it("resolves ordinals in owner-visible newest-first order", () => {
    const services = setup();
    const older = insertTask(services, TASK_A, "older task", {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    insertTask(services, TASK_B, "newer task", {
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const second = resolveTaskReference(
      services.owner.id,
      services.conversation.id,
      "第二个任务",
      services.tasks,
    );
    assert.equal(second.status, "ok");
    if (second.status === "ok") {
      assert.equal(second.task.id, older.id);
    }
  });

  it("prefers the current conversation for deictic references", () => {
    const services = setup();
    const other = services.store.upsertConversation({
      ownerId: services.owner.id,
      channel: "feishu",
      accountId: services.conversation.accountId,
      platformConversationId: "other-chat",
      kind: "p2p",
      createdAt: NOW.toISOString(),
    });
    insertTask(services, TASK_A, "other conversation task", {
      conversationId: other.id,
      createdAt: "2026-01-01T00:05:00.000Z",
    });
    const current = insertTask(services, TASK_B, "current conversation task", {
      conversationId: services.conversation.id,
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const resolved = resolveTaskReference(
      services.owner.id,
      services.conversation.id,
      "刚才那个任务",
      services.tasks,
    );
    assert.equal(resolved.status, "ok");
    if (resolved.status === "ok") {
      assert.equal(resolved.task.id, current.id);
    }
  });

  it("reports ambiguity and never returns another owner's task", () => {
    const services = setup();
    const alpha = insertTask(services, TASK_A, "alpha task");
    const beta = insertTask(services, TASK_B, "beta task");
    const ambiguous = resolveTaskReference(
      services.owner.id,
      services.conversation.id,
      "任务",
      services.tasks,
    );
    assert.equal(ambiguous.status, "ambiguous");
    const otherOwner = services.store.bindOwner({
      channel: "feishu",
      accountId: "other-app",
      actorId: "other-actor",
      verifiedAt: NOW.toISOString(),
    });
    const foreign = services.tasks.insert({
      ownerId: otherOwner.id,
      conversationId: services.conversation.id,
      sourceKey: "intent:foreign",
      goal: "foreign task",
      completionCriteria: "done",
      mandate: { resources: ["chat"], tools: [] },
      createdAt: NOW.toISOString(),
    });
    const resolved = resolveTaskReference(
      services.owner.id,
      services.conversation.id,
      foreign.task.id,
      services.tasks,
    );
    assert.equal(resolved.status, "not_found");
  });
});

describe("natural language state intents", () => {
  it("does not create a reminder when a list question is misrouted as remind", async () => {
    const services = setup();
    services.model.push({
      action: "remind",
      text: "不该创建的提醒",
      dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: "UTC",
    });
    await sendText(services, "我有哪些提醒", "evt_intent_misroute_remind");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
    assert.match(outbox(services), /当前没有待发送提醒/);
  });

  it("returns only the requested reminder list and does not open a Worker", async () => {
    const services = setup();
    insertTask(services, TASK_A, "task should not be listed");
    await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "带上钥匙",
      dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: "UTC",
    });
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "reminders" },
    });
    await sendText(services, "我有哪些提醒", "evt_intent_reminders");
    const text = outbox(services);
    assert.match(text, /带上钥匙/);
    assert.doesNotMatch(text, /task should not be listed/);
    assert.equal(services.runtime.opened.length, 0);
    const audit = services.store.db.all<{ after_json: string }>(
      "SELECT after_json FROM pa_audit WHERE event = 'state.query' ORDER BY seq DESC LIMIT 1",
    )[0];
    assert.ok(audit);
    const after = JSON.parse(audit.after_json) as { tool?: string; target?: string };
    assert.equal(after.tool, "reminder.list");
    assert.equal(after.target, "reminders");
  });

  it("filters the task list by status and reports real task detail", async () => {
    const services = setup();
    insertTask(services, TASK_A, "queued goal");
    insertTask(services, TASK_B, "running goal", {
      status: "running",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "tasks", status: "running" },
    });
    await sendText(services, "查看正在运行的任务", "evt_intent_task_filter");
    let text = outbox(services);
    assert.match(text, /running goal/);
    assert.doesNotMatch(text, /queued goal/);

    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "task", taskRef: "第二个" },
    });
    await sendText(services, "第二个任务执行得怎么样了", "evt_intent_task_detail");
    text = outbox(services);
    assert.match(text, /任务 [0-9a-f-]{8,}/);
    assert.match(text, /queued goal/);
    assert.match(text, /版本：1/);
    assert.equal(services.runtime.opened.length, 0);
  });

  it("redirects a simple state summary away from a Worker even when tools are proposed", async () => {
    const services = setup();
    insertTask(services, TASK_A, "summary target");
    await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "summary reminder",
      dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: "UTC",
    });
    services.model.push({
      action: "create_task",
      text: "ok",
      task: {
        goal: "用三点总结当前任务和提醒状态",
        completionCriteria: "三点",
        mandate: { resources: ["chat", "state"], tools: ["reminder.list"] },
      },
    });
    await sendText(services, "用三点总结当前任务和提醒状态", "evt_intent_direct_summary");
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
    assert.equal(services.runtime.opened.length, 0);
    assert.match(outbox(services), /summary target/);
    assert.match(outbox(services), /summary reminder/);
  });

  it("rejects a project filter for owner-level reminder reads", async () => {
    const services = setup();
    await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "owner-level reminder",
      dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: "UTC",
    });
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "reminders" },
    });
    await sendText(services, "--project=alpha 我有哪些提醒", "evt_intent_reminder_project");
    const text = outbox(services);
    assert.match(text, /不支持项目范围/);
    assert.doesNotMatch(text, /owner-level reminder/);
  });

  it("answers a generic completion question as a summary, not a task lookup", async () => {
    const services = setup();
    insertTask(services, TASK_A, "completed looking task", {
      status: "succeeded",
    });
    services.model.push({ action: "reply", text: "不知道" });
    await sendText(services, "我的任务都完成了吗", "evt_intent_completion_summary");
    const text = outbox(services);
    assert.match(text, /任务：排队 0/);
    assert.match(text, /完成 1/);
    assert.doesNotMatch(text, /没有找到匹配该目标的任务/);
  });

  it("rejects two control mutations in one message", async () => {
    const services = setup();
    const first = insertTask(services, TASK_A, "first control");
    const second = insertTask(services, TASK_B, "second control");
    services.model.push({
      action: "cancel_task",
      text: "",
      taskId: first.id.slice(0, 8),
    });
    await sendText(
      services,
      "取消第一个任务，然后删除第二个任务",
      "evt_intent_two_controls",
    );
    assert.equal(services.tasks.get(first.id)?.status, "queued");
    assert.equal(services.tasks.get(second.id)?.status, "queued");
    assert.match(outbox(services), /复合请求/);
  });

  it("redirects a read question misrouted as cancel instead of mutating", async () => {
    const services = setup();
    const task = insertTask(services, TASK_A, "must survive", {
      status: "running",
    });
    services.model.push({
      action: "cancel_task",
      text: "",
      taskId: task.id.slice(0, 8),
    });
    await sendText(services, "这个任务执行得怎么样了", "evt_intent_misroute_cancel");
    assert.equal(services.tasks.get(task.id)?.status, "running");
    assert.match(outbox(services), /must survive/);
  });

  it("asks to split a compound mutation-plus-query request", async () => {
    const services = setup();
    const task = insertTask(services, TASK_A, "compound target", {
      status: "waiting_user",
    });
    services.model.push({
      action: "cancel_task",
      text: "",
      taskId: task.id.slice(0, 8),
    });
    await sendText(services, "取消这个任务，然后查看提醒", "evt_intent_compound");
    assert.equal(services.tasks.get(task.id)?.status, "waiting_user");
    assert.match(outbox(services), /复合请求/);
  });

  it("accepts an explicit task id prefix for reads and cancellation", async () => {
    const services = setup();
    const task = insertTask(services, TASK_A, "prefix target", {
      status: "waiting_user",
    });
    const prefix = task.id.slice(0, 8);
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "task", taskId: prefix },
    });
    await sendText(services, "这个任务的详情", "evt_intent_explicit_detail");
    assert.match(outbox(services), /prefix target/);

    services.model.push({ action: "cancel_task", text: "", taskId: prefix });
    await sendText(services, "取消这个任务", "evt_intent_explicit_cancel");
    assert.equal(services.tasks.get(task.id)?.status, "cancelled");
  });

  it("asks instead of guessing when a mutation reference is ambiguous", async () => {
    const services = setup();
    const alpha = insertTask(services, TASK_A, "alpha task");
    const beta = insertTask(services, TASK_B, "beta task");
    services.model.push({ action: "cancel_task", text: "" });
    await sendText(services, "把那个任务停一下", "evt_intent_ambiguous_cancel");
    const text = outbox(services);
    assert.match(text, /匹配到多个任务/);
    assert.match(text, /alpha task/);
    assert.match(text, /beta task/);
    assert.equal(services.tasks.get(alpha.id)?.status, "queued");
    assert.equal(services.tasks.get(beta.id)?.status, "queued");
  });

  it("adds input to the referenced task through the existing input path", async () => {
    const services = setup();
    const analysis = insertTask(services, TASK_A, "analysis task", {
      status: "waiting_user",
    });
    insertTask(services, TASK_B, "other task", {
      status: "cancelled",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    services.model.push({
      action: "supplement_task",
      text: "再关注数据库性能",
      taskRef: "刚才那个任务",
    });
    await sendText(services, "分析时再关注数据库性能", "evt_intent_supplement");
    const inputs = services.tasks.listInputs(analysis.id);
    assert.ok(inputs.some((input) => input.text === "再关注数据库性能"));
    assert.equal(inputs.length, 1);
  });

  it("cancels a unique active task without touching an ended task", async () => {
    const services = setup();
    const analysis = insertTask(services, TASK_A, "analysis task", {
      status: "waiting_user",
    });
    const ended = insertTask(services, TASK_B, "other task", {
      status: "cancelled",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    services.model.push({ action: "cancel_task", text: "" });
    await sendText(services, "刚才那个任务先停一下", "evt_intent_cancel");
    assert.equal(services.tasks.get(analysis.id)?.status, "cancelled");
    assert.equal(services.tasks.get(ended.id)?.status, "cancelled");
  });

  it("prefers the conversation's focused task over a newer active task", async () => {
    const services = setup();
    const focused = insertTask(services, TASK_A, "focused task", {
      status: "waiting_user",
    });
    const newer = insertTask(services, TASK_B, "newer task", {
      status: "waiting_user",
      createdAt: "2026-01-01T00:05:00.000Z",
    });
    services.store.metaSet(
      `router.task_focus:${services.conversation.id}`,
      focused.id,
    );
    services.model.push({ action: "cancel_task", text: "" });
    await sendText(services, "刚才那个任务先停一下", "evt_intent_focus");
    assert.equal(services.tasks.get(focused.id)?.status, "cancelled");
    assert.equal(services.tasks.get(newer.id)?.status, "waiting_user");
  });

  it("continues the previous task rather than creating a duplicate", async () => {
    const services = setup();
    const previous = insertTask(services, TASK_A, "previous analysis", {
      status: "waiting_user",
    });
    services.model.push({
      action: "supplement_task",
      text: "继续处理",
      taskRef: "之前那个任务",
    });
    await sendText(services, "继续处理之前那个任务", "evt_intent_continue");
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
    assert.ok(
      services.tasks
        .listInputs(previous.id)
        .some((input) => input.text === "继续处理"),
    );
  });

  it("revises the referenced task through TaskService and its revision fence", async () => {
    const services = setup();
    const task = insertTask(services, TASK_A, "old goal", {
      status: "waiting_user",
    });
    services.model.push({
      action: "revise_task",
      text: "",
      taskRef: "刚才那个任务",
      changes: { goal: "new goal" },
    });
    await sendText(services, "把刚才的任务目标修改一下", "evt_intent_revise");
    const revised = services.tasks.get(task.id);
    assert.equal(revised?.goal, "new goal");
    assert.equal(revised?.revision, 2);
  });

  it("rejects a revision that expands the task mandate", async () => {
    const services = setup();
    const task = insertTask(services, TASK_A, "fixed scope", {
      status: "waiting_user",
    });
    services.model.push({
      action: "revise_task",
      text: "",
      taskRef: "刚才那个任务",
      changes: {
        mandate: { resources: ["chat", "state"], tools: ["state.summary"] },
      },
    });
    await sendText(services, "给刚才那个任务加上状态读取权限", "evt_intent_expand");
    assert.equal(services.tasks.get(task.id)?.revision, 1);
    assert.match(outbox(services), /不能改变项目范围或增减任务授权/);
  });

  it("confirms memory save and forget instead of writing directly", async () => {
    const services = setup();
    services.model.push({
      action: "save_memory",
      text: "",
      key: "editor",
      value: "vim",
    });
    await sendText(services, "记住我喜欢用 vim", "evt_intent_memory_save");
    const pendingSave = services.confirmations.listPending(services.owner.id)[0];
    assert.ok(pendingSave);
    assert.equal(services.memory.get(services.owner.id, "editor"), undefined);
    await sendText(services, `/确认 ${pendingSave.id.slice(0, 8)}`, "evt_intent_memory_confirm");
    assert.equal(services.memory.get(services.owner.id, "editor")?.value, "vim");

    services.model.push({
      action: "forget_memory",
      text: "",
      key: "editor",
    });
    await sendText(services, "忘掉编辑器的偏好", "evt_intent_memory_forget");
    const pendingForget = services.confirmations.listPending(services.owner.id)[0];
    assert.ok(pendingForget);
    assert.equal(services.memory.get(services.owner.id, "editor")?.status, "active");
    await sendText(services, `/确认 ${pendingForget.id.slice(0, 8)}`, "evt_intent_memory_forget_confirm");
    assert.equal(services.memory.get(services.owner.id, "editor")?.status, "deleted");
  });

  it("finds a pending reminder past 20 fired history rows", async () => {
    const services = setup();
    const reminders = [];
    for (let index = 0; index < 21; index += 1) {
      reminders.push(
        await services.reminders.create({
          ownerId: services.owner.id,
          conversationId: services.conversation.id,
          text: `reminder ${index}`,
          dueAt: new Date(NOW.getTime() + (index + 1) * 3_600_000).toISOString(),
          timezone: "UTC",
        }),
      );
    }
    for (const reminder of reminders.slice(0, 20)) {
      services.schedules.markFired(reminder.id, NOW.toISOString());
    }
    const pending = reminders[20] as { id: string };
    services.model.push({
      action: "cancel_reminder",
      text: "",
      reminderRef: "reminder 20",
    });
    await sendText(services, "取消第二十一个提醒", "evt_intent_reminder_history");
    assert.equal(services.schedules.get(pending.id)?.status, "cancelled");
  });

  it("resolves a project-scoped ordinal within that project", async () => {
    const services = setup();
    insertTask(services, TASK_A, "beta newest", {
      createdAt: "2026-01-01T00:03:00.000Z",
      project: "beta",
    });
    insertTask(services, TASK_B, "alpha newest", {
      createdAt: "2026-01-01T00:02:00.000Z",
      project: "alpha",
    });
    insertTask(services, TASK_C, "alpha second", {
      createdAt: "2026-01-01T00:01:00.000Z",
      project: "alpha",
    });
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "task", taskRef: "第二个", project: "alpha" },
    });
    await sendText(services, "项目 alpha 的第二个任务怎么样了", "evt_intent_project_ordinal");
    const text = outbox(services);
    assert.match(text, /alpha second/);
    assert.doesNotMatch(text, /alpha newest/);
  });

  it("does not reject a read-only query that mentions a past control word", async () => {
    const services = setup();
    insertTask(services, TASK_A, "readable task");
    services.model.push({
      action: "query_status",
      text: "",
      query: { target: "tasks" },
    });
    await sendText(services, "任务停了吗，最近任务有哪些", "evt_intent_read_compound");
    const text = outbox(services);
    assert.doesNotMatch(text, /复合请求/);
    assert.match(text, /readable task/);
  });

  it("requires an explicit confirmation before activating a schedule", async () => {
    const services = setup({ github: { allowedRepos: ["owner/repo"] } });
    const draft = services.schedulePolicy.createDraft(
      services.owner.id,
      services.conversation.id,
      {
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "weekdays",
        goal: "确认守卫",
      },
    );
    assert.ok(draft.ok);
    const policy = draft.policy;
    services.model.push({
      action: "confirm_schedule",
      text: "",
      scheduleRef: policy.id.slice(0, 8),
    });
    await sendText(services, "那个计划怎么样", "evt_intent_schedule_confirm_guard");
    assert.equal(services.schedulePolicies.get(policy.id)?.status, "draft");
    assert.match(outbox(services), /需要明确确认/);
  });

  it("cancels a natural language reminder reference", async () => {
    const services = setup();
    const reminder = await services.reminders.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      text: "带上钥匙",
      dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: "UTC",
    });
    services.model.push({
      action: "cancel_reminder",
      text: "",
      reminderRef: "带上钥匙",
    });
    await sendText(services, "取消带钥匙的提醒", "evt_intent_reminder_cancel");
    assert.equal(services.schedules.get(reminder.id)?.status, "cancelled");
    assert.match(outbox(services), /提醒已取消/);
  });

  it("drafts, confirms, and cancels a schedule only through explicit steps", async () => {
    const services = setup({ github: { allowedRepos: ["owner/repo"] } });
    services.model.push({
      action: "draft_schedule",
      text: "",
      schedule: {
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "weekdays",
        goal: "总结昨天合并的 PR",
        timezone: "UTC",
      },
    });
    await sendText(services, "每个工作日九点总结 owner/repo 的合并 PR", "evt_intent_schedule_draft");
    const draft = services.schedulePolicy.list(services.owner.id)[0];
    assert.ok(draft);
    assert.equal(draft.status, "draft");
    assert.match(outbox(services), /未激活/);
    assert.match(outbox(services), /收件人/);

    services.model.push({
      action: "confirm_schedule",
      text: "",
      scheduleRef: draft.id.slice(0, 8),
    });
    await sendText(services, "确认刚才的计划", "evt_intent_schedule_confirm");
    const active = services.schedulePolicies.get(draft.id);
    assert.equal(active?.status, "active");
    assert.ok(active?.nextRunAt);

    services.model.push({
      action: "cancel_schedule",
      text: "",
      scheduleRef: "总结昨天合并的 PR",
    });
    await sendText(services, "取消那个周期计划", "evt_intent_schedule_cancel");
    assert.equal(services.schedulePolicies.get(draft.id)?.status, "cancelled");
  });

  it("asks for missing schedule fields instead of inventing them", async () => {
    const services = setup({ github: { allowedRepos: ["owner/repo"] } });
    services.model.push({
      action: "draft_schedule",
      text: "",
      schedule: { repo: "owner/repo", goal: "汇报" },
    });
    await sendText(services, "帮我设置一个周期汇报", "evt_intent_schedule_missing");
    assert.match(outbox(services), /请补充周期计划/);
    assert.equal(services.schedulePolicy.list(services.owner.id).length, 0);
  });
});

describe("router parity helpers", () => {
  it("parses structured query and reference fields from model JSON", () => {
    const decision = parseRouterDecision(
      JSON.stringify({
        action: "query_status",
        text: "",
        query: { target: "task", taskRef: "第二个", project: "alpha" },
      }),
    );
    assert.deepEqual(decision?.query, {
      target: "task",
      taskRef: "第二个",
      project: "alpha",
    });
  });

  it("records invalid query parameters for a clarification reply", () => {
    const decision = parseRouterDecision(
      JSON.stringify({
        action: "query_status",
        text: "",
        query: { target: "reminders", status: "running" },
      }),
    );
    assert.equal(decision?.query, undefined);
    assert.match(decision?.queryError ?? "", /不支持字段/);
  });

  it("tells the model to use specific targets and real task candidates", () => {
    const prompt = routerPrompt({
      ownerId: "owner",
      conversationId: "conversation",
      text: "第二个任务怎么样了",
      inboxId: "inbox",
      taskContext: [
        {
          id: TASK_A,
          status: "running",
          goal: "database analysis",
          conversationId: "conversation",
        },
      ],
    });
    assert.match(prompt, /"target":"summary\|tasks\|task\|reminders\|memories\|schedules"/);
    assert.match(prompt, /Recent owner tasks/);
    assert.match(prompt, new RegExp(TASK_A));
    assert.match(prompt, /do not guess/);
  });

  it("formats a task detail receipt without inventing fields", () => {
    const services = setup();
    const snapshot = services.state.read(
      "task.get",
      { ownerId: services.owner.id },
      { taskId: insertTask(services, TASK_A, "detail goal").id },
    );
    const text = formatStateQuery(snapshot, "UTC");
    assert.match(text, /detail goal/);
    assert.match(text, /任务/);
    assert.doesNotMatch(text, /细节猜测/);
  });
});
