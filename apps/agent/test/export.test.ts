import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { exportAgentData } from "../../../scripts/export.ts";
import { MemoryRepository } from "../src/storage/personal.ts";
import { openStore } from "../src/storage/node.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pa-export-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("agent JSON export", () => {
  it("exports application rows without reading environment secrets", async () => {
    await withDir(async (dir) => {
      const dataDir = join(dir, "data");
      const out = join(dir, "exports", "agent.json");
      await mkdir(dataDir, { recursive: true });
      const store = openStore(join(dataDir, "agent.sqlite"));
      const memories = new MemoryRepository(store.db);
      memories.upsert({
        ownerId: "owner_1",
        project: "alpha",
        key: "city",
        value: "Shanghai",
        now: START.toISOString(),
      });
      store.close();
      const previousSecret = process.env.FEISHU_APP_SECRET;
      process.env.FEISHU_APP_SECRET = "must-not-appear";

      const result = await exportAgentData({ dataDir, out, now: START });
      assert.equal(result.exportVersion, 1);
      assert.equal(result.schemaVersion, "13");
      assert.equal(result.tables.pa_memories?.length, 1);
      assert.equal(result.tables.pa_memories?.[0]?.project, "alpha");
      assert.equal(result.pi.included, false);
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      const text = await readFile(out, "utf8");
      assert.ok(!text.includes("must-not-appear"));
      if (previousSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousSecret;
      }
      await assert.rejects(
        () => exportAgentData({ dataDir, out, now: START }),
        /already exists/,
      );
    });
  });

  it("refuses a missing agent database", async () => {
    await withDir(async (dir) => {
      await assert.rejects(
        () =>
          exportAgentData({
            dataDir: join(dir, "missing"),
            out: join(dir, "export.json"),
            now: START,
          }),
        /unable to open|ENOENT|not found/i,
      );
    });
  });
});
