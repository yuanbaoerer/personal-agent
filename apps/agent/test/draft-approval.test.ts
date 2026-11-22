import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { CredentialBroker } from "../src/actions/credentials.ts";
import { createGithubPlugin } from "../src/plugins/github.ts";
import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import { OutboxDispatcher } from "../src/delivery/outbox.ts";
import type { GitHubIssueWriteConfig } from "../src/actions/github-issue.ts";
import type { AssignmentRecord, IssueDraft } from "../src/domain/types.ts";
import { createServices, sendText, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const REPO = "owner/repo";
const REPO_ID = 101;
const PROJECT_KEY = "personal-agent";
const MAIN_SHA = "a".repeat(40);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeGitHub {
  readonly requests: { method: string; path: string; body?: string }[] = [];
  issues: Record<string, unknown>[] = [];
  comments: Record<string, unknown>[] = [];
  failAfterPost = false;
  rateLimitPost = false;
  mainSha = MAIN_SHA;
  private nextIssue = 500;
  private nextComment = 1;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body === undefined ? undefined : String(init.body);
    this.requests.push({ method, path: url.pathname, body });
    if (url.pathname === `/repos/${REPO}`) {
      return json({ id: REPO_ID, full_name: REPO });
    }
    if (url.pathname === `/repos/${REPO}/git/ref/heads/main`) {
      return json({
        ref: "refs/heads/main",
        object: { sha: this.mainSha, type: "commit" },
      });
    }
    if (url.pathname === `/repos/${REPO}/issues` && method === "GET") {
      return json([...this.issues].reverse());
    }
    if (url.pathname === `/repos/${REPO}/issues` && method === "POST") {
      if (this.rateLimitPost) {
        return json({ message: "rate limited" }, 429);
      }
      const payload = JSON.parse(body ?? "{}") as {
        title?: string;
        body?: string;
      };
      const number = this.nextIssue++;
      const issue = {
        number,
        id: number + 1000,
        title: payload.title ?? "",
        body: payload.body ?? "",
        state: "open",
        html_url: `https://github.com/${REPO}/issues/${number}`,
      };
      this.issues.push(issue);
      if (this.failAfterPost) {
        this.failAfterPost = false;
        throw new TypeError("socket hang up");
      }
      return json(issue, 201);
    }
    const issueMatch = /^\/repos\/owner\/repo\/issues\/(\d+)$/.exec(
      url.pathname,
    );
    if (issueMatch !== null) {
      const issue = this.issues.find(
        (item) => item.number === Number(issueMatch[1]),
      );
      return issue === undefined ? json({ message: "Not Found" }, 404) : json(issue);
    }
    const commentList = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(
      url.pathname,
    );
    if (commentList !== null && method === "GET") {
      return json(this.comments);
    }
    if (commentList !== null && method === "POST") {
      const payload = JSON.parse(body ?? "{}") as { body?: string };
      const id = this.nextComment++;
      const comment = {
        id,
        body: payload.body ?? "",
        html_url: `https://github.com/${REPO}/issues/${commentList[1]}#issuecomment-${id}`,
      };
      this.comments.push(comment);
      return json(comment, 201);
    }
    const commentGet = /^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/.exec(
      url.pathname,
    );
    if (commentGet !== null) {
      const comment = this.comments.find(
        (item) => item.id === Number(commentGet[1]),
      );
      return comment === undefined ? json({ message: "Not Found" }, 404) : json(comment);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

function setup(options: { failAfterPost?: boolean } = {}) {
  const fake = new FakeGitHub();
  fake.issues.push({
    number: 7,
    id: 70,
    title: "Existing issue",
    body: "old body",
    state: "open",
    html_url: `https://github.com/${REPO}/issues/7`,
  });
  fake.failAfterPost = options.failAfterPost === true;
  const credentials = new CredentialBroker(() => NOW);
  let services!: TestServices;
  const readConfig = {
    token: "read-token",
    allowedRepos: [REPO],
    credentials,
    resolveProject: (key: string) =>
      services.projects.findActiveByKey(services.owner.id, key),
    fetch: fake.fetch,
  };
  const writeConfig: GitHubIssueWriteConfig = {
    allowedRepos: [REPO],
    issueCredentialRef: "github:issues",
    credentials,
    resolveProject: (key) => services.projects.findActiveByKey(services.owner.id, key),
    fetch: fake.fetch,
  };
  services = createServices({
    now: () => NOW,
    github: readConfig,
    githubIssueWrite: { credentialRef: "github:issues" },
    builtinPlugins: [createGithubPlugin(readConfig, writeConfig)],
  });
  credentials.register("github:default", {
    token: "read-token",
    scopes: ["repository.read"],
    ownerId: services.owner.id,
  });
  credentials.register("github:issues", {
    token: "write-secret",
    scopes: ["repository.read", "issues.write"],
    ownerId: services.owner.id,
    repositoryIds: [REPO_ID],
  });
  services.projectService.bind(
    services.owner.id,
    {
      projectKey: PROJECT_KEY,
      repositoryId: REPO_ID,
      repositoryFullName: REPO,
      defaultBranch: "main",
      credentialRef: "github:default",
      allowedPlanPaths: ["README.md"],
    },
    "admin",
  );
  return { services, credentials, fake };
}

function seedDraft(
  services: TestServices,
  options: {
    title?: string;
    key?: string;
    action?: "create" | "update" | "comment";
    targetIssue?: number;
    beforeHash?: string;
  } = {},
): { draft: IssueDraft & { id: string }; payloadHash: string } {
  const task = services.taskService.createExternalActionTask({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `draft-source:${options.key ?? "one"}:${Math.random()}`,
    goal: "review",
    completionCriteria: "done",
    mandate: {
      resources: ["chat"],
      tools: [],
      project: PROJECT_KEY,
      skills: ["github.project-review"],
    },
  });
  const draft: IssueDraft = {
    action: options.action ?? "create",
    ...(options.targetIssue === undefined
      ? {}
      : { targetIssue: options.targetIssue }),
    title: options.title ?? "Approved issue",
    body: options.action === "update" ? "approved new body" : "Approved body from the review.",
    findingIds: ["f1"],
    idempotencyKey: (options.key ?? "a").repeat(32).slice(0, 32),
    requiresOwnerApproval: true,
    ...(options.beforeHash === undefined
      ? {}
      : { beforeHash: options.beforeHash }),
  };
  const result = services.issueDrafts.recordVerified({
    task,
    assignment: { id: `assignment:${task.id}` } as AssignmentRecord,
    findings: [
      {
        id: "f1",
        requirementRef: "GH-04",
        classification: "observed",
        severity: "high",
        repositoryId: REPO_ID,
        commitSha: MAIN_SHA,
        evidenceRefs: [],
        expected: "approved draft",
        actual: "draft exists",
        impact: "test",
        existingIssueMatches: [],
        suggestedAction: "write after approval",
      },
    ],
    drafts: [draft],
    actions: [],
  });
  const snapshot = result.recorded[0];
  assert.ok(snapshot);
  return {
    draft: { ...draft, id: snapshot.id },
    payloadHash: snapshot.payloadHash,
  };
}

function writeTask(services: TestServices) {
  return services.tasks
    .listByOwner(services.owner.id)
    .find((task) => task.goal.startsWith("执行已批准的 GitHub"));
}

describe("issue draft approval bridge", () => {
  it("approves a draft, writes once, reads after write, and settles the task", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services);
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_approve",
    );

    const persisted = services.issueDrafts.get(services.owner.id, draft.id);
    assert.equal(persisted?.status, "approved");
    assert.equal(persisted?.writeActionId !== undefined, true);
    const task = writeTask(services);
    assert.equal(task?.status, "succeeded");
    assert.equal(task?.verification?.verifier, "action-receipt");
    assert.equal(task?.verification?.externalFactsVerified, true);
    const posts = fake.requests.filter(
      (request) => request.method === "POST" && request.path === `/repos/${REPO}/issues`,
    );
    assert.equal(posts.length, 1);
    assert.match(String(posts[0]?.body), /personal-agent:/);
    const outbox = services.store.listRecentOutbox(20).map((row) => row.text);
    assert.ok(outbox.some((text) => /external|外部动作|issues\/500/.test(text)));

    // Replaying the approval must not issue a second POST.
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_approve_replay",
    );
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path === `/repos/${REPO}/issues`,
      ).length,
      1,
    );
  });

  it("rejects a draft without writing", async () => {
    const { services, fake } = setup();
    const { draft } = seedDraft(services, { key: "b" });
    await sendText(services, `/draft reject ${draft.id}`, "evt_draft_reject");
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "rejected",
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
  });

  it("refuses approval after binding revoke or credential rotation", async () => {
    const revoked = setup();
    const first = seedDraft(revoked.services, { key: "c" });
    const project = revoked.services.projects.findActiveByKey(
      revoked.services.owner.id,
      PROJECT_KEY,
    );
    assert.ok(project);
    revoked.services.projectService.unbind(
      revoked.services.owner.id,
      project.id,
      "admin",
    );
    await sendText(
      revoked.services,
      `/draft approve ${first.draft.id} ${first.payloadHash}`,
      "evt_draft_revoked_binding",
    );
    assert.equal(
      revoked.services.issueDrafts.get(revoked.services.owner.id, first.draft.id)
        ?.status,
      "superseded",
    );
    assert.equal(
      revoked.fake.requests.filter((request) => request.method === "POST").length,
      0,
    );

    const rotated = setup();
    const second = seedDraft(rotated.services, { key: "d" });
    rotated.credentials.rotate("github:issues", {
      token: "write-secret-2",
      scopes: ["repository.read", "issues.write"],
      ownerId: rotated.services.owner.id,
      repositoryIds: [REPO_ID],
    });
    await sendText(
      rotated.services,
      `/draft approve ${second.draft.id} ${second.payloadHash}`,
      "evt_draft_rotated_credential",
    );
    assert.equal(
      rotated.services.issueDrafts.get(
        rotated.services.owner.id,
        second.draft.id,
      )?.status,
      "superseded",
    );
    assert.equal(
      rotated.fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
  });

  it("reconciles a lost POST by marker instead of creating a duplicate", async () => {
    const { services, fake } = setup({ failAfterPost: true });
    const { draft, payloadHash } = seedDraft(services, { key: "e" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_unknown",
    );
    // The action begins unknown; verification finds the marker and settles it.
    const persisted = services.issueDrafts.get(services.owner.id, draft.id);
    assert.equal(persisted?.status, "approved");
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path === `/repos/${REPO}/issues`,
      ).length,
      1,
    );
  });

  it("refuses approval when the payload hash does not match", async () => {
    const { services, fake } = setup();
    const { draft } = seedDraft(services, { key: "f" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${"0".repeat(64)}`,
      "evt_draft_hash_mismatch",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "pending_approval",
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
  });
});

describe("issue draft approval: update and failure paths", () => {
  it("pauses an update when a human changed the issue after the review", async () => {
    const { services, fake } = setup();
    const beforeHash = createHash("sha256")
      .update("Existing issue\nold body")
      .digest("hex");
    const { draft, payloadHash } = seedDraft(services, {
      key: "9",
      action: "update",
      targetIssue: 7,
      beforeHash,
    });
    const issue = fake.issues.find((item) => item.number === 7);
    assert.ok(issue);
    issue.body = "human edit after approval";
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_update_conflict",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "failed",
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "PATCH").length,
      0,
    );
    assert.equal(issue.body, "human edit after approval");
  });

  it("writes a comment through the bridge with read-after-write", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, {
      key: "8",
      action: "comment",
      targetIssue: 7,
    });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_comment",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "approved",
    );
    assert.equal(fake.comments.length, 1);
    assert.match(String(fake.comments[0]?.body), /personal-agent:8{32}/);
  });

  it("fails closed on a 429 without reporting success", async () => {
    const { services, fake } = setup();
    fake.rateLimitPost = true;
    const { draft, payloadHash } = seedDraft(services, { key: "7" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_429",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "failed",
    );
    const task = writeTask(services);
    assert.equal(task?.status, "failed");
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      1,
    );
  });
});

describe("issue draft restart reconciliation", () => {
  it("settles an already-succeeded action without issuing another write", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "5" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_restart_seed",
    );
    const task = writeTask(services);
    assert.ok(task);
    const snapshot = services.issueDrafts.get(services.owner.id, draft.id);
    assert.ok(snapshot);
    services.store.db.run(
      "UPDATE pa_issue_drafts SET status = 'executing' WHERE id = ?",
      draft.id,
    );
    services.store.db.run(
      "UPDATE pa_tasks SET status = 'waiting_user' WHERE id = ?",
      task.id,
    );
    const settled = services.issueDraftApproval?.reconcileOwner(
      services.owner.id,
    );
    assert.equal(settled, 1);
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "approved",
    );
    assert.equal(services.tasks.get(task.id)?.status, "succeeded");
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path === `/repos/${REPO}/issues`,
      ).length,
      1,
    );
  });

  it("turns an unresolved action into needs_review, never success", async () => {
    const { services } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "6" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_manual_seed",
    );
    const task = writeTask(services);
    const snapshot = services.issueDrafts.get(services.owner.id, draft.id);
    assert.ok(task && snapshot);
    assert.ok(snapshot.writeActionId);
    services.store.db.run(
      "UPDATE pa_issue_drafts SET status = 'executing' WHERE id = ?",
      draft.id,
    );
    services.store.db.run(
      "UPDATE pa_tasks SET status = 'waiting_user' WHERE id = ?",
      task.id,
    );
    services.store.db.run(
      "UPDATE pa_actions SET status = 'needs_manual' WHERE id = ?",
      snapshot.writeActionId,
    );
    services.issueDraftApproval?.reconcileOwner(services.owner.id);
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "failed",
    );
    assert.equal(services.tasks.get(task.id)?.status, "needs_review");
  });
});

describe("issue draft approval: plugin lifecycle", () => {
  it("refuses approval when the GitHub plugin is disabled", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "4" });
    await services.plugins.disable("github", services.owner.id);
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_plugin_disabled",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "pending_approval",
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
    const outbox = services.store.listRecentOutbox(10).map((row) => row.text);
    assert.ok(outbox.some((text) => /issue_write_capability_unavailable|无法批准/.test(text)));
  });
});

describe("issue write origin fence", () => {
  it("rejects a Worker-proposed issue write and a non-draft approved action", () => {
    const { services } = setup();
    const task = services.taskService.createExternalActionTask({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "origin-fence",
      goal: "write",
      completionCriteria: "done",
      mandate: {
        resources: ["github"],
        tools: ["github.issue.create"],
        project: PROJECT_KEY,
      },
    });
    const assignment = { id: "assignment:origin" } as AssignmentRecord;
    const proposed = services.actionService.proposeForReport(task, assignment, [
      {
        tool: "github.issue.create",
        args: { title: "worker proposal", body: "not from a draft" },
      },
    ]);
    assert.equal(proposed.count, 0);
    assert.equal(proposed.rejected, 1);

    const { action } = services.actions.insert({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      taskId: task.id,
      taskRevision: task.revision,
      fencingToken: 0,
      tool: "github.issue.create",
      args: { title: "direct", body: "not from a draft" },
      argsHash: "hash",
      expiresAt: "2026-01-01T00:10:00.000Z",
      nonce: "nonce-origin",
      sourceKey: "worker:proposal:direct",
      createdAt: NOW.toISOString(),
    });
    const approved = services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
      expectedArgsHash: action.argsHash,
      expectedTaskRevision: action.taskRevision,
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.reason, "write_requires_approved_draft");
  });
});


describe("issue draft approval: revision drift", () => {
  it("supersedes a draft when the repository moved past the verified commit", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "3" });
    fake.mainSha = "d".repeat(40);
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_revision_changed",
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "superseded",
    );
    const outbox = services.store.listRecentOutbox(10).map((row) => row.text);
    assert.ok(outbox.some((text) => /revision_changed/.test(text)));
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
  });
});


describe("approval bridge failure fences", () => {
  it("does not write after the owner cancels the write task", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "2" });
    const approved = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(approved?.ok, true);
    assert.ok(approved?.taskId);
    services.taskService.cancel(approved.taskId);
    await services.effectDispatcher.drain(10);
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "superseded",
    );
  });

  it("does not write after a task revision changes", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "1" });
    const approved = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(approved?.ok, true);
    assert.ok(approved?.taskId);
    services.taskService.revise(approved.taskId, { goal: "revised write task" });
    await services.effectDispatcher.drain(10);
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "superseded",
    );
  });

  it("does not write after the plugin is disabled post-approval", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "0" });
    const approved = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(approved?.ok, true);
    await services.plugins.disable("github", services.owner.id);
    await services.effectDispatcher.drain(10);
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "superseded",
    );
  });
});

describe("approval bridge Feishu delivery", () => {
  it("delivers the write result to Feishu with a platform message id", async () => {
    const { services } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "f" });
    await sendText(
      services,
      `/draft approve ${draft.id} ${payloadHash}`,
      "evt_draft_feishu",
    );
    const sent: string[] = [];
    let message = 0;
    const adapter = new FeishuAdapter(
      {
        appId: "app_1",
        appSecret: "secret",
        verificationToken: "token",
        apiBase: "https://feishu.test",
      },
      {
        now: () => NOW,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/tenant_access_token/internal")) {
            return json({
              code: 0,
              tenant_access_token: "tenant-token",
              expire: 7200,
            });
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            content?: string;
          };
          const content = JSON.parse(body.content ?? "{}") as { text?: string };
          if (typeof content.text === "string") {
            sent.push(content.text);
          }
          message += 1;
          return json({ code: 0, data: { message_id: `om_write_${message}` } });
        }) as typeof fetch,
      },
    );
    const dispatcher = new OutboxDispatcher({
      store: services.store,
      channel: adapter,
      now: () => NOW,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    const result = await dispatcher.drain(100);
    assert.ok(result.accepted > 0);
    assert.ok(sent.some((text) => text.includes("外部动作已完成并核对")));
    assert.ok(
      sent.some((text) => text.includes(`https://github.com/${REPO}/issues/500`)),
    );
  });
});

