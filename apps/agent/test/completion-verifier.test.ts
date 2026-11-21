import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VERIFIER_VERSION } from "../src/coordinator/completion.ts";
import { parseWorkerReport } from "../src/coordinator/tasks.ts";
import {
  sendText,
  createServices,
  type TestServices,
} from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function setup() {
  return createServices({
    now: () => START,
    github: {
      token: "secret",
      allowedRepos: ["owner/repo", "other/repo"],
      fetch: (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    },
  });
}

function createTask(
  services: TestServices,
  options: {
    criteria?: string;
    mandateTools?: string[];
    mandateSkills?: string[];
    mandateProject?: string;
    key?: string;
  } = {},
) {
  return services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `verify:${options.key ?? Math.random().toString(36).slice(2)}`,
    goal: "check repository",
    completionCriteria:
      options.criteria ??
      '{"verifier":"github-read","repo":"owner/repo","requiredEvidenceKinds":["github"]}',
    mandate: {
      resources: ["chat", "github"],
      tools: options.mandateTools ?? ["github.read"],
      ...(options.mandateSkills === undefined
        ? {}
        : { skills: options.mandateSkills }),
      ...(options.mandateProject === undefined
        ? {}
        : { project: options.mandateProject }),
    },
  });
}

function claim(services: TestServices) {
  const assignment = services.tasks.claimNext(START.toISOString(), 60_000, 2);
  assert.ok(assignment);
  return assignment;
}

function insertSucceededAction(
  services: TestServices,
  taskId: string,
  assignment: ReturnType<typeof claim>,
  options: { repo?: string; evidenceRepo?: string } = {},
) {
  const repo = options.repo ?? "owner/repo";
  const evidenceRepo = options.evidenceRepo ?? repo;
  const { action } = services.actions.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    taskId,
    taskRevision: assignment.assignment.taskRevision,
    fencingToken: assignment.assignment.fencingToken,
    tool: "github.read",
    args: { operation: "repo", repo },
    argsHash: "hash",
    expiresAt: "2026-01-01T00:10:00.000Z",
    nonce: `nonce-${Math.random()}`,
    createdAt: START.toISOString(),
  });
  services.store.db.run(
    `UPDATE pa_actions SET status = 'succeeded', evidence_json = ?,
       external_ref = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({
      operation: "repo",
      repo: evidenceRepo,
      source: `https://github.com/${evidenceRepo}`,
    }),
    `https://github.com/${evidenceRepo}`,
    START.toISOString(),
    action.id,
  );
  return action;
}

function insertSucceededGithubList(
  services: TestServices,
  taskId: string,
  assignment: ReturnType<typeof claim>,
  operation: "issues" | "pulls" | "commits",
  items: Record<string, unknown>[],
) {
  const repo = "owner/repo";
  const { action } = services.actions.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    taskId,
    taskRevision: assignment.assignment.taskRevision,
    fencingToken: assignment.assignment.fencingToken,
    tool: "github.read",
    args: { operation, repo },
    argsHash: `hash-${operation}`,
    expiresAt: "2026-01-01T00:10:00.000Z",
    nonce: `nonce-${Math.random()}`,
    createdAt: START.toISOString(),
  });
  services.store.db.run(
    `UPDATE pa_actions SET status = 'succeeded', evidence_json = ?,
       external_ref = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({
      operation,
      repo,
      source: `https://github.com/${repo}`,
      items,
    }),
    `https://github.com/${repo}`,
    START.toISOString(),
    action.id,
  );
  return action;
}

