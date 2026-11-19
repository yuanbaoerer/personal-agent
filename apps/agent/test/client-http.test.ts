import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { ClientApiService } from "../src/client-api.ts";
import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import type { FeishuConfig } from "../src/channels/feishu/types.ts";
import { createHttpServer, type AppLogger } from "../src/server.ts";
import { createServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "http-admin-secret";
const feishuConfig: FeishuConfig = {
  appId: "app_1",
  appSecret: "app-secret",
  verificationToken: "verification-token",
  accountId: "app_1",
};

describe("client API HTTP mount", () => {
  it("authenticates and never logs the bearer token", async () => {
    const services = createServices({ now: () => NOW });
    const logs: Record<string, unknown>[] = [];
    const logger: AppLogger = {
      info(message, fields) {
        logs.push({ message, ...fields });
      },
      error(message, fields) {
        logs.push({ message, ...fields });
      },
    };
    const clientApi = new ClientApiService({
      store: services.store,
      services,
      ownerId: services.owner.id,
      adminToken: ADMIN,
      now: () => NOW,
    });
    const server = createHttpServer({
      feishu: new FeishuAdapter(feishuConfig, { now: () => NOW }),
      ingress: services.ingress,
      logger,
      adminToken: ADMIN,
      clientApi,
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const unauthorized = await fetch(`${url}/api/v1/health`);
      assert.equal(unauthorized.status, 401);

      const created = await fetch(`${url}/api/v1/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN}`,
          "content-type": "application/json",
          "idempotency-key": "http-task",
        },
        body: JSON.stringify({
          goal: "http task",
          completionCriteria: "http task done",
        }),
      });
      assert.equal(created.status, 201);
      const body = (await created.json()) as { task: { id: string } };

      const list = await fetch(`${url}/api/v1/tasks`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      assert.equal(list.status, 200);
      assert.equal(((await list.json()) as { tasks: unknown[] }).tasks.length, 1);
      assert.equal(
        logs.some((entry) => JSON.stringify(entry).includes(ADMIN)),
        false,
      );

      const detail = await fetch(`${url}/api/v1/tasks/${body.task.id}`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      assert.equal(detail.status, 200);

      const unauthorizedStream = await fetch(`${url}/api/v1/events/stream`);
      assert.equal(unauthorizedStream.status, 401);

      const controller = new AbortController();
      const stream = await fetch(`${url}/api/v1/events/stream?after=0`, {
        headers: { authorization: `Bearer ${ADMIN}` },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = stream.body?.getReader();
      assert.ok(reader !== undefined);
      let received = "";
      const deadline = Date.now() + 2_000;
      while (!received.includes("event: audit") && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SSE timeout")), 500),
          ),
        ]);
        if (next.done) break;
        received += new TextDecoder().decode(next.value);
      }
      controller.abort();
      assert.match(received, /event: audit/);
      assert.match(received, /task\.created|inbox\./);
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      services.store.close();
    }
  });
});
