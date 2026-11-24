import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseStateEvidence } from "../src/actions/state.ts";
import { endOfLocalDay, nextScheduledAt } from "../src/personal/schedule-policies.ts";
import { openStore } from "../src/storage/node.ts";
import { createServices, sendText, type TestServices } from "./services.ts";

const START = "2026-01-01T00:00:00.000Z";

function clock(start = START) {
  let current = new Date(start);
  return {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}

function githubFixture() {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          full_name: "owner/repo",
          default_branch: "main",
          pushed_at: START,
          open_issues_count: 1,
          html_url: "https://github.com/owner/repo",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  };
}

function fixture(
  allowedRepos: string[] = ["owner/repo"],
  wake?: (at?: Date) => Promise<void>,
) {
  const time = clock();
  const github = githubFixture();
  const services = createServices({
    now: time.now,
    wake: wake === undefined ? undefined : { wake },
    github: {
      token: "secret",
      allowedRepos,
      fetch: github.fetch,
    },
  });
  return { services, time, github };
}

function createConfirmed(
  services: TestServices,
  overrides: Partial<Parameters<TestServices["schedulePolicy"]["createDraft"]>[2]> = {},
) {
  const draft = services.schedulePolicy.createDraft(
    services.owner.id,
    services.conversation.id,
    {
      repo: "owner/repo",
      localTime: "09:00",
      cadence: "daily",
      goal: "检查仓库进展",
      timezone: "UTC",
      until: "2026-01-05",
      ...overrides,
    },
  );
  if (!draft.ok) assert.fail(draft.reason);
  const confirmed = services.schedulePolicy.confirm(services.owner.id, draft.policy.id);
  if (!confirmed.ok) assert.fail(confirmed.reason);
  return confirmed.policy;
}

describe("schedule policy time calculation", () => {
  it("computes the next daily wall-clock occurrence in the policy timezone", () => {
    assert.equal(
      nextScheduledAt("2025-12-31T23:00:00.000Z", "Asia/Shanghai", "daily", "09:00"),
      "2026-01-01T01:00:00.000Z",
    );
  });

  it("skips a DST spring-forward gap instead of firing at a different time", () => {
    assert.equal(
      nextScheduledAt("2026-03-08T00:00:00.000Z", "America/New_York", "daily", "02:30"),
      "2026-03-09T06:30:00.000Z",
    );
  });

  it("resolves an ambiguous fall-back time to the first matching instant", () => {
    assert.equal(
      nextScheduledAt("2026-11-01T04:00:00.000Z", "America/New_York", "daily", "01:30"),
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("keeps the final local calendar day inclusive to its last millisecond", () => {
    assert.equal(endOfLocalDay("2026-01-05", "UTC"), "2026-01-05T23:59:59.999Z");
  });

  it("skips weekends for weekday plans", () => {
    assert.equal(
      nextScheduledAt("2026-01-02T15:00:00.000Z", "America/New_York", "weekdays", "09:00"),
      "2026-01-05T14:00:00.000Z",
    );
  });
});

describe("schedule policy lifecycle", () => {
  it("caps dispatched runs per UTC day and skips the rest", () => {
    const time = clock();
    const github = githubFixture();
    const services = createServices({
      now: time.now,
      maxScheduleRunsPerDay: 1,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
    });
    createConfirmed(services);
    const second = createConfirmed(services, { goal: "第二个计划" });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
    const runs = services.schedulePolicies.listRuns(second.id);
    assert.equal(runs[0]?.status, "skipped");
    assert.match(
      services.store
        .listAuditAfter(0, 100)
        .map((event) => event.event)
        .join(","),
      /schedule_policy.skipped/,
    );
  });

  it("requires confirmation before firing and creates one task per occurrence", () => {
    const { services, time } = fixture();
    const draft = services.schedulePolicy.createDraft(
      services.owner.id,
      services.conversation.id,
      {
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "daily",
        goal: "检查仓库进展",
        timezone: "UTC",
        until: "2026-01-05",
      },
    );
    assert.equal(draft.ok, true);
    if (!draft.ok) return;
    assert.equal(draft.policy.status, "draft");
    assert.equal(services.schedulePolicy.fireDue(), 0);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);

    assert.equal(
      services.schedulePolicy.confirm(services.owner.id, draft.policy.id).ok,
      true,
    );
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const tasks = services.tasks.listByOwner(services.owner.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.schedulePolicyId, draft.policy.id);
    assert.match(tasks[0]?.mandate.tools.join(",") ?? "", /github\.read/);

    // A duplicate alarm on the same occurrence must not create a second task.
    assert.equal(services.schedulePolicy.fireDue(), 0);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
    assert.equal(
      services.schedulePolicies.get(draft.policy.id)?.nextRunAt,
      "2026-01-02T09:00:00.000Z",
    );
    assert.equal(
      services.schedulePolicies.listRuns(draft.policy.id)[0]?.taskId,
      tasks[0]?.id,
    );

    time.set("2026-01-02T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 2);

    assert.equal(services.schedulePolicy.pause(services.owner.id, draft.policy.id).ok, true);
    time.set("2026-01-03T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 0);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 2);
  });

  it("fires a 23:59 occurrence on the inclusive expiry day", () => {
    const { services, time } = fixture();
    createConfirmed(services, { localTime: "23:59", until: "2026-01-01" });
    time.set("2026-01-01T23:59:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
  });

  it("skips occurrences missed by more than the grace window", () => {
    const { services, time } = fixture();
    const policy = createConfirmed(services);
    time.set("2026-01-03T12:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 0);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);
    const runs = services.schedulePolicies.listRuns(policy.id);
    assert.equal(runs[0]?.status, "skipped");
    assert.equal(
      services.schedulePolicies.get(policy.id)?.nextRunAt,
      "2026-01-04T09:00:00.000Z",
    );
  });

  it("rejects an out-of-plan repo instead of falling back to an approval card", () => {
    const { services, time } = fixture(["owner/repo", "other/repo"]);
    createConfirmed(services);
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);

    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "github.read", args: { operation: "repo", repo: "other/repo" } },
    ]);
    assert.equal(proposed.count, 0);
    assert.deepEqual(proposed.autoApprove, []);
    assert.equal(services.actions.listByTask(task.id).length, 0);
    assert.ok(
      !services.store
        .listRecentOutbox(10)
        .some((row) => row.text.includes("需要批准动作")),
    );
  });

  it("invalidates an active plan's read authorization when edited", () => {
    const { services, time, github } = fixture();
    const policy = createConfirmed(services);
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);

    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "github.read", args: { operation: "repo", repo: "owner/repo" } },
    ]);
    services.actionService.finalizeReportedActions(proposed.autoApprove);
    const action = services.actions.listByTask(task.id)[0];
    assert.ok(action);
    assert.equal(action.status, "approved");
    assert.equal(action.schedulePolicyId, policy.id);
    assert.equal(action.schedulePolicyVersion, policy.version);

    const edited = services.schedulePolicy.edit(
      services.owner.id,
      policy.id,
      {
        repo: "owner/repo",
        localTime: "10:00",
        cadence: "daily",
        goal: "检查仓库进展",
        timezone: "UTC",
        until: "2026-01-05",
      },
    );
    assert.equal(edited.ok, true);
    return services.actionService.handleExecute({ actionId: action.id }).then((outcome) => {
      assert.equal(outcome.status, "done");
      const after = services.actions.get(action.id);
      assert.equal(after?.status, "superseded");
      assert.equal(github.calls.length, 0);
    });
  });
});

