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
];

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
