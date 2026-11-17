import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubReadTool } from "../src/actions/github.ts";
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
