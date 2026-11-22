import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { LATEST_SCHEMA_VERSION } from "../src/storage/schema.ts";
import { openStore } from "../src/storage/node.ts";
import { ProjectRepository } from "../src/storage/projects.ts";
import { TaskRepository } from "../src/storage/tasks.ts";

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
        CREATE TABLE pa_conversations (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES pa_identities(id),
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL,
          platform_conversation_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('p2p', 'group', 'unknown')),
          created_at TEXT NOT NULL,
          UNIQUE (channel, account_id, platform_conversation_id)
        ) STRICT;
        INSERT INTO pa_conversations
          (id, owner_id, channel, account_id, platform_conversation_id, kind, created_at)
          VALUES ('legacy-conversation', 'legacy-owner', 'feishu', 'app', 'chat', 'p2p',
                  '2026-01-01T00:00:00.000Z');
        CREATE TABLE pa_tasks (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES pa_identities(id),
          conversation_id TEXT NOT NULL REFERENCES pa_conversations(id),
          source_key TEXT NOT NULL UNIQUE,
          goal TEXT NOT NULL,
          completion_criteria TEXT NOT NULL,
          mandate_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          deadline TEXT,
          budget_json TEXT,
          result_ref TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          verification_json TEXT,
          extension_json TEXT
        ) STRICT;
        INSERT INTO pa_tasks
          (id, owner_id, conversation_id, source_key, goal, completion_criteria,
           mandate_json, revision, status, attempts, created_at, updated_at)
          VALUES ('legacy-task', 'legacy-owner', 'legacy-conversation',
                  'legacy:source', 'legacy goal', 'legacy criteria',
                  '{"resources":["chat"],"tools":[]}', 1, 'succeeded', 1,
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        CREATE TABLE pa_inbox (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          owner_id TEXT,
          status TEXT NOT NULL,
          received_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE pa_outbox (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE pa_actions (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_revision INTEGER NOT NULL,
          fencing_token INTEGER NOT NULL,
          tool TEXT NOT NULL,
          args_json TEXT NOT NULL,
          args_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          nonce TEXT NOT NULL UNIQUE,
          approved_at TEXT,
          approved_by TEXT,
          execution_attempts INTEGER NOT NULL DEFAULT 0,
          lease_until TEXT,
          external_ref TEXT,
          evidence_json TEXT,
          last_error TEXT,
          preauthorization_id TEXT,
          schedule_policy_id TEXT,
          schedule_policy_version INTEGER,
          plugin_id TEXT,
          plugin_version TEXT,
          plugin_digest TEXT,
          catalog_generation INTEGER,
          source_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO pa_actions
          (id, owner_id, conversation_id, task_id, task_revision, fencing_token,
           tool, args_json, args_hash, status, expires_at, nonce, source_key,
           created_at, updated_at)
          VALUES ('legacy-action', 'legacy-owner', 'legacy-conversation',
                  'legacy-task', 1, 1, 'github.read', '{}', 'hash', 'succeeded',
                  '2026-01-01T00:10:00.000Z', 'legacy-nonce',
                  'legacy:action', '2026-01-01T00:00:00.000Z',
                  '2026-01-01T00:00:00.000Z');
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

        const task = store.db.all<{ status: string; goal: string }>(
          "SELECT status, goal FROM pa_tasks WHERE id = 'legacy-task'",
        )[0];
        assert.equal(task?.status, "succeeded");
        assert.equal(task?.goal, "legacy goal");
        const action = store.db.all<{ status: string; source_key: string }>(
          "SELECT status, source_key FROM pa_actions WHERE id = 'legacy-action'",
        )[0];
        assert.equal(action?.status, "succeeded");
        assert.equal(action?.source_key, "legacy:action");
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a schema-23 database that predates the budget key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pa-migrate-23-"));
    const path = join(directory, "agent.sqlite");
    try {
      // Build the previous tip, then remove the column and roll the version
      // back to simulate a database created before the new migration entry.
      const created = openStore(path);
      created.close();
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        DROP INDEX IF EXISTS pa_tasks_budget_idx;
        ALTER TABLE pa_tasks DROP COLUMN budget_key;
        UPDATE pa_meta SET value = '23' WHERE key = 'schema_version';
      `);
      legacy.close();

      const store = openStore(path);
      try {
        const version = store.db.all<{ value: string }>(
          "SELECT value FROM pa_meta WHERE key = 'schema_version'",
        )[0]?.value;
        assert.equal(Number(version), LATEST_SCHEMA_VERSION);
        const columns = store.db
          .all<{ name: string }>("PRAGMA table_info(pa_tasks)")
          .map((row) => row.name);
        assert.ok(columns.includes("budget_key"));

        const owner = store.bindOwner({
          channel: "feishu",
          accountId: "app",
          actorId: "owner",
          verifiedAt: "2026-01-01T00:00:00.000Z",
        });
        const conversation = store.upsertConversation({
          ownerId: owner.id,
          channel: "feishu",
          accountId: "app",
          platformConversationId: "chat",
          kind: "p2p",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const task = new TaskRepository(store.db).insert({
          ownerId: owner.id,
          conversationId: conversation.id,
          sourceKey: "schema-23:task",
          goal: "post-upgrade task",
          completionCriteria: "criteria",
          mandate: { resources: ["chat"], tools: [] },
          createdAt: "2026-01-01T00:00:00.000Z",
        }).task;
        assert.equal(task.goal, "post-upgrade task");
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
