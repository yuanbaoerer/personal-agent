import { createHash } from "node:crypto";

import type { CredentialRepository } from "../storage/credentials.ts";

const CREDENTIAL_REF = /^[a-z][a-z0-9._:-]{0,127}$/;
const CREDENTIAL_VALUE = /^(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)/i;

/**
 * Scopes that only read repository data. An undeclared scope list may keep
 * using these for backward compatibility with earlier `github:default`
 * configurations. Anything else is privileged and must be declared.
 */
const READ_SCOPES = new Set([
  "repository.read",
  "metadata.read",
  "repository.metadata.read",
]);

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
  ownerId?: string;
  pluginId?: string;
  account?: string;
  /** Optional repository allow list (GitHub immutable repository ids). */
  repositoryIds?: number[];
  expiresAt?: string;
}

export interface CredentialSnapshot {
  ref: string;
  status: "active" | "revoked";
  version: number;
  scopes: string[];
  ownerId?: string;
  pluginId?: string;
  account?: string;
  repositoryIds: number[];
  expiresAt?: string;
}

export interface CredentialResolveOptions {
  /** The owner asking for the secret; must match a bound credential. */
  ownerId?: string;
  /** GitHub immutable repository id for repository-scoped credentials. */
  repositoryId?: number;
}

export interface ResolvedCredential {
  ref: string;
  token: string;
  version: number;
  scopes: string[];
  ownerId?: string;
  pluginId?: string;
  account?: string;
  repositoryIds: number[];
  expiresAt?: string;
}

interface CredentialEntry {
  token?: string;
  provider?: () => string | undefined | Promise<string | undefined>;
  scopes: string[];
  ownerId?: string;
  pluginId?: string;
  account?: string;
  repositoryIds: number[];
  expiresAt?: string;
  status: "active" | "revoked";
  version: number;
  secretFingerprint?: string;
}

/**
 * Owner-scoped credential references. Project bindings store only the ref;
 * the broker owns the actual secret and its rotation/revocation state. A
 * revoked or expired ref must never fall back to a global token.
 *
 * Non-secret metadata is persisted through `CredentialRepository` so a
 * restart keeps the same epoch. Secrets are re-attached by the host; they are
 * never written to the metadata table, Task, prompt or logs.
 */
export class CredentialBroker {
  readonly #entries = new Map<string, CredentialEntry>();
  readonly #now: () => Date;
  readonly #store?: CredentialRepository;

  constructor(now: () => Date = () => new Date(), store?: CredentialRepository) {
    this.#now = now;
    this.#store = store;
    if (store !== undefined) {
      for (const metadata of store.list()) {
        this.#entries.set(metadata.ref, {
          scopes: [...metadata.scopes],
          ...(metadata.ownerId === undefined ? {} : { ownerId: metadata.ownerId }),
          ...(metadata.pluginId === undefined ? {} : { pluginId: metadata.pluginId }),
          ...(metadata.account === undefined ? {} : { account: metadata.account }),
          repositoryIds: [...metadata.repositoryIds],
          ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
          ...(metadata.secretFingerprint === undefined
            ? {}
            : { secretFingerprint: metadata.secretFingerprint }),
          status: metadata.status,
          version: metadata.version,
        });
      }
    }
  }

  /**
   * Explicit registration or rotation by the host. Always activates the ref
   * and increments the epoch so approvals bound to the previous version
   * become stale.
   */
  register(ref: string, input: CredentialInput): CredentialSnapshot {
    assertRef(ref);
    const previous = this.#entries.get(ref);
    const normalized = normalizeInput(input);
    if (previous !== undefined && previous.status === "active" && sameMetadata(previous, normalized)) {
      // Re-registering an unchanged credential is an attach, not a rotation.
      this.#attach(ref, previous, normalized);
      return snapshot(ref, previous);
    }
    const entry: CredentialEntry = {
      ...normalized,
      token: normalized.token?.trim() === "" ? undefined : normalized.token,
      status: "active",
      version: (previous?.version ?? 0) + 1,
    };
    this.#entries.set(ref, entry);
    this.#persist(ref, entry);
    return snapshot(ref, entry);
  }

  /** Rotate the secret while keeping the ref addressable (e.g. OAuth refresh). */
  rotate(ref: string, input: CredentialInput, now?: Date): CredentialSnapshot {
    assertRef(ref);
    const previous = this.#entries.get(ref);
    const at = now ?? this.#now();
    const entry: CredentialEntry = {
      ...normalizeInput(input),
      token: input.token?.trim() === "" ? undefined : input.token,
      status: "active",
      version: (previous?.version ?? 0) + 1,
    };
    this.#entries.set(ref, entry);
    this.#persist(ref, entry, at);
    return snapshot(ref, entry);
  }

  /**
   * Startup recovery: keep the persisted epoch and revocation state. A
   * revoked ref stays revoked even when the host still has a token. Changed
   * metadata is a rotation, not a silent rewrite.
   */
  restore(ref: string, input: CredentialInput): CredentialSnapshot {
    assertRef(ref);
    const stored = this.#entries.get(ref);
    if (stored === undefined) {
      return this.register(ref, input);
    }
    const normalized = normalizeInput(input);
    if (stored.status === "revoked") {
      return snapshot(ref, stored);
    }
    if (!sameMetadata(stored, normalized)) {
      return this.rotate(ref, input);
    }
    this.#attach(ref, stored, normalized);
    return snapshot(ref, stored);
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
    this.#persist(ref, entry);
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
    options: CredentialResolveOptions = {},
  ): Promise<ResolvedCredential | undefined> {
    assertRef(ref);
    const entry = this.#entries.get(ref);
    if (entry === undefined || entry.status !== "active") {
      return undefined;
    }
    if (entry.ownerId !== undefined) {
      if (options.ownerId !== entry.ownerId) {
        throw new CredentialScopeError(
          `credential ${ref} is not owned by the requesting owner`,
        );
      }
    }
    if (
      entry.repositoryIds.length > 0 &&
      (options.repositoryId === undefined ||
        !entry.repositoryIds.includes(options.repositoryId))
    ) {
      throw new CredentialScopeError(
        `credential ${ref} is not bound to the requested repository`,
      );
    }
    if (entry.expiresAt !== undefined) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime()) {
        return undefined;
      }
    }
    assertScopes(ref, entry.scopes, requiredScopes);
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
      ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
      ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
      ...(entry.account === undefined ? {} : { account: entry.account }),
      repositoryIds: [...entry.repositoryIds],
      expiresAt: entry.expiresAt,
    };
  }

  #attach(ref: string, entry: CredentialEntry, input: CredentialEntry): void {
    entry.token = input.token?.trim() === "" ? undefined : input.token;
    entry.provider = input.provider;
    this.#persist(ref, entry);
  }

  #persist(ref: string, entry: CredentialEntry, at?: Date): void {
    this.#store?.upsert({
      ref,
      scopes: [...entry.scopes],
      repositoryIds: [...entry.repositoryIds],
      status: entry.status,
      version: entry.version,
      ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
      ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
      ...(entry.account === undefined ? {} : { account: entry.account }),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.secretFingerprint === undefined
        ? {}
        : { secretFingerprint: entry.secretFingerprint }),
      updatedAt: (at ?? this.#now()).toISOString(),
    });
  }
}

