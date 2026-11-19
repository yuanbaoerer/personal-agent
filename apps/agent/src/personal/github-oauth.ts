import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { GitHubOAuthConfig } from "../config.ts";
import type { Db } from "../storage/db.ts";

const STATE_TTL_MS = 10 * 60_000;
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export class GitHubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

export interface GitHubOAuthStatus {
  connected: boolean;
  login?: string;
  scopes?: string;
  updatedAt?: string;
}

export interface GitHubOAuthOptions {
  db: Db;
  ownerId: string;
  config: GitHubOAuthConfig;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface CredentialRow {
  owner_id: string;
  github_user_id: string;
  login: string;
  scopes: string;
  token_ciphertext: string;
  created_at: string;
  updated_at: string;
}

function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new GitHubOAuthError(
      "GITHUB_OAUTH_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters",
    );
  }
  return key;
}

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptToken(value: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, dataRaw] = value.split(":");
  if (version !== "v1" || ivRaw === undefined || tagRaw === undefined || dataRaw === undefined) {
    throw new GitHubOAuthError("unsupported GitHub credential encoding");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * GitHub OAuth web flow for the single local owner. OAuth tokens are encrypted
 * at rest; the raw token is never returned by status or logs.
 */
export class GitHubOAuthService {
  readonly #db: Db;
  readonly #ownerId: string;
  readonly #config: GitHubOAuthConfig;
  readonly #key: Buffer;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubOAuthOptions) {
    this.#db = options.db;
    this.#ownerId = options.ownerId;
    this.#config = options.config;
    this.#key = parseEncryptionKey(options.config.encryptionKey);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  start(): string {
    const now = this.#now();
    const state = randomBytes(32).toString("base64url");
    this.#db.run(
      `DELETE FROM pa_github_oauth_states
       WHERE expires_at <= ? OR used_at IS NOT NULL`,
      now.toISOString(),
    );
    this.#db.run(
      `INSERT INTO pa_github_oauth_states
        (state_hash, owner_id, expires_at, used_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
      stateHash(state),
      this.#ownerId,
      new Date(now.getTime() + STATE_TTL_MS).toISOString(),
      now.toISOString(),
    );
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", this.#config.redirectUri);
    url.searchParams.set("scope", this.#config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return url.toString();
  }

  async complete(code: string, state: string): Promise<GitHubOAuthStatus> {
    const now = this.#now();
    const consumed = this.#db.all<{ owner_id: string }>(
      `UPDATE pa_github_oauth_states
       SET used_at = ?
       WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
       RETURNING owner_id`,
      now.toISOString(),
      stateHash(state),
      now.toISOString(),
    )[0];
    if (consumed === undefined || consumed.owner_id !== this.#ownerId) {
      throw new GitHubOAuthError("OAuth state is invalid, expired, or already used");
    }

    const tokenResponse = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "personal-agent",
      },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        code,
        redirect_uri: this.#config.redirectUri,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = (await tokenResponse.json()) as {
      access_token?: unknown;
      token_type?: unknown;
      scope?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") {
      throw new GitHubOAuthError(
        `GitHub token exchange failed: ${String(tokenBody.error_description ?? tokenBody.error ?? tokenResponse.status)}`,
      );
    }

    const userResponse = await this.#fetch(USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenBody.access_token}`,
        "user-agent": "personal-agent",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) {
      throw new GitHubOAuthError(`GitHub user lookup failed: ${userResponse.status}`);
    }
    const user = (await userResponse.json()) as { id?: unknown; login?: unknown };
    if (
      (typeof user.id !== "number" && typeof user.id !== "string") ||
      typeof user.login !== "string"
    ) {
      throw new GitHubOAuthError("GitHub user response is missing id/login");
    }

    const scopes =
      typeof tokenBody.scope === "string"
        ? tokenBody.scope
        : this.#config.scopes.join(" ");
    this.#db.run(
      `INSERT INTO pa_github_credentials
        (owner_id, github_user_id, login, scopes, token_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET
         github_user_id = excluded.github_user_id,
         login = excluded.login,
         scopes = excluded.scopes,
         token_ciphertext = excluded.token_ciphertext,
         updated_at = excluded.updated_at`,
      this.#ownerId,
      String(user.id),
      user.login,
      scopes,
      encryptToken(tokenBody.access_token, this.#key),
      now.toISOString(),
      now.toISOString(),
    );
    return {
      connected: true,
      login: user.login,
      scopes,
      updatedAt: now.toISOString(),
    };
  }

  status(): GitHubOAuthStatus {
    const row = this.#db.all<CredentialRow>(
      "SELECT * FROM pa_github_credentials WHERE owner_id = ?",
      this.#ownerId,
    )[0];
    if (row === undefined) {
      return { connected: false };
    }
    try {
      // Do not advertise a credential that the current key cannot decrypt
      // (for example after restoring a DB with a different key).
      decryptToken(row.token_ciphertext, this.#key);
    } catch {
      return { connected: false };
    }
    return {
      connected: true,
      login: row.login,
      scopes: row.scopes,
      updatedAt: row.updated_at,
    };
  }

  accessToken(): string | undefined {
    const row = this.#db.all<CredentialRow>(
      "SELECT * FROM pa_github_credentials WHERE owner_id = ?",
      this.#ownerId,
    )[0];
    return row === undefined ? undefined : decryptToken(row.token_ciphertext, this.#key);
  }

  disconnect(): boolean {
    return this.#db.run(
      "DELETE FROM pa_github_credentials WHERE owner_id = ?",
      this.#ownerId,
    ) > 0;
  }
}
