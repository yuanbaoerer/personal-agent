import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const AGENT_TABLES = [
  "pa_identities",
  "pa_conversations",
  "pa_inbox",
  "pa_outbox",
  "pa_audit",
  "pa_tasks",
  "pa_assignments",
  "pa_actions",
  "pa_approvals",
  "pa_effects",
  "pa_schedules",
  "pa_memories",
  "pa_task_inputs",
  "pa_confirmations",
  "pa_preauthorizations",
  "pa_schedule_policies",
  "pa_schedule_policy_runs",
  "pa_projects",
] as const;

export interface AgentExport {
  exportVersion: 1;
  generatedAt: string;
  source: { agentDatabase: string };
  schemaVersion?: string;
  tables: Record<string, Record<string, unknown>[]>;
  pi: { included: false; tables: number };
}

export interface ExportOptions {
  dataDir: string;
  out: string;
  now?: Date;
  agentDatabase?: string;
  piDatabase?: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function readSchemaVersion(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT value FROM pa_meta WHERE key = ?")
      .get("schema_version") as { value?: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/**
 * Export application tables as JSON for inspection/migration. Secrets are not
 * read from the environment; Pi/Provider data is intentionally not included.
 */
export async function exportAgentData(options: ExportOptions): Promise<AgentExport> {
  const dataDir = resolve(options.dataDir);
  const out = resolve(options.out);
  const agentPath = join(dataDir, options.agentDatabase ?? "agent.sqlite");
  const piPath = join(dataDir, options.piDatabase ?? "pi.sqlite");
  if ((await stat(out).catch(() => undefined)) !== undefined) {
    throw new Error(`export destination already exists: ${out}`);
  }

  const db = new DatabaseSync(agentPath, { readOnly: true });
  const tables: Record<string, Record<string, unknown>[]> = {};
  let schemaVersion: string | undefined;
  try {
    // Pin one WAL snapshot so parent/child tables cannot come from different
    // committed states while the agent is running.
    db.exec("BEGIN");
    schemaVersion = readSchemaVersion(db);
    for (const table of AGENT_TABLES) {
      if (!tableExists(db, table)) {
        continue;
      }
      tables[table] = db.prepare(`SELECT * FROM "${table}"`).all() as Record<
        string,
        unknown
      >[];
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  let piTables = 0;
  try {
    const pi = new DatabaseSync(piPath, { readOnly: true });
    try {
      const row = pi
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { count?: number } | undefined;
      piTables = Number(row?.count ?? 0);
    } finally {
      pi.close();
    }
  } catch {
    // Pi is optional; the export explicitly says it is not included.
  }

  const result: AgentExport = {
    exportVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    source: { agentDatabase: basename(agentPath) },
    schemaVersion,
    tables,
    pi: { included: false, tables: piTables },
  };

  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

const KNOWN_FLAGS = new Set(["data", "out", "agent", "pi"]);

function parseArgs(argv: string[]): ExportOptions {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index] ?? "";
    const name = key.startsWith("--") ? key.slice(2) : "";
    if (!KNOWN_FLAGS.has(name)) {
      throw new Error(`unknown option: ${key}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`missing value for ${key}`);
    }
    args[name] = value;
    index += 1;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    dataDir: args.data ?? "./data",
    out: args.out ?? join("exports", `agent-${stamp}.json`),
    agentDatabase: args.agent,
    piDatabase: args.pi,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await exportAgentData(parseArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify({
        event: "export_ok",
        schemaVersion: result.schemaVersion,
        tables: Object.fromEntries(
          Object.entries(result.tables).map(([name, rows]) => [name, rows.length]),
        ),
        pi: result.pi,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
