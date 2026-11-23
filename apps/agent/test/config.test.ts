import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

const BASE = {
  FEISHU_APP_ID: "cli_app",
  FEISHU_APP_SECRET: "secret",
  FEISHU_VERIFICATION_TOKEN: "token",
};

describe("model provider config", () => {
  it("defaults to opencode-go and accepts a pinned model", () => {
    const config = loadConfig({ ...BASE, OPENCODE_MODEL: "fixed-model" });
    assert.equal(config.model.provider, "opencode-go");
    assert.equal(config.model.modelId, "fixed-model");
    assert.equal(config.model.apiKey, undefined);
  });

  it("rejects an unsupported provider instead of silently falling back", () => {
    assert.throws(
      () => loadConfig({ ...BASE, MODEL_PROVIDER: "openai" }),
      /MODEL_PROVIDER must be one of/,
    );
  });
});

describe("GitHub OAuth config", () => {
  it("requires client id, secret, and encryption key together", () => {
    assert.throws(
      () => loadConfig({ ...BASE, GITHUB_OAUTH_CLIENT_ID: "client" }),
      /set together/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          GITHUB_OAUTH_CLIENT_ID: "client",
          GITHUB_OAUTH_CLIENT_SECRET: "secret",
        }),
      /GITHUB_OAUTH_ENCRYPTION_KEY/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          GITHUB_OAUTH_CLIENT_ID: "client",
          GITHUB_OAUTH_CLIENT_SECRET: "secret",
          GITHUB_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        }),
      /ADMIN_TOKEN is required/,
    );
    const config = loadConfig({
      ...BASE,
      GITHUB_OAUTH_CLIENT_ID: "client",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
      GITHUB_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      ADMIN_TOKEN: "admin",
    });
    assert.equal(config.github.oauth?.clientId, "client");
    assert.equal(
      config.github.oauth?.redirectUri,
      "http://127.0.0.1:8787/oauth/github/callback",
    );
  });

  it("accepts a PAT-only vault key and rejects conflicting keys", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const patOnly = loadConfig({
      ...BASE,
      GITHUB_CONNECTION_ENCRYPTION_KEY: key,
    });
    assert.equal(patOnly.github.encryptionKey, key);
    assert.equal(patOnly.github.oauth, undefined);

    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          GITHUB_OAUTH_CLIENT_ID: "client",
          GITHUB_OAUTH_CLIENT_SECRET: "secret",
          GITHUB_OAUTH_ENCRYPTION_KEY: key,
          GITHUB_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
          ADMIN_TOKEN: "admin",
        }),
      /must match/,
    );
  });
});

describe("Feishu event mode config", () => {
  it("defaults to webhook", () => {
    assert.equal(loadConfig(BASE).eventMode, "webhook");
  });

  it("accepts long_connection", () => {
    assert.equal(
      loadConfig({ ...BASE, FEISHU_EVENT_MODE: "long_connection" }).eventMode,
      "long_connection",
    );
  });

  it("rejects an unknown mode", () => {
    assert.throws(
      () => loadConfig({ ...BASE, FEISHU_EVENT_MODE: "websocket" }),
      /FEISHU_EVENT_MODE/,
    );
  });
});

describe("model-call budget config", () => {
  it("defaults to 10 calls per task with no daily cap", () => {
    const config = loadConfig(BASE);
    assert.equal(config.budget.maxCallsPerTask, 10);
    assert.equal(config.budget.maxCallsPerDay, undefined);
    assert.equal(config.budget.maxToolCallsPerTask, 20);
    assert.equal(config.budget.maxScheduleRunsPerDay, 20);
  });

  it("parses explicit task and daily limits", () => {
    const config = loadConfig({
      ...BASE,
      BUDGET_MAX_MODEL_CALLS_PER_TASK: "3",
      BUDGET_MAX_MODEL_CALLS_PER_DAY: "25",
      BUDGET_MAX_TOOL_CALLS_PER_TASK: "7",
      BUDGET_MAX_SCHEDULE_RUNS_PER_DAY: "4",
    });
    assert.equal(config.budget.maxCallsPerTask, 3);
    assert.equal(config.budget.maxCallsPerDay, 25);
    assert.equal(config.budget.maxToolCallsPerTask, 7);
    assert.equal(config.budget.maxScheduleRunsPerDay, 4);
  });

  it("rejects out-of-range limits", () => {
    assert.throws(
      () => loadConfig({ ...BASE, BUDGET_MAX_MODEL_CALLS_PER_TASK: "0" }),
      /BUDGET_MAX_MODEL_CALLS_PER_TASK/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, BUDGET_MAX_MODEL_CALLS_PER_DAY: "0" }),
      /BUDGET_MAX_MODEL_CALLS_PER_DAY/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, BUDGET_MAX_TOOL_CALLS_PER_TASK: "0" }),
      /BUDGET_MAX_TOOL_CALLS_PER_TASK/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, BUDGET_MAX_SCHEDULE_RUNS_PER_DAY: "0" }),
      /BUDGET_MAX_SCHEDULE_RUNS_PER_DAY/,
    );
  });
});
