import type { CredentialBroker } from "../actions/credentials.ts";
import type { PluginConnection } from "../plugins/types.ts";
import type { Store } from "../storage/store.ts";
import type { GitHubOAuthService } from "./github-oauth.ts";
import type {
  GitHubAuthMethod,
  GitHubTokenVault,
} from "./github-token-vault.ts";

const GITHUB_USER_URL = "https://api.github.com/user";
const CREDENTIAL_REF = "github:default";
const APP_SCOPES = ["repository.read"] as const;

export type GitHubConnectionStatus =
  | "unconfigured"
  | "connected"
  | "expired"
  | "revoked"
  | "reauth_required"
  | "error";

export type GitHubConnectionErrorCode =
  | "setup_required"
  | "oauth_not_configured"
  | "encryption_key_missing"
  | "reauth_required"
  | "invalid_token"
  | "github_unavailable"
  | "not_connected"
  | "oauth_failed";

export class GitHubConnectionError extends Error {
  readonly code: GitHubConnectionErrorCode;

  constructor(code: GitHubConnectionErrorCode, message: string) {
    super(message);
    this.name = "GitHubConnectionError";
    this.code = code;
  }
}

export interface GitHubConnectionView {
  id: "github";
  ownerId: string;
  pluginId: "github";
  credentialRef: string;
  authMethod?: GitHubAuthMethod;
  accountId?: string;
  accountLogin?: string;
  credentialVersion?: number;
  status: GitHubConnectionStatus;
  /** App-level scopes enforced by the credential broker. */
  scopes: string[];
  repositoryIds: number[];
  /** Provider scopes reported by GitHub; display/diagnostic only. */
  githubScopes?: string[];
  oauthConfigured: boolean;
  encryptionConfigured: boolean;
  envPatConfigured: boolean;
  updatedAt?: string;
  detail?: string;
}

export interface GitHubIdentity {
  accountId: string;
  login: string;
  scopes: string[];
}

export interface GitHubConnectionChange {
  event: "connected" | "disconnected";
  authMethod?: GitHubAuthMethod;
  actorId: string;
  credentialVersion: number;
}

export interface GitHubConnectionOptions {
  store: Store;
  ownerId: string;
  credentials: CredentialBroker;
  vault?: GitHubTokenVault;
  oauth?: Pick<GitHubOAuthService, "start" | "complete" | "status">;
  oauthConfigured: boolean;
  envPatConfigured: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  onChange?: (change: GitHubConnectionChange) => void | Promise<void>;
}

/**
 * Thin owner-facing GitHub connection contract. It composes the existing
 * OAuth service, encrypted vault and credential broker; it does not create a
 * second token store or grant repository/task permissions by itself.
 */
export class GitHubConnectionService {
  readonly #store: Store;
  readonly #ownerId: string;
  readonly #credentials: CredentialBroker;
  readonly #vault?: GitHubTokenVault;
  readonly #oauth?: Pick<GitHubOAuthService, "start" | "complete" | "status">;
  readonly #oauthConfigured: boolean;
  readonly #envPatConfigured: boolean;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #onChange?: GitHubConnectionOptions["onChange"];

  constructor(options: GitHubConnectionOptions) {
    this.#store = options.store;
    this.#ownerId = options.ownerId;
    this.#credentials = options.credentials;
    this.#vault = options.vault;
    this.#oauth = options.oauth;
    this.#oauthConfigured = options.oauthConfigured;
    this.#envPatConfigured = options.envPatConfigured;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange;
  }