/**
 * Undeclared scopes keep legacy read-only credentials working. Any scope
 * outside the read set requires an explicit declaration, so a write token is
 * never inherited from a credential whose permission was never stated.
 */
function assertScopes(
  ref: string,
  declared: readonly string[],
  required: readonly string[],
): void {
  if (required.length === 0) {
    return;
  }
  if (declared.length === 0) {
    const privileged = required.filter((scope) => !READ_SCOPES.has(scope));
    if (privileged.length > 0) {
      throw new CredentialScopeError(
        `credential ${ref} has no declared scopes; ${privileged.join(",")} requires an explicit declaration`,
      );
    }
    return;
  }
  const missing = required.filter((scope) => !declared.includes(scope));
  if (missing.length > 0) {
    throw new CredentialScopeError(
      `credential ${ref} is missing scope ${missing.join(",")}`,
    );
  }
}

function assertRef(ref: string): void {
  if (!CREDENTIAL_REF.test(ref) || CREDENTIAL_VALUE.test(ref)) {
    throw new TypeError(
      "credential ref must be 1-128 lowercase letters, digits, dot, colon, underscore or dash and start with a letter",
    );
  }
}

function normalizeInput(input: CredentialInput): CredentialEntry {
  return {
    token: input.token,
    provider: input.provider,
    scopes: normalizeScopes(input.scopes),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
    ...(input.account === undefined ? {} : { account: input.account }),
    repositoryIds: normalizeRepositoryIds(input.repositoryIds),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.token === undefined
      ? {}
      : {
          secretFingerprint: createHash("sha256")
            .update(input.token)
            .digest("hex")
            .slice(0, 16),
        }),
    status: "active",
    version: 0,
  };
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (scopes === undefined) {
    return [];
  }
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

function normalizeRepositoryIds(ids: number[] | undefined): number[] {
  if (ids === undefined) {
    return [];
  }
  return [
    ...new Set(
      ids.filter(
        (id) => Number.isSafeInteger(id) && id > 0,
      ),
    ),
  ];
}

function sameMetadata(left: CredentialEntry, right: CredentialEntry): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.pluginId === right.pluginId &&
    left.account === right.account &&
    left.expiresAt === right.expiresAt &&
    left.secretFingerprint === right.secretFingerprint &&
    sameList(left.scopes, right.scopes) &&
    sameList(left.repositoryIds, right.repositoryIds)
  );
}

function sameList(left: readonly string[] | readonly number[], right: readonly string[] | readonly number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].map(String).sort();
  const b = [...right].map(String).sort();
  return a.every((value, index) => value === b[index]);
}

function snapshot(ref: string, entry: CredentialEntry): CredentialSnapshot {
  return {
    ref,
    status: entry.status,
    version: entry.version,
    scopes: [...entry.scopes],
    ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
    ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
    ...(entry.account === undefined ? {} : { account: entry.account }),
    repositoryIds: [...entry.repositoryIds],
    expiresAt: entry.expiresAt,
  };
}
