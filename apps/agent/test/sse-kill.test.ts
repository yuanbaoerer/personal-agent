import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ADMIN = "sse-admin";
const fixture = fileURLToPath(new URL("./fixtures/sse-server.ts", import.meta.url));

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnServer(database: string, portFile: string) {
  const child = spawn(process.execPath, [fixture, database, portFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 8_000;
  while (!existsSync(portFile)) {
    if (child.exitCode !== null) {
      throw new Error(`SSE fixture exited before listening: ${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`SSE fixture did not listen: ${stderr}`);
    }
    await delay(50);
  }
  const port = Number(await readFile(portFile, "utf8"));
  assert.ok(Number.isInteger(port) && port > 0);
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
    stderr() {
      return stderr;
    },
  };
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

describe("SSE after a real child-process kill", () => {
  it("resumes with Last-Event-ID after SIGKILL and restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pa-sse-kill-"));
    const database = join(dir, "agent.sqlite");
    let first: Awaited<ReturnType<typeof spawnServer>> | undefined;
    let second: Awaited<ReturnType<typeof spawnServer>> | undefined;
    try {
      first = await spawnServer(database, join(dir, "port-1"));
      const firstText = await readUntil(
        `${first.url}/api/v1/events/stream?after=0`,
        "sse.startup",
      );
      const firstIds = [...firstText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      const lastId = Math.max(...firstIds);
      assert.ok(Number.isFinite(lastId) && lastId > 0);
      await first.stop();
      first = undefined;

      second = await spawnServer(database, join(dir, "port-2"));
      const secondText = await readUntil(
        `${second.url}/api/v1/events/stream`,
        "sse.startup",
        lastId,
      );
      assert.match(secondText, /sse\.startup/);
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