  status(): GitHubConnectionView {
    const stored = this.#vault?.metadata();
    const credential = this.#credentials.status(CREDENTIAL_REF);
    const encryptionConfigured = this.#vault?.configured === true;
    const base = {
      id: "github" as const,
      ownerId: this.#ownerId,
      pluginId: "github" as const,
      credentialRef: CREDENTIAL_REF,
      oauthConfigured: this.#oauthConfigured,
      encryptionConfigured,
      envPatConfigured: this.#envPatConfigured,
      repositoryIds: [...(credential?.repositoryIds ?? [])],
      ...(credential?.version === undefined
        ? {}
        : { credentialVersion: credential.version }),
    };

    if (stored !== undefined) {
      const expired =
        credential?.expiresAt !== undefined &&
        Date.parse(credential.expiresAt) <= this.#now().getTime();
      const status: GitHubConnectionStatus = !stored.decryptable
        ? "reauth_required"
        : credential?.status === "revoked"
          ? "revoked"
          : expired
            ? "expired"
            : "connected";
      return {
        ...base,
        authMethod: stored.method,
        accountId: stored.accountId,
        accountLogin: stored.login,
        status,
        scopes: [...(credential?.scopes ?? APP_SCOPES)],
        githubScopes: splitScopes(stored.scopeText),
        updatedAt: stored.updatedAt,
        ...(status === "reauth_required"
          ? { detail: "stored credential cannot be decrypted by the configured key; reconnect" }
          : {}),
        ...(status === "revoked"
          ? { detail: "local connection was revoked; authorize again to reconnect" }
          : {}),
      };
    }

    if (credential?.status === "revoked") {
      return {
        ...base,
        status: "revoked",
        scopes: [...credential.scopes],
        detail: "local connection was revoked; authorize again to reconnect",
      };
    }

    if (this.#envPatConfigured) {
      if (credential === undefined) {
        return {
          ...base,
          authMethod: "pat",
          status: "error",
          scopes: [...APP_SCOPES],
          detail: "environment PAT is configured but the credential broker has no entry",
        };
      }
      return {
        ...base,
        authMethod: "pat",
        status: "connected",
        scopes: [...credential.scopes],
        detail: "connected through GITHUB_TOKEN",
      };
    }

    if (credential !== undefined) {
      return {
        ...base,
        status: "error",
        scopes: [...credential.scopes],
        detail: "credential broker has an entry but no token source is available",
      };
    }

    return {
      ...base,
      status: "unconfigured",
      scopes: [...APP_SCOPES],
      detail:
        !encryptionConfigured && !this.#oauthConfigured
          ? "configure GitHub OAuth or an encryption key for PAT login"
          : "not connected",
    };
  }

  /** Owner-facing plugin status uses the same view; never includes a token. */
  pluginConnection(): PluginConnection {
    const view = this.status();
    const status =
      view.status === "connected"
        ? "connected"
        : view.status === "revoked"
          ? "revoked"
          : view.status === "expired"
            ? "expired"
            : view.status === "unconfigured"
              ? "unconfigured"
              : "error";
    return {
      status,
      ...(view.accountLogin === undefined
        ? {}
        : { account: view.accountLogin }),
      scopes: [...view.scopes],
      detail: [
        view.authMethod ?? "unknown",
        view.credentialVersion === undefined
          ? undefined
          : `epoch ${view.credentialVersion}`,
        view.detail,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" · "),
    };
  }

  beginOAuth(): { authorizeUrl: string } {
    if (this.#oauth === undefined || !this.#oauthConfigured) {
      throw new GitHubConnectionError(
        "oauth_not_configured",
        "GitHub OAuth is not configured; set GITHUB_OAUTH_CLIENT_ID/SECRET or use a PAT",
      );
    }
    return { authorizeUrl: this.#oauth.start() };
  }

  async completeOAuth(
    code: string,
    state: string,
    actorId = "owner",
  ): Promise<GitHubConnectionView> {
    if (this.#oauth === undefined || !this.#oauthConfigured) {
      throw new GitHubConnectionError(
        "oauth_not_configured",
        "GitHub OAuth is not configured",
      );
    }
    try {
      await this.#oauth.complete(code, state);
    } catch (error) {
      throw new GitHubConnectionError(
        "oauth_failed",
        error instanceof Error ? error.message : "GitHub OAuth failed",
      );
    }
    return this.#applyStoredCredential(actorId);
  }

  async connectPat(
    input: { token: string; repositoryIds?: number[] },
    actorId = "owner",
  ): Promise<GitHubConnectionView> {
    if (this.#vault === undefined || !this.#vault.configured) {
      throw new GitHubConnectionError(
        "encryption_key_missing",
        "PAT login needs GITHUB_CONNECTION_ENCRYPTION_KEY (or GITHUB_OAUTH_ENCRYPTION_KEY)",
      );
    }
    const token = input.token.trim();
    if (token.length === 0) {
      throw new GitHubConnectionError("invalid_token", "token must not be empty");
    }
    const identity = await fetchGitHubIdentity(token, this.#fetch);
    this.#vault.save({
      method: "pat",
      accountId: identity.accountId,
      login: identity.login,
      scopeText: identity.scopes.join(","),
      token,
    });
    return this.#applyStoredCredential(actorId, input.repositoryIds);
  }

