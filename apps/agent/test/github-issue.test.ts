import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { CredentialBroker } from "../src/actions/credentials.ts";
import {
  createGitHubIssueWriteTools,
  type GitHubIssueWriteConfig,
} from "../src/actions/github-issue.ts";
import { ToolUnknownError } from "../src/actions/tooling.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const OWNER = "owner-1";
const REPO = "owner/repo";
const REPO_ID = 101;
const BINDING = {
  projectKey: "personal-agent",
  repositoryId: REPO_ID,
  repositoryFullName: REPO,
  credentialRef: "github:issues",
  status: "active" as const,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeIssues {
  readonly requests: { method: string; path: string; body?: string }[] = [];
  issues: Record<string, unknown>[] = [
    {
      number: 7,
      id: 70,
      title: "Existing issue",
      body: "old body",
      state: "open",
      html_url: `https://github.com/${REPO}/issues/7`,
    },
  ];
  comments: Record<string, unknown>[] = [];
  failAfterPost = false;
  identityMismatch = false;
  private nextIssue = 100;
  private nextComment = 1;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body === undefined ? undefined : String(init.body);
    this.requests.push({ method, path: url.pathname, body });
    if (url.pathname === `/repos/${REPO}`) {
      return json({ id: this.identityMismatch ? 999 : REPO_ID, full_name: REPO });
    }
    if (url.pathname === `/repos/${REPO}/issues` && method === "GET") {
      return json([...this.issues].reverse());
    }
    if (url.pathname === `/repos/${REPO}/issues` && method === "POST") {
      const payload = JSON.parse(body ?? "{}") as {
        title?: string;
        body?: string;
      };
      const issue = {
        number: this.nextIssue++,
        id: this.nextIssue,
        title: payload.title ?? "",
        body: payload.body ?? "",
        state: "open",
        html_url: `https://github.com/${REPO}/issues/${this.nextIssue - 1}`,
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
    if (issueMatch !== null && method === "GET") {
      const issue = this.issues.find(
        (item) => item.number === Number(issueMatch[1]),
      );
      return issue === undefined ? json({ message: "Not Found" }, 404) : json(issue);
    }
    if (issueMatch !== null && method === "PATCH") {
      const issue = this.issues.find(
        (item) => item.number === Number(issueMatch[1]),
      );
      if (issue === undefined) {
        return json({ message: "Not Found" }, 404);
      }
      const payload = JSON.parse(body ?? "{}") as Record<string, unknown>;
      Object.assign(issue, payload);
      return json(issue);
    }
    if (
      url.pathname === `/repos/${REPO}/issues/7/comments` &&
      method === "GET"
    ) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      return json(this.comments.slice((page - 1) * perPage, page * perPage));
    }
    if (
      url.pathname === `/repos/${REPO}/issues/7/comments` &&
      method === "POST"
    ) {
      const payload = JSON.parse(body ?? "{}") as { body?: string };
      const comment = {
        id: this.nextComment++,
        body: payload.body ?? "",
        html_url: `https://github.com/${REPO}/issues/7#issuecomment-${this.nextComment}`,
      };
      this.comments.push(comment);
      return json(comment, 201);
    }
    const commentMatch = /^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/.exec(
      url.pathname,
    );
    if (commentMatch !== null) {
      const comment = this.comments.find(
        (item) => item.id === Number(commentMatch[1]),
      );
      return comment === undefined ? json({ message: "Not Found" }, 404) : json(comment);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

function fixture(overrides: Partial<GitHubIssueWriteConfig> = {}) {
  const fake = new FakeIssues();
  const credentials = new CredentialBroker(() => NOW);
  credentials.register("github:issues", {
    token: "write-secret",
    scopes: ["repository.read", "issues.write"],
    ownerId: OWNER,
    repositoryIds: [REPO_ID],
  });
  const tools = createGitHubIssueWriteTools({
    allowedRepos: [REPO],
    issueCredentialRef: "github:issues",
    resolveProject: () => BINDING,
    credentials,
    fetch: fake.fetch,
    ...overrides,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const context = { ownerId: OWNER, project: BINDING.projectKey };
  const version = credentials.status("github:issues")?.version ?? 0;
  return { fake, credentials, byName, context, version };
}

function base(version: number, overrides: Record<string, unknown> = {}) {
  return {
    projectKey: BINDING.projectKey,
    repo: REPO,
    repositoryId: REPO_ID,
    credentialRef: "github:issues",
    credentialVersion: version,
    payloadHash: "a".repeat(64),
    idempotencyKey: "b".repeat(32),
    ...overrides,
  };
}

describe("typed GitHub issue writes", () => {
  it("creates one issue, verifies it by reading after write, and is idempotent", async () => {
    const { fake, byName, context, version } = fixture();
    const tool = byName.get("github.issue.create");
    assert.ok(tool);
    const args = base(version, { title: "New issue", body: "body text" });
    const first = await tool.execute(args, context);
    assert.equal(first.evidence.verified, true);
    assert.equal(first.evidence.readAfterWrite, true);
    assert.equal(first.evidence.repositoryId, REPO_ID);
    assert.match(String(first.externalRef), /\/issues\/100$/);
    const posts = fake.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/issues"),
    );
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.body ?? "", /personal-agent:b{32}/);

    const replay = await tool.execute(args, context);
    assert.equal(replay.evidence.issueNumber, first.evidence.issueNumber);
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/issues"),
      ).length,
      1,
    );
  });

  it("updates only when the before hash still matches", async () => {
    const { fake, byName, context, version } = fixture();
    const tool = byName.get("github.issue.update");
    assert.ok(tool);
    const beforeHash = "5bf3e85a6ed5c27d8b0b56ebd63b6a4dcd51833cd07a5328003197f5c1a1eab9";
    const conflict = base(version, {
      targetIssue: 7,
      title: "Changed title",
      body: "new body",
      beforeHash: "c".repeat(64),
    });
    await assert.rejects(
      () => tool.execute(conflict, context),
      /issue changed since approval/,
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "PATCH").length,
      0,
    );

    // Use the real hash of "old body" for the approved pre-state.
    const realBefore = createHash("sha256")
      .update("Existing issue\nold body")
      .digest("hex");
    assert.notEqual(realBefore, beforeHash);
    const result = await tool.execute(
      base(version, {
        targetIssue: 7,
        title: "New title",
        body: "new body",
        beforeHash: realBefore,
      }),
      context,
    );
    assert.equal(result.evidence.verified, true);
    assert.equal(
      fake.requests.filter((request) => request.method === "PATCH").length,
      1,
    );
    const issue = fake.issues.find((item) => item.number === 7);
    assert.equal(issue?.title, "New title");
    assert.equal(issue?.body, "new body");

    // A title-only update must actually PATCH, not report a no-op success.
    const titleOnly = await tool.execute(
      base(version, {
        targetIssue: 7,
        title: "Title only",
        beforeHash: createHash("sha256")
          .update("New title\nnew body")
          .digest("hex"),
      }),
      context,
    );
    assert.equal(titleOnly.evidence.verified, true);
    assert.equal(
      fake.requests.filter((request) => request.method === "PATCH").length,
      2,
    );
    assert.equal(issue?.title, "Title only");
    assert.equal(issue?.body, "new body");
  });

  it("comments once with a marker and re-reads the comment", async () => {
    const { fake, byName, context, version } = fixture();
    const tool = byName.get("github.issue.comment");
    assert.ok(tool);
    const args = base(version, { targetIssue: 7, body: "a comment" });
    const first = await tool.execute(args, context);
    assert.equal(first.evidence.verified, true);
    assert.equal(first.evidence.commentId, 1);
    const replay = await tool.execute(args, context);
    assert.equal(replay.evidence.commentId, 1);
    assert.equal(
      fake.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      ).length,
      1,
    );

    // A marker beyond the first 100 comments is still found without a POST.
    fake.comments = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index + 1}`,
      html_url: `https://github.com/${REPO}/issues/7#issuecomment-${index + 1}`,
    }));
    fake.comments[110] = {
      id: 111,
      body: `<!-- personal-agent:${"c".repeat(32)}:${"a".repeat(64)} -->\n\nolder replay`,
      html_url: `https://github.com/${REPO}/issues/7#issuecomment-111`,
    };
    const paginated = await tool.execute(
      base(version, {
        targetIssue: 7,
        body: "body",
        idempotencyKey: "c".repeat(32),
      }),
      context,
    );
    assert.equal(paginated.evidence.commentId, 111);
    assert.equal(
      fake.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      ).length,
      1,
    );
  });

  it("fails closed on scope, credential epoch, identity and write allowlist", async () => {
    const { credentials, byName, context, version, fake } = fixture();
    const tool = byName.get("github.issue.create");
    assert.ok(tool);
    await assert.rejects(
      () =>
        tool.execute(
          { ...base(version, { title: "x", body: "y" }), credentialVersion: version + 1 },
          context,
        ),
      /credential changed since approval/,
    );
    await assert.rejects(
      () =>
        tool.execute(
          base(version, { title: "x", body: "y" }),
          { ownerId: "other-owner", project: BINDING.projectKey },
        ),
      /not owned by the requesting owner/,
    );
    credentials.rotate("github:issues", {
      token: "write-secret-2",
      scopes: ["repository.read", "issues.write"],
      ownerId: OWNER,
      repositoryIds: [REPO_ID],
    });
    await assert.rejects(
      () => tool.execute(base(version, { title: "x", body: "y" }), context),
      /credential changed since approval/,
    );

    const mismatch = fixture({});
    mismatch.fake.identityMismatch = true;
    const mismatchTool = mismatch.byName.get("github.issue.create");
    assert.ok(mismatchTool);
    await assert.rejects(
      () =>
        mismatchTool.execute(
          base(mismatch.version, { title: "x", body: "y" }),
          mismatch.context,
        ),
      /repository identity does not match/,
    );

    const limited = createGitHubIssueWriteTools({
      allowedRepos: ["owner/other"],
      issueCredentialRef: "github:issues",
      resolveProject: () => BINDING,
      credentials,
      fetch: fake.fetch,
    }).find((candidate) => candidate.name === "github.issue.create");
    assert.ok(limited);
    await assert.rejects(
      () => limited.execute(base(version, { title: "x", body: "y" }), context),
      /not in the issue write allow list/,
    );
  });

  it("returns unknown after a lost POST and reconciles by marker instead of repeating", async () => {
    const { fake, byName, context, version } = fixture();
    fake.failAfterPost = true;
    const tool = byName.get("github.issue.create");
    assert.ok(tool);
    const args = base(version, { title: "Lost issue", body: "lost body" });
    await assert.rejects(
      () => tool.execute(args, context),
      ToolUnknownError,
    );
    // The fake applied the issue before the socket error; verify sees it.
    const verified = await tool.verify(args, context);
    assert.equal(verified.satisfied, true);
    assert.equal(verified.evidence.verified, true);
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/issues"),
      ).length,
      1,
    );
  });

  it("rejects unsupported target shapes before any request", async () => {
    const { byName, context, version, fake } = fixture();
    const create = byName.get("github.issue.create");
    const comment = byName.get("github.issue.comment");
    assert.ok(create && comment);
    await assert.rejects(
      () =>
        create.execute(
          base(version, { title: "x", body: "y", targetIssue: 7 }),
          context,
        ),
      /must not target/,
    );
    await assert.rejects(
      () =>
        comment.execute(
          base(version, { body: "y", title: "x", targetIssue: 7 }),
          context,
        ),
      /comment requires body and no title/,
    );
    const update = byName.get("github.issue.update");
    assert.ok(update);
    await assert.rejects(
      () => update.execute(base(version, { targetIssue: 7 }), context),
      /update requires title or body/,
    );
    assert.equal(fake.requests.length, 0);
  });
});

