import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { scanText } from "../../../scripts/scan-secrets.ts";

describe("secret scanner", () => {
  it("reports locations without returning the matched value", () => {
    const text = `prefix ${"oc_sk_"}${"abcdefghijklmnop"} suffix`;
    const findings = scanText(text, "fixture.txt");
    assert.deepEqual(findings, [
      { rule: "opencode_api_key", file: "fixture.txt", line: 1 },
    ]);
    assert.ok(!JSON.stringify(findings).includes("abcdefghijklmnop"));
  });

  it("catches fine-grained GitHub PATs and encrypted/PGP private keys", () => {
    const token = `github_pat_${"abcdefghijklmnopqrstuvwx"}_${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"}`;
    assert.deepEqual(scanText(token).map((finding) => finding.rule), [
      "github_fine_grained_token",
    ]);
    for (const kind of ["ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK", "DSA PRIVATE KEY"]) {
      const block = `-----BEGIN ${kind}-----`;
      assert.ok(
        scanText(block).some((finding) => finding.rule === "private_key"),
        kind,
      );
    }
  });

  it("fails closed when git history cannot be scanned", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-secret-scan-"));
    try {
      const script = fileURLToPath(
        new URL("../../../scripts/scan-secrets.ts", import.meta.url),
      );
      const result = spawnSync(process.execPath, [script, "--history"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.ok(!`${result.stdout}\n${result.stderr}`.includes('"findings": []'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores synthetic Feishu ids used by tests", () => {
    assert.deepEqual(scanText("ou_owner om_1 cli_app"), []);
  });
});
