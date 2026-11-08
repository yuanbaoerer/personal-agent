// Independent-process durability check: commit, SIGKILL, reopen the same SQLite file.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(), "pa-pi-kill-"));
const dbPath = join(dir, "agent.sqlite");
const markerPath = join(dir, "marker.json");

const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    join(import.meta.dirname, "crash-child.ts"),
    dbPath,
    markerPath,
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
assert.ok(child.stdout, "child stdout must be piped");

const ready = Promise.withResolvers<void>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  if (line === "READY") {
    ready.resolve();
  }
});
await ready.promise;

const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
child.once("exit", (code, signal) => exited.resolve({ code, signal }));
child.kill("SIGKILL");
const exit = await exited.promise;

assert.equal(exit.signal, "SIGKILL", "child must be killed, not closed normally");

const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
  rootId: unknown;
  entryCount: number;
};
const reopened = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models: createModels(), registry: createRegistry() },
  context,
);
const root = await reopened.root(context);
const entries = await root.entries({}, 50, undefined, context);

assert.equal(root.id, marker.rootId);
assert.equal(entries.items.length, marker.entryCount);

console.log(
  JSON.stringify(
    {
      dbPath,
      killedWith: exit.signal,
      rootId: root.id,
      entryCount: entries.items.length,
      reopenedSameRoot: root.id === marker.rootId,
    },
    null,
    2,
  ),
);

await reopened.close(context);
await rm(dir, { recursive: true, force: true });
