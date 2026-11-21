import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { LATEST_SCHEMA_VERSION } from "../src/storage/schema.ts";
import { openStore } from "../src/storage/node.ts";
import { ProjectRepository } from "../src/storage/projects.ts";

/**
 * A database created on main (schema 18) must upgrade in place. This guards
 * historical Task/Action/Project rows from the three migrations added by the
 * L2 branch (credential refs, issue drafts, secret fingerprint).
 */
describe("legacy schema migration", () => {
  it("upgrades a schema-18 database without losing project bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pa-migrate-"));
    const path = join(directory, "agent.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE pa_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT INTO pa_meta (key, value) VALUES ('schema_version', '18');
        CREATE TABLE pa_identities (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          display_name TEXT,
          verified_at TEXT NOT NULL,
          revoked_at TEXT,
          UNIQUE (channel, account_id, actor_id)
        ) STRICT;
        INSERT INTO pa_identities
          (id, channel, account_id, actor_id, verified_at)
          VALUES ('legacy-owner', 'feishu', 'app', 'owner', '2026-01-01T00:00:00.000Z');
        CREATE TABLE pa_projects (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES pa_identities(id),
          project_key TEXT NOT NULL,
          repository_id INTEGER NOT NULL CHECK (repository_id > 0),
          repository_full_name TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          allowed_plan_paths_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO pa_projects
          (id, owner_id, project_key, repository_id, repository_full_name,
           default_branch, credential_ref, allowed_plan_paths_json, status,
           version, created_at, updated_at)
          VALUES ('legacy-project', 'legacy-owner', 'personal-agent', 1445007789,
                  'yuanbaoerer/personal-agent', 'main', 'github:default',
                  '["README.md"]', 'active', 1,
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      legacy.close();

      const store = openStore(path);
      try {
        const version = store.db.all<{ value: string }>(
          "SELECT value FROM pa_meta WHERE key = 'schema_version'",
        )[0]?.value;
        assert.equal(Number(version), LATEST_SCHEMA_VERSION);

        const project = new ProjectRepository(store.db).findActiveByKey(
          "legacy-owner",
          "personal-agent",
        );
        assert.equal(project?.repositoryId, 1445007789);
        assert.equal(project?.credentialRef, "github:default");
        assert.deepEqual(project?.allowedPlanPaths, ["README.md"]);

        const credentialColumns = store.db
          .all<{ name: string }>("PRAGMA table_info(pa_credential_refs)")
          .map((row) => row.name);
        assert.ok(credentialColumns.includes("secret_fingerprint"));
        const draftTables = store.db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pa_issue_drafts'",
        );
        assert.equal(draftTables.length, 1);
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
