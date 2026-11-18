import type { PreauthorizationRecord } from "../domain/types.ts";
import type { PreauthorizationRepository } from "../storage/preauthorizations.ts";
import type { Store } from "../storage/store.ts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class PreauthorizationService {
  readonly #store: Store;
  readonly #preauthorizations: PreauthorizationRepository;
  readonly #allowedRepos: Set<string>;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(deps: {
    store: Store;
    preauthorizations: PreauthorizationRepository;
    allowedRepos: readonly string[];
    now?: () => Date;
    ttlMs?: number;
  }) {
    this.#store = deps.store;
    this.#preauthorizations = deps.preauthorizations;
    this.#allowedRepos = new Set(deps.allowedRepos.map((repo) => repo.toLowerCase()));
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.ttlMs ?? 24 * 60 * 60_000;
  }

  grant(
    ownerId: string,
    repoInput: string,
  ): { ok: true; grant: PreauthorizationRecord } | { ok: false; reason: string } {
    const repo = repoInput.trim().toLowerCase();
    if (!REPO_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
      return { ok: false, reason: "仓库格式应为 owner/name。" };
    }
    if (!this.#allowedRepos.has(repo)) {
      return { ok: false, reason: "仓库不在 GITHUB_ALLOWED_REPOS 白名单内。" };
    }
    const now = this.#now();
    const grant = this.#preauthorizations.upsert({
      ownerId,
      tool: "github.read",
      repo,
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      now: now.toISOString(),
    });
    this.#store.recordAudit({
      event: "preauthorization.granted",
      subjectType: "preauthorization",
      subjectId: grant.id,
      after: { tool: grant.tool, repo: grant.repo, expiresAt: grant.expiresAt },
      traceId: `preauth:${grant.id}`,
      occurredAt: now.toISOString(),
    });
    return { ok: true, grant };
  }

  revoke(
    ownerId: string,
    repoInput: string,
  ): { ok: boolean; repo: string } {
    const repo = repoInput.trim().toLowerCase();
    const now = this.#now().toISOString();
    const ok = this.#preauthorizations.revoke(ownerId, "github.read", repo, now);
    if (ok) {
      this.#store.recordAudit({
        event: "preauthorization.revoked",
        subjectType: "preauthorization",
        subjectId: `${ownerId}:${repo}`,
        after: { repo },
        traceId: `preauth:${repo}`,
        occurredAt: now,
      });
    }
    return { ok, repo };
  }

  isAllowed(ownerId: string, tool: string, repo: string): boolean {
    return (
      this.#preauthorizations.findActive(
        ownerId,
        tool,
        repo.trim().toLowerCase(),
        this.#now().toISOString(),
      ) !== undefined
    );
  }

  findActive(ownerId: string, tool: string, repo: string): PreauthorizationRecord | undefined {
    return this.#preauthorizations.findActive(
      ownerId,
      tool,
      repo.trim().toLowerCase(),
      this.#now().toISOString(),
    );
  }

  isGrantActive(id: string): boolean {
    return this.findActiveById(id) !== undefined;
  }

  findActiveById(id: string): PreauthorizationRecord | undefined {
    const grant = this.#preauthorizations.get(id);
    if (
      grant === undefined ||
      grant.status !== "active" ||
      grant.expiresAt <= this.#now().toISOString()
    ) {
      return undefined;
    }
    return grant;
  }

  list(ownerId: string): PreauthorizationRecord[] {
    const now = this.#now().toISOString();
    return this.#preauthorizations.list(ownerId).map((grant) =>
      grant.status === "active" && grant.expiresAt <= now
        ? { ...grant, status: "expired" as const }
        : grant,
    );
  }
}
