import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Db } from "../storage/db.ts";

export type GitHubAuthMethod = "pat" | "oauth";

export class GitHubVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubVaultError";
  }
}

/** Non-secret connection metadata. The token itself is never exposed here. */
export interface GitHubCredentialMetadata {
  method: GitHubAuthMethod;
  accountId: string;
  login: string;
  /** Provider scopes exactly as GitHub returned them (may be empty for PATs). */
  scopeText: string;
  updatedAt: string;
  /** False when the configured key cannot decrypt the stored token. */
  decryptable: boolean;
}

export interface GitHubStoredCredential extends GitHubCredentialMetadata {
  token: string;
}

export interface GitHubCredentialInput {
  method: GitHubAuthMethod;
  accountId: string;
  login: string;
  scopeText: string;
  token: string;
}

interface CredentialRow {
  owner_id: string;
  github_user_id: string;
  login: string;
  scopes: string;
  token_ciphertext: string;
  auth_method: GitHubAuthMethod | null;
  created_at: string;
  updated_at: string;
}

function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new GitHubVaultError(
      "GitHub encryption key must be 32 bytes encoded as base64 or 64 hex characters",
    );
  }
  return key;
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptToken(value: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, dataRaw] = value.split(":");
  if (version !== "v1" || ivRaw === undefined || tagRaw === undefined || dataRaw === undefined) {
    throw new GitHubVaultError("unsupported GitHub credential encoding");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Owner-scoped encrypted GitHub credential vault. It reuses the existing
 * `pa_github_credentials` row (no parallel token store) and only keeps
 * non-secret connection metadata outside the ciphertext.
 */
export class GitHubTokenVault {
  readonly #db: Db;
  readonly #ownerId: string;
  readonly #key?: Buffer;
  readonly #now: () => Date;

  constructor(options: {
    db: Db;
    ownerId: string;
    encryptionKey?: string;
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#ownerId = options.ownerId;
    this.#key =
      options.encryptionKey === undefined
        ? undefined
        : parseEncryptionKey(options.encryptionKey);
    this.#now = options.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.#key !== undefined;
  }

  /** Metadata only; never decrypts or returns the token. */
  metadata(): GitHubCredentialMetadata | undefined {
    const row = this.#row();
    if (row === undefined) {
      return undefined;
    }
    return {
      method: this.#method(row),
      accountId: row.github_user_id,
      login: row.login,
      scopeText: row.scopes,
      updatedAt: row.updated_at,
      decryptable: this.#canDecrypt(row),
    };
  }

  /** The stored token, or undefined when no credential exists. */
  load(): GitHubStoredCredential | undefined {
    const row = this.#row();
    if (row === undefined) {
      return undefined;
    }
    if (this.#key === undefined) {
      throw new GitHubVaultError("GitHub encryption key is not configured");
    }
    let token: string;
    try {
      token = decryptToken(row.token_ciphertext, this.#key);
    } catch {
      throw new GitHubVaultError(
        "stored GitHub credential cannot be decrypted with the configured key",
      );
    }
    return {
      method: this.#method(row),
      accountId: row.github_user_id,
      login: row.login,
      scopeText: row.scopes,
      updatedAt: row.updated_at,
      decryptable: true,
      token,
    };
  }

  accessToken(): string | undefined {
    return this.load()?.token;
  }

  save(input: GitHubCredentialInput): GitHubCredentialMetadata {
    if (this.#key === undefined) {
      throw new GitHubVaultError("GitHub encryption key is not configured");
    }
    const token = input.token.trim();
    if (token.length === 0) {
      throw new GitHubVaultError("GitHub token must not be empty");
    }
    const now = this.#now().toISOString();
    this.#db.run(
      `INSERT INTO pa_github_credentials
        (owner_id, github_user_id, login, scopes, token_ciphertext, auth_method,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET
         github_user_id = excluded.github_user_id,
         login = excluded.login,
         scopes = excluded.scopes,
         token_ciphertext = excluded.token_ciphertext,
         auth_method = excluded.auth_method,
         updated_at = excluded.updated_at`,
      this.#ownerId,
      input.accountId,
      input.login,
      input.scopeText,
      encryptToken(token, this.#key),
      input.method,
      now,
      now,
    );
    const metadata = this.metadata();
    if (metadata === undefined) {
      throw new GitHubVaultError("GitHub credential was not persisted");
    }
    return metadata;
  }

  disconnect(): boolean {
    return (
      this.#db.run(
        "DELETE FROM pa_github_credentials WHERE owner_id = ?",
        this.#ownerId,
      ) > 0
    );
  }

  #row(): CredentialRow | undefined {
    return this.#db.all<CredentialRow>(
      "SELECT * FROM pa_github_credentials WHERE owner_id = ?",
      this.#ownerId,
    )[0];
  }

  #method(row: CredentialRow): GitHubAuthMethod {
    return row.auth_method === "pat" ? "pat" : "oauth";
  }

  #canDecrypt(row: CredentialRow): boolean {
    if (this.#key === undefined) {
      return false;
    }
    try {
      decryptToken(row.token_ciphertext, this.#key);
      return true;
    } catch {
      return false;
    }
  }
}
