import { createHash } from "node:crypto";

import {
  CredentialScopeError,
  CredentialUnavailableError,
  type CredentialBroker,
  type ResolvedCredential,
} from "./credentials.ts";
import type { GitHubProjectBinding } from "./github.ts";
import {
  ToolRejectedError,
  ToolUnknownError,
  type ActionTool,
  type ToolExecutionContext,
  type ToolExecution,
  type ToolVerification,
} from "./tools.ts";

const API_BASE = "https://api.github.com";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{32}$/;
const MARKER = "personal-agent";

class GitHubHttpError extends ToolRejectedError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubHttpError";
    this.status = status;
  }
}

export type GitHubIssueOperation = "create" | "update" | "comment";

export interface GitHubIssueWriteConfig {
  /** Explicit write allowlist; a binding outside this list is refused. */
  allowedRepos: string[];
  /** The only credential ref this write plugin may use. */
  issueCredentialRef: string;
  resolveProject?: (projectKey: string) => GitHubProjectBinding | undefined;
  credentials?: CredentialBroker;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}

interface IssueRecord {
  number: number;
  id: number;
  title: string;
  body: string;
  state: string;
  htmlUrl?: string;
  isPullRequest: boolean;
}

interface CommentRecord {
  id: number;
  body: string;
  htmlUrl?: string;
}

/**
 * Typed GitHub issue write. It can only run through ActionService with an
 * owner approval bound to the exact canonical args. The tool re-checks the
 * live binding, immutable repository id, credential epoch/scope and issues
 * write allowlist before any mutation.
 */
class GitHubIssueWriteTool implements ActionTool {
  readonly name: string;
  readonly resource = "github";
  readonly readOnly = false;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs: number;
  readonly description: string;
  readonly #operation: GitHubIssueOperation;
  readonly #config: GitHubIssueWriteConfig;
  readonly #allowed: Set<string>;
  readonly #verified = new Map<string, number>();
  readonly #maxBytes: number;

