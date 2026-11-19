import { randomUUID } from "node:crypto";

import type { Db } from "./db.ts";

export const CLIENT_SCOPES = ["read", "write", "approve"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

export interface ClientTokenRecord {
  id: string;
  ownerId: string;
  name: string;
  scopes: ClientScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

interface ClientTokenRow {
  id: string;
  owner_id: string;
  name: string;
  token_hash: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

function parseScopes(raw: string): ClientScope[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (scope): scope is ClientScope =>
      typeof scope === "string" &&
      (CLIENT_SCOPES as readonly string[]).includes(scope),
  );
}

function mapToken(row: ClientTokenRow): ClientTokenRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

export class ClientTokenRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: {
    ownerId: string;
    name: string;
    tokenHash: string;
    scopes: ClientScope[];
    createdAt: string;
    expiresAt?: string;
  }): ClientTokenRecord {
    const row = this.#db.all<ClientTokenRow>(
      `INSERT INTO pa_client_tokens
        (id, owner_id, name, token_hash, scopes_json, created_at, last_used_at, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       RETURNING *`,
      randomUUID(),
      input.ownerId,
      input.name,
      input.tokenHash,
      JSON.stringify(input.scopes),
      input.createdAt,
      input.expiresAt ?? null,
    )[0];
    if (row === undefined) {
      throw new Error("client token was not inserted");
    }
    return mapToken(row);
  }

  /** Active token lookup by hash; revoked/unknown tokens return undefined. */
  findByHash(tokenHash: string): ClientTokenRecord | undefined {
    const row = this.#db.all<ClientTokenRow>(
      `SELECT * FROM pa_client_tokens
       WHERE token_hash = ? AND revoked_at IS NULL`,
      tokenHash,
    )[0];
    return row === undefined ? undefined : mapToken(row);
  }

  listByOwner(ownerId: string): ClientTokenRecord[] {
    return this.#db
      .all<ClientTokenRow>(
        `SELECT * FROM pa_client_tokens
         WHERE owner_id = ?
         ORDER BY created_at DESC`,
        ownerId,
      )
      .map(mapToken);
  }

  touch(id: string, at: string): void {
    this.#db.run(
      `UPDATE pa_client_tokens SET last_used_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      at,
      id,
    );
  }

  revoke(id: string, ownerId: string, at: string): boolean {
    return (
      this.#db.run(
        `UPDATE pa_client_tokens SET revoked_at = ?
         WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`,
        at,
        id,
        ownerId,
      ) > 0
    );
  }
}