describe("approval crash recovery", () => {
  it("resumes an already-approved action without creating another", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "1" });
    const first = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(first?.ok, true, JSON.stringify(first));
    const actionCount = services.actions.listByTask(first?.taskId ?? "").length;
    services.store.db.run(
      "UPDATE pa_issue_drafts SET status = 'pending_approval' WHERE id = ?",
      draft.id,
    );
    const second = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(second?.ok, true);
    assert.equal(
      services.actions.listByTask(first?.taskId ?? "").length,
      actionCount,
    );
    await services.effectDispatcher.drain(10);
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      1,
    );
  });
});

describe("approval withdrawal", () => {
  it("withdraws an approved action before it can execute", async () => {
    const { services, fake } = setup();
    const { draft, payloadHash } = seedDraft(services, { key: "2" });
    const approved = await services.issueDraftApproval?.approve({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      draftId: draft.id,
      payloadHash,
      actorId: services.owner.id,
    });
    assert.equal(approved?.ok, true);
    assert.ok(approved?.action);
    assert.equal(
      services.actionService.revokeApproval(
        approved.action.id,
        "test",
        services.owner.id,
      ),
      true,
    );
    await services.effectDispatcher.drain(10);
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      0,
    );
    assert.equal(
      services.issueDrafts.get(services.owner.id, draft.id)?.status,
      "superseded",
    );
  });
});