function insertSucceededGithubCustom(
  services: TestServices,
  taskId: string,
  assignment: ReturnType<typeof claim>,
  args: Record<string, unknown>,
  evidence: Record<string, unknown>,
) {
  const { action } = services.actions.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    taskId,
    taskRevision: assignment.assignment.taskRevision,
    fencingToken: assignment.assignment.fencingToken,
    tool: "github.read",
    args,
    argsHash: `hash-${String(args.operation)}-${Math.random()}`,
    expiresAt: "2026-01-01T00:10:00.000Z",
    nonce: `nonce-${Math.random()}`,
    createdAt: START.toISOString(),
  });
  services.store.db.run(
    `UPDATE pa_actions SET status = 'succeeded', evidence_json = ?,
       external_ref = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(evidence),
    typeof evidence.source === "string"
      ? evidence.source
      : "https://github.com/owner/repo",
    START.toISOString(),
    action.id,
  );
  return action;
}

function insertSucceededGithubPull(
  services: TestServices,
  taskId: string,
  assignment: ReturnType<typeof claim>,
  number: number,
  merged: boolean,
) {
  const repo = "owner/repo";
  const { action } = services.actions.insert({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    taskId,
    taskRevision: assignment.assignment.taskRevision,
    fencingToken: assignment.assignment.fencingToken,
    tool: "github.read",
    args: { operation: "pull", repo, number },
    argsHash: "hash-pull",
    expiresAt: "2026-01-01T00:10:00.000Z",
    nonce: `nonce-pull-${Math.random()}`,
    createdAt: START.toISOString(),
  });
  services.store.db.run(
    `UPDATE pa_actions SET status = 'succeeded', evidence_json = ?,
       external_ref = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({
      operation: "pull",
      repo,
      source: `https://github.com/${repo}/pull/${number}`,
      item: {
        number,
        title: "pull",
        state: merged ? "closed" : "open",
        merged,
        draft: false,
      },
    }),
    `https://github.com/${repo}/pull/${number}`,
    START.toISOString(),
    action.id,
  );
  return action;
}

function ready(
  summary = "repo checked",
  evidence: { kind: string; value: string }[] = [
    { kind: "github", value: "https://github.com/owner/repo" },
  ],
) {
  return {
    status: "ready" as const,
    summary,
    evidence,
  };
}

