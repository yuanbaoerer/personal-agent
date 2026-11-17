import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createBackup, verifyBackup } from "../../../scripts/backup.ts";
import { openStore } from "../src/storage/node.ts";
import { APP_ID, OWNER_OPEN_ID } from "./helpers.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pa-backup-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("sqlite backup", () => {
  it("copies both databases with a verified manifest", async () => {
    await withDir(async (dir) => {
      const dataDir = join(dir, "data");
      const outDir = join(dir, "backup");
      await mkdir(dataDir, { recursive: true });
      const store = openStore(join(dataDir, "agent.sqlite"));
      store.bindOwner({
        channel: "feishu",
        accountId: APP_ID,
        actorId: OWNER_OPEN_ID,
        verifiedAt: START.toISOString(),
      });
      store.close();
      const pi = new DatabaseSync(join(dataDir, "pi.sqlite"));
      pi.exec("CREATE TABLE pi_messages (id TEXT PRIMARY KEY)");
      pi.prepare("INSERT INTO pi_messages (id) VALUES (?)").run("m1");
      pi.close();

      const manifest = await createBackup({
        dataDir,
        outDir,
        now: START,
      });

      assert.equal(manifest.files.length, 2);
      assert.equal(manifest.files[0]?.schemaVersion, "7");
      assert.equal(manifest.files[1]?.name, "pi.sqlite");
      assert.equal((await stat(join(outDir, "agent.sqlite"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(outDir, "manifest.json"))).mode & 0o777, 0o600);
      await verifyBackup(outDir);

      const copy = new DatabaseSync(join(outDir, "agent.sqlite"), { readOnly: true });
      const row = copy.prepare("SELECT COUNT(*) AS count FROM pa_identities").get();
      assert.ok(row !== undefined && "count" in row && typeof row.count === "number");
      assert.equal(row.count, 1);
      copy.close();
    });
  });

  it("refuses a non-empty destination and detects tampering", async () => {
    await withDir(async (dir) => {
      const dataDir = join(dir, "data");
      const outDir = join(dir, "backup");
      await mkdir(dataDir, { recursive: true });
      const store = openStore(join(dataDir, "agent.sqlite"));
      store.close();

      await createBackup({ dataDir, outDir, now: START, piDatabase: "missing.sqlite" });
      await assert.rejects(
        () => createBackup({ dataDir, outDir, now: START }),
        /not empty/,
      );

      const path = join(outDir, "agent.sqlite");
      const original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from("tamper")]));
      await assert.rejects(() => verifyBackup(outDir), /changed/);
    });
  });

  it("rejects an empty or pruned manifest inventory", async () => {
    await withDir(async (dir) => {
      const dataDir = join(dir, "data");
      const outDir = join(dir, "backup");
      await mkdir(dataDir, { recursive: true });
      const store = openStore(join(dataDir, "agent.sqlite"));
      store.close();
      await createBackup({
        dataDir,
        outDir,
        now: START,
        piDatabase: "missing.sqlite",
      });

      const manifestPath = join(outDir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          createdAt: START.toISOString(),
          source: { dataDir, agentDatabase: "agent.sqlite" },
          files: [],
        }),
      );
      await assert.rejects(() => verifyBackup(outDir), /no files/);
    });
  });

  it("verifies a backup whose source name is a relative path", async () => {
    await withDir(async (dir) => {
      const dataDir = join(dir, "data");
      const outDir = join(dir, "backup");
      await mkdir(dataDir, { recursive: true });
      const store = openStore(join(dataDir, "agent.sqlite"));
      store.close();

      await createBackup({
        dataDir,
        outDir,
        now: START,
        agentDatabase: "./agent.sqlite",
        piDatabase: "missing.sqlite",
      });

      await verifyBackup(outDir);
    });
  });

  it("refuses to run without the agent database", async () => {
    await withDir(async (dir) => {
      await assert.rejects(
        () =>
          createBackup({
            dataDir: join(dir, "missing"),
            outDir: join(dir, "backup"),
            now: START,
          }),
        /source database not found/,
      );
    });
  });
});
