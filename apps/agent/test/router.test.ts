import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeReminderCancelFailure,
  formatSchedules,
  normalizeGithubCriteria,
  resolveProjectMention,
  resolveTaskId,
  wantsProjectReview,
} from "../src/coordinator/router.ts";
import { parseRouterDecision, routerPrompt } from "../src/coordinator/pi-router.ts";
import { evaluateCompletion, parseWorkerReport } from "../src/coordinator/tasks.ts";
import type { ProjectBinding, ScheduleRecord, TaskRecord } from "../src/domain/types.ts";
import { createServices, sendText } from "./services.ts";

function taskRecord(id: string, ownerId = "owner"): TaskRecord {
  return {
    id,
    ownerId,
    conversationId: "conversation",
    sourceKey: `source:${id}`,
    goal: "goal",
    completionCriteria: "criteria",
    mandate: { resources: ["chat"], tools: [] },
    revision: 1,
    status: "waiting_user",
    priority: 0,
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function scheduleRecord(id: string, status: ScheduleRecord["status"] = "pending"): ScheduleRecord {
  return {
    id,
    ownerId: "owner",
    conversationId: "conversation",
    runKey: `inbox:${id}:reminder`,
    dueAt: "2026-01-01T09:00:00.000Z",
    timezone: "Asia/Shanghai",
    text: "带上钥匙",
    purpose: "reminder",
    expiresAt: "2026-01-02T00:00:00.000Z",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const TASK_A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK_A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const TASK_B = "bbbbbbbb-0000-4000-8000-000000000003";

function fakeTasks(items: TaskRecord[]) {
  return {
    get(id: string): TaskRecord | undefined {
      return items.find((task) => task.id === id);
    },
    listByOwner(owner: string): TaskRecord[] {
      return items.filter((task) => task.ownerId === owner);
    },
  };
}

describe("router decision parsing", () => {
  it("parses a task decision and filters tools outside the allowlist", () => {
    const decision = parseRouterDecision(
      JSON.stringify({
        action: "create_task",
        text: "ok",
        task: {
          goal: "set lamp",
          completionCriteria: "brightness 50",
          mandate: { resources: ["chat", "shell"], tools: ["lamp.set_brightness", "shell.exec"] },
        },
      }),
    );

    assert.equal(decision?.action, "create_task");
    assert.deepEqual(decision?.task?.mandate?.resources, ["chat"]);
    assert.deepEqual(decision?.task?.mandate?.tools, ["lamp.set_brightness"]);
  });

  it("preserves the read-only github capability in a task mandate", () => {
    const decision = parseRouterDecision(
      JSON.stringify({
        action: "create_task",
        text: "ok",
        task: {
          goal: "summarize PRs",
          completionCriteria: "with source URLs",
          mandate: {
            resources: ["chat", "github", "shell"],
            tools: ["github.read", "github.write"],
          },
        },
      }),
    );

    assert.deepEqual(decision?.task?.mandate?.resources, ["chat", "github"]);
    assert.deepEqual(decision?.task?.mandate?.tools, ["github.read"]);
  });

  it("parses a supplement_task decision with its task id and answer", () => {
    const decision = parseRouterDecision(
      '{"action":"supplement_task","taskId":"aaaaaaaa-0000-4000-8000-000000000001","text":"明天下午三点"}',
    );

    assert.equal(decision?.action, "supplement_task");
    assert.equal(decision?.taskId, TASK_A1);
    assert.equal(decision?.text, "明天下午三点");
  });

  it("parses a revise_task decision and its changes", () => {
    const decision = parseRouterDecision(
      JSON.stringify({
        action: "revise_task",
        taskId: "task-1",
        changes: {
          goal: "new goal",
          completionCriteria: "new criteria",
          priority: 2,
        },
      }),
    );
    assert.equal(decision?.action, "revise_task");
    assert.equal(decision?.taskId, "task-1");
    assert.deepEqual(decision?.changes, {
      goal: "new goal",
      completionCriteria: "new criteria",
      priority: 2,
    });
  });

  it("rejects an unknown action and a non-JSON answer", () => {
    assert.equal(parseRouterDecision('{"action":"delete_everything"}'), undefined);
    assert.equal(parseRouterDecision("not json"), undefined);
  });

  it("includes the owner message in the prompt", () => {
    const prompt = routerPrompt({
      ownerId: "owner",
      conversationId: "conversation",
      text: "hello",
      inboxId: "inbox",
    });
    assert.match(prompt, /Owner message: hello/);
    assert.match(prompt, /revise_task/);
  });

  it("allows supplement_task and requires explicit memory and reminder intent", () => {
    const prompt = routerPrompt({
      ownerId: "owner",
      conversationId: "conversation",
      text: "hello",
      inboxId: "inbox",
    });
    assert.match(prompt, /"action":"supplement_task"/);
    assert.match(prompt, /Use save_memory only when the owner explicitly asks/);
    assert.match(prompt, /Use remind only when the owner explicitly asks/);
    assert.match(prompt, /Never infer personal facts/);
    assert.match(prompt, /ask for confirmation/);
  });
});

describe("task id resolution", () => {
  const tasks = fakeTasks([taskRecord(TASK_A1), taskRecord(TASK_A2), taskRecord(TASK_B)]);

  it("resolves an exact id and a unique prefix", () => {
    assert.deepEqual(resolveTaskId("owner", TASK_A1, tasks), { status: "ok", id: TASK_A1 });
    assert.deepEqual(resolveTaskId("owner", "bbbb", tasks), { status: "ok", id: TASK_B });
    assert.deepEqual(resolveTaskId("owner", "  bbbbbbbb  ", tasks), { status: "ok", id: TASK_B });
  });

  it("reports an ambiguous prefix and a missing task", () => {
    assert.deepEqual(resolveTaskId("owner", "aaaa", tasks), {
      status: "ambiguous",
      ids: [TASK_A1, TASK_A2],
    });
    assert.deepEqual(resolveTaskId("owner", "cccc", tasks), { status: "not_found" });
    assert.deepEqual(resolveTaskId("owner", "", tasks), { status: "not_found" });
  });

  it("does not resolve tasks owned by someone else", () => {
    assert.deepEqual(resolveTaskId("intruder", TASK_B, tasks), { status: "not_found" });
    assert.deepEqual(resolveTaskId("intruder", "bbbb", tasks), { status: "not_found" });
  });
});

describe("reminder command formatting", () => {
  it("lists reminders with full id, status, due time, and text", () => {
    const text = formatSchedules([scheduleRecord(TASK_B), scheduleRecord(TASK_A1, "fired")]);
    assert.match(text, new RegExp(TASK_B));
    assert.match(text, /pending/);
    assert.match(text, /2026-01-01T09:00:00\.000Z/);
    assert.match(text, /带上钥匙/);
    assert.match(text, /fired/);
  });

  it("reports an empty reminder list", () => {
    assert.equal(formatSchedules([]), "当前没有提醒。");
  });

  it("explains why a reminder cannot be cancelled", () => {
    assert.equal(describeReminderCancelFailure("not_owner"), "找不到属于你的该提醒。");
    assert.equal(describeReminderCancelFailure("schedule_not_found"), "找不到属于你的该提醒。");
    assert.match(describeReminderCancelFailure("schedule_fired"), /fired/);
  });
});

describe("worker report validation", () => {
  it("parses a report wrapped in prose and rejects a completion without evidence", () => {
    const report = parseWorkerReport(
      'Here is the result: {"status":"ready","summary":"ok","evidence":[{"kind":"db","value":"row"}]}',
    );
    assert.equal(report?.status, "ready");
    assert.equal(
      evaluateCompletion({ completionCriteria: "text" }, report as NonNullable<typeof report>)
        .ok,
      true,
    );

    const empty = parseWorkerReport(
      '{"status":"ready","summary":"ok","evidence":[]}',
    );
    assert.equal(
      evaluateCompletion({ completionCriteria: "text" }, empty as NonNullable<typeof empty>)
        .ok,
      false,
    );

    assert.equal(
      evaluateCompletion(
        { completionCriteria: '{"requiredEvidenceKinds":["weather"]}' },
        report as NonNullable<typeof report>,
      ).ok,
      false,
    );
  });

  it("rejects an invalid status or missing fields", () => {
    assert.equal(parseWorkerReport('{"status":"done"}'), undefined);
    assert.equal(parseWorkerReport("no json"), undefined);
  });

  it("parses review findings and derives draft idempotency keys", () => {
    const sha = "a".repeat(40);
    const report = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "review",
        evidence: [{ kind: "github", value: "https://github.com/owner/repo" }],
        findings: [
          {
            id: "f1",
            requirementRef: "GH-02",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: sha,
            evidenceRefs: ["https://github.com/owner/repo/blob/" + sha + "/a.ts"],
            expected: "pinned",
            actual: "unpinned",
            impact: "stale evidence",
            existingIssueMatches: [60],
            suggestedAction: "pin evidence",
          },
        ],
        issueDrafts: [
          {
            action: "update",
            targetIssue: 60,
            title: "Pin evidence",
            body: "Body",
            findingIds: ["f1"],
            requiresOwnerApproval: true,
          },
        ],
      }),
    );
    assert.equal(report?.findings?.[0]?.commitSha, sha);
    assert.match(report?.issueDrafts?.[0]?.idempotencyKey ?? "", /^[0-9a-f]{32}$/);

    const malformed = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "review",
        evidence: [{ kind: "github", value: "https://github.com/owner/repo" }],
        findings: [
          {
            requirementRef: "GH-02",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: "not-a-sha",
            evidenceRefs: [],
            expected: "pinned",
            actual: "unpinned",
            impact: "stale",
            existingIssueMatches: [],
            suggestedAction: "fix",
          },
        ],
      }),
    );
    assert.equal(malformed?.findings, undefined);

    const gap = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "review",
        evidence: [{ kind: "github", value: "https://github.com/owner/repo" }],
        findings: [
          {
            requirementRef: "GH-02",
            classification: "unknown",
            severity: "medium",
            repositoryId: 101,
            commitSha: "unknown",
            evidenceRefs: [],
            expected: "pinned",
            actual: "unknown",
            impact: "cannot verify",
            existingIssueMatches: [],
            suggestedAction: "read the PR head",
            evidenceGap: "no PR receipt",
          },
        ],
      }),
    );
    assert.equal(gap?.findings?.[0]?.commitSha, "unknown");
  });
});