describe("TaskCompletionVerifier", () => {
  it("parses only well-formed GitHub claims", () => {
    const report = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "ok",
        evidence: [{ kind: "github", value: "https://github.com/owner/repo" }],
        githubClaims: [
          {
            kind: "github_item",
            repo: "Owner/Repo",
            operation: "issues",
            item: 12,
            field: "state",
            value: "open",
          },
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "commits",
            item: "abcdef",
            field: "message",
            value: "fix",
          },
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "issues",
            item: 13,
            field: "merged",
            value: true,
          },
        ],
      }),
    );
    assert.deepEqual(report?.githubClaims, [
      {
        kind: "github_item",
        repo: "owner/repo",
        operation: "issues",
        item: "12",
        field: "state",
        value: "open",
      },
      {
        kind: "github_item",
        repo: "owner/repo",
        operation: "commits",
        item: "abcdef",
        field: "message",
        value: "fix",
      },
    ]);
  });

  it("preserves optional report metadata without trusting it", () => {
    const report = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "ok",
        evidence: [{ kind: "test", value: "claim" }],
        completionReason: "summary complete",
        evidenceRef: "action:123",
        verifierVersion: "worker-claim",
        unverifiedClaims: ["freshness unknown"],
      }),
    );
    assert.equal(report?.completionReason, "summary complete");
    assert.equal(report?.evidenceRef, "action:123");
    assert.equal(report?.verifierVersion, "worker-claim");
    assert.deepEqual(report?.unverifiedClaims, ["freshness unknown"]);
  });

  it("parses only well-formed structured state claims", () => {
    const hash = "a".repeat(64);
    const report = parseWorkerReport(
      JSON.stringify({
        status: "ready",
        summary: "ok",
        evidence: [{ kind: "state_snapshot", value: hash }],
        stateClaims: [
          { kind: "count", snapshotHash: hash, path: "tasks.counts.running", value: 2 },
          { kind: "task_status", snapshotHash: hash, taskId: "task-1", status: "running" },
          {
            kind: "reminder_due",
            snapshotHash: hash,
            reminderId: "reminder-1",
            dueAt: "2026-01-01T01:00:00.000Z",
          },
          { kind: "count", snapshotHash: "bad", path: "tasks.counts.running", value: 2 },
          { kind: "count", snapshotHash: hash, path: "tasks.counts.running", value: "2" },
          { kind: "task_status", snapshotHash: hash, taskId: "task-2", status: "invented" },
        ],
      }),
    );
    assert.deepEqual(report?.stateClaims, [
      { kind: "count", snapshotHash: hash, path: "tasks.counts.running", value: 2 },
      { kind: "task_status", snapshotHash: hash, taskId: "task-1", status: "running" },
      {
        kind: "reminder_due",
        snapshotHash: hash,
        reminderId: "reminder-1",
        dueAt: "2026-01-01T01:00:00.000Z",
      },
    ]);
  });

  it("marks a GitHub claim without an executor receipt as needs_review", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    const outcome = services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    assert.equal(outcome.status, "done");
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.equal(current?.verification?.verifier, "github-read");
    assert.equal(current?.verification?.externalFactsVerified, false);
    assert.match(current?.verification?.missing.join(",") ?? "", /github\.read action/);
    assert.equal(
      services.tasks.claimNext(START.toISOString(), 60_000, 2),
      undefined,
    );
    assert.match(services.router.statusText(services.owner.id), /待核对任务 1/);
  });

  it("accepts a GitHub claim only with a matching executor receipt and source URL", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.equal(current?.verification?.verdict, "succeeded");
    assert.equal(current?.verification?.verifierVersion, VERIFIER_VERSION);
    assert.equal(current?.verification?.externalFactsVerified, false);
    assert.match(current?.verification?.reason ?? "", /free-text claims/);
    assert.match(current?.verification?.evidenceRefs.join(",") ?? "", /github\.com\/owner\/repo/);
  });

  it("accepts an issue claim that matches the GitHub receipt", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededGithubList(services, task.id, assignment, "issues", [
      { number: 12, title: "bug", state: "open", author: "alice", url: "https://github.com/owner/repo/issues/12" },
    ]);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready(),
        githubClaims: [
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "issues",
            item: "12",
            field: "state",
            value: "open",
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.ok(
      current?.verification?.checked.includes("claim:github:issues:state"),
    );
    assert.ok(
      current?.verification?.checked.includes("claim:free_text_unverified"),
    );
    assert.equal(current?.verification?.externalFactsVerified, false);
  });

  it("accepts a merged claim from a single-pull receipt", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededGithubPull(services, task.id, assignment, 45, true);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("merged", [
          { kind: "github", value: "https://github.com/owner/repo/pull/45" },
        ]),
        githubClaims: [
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "pulls",
            item: "45",
            field: "merged",
            value: true,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.ok(
      current?.verification?.checked.includes("claim:github:pulls:merged"),
    );
  });

  it("rejects an issue state that conflicts with the GitHub receipt", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededGithubList(services, task.id, assignment, "issues", [
      { number: 12, title: "bug", state: "open", author: "alice", url: "https://github.com/owner/repo/issues/12" },
    ]);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready(),
        githubClaims: [
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "issues",
            item: "12",
            field: "state",
            value: "closed",
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.ok(
      current?.verification?.missing.some((item) =>
        item.startsWith("claim:github_field_mismatch:issues:12:state"),
      ),
    );
  });

  it("rejects a claim for an item absent from the GitHub receipt", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededGithubList(services, task.id, assignment, "pulls", [
      { number: 7, title: "pr", state: "open", merged: false },
    ]);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready(),
        githubClaims: [
          {
            kind: "github_item",
            repo: "owner/repo",
            operation: "pulls",
            item: "8",
            field: "merged",
            value: false,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.ok(
      current?.verification?.missing.some((item) =>
        item.startsWith("claim:github_item_missing:pulls:8"),
      ),
    );
  });

  it("requires structured GitHub claims when the criteria demand them", () => {
    const services = setup();
    const task = createTask(services, {
      criteria:
        '{"verifier":"github-read","repo":"owner/repo","requiredEvidenceKinds":["github"],"requireStructuredClaims":true}',
    });
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.ok(
      current?.verification?.missing.includes("claim:github_claims_required"),
    );
  });

  it("rejects fabricated evidence kinds and mismatched report sources", () => {
    const fabricated = setup();
    const first = createTask(fabricated, { key: "fabricated" });
    const firstAssignment = claim(fabricated);
    insertSucceededAction(fabricated, first.id, firstAssignment);
    fabricated.taskService.report(
      firstAssignment.assignment.id,
      firstAssignment.assignment.fencingToken,
      firstAssignment.assignment.taskRevision,
      ready("repo checked", [{ kind: "test", value: "trust me" }]),
    );
    assert.equal(fabricated.tasks.get(first.id)?.status, "failed");
    assert.equal(fabricated.tasks.get(first.id)?.verification?.verdict, "failed");

    const mismatched = setup();
    const second = createTask(mismatched, { key: "mismatched" });
    const secondAssignment = claim(mismatched);
    insertSucceededAction(mismatched, second.id, secondAssignment);
    mismatched.taskService.report(
      secondAssignment.assignment.id,
      secondAssignment.assignment.fencingToken,
      secondAssignment.assignment.taskRevision,
      ready("repo checked", [
        { kind: "github", value: "https://github.com/other/repo" },
      ]),
    );
    assert.equal(mismatched.tasks.get(second.id)?.status, "needs_review");
    assert.match(
      mismatched.tasks.get(second.id)?.verification?.missing.join(",") ?? "",
      /verified GitHub source/,
    );
    assert.equal(
      mismatched.tasks.get(second.id)?.verification?.externalFactsVerified,
      false,
    );
  });

  it("does not let a tool-backed task succeed structurally without an action receipt", () => {
    const services = setup();
    const task = createTask(services, {
      criteria: '{"requiredEvidenceKinds":["test"]}',
      mandateTools: ["lamp.set_brightness"],
      key: "tool-no-action",
    });
    const assignment = claim(services);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready("done", [{ kind: "test", value: "ok" }]),
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.equal(current?.verification?.verifier, "action-receipt");
    assert.match(current?.verification?.missing.join(",") ?? "", /action receipt/);
  });

  it("requires an explicit repository criterion for GitHub success", () => {
    const services = setup();
    const task = createTask(services, {
      criteria: '{"verifier":"github-read","requiredEvidenceKinds":["github"]}',
      key: "no-repo",
    });
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    assert.equal(services.tasks.get(task.id)?.status, "needs_review");
    assert.match(
      services.tasks.get(task.id)?.verification?.missing.join(",") ?? "",
      /explicit repository/,
    );
  });

  it("rejects a citation that was not present in executor evidence", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready("repo checked", [
        { kind: "github", value: "https://github.com/owner/repo" },
        { kind: "github", value: "https://github.com/owner/repo/issues/999" },
      ]),
    );
    assert.equal(services.tasks.get(task.id)?.status, "needs_review");
    assert.match(
      services.tasks.get(task.id)?.verification?.missing.join(",") ?? "",
      /verified GitHub source/,
    );
  });

  it("requires receipts for non-GitHub tools in a mixed mandate", () => {
    const services = setup();
    const task = createTask(services, {
      mandateTools: ["github.read", "lamp.set_brightness"],
      key: "mixed-mandate",
    });
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.match(
      current?.verification?.missing.join(",") ?? "",
      /lamp\.set_brightness/,
    );
  });

  it("accepts mixed-case repositories when the receipt and URL match", () => {
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["Owner/Repo"],
        fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "verify:mixed-case",
      goal: "check repository",
      completionCriteria:
        '{"verifier":"github-read","repo":"owner/repo","requiredEvidenceKinds":["github"]}',
      mandate: {
        resources: ["chat", "github"],
        tools: ["github.read"],
      },
    });
    const assignment = claim(services);
    insertSucceededAction(services, task.id, assignment, {
      repo: "Owner/Repo",
      evidenceRepo: "Owner/Repo",
    });
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready("repo checked", [
        { kind: "github", value: "https://github.com/Owner/Repo" },
      ]),
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
  });

  it("does not reuse a receipt from an earlier task revision", () => {
    const services = setup();
    const task = createTask(services);
    const first = claim(services);
    insertSucceededAction(services, task.id, first);
    const revised = services.taskService.revise(task.id, {
      goal: "check again after revision",
    });
    assert.equal(revised?.revision, 2);
    const second = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(second);
    services.taskService.report(
      second.assignment.id,
      second.assignment.fencingToken,
      second.assignment.taskRevision,
      ready(),
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.match(
      current?.verification?.missing.join(",") ?? "",
      /github\.read action/,
    );
  });

  it("routes unknown or text-review verifiers to needs_review", () => {
    const unknown = setup();
    const unknownTask = createTask(unknown, {
      criteria: '{"verifier":"does-not-exist"}',
      mandateTools: [],
      key: "unknown",
    });
    const unknownAssignment = claim(unknown);
    unknown.taskService.report(
      unknownAssignment.assignment.id,
      unknownAssignment.assignment.fencingToken,
      unknownAssignment.assignment.taskRevision,
      ready("text", [{ kind: "test", value: "claim" }]),
    );
    assert.equal(unknown.tasks.get(unknownTask.id)?.status, "needs_review");
    assert.match(
      unknown.tasks.get(unknownTask.id)?.verification?.reason ?? "",
      /unknown completion verifier/,
    );

    const text = setup();
    const textTask = createTask(text, {
      criteria: '{"verifier":"text-review"}',
      mandateTools: [],
      key: "text",
    });
    const textAssignment = claim(text);
    text.taskService.report(
      textAssignment.assignment.id,
      textAssignment.assignment.fencingToken,
      textAssignment.assignment.taskRevision,
      ready("text", [{ kind: "test", value: "claim" }]),
    );
    assert.equal(text.tasks.get(textTask.id)?.status, "needs_review");
    assert.match(text.tasks.get(textTask.id)?.verification?.reason ?? "", /semantic/);
  });

  it("allows /ack only for needs_review and records the owner and audit", async () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      ready(),
    );
    assert.equal(services.tasks.get(task.id)?.status, "needs_review");

    await sendText(services, `/ack ${task.id} 已人工复核`, "evt_ack");
    const acknowledged = services.tasks.get(task.id);
    assert.equal(acknowledged?.status, "succeeded");
    assert.equal(acknowledged?.acknowledgedBy, services.owner.id);
    assert.ok(acknowledged?.acknowledgedAt);
    const audit = services.store.db.all<{ event: string }>(
      "SELECT event FROM pa_audit WHERE subject_id = ? AND event = 'task.acknowledged'",
      task.id,
    );
    assert.equal(audit.length, 1);

    await sendText(services, `/ack ${task.id} again`, "evt_ack_again");
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
    assert.match(
      services.store.listRecentOutbox(5).map((row) => row.text).join("\n"),
      /只有 needs_review 可以 \/ack/,
    );
  });

  it("accepts typed file and check claims at the pinned revision", () => {
    const services = setup();
    const task = createTask(services);
    const assignment = claim(services);
    const sha = "a".repeat(40);
    const source = `https://github.com/owner/repo/blob/${sha}/docs/24.md`;
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "file",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
        path: "docs/24.md",
      },
      {
        operation: "file",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        requestedSha: sha,
        path: "docs/24.md",
        source,
        permanentUrl: source,
        item: {
          type: "file",
          path: "docs/24.md",
          sha: "b".repeat(40),
          content: "# Plan\nGH-02\n",
        },
      },
    );
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "checks",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
      },
      {
        operation: "checks",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        requestedSha: sha,
        source: `https://github.com/owner/repo/commit/${sha}/checks`,
        items: [
          {
            id: 1,
            name: "ci",
            status: "completed",
            conclusion: "success",
            headSha: sha,
          },
        ],
        coverage: { checkRuns: "complete", commitStatuses: "included" },
      },
    );
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("typed read", [{ kind: "github", value: source }]),
        githubClaims: [
          {
            kind: "github_typed",
            repo: "owner/repo",
            projectKey: "personal-agent",
            operation: "file",
            revision: sha,
            target: "docs/24.md",
            field: "contentIncludes",
            value: "GH-02",
          },
          {
            kind: "github_typed",
            repo: "owner/repo",
            projectKey: "personal-agent",
            operation: "checks",
            revision: sha,
            target: "ci",
            field: "conclusion",
            value: "success",
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.ok(
      current?.verification?.checked.includes("claim:github:file:contentIncludes"),
    );
    assert.ok(
      current?.verification?.checked.includes("claim:github:checks:conclusion"),
    );
  });

  it("rejects typed claims from a stale PR or a truncated tree", () => {
    const stale = setup();
    const staleTask = createTask(stale);
    const staleAssignment = claim(stale);
    const sha = "c".repeat(40);
    insertSucceededGithubCustom(
      stale,
      staleTask.id,
      staleAssignment,
      {
        operation: "pull_files",
        projectKey: "personal-agent",
        repo: "owner/repo",
        number: 7,
      },
      {
        operation: "pull_files",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        number: 7,
        headSha: sha,
        baseSha: "d".repeat(40),
        stale: true,
        source: "https://github.com/owner/repo/pull/7/files",
        items: [{ filename: "src/a.ts", status: "modified", changes: 2 }],
      },
    );
    stale.taskService.report(
      staleAssignment.assignment.id,
      staleAssignment.assignment.fencingToken,
      staleAssignment.assignment.taskRevision,
      {
        ...ready("stale", [
          { kind: "github", value: "https://github.com/owner/repo/pull/7/files" },
        ]),
        githubClaims: [
          {
            kind: "github_typed",
            repo: "owner/repo",
            projectKey: "personal-agent",
            operation: "pull_files",
            revision: sha,
            target: "src/a.ts",
            field: "status",
            value: "modified",
          },
        ],
      },
    );
    assert.equal(stale.tasks.get(staleTask.id)?.status, "needs_review");
    assert.match(
      stale.tasks.get(staleTask.id)?.verification?.missing.join(",") ?? "",
      /github_typed_stale/,
    );

    const tree = setup();
    const treeTask = createTask(tree);
    const treeAssignment = claim(tree);
    insertSucceededGithubCustom(
      tree,
      treeTask.id,
      treeAssignment,
      {
        operation: "tree",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
      },
      {
        operation: "tree",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        source: `https://github.com/owner/repo/tree/${sha}`,
        truncated: true,
        items: [{ path: "docs/24.md", type: "blob", sha: "e".repeat(40) }],
      },
    );
    tree.taskService.report(
      treeAssignment.assignment.id,
      treeAssignment.assignment.fencingToken,
      treeAssignment.assignment.taskRevision,
      {
        ...ready("tree", [
          { kind: "github", value: `https://github.com/owner/repo/tree/${sha}` },
        ]),
        githubClaims: [
          {
            kind: "github_typed",
            repo: "owner/repo",
            projectKey: "personal-agent",
            operation: "tree",
            revision: sha,
            target: "docs/25.md",
            field: "exists",
            value: false,
          },
        ],
      },
    );
    assert.equal(tree.tasks.get(treeTask.id)?.status, "needs_review");
    assert.match(
      tree.tasks.get(treeTask.id)?.verification?.missing.join(",") ?? "",
      /github_typed_tree_truncated/,
    );
  });

  it("verifies project-review findings and issue drafts against receipts", () => {
    const services = setup();
    const task = createTask(services, {
      mandateSkills: ["github.project-review"],
      key: "review",
    });
    const assignment = claim(services);
    const sha = "a".repeat(40);
    const source = `https://github.com/owner/repo/blob/${sha}/docs/24.md`;
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "file",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
        path: "docs/24.md",
      },
      {
        operation: "file",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        path: "docs/24.md",
        source,
        permanentUrl: source,
        item: { type: "file", path: "docs/24.md", sha: "b".repeat(40) },
      },
    );
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      { operation: "issues", repo: "owner/repo" },
      {
        operation: "issues",
        repo: "owner/repo",
        source: "https://github.com/owner/repo",
        items: [
          {
            number: 60,
            title: "GH-02 evidence",
            state: "open",
            body: "Existing GH-02 body",
            url: "https://github.com/owner/repo/issues/60",
          },
        ],
      },
    );
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("review", [{ kind: "github", value: source }]),
        findings: [
          {
            id: "f1",
            requirementRef: "docs/24 GH-02 B4",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: sha,
            evidenceRefs: [source],
            expected: "PR files pinned to a head SHA",
            actual: "file receipt exists but PR files are not pinned",
            impact: "stale conclusions possible",
            existingIssueMatches: [60],
            suggestedAction: "pin pull_files and mark stale receipts",
            coverage: "complete",
          },
        ],
        issueDrafts: [
          {
            action: "update",
            targetIssue: 60,
            title: "Pin PR file evidence",
            body: "Verify head SHA before and after listing files.",
            findingIds: ["f1"],
            beforeHash:
              "5bf3e85a6ed5c27d8b0b56ebd63b6a4dcd51833cd07a5328003197f5c1a1eab9",
            requiresOwnerApproval: true,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "succeeded");
    assert.equal(current?.verification?.verifier, "project-review");
    assert.equal(current?.verification?.externalFactsVerified, true);
    assert.match(current?.verification?.reason ?? "", /1 observed/);
  });

  it("refuses project-review findings outside the criteria repository or project", async () => {
    for (const scenario of [
      {
        key: "review-repo-mismatch",
        criteria:
          '{"verifier":"project-review","repo":"owner/repo","repositoryId":999,"projectKey":"personal-agent","requiredEvidenceKinds":["github"]}',
        project: "personal-agent",
        missing: /repository_id_mismatch/,
      },
      {
        key: "review-project-mismatch",
        criteria:
          '{"verifier":"project-review","repo":"owner/repo","repositoryId":101,"projectKey":"personal-agent","requiredEvidenceKinds":["github"]}',
        project: "other-project",
        missing: /criteria_project_mismatch/,
      },
    ]) {
      const services = setup();
      const task = createTask(services, {
        mandateSkills: ["github.project-review"],
        mandateProject: scenario.project,
        criteria: scenario.criteria,
        key: scenario.key,
      });
      const assignment = claim(services);
      const sha = "a".repeat(40);
      const source = `https://github.com/owner/repo/blob/${sha}/docs/24.md`;
      insertSucceededGithubCustom(
        services,
        task.id,
        assignment,
        { operation: "file", projectKey: "personal-agent", repo: "owner/repo", sha, path: "docs/24.md" },
        {
          operation: "file",
          repo: "owner/repo",
          projectKey: "personal-agent",
          repositoryId: 101,
          commitSha: sha,
          path: "docs/24.md",
          source,
          permanentUrl: source,
          item: { type: "file", path: "docs/24.md" },
        },
      );
      services.taskService.report(
        assignment.assignment.id,
        assignment.assignment.fencingToken,
        assignment.assignment.taskRevision,
        {
          ...ready("review", [{ kind: "github", value: source }]),
          findings: [
            {
              id: "f1",
              requirementRef: "docs/24 GH-02",
              classification: "observed",
              severity: "high",
              repositoryId: 101,
              commitSha: sha,
              evidenceRefs: [source],
              expected: "bound repository",
              actual: "different repository",
              impact: "cross-project evidence",
              existingIssueMatches: [],
              suggestedAction: "re-check the binding",
              coverage: "complete",
            },
          ],
        },
      );
      const current = services.tasks.get(task.id);
      assert.equal(current?.status, "needs_review");
      assert.match(current?.verification?.missing.join(",") ?? "", scenario.missing);
    }
  });

  it("refuses project-review findings with invented evidence or issue numbers", () => {
    const services = setup();
    const task = createTask(services, {
      mandateSkills: ["github.project-review"],
      key: "review-invalid",
    });
    const assignment = claim(services);
    const sha = "a".repeat(40);
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "file",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
        path: "docs/24.md",
      },
      {
        operation: "file",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        source: `https://github.com/owner/repo/blob/${sha}/docs/24.md`,
        item: { type: "file", path: "docs/24.md" },
      },
    );
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("review", [
          {
            kind: "github",
            value: `https://github.com/owner/repo/blob/${sha}/docs/24.md`,
          },
        ]),
        findings: [
          {
            id: "f1",
            requirementRef: "docs/24 GH-02",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: sha,
            evidenceRefs: ["https://github.com/owner/repo/blob/deadbeef/docs/24.md"],
            expected: "pinned",
            actual: "unpinned",
            impact: "stale",
            existingIssueMatches: [999],
            suggestedAction: "fix it",
          },
        ],
        issueDrafts: [
          {
            action: "update",
            targetIssue: 999,
            title: "Fix",
            body: "Body",
            findingIds: ["f1"],
            requiresOwnerApproval: true,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    const missing = current?.verification?.missing.join(",") ?? "";
    assert.match(missing, /evidence_ref_unverified/);
    assert.match(missing, /issue_match_unverified:999/);
    assert.match(missing, /target_issue_unverified/);
  });

  it("refuses a create draft when an existing issue already matches", () => {
    const services = setup();
    const task = createTask(services, {
      mandateSkills: ["github.project-review"],
      key: "review-duplicate",
    });
    const assignment = claim(services);
    const sha = "a".repeat(40);
    const source = `https://github.com/owner/repo/blob/${sha}/docs/24.md`;
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "file",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
        path: "docs/24.md",
      },
      {
        operation: "file",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        source,
        item: { type: "file", path: "docs/24.md" },
      },
    );
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      { operation: "issues", repo: "owner/repo" },
      {
        operation: "issues",
        repo: "owner/repo",
        source: "https://github.com/owner/repo",
        items: [
          {
            number: 60,
            title: "Pin pull files to head SHA",
            state: "open",
            url: "https://github.com/owner/repo/issues/60",
          },
        ],
      },
    );
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("review", [{ kind: "github", value: source }]),
        findings: [
          {
            id: "f1",
            requirementRef: "docs/24 GH-02 B4",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: sha,
            evidenceRefs: [source],
            expected: "pinned",
            actual: "unpinned",
            impact: "stale evidence",
            existingIssueMatches: [],
            suggestedAction: "pin files",
          },
        ],
        issueDrafts: [
          {
            action: "create",
            title: "Pin pull files to head SHA",
            body: "Pin the PR file listing to the observed head.",
            findingIds: ["f1"],
            requiresOwnerApproval: true,
          },
        ],
      },
    );
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.match(
      current?.verification?.missing.join(",") ?? "",
      /create_matches_existing_issue:60/,
    );
  });

  it("does not treat a pull request number as an existing issue", () => {
    const services = setup();
    const task = createTask(services, {
      mandateSkills: ["github.project-review"],
      key: "review-pr-as-issue",
    });
    const assignment = claim(services);
    const sha = "a".repeat(40);
    const source = `https://github.com/owner/repo/blob/${sha}/docs/24.md`;
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      {
        operation: "file",
        projectKey: "personal-agent",
        repo: "owner/repo",
        sha,
        path: "docs/24.md",
      },
      {
        operation: "file",
        repo: "owner/repo",
        projectKey: "personal-agent",
        repositoryId: 101,
        commitSha: sha,
        source,
        item: { type: "file", path: "docs/24.md" },
      },
    );
    insertSucceededGithubCustom(
      services,
      task.id,
      assignment,
      { operation: "pull", repo: "owner/repo", number: 60 },
      {
        operation: "pull",
        repo: "owner/repo",
        source: "https://github.com/owner/repo/pull/60",
        item: { number: 60, title: "PR not issue", state: "open" },
      },
    );
    services.taskService.report(
      assignment.assignment.id,
      assignment.assignment.fencingToken,
      assignment.assignment.taskRevision,
      {
        ...ready("review", [{ kind: "github", value: source }]),
        findings: [
          {
            id: "f1",
            requirementRef: "docs/24 GH-02",
            classification: "observed",
            severity: "high",
            repositoryId: 101,
            commitSha: sha,
            evidenceRefs: [source],
            expected: "pinned",
            actual: "unpinned",
            impact: "stale",
            existingIssueMatches: [60],
            suggestedAction: "fix",
          },
        ],
        issueDrafts: [
          {
            action: "update",
            targetIssue: 60,
            title: "Fix",
            body: "Body",
            findingIds: ["f1"],
            requiresOwnerApproval: true,
          },
        ],
      },
    );
    const missing =
      services.tasks.get(task.id)?.verification?.missing.join(",") ?? "";
    assert.match(missing, /issue_match_unverified:60/);
    assert.match(missing, /target_issue_unverified/);
  });
});
