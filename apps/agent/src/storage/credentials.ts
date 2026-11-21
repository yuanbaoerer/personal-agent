import type { Db } from "./db.ts";

export type CredentialStatus = "active" | "revoked";

/**
 * Non-secret credential metadata. The secret itself stays in the OAuth vault
 * or the process environment; this table only binds a stable ref to its
 * owner, plugin, account, scopes, repository ids and epoch.
 */
export interface CredentialMetadata {
  ref: string;
  ownerId?: string;
  pluginId?: string;
  account?: string;
  scopes: string[];
  repositoryIds: number[];
  status: CredentialStatus;
  version: number;
  expiresAt?: string;
  /** Hash of a static token; never the token itself. */
  secretFingerprint?: string;
  updatedAt: string;
}

export interface CredentialMetadataInput {
  ref: string;
  ownerId?: string;
  pluginId?: string;
  account?: string;
  scopes: string[];
  repositoryIds?: number[];
  status: CredentialStatus;
  version: number;
  expiresAt?: string;
  secretFingerprint?: string;
  updatedAt: string;
}

interface CredentialRow {
  ref: string;
  owner_id: string | null;
  plugin_id: string | null;
  account: string | null;
  scopes_json: string;
  repository_ids_json: string;
  status: CredentialStatus;
  version: number;
  expires_at: string | null;
  secret_fingerprint: string | null;
  updated_at: string;
}

export class CredentialRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): CredentialMetadata[] {
    return this.#db
      .all<CredentialRow>(
        "SELECT * FROM pa_credential_refs ORDER BY ref ASC",
      )
      .map(mapCredential);
  }

  get(ref: string): CredentialMetadata | undefined {
    const row = this.#db.all<CredentialRow>(
      "SELECT * FROM pa_credential_refs WHERE ref = ?",
      ref,
    )[0];
    return row === undefined ? undefined : mapCredential(row);
  }

  upsert(input: CredentialMetadataInput): void {
    this.#db.run(
      `INSERT INTO pa_credential_refs
        (ref, owner_id, plugin_id, account, scopes_json, repository_ids_json,
         status, version, expires_at, secret_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ref) DO UPDATE SET
         owner_id = excluded.owner_id,
         plugin_id = excluded.plugin_id,
         account = excluded.account,
         scopes_json = excluded.scopes_json,
         repository_ids_json = excluded.repository_ids_json,
         status = excluded.status,
         version = excluded.version,
         expires_at = excluded.expires_at,
         secret_fingerprint = excluded.secret_fingerprint,
         updated_at = excluded.updated_at`,
      input.ref,
      input.ownerId ?? null,
      input.pluginId ?? null,
      input.account ?? null,
      JSON.stringify(input.scopes),
      JSON.stringify(input.repositoryIds ?? []),
      input.status,
      input.version,
      input.expiresAt ?? null,
      input.secretFingerprint ?? null,
      input.updatedAt,
    );
  }
}

function mapCredential(row: CredentialRow): CredentialMetadata {
  return {
    ref: row.ref,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...(row.plugin_id === null ? {} : { pluginId: row.plugin_id }),
    ...(row.account === null ? {} : { account: row.account }),
    scopes: parseStringArray(row.scopes_json),
    repositoryIds: parseNumberArray(row.repository_ids_json),
    status: row.status,
    version: Number(row.version),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.secret_fingerprint === null
      ? {}
      : { secretFingerprint: row.secret_fingerprint }),
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is number =>
            typeof item === "number" && Number.isSafeInteger(item) && item > 0,
        )
      : [];
  } catch {
    return [];
  }
}