describe("GitHub completion criteria", () => {
  it("adds the repo from the owner message when the model omitted it", () => {
    const criteria = normalizeGithubCriteria(
      "with source URLs",
      "检查仓库进展",
      "看看 https://github.com/Owner/Repo 的 open issues",
      ["github.read"],
    );
    const parsed = JSON.parse(criteria) as Record<string, unknown>;
    assert.equal(parsed.repo, "owner/repo");
    assert.equal(parsed.verifier, "github-read");
    assert.deepEqual(parsed.requiredEvidenceKinds, ["github"]);
  });

  it("prefers the repo named by the owner over a model-supplied repo", () => {
    const criteria = normalizeGithubCriteria(
      '{"repo":"owner/repo"}',
      "检查 other/repo",
      "检查 other/repo 的进展",
      ["github.read"],
    );
    assert.equal((JSON.parse(criteria) as Record<string, unknown>).repo, "other/repo");
  });

  it("binds the project-review verifier only when the skill is selected", () => {
    const review = normalizeGithubCriteria(
      "done",
      "对照规划检查项目完成度",
      "检查 owner/repo 的开发进展",
      ["github.read"],
      ["github.project-review"],
    );
    const parsed = JSON.parse(review) as Record<string, unknown>;
    assert.equal(parsed.verifier, "project-review");
    assert.equal(parsed.repo, "owner/repo");
    assert.equal(wantsProjectReview("对照规划评估这个项目的实现差距"), true);
    assert.equal(wantsProjectReview("查看 open issues"), false);
  });

  it("never invents a repo for a non-GitHub task", () => {
    assert.equal(
      normalizeGithubCriteria("done", "check owner/repo", "owner/repo", []),
      "done",
    );
  });
});