describe("schedule policy commands", () => {
  it("requires /schedule confirm and shows the exact scope before activation", async () => {
    const wakeCalls: (Date | undefined)[] = [];
    const { services } = fixture(undefined, async (at) => {
      wakeCalls.push(at);
    });
    await sendText(
      services,
      "/schedule new owner/repo 09:00 daily 检查进展 --tz=UTC --until=2026-01-05",
      "evt_schedule_new",
    );
    const draftReply = services.store
      .listRecentOutbox(5)
      .find((row) => row.text.includes("计划草稿"));
    assert.ok(draftReply);
    assert.match(draftReply.text, /owner\/repo/);
    assert.match(draftReply.text, /09:00/);
    assert.match(draftReply.text, /2026-01-05/);
    const id = /\/schedule confirm ([0-9a-f-]+)/.exec(draftReply.text)?.[1];
    assert.ok(id);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);

    await sendText(services, `/schedule confirm ${id}`, "evt_schedule_confirm");
    const confirmed = services.store
      .listRecentOutbox(5)
      .find((row) => row.text.includes("已确认并激活"));
    assert.ok(confirmed);
    assert.match(confirmed.text, /\[active\]/);
    assert.equal(services.schedulePolicies.get(id)?.status, "active");
    assert.ok(wakeCalls.length > 0);
    assert.equal(wakeCalls.at(-1), undefined);
  });
});

describe("unattended budget gate", () => {
  it("does not fire a schedule when the daily model budget is unknown", () => {
    const time = clock();
    const github = githubFixture();
    const services = createServices({
      now: time.now,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
      unattendedBudgetKnown: false,
    });
    createConfirmed(services);
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 0);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);
    const events = services.store
      .listAuditAfter(0, 100)
      .filter((item) => item.event === "schedule_policy.skipped");
    assert.equal(events.length, 1);
  });
});

