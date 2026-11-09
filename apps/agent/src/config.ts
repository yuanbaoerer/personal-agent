import type { FeishuConfig } from "./channels/feishu/types.ts";
import { ConfigError } from "./domain/errors.ts";

export type FeishuEventMode = "webhook" | "long_connection";

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  ownerOpenId?: string;
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

  return {
    host: read("HOST") ?? "0.0.0.0",
    port: parseInteger(read("PORT") ?? "8787", "PORT", 1, 65_535),
    databasePath: read("DATABASE_PATH") ?? "./data/agent.sqlite",
    ownerOpenId: read("OWNER_FEISHU_OPEN_ID"),
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
