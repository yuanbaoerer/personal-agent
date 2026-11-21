const CREDENTIAL_REF = /^[a-z][a-z0-9._:-]{0,127}$/;
const CREDENTIAL_VALUE = /^(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)/i;

export class CredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

export class CredentialScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialScopeError";
  }
}

export interface CredentialInput {
  /** Static token. Prefer `provider` for OAuth tokens that rotate. */
  token?: string;
  /** Resolves the current token at call time. */
  provider?: () => string | undefined | Promise<string | undefined>;
  /** Declared scopes; an empty list means the host did not declare any. */
  scopes?: string[];
  account?: string;
  expiresAt?: string;
}

export interface CredentialSnapshot {
  ref: string;
  status: "active" | "revoked";
  version: number;
  scopes: string[];
  account?: string;
  expiresAt?: string;
}

export interface ResolvedCredential {
  ref: string;
  token: string;
  version: number;
  scopes: string[];
  account?: string;
  expiresAt?: string;
}

interface CredentialEntry {
  token?: string;
  provider?: () => string | undefined | Promise<string | undefined>;
  scopes: string[];
  account?: string;
  expiresAt?: string;
  status: "active" | "revoked";
  version: number;
}

/**
 * Owner-scoped credential references. Project bindings store only the ref;
 * the broker owns the actual secret and its rotation/revocation state. A
 * revoked or expired ref must never fall back to a global token.
 */
export class CredentialBroker {
  readonly #entries = new Map<string, CredentialEntry>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  register(ref: string, input: CredentialInput): CredentialSnapshot {
    assertRef(ref);
    const previous = this.#entries.get(ref);
    const entry: CredentialEntry = {
      ...input,
      token: input.token?.trim() === "" ? undefined : input.token,
      scopes: normalizeScopes(input.scopes),
      status: "active",
      version: (previous?.version ?? 0) + 1,
    };
    this.#entries.set(ref, entry);
    return snapshot(ref, entry);
  }

  /** Rotate the secret while keeping the ref addressable (e.g. OAuth refresh). */
  rotate(ref: string, input: CredentialInput): CredentialSnapshot {
    return this.register(ref, input);
  }

  revoke(ref: string): boolean {
    const entry = this.#entries.get(ref);
    if (entry === undefined || entry.status === "revoked") {
      return false;
    }
    entry.status = "revoked";
    entry.version += 1;
    entry.token = undefined;
    entry.provider = undefined;
    return true;
  }

  status(ref: string): CredentialSnapshot | undefined {
    const entry = this.#entries.get(ref);
    return entry === undefined ? undefined : snapshot(ref, entry);
  }

  list(): CredentialSnapshot[] {
    return [...this.#entries].map(([ref, entry]) => snapshot(ref, entry));
  }

  async resolve(
    ref: string,
    requiredScopes: readonly string[] = [],
  ): Promise<ResolvedCredential | undefined> {
    assertRef(ref);
    const entry = this.#entries.get(ref);
    if (entry === undefined || entry.status !== "active") {
      return undefined;
    }
    if (entry.expiresAt !== undefined) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime()) {
        return undefined;
      }
    }
    if (requiredScopes.length > 0 && entry.scopes.length > 0) {
      const missing = requiredScopes.filter(
        (scope) => !entry.scopes.includes(scope),
      );
      if (missing.length > 0) {
        throw new CredentialScopeError(
          `credential ${ref} is missing scope ${missing.join(",")}`,
        );
      }
    }
    let token: string | undefined;
    try {
      token =
        entry.provider === undefined ? entry.token : await entry.provider();
    } catch {
      throw new CredentialUnavailableError(
        `credential ${ref} provider failed`,
      );
    }
    if (token === undefined || token.trim().length === 0) {
      return undefined;
    }
    return {
      ref,
      token: token.trim(),
      version: entry.version,
      scopes: [...entry.scopes],
      account: entry.account,
      expiresAt: entry.expiresAt,
    };
  }
}

function assertRef(ref: string): void {
  if (!CREDENTIAL_REF.test(ref) || CREDENTIAL_VALUE.test(ref)) {
    throw new TypeError(
      "credential ref must be 1-128 lowercase letters, digits, dot, colon, underscore or dash and start with a letter",
    );
  }
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (scopes === undefined) {
    return [];
  }
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

function snapshot(ref: string, entry: CredentialEntry): CredentialSnapshot {
  return {
    ref,
    status: entry.status,
    version: entry.version,
    scopes: [...entry.scopes],
    account: entry.account,
    expiresAt: entry.expiresAt,
  };
}
