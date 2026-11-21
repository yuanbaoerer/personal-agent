import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubReadTool, type GitHubProjectBinding } from "../src/actions/github.ts";
import { ToolRejectedError } from "../src/actions/tools.ts";
import { createStore } from "./helpers.ts";
import { createServices } from "./services.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

const BINDING: GitHubProjectBinding = {
  projectKey: "personal-agent",
  repositoryId: 101,
  repositoryFullName: "owner/repo",
  status: "active",
};

function resolveProject(key: string): GitHubProjectBinding | undefined {
  return key === BINDING.projectKey ? BINDING : undefined;
}

function fetchReturning(
  body: unknown,
  calls: { url: string; init?: RequestInit }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body);
  }) as typeof fetch;
}

describe("read-only GitHub connector", () => {
  it("sends an authenticated GET only to an allow-listed repo", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: fetchReturning(
        {
          full_name: "owner/repo",
          default_branch: "main",
          pushed_at: "2026-01-01T00:00:00Z",
          open_issues_count: 3,
          html_url: "https://github.com/owner/repo",
        },
        calls,
      ),
    });

    const result = await tool.execute({ operation: "repo", repo: "owner/repo" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.github.com/repos/owner/repo");
    assert.equal(calls[0]?.init?.method, "GET");
    assert.equal(calls[0]?.init?.redirect, "error");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-token");
    assert.equal(result.evidence.source, "https://github.com/owner/repo");
    assert.equal((await tool.verify()).satisfied, false);
    assert.deepEqual(result.evidence.item, {
      fullName: "owner/repo",
      defaultBranch: "main",
      pushedAt: "2026-01-01T00:00:00Z",
      openIssues: 3,
      url: "https://github.com/owner/repo",
    });
  });

  it("resolves an OAuth token provider at execution time", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let token: string | undefined = "oauth-token";
    const tool = new GitHubReadTool({
      allowedRepos: ["owner/repo"],
      tokenProvider: async () => token,
      fetch: fetchReturning({ full_name: "owner/repo" }, calls),
    });
    await tool.execute({ operation: "repo", repo: "owner/repo" });
    let headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer oauth-token");

    token = undefined;
    await assert.rejects(
      () => tool.execute({ operation: "repo", repo: "owner/repo" }),
      /OAuth is not connected/,
    );
  });

  it("rejects a repo outside the allow list before any fetch", async () => {
    let called = 0;
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });

    await assert.rejects(
      () => tool.execute({ operation: "commits", repo: "owner/other" }),
      ToolRejectedError,
    );
    await assert.rejects(
      () => tool.execute({ operation: "commits", repo: "owner/.." }),
      ToolRejectedError,
    );
    assert.equal(called, 0);
  });

  it("caps item count and preserves source URLs", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: fetchReturning(
        [
          {
            sha: "a".repeat(40),
            html_url: "https://github.com/owner/repo/commit/a",
            commit: {
              message: "fix: first line\n\nbody",
              author: { name: "Alice", date: "2026-01-01T00:00:00Z" },
            },
          },
          {
            sha: "b".repeat(40),
            html_url: "https://github.com/owner/repo/commit/b",
            commit: {
              message: "fix: second",
              author: { name: "Bob", date: "2026-01-02T00:00:00Z" },
            },
          },
          {
            sha: "c".repeat(40),
            html_url: "https://github.com/owner/repo/commit/c",
            commit: {
              message: "fix: third",
              author: { name: "Cara", date: "2026-01-03T00:00:00Z" },
            },
          },
        ],
        calls,
      ),
    });

    const result = await tool.execute({
      operation: "commits",
      repo: "owner/repo",
      limit: 2,
    });

    assert.match(calls[0]?.url ?? "", /per_page=2/);
    const items = result.evidence.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.message, "fix: first line");
    assert.equal(items[0]?.url, "https://github.com/owner/repo/commit/a");
    assert.equal(items[1]?.message, "fix: second");
  });

  it("rejects an out-of-range limit and an oversized body", async () => {
    let called = 0;
    const limited = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: (async () => {
        called += 1;
        return jsonResponse([]);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => limited.execute({ operation: "issues", repo: "owner/repo", limit: 21 }),
      ToolRejectedError,
    );
    assert.equal(called, 0);

    const oversized = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      maxBytes: 16,
      fetch: (async () =>
        new Response(JSON.stringify([{ number: 1, title: "x".repeat(100) }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    await assert.rejects(
      () => oversized.execute({ operation: "issues", repo: "owner/repo" }),
      /size limit/,
    );
  });

  it("distinguishes auth, rate limit, permission and not-found failures", async () => {
    const cases = [
      { status: 401, message: /authentication failed/ },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
        message: /rate limit/,
      },
      {
        status: 429,
        message: /rate limit/,
      },
      {
        status: 403,
        headers: { "retry-after": "30" },
        message: /rate limit/,
      },
      { status: 403, message: /permission denied/ },
      { status: 404, message: /not found/ },
    ];
    for (const item of cases) {
      const tool = new GitHubReadTool({
        token: "secret-token",
        allowedRepos: ["owner/repo"],
        fetch: (async () =>
          new Response("nope", {
            status: item.status,
            headers: item.headers,
          })) as typeof fetch,
      });
      await assert.rejects(
        () => tool.execute({ operation: "issues", repo: "owner/repo" }),
        item.message,
      );
    }
  });

  it("uses the Link header to report truncation", async () => {
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: (async () =>
        new Response(JSON.stringify([{ number: 1, title: "one" }]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: '<https://api.github.com/repositories/1/issues?per_page=1&page=2>; rel="next"',
          },
        })) as typeof fetch,
    });

    const result = await tool.execute({
      operation: "issues",
      repo: "owner/repo",
      limit: 1,
    });

    assert.equal(result.evidence.truncated, true);
  });

  it("turns a timeout into a visible read failure", async () => {
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => tool.execute({ operation: "pulls", repo: "owner/repo" }),
      /timed out/,
    );
  });

  it("reads fixed-SHA files, trees, refs, issues, PR files and checks with provenance", async () => {
    const sha = "a".repeat(40);
    const calls: string[] = [];
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      resolveProject,
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url.toString());
        if (url.pathname.endsWith("/contents/docs/24.md")) {
          return jsonResponse({
            type: "file",
            path: "docs/24.md",
            name: "24.md",
            sha,
            size: 7,
            encoding: "base64",
            content: Buffer.from("# Plan\n", "utf8").toString("base64"),
            html_url: `https://github.com/owner/repo/blob/${sha}/docs/24.md`,
          });
        }
        if (url.pathname.endsWith(`/git/trees/${sha}`)) {
          return jsonResponse({
            sha,
            truncated: false,
            tree: [
              { path: "docs", mode: "040000", type: "tree", sha: "b".repeat(40) },
              { path: "docs/24.md", mode: "100644", type: "blob", sha, size: 7 },
            ],
          });
        }
        if (url.pathname.endsWith("/git/ref/heads/main")) {
          return jsonResponse({
            ref: "refs/heads/main",
            object: { sha, type: "commit", url: `https://api.github.com/commits/${sha}` },
          });
        }
        if (url.pathname.endsWith("/issues/12")) {
          return jsonResponse({
            number: 12,
            title: "Typed reads",
            state: "open",
            body: "body text",
            user: { login: "owner" },
            html_url: "https://github.com/owner/repo/issues/12",
          });
        }
        if (url.pathname.endsWith("/pulls/12/files")) {
          return jsonResponse([
            {
              filename: "src/a.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
              changes: 3,
              sha,
              patch: "@@ -1 +1 @@",
            },
          ]);
        }
        if (url.pathname.endsWith(`/commits/${sha}/check-runs`)) {
          return jsonResponse({
            total_count: 1,
            check_runs: [
              {
                id: 9,
                name: "ci",
                status: "completed",
                conclusion: "success",
                head_sha: sha,
                details_url: `https://github.com/owner/repo/commit/${sha}/checks`,
              },
            ],
          });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });

    const projectArgs = {
      projectKey: BINDING.projectKey,
      repo: BINDING.repositoryFullName,
    };
    const canonical = tool.canonicalize({
      operation: "file",
      projectKey: BINDING.projectKey,
      sha,
      path: "README.md",
    });
    assert.equal(canonical.repo, BINDING.repositoryFullName);
    assert.equal(canonical.projectKey, BINDING.projectKey);
    assert.equal(canonical.repositoryId, BINDING.repositoryId);

    const file = await tool.execute({
      operation: "file",
      ...projectArgs,
      sha,
      path: "docs/24.md",
    });
    assert.equal(file.evidence.projectKey, BINDING.projectKey);
    assert.equal(file.evidence.repositoryId, BINDING.repositoryId);
    assert.match(calls[0] ?? "", /\/contents\/docs\/24\.md\?ref=a{40}$/);
    assert.equal((file.evidence.item as Record<string, unknown>).content, "# Plan\n");
    assert.equal(
      (file.evidence.item as Record<string, unknown>).path,
      "docs/24.md",
    );

    const tree = await tool.execute({
      operation: "tree",
      ...projectArgs,
      sha,
      recursive: true,
      limit: 1,
    });
    assert.match(calls[1] ?? "", /\/git\/trees\/a{40}\?recursive=1$/);
    assert.equal((tree.evidence.items as unknown[]).length, 1);
    assert.equal(tree.evidence.truncated, true);

    const ref = await tool.execute({
      operation: "ref",
      ...projectArgs,
      ref: "heads/main",
    });
    assert.equal(ref.evidence.sha, sha);
    assert.equal(ref.evidence.type, "commit");

    const issue = await tool.execute({
      operation: "issue",
      ...projectArgs,
      number: 12,
    });
    assert.equal((issue.evidence.item as Record<string, unknown>).title, "Typed reads");

    const files = await tool.execute({
      operation: "pull_files",
      ...projectArgs,
      number: 12,
      limit: 1,
    });
    assert.equal(
      (files.evidence.items as Array<Record<string, unknown>>)[0]?.filename,
      "src/a.ts",
    );
    assert.match(files.evidence.source as string, /\/pull\/12\/files$/);

    const checks = await tool.execute({
      operation: "checks",
      ...projectArgs,
      sha,
      limit: 1,
    });
    assert.equal(
      (checks.evidence.items as Array<Record<string, unknown>>)[0]?.conclusion,
      "success",
    );
    assert.equal(calls.length, 6);
  });

  it("rejects unsafe typed-read arguments before fetching", async () => {
    let called = 0;
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      resolveProject,
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });
    const sha = "a".repeat(40);
    const projectKey = BINDING.projectKey;
    await assert.rejects(
      () => tool.execute({ operation: "file", projectKey, repo: "owner/repo", sha: "abc", path: "README.md" }),
      /fixed 40-character/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "file", projectKey, repo: "owner/repo", sha, path: "../secret" }),
      /safe repository-relative/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "file", projectKey, repo: "owner/repo", sha, path: "/etc/passwd" }),
      /safe repository-relative/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "tree", projectKey, repo: "owner/repo", sha: "not-a-sha" }),
      /fixed 40-character/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "ref", projectKey, repo: "owner/repo", ref: "-main" }),
      /safe branch/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "ref", projectKey, repo: "owner/repo", ref: "heads/../main" }),
      /safe branch/,
    );
    await assert.rejects(
      () => tool.execute({ operation: "checks", projectKey, repo: "owner/repo", sha: "b".repeat(39) }),
      /fixed 40-character/,
    );
    assert.equal(called, 0);
  });

  it("requires an active project binding for typed reads", async () => {
    let called = 0;
    const revoked: GitHubProjectBinding = { ...BINDING, status: "revoked" };
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      resolveProject: (key) =>
        key === "revoked-project" ? revoked : resolveProject(key),
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });
    const sha = "a".repeat(40);
    await assert.rejects(
      () =>
        tool.execute({
          operation: "file",
          projectKey: "missing-project",
          sha,
          path: "README.md",
        }),
      /active repository binding/,
    );
    await assert.rejects(
      () =>
        tool.execute({
          operation: "file",
          projectKey: "revoked-project",
          sha,
          path: "README.md",
        }),
      /active repository binding/,
    );
    await assert.rejects(
      () =>
        tool.execute({
          operation: "file",
          projectKey: BINDING.projectKey,
          repo: "other/repo",
          sha,
          path: "README.md",
        }),
      /does not match the active project binding/,
    );
    await assert.rejects(
      () =>
        tool.execute(
          {
            operation: "file",
            projectKey: BINDING.projectKey,
            sha,
            path: "README.md",
          },
          { ownerId: "owner-1", project: "other-project" },
        ),
      /task mandate project/,
    );
    await assert.rejects(
      () =>
        tool.execute({
          operation: "file",
          repo: "owner/repo",
          sha,
          path: "README.md",
        }),
      /requires an active projectKey/,
    );
    const noResolver = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await assert.rejects(
      () =>
        noResolver.execute({
          operation: "file",
          projectKey: BINDING.projectKey,
          sha,
          path: "README.md",
        }),
      /bindings are not configured/,
    );
    const throwingResolver = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      resolveProject: () => {
        throw new Error("db unavailable");
      },
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await assert.rejects(
      () =>
        throwingResolver.execute({
          operation: "file",
          projectKey: BINDING.projectKey,
          sha,
          path: "README.md",
        }),
      /binding lookup failed/,
    );
    const outsideAllowlist = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["other/repo"],
      resolveProject: () => BINDING,
      fetch: (async () => {
        called += 1;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await assert.rejects(
      () =>
        outsideAllowlist.execute({
          operation: "file",
          projectKey: BINDING.projectKey,
          sha,
          path: "README.md",
        }),
      /allow list/,
    );
    assert.equal(called, 0);
  });

  it("bounds directory file listings", async () => {
    const tool = new GitHubReadTool({
      token: "secret-token",
      allowedRepos: ["owner/repo"],
      resolveProject,
      fetch: (async () =>
        jsonResponse([
          { type: "file", path: "a", sha: "a".repeat(40), size: 1 },
          { type: "file", path: "b", sha: "b".repeat(40), size: 1 },
          { type: "file", path: "c", sha: "c".repeat(40), size: 1 },
        ])) as typeof fetch,
    });
    const result = await tool.execute({
      operation: "file",
      projectKey: BINDING.projectKey,
      repo: "owner/repo",
      sha: "d".repeat(40),
      path: "docs",
      limit: 1,
    });
    assert.equal((result.evidence.items as unknown[]).length, 1);
    assert.equal(result.evidence.truncated, true);
  });

  it("is absent from the registry without a token or allow list", () => {
    const store = createStore();
    const services = createServices({
      store,
      github: { token: "", allowedRepos: ["owner/repo"] },
    });
    assert.equal(services.tools.get("github.read"), undefined);
    services.store.close();

    const noRepos = createServices({
      store: createStore(),
      github: { token: "secret-token", allowedRepos: [] },
    });
    assert.equal(noRepos.tools.get("github.read"), undefined);
    noRepos.store.close();
  });

  it("requires the github Mandate resource, not just the tool name", () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const services = createServices({
      github: {
        token: "secret-token",
        allowedRepos: ["owner/repo"],
        fetch: fetchReturning([], calls),
      },
    });
    const withoutResource = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:github-chat-only",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat"], tools: ["github.read"] },
    });
    const claimed = services.tasks.claimNext(
      services.now().toISOString(),
      60_000,
      2,
    );
    assert.ok(claimed);
    assert.equal(
      services.actionService.propose(withoutResource, claimed.assignment, {
        tool: "github.read",
        args: { operation: "repo", repo: "owner/repo" },
      }),
      undefined,
    );

    const withResource = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "source:github-with-resource",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    const claimedAgain = services.tasks.claimNext(
      services.now().toISOString(),
      60_000,
      2,
    );
    assert.ok(claimedAgain);
    const action = services.actionService.propose(withResource, claimedAgain.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    assert.equal(calls.length, 0);
  });
});
