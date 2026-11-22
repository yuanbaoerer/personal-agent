import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CredentialBroker,
  CredentialScopeError,
} from "../src/actions/credentials.ts";
import { CredentialRepository } from "../src/storage/credentials.ts";
import { createStore } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const OWNER = "owner-1";

function fixture() {
  const store = createStore();
  const owner = store.findOwner("feishu", "app_1", "ou_owner");
  const repository = new CredentialRepository(store.db);
  const broker = new CredentialBroker(() => NOW, repository);
  return { store, repository, broker, ownerId: owner?.id as string };
}

describe("CredentialBroker", () => {
  it("resolves a provider token and exposes only metadata", async () => {
    const broker = new CredentialBroker(() => NOW);
    let token: string | undefined = "ghs-secret";
    broker.register("github:default", {
      provider: () => token,
      scopes: ["repository.read"],
      account: "owner",
    });
    const resolved = await broker.resolve("github:default", ["repository.read"]);
    assert.equal(resolved?.token, "ghs-secret");
    assert.equal(resolved?.version, 1);
    assert.deepEqual(broker.status("github:default"), {
      ref: "github:default",
      status: "active",
      version: 1,
      scopes: ["repository.read"],
      account: "owner",
      repositoryIds: [],
      expiresAt: undefined,
    });
    assert.equal(JSON.stringify(broker.list()).includes("ghs-secret"), false);

    token = undefined;
    assert.equal(await broker.resolve("github:default"), undefined);
  });

  it("fails closed after revocation, expiry or a missing scope", async () => {
    const broker = new CredentialBroker(() => NOW);
    broker.register("github:default", {
      token: "secret",
      scopes: ["repository.read"],
      expiresAt: "2026-01-01T00:00:01.000Z",
    });
    await assert.rejects(
      () => broker.resolve("github:default", ["issues.write"]),
      CredentialScopeError,
    );
    broker.register("github:unscoped", { token: "test-token" });
    await assert.rejects(
      () => broker.resolve("github:unscoped", ["repository.read"]),
      CredentialScopeError,
    );
    assert.equal(broker.revoke("github:default"), true);
    assert.equal(await broker.resolve("github:default"), undefined);
    assert.equal(broker.revoke("github:default"), false);

    broker.register("github:expired", {
      token: "secret",
      expiresAt: "2025-12-31T23:59:59.000Z",
    });
    assert.equal(await broker.resolve("github:expired"), undefined);
  });

  it("never infers a scope for a credential without declarations", async () => {
    const broker = new CredentialBroker(() => NOW);
    broker.register("github:default", { token: "secret" });
    await assert.rejects(
      () => broker.resolve("github:default", ["repository.read"]),
      /missing scope repository\.read/,
    );
    await assert.rejects(
      () => broker.resolve("github:default", ["issues.write"]),
      /missing scope issues\.write/,
    );
    assert.equal(
      (await broker.resolve("github:default"))?.token,
      "secret",
    );

    broker.register("github:issues", {
      token: "write-secret",
      scopes: ["repository.read", "issues.write"],
    });
    assert.equal(
      (await broker.resolve("github:issues", ["issues.write"]))?.token,
      "write-secret",
    );
    await assert.rejects(
      () => broker.resolve("github:issues", ["repository.admin"]),
      /missing scope repository\.admin/,
    );
  });

  it("does not let an unscoped credential satisfy an owner-scoped read", async () => {
    const broker = new CredentialBroker(() => NOW);
    broker.register("github:legacy", {
      token: "legacy-secret",
      scopes: ["repository.read"],
    });
    assert.equal((await broker.resolve("github:legacy"))?.token, "legacy-secret");
    await assert.rejects(
      () => broker.resolve("github:legacy", ["repository.read"], { ownerId: OWNER }),
      /not bound to an owner/,
    );
  });

  it("binds credentials to an owner and immutable repository ids", async () => {
    const broker = new CredentialBroker(() => NOW);
    broker.register("github:project", {
      token: "project-secret",
      scopes: ["repository.read"],
      ownerId: OWNER,
      repositoryIds: [101],
    });
    await assert.rejects(
      () => broker.resolve("github:project", ["repository.read"]),
      /not owned by the requesting owner/,
    );
    await assert.rejects(
      () =>
        broker.resolve("github:project", ["repository.read"], {
          ownerId: "other-owner",
          repositoryId: 101,
        }),
      /not owned by the requesting owner/,
    );
    await assert.rejects(
      () =>
        broker.resolve("github:project", ["repository.read"], {
          ownerId: OWNER,
          repositoryId: 999,
        }),
      /not bound to the requested repository/,
    );
    assert.equal(
      (
        await broker.resolve("github:project", ["repository.read"], {
          ownerId: OWNER,
          repositoryId: 101,
        })
      )?.token,
      "project-secret",
    );
  });

  it("persists metadata and the epoch across a restart without storing the token", async () => {
    const { store, repository, ownerId } = fixture();
    const first = new CredentialBroker(() => NOW, repository);
    first.register("github:project", {
      token: "top-secret",
      scopes: ["repository.read"],
      ownerId,
      repositoryIds: [101],
      account: "yuanbaoerer",
    });
    assert.equal(first.status("github:project")?.version, 1);
    const rows = store.db.all(
      "SELECT * FROM pa_credential_refs WHERE ref = ?",
      "github:project",
    );
    assert.equal(JSON.stringify(rows).includes("top-secret"), false);

    // A fresh broker hydrates metadata only; resolving before the host
    // re-attaches the secret must fail closed.
    const hydrated = new CredentialBroker(() => NOW, repository);
    assert.equal(hydrated.status("github:project")?.version, 1);
    assert.equal(
      await hydrated.resolve("github:project", [], {
        ownerId,
        repositoryId: 101,
      }),
      undefined,
    );

    const restarted = new CredentialBroker(() => NOW, repository);
    restarted.restore("github:project", {
      token: "top-secret",
      scopes: ["repository.read"],
      ownerId,
      repositoryIds: [101],
      account: "yuanbaoerer",
    });
    assert.equal(restarted.status("github:project")?.version, 1);
    assert.equal(
      (await restarted.resolve("github:project", [], {
        ownerId,
        repositoryId: 101,
      }))?.token,
      "top-secret",
    );

    // Changed scope metadata is a rotation, not a silent upgrade.
    restarted.restore("github:project", {
      token: "top-secret",
      scopes: ["repository.read", "issues.write"],
      ownerId,
      repositoryIds: [101],
      account: "yuanbaoerer",
    });
    assert.equal(restarted.status("github:project")?.version, 2);

    restarted.revoke("github:project");
    const afterRevoke = new CredentialBroker(() => NOW, repository);
    afterRevoke.restore("github:project", {
      token: "top-secret",
      scopes: ["repository.read"],
      ownerId,
      repositoryIds: [101],
      account: "yuanbaoerer",
    });
    assert.equal(afterRevoke.status("github:project")?.status, "revoked");
    assert.equal(await afterRevoke.resolve("github:project"), undefined);
  });

  it("increments the version on rotation and provider failure is explicit", async () => {
    const broker = new CredentialBroker(() => NOW);
    broker.register("github:default", { token: "one" });
    const rotated = broker.rotate("github:default", { token: "two" });
    assert.equal(rotated.version, 2);
    assert.equal((await broker.resolve("github:default"))?.token, "two");

    broker.register("github:broken", {
      provider: () => {
        throw new Error("vault down");
      },
    });
    await assert.rejects(
      () => broker.resolve("github:broken"),
      /credential github:broken provider failed/,
    );
  });

  it("discards tokens returned after revoke, rotation or expiry", async () => {
    for (const invalidate of ["revoke", "rotate", "expire"] as const) {
      let now = NOW;
      const broker = new CredentialBroker(() => now);
      const provider = Promise.withResolvers<string>();
      const ref = "github:default";
      broker.register(ref, {
        provider: () => provider.promise,
        expiresAt: "2026-01-01T00:00:01.000Z",
        scopes: ["repository.read"],
      });
      const resolving = broker.resolve(ref, ["repository.read"]);
      if (invalidate === "revoke") broker.revoke(ref);
      if (invalidate === "rotate") broker.rotate(ref, { token: "new-token" });
      if (invalidate === "expire") now = new Date("2026-01-01T00:00:01.000Z");
      provider.resolve("old-token");
      assert.equal(await resolving, undefined, invalidate);
    }
  });

  it("rejects token-shaped refs", () => {
    const broker = new CredentialBroker(() => NOW);
    assert.throws(
      () => broker.register("ghp_1234567890", { token: "secret" }),
      /credential ref/,
    );
  });
});
