import {
  ToolRejectedError,
  type ActionTool,
  type ToolExecutionContext,
  type ToolExecution,
  type ToolVerification,
} from "./tools.ts";
import {
  CredentialBroker,
  CredentialScopeError,
  CredentialUnavailableError,
  type ResolvedCredential,
} from "./credentials.ts";

export interface GitHubProjectBinding {
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  /** Reference into the CredentialBroker; never a token. */
  credentialRef: string;
  status: "active" | "revoked";
}

export interface GitHubReadConfig {
  token?: string;
  /** Resolve a token at call time (OAuth credential store); overrides token. */
  tokenProvider?: () => string | undefined | Promise<string | undefined>;
  /** Exact owner/repo allow list; empty disables the connector. */
  allowedRepos: string[];
  /** Resolve an active owner-scoped project binding for typed reads. */
  resolveProject?: (projectKey: string) => GitHubProjectBinding | undefined;
  /**
   * When present, typed reads resolve the binding credentialRef here and
   * never fall back to the global token. Project writes will use the same refs.
   */
  credentials?: CredentialBroker;
  /** How long a verified repository identity is trusted. */
  repositoryVerificationTtlMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}

type GitHubOperation =
  | "repo"
  | "commits"
  | "issues"
  | "pulls"
  | "pull"
  | "ref"
  | "tree"
  | "file"
  | "issue"
  | "pull_files"
  | "checks";

const API_BASE = "https://api.github.com";
const MAX_ITEMS = 20;
const DEFAULT_ITEMS = 5;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_PATTERN = /^[\p{L}\p{N}._/@+-]{1,255}$/u;
const PATH_PATTERN = /^[\p{L}\p{N}._/ @+-]{1,500}$/u;
const PROJECT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const TYPED_OPERATIONS = new Set<GitHubOperation>([
  "ref",
  "tree",
  "file",
  "issue",
  "pull_files",
  "checks",
]);

/**
 * Read-only GitHub connector. Every operation is a GET; the token is only
 * sent to api.github.com with redirects disabled, and the repo allow list is
 * enforced before any network call.
 */
export class GitHubReadTool implements ActionTool {
  readonly name = "github.read";
  readonly resource = "github";
  readonly readOnly = true;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs = 10_000;
  readonly #config: Required<Pick<GitHubReadConfig, "timeoutMs" | "maxBytes">> &
    GitHubReadConfig;
  readonly #allowed: Set<string>;
  readonly #verifiedRepositories = new Map<string, number>();