describe("schedule policy restart dedupe", () => {
  it("does not create a second task after reopening the same database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pa-schedule-restart-"));
    const path = join(directory, "agent.sqlite");
    const time = clock();
    const github = githubFixture();
    try {
      const firstStore = openStore(path);
      try {
        const services = createServices({
          store: firstStore,
          now: time.now,
          github: {
            token: "secret",
            allowedRepos: ["owner/repo"],
            fetch: github.fetch,
          },
        });
        createConfirmed(services);
        time.set("2026-01-01T09:00:00.000Z");
        assert.equal(services.schedulePolicy.fireDue(), 1);
        assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
      } finally {
        firstStore.close();
      }

      const secondStore = openStore(path);
      try {
        const services = createServices({
          store: secondStore,
          now: time.now,
          github: {
            token: "secret",
            allowedRepos: ["owner/repo"],
            fetch: github.fetch,
          },
        });
        assert.equal(services.schedulePolicy.fireDue(), 0);
        assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
        const policies = services.schedulePolicies.listByOwner(services.owner.id);
        assert.equal(policies.length, 1);
        assert.equal(services.schedulePolicies.listRuns(policies[0]!.id).length, 1);
      } finally {
        secondStore.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("weekly schedule policies", () => {
  it("computes the next matching weekday in the policy timezone", () => {
    assert.equal(
      nextScheduledAt("2026-01-01T00:00:00.000Z", "UTC", "weekly", "09:00", 1),
      "2026-01-05T09:00:00.000Z",
    );
  });

  it("requires a weekday for weekly and rejects one for other cadences", () => {
    const { services } = fixture();
    const missing = services.schedulePolicy.createDraft(
      services.owner.id,
      services.conversation.id,
      {
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "weekly",
        goal: "检查仓库进展",
        timezone: "UTC",
        until: "2026-01-20",
      },
    );
    assert.equal(missing.ok, false);
    const extra = services.schedulePolicy.createDraft(
      services.owner.id,
      services.conversation.id,
      {
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "daily",
        weekday: 1,
        goal: "检查仓库进展",
        timezone: "UTC",
        until: "2026-01-20",
      },
    );
    assert.equal(extra.ok, false);
  });

  it("fires once on the chosen weekday and advances by one week", () => {
    const { services, time } = fixture();
    const policy = createConfirmed(services, {
      cadence: "weekly",
      weekday: 1,
      until: "2026-01-20",
    });
    time.set("2026-01-05T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 1);
    assert.equal(
      services.schedulePolicies.get(policy.id)?.nextRunAt,
      "2026-01-12T09:00:00.000Z",
    );
    assert.equal(services.schedulePolicy.fireDue(), 0);
  });

  it("parses --dow in the slash command", async () => {
    const { services } = fixture();
    await sendText(
      services,
      "/schedule new owner/repo 09:00 weekly 检查进展 --dow=mon --tz=UTC --until=2026-01-20",
      "evt_schedule_weekly",
    );
    const draftReply = services.store
      .listRecentOutbox(5)
      .find((row) => row.text.includes("计划草稿"));
    assert.ok(draftReply);
    assert.match(draftReply.text, /每周周一/);
    assert.match(draftReply.text, /owner\/repo/);
  });
});

describe("internal status schedules", () => {
  it("creates a state-read task with no repo and auto-approves state.summary", () => {
    const { services, time } = fixture();
    const policy = createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-05",
    });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    assert.deepEqual(task.mandate.tools, ["state.summary"]);
    assert.deepEqual(task.mandate.resources, ["chat", "state"]);
    assert.equal(JSON.parse(task.completionCriteria).verifier, "state-read");
    assert.equal(task.schedulePolicyId, policy.id);

    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "state.summary", args: {} },
    ]);
    assert.equal(proposed.count, 1);
    assert.equal(proposed.autoApprove.length, 1);
    services.actionService.finalizeReportedActions(proposed.autoApprove);
    const action = services.actions.listByTask(task.id)[0];
    assert.equal(action?.status, "approved");
    assert.equal(action?.schedulePolicyId, policy.id);
    assert.equal(action?.schedulePolicyVersion, policy.version);
  });

  it("blocks an in-flight internal read when the plan is paused", async () => {
    const { services, time } = fixture();
    const policy = createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-05",
    });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "state.summary", args: {} },
    ]);
    services.actionService.finalizeReportedActions(proposed.autoApprove);
    const action = services.actions.listByTask(task.id)[0];
    assert.ok(action);
    assert.equal(services.schedulePolicy.pause(services.owner.id, policy.id).ok, true);
    const outcome = await services.actionService.handleExecute({ actionId: action.id });
    assert.equal(outcome.status, "done");
    assert.equal(services.actions.get(action.id)?.status, "superseded");
  });

  it("preserves the internal kind when an edit omits it", () => {
    const { services } = fixture();
    const policy = createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-05",
    });
    const edited = services.schedulePolicy.edit(services.owner.id, policy.id, {
      localTime: "10:00",
      cadence: "daily",
      goal: "新的内部状态汇总",
      timezone: "UTC",
      until: "2026-01-05",
    });
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    assert.equal(edited.policy.kind, "internal");
    assert.equal(edited.policy.repo, "");
    assert.equal(edited.policy.status, "draft");
    assert.equal(edited.policy.version, policy.version + 1);
  });

  it("completes a scheduled internal report through the state verifier", async () => {
    const { services, time } = fixture();
    createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-05",
    });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "state.summary", args: {} },
    ]);
    services.actionService.finalizeReportedActions(proposed.autoApprove);
    const action = services.actions.listByTask(task.id)[0];
    assert.ok(action);
    const outcome = await services.actionService.handleExecute({ actionId: action.id });
    assert.equal(outcome.status, "done");
    const settled = services.actions.get(action.id);
    assert.equal(settled?.status, "succeeded");
    const evidence = parseStateEvidence(settled?.evidence);
    assert.ok(evidence);
    const tasks = evidence.snapshot.tasks;
    assert.ok(typeof tasks === "object" && tasks !== null && "counts" in tasks);
    const counts = tasks.counts;
    assert.ok(typeof counts === "object" && counts !== null && "running" in counts);
    const running = counts.running;
    if (typeof running !== "number") {
      assert.fail("state.summary running count is not a number");
    }
    services.taskService.report(
      claimed.assignment.id,
      claimed.assignment.fencingToken,
      claimed.assignment.taskRevision,
      {
        status: "ready",
        summary: "内部状态日报",
        evidence: [{ kind: "state_snapshot", value: evidence.snapshotHash }],
        stateClaims: [
          {
            kind: "count",
            snapshotHash: evidence.snapshotHash,
            path: "tasks.counts.running",
            value: running,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.equal(current?.verification?.verifier, "state-read");
  });

  it("allows the final occurrence's internal read after the policy expires", () => {
    const { services, time } = fixture();
    createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-01",
    });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const policy = services.schedulePolicy.list(services.owner.id)[0];
    assert.ok(policy);
    assert.equal(policy.status, "expired");
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "state.summary", args: {} },
    ]);
    assert.equal(proposed.count, 1);
    assert.equal(proposed.autoApprove.length, 1);
  });

  it("rejects the final read after the policy expiry timestamp", () => {
    const { services, time } = fixture();
    createConfirmed(services, {
      kind: "internal",
      repo: undefined,
      goal: "汇总当前任务与提醒",
      until: "2026-01-01",
    });
    time.set("2026-01-01T09:00:00.000Z");
    assert.equal(services.schedulePolicy.fireDue(), 1);
    const task = services.tasks.listByOwner(services.owner.id)[0];
    assert.ok(task);
    time.set("2026-01-02T00:00:00.000Z");
    const claimed = services.tasks.claimNext(time.now().toISOString(), 60_000, 2);
    assert.ok(claimed);
    const proposed = services.actionService.proposeForReport(task, claimed.assignment, [
      { tool: "state.summary", args: {} },
    ]);
    assert.equal(proposed.count, 0);
    assert.equal(services.actions.listByTask(task.id).length, 0);
  });

  it("parses an explicit internal target when editing", async () => {
    const { services } = fixture();
    await sendText(
      services,
      "/schedule new internal 09:00 daily 汇总当前任务与提醒 --tz=UTC --until=2026-01-05",
      "evt_schedule_internal_new",
    );
    const policy = services.schedulePolicy.list(services.owner.id)[0];
    assert.ok(policy);
    await sendText(
      services,
      `/schedule edit ${policy.id} internal 10:00 daily 新的内部状态汇总 --tz=UTC --until=2026-01-05`,
      "evt_schedule_internal_edit",
    );
    const updated = services.schedulePolicies.get(policy.id);
    assert.equal(updated?.kind, "internal");
    assert.equal(updated?.status, "draft");
    assert.equal(updated?.localTime, "10:00");
  });

  it("rejects a repo on an internal plan and shows the internal target", async () => {
    const { services } = fixture();
    const draft = services.schedulePolicy.createDraft(
      services.owner.id,
      services.conversation.id,
      {
        kind: "internal",
        repo: "owner/repo",
        localTime: "09:00",
        cadence: "daily",
        goal: "汇总当前任务与提醒",
        timezone: "UTC",
        until: "2026-01-05",
      },
    );
    assert.equal(draft.ok, false);

    await sendText(
      services,
      "/schedule new internal 09:00 daily 汇总当前任务与提醒 --tz=UTC --until=2026-01-05",
      "evt_schedule_internal",
    );
    const draftReply = services.store
      .listRecentOutbox(5)
      .find((row) => row.text.includes("计划草稿"));
    assert.ok(draftReply);
    assert.match(draftReply.text, /内部状态/);
  });
});
