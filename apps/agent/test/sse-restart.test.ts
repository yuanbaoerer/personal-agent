import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ClientApiService } from "../src/client-api.ts";
import { FeishuAdapter } from "../src/channels/feishu/adapter.ts";
import type { FeishuConfig } from "../src/channels/feishu/types.ts";
import { createHttpServer, type AppLogger } from "../src/server.ts";
import { openStore } from "../src/storage/node.ts";
import type { Store } from "../src/storage/store.ts";
import { createServices, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "restart-admin-secret";
const feishuConfig: FeishuConfig = {
  appId: "app_1",
  appSecret: "app-secret",
  verificationToken: "verification-token",
  accountId: "app_1",
};
const logger: AppLogger = { info() {}, error() {} };

async function start(store: Store, services: TestServices) {
  const clientApi = new ClientApiService({
    store,
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
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

async function readUntil(
  controller: AbortController,
  url: string,
  needle: string,
  lastEventId?: number,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${ADMIN}`,
      accept: "text/event-stream",
      ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader !== undefined);
  let text = "";
  const deadline = Date.now() + 3_000;
  while (!text.includes(needle) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE timeout")), 800),
      ),
    ]);
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  return text;
}

describe("SSE across a database reopen", () => {
  it("resumes from Last-Event-ID after closing and reopening storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-sse-restart-"));
    const path = join(dir, "agent.sqlite");
    let first: Awaited<ReturnType<typeof start>> | undefined;
    let second: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const store = openStore(path);
      const services = createServices({ store, now: () => NOW });
      services.store.recordAudit({
        event: "sse.first",
        subjectType: "test",
        subjectId: "one",
        traceId: "trace:one",
        occurredAt: NOW.toISOString(),
      });
      first = await start(store, services);
      const firstController = new AbortController();
      const firstText = await readUntil(
        firstController,
        `${first.url}/api/v1/events/stream?after=0`,
        "sse.first",
      );
      firstController.abort();
      const lastId = Number(lastMatch(firstText, /^id: (\d+)$/gm));
      assert.ok(lastId > 0);
      await first.close();
      first = undefined;
      store.close();

      const reopened = openStore(path);
      const services2 = createServices({ store: reopened, now: () => NOW });
      second = await start(reopened, services2);
      const secondController = new AbortController();
      const pending = readUntil(
        secondController,
        `${second.url}/api/v1/events/stream`,
        "sse.second",
        lastId,
      );
      // The server is already listening; append after the stream is opened.
      services2.store.recordAudit({
        event: "sse.second",
        subjectType: "test",
        subjectId: "two",
        traceId: "trace:two",
        occurredAt: NOW.toISOString(),
      });
      const secondText = await pending;
      secondController.abort();
      assert.match(secondText, /sse\.second/);
      const secondId = Number(lastMatch(secondText, /^id: (\d+)$/gm));
      assert.ok(secondId > lastId);
      await second.close();
      second = undefined;
      reopened.close();
    } finally {
      await first?.close();
      await second?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function lastMatch(text: string, pattern: RegExp): string {
  const values = [...text.matchAll(pattern)].map((match) => match[1]);
  return values.at(-1) ?? "0";
}
