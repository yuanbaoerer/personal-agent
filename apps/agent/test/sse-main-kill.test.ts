import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ADMIN = "main-kill-admin";
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const cwd = fileURLToPath(new URL("../../..", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0);
  return port;
}

async function waitUntil(
  fn: () => Promise<boolean>,
  child: ChildProcess,
  stderr: () => string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited: ${stderr()}`);
    }
    try {
      if (await fn()) return;
    } catch {
      // Retry while the port/DB is still coming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out: ${stderr()}`);
}

async function startMain(database: string, piDatabase: string) {
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, [mainPath], {
    cwd,
    env: {
      ...process.env,
      FEISHU_APP_ID: "app_test",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_VERIFICATION_TOKEN: "verification-token",
      FEISHU_EVENT_MODE: "webhook",
      OWNER_FEISHU_OPEN_ID: "ou_owner",
      ADMIN_TOKEN: ADMIN,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: database,
      PI_DATABASE_PATH: piDatabase,
      OPENCODE_API_KEY: "",
      GITHUB_TOKEN: "",
      GITHUB_ALLOWED_REPOS: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const url = `http://127.0.0.1:${port}`;
  await waitUntil(
    async () => (await fetch(`${url}/healthz`)).ok,
    child,
    () => stderr,
    "main process",
  );
  return {
    url,
    child,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
  };
}

async function createToken(url: string): Promise<void> {
  const response = await fetch(`${url}/api/v1/tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: `kill-${Date.now()}`, scopes: ["read"] }),
  });
  assert.equal(response.status, 201);
}

async function readUntil(
  url: string,
  needle: string,
  lastEventId?: number,
): Promise<string> {
  const controller = new AbortController();
  try {
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
    const deadline = Date.now() + 4_000;
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
  } finally {
    controller.abort();
  }
}

describe("main process SSE recovery", () => {
  it("resumes from Last-Event-ID after main.ts is SIGKILLed and restarted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-main-kill-"));
    const database = join(dir, "agent.sqlite");
    const piDatabase = join(dir, "pi.sqlite");
    let first: Awaited<ReturnType<typeof startMain>> | undefined;
    let second: Awaited<ReturnType<typeof startMain>> | undefined;
    try {
      first = await startMain(database, piDatabase);
      await createToken(first.url);
      const firstText = await readUntil(
        `${first.url}/api/v1/events/stream?after=0`,
        "client_token.created",
      );
      const firstIds = [...firstText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      const lastId = Math.max(...firstIds);
      assert.ok(lastId > 0);
      await first.stop();
      first = undefined;

      second = await startMain(database, piDatabase);
      await createToken(second.url);
      const secondText = await readUntil(
        `${second.url}/api/v1/events/stream`,
        "client_token.created",
        lastId,
      );
      assert.match(secondText, /client_token\.created/);
      const secondIds = [...secondText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      assert.ok(Math.max(...secondIds) > lastId);
      await second.stop();
      second = undefined;
    } finally {
      await first?.stop();
      await second?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
