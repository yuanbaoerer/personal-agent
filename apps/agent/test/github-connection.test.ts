import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CredentialBroker } from "../src/actions/credentials.ts";
import { GitHubConnectionError, GitHubConnectionService } from "../src/personal/github-connection.ts";
import { GitHubOAuthService } from "../src/personal/github-oauth.ts";
import { GitHubTokenVault, GitHubVaultError } from "../src/personal/github-token-vault.ts";
import { CredentialRepository } from "../src/storage/credentials.ts";
import type { Store } from "../src/storage/store.ts";
import { APP_ID, OWNER_OPEN_ID, createStore } from "./helpers.ts";
import { createServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "ghp_connection_test_token";

interface FetchAnswers {
  token?: Response;
  user?: Response;
  networkError?: boolean;
}

function fakeFetch(answers: FetchAnswers = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("login/oauth/access_token")) {
      return (
        answers.token ??
        Response.json({
          access_token: TOKEN,
          token_type: "bearer",
          scope: "read:user,repo",
        })
      );
    }
    if (url.endsWith("/user")) {
      if (answers.networkError === true) {
        throw new TypeError("network down");
      }
      return (
        answers.user ??
        Response.json(
          { id: 42, login: "octocat" },
          { headers: { "x-oauth-scopes": "read:user,repo" } },
        )
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function setup(options: {
  withVault?: boolean;
  envPat?: boolean;
  oauth?: boolean;
  answers?: FetchAnswers;
  key?: string;
} = {}) {
  const store = createStore();
  const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
  assert.ok(owner);
  const credentials = new CredentialBroker(
    () => NOW,
    new CredentialRepository(store.db),
  );
  const vault =
    options.withVault === false
      ? undefined
      : new GitHubTokenVault({
          db: store.db,
          ownerId: owner.id,
          encryptionKey: options.key ?? KEY,
          now: () => NOW,
        });
  const changes: { event: string; authMethod?: string; credentialVersion: number }[] = [];
  const oauth =
    options.oauth === false
      ? undefined
      : new GitHubOAuthService({
          db: store.db,
          ownerId: owner.id,
          config: {
            clientId: "client",
            clientSecret: "secret",
            redirectUri: "http://127.0.0.1:8787/oauth/github/callback",
            scopes: ["read:user", "repo"],
            encryptionKey: options.key ?? KEY,
          },
          ...(vault === undefined ? {} : { vault }),
          fetch: fakeFetch(options.answers),
          now: () => NOW,
        });
  const connection = new GitHubConnectionService({
    store,
    ownerId: owner.id,
    credentials,
    ...(vault === undefined ? {} : { vault }),
    ...(oauth === undefined ? {} : { oauth }),
    oauthConfigured: options.oauth ?? true,
    envPatConfigured: options.envPat ?? false,
    fetch: fakeFetch(options.answers),
    now: () => NOW,
    onChange: (change) => {
      changes.push(change);
    },
  });
  return { store, owner, credentials, vault, oauth, connection, changes };
}

function restart(store: Store, ownerId: string, key = KEY) {
  const credentials = new CredentialBroker(
    () => NOW,
    new CredentialRepository(store.db),
  );
  const vault = new GitHubTokenVault({
    db: store.db,
    ownerId,
    encryptionKey: key,
    now: () => NOW,
  });
  const connection = new GitHubConnectionService({
    store,
    ownerId,
    credentials,
    vault,
    oauthConfigured: false,
    envPatConfigured: false,
    now: () => NOW,
  });
  return { credentials, vault, connection };
}

describe("GitHub connection contract", () => {
  it("starts unconfigured and requires OAuth setup", () => {
    const fixture = setup({ oauth: false });
    const view = fixture.connection.status();
    assert.equal(view.status, "unconfigured");
    assert.equal(view.oauthConfigured, false);
    assert.equal(view.encryptionConfigured, true);
    assert.throws(
      () => fixture.connection.beginOAuth(),
      (error: unknown) =>
        error instanceof GitHubConnectionError &&
        error.code === "setup_required",
    );
  });

  it("connects a PAT, stores ciphertext only, and rotates the broker epoch", async () => {
    const fixture = setup({ oauth: false });
    const view = await fixture.connection.connectPat({ token: TOKEN });
    assert.equal(view.status, "connected");
    assert.equal(view.authMethod, "pat");
    assert.equal(view.accountLogin, "octocat");
    assert.equal(view.credentialVersion, 1);
    assert.deepEqual(view.scopes, ["repository.read"]);
    assert.deepEqual(view.githubScopes, ["read:user", "repo"]);
    assert.equal(fixture.credentials.status("github:default")?.status, "active");
    assert.equal(fixture.changes.length, 1);
    assert.equal(fixture.changes[0]?.event, "connected");
    assert.equal(fixture.changes[0]?.authMethod, "pat");

    const row = fixture.store.db.all<{
      token_ciphertext: string;
      auth_method: string;
    }>("SELECT token_ciphertext, auth_method FROM pa_github_credentials")[0];
    assert.ok(row);
    assert.equal(row.auth_method, "pat");
    assert.ok(!row.token_ciphertext.includes(TOKEN));
    assert.ok(!JSON.stringify(view).includes(TOKEN));

    await assert.rejects(
      () =>
        fixture.credentials.resolve("github:default", ["issues.write"], {
          ownerId: fixture.owner.id,
        }),
      /missing scope/,
    );

    const audits = fixture.store
      .listAuditAfter(0, 50)
      .filter((item) => item.event === "github.connection_connected");
    assert.equal(audits.length, 1);
    assert.ok(!JSON.stringify(audits).includes(TOKEN));
  });

  it("rejects a token GitHub does not accept without persisting or rotating", async () => {
    const fixture = setup({
      oauth: false,
      answers: { user: new Response("bad credentials", { status: 401 }) },
    });
    await assert.rejects(
      () => fixture.connection.connectPat({ token: "bad" }),
      (error: unknown) =>
        error instanceof GitHubConnectionError && error.code === "invalid_token",
    );
    assert.equal(fixture.vault?.metadata(), undefined);
    assert.equal(fixture.credentials.status("github:default"), undefined);
    assert.equal(fixture.changes.length, 0);
  });

  it("maps GitHub 403/429 and network failures without persisting", async () => {
    for (const status of [403, 429]) {
      const fixture = setup({
        oauth: false,
        answers: { user: new Response("limited", { status }) },
      });
      await assert.rejects(
        () => fixture.connection.connectPat({ token: "token" }),
        (error: unknown) =>
          error instanceof GitHubConnectionError &&
          error.code === "github_unavailable",
      );
      assert.equal(fixture.vault?.metadata(), undefined);
      assert.equal(fixture.credentials.status("github:default"), undefined);
    }
    const offline = setup({
      oauth: false,
      answers: { networkError: true },
    });
    await assert.rejects(
      () => offline.connection.connectPat({ token: "token" }),
      (error: unknown) =>
        error instanceof GitHubConnectionError &&
        error.code === "github_unavailable",
    );
    assert.equal(offline.vault?.metadata(), undefined);
  });

  it("rotates the epoch on re-login and preserves the owner scope", async () => {
    const fixture = setup({ oauth: false });
    await fixture.connection.connectPat({ token: TOKEN });
    const rotated = await fixture.connection.connectPat({ token: `${TOKEN}_2` });
    assert.equal(rotated.credentialVersion, 2);
    assert.equal(fixture.credentials.status("github:default")?.version, 2);
    assert.equal(fixture.changes.length, 2);
  });

  it("disconnects locally, keeps revocation across restart, and never claims remote revoke", async () => {
    const fixture = setup({ oauth: false });
    await fixture.connection.connectPat({ token: TOKEN });
    const result = await fixture.connection.disconnect();
    assert.equal(result.disconnected, true);
    assert.equal(result.remoteRevoked, false);
    assert.equal(result.connection.status, "revoked");
    assert.equal(fixture.vault?.metadata(), undefined);
    assert.equal(fixture.credentials.status("github:default")?.status, "revoked");

    const after = restart(fixture.store, fixture.owner.id);
    assert.equal(after.connection.status().status, "revoked");
    assert.equal(after.credentials.status("github:default")?.status, "revoked");
    assert.equal(after.vault.metadata(), undefined);
  });

  it("fails closed when the stored token cannot be decrypted", async () => {
    const fixture = setup({ oauth: false });
    await fixture.connection.connectPat({ token: TOKEN });
    const wrong = restart(fixture.store, fixture.owner.id, OTHER_KEY);
    const view = wrong.connection.status();
    assert.equal(view.status, "reauth_required");
    assert.equal(view.accountLogin, "octocat");
    assert.equal(view.credentialVersion, 1);
    assert.throws(() => wrong.vault.accessToken(), GitHubVaultError);
  });

  it("requires an encryption key before accepting a PAT", async () => {
    const fixture = setup({ oauth: false, withVault: false });
    assert.equal(fixture.connection.status().status, "unconfigured");
    await assert.rejects(
      () => fixture.connection.connectPat({ token: TOKEN }),
      (error: unknown) =>
        error instanceof GitHubConnectionError &&
        error.code === "encryption_key_missing",
    );
  });

  it("reports a legacy env PAT and revokes it persistently", async () => {
    const fixture = setup({ oauth: false, withVault: false, envPat: true });
    fixture.credentials.restore("github:default", {
      provider: () => "env-token",
      scopes: ["repository.read"],
      ownerId: fixture.owner.id,
      pluginId: "github",
      account: "env",
    });
    const view = fixture.connection.status();
    assert.equal(view.status, "connected");
    assert.equal(view.authMethod, "pat");
    assert.equal(view.detail, "connected through GITHUB_TOKEN");
    await fixture.connection.disconnect();
    assert.equal(fixture.connection.status().status, "revoked");
    assert.equal(fixture.credentials.status("github:default")?.status, "revoked");
  });

  it("rotates the catalog generation and invalidates drafts on connection change", async () => {
    const services = createServices({ now: () => NOW });
    const vault = new GitHubTokenVault({
      db: services.store.db,
      ownerId: services.owner.id,
      encryptionKey: KEY,
      now: () => NOW,
    });
    const credentials = new CredentialBroker(
      () => NOW,
      new CredentialRepository(services.store.db),
    );
    const before = services.catalog.generation();
    const connection = new GitHubConnectionService({
      store: services.store,
      ownerId: services.owner.id,
      credentials,
      vault,
      oauthConfigured: false,
      envPatConfigured: false,
      fetch: fakeFetch(),
      now: () => NOW,
      onChange: async () => {
        services.issueDrafts.supersedeForCredential(
          services.owner.id,
          "github:default",
        );
        await services.plugins.credentialChanged("github", "test");
      },
    });
    await connection.connectPat({ token: TOKEN });
    assert.ok(services.catalog.generation() > before);
    assert.ok(
      services.store
        .listAuditAfter(0, 200)
        .some((item) => item.event === "plugin.credential_changed"),
    );
  });

  it("completes the existing OAuth flow and applies the new credential", async () => {
    const fixture = setup();
    const started = fixture.connection.beginOAuth();
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    assert.ok(state);
    const view = await fixture.connection.completeOAuth("code", state);
    assert.equal(view.status, "connected");
    assert.equal(view.authMethod, "oauth");
    assert.equal(view.accountLogin, "octocat");
    assert.equal(view.credentialVersion, 1);
    assert.equal(fixture.changes[0]?.authMethod, "oauth");
    assert.equal(fixture.vault?.load()?.token, TOKEN);
    assert.equal(fixture.connection.pluginConnection().status, "connected");
    assert.equal(fixture.connection.pluginConnection().account, "octocat");
  });
});
