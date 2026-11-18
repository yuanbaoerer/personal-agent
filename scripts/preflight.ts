import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../apps/agent/src/config.ts";
import { ConfigError } from "../apps/agent/src/domain/errors.ts";

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface PreflightResult {
  checks: string[];
  warnings: string[];
  config: {
    host: string;
    port: number;
    eventMode: string;
    databasePath: string;
    piDatabasePath: string;
    modelConfigured: boolean;
    githubRepos: number;
    magpieConfigured: boolean;
  };
}

function dataDirectory(path: string, cwd: string): string {
  return path === ":memory:" ? "" : dirname(isAbsolute(path) ? path : resolve(cwd, path));
}

/**
 * Fail before opening SQLite/listening when the container cannot work. Prints
 * only non-secret configuration, so it is safe in Docker logs.
 */
export function runPreflight(options: PreflightOptions = {}): PreflightResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(env);
  const warnings: string[] = [];

  if ((env.OWNER_FEISHU_OPEN_ID ?? "").trim().length === 0) {
    throw new ConfigError(
      "missing environment variable: OWNER_FEISHU_OPEN_ID (self-hosted deployments must bind exactly one owner)",
    );
  }
  const checks = ["config_parsed", "owner_bound"];

  for (const [label, path] of [
    ["agent", config.databasePath],
    ["pi", config.piDatabasePath],
  ] as const) {
    const directory = dataDirectory(path, cwd);
    if (directory.length === 0) {
      checks.push(`${label}_database_memory`);
      continue;
    }
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
    const probe = mkdtempSync(join(directory, `.preflight-${label}-`));
    rmSync(probe, { recursive: true, force: true });
    checks.push(`${label}_data_writable`);
  }

  if (config.model.apiKey === undefined) {
    warnings.push(
      "OPENCODE_API_KEY is unset: deterministic commands work, model tasks fail explicitly",
    );
  }
  if (config.eventMode === "webhook" && config.feishu.encryptKey === undefined) {
    warnings.push(
      "FEISHU_ENCRYPT_KEY is unset: webhook authenticity relies on the verification token",
    );
  }
  if (config.github.token !== undefined && config.github.allowedRepos.length === 0) {
    warnings.push("GITHUB_TOKEN is set but GITHUB_ALLOWED_REPOS is empty: GitHub tool is disabled");
  }
  if (config.github.token === undefined && config.github.allowedRepos.length > 0) {
    warnings.push("GITHUB_ALLOWED_REPOS is set but GITHUB_TOKEN is empty: GitHub tool is disabled");
  }
  if (config.magpie.baseUrl === undefined) {
    warnings.push("MAGPIE_URL is unset: subscription budget enforcement is disabled");
  }

  return {
    checks,
    warnings,
    config: {
      host: config.host,
      port: config.port,
      eventMode: config.eventMode,
      databasePath: config.databasePath,
      piDatabasePath: config.piDatabasePath,
      modelConfigured: config.model.apiKey !== undefined,
      githubRepos: config.github.allowedRepos.length,
      magpieConfigured: config.magpie.baseUrl !== undefined,
    },
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  try {
    const result = runPreflight();
    console.log(JSON.stringify({ event: "preflight_ok", ...result }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "preflight_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