  constructor(config: GitHubReadConfig) {
    this.#config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 8_000,
      maxBytes: config.maxBytes ?? 200_000,
    };
    this.#allowed = new Set(config.allowedRepos.map((repo) => repo.toLowerCase()));
  }

  canonicalize(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Record<string, unknown> {
    const operation = args.operation;
    if (
      operation !== "repo" &&
      operation !== "commits" &&
      operation !== "issues" &&
      operation !== "pulls" &&
      operation !== "pull" &&
      operation !== "ref" &&
      operation !== "tree" &&
      operation !== "file" &&
      operation !== "issue" &&
      operation !== "pull_files" &&
      operation !== "checks"
    ) {
      throw new ToolRejectedError(
        "operation must be repo, commits, issues, pulls, pull, ref, tree, file, issue, pull_files, or checks",
      );
    }
    const typed = TYPED_OPERATIONS.has(operation);
    let repo: string;
    let projectKey: string | undefined;
    let repositoryId: number | undefined;
    if (typed) {
      const requestedProject = args.projectKey;
      if (
        typeof requestedProject !== "string" ||
        !PROJECT_KEY_PATTERN.test(requestedProject)
      ) {
        throw new ToolRejectedError(
          `${operation} requires an active projectKey`,
        );
      }
      if (
        context?.project !== undefined &&
        context.project.toLowerCase() !== requestedProject
      ) {
        throw new ToolRejectedError(
          "projectKey does not match the task mandate project",
        );
      }
      if (this.#config.resolveProject === undefined) {
        throw new ToolRejectedError(
          "GitHub project bindings are not configured for typed reads",
        );
      }
      let binding: GitHubProjectBinding | undefined;
      try {
        binding = this.#config.resolveProject(requestedProject);
      } catch {
        throw new ToolRejectedError("GitHub project binding lookup failed");
      }
      if (
        binding === undefined ||
        binding.status !== "active" ||
        binding.projectKey !== requestedProject ||
        !Number.isSafeInteger(binding.repositoryId) ||
        binding.repositoryId < 1 ||
        !REPO_PATTERN.test(binding.repositoryFullName) ||
        typeof binding.credentialRef !== "string" ||
        !CREDENTIAL_REF_PATTERN.test(binding.credentialRef) ||
        binding.repositoryFullName
          .split("/")
          .some((part) => part === "." || part === "..")
      ) {
        throw new ToolRejectedError(
          `project ${requestedProject} is not an active repository binding`,
        );
      }
      projectKey = requestedProject;
      repositoryId = binding.repositoryId;
      repo = binding.repositoryFullName;
      if (args.repo !== undefined) {
        if (
          typeof args.repo !== "string" ||
          args.repo.toLowerCase() !== repo.toLowerCase()
        ) {
          throw new ToolRejectedError(
            "repo does not match the active project binding",
          );
        }
      }
    } else {
      const requestedRepo = args.repo;
      if (
        typeof requestedRepo !== "string" ||
        !REPO_PATTERN.test(requestedRepo) ||
        requestedRepo.split("/").some((part) => part === "." || part === "..")
      ) {
        throw new ToolRejectedError("repo must be owner/name");
      }
      repo = requestedRepo;
      if (
        context?.project !== undefined &&
        this.#config.resolveProject !== undefined
      ) {
        let binding: GitHubProjectBinding | undefined;
        try {
          binding = this.#config.resolveProject(context.project);
        } catch {
          throw new ToolRejectedError("GitHub project binding lookup failed");
        }
        if (
          binding === undefined ||
          binding.status !== "active" ||
          typeof binding.credentialRef !== "string" ||
          !CREDENTIAL_REF_PATTERN.test(binding.credentialRef) ||
          binding.repositoryFullName.toLowerCase() !== repo.toLowerCase()
        ) {
          throw new ToolRejectedError(
            "repo does not match the task project binding",
          );
        }
        projectKey = binding.projectKey;
        repositoryId = binding.repositoryId;
      }
    }
    if (!this.#allowed.has(repo.toLowerCase())) {
      throw new ToolRejectedError("repository is not in the allow list");
    }
    const project =
      projectKey === undefined ? {} : { projectKey, repositoryId };

    const limitRaw = args.limit;
    const limit =
      limitRaw === undefined
        ? DEFAULT_ITEMS
        : typeof limitRaw === "number" && Number.isInteger(limitRaw)
          ? limitRaw
          : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS) {
      throw new ToolRejectedError(`limit must be an integer between 1 and ${MAX_ITEMS}`);
    }

    if (operation === "pull" || operation === "issue" || operation === "pull_files") {
      // `pullNumber` is a natural model alias; canonicalize it away.
      const number = args.number ?? args.pullNumber;
      if (
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1
      ) {
        throw new ToolRejectedError(
          `${operation} requires a positive integer number`,
        );
      }
      return { operation, repo, ...project, number, limit };
    }
    if (operation === "ref") {
      const ref = args.ref;
      if (
        typeof ref !== "string" ||
        !REF_PATTERN.test(ref) ||
        ref.startsWith("-") ||
        ref.startsWith("/") ||
        ref.endsWith("/") ||
        ref.includes("..") ||
        ref.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new ToolRejectedError("ref must be a safe branch, tag or ref");
      }
      return { operation, repo, ...project, ref: normalizeGitRef(ref) };
    }
    if (operation === "tree" || operation === "checks") {
      // `revision` is the claim field name; accept it as the read SHA.
      const sha = args.sha ?? args.revision;
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
        throw new ToolRejectedError(`${operation} requires a fixed 40-character commit SHA`);
      }
      if (operation === "tree") {
        if (args.recursive !== undefined && typeof args.recursive !== "boolean") {
          throw new ToolRejectedError("recursive must be a boolean");
        }
        return {
          operation,
          repo,
          ...project,
          sha,
          recursive: args.recursive === true,
          limit,
        };
      }
      return { operation, repo, ...project, sha, limit };
    }
    if (operation === "file") {
      const sha = args.sha ?? args.revision;
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
        throw new ToolRejectedError("file requires a fixed 40-character commit SHA");
      }
      const path = args.path ?? args.target;
      if (
        typeof path !== "string" ||
        !PATH_PATTERN.test(path) ||
        path.startsWith("/") ||
        path.endsWith("/") ||
        path.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new ToolRejectedError("path must be a safe repository-relative path");
      }
      return { operation, repo, ...project, sha, path, limit };
    }
    return { operation, repo, ...project, limit };
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecution> {
    const canonical = this.canonicalize(args, context);
    const operation = canonical.operation as GitHubOperation;
    const repo = canonical.repo as string;
    const limit = canonical.limit as number;
    const deadline = Date.now() + this.#config.timeoutMs;
    const token = await this.#resolveToken(canonical, operation, deadline, context);
    const projectEvidence =
      typeof canonical.projectKey === "string"
        ? {
            projectKey: canonical.projectKey,
            repositoryId: canonical.repositoryId,
          }
        : {};
    const externalRef = `https://github.com/${repo}`;

    if (operation === "pull_files") {
      return {
        evidence: {
          ...(await this.#readPullFiles(
            repo,
            canonical.number as number,
            limit,
            token,
            deadline,
          )),
          ...projectEvidence,
        },
        externalRef,
      };
    }
    if (operation === "checks") {
      return {
        evidence: {
          ...(await this.#readChecks(
            repo,
            canonical.sha as string,
            limit,
            token,
            deadline,
          )),
          ...projectEvidence,
        },
        externalRef,
      };
    }

    const path =
      operation === "pull"
        ? `/repos/${repo}/pulls/${canonical.number as number}`
        : operation === "repo"
          ? `/repos/${repo}`
          : operation === "issue"
            ? `/repos/${repo}/issues/${canonical.number as number}`
            : operation === "ref"
              ? `/repos/${repo}/git/ref/${encodeRef(canonical.ref as string)}`
              : operation === "tree"
                ? `/repos/${repo}/git/trees/${canonical.sha as string}`
                : operation === "file"
                  ? `/repos/${repo}/contents/${encodePath(canonical.path as string)}`
                  : `/repos/${repo}/${operation}`;
    const params = new URLSearchParams();
    if (operation === "issues" || operation === "pulls") {
      params.set("state", "open");
      params.set("per_page", String(limit));
    } else if (operation === "commits") {
      params.set("per_page", String(limit));
    } else if (operation === "tree") {
      if (canonical.recursive === true) params.set("recursive", "1");
    } else if (operation === "file") {
      params.set("ref", canonical.sha as string);
    }
    const url = this.#url(path, params);
    const { body, hasNext } = await this.#requestJson(
      url,
      operation,
      token,
      deadline,
    );
    const evidence = mapEvidence(operation, repo, body, limit, url, hasNext, {
      sha: canonical.sha as string | undefined,
      path: canonical.path as string | undefined,
      ref: canonical.ref as string | undefined,
    });
    return {
      evidence: { ...evidence, ...projectEvidence },
      externalRef,
    };
  }

  async verify(): Promise<ToolVerification> {
    // A lost GET result cannot be proven complete from local state; let
    // reconcile re-read instead of reporting a fabricated success.
    return { satisfied: false, evidence: { readOnly: true } };
  }

  /**
   * Typed project reads use the binding's credential ref, not the global
   * PAT/OAuth token. The real repository id is checked before the first read
   * under each credential version and then cached briefly.
   */
  async #resolveToken(
    canonical: Record<string, unknown>,
    operation: GitHubOperation,
    deadline: number,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (
      canonical.projectKey !== undefined &&
      this.#config.credentials !== undefined
    ) {
      const projectKey = canonical.projectKey as string;
      const repo = canonical.repo as string;
      const binding = this.#config.resolveProject?.(projectKey);
      if (
        binding === undefined ||
        binding.status !== "active" ||
        binding.projectKey !== projectKey ||
        binding.repositoryId !== canonical.repositoryId ||
        binding.repositoryFullName.toLowerCase() !== repo.toLowerCase() ||
        typeof binding.credentialRef !== "string" ||
        !CREDENTIAL_REF_PATTERN.test(binding.credentialRef)
      ) {
        throw new ToolRejectedError(
          `project ${projectKey} is not an active repository binding`,
        );
      }
      let credential: ResolvedCredential | undefined;
      try {
        credential = await this.#config.credentials.resolve(
          binding.credentialRef,
          ["repository.read"],
          {
            ...(context?.ownerId === undefined ? {} : { ownerId: context.ownerId }),
            repositoryId: binding.repositoryId,
          },
        );
      } catch (error) {
        if (
          error instanceof CredentialUnavailableError ||
          error instanceof CredentialScopeError
        ) {
          throw new ToolRejectedError(error.message);
        }
        throw new ToolRejectedError("project credential lookup failed");
      }
      if (credential === undefined) {
        throw new ToolRejectedError(
          `project credential ${binding.credentialRef} is unavailable`,
        );
      }
      await this.#ensureRepositoryIdentity(
        repo,
        binding.repositoryId,
        credential,
        deadline,
      );
      return credential.token;
    }

    const token =
      this.#config.tokenProvider === undefined
        ? this.#config.token
        : await this.#config.tokenProvider();
    if (token === undefined || token.trim().length === 0) {
      throw new ToolRejectedError(
        "github token is not configured or OAuth is not connected",
      );
    }
    return token;
  }

  async #ensureRepositoryIdentity(
    repo: string,
    expectedId: number,
    credential: ResolvedCredential,
    deadline: number,
  ): Promise<void> {
    const key = `${credential.ref}\u0000${credential.version}\u0000${expectedId}\u0000${repo.toLowerCase()}`;
    const cachedUntil = this.#verifiedRepositories.get(key);
    if (cachedUntil !== undefined && cachedUntil > Date.now()) {
      return;
    }
    const url = this.#url(`/repos/${repo}`, new URLSearchParams());
    const { body } = await this.#requestJson(
      url,
      "repo",
      credential.token,
      deadline,
    );
    const record = asObject(body);
    const repositoryId = numberValue(record.id);
    const fullName = stringValue(record.full_name);
    if (
      repositoryId !== expectedId ||
      fullName === undefined ||
      fullName.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new ToolRejectedError(
        "github repository identity does not match the project binding",
      );
    }
    const ttl = this.#config.repositoryVerificationTtlMs ?? 300_000;
    if (this.#verifiedRepositories.size >= 100) {
      this.#verifiedRepositories.clear();
    }
    this.#verifiedRepositories.set(key, Date.now() + ttl);
  }

  async #requestJson(
    url: URL,
    operation: GitHubOperation,
    token: string,
    deadline?: number,
  ): Promise<{ body: unknown; hasNext: boolean }> {
    const timeoutMs =
      deadline === undefined
        ? this.#config.timeoutMs
        : Math.min(this.#config.timeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) {
      throw new ToolRejectedError("github request timed out");
    }
    let response: Response;
    try {
      response = await this.#fetch(url, token, timeoutMs);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ToolRejectedError("github request timed out");
      }
      throw new ToolRejectedError(
        `github request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new ToolRejectedError(describeFailure(response, operation));
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > this.#config.maxBytes) {
      throw new ToolRejectedError("github response exceeded the size limit");
    }

    let raw = "";
    try {
      const reader = response.body?.getReader();
      if (reader === undefined) {
        raw = await response.text();
        if (new TextEncoder().encode(raw).byteLength > this.#config.maxBytes) {
          throw new ToolRejectedError("github response exceeded the size limit");
        }
      } else {
        const decoder = new TextDecoder();
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          bytes += chunk.value.byteLength;
          if (bytes > this.#config.maxBytes) {
            await reader.cancel();
            throw new ToolRejectedError("github response exceeded the size limit");
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      }
    } catch (error) {
      if (error instanceof ToolRejectedError) {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ToolRejectedError("github request timed out");
      }
      throw new ToolRejectedError(
        `github request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ToolRejectedError("github response was not valid JSON");
    }
    return {
      body,
      hasNext: (response.headers.get("link") ?? "").includes('rel="next"'),
    };
  }

  /**
   * `/pulls/{n}/files` is not pinned by SHA. Read the PR head before and after
   * the file list; retry once, then mark the receipt stale so the verifier
   * refuses deterministic conclusions from it.
   */
  async #readPullFiles(
    repo: string,
    number: number,
    limit: number,
    token: string,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const pullUrl = this.#url(
      `/repos/${repo}/pulls/${number}`,
      new URLSearchParams(),
    );
    const filesUrl = this.#url(
      `/repos/${repo}/pulls/${number}/files`,
      new URLSearchParams({ per_page: String(limit) }),
    );
    const first = await this.#requestJson(
      pullUrl,
      "pull_files",
      token,
      deadline,
    );
    const firstShas = pullShas(first.body);
    if (firstShas === undefined) {
      throw new ToolRejectedError(
        "github pull request has no base/head SHA",
      );
    }
    let headSha = firstShas.headSha;
    let baseSha = firstShas.baseSha;
    let files = await this.#requestJson(
      filesUrl,
      "pull_files",
      token,
      deadline,
    );
    let retryCount = 0;
    let stale = false;
    let observedHeadSha: string | undefined;

    const second = await this.#requestJson(
      pullUrl,
      "pull_files",
      token,
      deadline,
    );
    const secondShas = pullShas(second.body);
    if (secondShas === undefined) {
      throw new ToolRejectedError(
        "github pull request has no base/head SHA",
      );
    }
    if (secondShas.headSha !== headSha) {
      observedHeadSha = headSha;
      headSha = secondShas.headSha;
      baseSha = secondShas.baseSha;
      retryCount = 1;
      files = await this.#requestJson(
        filesUrl,
        "pull_files",
        token,
        deadline,
      );
      const third = await this.#requestJson(
        pullUrl,
        "pull_files",
        token,
        deadline,
      );
      const thirdShas = pullShas(third.body);
      if (thirdShas === undefined) {
        throw new ToolRejectedError(
          "github pull request has no base/head SHA",
        );
      }
      if (thirdShas.headSha !== headSha) {
        stale = true;
        observedHeadSha = headSha;
        headSha = thirdShas.headSha;
        baseSha = thirdShas.baseSha;
      } else {
        baseSha = thirdShas.baseSha;
      }
    }

    const items = Array.isArray(files.body) ? files.body : [];
    return {
      operation: "pull_files",
      repo,
      number,
      baseSha,
      headSha,
      ...(observedHeadSha === undefined ? {} : { observedHeadSha }),
      retryCount,
      stale,
      coverage: stale ? "unknown" : "complete",
      source: `https://github.com/${repo}/pull/${number}/files`,
      items: items.slice(0, limit).map((item) => mapPullFile(asObject(item))),
      truncated: files.hasNext || items.length > limit,
    };
  }

  async #readChecks(
    repo: string,
    sha: string,
    limit: number,
    token: string,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const runsUrl = this.#url(
      `/repos/${repo}/commits/${sha}/check-runs`,
      new URLSearchParams({ per_page: String(limit) }),
    );
    const runs = await this.#requestJson(runsUrl, "checks", token, deadline);
    const evidence = mapEvidence(
      "checks",
      repo,
      runs.body,
      limit,
      runsUrl,
      runs.hasNext,
      { sha },
    );

    let combinedStatus: Record<string, unknown> | undefined;
    let commitStatuses: "included" | "unavailable" = "included";
    try {
      const statusUrl = this.#url(
        `/repos/${repo}/commits/${sha}/status`,
        new URLSearchParams(),
      );
      const status = await this.#requestJson(
        statusUrl,
        "checks",
        token,
        deadline,
      );
      const record = asObject(status.body);
      const statuses = Array.isArray(record.statuses) ? record.statuses : [];
      combinedStatus = {
        state: stringValue(record.state),
        totalCount: numberValue(record.total_count),
        items: statuses.slice(0, limit).map((item) => {
          const entry = asObject(item);
          return {
            context: stringValue(entry.context),
            state: stringValue(entry.state),
            targetUrl: stringValue(entry.target_url),
          };
        }),
        truncated: status.hasNext || statuses.length > limit,
      };
    } catch {
      commitStatuses = "unavailable";
    }

    return {
      ...evidence,
      commitSha: sha,
      coverage: {
        checkRuns: runs.hasNext ? "truncated" : "complete",
        commitStatuses,
      },
      ...(combinedStatus === undefined ? {} : { combinedStatus }),
    };
  }

  #url(path: string, params: URLSearchParams): URL {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  async #fetch(
    url: URL,
    token: string,
    timeoutMs: number = this.#config.timeoutMs,
  ): Promise<Response> {
    const fetcher = this.#config.fetch ?? fetch;
    return fetcher(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "personal-agent/0.1",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

function describeFailure(response: Response, operation: GitHubOperation): string {
  if (response.status === 401) {
    return "github authentication failed";
  }
  if (response.status === 403 || response.status === 429) {
    const rateLimited =
      response.status === 429 ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.get("retry-after") !== null;
    return rateLimited
      ? "github rate limit exceeded"
      : `github permission denied for ${operation}`;
  }
  if (response.status === 404) {
    return operation === "ref"
      ? "github ref not found; use heads/<branch> or tags/<tag>"
      : "github repository or resource not found";
  }
  return `github request failed with status ${response.status}`;
}

function mapEvidence(
  operation: GitHubOperation,
  repo: string,
  body: unknown,
  limit: number,
  requestUrl: URL,
  hasNextPage: boolean,
  request?: { sha?: string; path?: string; ref?: string },
): Record<string, unknown> {
  if (operation === "repo") {
    const item = asObject(body);
    return {
      operation,
      repo,
      source: `https://github.com/${repo}`,
      item: {
        ...(numberValue(item.id) === undefined ? {} : { id: numberValue(item.id) }),
        fullName: stringValue(item.full_name),
        defaultBranch: stringValue(item.default_branch),
        pushedAt: stringValue(item.pushed_at),
        openIssues: numberValue(item.open_issues_count),
        url: stringValue(item.html_url),
      },
    };
  }
  if (operation === "pull") {
    return {
      operation,
      repo,
      source: stringValue(asObject(body).html_url) ?? `https://github.com/${repo}`,
      item: mapPull(asObject(body)),
    };
  }
  if (operation === "ref") {
    const record = asObject(body);
    const object = asObject(record.object);
    const sha = stringValue(object.sha)?.slice(0, 40);
    return {
      operation,
      repo,
      ref: stringValue(record.ref),
      requestedRef: request?.ref,
      sha,
      type: stringValue(object.type),
      source:
        sha === undefined
          ? `https://github.com/${repo}`
          : stringValue(object.type) === "commit"
            ? `https://github.com/${repo}/commit/${sha}`
            : `https://github.com/${repo}`,
      url: stringValue(object.url),
    };
  }
  if (operation === "tree") {
    const record = asObject(body);
    const rawItems = Array.isArray(record.tree) ? record.tree : [];
    const commitSha = request?.sha;
    return {
      operation,
      repo,
      sha: stringValue(record.sha)?.slice(0, 40),
      commitSha,
      requestedSha: commitSha,
      source:
        commitSha === undefined
          ? `https://github.com/${repo}`
          : `https://github.com/${repo}/tree/${commitSha}`,
      request: requestUrl.pathname,
      items: rawItems.slice(0, limit).map((item) => {
        const entry = asObject(item);
        return {
          path: stringValue(entry.path),
          mode: stringValue(entry.mode),
          type: stringValue(entry.type),
          sha: stringValue(entry.sha),
          size: numberValue(entry.size),
        };
      }),
      truncated: record.truncated === true || rawItems.length > limit || hasNextPage,
    };
  }
  if (operation === "file") {
    const commitSha = request?.sha;
    const path = request?.path;
    if (Array.isArray(body)) {
      return {
        operation,
        repo,
        commitSha,
        requestedSha: commitSha,
        path,
        source:
          commitSha === undefined || path === undefined
            ? `https://github.com/${repo}`
            : `https://github.com/${repo}/tree/${commitSha}/${encodePath(path)}`,
        items: body.slice(0, limit).map((item) => mapContentItem(asObject(item))),
        truncated: body.length > limit || hasNextPage,
      };
    }
    const record = asObject(body);
    const item = mapContentItem(record);
    return {
      operation,
      repo,
      commitSha,
      requestedSha: commitSha,
      path,
      source:
        stringValue(record.html_url) ??
        `https://github.com/${repo}`,
      permanentUrl:
        commitSha === undefined || path === undefined
          ? undefined
          : `https://github.com/${repo}/blob/${commitSha}/${encodePath(path)}`,
      item,
    };
  }
  if (operation === "issue") {
    const record = asObject(body);
    return {
      operation,
      repo,
      source: stringValue(record.html_url) ?? `https://github.com/${repo}`,
      item: mapIssue(record),
    };
  }
  if (operation === "pull_files") {
    const items = Array.isArray(body) ? body.slice(0, limit) : [];
    return {
      operation,
      repo,
      source: `https://github.com/${repo}/pull/${pathPart(requestUrl, 5)}/files`,
      items: items.map((item) => mapPullFile(asObject(item))),
      truncated: hasNextPage || (Array.isArray(body) && body.length > limit),
    };
  }
  if (operation === "checks") {
    const record = asObject(body);
    const runs = Array.isArray(record.check_runs) ? record.check_runs : [];
    return {
      operation,
      repo,
      commitSha: request?.sha,
      requestedSha: request?.sha,
      source: `https://github.com/${repo}/commit/${request?.sha ?? pathPart(requestUrl, 5)}/checks`,
      items: runs.slice(0, limit).map((item) => mapCheckRun(asObject(item))),
      truncated: hasNextPage || runs.length > limit,
      totalCount: numberValue(record.total_count),
    };
  }

  const items = Array.isArray(body) ? body.slice(0, limit) : [];
  return {
    operation,
    repo,
    source: `https://github.com/${repo}`,
    items: items.map((item) => {
      const record = asObject(item);
      if (operation === "commits") {
        return {
          sha: stringValue(record.sha)?.slice(0, 40),
          message: firstLine(stringValue(asObject(record.commit).message)),
          author:
            stringValue(asObject(record.author).login) ??
            stringValue(asObject(asObject(record.commit).author).name),
          date: stringValue(asObject(asObject(record.commit).author).date),
          url: stringValue(record.html_url),
        };
      }
      if (operation === "issues") {
        return {
          number: numberValue(record.number),
          title: firstLine(stringValue(record.title)),
          state: stringValue(record.state),
          updatedAt: stringValue(record.updated_at),
          author: stringValue(asObject(record.user).login),
          isPullRequest: record.pull_request !== undefined,
          url: stringValue(record.html_url),
        };
      }
      return mapPull(record);
    }),
    truncated: hasNextPage,
    request: requestUrl.pathname,
  };
}

function mapPull(record: Record<string, unknown>): Record<string, unknown> {
  return {
    number: numberValue(record.number),
    title: firstLine(stringValue(record.title)),
    state: stringValue(record.state),
    draft: record.draft === true,
    merged: record.merged === true,
    mergeableState: stringValue(record.mergeable_state),
    base: stringValue(asObject(record.base).ref),
    head: stringValue(asObject(record.head).ref),
    baseSha: stringValue(asObject(record.base).sha),
    headSha: stringValue(asObject(record.head).sha),
    author: stringValue(asObject(record.user).login),
    updatedAt: stringValue(record.updated_at),
    url: stringValue(record.html_url),
  };
}

function pullShas(
  body: unknown,
): { headSha: string; baseSha: string } | undefined {
  const record = asObject(body);
  const headSha = stringValue(asObject(record.head).sha);
  const baseSha = stringValue(asObject(record.base).sha);
  if (
    headSha === undefined ||
    baseSha === undefined ||
    !SHA_PATTERN.test(headSha) ||
    !SHA_PATTERN.test(baseSha)
  ) {
    return undefined;
  }
  return { headSha: headSha.toLowerCase(), baseSha: baseSha.toLowerCase() };
}

function mapContentItem(record: Record<string, unknown>): Record<string, unknown> {
  const type = stringValue(record.type);
  const encoding = stringValue(record.encoding);
  const content = stringValue(record.content);
  const size = numberValue(record.size);
  const decoded =
    type === "file" && encoding === "base64" && content !== undefined
      ? decodeUtf8(content, size)
      : {};
  return {
    type,
    path: stringValue(record.path),
    name: stringValue(record.name),
    sha: stringValue(record.sha),
    size,
    encoding,
    downloadUrl: stringValue(record.download_url),
    htmlUrl: stringValue(record.html_url),
    target: stringValue(record.target),
    ...decoded,
  };
}

function mapIssue(record: Record<string, unknown>): Record<string, unknown> {
  const labels = Array.isArray(record.labels)
    ? record.labels
        .slice(0, 20)
        .map((label) => stringValue(asObject(label).name))
        .filter((label): label is string => label !== undefined)
    : [];
  const body = stringValue(record.body);
  return {
    number: numberValue(record.number),
    title: firstLine(stringValue(record.title)),
    state: stringValue(record.state),
    author: stringValue(asObject(record.user).login),
    body: truncateText(body, 4_000),
    bodyTruncated: body !== undefined && body.length > 4_000,
    labels,
    isPullRequest: record.pull_request !== undefined,
    createdAt: stringValue(record.created_at),
    updatedAt: stringValue(record.updated_at),
    url: stringValue(record.html_url),
  };
}

function mapPullFile(record: Record<string, unknown>): Record<string, unknown> {
  const patch = stringValue(record.patch);
  const truncatedPatch = truncateText(patch, 8_000);
  return {
    filename: stringValue(record.filename),
    status: stringValue(record.status),
    additions: numberValue(record.additions),
    deletions: numberValue(record.deletions),
    changes: numberValue(record.changes),
    sha: stringValue(record.sha),
    previousFilename: stringValue(record.previous_filename),
    patch: truncatedPatch,
    patchTruncated:
      patch !== undefined && truncatedPatch !== patch,
  };
}

function mapCheckRun(record: Record<string, unknown>): Record<string, unknown> {
  const output = asObject(record.output);
  const summary = stringValue(output.summary);
  return {
    id: numberValue(record.id),
    name: stringValue(record.name),
    status: stringValue(record.status),
    conclusion: stringValue(record.conclusion),
    headSha: stringValue(record.head_sha),
    detailsUrl: stringValue(record.details_url),
    startedAt: stringValue(record.started_at),
    completedAt: stringValue(record.completed_at),
    outputTitle: firstLine(stringValue(output.title)),
    outputSummary: truncateText(summary, 2_000),
    outputSummaryTruncated: summary !== undefined && summary.length > 2_000,
  };
}

function decodeUtf8(
  content: string,
  size: number | undefined,
): { content?: string; contentTruncated?: boolean; contentEncodingInvalid?: boolean } {
  if (size !== undefined && size > 32 * 1024) {
    return { contentTruncated: true };
  }
  try {
    const binary = atob(content.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return {
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      ),
    };
  } catch {
    return { contentEncodingInvalid: true };
  }
}

function truncateText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * GET /git/ref expects `heads/main` or `tags/v1`. Owners commonly write
 * `main` or `refs/heads/main`; normalize those deterministically instead of
 * failing a read on a syntactic detail.
 */
function normalizeGitRef(ref: string): string {
  const withoutPrefix = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
  return withoutPrefix.startsWith("heads/") || withoutPrefix.startsWith("tags/")
    ? withoutPrefix
    : `heads/${withoutPrefix}`;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function pathPart(url: URL, index: number): string {
  return url.pathname.split("/")[index] ?? "";
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const line = value.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
