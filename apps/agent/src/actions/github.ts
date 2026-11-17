import { ToolRejectedError, type ActionTool, type ToolExecution, type ToolVerification } from "./tools.ts";

export interface GitHubReadConfig {
  token?: string;
  /** Exact owner/repo allow list; empty disables the connector. */
  allowedRepos: string[];
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}

type GitHubOperation = "repo" | "commits" | "issues" | "pulls" | "pull";

const API_BASE = "https://api.github.com";
const MAX_ITEMS = 20;
const DEFAULT_ITEMS = 5;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Read-only GitHub connector. Every operation is a GET; the token is only
 * sent to api.github.com with redirects disabled, and the repo allow list is
 * enforced before any network call.
 */
export class GitHubReadTool implements ActionTool {
  readonly name = "github.read";
  readonly resource = "github";
  readonly #config: Required<Pick<GitHubReadConfig, "timeoutMs" | "maxBytes">> &
    GitHubReadConfig;
  readonly #allowed: Set<string>;

  constructor(config: GitHubReadConfig) {
    this.#config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 8_000,
      maxBytes: config.maxBytes ?? 200_000,
    };
    this.#allowed = new Set(config.allowedRepos.map((repo) => repo.toLowerCase()));
  }

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    const operation = args.operation;
    if (
      operation !== "repo" &&
      operation !== "commits" &&
      operation !== "issues" &&
      operation !== "pulls" &&
      operation !== "pull"
    ) {
      throw new ToolRejectedError(
        "operation must be repo, commits, issues, pulls, or pull",
      );
    }
    const repo = args.repo;
    if (
      typeof repo !== "string" ||
      !REPO_PATTERN.test(repo) ||
      repo.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new ToolRejectedError("repo must be owner/name");
    }
    if (!this.#allowed.has(repo.toLowerCase())) {
      throw new ToolRejectedError("repository is not in the allow list");
    }

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

    if (operation === "pull") {
      const number = args.number;
      if (
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1
      ) {
        throw new ToolRejectedError("pull requires a positive integer number");
      }
      return { operation, repo, number, limit };
    }
    return { operation, repo, limit };
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecution> {
    const canonical = this.canonicalize(args);
    const operation = canonical.operation as GitHubOperation;
    const repo = canonical.repo as string;
    const limit = canonical.limit as number;
    const token = this.#config.token;
    if (token === undefined || token.trim().length === 0) {
      throw new ToolRejectedError("github token is not configured");
    }

    const path =
      operation === "pull"
        ? `/repos/${repo}/pulls/${canonical.number as number}`
        : operation === "repo"
          ? `/repos/${repo}`
          : `/repos/${repo}/${operation}`;
    const params = new URLSearchParams();
    if (operation === "issues" || operation === "pulls") {
      params.set("state", "open");
      params.set("per_page", String(limit));
    } else if (operation === "commits") {
      params.set("per_page", String(limit));
    }
    const url = this.#url(path, params);

    let response: Response;
    try {
      response = await this.#fetch(url, token);
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

    const evidence = mapEvidence(
      operation,
      repo,
      body,
      limit,
      url,
      (response.headers.get("link") ?? "").includes('rel="next"'),
    );
    return {
      evidence,
      externalRef: `https://github.com/${repo}`,
    };
  }

  async verify(): Promise<ToolVerification> {
    // A read has no external state to reconcile.
    return { satisfied: true, evidence: { readOnly: true } };
  }

  #url(path: string, params: URLSearchParams): URL {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  async #fetch(url: URL, token: string): Promise<Response> {
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
      signal: AbortSignal.timeout(this.#config.timeoutMs),
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
    return "github repository or resource not found";
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
): Record<string, unknown> {
  if (operation === "repo") {
    const item = asObject(body);
    return {
      operation,
      repo,
      source: `https://github.com/${repo}`,
      item: {
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
    author: stringValue(asObject(record.user).login),
    updatedAt: stringValue(record.updated_at),
    url: stringValue(record.html_url),
  };
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
