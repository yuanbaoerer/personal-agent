import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { LATEST_SCHEMA_VERSION } from "../apps/agent/src/storage/schema.ts";

export interface BackupFile {
  name: string;
  bytes: number;
  sha256: string;
  schemaVersion?: string;
}

export interface BackupMetadata {
  tool: string;
  appVersion?: string;
  commitSha?: string;
  agentSchemaVersion?: string;
  /** Coarse, non-secret row counts used to compare a restored instance. */
  rowCounts: Record<string, number>;
  piTables: number;
  sdkVersions: Record<string, string>;
}

export interface BackupManifest {
  /** v2 adds non-secret metadata; v1 remains readable. */
  version: 1 | 2;
  createdAt: string;
  source: {
    dataDir: string;
    agentDatabase: string;
    piDatabase?: string;
  };
  files: BackupFile[];
  metadata?: BackupMetadata;
}

export interface BackupOptions {
  dataDir: string;
  outDir: string;
  now?: Date;
  /** Optional source names; defaults match the local Node service. */
  agentDatabase?: string;
  piDatabase?: string;
  appVersion?: string;
  commitSha?: string;
  sdkVersions?: Record<string, string>;
}

/** Restore a verified backup into a new/empty data directory. */
export async function restoreBackup(options: {
  backupDir: string;
  targetDir: string;
}): Promise<BackupManifest> {
  const manifest = await verifyBackup(options.backupDir);
  const source = resolve(options.backupDir);
  const target = resolve(options.targetDir);
  for (const file of manifest.files) {
    const version = readSchemaVersion(join(source, file.name));
    if (version === undefined) {
      continue;
    }
    const parsed = Number(version);
    if (!Number.isInteger(parsed)) {
      throw new Error(`invalid schema version in ${file.name}: ${version}`);
    }
    if (parsed > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `backup schema ${parsed} is newer than this build (${LATEST_SCHEMA_VERSION})`,
      );
    }
  }

  await mkdir(target, { recursive: true, mode: 0o700 });
  const existing = await readdir(target);
  if (existing.length > 0) {
    throw new Error(`restore target is not empty: ${target}`);
  }
  await chmod(target, 0o700);
  const copied: string[] = [];
  try {
    for (const file of manifest.files) {
      const destination = join(target, file.name);
      copied.push(destination);
      await copyFile(join(source, file.name), destination);
      await chmod(destination, 0o600);
      assertIntegrity(destination);
    }
    const manifestTarget = join(target, "manifest.json");
    copied.push(manifestTarget);
    await copyFile(join(source, "manifest.json"), manifestTarget);
    await chmod(manifestTarget, 0o600);
  } catch (error) {
    for (const path of copied) {
      await rm(path, { force: true });
    }
    throw error;
  }
  return manifest;
}

const AGENT_DB = "agent.sqlite";
const PI_DB = "pi.sqlite";

