import type { Db } from "./db.ts";

/**
 * Application tables use the pa_ prefix. Pi owns pi_* tables and is never
 * migrated or rewritten here.
 *
 * Each migration is a list of individual statements so the same code runs on
 * Node's `node:sqlite` and a Durable Object's SQLite storage. Schema version
 * lives in pa_meta rather than `PRAGMA user_version`, which Durable Object
 * SQLite does not expose through its typed API.
 */
const migrations: readonly (readonly string[])[] = [
  [
    `CREATE TABLE pa_identities (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      display_name TEXT,
      verified_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE (channel, account_id, actor_id)
    ) STRICT`,
    `CREATE TABLE pa_conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES pa_identities(id),
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      platform_conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('p2p', 'group', 'unknown')),
      created_at TEXT NOT NULL,
      UNIQUE (channel, account_id, platform_conversation_id)
    ) STRICT`,
    `CREATE TABLE pa_inbox (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      platform_event_id TEXT NOT NULL,
      owner_id TEXT REFERENCES pa_identities(id),
      conversation_id TEXT REFERENCES pa_conversations(id),
      platform_conversation_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      reply_to TEXT,
      text TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      reject_reason TEXT,
      occurred_at TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      trace_id TEXT NOT NULL,
      UNIQUE (channel, account_id, platform_event_id)
    ) STRICT`,
    `CREATE INDEX pa_inbox_pending_idx
      ON pa_inbox (status, processed_at, received_at)`,
    `CREATE TABLE pa_outbox (
      id TEXT PRIMARY KEY,
      business_key TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      task_id TEXT,
      purpose TEXT NOT NULL CHECK (
        purpose IN ('ack', 'status', 'clarify', 'approval', 'result', 'failure', 'reminder')
      ),
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'sending', 'accepted', 'failed', 'unknown', 'needs_manual', 'cancelled')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      lease_until TEXT,
      platform_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT,
      delivered_at TEXT,
      read_at TEXT
    ) STRICT`,
    `CREATE INDEX pa_outbox_due_idx
      ON pa_outbox (status, next_attempt_at, created_at)`,
    `CREATE INDEX pa_outbox_task_idx ON pa_outbox (task_id, status)`,
    `CREATE TABLE pa_audit (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      actor_id TEXT,
      event TEXT NOT NULL,
      subject_type TEXT,
      subject_id TEXT,
      before_json TEXT,
      after_json TEXT,
      trace_id TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_audit_subject_idx ON pa_audit (subject_type, subject_id)`,
  ],
  [
    `CREATE TABLE pa_tasks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES pa_identities(id),
      conversation_id TEXT NOT NULL REFERENCES pa_conversations(id),
      source_key TEXT NOT NULL UNIQUE,
      goal TEXT NOT NULL,
      completion_criteria TEXT NOT NULL,
      mandate_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'running', 'waiting_user', 'waiting_external',
          'succeeded', 'failed', 'cancelling', 'cancelled'
        )
      ),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      budget_json TEXT,
      result_ref TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_tasks_dispatch_idx
      ON pa_tasks (status, priority DESC, created_at ASC)`,
    `CREATE TABLE pa_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES pa_tasks(id),
      task_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'reported', 'superseded', 'cancelled', 'expired')),
      lease_until TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      report_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX pa_assignments_active_idx
      ON pa_assignments (task_id) WHERE status = 'active'`,
    `CREATE INDEX pa_assignments_lease_idx ON pa_assignments (status, lease_until)`,
    `CREATE TABLE pa_actions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      fencing_token INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'proposed', 'approved', 'denied', 'expired', 'superseded',
          'executing', 'succeeded', 'failed', 'unknown', 'reconciling', 'needs_manual'
        )
      ),
      expires_at TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      approved_at TEXT,
      approved_by TEXT,
      execution_attempts INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      external_ref TEXT,
      evidence_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_actions_task_idx ON pa_actions (task_id, status)`,
    `CREATE INDEX pa_actions_due_idx ON pa_actions (status, lease_until, expires_at)`,
    `CREATE TABLE pa_approvals (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL UNIQUE REFERENCES pa_actions(id),
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
      approver_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE pa_effects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      business_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_effects_due_idx
      ON pa_effects (status, next_attempt_at, created_at)`,
    `CREATE TABLE pa_schedules (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_key TEXT NOT NULL UNIQUE,
      due_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      text TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('reminder')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled', 'skipped')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_schedules_due_idx ON pa_schedules (status, due_at)`,
    `CREATE TABLE pa_memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_event_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, key)
    ) STRICT`,
  ],
  [
    // Idempotency for a Worker report retried after its assignment was
    // already marked reported: the same proposal cannot create a second action.
    `ALTER TABLE pa_actions ADD COLUMN source_key TEXT`,
    // SQLite unique indexes permit multiple NULLs, so actions without a
    // source key (direct proposals) do not conflict with each other.
    `CREATE UNIQUE INDEX pa_actions_source_idx ON pa_actions (source_key)`,
  ],
  [
    // Owner-supplied facts/answers are handed to the next Worker run.
    `ALTER TABLE pa_tasks ADD COLUMN owner_input TEXT`,
  ],
  [
    // Immutable TaskInput rows. `owner_input` was a mutable concatenation, so
    // a Worker could report `ready` without ever seeing late additions. The
    // assignment seq columns make that barrier observable and enforceable.
    `CREATE TABLE pa_task_inputs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES pa_tasks(id),
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('supplement')),
      source_inbox_id TEXT,
      actor_id TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, seq),
      UNIQUE (task_id, source_inbox_id)
    ) STRICT`,
    `ALTER TABLE pa_assignments ADD COLUMN dispatched_input_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE pa_assignments ADD COLUMN consumed_input_seq INTEGER NOT NULL DEFAULT 0`,
    // Preserve input accepted before the migration as the first immutable row.
    `INSERT INTO pa_task_inputs
       (id, task_id, seq, kind, source_inbox_id, actor_id, text, created_at)
     SELECT 'legacy:' || id, id, 1, 'supplement', NULL, NULL, owner_input, updated_at
     FROM pa_tasks
     WHERE owner_input IS NOT NULL AND length(owner_input) > 0`,
  ],
  [
    // Causal trace for delivery rows; payload text stays out of diagnostics.
    `ALTER TABLE pa_outbox ADD COLUMN trace_id TEXT`,
    `CREATE INDEX pa_outbox_trace_idx ON pa_outbox (trace_id)`,
  ],
  [
    // Model-interpreted memory/reminder changes wait for an explicit owner
    // confirmation. Deterministic slash commands bypass this table.
    `CREATE TABLE pa_confirmations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      source_inbox_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('memory_save', 'reminder_create')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'confirmed', 'cancelled', 'expired')
      ),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, source_inbox_id, kind)
    ) STRICT`,
    `CREATE INDEX pa_confirmations_owner_idx ON pa_confirmations (owner_id, status)`,
  ],
  [
    // Owner-granted, revocable permission for bounded read-only actions.
    `CREATE TABLE pa_preauthorizations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      repo TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, tool, repo)
    ) STRICT`,
    `CREATE INDEX pa_preauthorizations_owner_idx
       ON pa_preauthorizations (owner_id, tool, repo, status)`,
  ],
  [
    // Provenance for actions approved by a read-only preauthorization, so a
    // revoked grant can stop work that has not executed yet.
    `ALTER TABLE pa_actions ADD COLUMN preauthorization_id TEXT`,
  ],
  [
    // Recurring, owner-confirmed task policies. A draft has no timer until the
    // owner confirms the exact scope; every edit returns to draft.
    `CREATE TABLE pa_schedule_policies (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      timezone TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekdays')),
      local_time TEXT NOT NULL,
      repo TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'paused', 'cancelled', 'expired')
      ),
      version INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_schedule_policies_due_idx
       ON pa_schedule_policies (status, next_run_at)`,
    `CREATE TABLE pa_schedule_policy_runs (
      policy_id TEXT NOT NULL REFERENCES pa_schedule_policies(id),
      scheduled_at TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('dispatched', 'skipped')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (policy_id, scheduled_at)
    ) STRICT`,
    `ALTER TABLE pa_tasks ADD COLUMN schedule_policy_id TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN schedule_policy_id TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN schedule_policy_version INTEGER`,
  ],
  [
    // Completion verifier output and the only path out of needs_review.
    `ALTER TABLE pa_tasks ADD COLUMN verification_json TEXT`,
    `ALTER TABLE pa_tasks ADD COLUMN acknowledged_at TEXT`,
    `ALTER TABLE pa_tasks ADD COLUMN acknowledged_by TEXT`,
    // SQLite cannot widen a CHECK constraint in place. needs_review is stored
    // as waiting_user + this terminal flag and mapped to the domain status.
    `ALTER TABLE pa_tasks ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0`,
  ],
  [
    // Project-scoped memories. Existing rows are global; a rebuild is needed
    // because SQLite cannot widen the old UNIQUE(owner_id, key) constraint.
    `ALTER TABLE pa_memories RENAME TO pa_memories_old`,
    `CREATE TABLE pa_memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_event_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, project, key)
    ) STRICT`,
    `INSERT INTO pa_memories
       (id, owner_id, project, key, value, source_event_id, version, status,
        created_at, updated_at)
     SELECT id, owner_id, '', key, value, source_event_id, version, status,
            created_at, updated_at
     FROM pa_memories_old`,
    `DROP TABLE pa_memories_old`,
    `CREATE INDEX pa_memories_scope_idx ON pa_memories (owner_id, project, status)`,
  ],
  [
    // GitHub OAuth state and encrypted credentials (Node self-host path).
    `CREATE TABLE pa_github_oauth_states (
      state_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_github_oauth_states_owner_idx
       ON pa_github_oauth_states (owner_id, expires_at)`,
    `CREATE TABLE pa_github_credentials (
      owner_id TEXT PRIMARY KEY,
      github_user_id TEXT NOT NULL,
      login TEXT NOT NULL,
      scopes TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
  ],
  [
    // Revocable, least-privilege credentials for local clients (CLI/TUI).
    // Only a SHA-256 hash of the bearer token is stored.
    `CREATE TABLE pa_client_tokens (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES pa_identities(id),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    ) STRICT`,
    `CREATE INDEX pa_client_tokens_owner_idx
       ON pa_client_tokens (owner_id, revoked_at)`,
  ],
  [
    // Stable event cursor. SQLite rowid can change on VACUUM; audit seq is
    // assigned by recordAudit and never reused.
    `ALTER TABLE pa_audit ADD COLUMN seq INTEGER`,
    `UPDATE pa_audit SET seq = rowid`,
    `CREATE UNIQUE INDEX pa_audit_seq_idx ON pa_audit (seq)`,
  ],
  [
    // Optional device-token lifetime. Null means the owner must revoke it.
    `ALTER TABLE pa_client_tokens ADD COLUMN expires_at TEXT`,
    `CREATE INDEX pa_client_tokens_expiry_idx ON pa_client_tokens (expires_at)`,
  ],
  [
    // Builtin plugin lifecycle and the catalog identity pinned on tasks/actions.
    // Disabling a plugin never deletes its row or its audit trail.
    `CREATE TABLE pa_plugins (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'error')),
      config_json TEXT NOT NULL,
      error TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      enabled_at TEXT,
      disabled_at TEXT
    ) STRICT`,
    `ALTER TABLE pa_tasks ADD COLUMN extension_json TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN plugin_id TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN plugin_version TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN plugin_digest TEXT`,
    `ALTER TABLE pa_actions ADD COLUMN catalog_generation INTEGER`,
    `CREATE INDEX pa_actions_plugin_idx ON pa_actions (plugin_id, status)`,
  ],
  [
    // Owner-scoped GitHub project bindings. `repository_id` is immutable;
    // full_name is display data. Only one active binding per key/repo.
    `CREATE TABLE pa_projects (
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
    ) STRICT`,
    `CREATE UNIQUE INDEX pa_projects_owner_key_active_idx
       ON pa_projects (owner_id, project_key) WHERE status = 'active'`,
    `CREATE UNIQUE INDEX pa_projects_owner_repo_active_idx
       ON pa_projects (owner_id, repository_id) WHERE status = 'active'`,
    `CREATE INDEX pa_projects_owner_idx
       ON pa_projects (owner_id, status, project_key)`,
  ],
  [
    // Non-secret credential metadata. Tokens stay in the encrypted OAuth
    // vault or process environment; this row binds ref, owner, plugin,
    // account, scopes, repository ids and the rotation epoch.
    `CREATE TABLE pa_credential_refs (
      ref TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES pa_identities(id),
      plugin_id TEXT,
      account TEXT,
      scopes_json TEXT NOT NULL,
      repository_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      version INTEGER NOT NULL CHECK (version >= 1),
      expires_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX pa_credential_refs_owner_idx
       ON pa_credential_refs (owner_id, plugin_id, status)`,
  ],
  [
    // Verifier-approved issue draft snapshots. The payload hash and source
    // revision are immutable; status transition is separate. No token ref
    // secret is stored, only the credential reference and epoch.
    `CREATE TABLE pa_issue_drafts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES pa_identities(id),
      project_key TEXT NOT NULL,
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      repository_full_name TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      source_task_revision INTEGER NOT NULL CHECK (source_task_revision >= 1),
      source_assignment_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      finding_ids_json TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'comment')),
      target_issue INTEGER,
      before_hash TEXT,
      before_summary TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      credential_version INTEGER,
      status TEXT NOT NULL CHECK (
        status IN (
          'draft', 'pending_approval', 'approved', 'rejected', 'expired',
          'superseded', 'executing', 'failed'
        )
      ),
      write_task_id TEXT,
      write_action_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX pa_issue_drafts_active_key_idx
       ON pa_issue_drafts (owner_id, repository_id, idempotency_key)
       WHERE status IN ('draft', 'pending_approval', 'approved', 'executing')`,
    `CREATE INDEX pa_issue_drafts_owner_idx
       ON pa_issue_drafts (owner_id, status, created_at)`,
    `CREATE INDEX pa_issue_drafts_task_idx
       ON pa_issue_drafts (source_task_id, source_task_revision)`,
    `CREATE INDEX pa_issue_drafts_project_idx
       ON pa_issue_drafts (owner_id, project_key, repository_id, status)`,
  ],
  [
    // A one-way fingerprint of a static secret detects env-token rotation
    // across restarts without storing the token itself.
    `ALTER TABLE pa_credential_refs ADD COLUMN secret_fingerprint TEXT`,
  ],
  [
    // The Router reads a bounded window of one conversation. Inbox rows keep
    // the internal conversation id; outbox rows are addressed by the platform
    // conversation tuple, so both paths get an index.
    `CREATE INDEX IF NOT EXISTS pa_inbox_conversation_idx
       ON pa_inbox (conversation_id, owner_id, status, received_at)`,
    `CREATE INDEX IF NOT EXISTS pa_outbox_conversation_idx
       ON pa_outbox (owner_id, channel, account_id, conversation_id, created_at)`,
  ],
  [
    // A versioned, bounded workflow plan under one Parent Task. Plans are
    // drafts until the owner activates them; at most one version of a task
    // is active, and old versions stay queryable for diffs and audit.
    `CREATE TABLE pa_plans (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES pa_identities(id),
      parent_task_id TEXT NOT NULL REFERENCES pa_tasks(id),
      task_revision INTEGER NOT NULL,
      input_seq INTEGER NOT NULL,
      plan_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'paused', 'completed', 'cancelled', 'superseded')
      ),
      project_key TEXT,
      approved_scope_ref TEXT,
      budget_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (parent_task_id, plan_version)
    ) STRICT`,
    `CREATE UNIQUE INDEX pa_plans_active_idx
       ON pa_plans (parent_task_id) WHERE status = 'active'`,
    `CREATE INDEX pa_plans_owner_idx
       ON pa_plans (owner_id, updated_at DESC)`,
    `CREATE TABLE pa_plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES pa_plans(id),
      step_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      goal TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      verifier_id TEXT NOT NULL,
      max_attempts INTEGER NOT NULL,
      timeout_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('blocked', 'ready', 'running', 'completed', 'failed',
                   'needs_review', 'cancelled')
      ),
      assignment_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (plan_id, step_key)
    ) STRICT`,
    `CREATE INDEX pa_plan_steps_plan_idx
       ON pa_plan_steps (plan_id, ordinal)`,
    `CREATE TABLE pa_plan_diffs (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES pa_plans(id),
      from_version INTEGER NOT NULL,
      to_version INTEGER NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (plan_id, from_version, to_version)
    ) STRICT`,
    `CREATE INDEX pa_plan_diffs_plan_idx
       ON pa_plan_diffs (plan_id, to_version DESC)`,
  ],
  [
    // PL-02 wires plan steps to child tasks. The child task carries plan_id
    // so the dispatcher can reserve the parent while the plan runs; steps
    // keep the child task id and their own completion criteria.
    `ALTER TABLE pa_tasks ADD COLUMN plan_id TEXT`,
    `ALTER TABLE pa_tasks ADD COLUMN plan_step_key TEXT`,
    `ALTER TABLE pa_tasks ADD COLUMN budget_key TEXT`,
    `CREATE INDEX IF NOT EXISTS pa_tasks_plan_idx ON pa_tasks (plan_id, plan_step_key)`,
    `CREATE INDEX IF NOT EXISTS pa_tasks_budget_idx ON pa_tasks (budget_key)`,
    `ALTER TABLE pa_plan_steps ADD COLUMN task_id TEXT`,
    `ALTER TABLE pa_plan_steps ADD COLUMN completion_criteria TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS pa_plan_steps_task_idx ON pa_plan_steps (task_id)`,
  ],
];

/** Highest schema version this build can read/migrate. */
export const LATEST_SCHEMA_VERSION = migrations.length;

const SCHEMA_VERSION_KEY = "schema_version";

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pa_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`);

  const versionRow = db.all<{ value: string }>(
    "SELECT value FROM pa_meta WHERE key = ?",
    SCHEMA_VERSION_KEY,
  )[0];
  let current = versionRow === undefined ? 0 : Number(versionRow.value);

  if (versionRow === undefined) {
    // Older local builds tracked migrations with PRAGMA user_version. Seed
    // pa_meta from it so an existing database does not re-run migration 1.
    let legacy = 0;
    try {
      const legacyRow = db.all<{ user_version: number }>("PRAGMA user_version")[0];
      legacy = Number(legacyRow?.user_version ?? 0);
    } catch {
      legacy = 0;
    }
    if (Number.isFinite(legacy) && legacy > 0) {
      current = Math.min(legacy, migrations.length);
      db.run(
        `INSERT INTO pa_meta (key, value) VALUES (?, ?)`,
        SCHEMA_VERSION_KEY,
        String(current),
      );
    }
  }

  for (let index = current; index < migrations.length; index += 1) {
    const statements = migrations[index];
    if (statements === undefined) {
      throw new Error(`missing migration ${index + 1}`);
    }

    db.transaction(() => {
      for (const statement of statements) {
        db.exec(statement);
      }
      db.run(
        `INSERT INTO pa_meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        SCHEMA_VERSION_KEY,
        String(index + 1),
      );
    });
  }
}
