import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

const BASE = {
  FEISHU_APP_ID: "cli_app",
  FEISHU_APP_SECRET: "secret",
  FEISHU_VERIFICATION_TOKEN: "token",
};

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
