import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export interface BackupFile {
  name: string;
  bytes: number;
  sha256: string;
  schemaVersion?: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  source: {
    dataDir: string;
    agentDatabase: string;
    piDatabase?: string;
  };
  files: BackupFile[];
}

export interface BackupOptions {
  dataDir: string;
  outDir: string;
  now?: Date;
  /** Optional source names; defaults match the local Node service. */
  agentDatabase?: string;
  piDatabase?: string;
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
    version: 1,
    createdAt,
    source: { dataDir, agentDatabase: agentName, piDatabase: hasPi ? piName : undefined },
    files,
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
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
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

const KNOWN_FLAGS = new Set(["data", "out", "agent", "pi", "verify"]);

function parseArgs(argv: string[]): BackupOptions & { verify?: string } {
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
  if (args.verify !== undefined) {
    return { dataDir: "", outDir: "", verify: args.verify };
  }
  const dataDir = args.data ?? "./data";
  const createdAt = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    dataDir,
    outDir: args.out ?? join("backups", createdAt),
    agentDatabase: args.agent,
    piDatabase: args.pi,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result =
      options.verify === undefined
        ? await createBackup(options)
        : await verifyBackup(options.verify);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
