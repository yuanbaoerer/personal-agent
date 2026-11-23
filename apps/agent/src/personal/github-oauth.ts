import { createHash, randomBytes } from "node:crypto";

import type { GitHubOAuthConfig } from "../config.ts";
import type { Db } from "../storage/db.ts";
import {
  GitHubTokenVault,
  type GitHubCredentialMetadata,
} from "./github-token-vault.ts";

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
  /** Shared with the connection service; falls back to an internal vault. */
  vault?: GitHubTokenVault;
}

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/**
 * GitHub OAuth web flow for the single local owner. OAuth tokens are encrypted
 * at rest; the raw token is never returned by status or logs.
 */
export class GitHubOAuthService {
  readonly #db: Db;
  readonly #ownerId: string;
  readonly #config: GitHubOAuthConfig;
  readonly #vault: GitHubTokenVault;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubOAuthOptions) {
    this.#db = options.db;
    this.#ownerId = options.ownerId;
    this.#config = options.config;
    this.#vault =
      options.vault ??
      new GitHubTokenVault({
        db: options.db,
        ownerId: options.ownerId,
        encryptionKey: options.config.encryptionKey,
        now: options.now,
      });
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
    this.#vault.save({
      method: "oauth",
      accountId: String(user.id),
      login: user.login,
      scopeText: scopes,
      token: tokenBody.access_token,
    });
    return {
      connected: true,
      login: user.login,
      scopes,
      updatedAt: now.toISOString(),
    };
  }

  status(): GitHubOAuthStatus {
    const stored: GitHubCredentialMetadata | undefined = this.#vault.metadata();
    if (stored === undefined || !stored.decryptable) {
      // Do not advertise a credential that the current key cannot decrypt
      // (for example after restoring a DB with a different key).
      return { connected: false };
    }
    return {
      connected: true,
      login: stored.login,
      scopes: stored.scopeText,
      updatedAt: stored.updatedAt,
    };
  }

  accessToken(): string | undefined {
    return this.#vault.accessToken();
  }

  disconnect(): boolean {
    return this.#vault.disconnect();
  }
}
