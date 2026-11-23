import type { FeishuConfig } from "./channels/feishu/types.ts";
import { ConfigError } from "./domain/errors.ts";

export type FeishuEventMode = "webhook" | "long_connection";

export const SUPPORTED_MODEL_PROVIDERS = ["opencode-go"] as const;
export type ModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

export interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
  /** Absent means the Node process cannot run model tasks. */
  apiKey?: string;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  encryptionKey: string;
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  /** pi_* tables live in their own SQLite file; see docs/adr/0001. */
  piDatabasePath: string;
  model: ModelConfig;
  github: {
    token?: string;
    allowedRepos: string[];
    /** Encrypts stored PAT/OAuth tokens; OAuth falls back to its own key. */
    encryptionKey?: string;
    oauth?: GitHubOAuthConfig;
    /** Separate least-privilege Issues-write credential; never inherited. */
    issueWriteToken?: string;
    issueWriteRepos: string[];
    issueWriteCredentialRef: string;
  };
  adminToken?: string;
  magpie: {
    baseUrl?: string;
    gatewayKey?: string;
    minRemainingPercent: number;
  };
  budget: {
    maxCallsPerTask: number;
    maxCallsPerDay?: number;
    maxToolCallsPerTask: number;
    maxScheduleRunsPerDay: number;
  };
  ownerOpenId?: string;
  /** Optional SKILL.md root; absent means use ./skills when it exists. */
  skillsDir?: string;
  /** Optional read-only MCP server config JSON. */
  mcpConfigPath?: string;
  eventMode: FeishuEventMode;
  feishu: FeishuConfig;
  outbox: {
    leaseMs: number;
    maxAttempts: number;
    retryBaseMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };

  const required = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_VERIFICATION_TOKEN",
  ] as const;
  const missing = required.filter((name) => read(name) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`missing environment variables: ${missing.join(", ")}`);
  }

  const appId = read("FEISHU_APP_ID") as string;
  const appSecret = read("FEISHU_APP_SECRET") as string;
  const verificationToken = read("FEISHU_VERIFICATION_TOKEN") as string;

  const eventModeRaw = read("FEISHU_EVENT_MODE") ?? "webhook";
  if (eventModeRaw !== "webhook" && eventModeRaw !== "long_connection") {
    throw new ConfigError("FEISHU_EVENT_MODE must be webhook or long_connection");
  }

  const port = parseInteger(read("PORT") ?? "8787", "PORT", 1, 65_535);
  const adminToken = read("ADMIN_TOKEN");
  const githubOAuthClientId = read("GITHUB_OAUTH_CLIENT_ID");
  const githubOAuthClientSecret = read("GITHUB_OAUTH_CLIENT_SECRET");
  const githubOAuthEncryptionKey = read("GITHUB_OAUTH_ENCRYPTION_KEY");
  const githubConnectionEncryptionKey =
    read("GITHUB_CONNECTION_ENCRYPTION_KEY") ?? githubOAuthEncryptionKey;
  if (
    read("GITHUB_CONNECTION_ENCRYPTION_KEY") !== undefined &&
    githubOAuthEncryptionKey !== undefined &&
    read("GITHUB_CONNECTION_ENCRYPTION_KEY") !== githubOAuthEncryptionKey
  ) {
    throw new ConfigError(
      "GITHUB_CONNECTION_ENCRYPTION_KEY must match GITHUB_OAUTH_ENCRYPTION_KEY when both are set",
    );
  }
  if (
    (githubOAuthClientId === undefined) !==
    (githubOAuthClientSecret === undefined)
  ) {
    throw new ConfigError(
      "GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set together",
    );
  }
  if (githubOAuthClientId !== undefined && githubOAuthEncryptionKey === undefined) {
    throw new ConfigError(
      "GITHUB_OAUTH_ENCRYPTION_KEY is required when GitHub OAuth is configured",
    );
  }
  if (githubOAuthClientId === undefined && githubOAuthEncryptionKey !== undefined) {
    throw new ConfigError(
      "GITHUB_OAUTH_ENCRYPTION_KEY is set but GITHUB_OAUTH_CLIENT_ID/SECRET are missing",
    );
  }
  if (
    githubOAuthClientId !== undefined &&
    githubOAuthClientSecret !== undefined &&
    adminToken === undefined
  ) {
    throw new ConfigError(
      "ADMIN_TOKEN is required when GitHub OAuth is configured; OAuth routes must not rely on loopback trust",
    );
  }
  const githubOAuth =
    githubOAuthClientId !== undefined &&
    githubOAuthClientSecret !== undefined &&
    githubOAuthEncryptionKey !== undefined
      ? {
          clientId: githubOAuthClientId,
          clientSecret: githubOAuthClientSecret,
          redirectUri:
            read("GITHUB_OAUTH_REDIRECT_URI") ??
            `http://127.0.0.1:${port}/oauth/github/callback`,
          scopes: (read("GITHUB_OAUTH_SCOPES") ?? "read:user,public_repo")
            .split(/[\s,]+/)
            .filter((scope) => scope.length > 0),
          encryptionKey: githubOAuthEncryptionKey,
        }
      : undefined;
  const issueWriteToken = read("GITHUB_ISSUE_WRITE_TOKEN");
  const issueWriteRepos = (read("GITHUB_ISSUE_WRITE_REPOS") ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo.length > 0);
  const issueWriteCredentialRef =
    read("GITHUB_ISSUE_WRITE_CREDENTIAL_REF") ?? "github:issues";
  if (issueWriteToken !== undefined && issueWriteRepos.length === 0) {
    throw new ConfigError(
      "GITHUB_ISSUE_WRITE_REPOS is required when GITHUB_ISSUE_WRITE_TOKEN is set",
    );
  }
  if (issueWriteToken === undefined && issueWriteRepos.length > 0) {
    throw new ConfigError(
      "GITHUB_ISSUE_WRITE_TOKEN is required when GITHUB_ISSUE_WRITE_REPOS is set",
    );
  }
  if (
    !/^[a-z][a-z0-9._:-]{0,127}$/.test(issueWriteCredentialRef) ||
    /^(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)/i.test(issueWriteCredentialRef)
  ) {
    throw new ConfigError(
      "GITHUB_ISSUE_WRITE_CREDENTIAL_REF must be a credential reference, not a token",
    );
  }
  const providerRaw = read("MODEL_PROVIDER") ?? "opencode-go";
  if (!SUPPORTED_MODEL_PROVIDERS.includes(providerRaw as ModelProvider)) {
    throw new ConfigError(
      `MODEL_PROVIDER must be one of: ${SUPPORTED_MODEL_PROVIDERS.join(", ")}`,
    );
  }

  return {
    host: read("HOST") ?? "0.0.0.0",
    port,
    databasePath: read("DATABASE_PATH") ?? "./data/agent.sqlite",
    piDatabasePath: read("PI_DATABASE_PATH") ?? "./data/pi.sqlite",
    model: {
      provider: providerRaw as ModelProvider,
      modelId: read("OPENCODE_MODEL") ?? "deepseek-v4.1-flash",
      apiKey: read("OPENCODE_API_KEY"),
    },
    github: {
      token: read("GITHUB_TOKEN"),
      allowedRepos: (read("GITHUB_ALLOWED_REPOS") ?? "")
        .split(",")
        .map((repo) => repo.trim())
        .filter((repo) => repo.length > 0),
      oauth: githubOAuth,
      ...(githubConnectionEncryptionKey === undefined
        ? {}
        : { encryptionKey: githubConnectionEncryptionKey }),
      ...(issueWriteToken === undefined
        ? {}
        : { issueWriteToken }),
      issueWriteRepos,
      issueWriteCredentialRef,
    },
    adminToken,
    magpie: {
      baseUrl: read("MAGPIE_URL"),
      gatewayKey: read("MAGPIE_GATEWAY_KEY"),
      minRemainingPercent: parseInteger(
        read("MAGPIE_MIN_REMAINING_PERCENT") ?? "5",
        "MAGPIE_MIN_REMAINING_PERCENT",
        0,
        100,
      ),
    },
    budget: {
      maxCallsPerTask: parseInteger(
        read("BUDGET_MAX_MODEL_CALLS_PER_TASK") ?? "10",
        "BUDGET_MAX_MODEL_CALLS_PER_TASK",
        1,
        1_000,
      ),
      maxCallsPerDay:
        read("BUDGET_MAX_MODEL_CALLS_PER_DAY") === undefined
          ? undefined
          : parseInteger(
              read("BUDGET_MAX_MODEL_CALLS_PER_DAY") as string,
              "BUDGET_MAX_MODEL_CALLS_PER_DAY",
              1,
              100_000,
            ),
      maxToolCallsPerTask: parseInteger(
        read("BUDGET_MAX_TOOL_CALLS_PER_TASK") ?? "20",
        "BUDGET_MAX_TOOL_CALLS_PER_TASK",
        1,
        1_000,
      ),
      maxScheduleRunsPerDay: parseInteger(
        read("BUDGET_MAX_SCHEDULE_RUNS_PER_DAY") ?? "20",
        "BUDGET_MAX_SCHEDULE_RUNS_PER_DAY",
        1,
        1_000,
      ),
    },
    ownerOpenId: read("OWNER_FEISHU_OPEN_ID"),
    skillsDir: read("PA_SKILLS_DIR"),
    mcpConfigPath: read("PA_MCP_CONFIG"),
    eventMode: eventModeRaw,
    feishu: {
      appId,
      appSecret,
      verificationToken,
      accountId: appId,
      encryptKey: read("FEISHU_ENCRYPT_KEY"),
      apiBase: read("FEISHU_API_BASE"),
      timeoutMs:
        read("FEISHU_TIMEOUT_MS") === undefined
          ? undefined
          : parseInteger(read("FEISHU_TIMEOUT_MS") as string, "FEISHU_TIMEOUT_MS", 1_000, 60_000),
    },
    outbox: {
      leaseMs: parseInteger(read("OUTBOX_LEASE_MS") ?? "15000", "OUTBOX_LEASE_MS", 1_000, 300_000),
      maxAttempts: parseInteger(read("OUTBOX_MAX_ATTEMPTS") ?? "5", "OUTBOX_MAX_ATTEMPTS", 1, 20),
      retryBaseMs: parseInteger(
        read("OUTBOX_RETRY_BASE_MS") ?? "1000",
        "OUTBOX_RETRY_BASE_MS",
        100,
        60_000,
      ),
    },
  };
}

function parseInteger(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
