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
