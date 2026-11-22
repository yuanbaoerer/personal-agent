import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { CredentialBroker } from "../src/actions/credentials.ts";
import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import { OutboxDispatcher } from "../src/delivery/outbox.ts";
import { assignDraftKeys } from "../src/coordinator/project-review.ts";
import type {
  ActionRecord,
  AssignmentRecord,
  ProjectBinding,
  TaskRecord,
} from "../src/domain/types.ts";
import { createServices, type TestServices } from "./services.ts";
import { inbound } from "./helpers.ts";

const START = new Date("2026-01-01T00:00:00.000Z");
const REPO = "owner/repo";
const PROJECT_KEY = "personal-agent";
const REPOSITORY_ID = 101;
const MAIN_SHA = "a".repeat(40);
const PR_HEAD = "b".repeat(40);
const PR_BASE = "c".repeat(40);
const PLAN_PATH = "docs/24-github-project-management.md";
const SOURCE_PATH = "apps/agent/src/actions/github.ts";
const ISSUE_BODY = "Existing GH-02 evidence body";
const FEISHU_CONFIG = {
  appId: "app_1",
  appSecret: "secret",
  verificationToken: "token",
  apiBase: "https://feishu.test",
};

function feishuEvent(text: string, messageId: string) {
  const adapter = new FeishuAdapter(FEISHU_CONFIG, { now: () => START });
  const parsed = adapter.parseRequest({
    headers: {},
    rawBody: JSON.stringify({
      header: {
        token: "token",
        app_id: "app_1",
        event_type: "im.message.receive_v1",
        event_id: `event-${messageId}`,
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_owner" },
          sender_type: "user",
        },
        message: {
          chat_id: "oc_1",
          chat_type: "p2p",
          message_id: messageId,
          message_type: "text",
          content: JSON.stringify({ text }),
          create_time: String(START.getTime()),
        },
      },
    }),
  });
  assert.equal(parsed.kind, "event");
  return parsed.kind === "event" ? parsed.event : undefined;
}

async function deliverFeishu(services: TestServices): Promise<string[]> {
  const sent: string[] = [];
  let message = 0;
  const adapter = new FeishuAdapter(FEISHU_CONFIG, {
    now: () => START,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
      };
      try {
        const content = JSON.parse(body.content ?? "{}") as { text?: string };
        if (typeof content.text === "string") {
          sent.push(content.text);
        }
      } catch {
        sent.push("");
      }
      message += 1;
      return jsonResponse({
        code: 0,
        data: { message_id: `om_review_${message}` },
      });
    }) as typeof fetch,
  });
  const dispatcher = new OutboxDispatcher({
    store: services.store,
    channel: adapter,
    now: () => START,
    leaseMs: 1_000,
    maxAttempts: 3,
  });
  const result = await dispatcher.drain(100);
  assert.ok(result.accepted > 0);
  return sent;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileResponse(path: string, size = 20): Response {
  return jsonResponse({
    type: "file",
    path,
    name: path.split("/").at(-1),
    sha: "d".repeat(40),
    size,
    encoding: "base64",
    content: Buffer.from(`content of ${path}`).toString("base64"),
    html_url: `https://github.com/${REPO}/blob/${MAIN_SHA}/${path}`,
    download_url: `https://raw.githubusercontent.com/${REPO}/${MAIN_SHA}/${path}`,
  });
}

interface FakeGitHubOptions {
  repositoryId?: number;
  fullName?: string;
  headShas?: string[];
  failStatus?: boolean;
  truncatedPlan?: boolean;
}

