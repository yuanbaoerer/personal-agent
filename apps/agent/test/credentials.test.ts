import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CredentialBroker,
  CredentialScopeError,
} from "../src/actions/credentials.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

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
