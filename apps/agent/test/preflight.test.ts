import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runPreflight } from "../../../scripts/preflight.ts";

function baseEnv(dir: string): NodeJS.ProcessEnv {
  return {
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret",
    FEISHU_VERIFICATION_TOKEN: "token",
    FEISHU_EVENT_MODE: "long_connection",
    OWNER_FEISHU_OPEN_ID: "ou_test",
    OPENCODE_API_KEY: "test-key",
    DATABASE_PATH: join(dir, "agent.sqlite"),
    PI_DATABASE_PATH: join(dir, "pi.sqlite"),
  };
}

describe("container preflight", () => {
  it("creates data directories and reports redacted configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-preflight-"));
    try {
      const result = runPreflight({ env: baseEnv(dir), cwd: dir });
      assert.deepEqual(result.checks, [
        "config_parsed",
        "owner_bound",
        "agent_data_writable",
        "pi_data_writable",
      ]);
      assert.equal(result.config.modelConfigured, true);
      assert.equal(result.config.host, "0.0.0.0");
      assert.equal(result.config.port, 8787);
      assert.ok(result.warnings.some((warning) => warning.includes("MAGPIE_URL")));
      assert.ok(!JSON.stringify(result).includes("test-key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails before startup without a bound owner or Feishu credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-preflight-"));
    try {
      const env = baseEnv(dir);
      delete env.OWNER_FEISHU_OPEN_ID;
      assert.throws(() => runPreflight({ env, cwd: dir }), /OWNER_FEISHU_OPEN_ID/);
      delete env.FEISHU_APP_ID;
      assert.throws(() => runPreflight({ env, cwd: dir }), /FEISHU_APP_ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