function fakeGitHub(options: FakeGitHubOptions = {}) {
  let pullReads = 0;
  let fileReads = 0;
  const calls: string[] = [];
  const headShas = options.headShas ?? [PR_HEAD];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const path = url.pathname;
    if (path === `/repos/${REPO}`) {
      return jsonResponse({
        id: options.repositoryId ?? REPOSITORY_ID,
        full_name: options.fullName ?? REPO,
        default_branch: "main",
        pushed_at: "2026-01-01T00:00:00.000Z",
        open_issues_count: 1,
        html_url: `https://github.com/${REPO}`,
      });
    }
    if (path === `/repos/${REPO}/git/ref/heads/main`) {
      return jsonResponse({
        ref: "refs/heads/main",
        object: {
          sha: MAIN_SHA,
          type: "commit",
          url: `https://api.github.com/repos/${REPO}/git/commits/${MAIN_SHA}`,
        },
      });
    }
    if (path === `/repos/${REPO}/contents/${PLAN_PATH}`) {
      return fileResponse(PLAN_PATH, options.truncatedPlan === true ? 40_000 : 20);
    }
    if (path === `/repos/${REPO}/contents/${SOURCE_PATH}`) {
      return fileResponse(SOURCE_PATH);
    }
    if (path === `/repos/${REPO}/pulls/7`) {
      pullReads += 1;
      return jsonResponse({
        number: 7,
        title: "Read-only project review",
        state: "open",
        draft: false,
        merged: false,
        html_url: `https://github.com/${REPO}/pull/7`,
        head: { ref: "feat/review", sha: headShas[Math.min(pullReads - 1, headShas.length - 1)] },
        base: { ref: "main", sha: PR_BASE },
      });
    }
    if (path === `/repos/${REPO}/pulls/7/files`) {
      fileReads += 1;
      return jsonResponse([
        {
          filename: fileReads === 1 ? "apps/agent/src/coordinator/project-review.ts" : "apps/agent/src/actions/github.ts",
          status: "modified",
          additions: 10,
          deletions: 2,
          changes: 12,
          sha: "e".repeat(40),
          patch: "@@ -1 +1 @@",
        },
      ]);
    }
    if (path === `/repos/${REPO}/commits/${MAIN_SHA}/check-runs`) {
      return jsonResponse({
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: "ci",
            status: "completed",
            conclusion: "success",
            head_sha: MAIN_SHA,
            details_url: `https://github.com/${REPO}/actions/runs/1`,
            output: { title: "ci", summary: "passed" },
          },
        ],
      });
    }
    if (path === `/repos/${REPO}/commits/${MAIN_SHA}/status`) {
      if (options.failStatus === true) {
        return new Response("forbidden", { status: 403 });
      }
      return jsonResponse({ state: "success", total_count: 0, statuses: [] });
    }
    if (path === `/repos/${REPO}/issues/60`) {
      return jsonResponse({
        number: 60,
        title: "GH-02 evidence",
        state: "open",
        body: ISSUE_BODY,
        user: { login: "yuanbaoerer" },
        html_url: `https://github.com/${REPO}/issues/60`,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }
    if (path === `/repos/${REPO}/issues`) {
      return jsonResponse([
        {
          number: 60,
          title: "GH-02 evidence",
          state: "open",
          body: ISSUE_BODY,
          user: { login: "yuanbaoerer" },
          html_url: `https://github.com/${REPO}/issues/60`,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
    }
    return jsonResponse({ message: "not found" }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function bindingInput(overrides: Partial<ProjectBinding> = {}) {
  return {
    projectKey: PROJECT_KEY,
    repositoryId: REPOSITORY_ID,
    repositoryFullName: REPO,
    defaultBranch: "main",
    credentialRef: "github:default",
    allowedPlanPaths: ["README.md", PLAN_PATH],
    ...overrides,
  };
}

function setup(options: FakeGitHubOptions = {}) {
  const github = fakeGitHub(options);
  const credentials = new CredentialBroker(() => START);
  let services!: TestServices;
  services = createServices({
    now: () => START,
    github: {
      token: "global-token",
      allowedRepos: [REPO],
      credentials,
      resolveProject: (key) =>
        services.projects.findActiveByKey(services.owner.id, key),
      fetch: github.fetch,
    },
  });
  credentials.register("github:default", {
    token: "project-token",
    scopes: ["repository.read"],
    ownerId: services.owner.id,
    repositoryIds: [REPOSITORY_ID],
  });
  services.projectService.bind(services.owner.id, bindingInput(), "admin");
  services.preauthorization.grant(services.owner.id, REPO);
  return { services, credentials, github };
}

const REVIEW_TEXT =
  "检查 personal-agent 的最新实施情况，对照项目规划、源码、PR 和 CI，指出工程缺口，关联已有 Issue，生成待办修改草稿。只读，不要实际修改 GitHub。";

function enqueueReviewDecision(services: TestServices): void {
  services.model.push({
    action: "create_task",
    text: "开始只读评估。",
    task: {
      goal: "检查 personal-agent 最新实施情况",
      completionCriteria: "对照规划、源码、PR 与 CI 给出有证据的 findings 和 issue drafts",
      mandate: { resources: ["chat"], tools: ["github.read"] },
    },
  });
}

const READS = [
  { tool: "github.read", args: { operation: "repo", repo: REPO } },
  {
    tool: "github.read",
    args: { operation: "ref", projectKey: PROJECT_KEY, repo: REPO, ref: "heads/main" },
  },
  {
    tool: "github.read",
    args: {
      operation: "file",
      projectKey: PROJECT_KEY,
      repo: REPO,
      sha: MAIN_SHA,
      path: PLAN_PATH,
    },
  },
  {
    tool: "github.read",
    args: {
      operation: "file",
      projectKey: PROJECT_KEY,
      repo: REPO,
      sha: MAIN_SHA,
      path: SOURCE_PATH,
    },
  },
  {
    tool: "github.read",
    args: { operation: "pull_files", projectKey: PROJECT_KEY, repo: REPO, number: 7, limit: 20 },
  },
  {
    tool: "github.read",
    args: { operation: "checks", projectKey: PROJECT_KEY, repo: REPO, sha: MAIN_SHA, limit: 20 },
  },
  { tool: "github.read", args: { operation: "issues", repo: REPO, limit: 20 } },
  {
    tool: "github.read",
    args: { operation: "issue", projectKey: PROJECT_KEY, repo: REPO, number: 60, limit: 5 },
  },
];

async function runReview(options: FakeGitHubOptions = {}) {
  const fixture = setup(options);
  const { services } = fixture;
  enqueueReviewDecision(services);
  const event = feishuEvent(
    REVIEW_TEXT,
    `om_project_review_${Math.random().toString(36).slice(2)}`,
  );
  assert.ok(event);
  await services.ingress.accept(event);
  // Process only the Router effect; the task dispatch stays queued so the
  // test can claim the assignment deterministically.
  await services.effectDispatcher.drain(1);
  const task = services.tasks.listByOwner(services.owner.id)[0] as TaskRecord;
  assert.ok(
    task,
    JSON.stringify(
      services.store.listRecentOutbox(10).map((row) => row.text),
    ),
  );
  const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
  assert.ok(claimed);
  services.taskService.report(
    claimed.assignment.id,
    claimed.assignment.fencingToken,
    claimed.assignment.taskRevision,
    {
      status: "working",
      summary: "收集固定 SHA 的项目证据",
      evidence: [{ kind: "github", value: `https://github.com/${REPO}` }],
      proposedActions: READS,
    },
  );
  // The task.dispatch effect from creation is still pending; it becomes a
  // no-op for waiting_external but consumes one drain slot.
  await services.effectDispatcher.drain(READS.length + 1);
  return { ...fixture, task: services.tasks.get(task.id) as TaskRecord };
}

function evidenceFor(services: TestServices, taskId: string) {
  const actions = services.actions.listByTask(taskId);
  const succeeded = actions.filter((action) => action.status === "succeeded");
  assert.equal(succeeded.length, READS.length, JSON.stringify(
    actions.map((action) => ({ args: action.args, status: action.status, error: action.lastError })),
  ));
  const byOperation = new Map<string, typeof succeeded[number]>();
  for (const action of succeeded) {
    byOperation.set(String(action.args.operation), action);
  }
  const repo = byOperation.get("repo");
  const ref = byOperation.get("ref");
  const issues = byOperation.get("issues");
  const issue = byOperation.get("issue");
  const files = succeeded.filter((action) => action.args.operation === "file");
  assert.ok(repo && ref && issues && issue && files.length === 2);
  const plan = files.find((action) => action.args.path === PLAN_PATH);
  const source = files.find((action) => action.args.path === SOURCE_PATH);
  assert.ok(plan && source);
  return { actions, repo, ref, issues, issue, plan, source };
}

function reviewReport(services: TestServices, task: TaskRecord) {
  const evidence = evidenceFor(services, task.id);
  const repositoryId = Number(evidence.repo.evidence?.item && (evidence.repo.evidence.item as Record<string, unknown>).id);
  const commitSha = String(evidence.ref.evidence?.sha);
  assert.equal(repositoryId, REPOSITORY_ID);
  assert.equal(commitSha, MAIN_SHA);
  const planUrl = String(evidence.plan.evidence?.permanentUrl);
  const sourceUrl = String(evidence.source.evidence?.permanentUrl);
  assert.match(planUrl, new RegExp(MAIN_SHA));
  return {
    status: "ready" as const,
    summary: "personal-agent 实施评估完成：规划、源码、PR 与 CI 均有固定 SHA 回执。",
    evidence: [
      { kind: "github", value: planUrl },
      { kind: "github", value: sourceUrl },
    ],
    findings: [
      {
        id: "f1",
        requirementRef: "docs/24 GH-04 只读评估",
        classification: "observed" as const,
        severity: "high" as const,
        repositoryId,
        commitSha,
        evidenceRefs: [planUrl],
        expected: "规划要求固定 SHA 的 project review 证据",
        actual: "当前实现只提供只读草稿，尚未持久化审批对象",
        impact: "评估结果无法跨任务复用，审批前缺少稳定身份",
        existingIssueMatches: [60],
        suggestedAction: "持久化 DraftSnapshot 并绑定 payload hash",
        coverage: "complete" as const,
        truncated: false,
      },
      {
        id: "f2",
        requirementRef: "docs/24 GH-02 PR 证据",
        classification: "observed" as const,
        severity: "medium" as const,
        repositoryId,
        commitSha,
        evidenceRefs: [sourceUrl],
        expected: "PR 文件证据应固定 head SHA",
        actual: "pull_files 已带 head/base SHA 和 stale 标记",
        impact: "读取期间 head 变化时仍需要 verifier 拒绝结论",
        existingIssueMatches: [],
        suggestedAction: "补充 head 漂移的端到端回归测试",
        coverage: "complete" as const,
        truncated: false,
      },
    ],
    issueDrafts: [
      {
        action: "update" as const,
        targetIssue: 60,
        title: "GH-02 evidence",
        body: "补充固定 SHA 与凭据 epoch 的只读评估证据。",
        findingIds: ["f1"],
        beforeHash: createHash("sha256")
          .update(`GH-02 evidence\n${ISSUE_BODY}`)
          .digest("hex"),
        requiresOwnerApproval: true as const,
      },
      {
        action: "create" as const,
        title: "Cover pull-file head drift in project review",
        body: "当 PR head 在读取期间变化时，project review 必须标记 stale 并要求重新读取。",
        findingIds: ["f2"],
        requiresOwnerApproval: true as const,
      },
    ],
  };
}

async function completeReview(options: FakeGitHubOptions = {}) {
  const fixture = await runReview(options);
  const claimed = fixture.services.tasks.claimNext(START.toISOString(), 60_000, 2);
  assert.ok(claimed);
  fixture.services.taskService.report(
    claimed.assignment.id,
    claimed.assignment.fencingToken,
    claimed.assignment.taskRevision,
    reviewReport(fixture.services, fixture.task),
  );
  return {
    ...fixture,
    task: fixture.services.tasks.get(fixture.task.id) as TaskRecord,
    assignment: claimed.assignment,
  };
}

describe("read-only project review E2E (fake GitHub API)", () => {
  it("runs binding → typed reads → verified findings/drafts → Feishu outbox", async () => {
    const { services, task, github } = await completeReview();
    const verified = services.tasks.get(task.id) as TaskRecord;
    assert.equal(verified.status, "succeeded");
    assert.equal(verified.verification?.verifier, "project-review");
    assert.equal(verified.verification?.verdict, "succeeded");
    assert.equal(verified.verification?.missing.length, 0);
    assert.match(verified.verification?.reason ?? "", /2 observed/);
    assert.match(verified.verification?.reason ?? "", /2 issue draft/);
    assert.ok(
      verified.verification?.checked.includes("finding:f1:evidence"),
    );
    assert.equal(verified.verification?.externalFactsVerified, false);

    const outbox = services.store.listRecentOutbox(20);
    const resultText = outbox.map((row) => row.text).join("\n");
    assert.match(resultText, /项目评估（已核对证据引用，结论为模型分析）/);
    assert.match(resultText, /待办草稿/);
    assert.match(resultText, /approval required/);
    assert.match(resultText, /GH-02 evidence/);

    // Full Feishu delivery E1: raw Feishu event → adapter parse → Router →
    // project review → Outbox → Feishu send API with a real message id.
    const delivered = await deliverFeishu(services);
    assert.ok(
      delivered.some(
        (text) =>
          text.includes("项目评估（已核对证据引用，结论为模型分析）") &&
          text.includes("待办草稿"),
      ),
    );
    const accepted = services.store
      .listRecentOutbox(50)
      .filter((row) => row.status === "accepted");
    assert.ok(accepted.some((row) => row.text.includes("项目评估")));
    assert.ok(
      accepted
        .filter((row) => row.text.includes("项目评估"))
        .every((row) => row.platformMessageId !== undefined),
    );

    const persisted = services.issueDrafts.list(services.owner.id);
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((draft) => draft.status === "pending_approval"));
    assert.ok(persisted.every((draft) => draft.validity === "valid"));
    assert.ok(persisted.every((draft) => /^[0-9a-f]{64}$/.test(draft.payloadHash)));
    assert.ok(persisted.every((draft) => draft.repositoryId === REPOSITORY_ID));
    assert.ok(persisted.every((draft) => draft.commitSha === MAIN_SHA));
    assert.ok(persisted.every((draft) => draft.sourceTaskId === task.id));
    const updateDraft = persisted.find((draft) => draft.action === "update");
    assert.ok(updateDraft);
    assert.equal(updateDraft.targetIssue, 60);
    assert.equal(
      updateDraft.beforeHash,
      createHash("sha256").update(`GH-02 evidence\n${ISSUE_BODY}`).digest("hex"),
    );
    assert.match(updateDraft.beforeSummary ?? "", /Existing GH-02 evidence body/);
    const createDraft = persisted.find((draft) => draft.action === "create");
    assert.ok(createDraft);
    assert.equal(createDraft.targetIssue, undefined);

    const audits = services.store
      .listAuditAfter(0, 200)
      .map((row) => row.event);
    assert.ok(audits.includes("action.succeeded"));
    assert.ok(!audits.includes("action.failed"));

    // Replaying a settled action must not call GitHub again.
    const callsBefore = github.calls.length;
    await services.actionService.handleExecute({
      actionId: evidenceFor(services, task.id).actions[0]?.id,
    });
    const after = services.tasks.get(task.id);
    assert.equal(after?.status, "succeeded");
    assert.equal(github.calls.length, callsBefore);
  });

  it("deduplicates repeated verified drafts instead of creating duplicates", async () => {
    const { services, task, assignment } = await completeReview();
    const first = services.issueDrafts.list(services.owner.id);
    assert.equal(first.length, 2);
    const actions = services.actions.listByTask(task.id);
    const findings = [
      {
        id: "f1",
        requirementRef: "docs/24 GH-04 只读评估",
        classification: "observed" as const,
        severity: "high" as const,
        repositoryId: REPOSITORY_ID,
        commitSha: MAIN_SHA,
        evidenceRefs: [String(actions.find((action) => action.args.path === PLAN_PATH)?.evidence?.permanentUrl)],
        expected: "x",
        actual: "y",
        impact: "z",
        existingIssueMatches: [60],
        suggestedAction: "a",
      },
      {
        id: "f2",
        requirementRef: "docs/24 GH-02 PR 证据",
        classification: "observed" as const,
        severity: "medium" as const,
        repositoryId: REPOSITORY_ID,
        commitSha: MAIN_SHA,
        evidenceRefs: [String(actions.find((action) => action.args.path === SOURCE_PATH)?.evidence?.permanentUrl)],
        expected: "x",
        actual: "y",
        impact: "z",
        existingIssueMatches: [],
        suggestedAction: "a",
      },
    ];
    const drafts = assignDraftKeys(findings, reviewReport(services, task).issueDrafts);
    const result = services.issueDrafts.recordVerified({
      task,
      assignment,
      findings,
      drafts,
      actions,
    });
    assert.equal(result.recorded.length, 2);
    assert.equal(result.deduplicated, 2);
    const after = services.issueDrafts.list(services.owner.id);
    assert.deepEqual(after.map((draft) => draft.id).sort(), first.map((draft) => draft.id).sort());
  });

  it("rejects a draft and invalidates it for later approval", async () => {
    const { services } = await completeReview();
    const draft = services.issueDrafts.list(services.owner.id)[0];
    assert.ok(draft);
    const rejected = services.issueDrafts.reject(services.owner.id, draft.id, "owner");
    assert.equal(rejected.ok, true);
    assert.equal(rejected.draft?.status, "rejected");
    assert.equal(services.issueDrafts.get(services.owner.id, draft.id)?.validity, "inactive");
    const second = services.issueDrafts.reject(services.owner.id, draft.id, "owner");
    assert.equal(second.ok, false);
    assert.match(second.reason ?? "", /draft_rejected/);
  });

  it("supersedes drafts on task revision, binding revoke and credential rotation", async () => {
    const revision = await completeReview();
    const revisionDrafts = revision.services.issueDrafts.list(revision.services.owner.id);
    assert.equal(revisionDrafts.length, 2);
    revision.services.issueDrafts.supersedeForTask(revision.task.id, revision.task.revision + 1);
    assert.ok(
      revision.services.issueDrafts
        .list(revision.services.owner.id)
        .every((draft) => draft.status === "superseded"),
    );

    const binding = await completeReview();
    const project = binding.services.projects.findActiveByKey(
      binding.services.owner.id,
      PROJECT_KEY,
    );
    assert.ok(project);
    binding.services.projectService.unbind(binding.services.owner.id, project.id, "owner");
    assert.ok(
      binding.services.issueDrafts
        .list(binding.services.owner.id)
        .every((draft) => draft.status === "superseded"),
    );

    const credential = await completeReview();
    credential.credentials.rotate("github:default", {
      token: "project-token",
      scopes: ["repository.read"],
      ownerId: credential.services.owner.id,
      repositoryIds: [REPOSITORY_ID],
    });
    assert.ok(
      credential.services.issueDrafts
        .list(credential.services.owner.id)
        .every((draft) => draft.status === "superseded"),
    );

    const explicit = await completeReview();
    const count = explicit.services.issueDrafts.supersedeForCredential(
      explicit.services.owner.id,
      "github:default",
    );
    assert.equal(count, 2);
    assert.ok(
      explicit.services.issueDrafts
        .list(explicit.services.owner.id)
        .every((draft) => draft.status === "superseded"),
    );
  });

  it("expires drafts past their approval window", async () => {
    const { services } = await completeReview();
    services.store.db.run(
      "UPDATE pa_issue_drafts SET expires_at = ?",
      "2025-12-31T00:00:00.000Z",
    );
    const expired = services.issueDrafts.list(services.owner.id);
    assert.equal(expired.length, 2);
    assert.ok(expired.every((draft) => draft.status === "expired"));
    assert.ok(expired.every((draft) => draft.validity === "expired"));
  });

  it("refuses an unbound projectKey, a wrong repo, a revoked binding and a missing credential before fetch", async () => {
    const { services, github } = setup();
    const tool = services.tools.get("github.read");
    assert.ok(tool);
    const context = { ownerId: services.owner.id, project: PROJECT_KEY };
    const before = github.calls.length;

    await assert.rejects(
      () =>
        tool.execute({
          operation: "file",
          projectKey: "other-project",
          sha: MAIN_SHA,
          path: PLAN_PATH,
        }),
      /not an active repository binding/,
    );
    await assert.rejects(
      () =>
        tool.execute(
          { operation: "file", projectKey: PROJECT_KEY, sha: MAIN_SHA, path: PLAN_PATH },
          { ownerId: services.owner.id, project: "other-project" },
        ),
      /projectKey does not match the task mandate/,
    );
    await assert.rejects(
      () =>
        tool.execute(
          { operation: "file", projectKey: PROJECT_KEY, sha: MAIN_SHA, path: PLAN_PATH },
          { ownerId: "other-owner", project: PROJECT_KEY },
        ),
      /not owned by the requesting owner/,
    );
    assert.equal(github.calls.length, before);

    const project = services.projects.findActiveByKey(services.owner.id, PROJECT_KEY);
    assert.ok(project);
    services.projectService.unbind(services.owner.id, project.id, "admin");
    await assert.rejects(
      () =>
        tool.execute(
          { operation: "file", projectKey: PROJECT_KEY, sha: MAIN_SHA, path: PLAN_PATH },
          context,
        ),
      /not an active repository binding/,
    );

    const second = setup();
    const secondTool = second.services.tools.get("github.read");
    assert.ok(secondTool);
    second.services.projectService.bind(
      second.services.owner.id,
      bindingInput({ credentialRef: "github:missing" }),
      "admin",
    );
    await assert.rejects(
      () =>
        secondTool.execute(
          {
            operation: "file",
            projectKey: PROJECT_KEY,
            sha: MAIN_SHA,
            path: PLAN_PATH,
          },
          { ownerId: second.services.owner.id, project: PROJECT_KEY },
        ),
      /credential github:missing is unavailable/,
    );
  });

  it("rejects repository identity mismatch and credential revocation", async () => {
    const mismatch = setup({ repositoryId: 999 });
    const tool = mismatch.services.tools.get("github.read");
    assert.ok(tool);
    await assert.rejects(
      () =>
        tool.execute(
          { operation: "file", projectKey: PROJECT_KEY, sha: MAIN_SHA, path: PLAN_PATH },
          { ownerId: mismatch.services.owner.id, project: PROJECT_KEY },
        ),
      /repository identity does not match/,
    );
    assert.deepEqual(mismatch.github.calls, [`/repos/${REPO}`]);

    const revoked = setup();
    revoked.credentials.revoke("github:default");
    const revokedTool = revoked.services.tools.get("github.read");
    assert.ok(revokedTool);
    await assert.rejects(
      () =>
        revokedTool.execute(
          { operation: "file", projectKey: PROJECT_KEY, sha: MAIN_SHA, path: PLAN_PATH },
          { ownerId: revoked.services.owner.id, project: PROJECT_KEY },
        ),
      /credential github:default is unavailable/,
    );
    assert.equal(revoked.github.calls.length, 0);
  });

  it("marks PR evidence stale when the head moves and refuses completion claims", async () => {
    const { services } = setup({ headShas: [PR_HEAD, PR_BASE, MAIN_SHA] });
    const tool = services.tools.get("github.read");
    assert.ok(tool);
    const result = await tool.execute(
      {
        operation: "pull_files",
        projectKey: PROJECT_KEY,
        repo: REPO,
        number: 7,
      },
      { ownerId: services.owner.id, project: PROJECT_KEY },
    );
    assert.equal(result.evidence.stale, true);
    assert.equal(result.evidence.coverage, "unknown");
    assert.equal(result.evidence.headSha, MAIN_SHA);
  });

  it("rejects truncated evidence presented as complete and cross-revision findings", async () => {
    for (const scenario of [
      {
        options: {},
        mutate: (report: ReturnType<typeof reviewReport>) => {
          const finding = report.findings[0];
          assert.ok(finding);
          finding.commitSha = "f".repeat(40);
        },
        missing: /revision_receipt_missing/,
      },
      {
        options: { truncatedPlan: true },
        mutate: (report: ReturnType<typeof reviewReport>) => {
          const finding = report.findings[0];
          assert.ok(finding);
          finding.coverage = "complete";
        },
        missing: /coverage_overstates_truncated_evidence/,
      },
    ]) {
      const { services, task } = await runReview(scenario.options);
      const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
      assert.ok(claimed);
      const report = reviewReport(services, task);
      scenario.mutate(report);
      services.taskService.report(
        claimed.assignment.id,
        claimed.assignment.fencingToken,
        claimed.assignment.taskRevision,
        report,
      );
      const current = services.tasks.get(task.id);
      assert.equal(current?.status, "needs_review");
      assert.match(current?.verification?.missing.join(",") ?? "", scenario.missing);
    }
  });
});

describe("draft pre-state fidelity", () => {
  it("keeps the verifier's full-title beforeHash instead of re-hashing a truncated title", () => {
    const { services } = setup();
    const task = services.taskService.createExternalActionTask({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "draft:long-title",
      goal: "review",
      completionCriteria: "done",
      mandate: {
        resources: ["chat"],
        tools: [],
        project: PROJECT_KEY,
        skills: ["github.project-review"],
      },
    });
    const longTitle = `T${"i".repeat(240)}`;
    const body = "old body";
    const fullHash = createHash("sha256")
      .update(`${longTitle}\n${body}`)
      .digest("hex");
    const action = {
      tool: "github.read",
      status: "succeeded",
      args: { operation: "issue", repo: REPO, number: 60 },
      evidence: {
        item: {
          number: 60,
          title: `${longTitle.slice(0, 200)}…`,
          body,
          beforeHash: fullHash,
        },
      },
    } as unknown as ActionRecord;
    const result = services.issueDrafts.recordVerified({
      task,
      assignment: { id: "assignment:long-title" } as AssignmentRecord,
      findings: [
        {
          id: "f1",
          requirementRef: "GH-04",
          classification: "observed",
          severity: "high",
          repositoryId: REPOSITORY_ID,
          commitSha: MAIN_SHA,
          evidenceRefs: [],
          expected: "x",
          actual: "y",
          impact: "z",
          existingIssueMatches: [60],
          suggestedAction: "update",
        },
      ],
      drafts: [
        {
          action: "update",
          targetIssue: 60,
          title: "new title",
          body: "new body",
          findingIds: ["f1"],
          beforeHash: fullHash,
          idempotencyKey: "e".repeat(32),
          requiresOwnerApproval: true,
        },
      ],
      actions: [action],
    });
    assert.equal(result.recorded[0]?.beforeHash, fullHash);
    assert.equal(result.recorded[0]?.beforeSummary, body);
  });
});

describe("draft credential epoch binding", () => {
  it("stores the epoch used by evidence and supersedes after a later rotation", () => {
    const { services, credentials } = setup();
    const task = services.taskService.createExternalActionTask({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "draft:credential-epoch",
      goal: "review",
      completionCriteria: "done",
      mandate: {
        resources: ["chat"],
        tools: [],
        project: PROJECT_KEY,
        skills: ["github.project-review"],
      },
    });
    const action = {
      tool: "github.read",
      status: "succeeded",
      args: { operation: "file", repo: REPO, sha: MAIN_SHA, path: PLAN_PATH },
      evidence: {
        operation: "file",
        commitSha: MAIN_SHA,
        repositoryId: REPOSITORY_ID,
        permanentUrl: `https://github.com/${REPO}/blob/${MAIN_SHA}/${PLAN_PATH}`,
        credentialVersion: 1,
        item: { type: "file", path: PLAN_PATH },
      },
    } as unknown as ActionRecord;
    const recorded = services.issueDrafts.recordVerified({
      task,
      assignment: { id: "assignment:credential-epoch" } as AssignmentRecord,
      findings: [
        {
          id: "f1",
          requirementRef: "GH-04",
          classification: "observed",
          severity: "high",
          repositoryId: REPOSITORY_ID,
          commitSha: MAIN_SHA,
          evidenceRefs: [String(action.evidence?.permanentUrl)],
          expected: "x",
          actual: "y",
          impact: "z",
          existingIssueMatches: [],
          suggestedAction: "create",
        },
      ],
      drafts: [
        {
          action: "create",
          title: "Epoch bound draft",
          body: "body",
          findingIds: ["f1"],
          idempotencyKey: "a".repeat(31) + "1",
          requiresOwnerApproval: true,
        },
      ],
      actions: [action],
    });
    assert.equal(recorded.recorded[0]?.credentialVersion, 1);
    credentials.rotate("github:default", {
      token: "project-token-2",
      scopes: ["repository.read"],
      ownerId: services.owner.id,
      repositoryIds: [REPOSITORY_ID],
    });
    assert.equal(
      services.issueDrafts.get(services.owner.id, recorded.recorded[0]?.id ?? "")
        ?.status,
      "superseded",
    );
  });
});