  async disconnect(actorId = "owner"): Promise<{
    disconnected: boolean;
    remoteRevoked: false;
    connection: GitHubConnectionView;
  }> {
    const removed = this.#vault?.disconnect() ?? false;
    const revoked = this.#credentials.revoke(CREDENTIAL_REF);
    const changed = removed || revoked;
    if (changed) {
      this.#audit("github.connection_disconnected", actorId, {
        credentialRef: CREDENTIAL_REF,
        storageRemoved: removed,
        brokerRevoked: revoked,
        remoteRevoked: false,
      });
      await this.#onChange?.({
        event: "disconnected",
        actorId,
        credentialVersion: this.#credentials.status(CREDENTIAL_REF)?.version ?? 0,
      });
    }
    return {
      disconnected: changed,
      remoteRevoked: false,
      connection: this.status(),
    };
  }

  async #applyStoredCredential(
    actorId: string,
    repositoryIds?: number[],
  ): Promise<GitHubConnectionView> {
    const stored = this.#vault?.metadata();
    if (stored === undefined || !stored.decryptable) {
      throw new GitHubConnectionError(
        "reauth_required",
        "stored credential is unavailable",
      );
    }
    const existing = this.#credentials.status(CREDENTIAL_REF);
    const input = {
      provider: () => this.#vault?.accessToken(),
      scopes: [...APP_SCOPES],
      ownerId: this.#ownerId,
      pluginId: "github",
      account: stored.login,
      repositoryIds: repositoryIds ?? existing?.repositoryIds ?? [],
    };
    if (existing === undefined) {
      this.#credentials.register(CREDENTIAL_REF, input);
    } else {
      this.#credentials.rotate(CREDENTIAL_REF, input);
    }
    const credential = this.#credentials.status(CREDENTIAL_REF);
    this.#audit("github.connection_connected", actorId, {
      credentialRef: CREDENTIAL_REF,
      authMethod: stored.method,
      accountId: stored.accountId,
      accountLogin: stored.login,
      credentialVersion: credential?.version,
      scopes: [...APP_SCOPES],
      repositoryIds: input.repositoryIds,
    });
    await this.#onChange?.({
      event: "connected",
      authMethod: stored.method,
      actorId,
      credentialVersion: credential?.version ?? 0,
    });
    return this.status();
  }

  #audit(
    event: string,
    actorId: string,
    after: Record<string, unknown>,
  ): void {
    this.#store.recordAudit({
      event,
      actorId,
      subjectType: "credential",
      subjectId: CREDENTIAL_REF,
      after,
      traceId: "github:connection",
      occurredAt: this.#now().toISOString(),
    });
  }
}

async function fetchGitHubIdentity(
  token: string,
  fetchImpl: typeof fetch,
): Promise<GitHubIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "personal-agent",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubConnectionError(
      "github_unavailable",
      "GitHub identity lookup failed; check the network and try again",
    );
  }
  if (response.status === 401) {
    throw new GitHubConnectionError(
      "invalid_token",
      "GitHub rejected the token (401); it may be invalid or expired",
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new GitHubConnectionError(
      "github_unavailable",
      `GitHub identity lookup was rate limited or forbidden (${response.status})`,
    );
  }
  if (!response.ok) {
    throw new GitHubConnectionError(
      "github_unavailable",
      `GitHub identity lookup failed (${response.status})`,
    );
  }
  let body: { id?: unknown; login?: unknown };
  try {
    body = (await response.json()) as { id?: unknown; login?: unknown };
  } catch {
    throw new GitHubConnectionError(
      "github_unavailable",
      "GitHub identity response was not JSON",
    );
  }
  if (
    (typeof body.id !== "number" && typeof body.id !== "string") ||
    typeof body.login !== "string" ||
    body.login.trim().length === 0
  ) {
    throw new GitHubConnectionError(
      "github_unavailable",
      "GitHub identity response is missing id/login",
    );
  }
  return {
    accountId: String(body.id),
    login: body.login,
    scopes: splitScopes(response.headers.get("x-oauth-scopes") ?? ""),
  };
}

function splitScopes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  ];
}
