import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubOAuthError, GitHubOAuthService } from "../src/personal/github-oauth.ts";
import { APP_ID, OWNER_OPEN_ID, createStore } from "./helpers.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function setup() {
  let now = START;
  const store = createStore();
  const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
  assert.ok(owner);
  const requests: { url: string; init?: RequestInit }[] = [];
  const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("login/oauth/access_token")) {
      return Response.json({
        access_token: "gho_test_access_token",
        token_type: "bearer",
        scope: "read:user,repo",
      });
    }
    if (url.endsWith("/user")) {
      return Response.json({ id: 42, login: "octocat" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const service = new GitHubOAuthService({
    db: store.db,
    ownerId: owner.id,
    config: {
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:8787/oauth/github/callback",
      scopes: ["read:user", "repo"],
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    },
    fetch: fakeFetch,
    now: () => now,
  });
  return {
    store,
    owner,
    service,
    requests,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("GitHub OAuth", () => {
  it("issues state, exchanges the code, and stores only ciphertext", async () => {
    const fixture = setup();
    const authorization = new URL(fixture.service.start());
    assert.equal(authorization.hostname, "github.com");
    assert.equal(authorization.searchParams.get("client_id"), "client");
    assert.equal(authorization.searchParams.get("scope"), "read:user repo");
    const state = authorization.searchParams.get("state");
    assert.ok(state);

    const status = await fixture.service.complete("code", state);
    assert.equal(status.connected, true);
    assert.equal(status.login, "octocat");
    assert.equal(fixture.service.accessToken(), "gho_test_access_token");
    assert.equal(fixture.service.status().login, "octocat");
    assert.equal(fixture.requests.length, 2);
    const row = fixture.store.db.all<{ token_ciphertext: string }>(
      "SELECT token_ciphertext FROM pa_github_credentials",
    )[0];
    assert.ok(row);
    assert.ok(!row.token_ciphertext.includes("gho_test_access_token"));
    assert.ok(!JSON.stringify(status).includes("gho_test_access_token"));
    const wrongKey = new GitHubOAuthService({
      db: fixture.store.db,
      ownerId: fixture.owner.id,
      config: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1:8787/oauth/github/callback",
        scopes: ["public_repo"],
        encryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      fetch: (async () => new Response()) as typeof fetch,
    });
    assert.equal(wrongKey.status().connected, false);
    assert.throws(() => wrongKey.accessToken());
    assert.equal(fixture.service.disconnect(), true);
    assert.equal(fixture.service.status().connected, false);
  });

  it("rejects replayed and expired state, and an invalid key", async () => {
    const fixture = setup();
    const authorization = new URL(fixture.service.start());
    const state = authorization.searchParams.get("state");
    assert.ok(state);
    await fixture.service.complete("code", state);
    await assert.rejects(
      () => fixture.service.complete("code", state),
      /state is invalid/,
    );

    const second = setup();
    const expired = new URL(second.service.start()).searchParams.get("state");
    assert.ok(expired);
    second.advance(11 * 60_000);
    await assert.rejects(
      () => second.service.complete("code", expired),
      /state is invalid/,
    );

    assert.throws(
      () =>
        new GitHubOAuthService({
          db: fixture.store.db,
          ownerId: fixture.owner.id,
          config: {
            clientId: "client",
            clientSecret: "secret",
            redirectUri: "http://localhost/callback",
            scopes: ["repo"],
            encryptionKey: "short",
          },
          fetch: (async () => new Response()) as typeof fetch,
        }),
      /32 bytes/,
    );
    assert.ok(new GitHubOAuthError("x") instanceof Error);
  });
});
