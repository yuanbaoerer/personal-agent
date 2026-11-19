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