/** Copy both SQLite files with VACUUM INTO, then verify the copies. */
export async function createBackup(options: BackupOptions): Promise<BackupManifest> {
  const dataDir = resolve(options.dataDir);
  const outDir = resolve(options.outDir);
  const agentName = options.agentDatabase ?? AGENT_DB;
  const piName = options.piDatabase ?? PI_DB;
  const agentPath = join(dataDir, agentName);
  const piPath = join(dataDir, piName);
  const createdAt = (options.now ?? new Date()).toISOString();

  await assertSource(agentPath, true);
  const hasPi = await fileExists(piPath);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const existing = await readdir(outDir);
  if (existing.length > 0) {
    throw new Error(`backup destination is not empty: ${outDir}`);
  }
  await chmod(outDir, 0o700);

  const files: BackupFile[] = [];
  files.push(await copyDatabase(agentPath, join(outDir, agentName)));
  if (hasPi) {
    files.push(await copyDatabase(piPath, join(outDir, piName)));
  }

  const manifest: BackupManifest = {
    version: 2,
    createdAt,
    source: { dataDir, agentDatabase: agentName, piDatabase: hasPi ? piName : undefined },
    files,
    metadata: {
      tool: "backup-v2",
      appVersion: options.appVersion,
      commitSha: options.commitSha,
      agentSchemaVersion: readSchemaVersion(join(outDir, agentName)),
      rowCounts: readRowCounts(join(outDir, agentName)),
      piTables: hasPi ? readTableCount(join(outDir, piName)) : 0,
      sdkVersions: options.sdkVersions ?? {},
    },
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

/** Re-check hashes and SQLite integrity of an existing backup directory. */
export async function verifyBackup(outDir: string): Promise<BackupManifest> {
  const dir = resolve(outDir);
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (
    (manifest.version !== 1 && manifest.version !== 2) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("unsupported backup manifest");
  }
  if (manifest.files.length === 0) {
    throw new Error("backup manifest lists no files");
  }
  const declared = [
    manifest.source?.agentDatabase,
    manifest.source?.piDatabase,
  ].filter((name): name is string => typeof name === "string");
  const listed = new Set(manifest.files.map((file) => file.name));
  for (const name of declared) {
    if (!listed.has(basename(name))) {
      throw new Error(`backup is missing ${name}`);
    }
  }
  for (const expected of manifest.files) {
    if (basename(expected.name) !== expected.name) {
      throw new Error(`invalid backup file name: ${expected.name}`);
    }
    const path = join(dir, expected.name);
    const size = (await stat(path)).size;
    const sha256 = await hashFile(path);
    if (size !== expected.bytes || sha256 !== expected.sha256) {
      throw new Error(`backup file changed: ${expected.name}`);
    }
    assertIntegrity(path);
  }
  return manifest;
}

async function copyDatabase(source: string, target: string): Promise<BackupFile> {
  const db = new DatabaseSync(source);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  await chmod(target, 0o600);
  assertIntegrity(target);
  const schemaVersion = readSchemaVersion(target);
  return {
    name: basename(target),
    bytes: (await stat(target)).size,
    sha256: await hashFile(target),
    schemaVersion,
  };
}

function readRowCounts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pa_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get() as
        | { count?: number }
        | undefined;
      counts[table.name] = Number(row?.count ?? 0);
    }
    return counts;
  } finally {
    db.close();
  }
}

function readTableCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

function readSchemaVersion(path: string): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM pa_meta WHERE key = ?")
      .get("schema_version") as { value?: string } | undefined;
    return row?.value;
  } catch {
    // pi.sqlite has no pa_meta; that is expected.
    return undefined;
  } finally {
    db.close();
  }
}

function assertIntegrity(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    if (row?.integrity_check !== "ok") {
      throw new Error(`integrity check failed for ${path}`);
    }
  } finally {
    db.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSource(path: string, required: boolean): Promise<void> {
  if (await fileExists(path)) {
    return;
  }
  if (required) {
    throw new Error(`source database not found: ${path}`);
  }
}

const KNOWN_FLAGS = new Set(["data", "out", "agent", "pi", "verify", "restore", "target"]);

type CliOptions = BackupOptions & {
  verify?: string;
  restore?: string;
  target?: string;
};

function parseArgs(argv: string[]): CliOptions {
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
  if (args.verify !== undefined && args.restore !== undefined) {
    throw new Error("use either --verify or --restore, not both");
  }
  if (args.target !== undefined && args.restore === undefined) {
    throw new Error("--target requires --restore");
  }
  if (args.verify !== undefined) {
    return { dataDir: "", outDir: "", verify: args.verify };
  }
  if (args.restore !== undefined) {
    if (args.target === undefined) {
      throw new Error("--restore requires --target");
    }
    return {
      dataDir: "",
      outDir: "",
      restore: args.restore,
      target: args.target,
    };
  }
  const dataDir = args.data ?? "./data";
  const createdAt = new Date().toISOString().replace(/[:.]/g, "-");
  let commitSha: string | undefined;
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    }).trim();
  } catch {
    commitSha = undefined;
  }
  let appVersion: string | undefined;
  let sdkVersions: Record<string, string> | undefined;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    appVersion = pkg.version;
    const agentPkg = JSON.parse(
      readFileSync(new URL("../apps/agent/package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    sdkVersions = agentPkg.dependencies ?? {};
  } catch {
    appVersion = undefined;
  }
  return {
    dataDir,
    outDir: args.out ?? join("backups", createdAt),
    appVersion,
    commitSha,
    sdkVersions,
    agentDatabase: args.agent,
    piDatabase: args.pi,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result =
      options.verify !== undefined
        ? await verifyBackup(options.verify)
        : options.restore !== undefined && options.target !== undefined
          ? await restoreBackup({
              backupDir: options.restore,
              targetDir: options.target,
            })
          : await createBackup(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
