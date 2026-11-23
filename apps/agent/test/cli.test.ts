import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.ts";
import { ClientApiClient } from "../src/client/sdk.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (message: string) => out.push(message),
      err: (message: string) => err.push(message),
    },
  };
}

describe("client CLI and SDK", () => {
  it("sends the bearer token and idempotency key without printing secrets", async () => {
    const requests: { url: string; headers: Headers; body?: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      if (request.method === "POST") {
        return jsonResponse({ task: { id: "task-1", status: "queued" } }, 201);
      }
      return jsonResponse({ tasks: [] });
    };
    const { io, out } = captureIo();
    const code = await runCli(
      ["create", "check", "the", "lamp", "--request-id", "req-1", "--json"],
      { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" },
      io,
      fakeFetch,
    );
    assert.equal(code, 0);
    const request = requests[0] as { url: string; headers: Headers; body?: string };
    assert.equal(request.url, "http://api.local/api/v1/tasks");
    assert.equal(request.headers.get("authorization"), "Bearer pa_secret");
    assert.equal(request.headers.get("idempotency-key"), "req-1");
    assert.match(request.body ?? "", /"goal":"check the lamp"/);
    assert.match(out.join("\n"), /task-1/);
    assert.ok(!out.join("\n").includes("pa_secret"));
  });

  it("lists tasks as JSON and fails clearly without a token", async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ tasks: [] });
    const { io, out } = captureIo();
    assert.equal(
      await runCli(
        ["tasks", "--json"],
        { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" },
        io,
        fakeFetch,
      ),
      0,
    );
    assert.deepEqual(JSON.parse(out[0] ?? "{}"), { tasks: [] });

    const missing = captureIo();
    const code = await runCli(["tasks"], {}, missing.io, fakeFetch);
    assert.equal(code, 1);
    assert.match(missing.err.join("\n"), /PA_API_TOKEN or ADMIN_TOKEN/);
  });

  it("requires --yes before approving and shows the immutable binding", async () => {
    let posts = 0;
    const action = {
      id: "action-1",
      taskId: "task-1",
      taskRevision: 1,
      tool: "lamp.set_brightness",
      args: { brightness: 50 },
      argsHash: "hash-1",
      nonce: "nonce-1",
      status: "proposed",
      expiresAt: "2026-01-01T01:00:00.000Z",
    };
    const fakeFetch: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") posts += 1;
      return jsonResponse({ approval: action });
    };
    const { io, out } = captureIo();
    const code = await runCli(
      ["approve", "action-1"],
      { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" },
      io,
      fakeFetch,
    );
    assert.equal(code, 2);
    assert.equal(posts, 0);
    assert.match(out.join("\n"), /nonce-1/);
    assert.match(out.join("\n"), /--yes/);
  });

  it("lists and disables plugins through the SDK with --yes", async () => {
    const plugin = {
      id: "github",
      name: "GitHub",
      version: "0.1.0",
      apiVersion: "1",
      trust: "builtin",
      digest: "digest",
      enabled: true,
      lifecycle: "enabled",
      connection: { status: "connected", scopes: ["repository.read"] },
      auth: ["pat"],
      permissions: ["repository.read"],
      tools: ["github.read"],
      activeTools: ["github.read"],
      defaultPolicy: "enabled",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${request.url}`);
      if (request.method === "POST") {
        return jsonResponse({
          changed: true,
          generation: 2,
          plugin: { ...plugin, enabled: false, lifecycle: "disabled", activeTools: [] },
          addedTools: [],
          removedTools: ["github.read"],
          revokedActions: 1,
          inFlightActions: 0,
        });
      }
      return jsonResponse({ plugins: [plugin] });
    };
    const env = { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" };
    const listIo = captureIo();
    assert.equal(
      await runCli(["plugins", "list", "--json"], env, listIo.io, fakeFetch),
      0,
    );
    assert.match(listIo.out.join("\n"), /"github"/);

    const refusedIo = captureIo();
    assert.equal(
      await runCli(["plugins", "disable", "github"], env, refusedIo.io, fakeFetch),
      1,
    );
    assert.match(refusedIo.out.join("\n"), /--yes/);

    const disableIo = captureIo();
    assert.equal(
      await runCli(
        ["plugins", "disable", "github", "--yes"],
        env,
        disableIo.io,
        fakeFetch,
      ),
      0,
    );
    assert.match(disableIo.out.join("\n"), /generation=2/);
    assert.deepEqual(seen, [
      "GET http://api.local/api/v1/plugins",
      "POST http://api.local/api/v1/plugins/github/disable",
    ]);
  });

  it("logs in/out and reports GitHub connection state without printing the token", async () => {
    const plugin = {
      id: "github",
      name: "GitHub",
      version: "0.1.0",
      apiVersion: "1",
      trust: "builtin",
      digest: "digest",
      enabled: true,
      lifecycle: "enabled",
      connection: { status: "unconfigured" },
      auth: ["pat", "oauth"],
      permissions: ["repository.read"],
      tools: ["github.read"],
      activeTools: [],
      defaultPolicy: "enabled",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const base = {
      id: "github",
      ownerId: "owner",
      pluginId: "github",
      credentialRef: "github:default",
      status: "unconfigured",
      scopes: ["repository.read"],
      repositoryIds: [],
      oauthConfigured: true,
      encryptionConfigured: true,
      envPatConfigured: false,
    };
    const connected = {
      ...base,
      status: "connected",
      authMethod: "pat",
      accountLogin: "octocat",
      credentialVersion: 1,
    };
    const revoked = { ...base, status: "revoked" };
    const seen: { method: string; url: string; body: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = init?.body === undefined ? "" : String(init.body);
      seen.push({ method: request.method, url: request.url, body });
      if (request.url.endsWith("/connections/github/pat")) {
        return jsonResponse({ connection: connected });
      }
      if (request.url.endsWith("/connections/github/disconnect")) {
        return jsonResponse({
          disconnected: true,
          remoteRevoked: false,
          connection: revoked,
        });
      }
      if (request.url.endsWith("/connections/github/start")) {
        return jsonResponse({
          authorizeUrl: "https://github.com/login/oauth/authorize?client_id=test",
          connection: base,
        });
      }
      if (request.url.endsWith("/connections/github")) {
        return jsonResponse({ connection: base });
      }
      if (request.url.endsWith("/plugins/github")) {
        return jsonResponse({ plugin });
      }
      return jsonResponse({});
    };
    const env = {
      PA_API_URL: "http://api.local",
      PA_API_TOKEN: "pa_secret",
      PA_GITHUB_TOKEN: "ghp_super_secret",
    };

    const login = captureIo();
    assert.equal(
      await runCli(["plugins", "login", "github"], env, login.io, fakeFetch),
      0,
    );
    assert.match(login.out.join("\n"), /connected/);
    assert.match(login.out.join("\n"), /octocat/);
    assert.ok(!login.out.join("\n").includes("ghp_super_secret"));
    const pat = seen.find((entry) => entry.url.endsWith("/pat"));
    assert.match(pat?.body ?? "", /ghp_super_secret/);

    const status = captureIo();
    assert.equal(
      await runCli(
        ["plugins", "status", "github", "--json"],
        env,
        status.io,
        fakeFetch,
      ),
      0,
    );
    const parsed = JSON.parse(status.out[0] ?? "{}") as {
      plugin: { id: string };
      connection: { status: string };
    };
    assert.equal(parsed.plugin.id, "github");
    assert.equal(parsed.connection.status, "unconfigured");
    assert.ok(!status.out.join("\n").includes("ghp_super_secret"));

    const refused = captureIo();
    assert.equal(
      await runCli(["plugins", "logout", "github"], env, refused.io, fakeFetch),
      1,
    );
    assert.match(refused.out.join("\n"), /--yes/);

    const logout = captureIo();
    assert.equal(
      await runCli(
        ["plugins", "logout", "github", "--yes"],
        env,
        logout.io,
        fakeFetch,
      ),
      0,
    );
    assert.match(logout.out.join("\n"), /remoteRevoked=false/);
  });

  it("prints the OAuth URL and explains a missing OAuth setup", async () => {
    const base = {
      id: "github",
      ownerId: "owner",
      pluginId: "github",
      credentialRef: "github:default",
      status: "unconfigured",
      scopes: ["repository.read"],
      repositoryIds: [],
      oauthConfigured: true,
      encryptionConfigured: true,
      envPatConfigured: false,
    };
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/connections/github/start")) {
        return jsonResponse({
          authorizeUrl: "https://github.com/login/oauth/authorize?client_id=test",
          connection: base,
        });
      }
      if (request.url.endsWith("/connections/github")) {
        return jsonResponse({ connection: base });
      }
      return jsonResponse({});
    };
    const env = { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" };
    const started = captureIo();
    assert.equal(
      await runCli(
        ["plugins", "login", "github", "--oauth", "--no-wait"],
        env,
        started.io,
        fakeFetch,
      ),
      0,
    );
    assert.match(started.out.join("\n"), /github\.com\/login\/oauth/);
    assert.deepEqual(seen, [
      "GET http://api.local/api/v1/connections/github",
      "POST http://api.local/api/v1/connections/github/start",
    ]);

    const missing = captureIo();
    const missingFetch: typeof fetch = async (input) => {
      const request = new Request(input);
      if (request.url.endsWith("/connections/github")) {
        return jsonResponse({
          connection: { ...base, oauthConfigured: false, encryptionConfigured: false },
        });
      }
      return jsonResponse({});
    };
    assert.equal(
      await runCli(
        ["plugins", "login", "github", "--oauth"],
        env,
        missing.io,
        missingFetch,
      ),
      1,
    );
    assert.match(missing.err.join("\n"), /GITHUB_CONNECTION_ENCRYPTION_KEY/);
  });

  it("SDK consumes SSE data frames without treating comments as events", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        ": keep-alive\n\n" +
          "id: 7\nevent: audit\ndata: {\"cursor\":7,\"event\":\"task.created\",\"traceId\":\"t\",\"occurredAt\":\"2026-01-01T00:00:00.000Z\"}\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    const client = new ClientApiClient({
      baseUrl: "http://api.local",
      token: "pa_secret",
      fetch: fakeFetch,
    });
    const events = [];
    for await (const event of client.streamEvents({ after: 6 })) {
      events.push(event);
    }
    assert.deepEqual(events.map((event) => event.cursor), [7]);
  });

  it("SDK surfaces structured API errors and revokes tokens via delete", async () => {
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/tokens/token-1")) {
        return jsonResponse({ revoked: true });
      }
      return jsonResponse({ error: "forbidden", message: "missing scope" }, 403);
    };
    const client = new ClientApiClient({
      baseUrl: "http://api.local/",
      token: "pa_secret",
      fetch: fakeFetch,
    });
    await assert.rejects(
      () => client.listTasks(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "forbidden",
    );
    assert.equal(await client.revokeToken("token-1"), true);
    assert.deepEqual(seen, [
      "GET http://api.local/api/v1/tasks",
      "DELETE http://api.local/api/v1/tokens/token-1",
    ]);
  });
});

describe("drafts CLI", () => {
  const draft = {
    id: "draft-1",
    ownerId: "owner",
    projectKey: "personal-agent",
    repositoryId: 101,
    repositoryFullName: "owner/repo",
    sourceTaskId: "task-1",
    sourceTaskRevision: 1,
    sourceAssignmentId: "assignment-1",
    commitSha: "a".repeat(40),
    findingIds: ["f1"],
    action: "create",
    title: "Add draft snapshot lifecycle",
    body: "Persist payload and approval binding.",
    payloadHash: "b".repeat(64),
    idempotencyKey: "c".repeat(32),
    credentialRef: "github:default",
    credentialVersion: 1,
    status: "pending_approval",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("lists and rejects drafts through the client API", async () => {
    const requests: { method: string; url: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, url: request.url });
      if (request.method === "POST") {
        return jsonResponse({ draft: { ...draft, status: "rejected" } });
      }
      return jsonResponse({ drafts: [draft] });
    };
    const env = { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" };
    const list = captureIo();
    assert.equal(
      await runCli(
        ["drafts", "list", "--project", "personal-agent", "--status", "pending_approval", "--json"],
        env,
        list.io,
        fakeFetch,
      ),
      0,
    );
    assert.match(requests[0]?.url ?? "", /\/api\/v1\/drafts\?/);
    assert.match(requests[0]?.url ?? "", /project=personal-agent/);
    assert.match(requests[0]?.url ?? "", /status=pending_approval/);
    assert.match(list.out.join("\n"), /owner\/repo/);

    const reject = captureIo();
    assert.equal(
      await runCli(["drafts", "reject", "draft-1", "--yes"], env, reject.io, fakeFetch),
      0,
    );
    assert.equal(requests[1]?.method, "POST");
    assert.match(requests[1]?.url ?? "", /\/api\/v1\/drafts\/draft-1\/reject$/);
    assert.match(reject.out.join("\n"), /rejected/);
    assert.match(reject.out.join("\n"), /before:/);
  });

  it("shows plans and requires --yes to activate", async () => {
    const view = {
      plan: {
        id: "plan-1",
        ownerId: "owner",
        parentTaskId: "task-1",
        taskRevision: 1,
        inputSeq: 0,
        planVersion: 1,
        status: "draft",
        budget: { maxSteps: 3, maxAttemptsPerStep: 1, timeoutMs: 300000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      steps: [
        {
          id: "step-a",
          planId: "plan-1",
          key: "A",
          ordinal: 0,
          goal: "read evidence",
          dependsOn: [],
          tools: [],
          resources: [],
          verifierId: "text-report",
          maxAttempts: 1,
          timeoutMs: 300000,
          status: "blocked",
          attempts: 0,
          evidenceRefs: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({ plans: [view.plan] });
    const env = { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" };

    const json = captureIo();
    assert.equal(
      await runCli(["plans", "list", "--json"], env, json.io, fakeFetch),
      0,
    );
    assert.deepEqual(JSON.parse(json.out[0] ?? "{}"), { plans: [view.plan] });

    const showFetch: typeof fetch = async () => jsonResponse(view);
    const show = captureIo();
    assert.equal(
      await runCli(["plans", "show", "plan-1"], env, show.io, showFetch),
      0,
    );
    assert.match(show.out.join("\n"), /v1\s+draft/);
    assert.match(show.out.join("\n"), /A\s+blocked/);

    const refused = captureIo();
    assert.equal(
      await runCli(["plans", "activate", "plan-1"], env, refused.io, fakeFetch),
      1,
    );
    assert.match(refused.err.join("\n"), /requires --yes/);
  });
});