function binding(overrides: Partial<ProjectBinding> = {}): ProjectBinding {
  return {
    id: "project-1",
    ownerId: "owner-1",
    projectKey: "personal-agent",
    repositoryId: 101,
    repositoryFullName: "yuanbaoerer/personal-agent",
    defaultBranch: "main",
    credentialRef: "github:default",
    allowedPlanPaths: ["README.md", "docs/24-github-project-management.md"],
    status: "active",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function catalog(items: ProjectBinding[]) {
  return {
    list: (ownerId: string, status?: "active") =>
      items.filter(
        (project) =>
          project.ownerId === ownerId && (status === undefined || project.status === status),
      ),
    findActiveByKey: (ownerId: string, key: string) =>
      items.find(
        (project) =>
          project.ownerId === ownerId &&
          project.projectKey === key &&
          project.status === "active",
      ),
  };
}

describe("project mention resolution", () => {
  const project = binding();
  const other = binding({
    id: "project-2",
    projectKey: "docs-site",
    repositoryId: 102,
    repositoryFullName: "yuanbaoerer/docs-site",
  });

  it("recognizes a projectKey without an owner/repository in the message", () => {
    const result = resolveProjectMention({
      text: "检查 personal-agent 项目的最新实施情况",
      ownerId: "owner-1",
      projects: catalog([project]),
      requireProject: true,
    });
    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" ? result.project.projectKey : "", "personal-agent");
    assert.equal(wantsProjectReview("检查 personal-agent 项目的最新实施情况"), true);
  });

  it("resolves an exact repository full name and the explicit flag", () => {
    const byRepo = resolveProjectMention({
      text: "审查 https://github.com/yuanbaoerer/personal-agent 的进展",
      ownerId: "owner-1",
      projects: catalog([project]),
      requireProject: true,
    });
    assert.equal(byRepo.status, "resolved");
    const byFlag = resolveProjectMention({
      text: "检查 --project=docs-site 的实施情况 personal-agent",
      ownerId: "owner-1",
      projects: catalog([project, other]),
      requireProject: true,
    });
    assert.equal(byFlag.status, "resolved");
    assert.equal(byFlag.status === "resolved" ? byFlag.project.projectKey : "", "docs-site");
  });

  it("refuses missing, ambiguous and unbound projects instead of guessing", () => {
    const missing = resolveProjectMention({
      text: "检查 unknown-project 项目的最新实施情况",
      ownerId: "owner-1",
      projects: catalog([project]),
      requireProject: true,
    });
    assert.equal(missing.status, "missing");

    const ambiguous = resolveProjectMention({
      text: "检查 personal-agent 和 docs-site 项目的实施情况",
      ownerId: "owner-1",
      projects: catalog([project, other]),
      requireProject: true,
    });
    assert.equal(ambiguous.status, "ambiguous");

    const conflict = resolveProjectMention({
      text: "检查 personal-agent 项目的最新实施情况",
      ownerId: "owner-1",
      requested: "docs-site",
      projects: catalog([project, other]),
      requireProject: true,
    });
    assert.equal(conflict.status, "ambiguous");

    const unboundRepo = resolveProjectMention({
      text: "检查 github.com/other/private 项目的实施情况",
      ownerId: "owner-1",
      projects: catalog([project]),
      requireProject: true,
    });
    assert.equal(unboundRepo.status, "missing");

    const unavailable = resolveProjectMention({
      text: "检查 personal-agent 项目的最新实施情况",
      ownerId: "owner-1",
      projects: catalog([]),
      requireProject: true,
    });
    assert.equal(unavailable.status, "unavailable");
  });

  it("binds criteria to the resolved repository identity", () => {
    const criteria = normalizeGithubCriteria(
      '{"repo":"attacker/repo","verifier":"github-read"}',
      "check",
      "检查 personal-agent 项目的最新实施情况",
      ["github.read"],
      ["github.project-review"],
      project,
    );
    const parsed = JSON.parse(criteria) as Record<string, unknown>;
    assert.equal(parsed.repo, "yuanbaoerer/personal-agent");
    assert.equal(parsed.repositoryId, 101);
    assert.equal(parsed.projectKey, "personal-agent");
    assert.equal(parsed.defaultBranch, "main");
    assert.deepEqual(parsed.allowedPlanPaths, [
      "README.md",
      "docs/24-github-project-management.md",
    ]);
    assert.equal(parsed.verifier, "project-review");
  });
});

describe("project review task creation", () => {
  function bindPersonalAgent(services: ReturnType<typeof createServices>) {
    services.projectService.bind(
      services.owner.id,
      {
        projectKey: "personal-agent",
        repositoryId: 101,
        repositoryFullName: "owner/repo",
        defaultBranch: "main",
        credentialRef: "github:default",
        allowedPlanPaths: ["README.md", "docs/24-github-project-management.md"],
      },
      "admin",
    );
  }

  it("creates a bound project-review task from a bare projectKey mention", async () => {
    const services = createServices({
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: (async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
    });
    bindPersonalAgent(services);
    services.model.push({
      action: "create_task",
      text: "开始检查。",
      task: {
        goal: "检查 personal-agent 最新实施情况",
        completionCriteria: "只读评估，给出有证据的 findings 和 issue drafts",
        mandate: { resources: ["chat"], tools: ["github.read"] },
      },
    });
    await sendText(services, "检查 personal-agent 项目的最新实施情况。", "evt_review");

    const tasks = services.tasks.listByOwner(services.owner.id);
    assert.equal(tasks.length, 1);
    const task = tasks[0] as TaskRecord;
    assert.equal(task.mandate.project, "personal-agent");
    assert.ok(task.mandate.tools.includes("github.read"));
    assert.deepEqual(task.mandate.skills, ["github.project-review"]);
    const criteria = JSON.parse(task.completionCriteria) as Record<string, unknown>;
    assert.equal(criteria.repo, "owner/repo");
    assert.equal(criteria.repositoryId, 101);
    assert.equal(criteria.projectKey, "personal-agent");
    assert.equal(criteria.verifier, "project-review");
    const outbox = services.store.listRecentOutbox(20).map((row) => row.text);
    assert.ok(outbox.some((text) => text.includes("项目：personal-agent")));
  });

  it("refuses an unbound project before creating a task", async () => {
    const services = createServices({
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: (async () => new Response("{}")) as typeof fetch,
      },
    });
    bindPersonalAgent(services);
    services.model.push({
      action: "create_task",
      text: "开始检查。",
      task: {
        goal: "检查 other-project 最新实施情况",
        completionCriteria: "只读评估",
        mandate: { resources: ["chat"], tools: ["github.read"] },
      },
    });
    await sendText(services, "检查 other-project 项目的最新实施情况。", "evt_review_missing");

    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);
    const outbox = services.store.listRecentOutbox(20).map((row) => row.text);
    assert.ok(outbox.some((text) => /找不到项目 other-project/.test(text)));
    assert.equal(services.runtime.opened.length, 0);
  });

  it("does not let the model pick a different project than the owner named", async () => {
    const services = createServices({
      github: {
        token: "secret",
        allowedRepos: ["owner/repo", "owner/docs"],
        fetch: (async () => new Response("{}")) as typeof fetch,
      },
    });
    bindPersonalAgent(services);
    services.projectService.bind(
      services.owner.id,
      {
        projectKey: "docs-site",
        repositoryId: 102,
        repositoryFullName: "owner/docs",
        defaultBranch: "main",
        credentialRef: "github:default",
        allowedPlanPaths: ["README.md"],
      },
      "admin",
    );
    services.model.push({
      action: "create_task",
      text: "开始检查。",
      task: {
        goal: "检查 docs-site 最新实施情况",
        completionCriteria: "只读评估",
        mandate: {
          resources: ["chat"],
          tools: ["github.read"],
          project: "docs-site",
        },
      },
    });
    await sendText(services, "检查 personal-agent 项目的最新实施情况。", "evt_review_conflict");

    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);
    const outbox = services.store.listRecentOutbox(20).map((row) => row.text);
    assert.ok(outbox.some((text) => /项目名称不唯一/.test(text)));
  });
});
