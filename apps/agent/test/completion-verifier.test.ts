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
    assert.equal(current?.verification?.externalFactsVerified, true);
    assert.match(current?.verification?.evidenceRefs.join(",") ?? "", /github\.com\/owner\/repo/);
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
});