  constructor(
    operation: GitHubIssueOperation,
    config: GitHubIssueWriteConfig,
  ) {
    this.#operation = operation;
    this.#config = config;
    this.name = `github.issue.${operation}`;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.#maxBytes = config.maxBytes ?? 200_000;
    this.#allowed = new Set(
      config.allowedRepos.map((repo) => repo.toLowerCase()),
    );
    this.description =
      operation === "create"
        ? "Create one GitHub issue after owner approval."
        : operation === "update"
          ? "Update the title/body of one GitHub issue after owner approval."
          : "Add one comment to a GitHub issue after owner approval.";
  }

  canonicalize(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Record<string, unknown> {
    const projectKey = args.projectKey;
    if (
      typeof projectKey !== "string" ||
      !PROJECT_KEY_PATTERN.test(projectKey)
    ) {
      throw new ToolRejectedError("projectKey is required");
    }
    if (
      context?.project !== undefined &&
      context.project.toLowerCase() !== projectKey
    ) {
      throw new ToolRejectedError(
        "projectKey does not match the task mandate project",
      );
    }
    if (this.#config.resolveProject === undefined) {
      throw new ToolRejectedError(
        "GitHub project bindings are not configured for writes",
      );
    }
    let binding: GitHubProjectBinding | undefined;
    try {
      binding = this.#config.resolveProject(projectKey);
    } catch {
      throw new ToolRejectedError("GitHub project binding lookup failed");
    }
    if (
      binding === undefined ||
      binding.status !== "active" ||
      binding.projectKey !== projectKey ||
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
        `project ${projectKey} is not an active repository binding`,
      );
    }
    if (!this.#allowed.has(binding.repositoryFullName.toLowerCase())) {
      throw new ToolRejectedError(
        "repository is not in the issue write allow list",
      );
    }
    if (args.repo !== undefined) {
      if (
        typeof args.repo !== "string" ||
        args.repo.toLowerCase() !== binding.repositoryFullName.toLowerCase()
      ) {
        throw new ToolRejectedError(
          "repo does not match the active project binding",
        );
      }
    }
    if (
      args.repositoryId !== undefined &&
      args.repositoryId !== binding.repositoryId
    ) {
      throw new ToolRejectedError(
        "repositoryId does not match the active project binding",
      );
    }
    if (
      args.credentialRef !== undefined &&
      args.credentialRef !== this.#config.issueCredentialRef
    ) {
      throw new ToolRejectedError(
        "credentialRef does not match the configured issue write credential",
      );
    }
    const credentialVersion = args.credentialVersion;
    if (
      typeof credentialVersion !== "number" ||
      !Number.isSafeInteger(credentialVersion) ||
      credentialVersion < 1
    ) {
      throw new ToolRejectedError(
        "credentialVersion must be bound to the approved action",
      );
    }
    const payloadHash = args.payloadHash;
    if (typeof payloadHash !== "string" || !PAYLOAD_HASH.test(payloadHash)) {
      throw new ToolRejectedError("payloadHash must be a sha256 hex digest");
    }
    const idempotencyKey = args.idempotencyKey;
    if (
      typeof idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new ToolRejectedError("idempotencyKey must be 32 lowercase hex");
    }
    const base = {
      projectKey,
      repo: binding.repositoryFullName.toLowerCase(),
      repositoryId: binding.repositoryId,
      credentialRef: this.#config.issueCredentialRef,
      credentialVersion,
      payloadHash,
      idempotencyKey,
    };
    const body = optionalBody(args.body);
    const title = optionalTitle(args.title);
    const targetIssue =
      this.#operation === "create"
        ? undefined
        : positiveInteger(args.targetIssue, "targetIssue");
    if (this.#operation === "create" && args.targetIssue !== undefined) {
      throw new ToolRejectedError("create must not target an existing issue");
    }
    if (
      this.#operation === "comment" &&
      (body === undefined || title !== undefined)
    ) {
      throw new ToolRejectedError("comment requires body and no title");
    }
    const notBefore =
      this.#operation === "comment" ? optionalNotBefore(args.notBefore) : undefined;
    if (
      this.#operation === "update" &&
      body === undefined &&
      title === undefined
    ) {
      throw new ToolRejectedError("update requires title or body");
    }
    if (this.#operation === "update") {
      const beforeHash = args.beforeHash;
      if (typeof beforeHash !== "string" || !PAYLOAD_HASH.test(beforeHash)) {
        throw new ToolRejectedError("update requires the issue beforeHash");
      }
      return {
        ...base,
        ...(targetIssue === undefined ? {} : { targetIssue }),
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        beforeHash,
      };
    }
    return {
      ...base,
      ...(targetIssue === undefined ? {} : { targetIssue }),
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(notBefore === undefined ? {} : { notBefore }),
    };
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecution> {
    const canonical = this.canonicalize(args, context);
    const credential = await this.#credential(canonical, context);
    await this.#ensureRepositoryIdentity(canonical, credential);
    const repo = canonical.repo as string;
    const key = canonical.idempotencyKey as string;
    const body = canonical.body as string | undefined;
    const title = canonical.title as string | undefined;
    const targetIssue = canonical.targetIssue as number | undefined;

    if (this.#operation === "create") {
      const existing = await this.#findByMarker(repo, credential, key);
      if (existing !== undefined) {
        return this.#success(existing, canonical);
      }
      const created = await this.#write(
        "POST",
        `/repos/${repo}/issues`,
        credential,
        {
          title: title as string,
          body: `${body as string}${marker(key)}`,
        },
      );
      const issue = parseIssue(created);
      const verified = await this.#readIssue(repo, issue.number, credential);
      if (
        verified === undefined ||
        !verified.body.includes(key) ||
        !verified.body.includes(body as string)
      ) {
        throw new ToolUnknownError(
          "issue create result could not be verified by read-after-write",
        );
      }
      return this.#success(verified, canonical);
    }

    if (this.#operation === "comment") {
      const existing = await this.#findComment(
        repo,
        targetIssue as number,
        credential,
        key,
        typeof args.notBefore === "string" ? args.notBefore : undefined,
      );
      if (existing !== undefined) {
        return this.#successComment(existing, canonical);
      }
      const before = await this.#readIssue(
        repo,
        targetIssue as number,
        credential,
      );
      if (before === undefined) {
        throw new ToolRejectedError("target issue does not exist");
      }
      if (before.isPullRequest) {
        throw new ToolRejectedError("target is a pull request, not an issue");
      }
      const created = await this.#write(
        "POST",
        `/repos/${repo}/issues/${targetIssue}/comments`,
        credential,
        { body: `${body as string}${marker(key)}` },
      );
      const comment = parseComment(created);
      const verified = await this.#readComment(repo, comment.id, credential);
      if (
        verified === undefined ||
        !verified.body.includes(key) ||
        !verified.body.includes(body as string)
      ) {
        throw new ToolUnknownError(
          "issue comment result could not be verified by read-after-write",
        );
      }
      return this.#successComment(verified, canonical);
    }

    // update: re-read before writing and stop on any competing edit.
    const before = await this.#readIssue(repo, targetIssue as number, credential);
    if (before === undefined) {
      throw new ToolRejectedError("target issue does not exist");
    }
    if (before.isPullRequest) {
      throw new ToolRejectedError("target is a pull request, not an issue");
    }
    const desiredBody = body ?? before.body;
    const desiredTitle = title ?? before.title;
    if (
      before.title === desiredTitle &&
      before.body === desiredBody
    ) {
      return this.#success(before, canonical);
    }
    if (hash(`${before.title}\n${before.body}`) !== canonical.beforeHash) {
      throw new ToolRejectedError(
        "issue changed since approval; re-read and approve the new diff",
      );
    }
    await this.#write(
      "PATCH",
      `/repos/${repo}/issues/${targetIssue}`,
      credential,
      {
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
      },
    );
    const verified = await this.#readIssue(
      repo,
      targetIssue as number,
      credential,
    );
    if (
      verified === undefined ||
      verified.title !== desiredTitle ||
      verified.body !== desiredBody
    ) {
      throw new ToolUnknownError(
        "issue update result could not be verified by read-after-write",
      );
    }
    return this.#success(verified, canonical);
  }

  /**
   * Reconcile path: never repeat a POST blindly. Look for the marker or the
   * desired update state and report satisfied only when the real resource
   * matches the approved payload.
   */
  async verify(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolVerification> {
    let canonical: Record<string, unknown>;
    let credential: ResolvedCredential;
    try {
      canonical = this.canonicalize(args, context);
      credential = await this.#credential(canonical, context);
    } catch (error) {
      return {
        satisfied: false,
        evidence: {
          verified: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const repo = canonical.repo as string;
    if (this.#operation === "create") {
      const existing = await this.#findByMarker(
        repo,
        credential,
        canonical.idempotencyKey as string,
      );
      return existing === undefined
        ? { satisfied: false, evidence: { verified: false } }
        : { satisfied: true, evidence: this.#evidence(existing, canonical) };
    }
    if (this.#operation === "comment") {
      const existing = await this.#findComment(
        repo,
        canonical.targetIssue as number,
        credential,
        canonical.idempotencyKey as string,
      );
      return existing === undefined
        ? { satisfied: false, evidence: { verified: false } }
        : {
            satisfied: true,
            evidence: this.#commentEvidence(existing, canonical),
          };
    }
    const issue = await this.#readIssue(
      repo,
      canonical.targetIssue as number,
      credential,
    );
    if (issue === undefined) {
      return { satisfied: false, evidence: { verified: false } };
    }
    const bodyMatches =
      canonical.body === undefined || issue.body === canonical.body;
    const titleMatches =
      canonical.title === undefined || issue.title === canonical.title;
    return bodyMatches && titleMatches
      ? { satisfied: true, evidence: this.#evidence(issue, canonical) }
      : { satisfied: false, evidence: { verified: false } };
  }

  async #credential(
    canonical: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ResolvedCredential> {
    if (this.#config.credentials === undefined) {
      throw new ToolRejectedError(
        "GitHub issue write credential broker is not configured",
      );
    }
    let credential: ResolvedCredential | undefined;
    try {
      credential = await this.#config.credentials.resolve(
        canonical.credentialRef as string,
        ["repository.read", "issues.write"],
        {
          ...(context?.ownerId === undefined ? {} : { ownerId: context.ownerId }),
          repositoryId: canonical.repositoryId as number,
        },
      );
    } catch (error) {
      if (
        error instanceof CredentialUnavailableError ||
        error instanceof CredentialScopeError
      ) {
        throw new ToolRejectedError(error.message);
      }
      throw new ToolRejectedError("GitHub issue write credential lookup failed");
    }
    if (credential === undefined) {
      throw new ToolRejectedError(
        "GitHub issue write credential is unavailable",
      );
    }
    if (credential.ref !== this.#config.issueCredentialRef) {
      throw new ToolRejectedError("write credential ref changed");
    }
    if (credential.version !== canonical.credentialVersion) {
      throw new ToolRejectedError(
        "credential changed since approval; re-approve the draft",
      );
    }
    return credential;
  }

  async #ensureRepositoryIdentity(
    canonical: Record<string, unknown>,
    credential: ResolvedCredential,
  ): Promise<void> {
    const repo = canonical.repo as string;
    const expectedId = canonical.repositoryId as number;
    const key = `${repo.toLowerCase()}\u0000${expectedId}\u0000${credential.version}`;
    if (this.#verified.has(key)) {
      return;
    }
    const response = await this.#request(
      "GET",
      `/repos/${repo}`,
      credential,
    );
    const record = asObject(response.body);
    if (
      record.id !== expectedId ||
      typeof record.full_name !== "string" ||
      record.full_name.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new ToolRejectedError(
        "github repository identity does not match the project binding",
      );
    }
    if (this.#verified.size >= 100) {
      this.#verified.clear();
    }
    this.#verified.set(key, expectedId);
  }

  async #findByMarker(
    repo: string,
    credential: ResolvedCredential,
    idempotencyKey: string,
  ): Promise<IssueRecord | undefined> {
    const response = await this.#request(
      "GET",
      `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100`,
      credential,
    );
    const items = Array.isArray(response.body) ? response.body : [];
    for (const item of items) {
      const issue = parseIssue(item);
      if (!issue.isPullRequest && issue.body.includes(idempotencyKey)) {
        return issue;
      }
    }
    return undefined;
  }

  async #findComment(
    repo: string,
    issueNumber: number,
    credential: ResolvedCredential,
    idempotencyKey: string,
    notBefore?: string,
  ): Promise<CommentRecord | undefined> {
    // GitHub returns comments in ascending id order. Scan bounded pages,
    // optionally starting after the draft creation time, so a lost POST on a
    // busy issue is still found instead of being repeated.
    for (let page = 1; page <= 5; page += 1) {
      const params = new URLSearchParams({
        per_page: "100",
        page: String(page),
      });
      if (notBefore !== undefined) {
        params.set("since", notBefore);
      }
      const response = await this.#request(
        "GET",
        `/repos/${repo}/issues/${issueNumber}/comments?${params.toString()}`,
        credential,
      );
      const items = Array.isArray(response.body) ? response.body : [];
      for (const item of items) {
        const comment = parseComment(item);
        if (comment.body.includes(idempotencyKey)) {
          return comment;
        }
      }
      if (items.length < 100) {
        return undefined;
      }
    }
    throw new ToolUnknownError(
      "too many issue comments to prove idempotency; reconcile manually",
    );
  }

  async #readIssue(
    repo: string,
    number: number,
    credential: ResolvedCredential,
  ): Promise<IssueRecord | undefined> {
    try {
      const response = await this.#request(
        "GET",
        `/repos/${repo}/issues/${number}`,
        credential,
      );
      return parseIssue(response.body);
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async #readComment(
    repo: string,
    id: number,
    credential: ResolvedCredential,
  ): Promise<CommentRecord | undefined> {
    const response = await this.#request(
      "GET",
      `/repos/${repo}/issues/comments/${id}`,
      credential,
    );
    return parseComment(response.body);
  }

  async #write(
    method: "POST" | "PATCH",
    path: string,
    credential: ResolvedCredential,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.#request(method, path, credential, body);
    return response.body;
  }

  #success(
    issue: IssueRecord,
    canonical: Record<string, unknown>,
  ): ToolExecution {
    return {
      evidence: this.#evidence(issue, canonical),
      externalRef: issue.htmlUrl,
    };
  }

  #evidence(
    issue: IssueRecord,
    canonical: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      operation: this.#operation,
      repo: canonical.repo,
      repositoryId: canonical.repositoryId,
      repositoryFullName: canonical.repo,
      issueNumber: issue.number,
      issueUrl: issue.htmlUrl,
      issueTitle: issue.title,
      idempotencyKey: canonical.idempotencyKey,
      payloadHash: canonical.payloadHash,
      credentialRef: canonical.credentialRef,
      credentialVersion: canonical.credentialVersion,
      verified: true,
      readAfterWrite: true,
    };
  }

  #successComment(
    comment: CommentRecord,
    canonical: Record<string, unknown>,
  ): ToolExecution {
    const evidence = {
      operation: this.#operation,
      repo: canonical.repo,
      repositoryId: canonical.repositoryId,
      issueNumber: canonical.targetIssue,
      commentId: comment.id,
      commentUrl: comment.htmlUrl,
      idempotencyKey: canonical.idempotencyKey,
      payloadHash: canonical.payloadHash,
      credentialRef: canonical.credentialRef,
      credentialVersion: canonical.credentialVersion,
      verified: true,
      readAfterWrite: true,
    };
    return { evidence, externalRef: comment.htmlUrl };
  }

  #commentEvidence(
    comment: CommentRecord,
    canonical: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      operation: this.#operation,
      repo: canonical.repo,
      repositoryId: canonical.repositoryId,
      issueNumber: canonical.targetIssue,
      commentId: comment.id,
      commentUrl: comment.htmlUrl,
      idempotencyKey: canonical.idempotencyKey,
      payloadHash: canonical.payloadHash,
      verified: true,
    };
  }

  async #request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    credential: ResolvedCredential,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${API_BASE}${path}`);
    const init: RequestInit = {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        "user-agent": "personal-agent/0.1",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await (this.#config.fetch ?? fetch)(url, init);
    } catch (error) {
      // A write whose response was lost may already have landed.
      if (method === "GET") {
        throw new ToolRejectedError(
          `github request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new ToolUnknownError(
        `github write outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    if (text.length > this.#maxBytes) {
      throw new ToolRejectedError("github response exceeded the size limit");
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const message =
        response.status === 401
          ? "github authentication failed"
          : response.status === 403 || response.status === 429
            ? "github write permission denied or rate limited"
            : response.status === 404
              ? "github issue or repository not found"
              : `github request failed with status ${response.status}`;
      if (
        method !== "GET" &&
        (response.status === 502 ||
          response.status === 503 ||
          response.status === 504)
      ) {
        throw new ToolUnknownError(message);
      }
      throw new GitHubHttpError(message, response.status);
    }
    return { status: response.status, body: parsed };
  }
}

export function createGitHubIssueWriteTools(
  config: GitHubIssueWriteConfig,
): ActionTool[] {
  return (["create", "update", "comment"] as const).map(
    (operation) => new GitHubIssueWriteTool(operation, config),
  );
}

function marker(idempotencyKey: string): string {
  return `\n\n<!-- ${MARKER}:${idempotencyKey} -->`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function optionalBody(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolRejectedError("body must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 20_000) {
    throw new ToolRejectedError("body must be 1-20000 characters");
  }
  return value;
}

function optionalNotBefore(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ToolRejectedError("notBefore must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolRejectedError("title must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw new ToolRejectedError("title must be 1-300 characters");
  }
  return trimmed;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolRejectedError(`${name} must be a positive integer`);
  }
  return value;
}

function parseIssue(value: unknown): IssueRecord {
  const record = asObject(value);
  return {
    number: Number(record.number),
    id: Number(record.id),
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    state: typeof record.state === "string" ? record.state : "open",
    htmlUrl: typeof record.html_url === "string" ? record.html_url : undefined,
    isPullRequest: record.pull_request !== undefined,
  };
}

function parseComment(value: unknown): CommentRecord {
  const record = asObject(value);
  return {
    id: Number(record.id),
    body: typeof record.body === "string" ? record.body : "",
    htmlUrl: typeof record.html_url === "string" ? record.html_url : undefined,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
