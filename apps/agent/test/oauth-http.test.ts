import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createHttpServer, type AppLogger } from "../src/server.ts";

const logs: Record<string, unknown>[] = [];
const logger: AppLogger = {
  info(_message, fields) {
    logs.push(fields ?? {});
  },
  error() {},
};

describe("GitHub OAuth HTTP routes", () => {
  it("requires admin auth for start/status, completes state callback, and redacts query logs", async () => {
    const handler = {
      start: () => "https://github.com/login/oauth/authorize?client_id=test",
      complete: async (code: string, state: string) => {
        assert.equal(code, "code");
        assert.equal(state, "state");
        return { connected: true, login: "octocat" };
      },
      status: () => ({ connected: true, login: "octocat" }),
      disconnect: () => true,
    };
    const server = createHttpServer({
      feishu: {} as never,
      ingress: {} as never,
      logger,
      adminToken: "admin-secret",
      oauth: handler,
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const unauthorized = await fetch(`${base}/oauth/github/start`, {
        redirect: "manual",
      });
      assert.equal(unauthorized.status, 401);

      const queryToken = await fetch(`${base}/oauth/github/start?key=admin-secret`, {
        redirect: "manual",
      });
      assert.equal(queryToken.status, 401);

      const started = await fetch(`${base}/oauth/github/start`, {
        headers: { authorization: "Bearer admin-secret" },
        redirect: "manual",
      });
      assert.equal(started.status, 302);
      assert.match(started.headers.get("location") ?? "", /github\.com\/login\/oauth/);

      const callback = await fetch(
        `${base}/oauth/github/callback?code=code&state=state`,
      );
      assert.equal(callback.status, 200);
      assert.match(await callback.text(), /octocat/);

      const status = await fetch(`${base}/oauth/github/status`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as { login: string }).login, "octocat");

      const disconnected = await fetch(`${base}/oauth/github/disconnect`, {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(disconnected.status, 200);
      assert.equal(logs.some((entry) => JSON.stringify(entry).includes("admin-secret")), false);
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});