describe("issue write idempotency robustness", () => {
  it("keeps the marker discoverable and verifies a long body", async () => {
    const { fake, byName, context, version } = fixture();
    const tool = byName.get("github.issue.create");
    assert.ok(tool);
    const body = `long body ${"x".repeat(10_000)}`;
    const args = base(version, {
      title: "Long issue",
      body,
      idempotencyKey: "d".repeat(32),
    });
    const first = await tool.execute(args, context);
    assert.equal(first.evidence.verified, true);
    const issue = fake.issues.find(
      (item) => item.number === first.evidence.issueNumber,
    );
    assert.ok(issue);
    assert.ok(String(issue.body).startsWith("<!-- personal-agent:"));
    assert.ok(String(issue.body).endsWith(body));
    const replay = await tool.execute(args, context);
    assert.equal(replay.evidence.issueNumber, first.evidence.issueNumber);
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/issues"),
      ).length,
      1,
    );
  });
});

describe("marker payload binding", () => {
  it("does not reuse an artifact with the same key but a different payload", async () => {
    const { fake, byName, context, version } = fixture();
    const key = "7".repeat(32);
    fake.issues.push({
      number: 99,
      id: 990,
      title: "Old artifact",
      body: `<!-- personal-agent:${key}:${"0".repeat(64)} -->\n\nold payload`,
      state: "open",
      html_url: `https://github.com/${REPO}/issues/99`,
    });
    const tool = byName.get("github.issue.create");
    assert.ok(tool);
    const result = await tool.execute(
      base(version, {
        title: "New payload",
        body: "new payload",
        idempotencyKey: key,
      }),
      context,
    );
    assert.notEqual(result.evidence.issueNumber, 99);
    assert.equal(
      fake.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/issues"),
      ).length,
      1,
    );
  });
});
