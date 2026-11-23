import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("reports partial Pi measurements without counting unrelated or duplicate sessions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pa-session-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "pi.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE conversations (id INTEGER PRIMARY KEY);
      CREATE TABLE entries (conversation_id INTEGER, record TEXT);
      INSERT INTO conversations VALUES (1), (2), (3), (4);`);
    const put = db.prepare("INSERT INTO entries VALUES (?, ?)");
    for (const [id, kind, totalTokens] of [
      [1, "pi.assistant", 11], [1, "pi.assistant", 0], [1, "pi.assistant", "9"],
      [2, "pi.assistant", 7], [2, "pi.system", 111], [4, "pi.assistant", 1000],
    ] as const) {
      put.run(id, JSON.stringify({ kind, model: [{ role: "assistant", usage: { totalTokens } }] }));
    }
  } finally {
    db.close();
  }
  const cli = fileURLToPath(new URL("../../../scripts/session-usage.ts", import.meta.url));
  const run = (...ids: string[]) => spawnSync(process.execPath, [cli, path, ...ids], { encoding: "utf8" });
  const mixed = run("1", "2", "02");
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.deepEqual(JSON.parse(mixed.stdout), {
    sessions: [
      { sessionId: 1, assistantEntries: 3, measuredEntries: 1, observedTokens: 11, totalTokens: null },
      { sessionId: 2, assistantEntries: 1, measuredEntries: 1, observedTokens: 7, totalTokens: 7 },
    ],
    summary: { assistantEntries: 4, measuredEntries: 2, observedTokens: 18, totalTokens: null, cost: null },
  });
  assert.equal(JSON.parse(run("2", "3").stdout).summary.totalTokens, null);
  assert.equal(JSON.parse(run("3").stdout).summary.observedTokens, null);
  const missing = run("2", "99");
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
});
