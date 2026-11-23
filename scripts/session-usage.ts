import { DatabaseSync } from "node:sqlite";

interface Counts {
  assistantEntries: number;
  measuredEntries: number;
  observedTokens: number | null;
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error("expected a positive decimal Pi session ID");
  }
  return id;
}

function main(): void {
  const [path, ...args] = process.argv.slice(2);
  if (!path || args.length === 0) {
    throw new Error("usage: node scripts/session-usage.ts <pi.sqlite snapshot> <sessionId>...");
  }
  const ids = new Set(args.map(parseId));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const query = db.prepare(`
      WITH samples AS (
        SELECT CASE WHEN json_extract(record, '$.model[0].role') = 'assistant'
          AND json_type(record, '$.model[0].usage.totalTokens') = 'integer'
          AND json_extract(record, '$.model[0].usage.totalTokens') > 0
          THEN json_extract(record, '$.model[0].usage.totalTokens') END AS tokens
        FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.assistant'
      )
      SELECT count(*) AS assistantEntries, count(tokens) AS measuredEntries, sum(tokens) AS observedTokens
      FROM samples HAVING EXISTS (SELECT 1 FROM conversations WHERE id = ?)
    `);
    const sessions = [];
    let observed = 0;
    let measured = 0;
    let entries = 0;
    let complete = true;
    for (const sessionId of ids) {
      const row = query.get(sessionId, sessionId) as Counts | undefined;
      if (!row) throw new Error(`unknown Pi session: ${sessionId}`);
      const totalTokens = row.assistantEntries === row.measuredEntries ? row.observedTokens : null;
      sessions.push({ sessionId, ...row, totalTokens });
      entries += row.assistantEntries;
      measured += row.measuredEntries;
      observed += row.observedTokens ?? 0;
      if (!Number.isSafeInteger(observed)) throw new Error("token sum exceeds safe integer range");
      if (totalTokens === null) complete = false;
    }
    db.exec("COMMIT");
    const summary = {
      assistantEntries: entries,
      measuredEntries: measured,
      observedTokens: measured ? observed : null,
      totalTokens: complete ? observed : null,
      cost: null,
    };
    console.log(JSON.stringify({ sessions, summary }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
