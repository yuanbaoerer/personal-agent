import type {
  ActionRecord,
  GithubClaim,
  GithubTypedClaim,
  StateClaim,
  TaskRecord,
  TaskVerification,
  WorkerReport,
} from "../domain/types.ts";
import { hashArgs } from "../actions/tooling.ts";
import { assignDraftKeys, validateProjectReview } from "./project-review.ts";
import {
  hashSnapshot,
  isListStateTool,
  isOwnerLevelStateTool,
  isStateToolName,
  parseStateEvidence,
  snapshotScope,
  type StateReadService,
} from "../actions/state.ts";
import type { ActionRepository } from "../storage/actions.ts";

export const VERIFIER_VERSION = "2026-11-21.1";

export interface CompletionVerdict {
  verdict: TaskVerification["verdict"];
  verification: TaskVerification;
}

export interface CompletionDeps {
  actions: ActionRepository;
  state?: StateReadService;
  now?: () => Date;
}

export interface CompletionContext {
  task: TaskRecord;
  report: WorkerReport;
  actions: readonly ActionRecord[];
  structural: { checked: string[]; criteria: Criteria };
  at: string;
  /** Created-at of the newest owner input; state receipts must be newer. */
  latestInputAt?: string;
}

export type CompletionVerifierFn = (context: CompletionContext) => CompletionVerdict;

interface Criteria {
  verifier?: string;
  repo?: string;
  repositoryId?: number;
  projectKey?: string;
  projectBindingVersion?: number;
  requiredEvidenceKinds: string[];
  /** New Router tasks require machine-checkable fact claims. */
  requireStructuredClaims: boolean;
}

function parseCriteria(text: string): Criteria {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return { requiredEvidenceKinds: [], requireStructuredClaims: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { requiredEvidenceKinds: [], requireStructuredClaims: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { requiredEvidenceKinds: [], requireStructuredClaims: false };
  }
  const record = value as Record<string, unknown>;
  return {
    verifier: typeof record.verifier === "string" ? record.verifier : undefined,
    repo: typeof record.repo === "string" ? record.repo.toLowerCase() : undefined,
    repositoryId:
      typeof record.repositoryId === "number" &&
      Number.isSafeInteger(record.repositoryId) &&
      record.repositoryId > 0
        ? record.repositoryId
        : undefined,
    projectKey:
      typeof record.projectKey === "string" && record.projectKey.length > 0
        ? record.projectKey
        : undefined,
    projectBindingVersion:
      typeof record.projectBindingVersion === "number" &&
      Number.isSafeInteger(record.projectBindingVersion) &&
      record.projectBindingVersion > 0
        ? record.projectBindingVersion
        : undefined,
    requiredEvidenceKinds: Array.isArray(record.requiredEvidenceKinds)
      ? record.requiredEvidenceKinds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    requireStructuredClaims: record.requireStructuredClaims === true,
  };
}

function structuralCheck(
  task: Pick<TaskRecord, "completionCriteria">,
  report: WorkerReport,
): { ok: true; checked: string[]; criteria: Criteria } | { ok: false; reason: string } {
  if (report.summary.trim().length === 0) {
    return { ok: false, reason: "summary is empty" };
  }
  if (report.evidence.length === 0) {
    return { ok: false, reason: "no evidence was provided" };
  }
  if (
    report.evidence.some(
      (item) => item.kind.trim().length === 0 || item.value.trim().length === 0,
    )
  ) {
    return { ok: false, reason: "evidence contains an empty kind or value" };
  }
  const criteria = parseCriteria(task.completionCriteria);
  for (const kind of criteria.requiredEvidenceKinds) {
    if (!report.evidence.some((item) => item.kind === kind)) {
      return { ok: false, reason: `missing required evidence kind: ${kind}` };
    }
  }
  return {
    ok: true,
    checked: [
      "summary_nonempty",
      "evidence_nonempty",
      "evidence_fields_nonempty",
      ...(criteria.requiredEvidenceKinds.length > 0 ? ["required_evidence_kinds"] : []),
    ],
    criteria,
  };
}


function actionEvidence(action: ActionRecord): Record<string, unknown> | undefined {
  return action.evidence;
}

function githubActionEvidenceValid(action: ActionRecord, repo: string): boolean {
  const evidence = actionEvidence(action);
  if (evidence === undefined) {
    return false;
  }
  if (
    typeof evidence.repo !== "string" ||
    evidence.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    return false;
  }
  const source = evidence.source;
  if (typeof source !== "string") {
    return false;
  }
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      (url.pathname.toLowerCase() === `/${repo.toLowerCase()}` ||
        url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/`))
    );
  } catch {
    return false;
  }
}

function normalizeGithubUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0
    ) {
      return undefined;
    }
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, "").toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function collectUrlField(value: unknown, urls: Set<string>): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizeGithubUrl(value);
  if (normalized !== undefined) {
    urls.add(normalized);
  }
}

/** Only known URL-bearing fields, not free-text issue/commit titles. */
function collectEvidenceUrls(
  value: unknown,
  urls: Set<string>,
  key?: string,
): void {
  if (
    key === "source" ||
    key === "url" ||
    key === "htmlUrl" ||
    key === "html_url" ||
    key === "detailsUrl" ||
    key === "downloadUrl" ||
    key === "externalRef"
  ) {
    collectUrlField(value, urls);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEvidenceUrls(item, urls);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, item] of Object.entries(value)) {
      collectEvidenceUrls(item, urls, childKey);
    }
  }
}

function allowedActionUrls(actions: readonly ActionRecord[]): Set<string> {
  const urls = new Set<string>();
  for (const action of actions) {
    if (action.externalRef !== undefined) {
      collectUrlField(action.externalRef, urls);
    }
    collectEvidenceUrls(action.evidence, urls);
  }
  return urls;
}

function reportHasVerifiedGithubSource(
  report: WorkerReport,
  repo: string,
  allowed: ReadonlySet<string>,
): boolean {
  const prefix = `https://github.com/${repo.toLowerCase()}`;
  let cited = 0;
  for (const item of report.evidence) {
    for (const match of item.value.matchAll(/https:\/\/github\.com\/[^\s"'<>\])]+/gi)) {
      const url = normalizeGithubUrl(match[0].replace(/[.,;:]+$/, ""));
      if (url === undefined) {
        continue;
      }
      cited += 1;
      if (!(url === prefix || url.startsWith(`${prefix}/`)) || !allowed.has(url)) {
        return false;
      }
    }
  }
  return cited > 0;
}

/**
 * The Coordinator's completion gate. A Worker `ready` report is never trusted
 * directly: structural checks always run, and tasks that claim external facts
 * must match evidence persisted by the executor.
 */
function snapshotPath(
  snapshot: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = snapshot;
  for (const segment of path.split(".")) {
    if (
      segment.length === 0 ||
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype" ||
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function snapshotItems(
  snapshot: Record<string, unknown>,
  key: "task" | "tasks" | "reminders",
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const direct = snapshot[key];
  if (typeof direct === "object" && direct !== null) {
    if (Array.isArray(direct)) {
      for (const item of direct) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          items.push(item as Record<string, unknown>);
        }
      }
    } else {
      items.push(direct as Record<string, unknown>);
      const nested = (direct as Record<string, unknown>)[
        key === "tasks" ? "recent" : "next"
      ];
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "object" && item !== null && !Array.isArray(item)) {
            items.push(item as Record<string, unknown>);
          }
        }
      }
    }
  }
  return items;
}

function findSnapshotItem(
  snapshot: Record<string, unknown>,
  key: "task" | "tasks" | "reminders",
  id: string,
): Record<string, unknown> | undefined {
  const items = snapshotItems(snapshot, key);
  const exact = items.find((item) => item.id === id);
  if (exact !== undefined) {
    return exact;
  }
  const prefixed = items.filter(
    (item) => typeof item.id === "string" && item.id.startsWith(id),
  );
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function validateGithubClaim(
  claim: GithubClaim,
  actions: readonly ActionRecord[],
): string | undefined {
  if (claim.kind === "github_typed") {
    return validateGithubTypedClaim(claim, actions);
  }
  const candidates = actions.filter(
    (candidate) =>
      typeof candidate.args.repo === "string" &&
      candidate.args.repo.toLowerCase() === claim.repo &&
      (candidate.args.operation === claim.operation ||
        (claim.operation === "pulls" && candidate.args.operation === "pull")),
  );
  if (candidates.length === 0) {
    return `github_action_missing:${claim.repo}:${claim.operation}`;
  }
  let found = false;
  let fieldSeen = false;
  for (const action of candidates) {
    const evidence = action.evidence;
    const items = Array.isArray(evidence?.items)
      ? evidence.items
      : claim.operation === "pulls" &&
          typeof evidence?.item === "object" &&
          evidence.item !== null &&
          !Array.isArray(evidence.item)
        ? [evidence.item]
        : undefined;
    if (items === undefined) {
      continue;
    }
    for (const candidate of items) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        continue;
      }
      const item = candidate as Record<string, unknown>;
      const matchesItem =
        claim.operation === "commits"
          ? typeof item.sha === "string" && item.sha.startsWith(claim.item)
          : Number(item.number) === Number(claim.item);
      if (!matchesItem) {
        continue;
      }
      found = true;
      if (Object.hasOwn(item, claim.field)) {
        fieldSeen = true;
        if (item[claim.field] === claim.value) {
          return undefined;
        }
      }
    }
  }
  if (!found) {
    return `github_item_missing:${claim.operation}:${claim.item}`;
  }
  return fieldSeen
    ? `github_field_mismatch:${claim.operation}:${claim.item}:${claim.field}`
    : `github_field_missing:${claim.operation}:${claim.field}`;
}

function validateGithubTypedClaim(
  claim: GithubTypedClaim,
  actions: readonly ActionRecord[],
): string | undefined {
  const candidates = actions.filter(
    (action) =>
      action.args.operation === claim.operation &&
      typeof action.args.repo === "string" &&
      action.args.repo.toLowerCase() === claim.repo &&
      action.args.projectKey === claim.projectKey,
  );
  if (candidates.length === 0) {
    return `github_typed_action_missing:${claim.operation}`;
  }
  for (const action of candidates) {
    const evidence = action.evidence;
    if (
      evidence === undefined ||
      evidence.projectKey !== claim.projectKey ||
      typeof evidence.repositoryId !== "number"
    ) {
      continue;
    }
    if (claim.operation === "pull_files") {
      if (evidence.stale === true) {
        return `github_typed_stale:${claim.operation}`;
      }
      if (
        typeof evidence.headSha !== "string" ||
        evidence.headSha.toLowerCase() !== claim.revision
      ) {
        continue;
      }
    } else {
      if (
        typeof action.args.sha !== "string" ||
        action.args.sha.toLowerCase() !== claim.revision ||
        typeof evidence.commitSha !== "string" ||
        evidence.commitSha.toLowerCase() !== claim.revision
      ) {
        continue;
      }
    }
    return matchTypedClaim(claim, evidence);
  }
  return `github_typed_revision_missing:${claim.operation}:${claim.revision}`;
}

function matchTypedClaim(
  claim: GithubTypedClaim,
  evidence: Record<string, unknown>,
): string | undefined {
  if (claim.operation === "file") {
    const item =
      typeof evidence.item === "object" &&
      evidence.item !== null &&
      !Array.isArray(evidence.item)
        ? (evidence.item as Record<string, unknown>)
        : undefined;
    if (item === undefined || item.path !== claim.target) {
      return `github_typed_item_missing:file:${claim.target}`;
    }
    if (claim.field === "exists") {
      const exists = item.type === "file" || item.type === "symlink";
      return exists === claim.value
        ? undefined
        : `github_typed_field_mismatch:file:${claim.target}:exists`;
    }
    if (claim.field === "contentIncludes") {
      if (typeof item.content !== "string") {
        return `github_typed_field_missing:file:${claim.target}:content`;
      }
      if (item.content.includes(String(claim.value))) {
        return undefined;
      }
      return item.contentTruncated === true
        ? `github_typed_content_truncated:file:${claim.target}`
        : `github_typed_field_mismatch:file:${claim.target}:contentIncludes`;
    }
    const actual = item[claim.field];
    if (actual === undefined) {
      return `github_typed_field_missing:file:${claim.target}:${claim.field}`;
    }
    return actual === claim.value
      ? undefined
      : `github_typed_field_mismatch:file:${claim.target}:${claim.field}`;
  }

  const items = Array.isArray(evidence.items) ? evidence.items : [];
  const records = items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
  if (claim.operation === "tree") {
    const item = records.find((entry) => entry.path === claim.target);
    if (claim.field === "exists") {
      if (claim.value === true && item !== undefined) {
        return undefined;
      }
      if (claim.value === false && item === undefined) {
        return evidence.truncated === true
          ? "github_typed_tree_truncated"
          : undefined;
      }
      return `github_typed_field_mismatch:tree:${claim.target}:exists`;
    }
    if (item === undefined) {
      return `github_typed_item_missing:tree:${claim.target}`;
    }
    const actual = item[claim.field];
    if (actual === undefined) {
      return `github_typed_field_missing:tree:${claim.target}:${claim.field}`;
    }
    return actual === claim.value
      ? undefined
      : `github_typed_field_mismatch:tree:${claim.target}:${claim.field}`;
  }
  if (claim.operation === "pull_files") {
    const item = records.find((entry) => entry.filename === claim.target);
    if (item === undefined) {
      return `github_typed_item_missing:pull_files:${claim.target}`;
    }
    const actual = item[claim.field];
    if (actual === undefined) {
      return `github_typed_field_missing:pull_files:${claim.target}:${claim.field}`;
    }
    return actual === claim.value
      ? undefined
      : `github_typed_field_mismatch:pull_files:${claim.target}:${claim.field}`;
  }
  const item = records.find((entry) => entry.name === claim.target);
  if (item === undefined) {
    return `github_typed_item_missing:checks:${claim.target}`;
  }
  if (
    typeof item.headSha === "string" &&
    item.headSha.toLowerCase() !== claim.revision
  ) {
    return `github_typed_field_mismatch:checks:${claim.target}:headSha`;
  }
  if (claim.field !== "status" && claim.field !== "conclusion") {
    return `github_typed_field_missing:checks:${claim.target}:${claim.field}`;
  }
  const actual = item[claim.field];
  if (actual === undefined) {
    return `github_typed_field_missing:checks:${claim.target}:${claim.field}`;
  }
  return actual === claim.value
    ? undefined
    : `github_typed_field_mismatch:checks:${claim.target}:${claim.field}`;
}

const COUNT_CLAIM_PATH =
  /^(?:total|tasks\.counts\.(?:queued|running|waiting_user|waiting_external|succeeded|needs_review|failed|cancelling|cancelled)|reminders\.pending|memories\.(?:global|project)|schedules\.counts\.(?:draft|active|paused|cancelled|expired))$/;

/**
 * Compare one model-declared fact with the executor snapshot. The program
 * never trusts the report's free text; only these structured claims are
 * machine-checkable.
 */
function validateStateClaim(
  claim: StateClaim,
  snapshot: Record<string, unknown>,
): string | undefined {
  if (claim.kind === "count") {
    if (!COUNT_CLAIM_PATH.test(claim.path)) {
      return `count_path_not_allowed:${claim.path}`;
    }
    const actual = snapshotPath(snapshot, claim.path);
    if (typeof actual !== "number") {
      return `count_path_missing:${claim.path}`;
    }
    return actual === claim.value
      ? undefined
      : `count_mismatch:${claim.path}:${actual}`;
  }
  if (claim.kind === "task_status") {
    const task = findSnapshotItem(snapshot, "task", claim.taskId) ??
      findSnapshotItem(snapshot, "tasks", claim.taskId);
    if (task === undefined) {
      return `task_missing:${claim.taskId}`;
    }
    return task.status === claim.status
      ? undefined
      : `task_status_mismatch:${claim.taskId}:${String(task.status)}`;
  }
  const reminder = findSnapshotItem(snapshot, "reminders", claim.reminderId);
  if (reminder === undefined) {
    return `reminder_missing:${claim.reminderId}`;
  }
  return reminder.dueAt === claim.dueAt
    ? undefined
    : `reminder_due_mismatch:${claim.reminderId}:${String(reminder.dueAt)}`;
}

export class TaskCompletionVerifier {
  readonly #actions: ActionRepository;
  readonly #state?: StateReadService;
  readonly #now: () => Date;
  readonly #verifiers = new Map<string, CompletionVerifierFn>();

  constructor(deps: CompletionDeps) {
    this.#actions = deps.actions;
    this.#state = deps.state;
    this.#now = deps.now ?? (() => new Date());
    this.register("structural", ({ structural, at }) =>
      this.#verdict("structural", "succeeded", "structural checks passed", {
        checked: structural.checked,
        externalFactsVerified: false,
      }, at),
    );
    this.register("text-review", ({ structural, at }) =>
      this.#verdict(
        "text-review",
        "needs_review",
        "text task has no independent semantic verifier",
        {
          checked: structural.checked,
          missing: ["independent semantic review"],
          externalFactsVerified: false,
        },
        at,
      ),
    );
    this.register(
      "github-read",
      ({ task, report, actions, structural, at, latestInputAt }) =>
        this.#verifyGithub(
          task,
          report,
          actions,
          structural,
          at,
          latestInputAt,
        ),
    );
    this.register(
      "project-review",
      ({ task, report, actions, structural, at }) =>
        this.#verifyProjectReview(task, report, actions, structural, at),
    );
    this.register(
      "state-read",
      ({ task, report, actions, structural, at, latestInputAt }) =>
        this.#verifyState(
          task,
          report,
          actions,
          structural,
          at,
          latestInputAt,
        ),
    );
    this.register("action-receipt", ({ structural, actions, at }) => {
      const succeeded = actions.filter((action) => action.status === "succeeded");
      const evidenceRefs = succeeded
        .map((action) => action.externalRef ?? `action:${action.id}`)
        .filter((value): value is string => typeof value === "string");
      if (succeeded.length === 0) {
        return this.#verdict(
          "action-receipt",
          "needs_review",
          "no succeeded action receipt",
          {
            checked: structural.checked,
            missing: ["succeeded action receipt"],
            externalFactsVerified: false,
          },
          at,
        );
      }
      return this.#verdict(
        "action-receipt",
        "succeeded",
        "executor receipt exists for the reported action",
        {
          checked: [...structural.checked, "action_succeeded"],
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    });
  }

  /** Host/extension seam; task types can add stricter verifiers by name. */
  register(name: string, verifier: CompletionVerifierFn): void {
    this.#verifiers.set(name, verifier);
  }

  verify(
    task: TaskRecord,
    report: WorkerReport,
    options: { latestInputAt?: string } = {},
  ): CompletionVerdict {
    const structural = structuralCheck(task, report);
    const at = this.#now().toISOString();
    if (!structural.ok) {
      return {
        verdict: "failed",
        verification: {
          verifier: "structural",
          verifierVersion: VERIFIER_VERSION,
          verdict: "failed",
          reason: structural.reason,
          checked: ["summary_nonempty", "evidence_nonempty", "evidence_fields_nonempty"],
          missing: [structural.reason],
          evidenceRefs: [],
          externalFactsVerified: false,
          verifiedAt: at,
        },
      };
    }

    const actions = this.#actions
      .listByTask(task.id)
      // A receipt from an earlier revision cannot prove work under the
      // current goal/criteria.
      .filter((action) => action.taskRevision === task.revision);
    const requested = structural.criteria.verifier;
    const hasGithub = task.mandate.tools.includes("github.read");
    const wantsProjectReview =
      task.mandate.skills?.includes("github.project-review") === true;
    const hasState = task.mandate.tools.some(isStateToolName);
    const hasExecutorTool = task.mandate.tools.length > 0;
    // A model-supplied completion criteria string must never downgrade a
    // tool-backed task to structural-only success. The mandate is the
    // minimum verifier strength, not the report text.
    const verifier =
      hasGithub && wantsProjectReview
        ? "project-review"
        : hasGithub
          ? "github-read"
          : hasState
            ? "state-read"
            : hasExecutorTool
              ? "action-receipt"
              : requested ?? "structural";

    const registered = this.#verifiers.get(verifier);
    if (registered === undefined) {
      return this.#verdict(
        verifier,
        "needs_review",
        `unknown completion verifier: ${verifier}`,
        {
          checked: structural.checked,
          missing: ["registered verifier"],
          externalFactsVerified: false,
        },
        at,
      );
    }
    return registered({
      task,
      report,
      actions,
      structural: { checked: structural.checked, criteria: structural.criteria },
      at,
      latestInputAt: options.latestInputAt,
    });
  }

  /**
   * Internal state claims need four separate facts: the tool really ran on
   * the current revision, the persisted receipt belongs to this owner/project,
   * the snapshot body was not altered, and the report cites that exact
   * snapshot. A self-consistent hash alone is not enough.
   */
  #checkStateReceipts(
    task: TaskRecord,
    report: WorkerReport,
    actions: readonly ActionRecord[],
    minSnapshotAt?: string,
    requireClaims = false,
  ): {
    receipts: {
      action: ActionRecord;
      hash: string;
      snapshot: Record<string, unknown>;
    }[];
    checked: string[];
    missing: string[];
  } {
    const stateTools = task.mandate.tools.filter(isStateToolName);
    const receipts: {
      action: ActionRecord;
      hash: string;
      snapshot: Record<string, unknown>;
    }[] = [];
    const checked: string[] = [];
    const missing: string[] = [];
    if (stateTools.length === 0) {
      return {
        receipts,
        checked,
        missing: ["execution:state_tool_mandate"],
      };
    }
    if (this.#state === undefined) {
      return {
        receipts,
        checked,
        missing: ["execution:state_verifier_unavailable"],
      };
    }
    for (const toolName of stateTools) {
      const candidates = actions.filter(
        (action) => action.tool === toolName && action.status === "succeeded",
      );
      if (candidates.length === 0) {
        missing.push(`execution:succeeded_state_action:${toolName}`);
        continue;
      }
      checked.push(`execution:state_action:${toolName}`);
      // Prefer the newest receipt. listByTask is created_at ASC, so a later
      // row wins an updatedAt tie instead of the older one being selected.
      let latest = candidates[0] as ActionRecord;
      for (const candidate of candidates.slice(1)) {
        if (candidate.updatedAt.localeCompare(latest.updatedAt) >= 0) {
          latest = candidate;
        }
      }
      const validation = this.#validateStateEvidence(task, latest, minSnapshotAt);
      checked.push(...validation.checked);
      if (!validation.ok) {
        missing.push(...validation.missing);
        continue;
      }
      receipts.push({
        action: latest,
        hash: validation.hash,
        snapshot: validation.snapshot,
      });
      const cited = report.evidence.some(
        (item) => item.kind === "state_snapshot" && item.value === validation.hash,
      );
      if (!cited) {
        missing.push(`claim:snapshot_cited:${toolName}`);
        continue;
      }
      checked.push(`claim:snapshot_cited:${toolName}`);
    }
    const claims = report.stateClaims ?? [];
    for (const claim of claims) {
      const receipt = receipts.find((item) => item.hash === claim.snapshotHash);
      if (receipt === undefined) {
        missing.push(
          `claim:unknown_snapshot:${claim.snapshotHash.slice(0, 8)}`,
        );
        continue;
      }
      const mismatch = validateStateClaim(claim, receipt.snapshot);
      if (mismatch !== undefined) {
        missing.push(`claim:${mismatch}`);
        continue;
      }
      checked.push(`claim:state:${claim.kind}`);
    }
    if (requireClaims && claims.length === 0) {
      missing.push("claim:structured_state_claims_required");
    }
    // Structured claims cover only declared facts. The report's free text is
    // never promoted to verified, with or without structured claims.
    checked.push("claim:free_text_unverified");
    return { receipts, checked, missing };
  }

  #validateStateEvidence(
    task: TaskRecord,
    action: ActionRecord,
    minSnapshotAt?: string,
  ):
    | {
        ok: true;
        hash: string;
        snapshot: Record<string, unknown>;
        checked: string[];
      }
    | { ok: false; missing: string[]; checked: string[] } {
    const checked: string[] = [];
    const missing: string[] = [];
    if (this.#state === undefined) {
      return {
        ok: false,
        missing: ["execution:state_verifier_unavailable"],
        checked,
      };
    }
    const evidence = parseStateEvidence(action.evidence);
    if (evidence === undefined) {
      return {
        ok: false,
        missing: ["provenance:state_evidence_invalid"],
        checked,
      };
    }
    checked.push("provenance:state_evidence_parsed");
    if (evidence.tool !== action.tool) {
      missing.push("provenance:tool_mismatch");
    }
    if (evidence.ownerId !== task.ownerId) {
      missing.push("provenance:owner_scope_mismatch");
    }
    const expectedProject = task.mandate.project ?? null;
    if (evidence.project !== expectedProject) {
      missing.push("provenance:project_scope_mismatch");
    }
    const scope = snapshotScope(evidence);
    const expectedSnapshotProject = isOwnerLevelStateTool(evidence.tool)
      ? null
      : expectedProject;
    if (
      scope === undefined ||
      scope.ownerId !== task.ownerId ||
      scope.project !== expectedSnapshotProject
    ) {
      missing.push("provenance:snapshot_scope_mismatch");
    }
    if (
      evidence.argsHash !== action.argsHash ||
      hashArgs(action.tool, evidence.args) !== action.argsHash
    ) {
      missing.push("provenance:args_not_bound");
    }
    if (hashSnapshot(evidence.snapshot) !== evidence.snapshotHash) {
      missing.push("provenance:snapshot_integrity_failed");
    }
    const created = Date.parse(action.createdAt);
    const executed = Date.parse(action.updatedAt);
    const snapshotAt = Date.parse(evidence.snapshotAt);
    if (
      Number.isNaN(created) ||
      Number.isNaN(executed) ||
      Number.isNaN(snapshotAt) ||
      snapshotAt < created ||
      snapshotAt > executed + 1_000
    ) {
      missing.push("provenance:snapshot_time_outside_action");
    }
    if (minSnapshotAt !== undefined) {
      const inputAt = Date.parse(minSnapshotAt);
      if (Number.isNaN(inputAt) || snapshotAt < inputAt) {
        missing.push("provenance:snapshot_before_latest_input");
      }
    }
    if (isListStateTool(evidence.tool)) {
      // A tail or empty page can satisfy entity checks while hiding the rest
      // of the owner's state. Receipts must start at the first page.
      if (evidence.args.offset !== 0) {
        missing.push("provenance:page_not_first");
      }
      const total = evidence.snapshot.total;
      const returned = evidence.snapshot.returned;
      if (
        typeof total === "number" &&
        total > 0 &&
        typeof returned === "number" &&
        returned === 0
      ) {
        missing.push("provenance:empty_page");
      }
    }
    const entities = this.#state.auditSnapshot(evidence.tool, evidence.snapshot);
    if (entities.length > 0) {
      missing.push(...entities.map((item) => `provenance:${item}`));
    }
    if (missing.length > 0) {
      return { ok: false, missing, checked };
    }
    checked.push(
      "provenance:owner_scope",
      "provenance:project_scope",
      "provenance:args_bound",
      "provenance:snapshot_integrity",
      "provenance:snapshot_time",
      "provenance:entities_present",
    );
    return {
      ok: true,
      hash: evidence.snapshotHash,
      snapshot: evidence.snapshot,
      checked,
    };
  }

  #verifyState(
    task: TaskRecord,
    report: WorkerReport,
    actions: readonly ActionRecord[],
    structural: { checked: string[]; criteria: Criteria },
    at: string,
    latestInputAt?: string,
  ): CompletionVerdict {
    const state = this.#checkStateReceipts(
      task,
      report,
      actions,
      latestInputAt,
      structural.criteria.requireStructuredClaims,
    );
    const checked = [...structural.checked, ...state.checked];
    const missing = [...state.missing];
    for (const toolName of task.mandate.tools.filter(
      (tool) => !isStateToolName(tool),
    )) {
      const succeeded = actions.some(
        (action) => action.tool === toolName && action.status === "succeeded",
      );
      if (succeeded) {
        checked.push(`execution:action:${toolName}`);
      } else {
        missing.push(`execution:succeeded_action:${toolName}`);
      }
    }
    const evidenceRefs = state.receipts.map(
      ({ action }) => action.externalRef ?? `action:${action.id}`,
    );
    if (missing.length > 0) {
      return this.#verdict(
        "state-read",
        "needs_review",
        "state receipt is missing or does not prove current internal state",
        {
          checked,
          missing,
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    }
    const claims = report.stateClaims?.length ?? 0;
    return this.#verdict(
      "state-read",
      "succeeded",
      claims > 0
        ? `state snapshot receipt, scope, citation and ${claims} structured claim(s) verified for the current revision; remaining free text was not independently verified`
        : "state snapshot receipt, scope and citation verified for the current revision; free-text claims were not independently verified",
      {
        checked,
        evidenceRefs,
        externalFactsVerified: false,
      },
      at,
    );
  }

  #verifyGithub(
    task: TaskRecord,
    report: WorkerReport,
    actions: readonly ActionRecord[],
    structural: { checked: string[]; criteria: Criteria },
    at: string,
    latestInputAt?: string,
  ): CompletionVerdict {
    if (!task.mandate.tools.includes("github.read")) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "github verifier selected without a github.read mandate",
        {
          checked: structural.checked,
          missing: ["github.read mandate"],
          externalFactsVerified: false,
        },
        at,
      );
    }
    const succeeded = actions.filter(
      (action) => action.tool === "github.read" && action.status === "succeeded",
    );
    if (succeeded.length === 0) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "no succeeded github.read action receipt",
        {
          checked: structural.checked,
          missing: ["succeeded github.read action"],
          externalFactsVerified: false,
        },
        at,
      );
    }

    const expectedRepo = structural.criteria.repo;
    if (expectedRepo === undefined) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "github completion criteria has no explicit repository",
        {
          checked: [...structural.checked, "github_action_receipt"],
          missing: ["explicit repository completion criterion"],
          externalFactsVerified: false,
        },
        at,
      );
    }
    const candidateRepos = [expectedRepo];

    const accepted = succeeded.filter(
      (action) =>
        typeof action.args.repo === "string" &&
        candidateRepos.includes(action.args.repo.toLowerCase()) &&
        githubActionEvidenceValid(action, action.args.repo.toLowerCase()),
    );
    if (accepted.length === 0) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "github action evidence does not match the expected repository",
        {
          checked: [...structural.checked, "github_action_receipt", "github_source_url"],
          missing: ["matching github.com source URL in executor evidence"],
          externalFactsVerified: false,
        },
        at,
      );
    }

    const sourceRepo = expectedRepo;
    const allowed = allowedActionUrls(accepted);
    if (!reportHasVerifiedGithubSource(report, sourceRepo, allowed)) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "report has no source URL from the verified GitHub read",
        {
          checked: [...structural.checked, "github_action_receipt", "github_source_url"],
          missing: [`verified GitHub source URL in report evidence`],
          evidenceRefs: accepted
            .map((action) => action.externalRef ?? `action:${action.id}`)
            .filter((value): value is string => typeof value === "string"),
          externalFactsVerified: false,
        },
        at,
      );
    }

    const otherTools = task.mandate.tools.filter(
      (tool) => tool !== "github.read" && !isStateToolName(tool),
    );
    const missingTools = otherTools.filter(
      (tool) =>
        !actions.some(
          (action) => action.tool === tool && action.status === "succeeded",
        ),
    );
    if (missingTools.length > 0) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "mandated non-GitHub tools have no succeeded receipt",
        {
          checked: [
            ...structural.checked,
            "github_action_receipt",
            "non_github_action_receipts",
          ],
          missing: missingTools.map((tool) => `succeeded ${tool} action`),
          evidenceRefs: accepted
            .map((action) => action.externalRef ?? `action:${action.id}`)
            .filter((value): value is string => typeof value === "string"),
          externalFactsVerified: false,
        },
        at,
      );
    }

    const hasStateTools = task.mandate.tools.some(isStateToolName);
    const stateCheck = hasStateTools
      ? this.#checkStateReceipts(
          task,
          report,
          actions,
          latestInputAt,
          structural.criteria.requireStructuredClaims,
        )
      : { receipts: [], checked: [], missing: [] };
    if (stateCheck.missing.length > 0) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "mandated internal state reads are not proven by a current receipt",
        {
          checked: [
            ...structural.checked,
            "github_action_receipt",
            "github_repository_match",
            "github_source_url",
            ...stateCheck.checked,
          ],
          missing: stateCheck.missing,
          evidenceRefs: accepted
            .map((action) => action.externalRef ?? `action:${action.id}`)
            .filter((value): value is string => typeof value === "string"),
          externalFactsVerified: false,
        },
        at,
      );
    }

    const githubClaims = report.githubClaims ?? [];
    const claimMissing: string[] = [];
    if (
      structural.criteria.requireStructuredClaims &&
      githubClaims.length === 0
    ) {
      claimMissing.push("claim:github_claims_required");
    }
    const claimChecked: string[] = [];
    for (const claim of githubClaims) {
      const mismatch = validateGithubClaim(claim, accepted);
      if (mismatch !== undefined) {
        claimMissing.push(`claim:${mismatch}`);
      } else {
        claimChecked.push(`claim:github:${claim.operation}:${claim.field}`);
      }
    }
    const checkedAll = [
      ...structural.checked,
      "github_action_receipt",
      "github_repository_match",
      "github_source_url",
      ...stateCheck.checked,
      ...claimChecked,
      "claim:free_text_unverified",
    ];
    if (claimMissing.length > 0) {
      return this.#verdict(
        "github-read",
        "needs_review",
        "github structured claims do not match the source receipts",
        {
          checked: checkedAll,
          missing: claimMissing,
          evidenceRefs: accepted
            .map((action) => action.externalRef ?? `action:${action.id}`)
            .filter((value): value is string => typeof value === "string"),
          externalFactsVerified: false,
        },
        at,
      );
    }
    return this.#verdict(
      "github-read",
      "succeeded",
      githubClaims.length > 0
        ? `github action and source URL verified; ${githubClaims.length} structured claim(s) matched; remaining free text was not independently verified`
        : "github action and source URL verified; free-text claims were not independently verified",
      {
        checked: checkedAll,
        evidenceRefs: accepted
          .map((action) => action.externalRef ?? `action:${action.id}`)
          .filter((value): value is string => typeof value === "string"),
        externalFactsVerified: false,
      },
      at,
    );
  }

  /**
   * A project review is not trusted because the Skill was selected. Every
   * structured finding must resolve to a GitHub receipt at the same
   * repository and revision, and every drafted issue write must point at a
   * verified finding and (for updates) an existing issue receipt.
   */
  #verifyProjectReview(
    task: TaskRecord,
    report: WorkerReport,
    actions: readonly ActionRecord[],
    structural: { checked: string[]; criteria: Criteria },
    at: string,
  ): CompletionVerdict {
    if (structural.criteria.repo === undefined) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review completion criteria has no explicit repository",
        {
          checked: [...structural.checked, "github_action_receipt"],
          missing: ["explicit repository completion criterion"],
          externalFactsVerified: false,
        },
        at,
      );
    }
    const repo = structural.criteria.repo;
    const project = task.mandate.project?.toLowerCase();
    const githubActions = actions.filter(
      (action) => action.status === "succeeded" &&
        action.tool === "github.read" &&
        githubActionEvidenceValid(action, repo) &&
        (project === undefined ||
          (typeof action.evidence?.projectKey === "string" &&
            action.evidence.projectKey.toLowerCase() === project)),
    );
    const evidenceRefs = githubActions
      .map((action) => action.externalRef ?? `action:${action.id}`)
      .filter((value): value is string => typeof value === "string");
    if (githubActions.length === 0) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review has no succeeded GitHub read receipt",
        {
          checked: [...structural.checked, "github_action_receipt"],
          missing: ["succeeded github.read action"],
          externalFactsVerified: false,
        },
        at,
      );
    }
    const findings = report.findings ?? [];
    const drafts = assignDraftKeys(findings, report.issueDrafts ?? []);
    if (findings.length === 0) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review report has no structured findings",
        {
          checked: [...structural.checked, "github_action_receipt"],
          missing: ["structured finding"],
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    }
    // The task's completion criteria is bound to one active ProjectBinding.
    // Findings for another repository or project cannot be accepted even
    // when each individual receipt exists.
    const bindingMissing: string[] = [];
    if (
      structural.criteria.projectKey !== undefined &&
      task.mandate.project === undefined
    ) {
      bindingMissing.push("project_review:criteria_project_not_in_mandate");
    }
    if (
      structural.criteria.projectKey !== undefined &&
      task.mandate.project !== undefined &&
      structural.criteria.projectKey.toLowerCase() !==
        task.mandate.project.toLowerCase()
    ) {
      bindingMissing.push("project_review:criteria_project_mismatch");
    }
    if (
      structural.criteria.repositoryId !== undefined &&
      findings.some(
        (finding) =>
          finding.repositoryId !== structural.criteria.repositoryId,
      )
    ) {
      bindingMissing.push("project_review:repository_id_mismatch");
    }
    if (bindingMissing.length > 0) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review findings are outside the bound project",
        {
          checked: [...structural.checked, "github_action_receipt", "project_review:binding_criteria"],
          missing: bindingMissing,
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    }
    const validation = validateProjectReview({
      findings,
      drafts,
      actions: githubActions,
      repo,
      projectKey: project,
    });
    for (const claim of report.githubClaims ?? []) {
      const mismatch = validateGithubClaim(claim, githubActions);
      if (mismatch !== undefined) {
        validation.missing.push(`claim:${mismatch}`);
      } else {
        validation.checked.push(`claim:github:${claim.operation}:${claim.field}`);
      }
    }
    const checked = [
      ...structural.checked,
      "github_action_receipt",
      "project_review:findings",
      ...validation.checked.slice(0, 80),
      "claim:free_text_unverified",
    ];
    if (validation.missing.length > 0) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review findings do not match the GitHub receipts",
        {
          checked,
          missing: validation.missing.slice(0, 40),
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    }
    if (validation.observed === 0) {
      return this.#verdict(
        "project-review",
        "needs_review",
        "project review has no observed finding backed by a receipt",
        {
          checked,
          missing: ["observed finding with verified evidence"],
          evidenceRefs,
          externalFactsVerified: false,
        },
        at,
      );
    }
    return this.#verdict(
      "project-review",
      "succeeded",
      `project review checked citations for ${validation.observed} observed, ${validation.inferred} inferred and ${validation.unknown} unknown finding(s); narrative conclusions were not independently verified; ${validation.drafts} issue draft(s) await owner approval`,
      {
        checked,
        evidenceRefs,
        externalFactsVerified: false,
      },
      at,
    );
  }

  #verdict(
    verifier: string,
    verdict: TaskVerification["verdict"],
    reason: string,
    details: {
      checked: string[];
      missing?: string[];
      evidenceRefs?: string[];
      externalFactsVerified: boolean;
    },
    at: string,
  ): CompletionVerdict {
    return {
      verdict,
      verification: {
        verifier,
        verifierVersion: VERIFIER_VERSION,
        verdict,
        reason,
        checked: details.checked,
        missing: details.missing ?? [],
        evidenceRefs: details.evidenceRefs ?? [],
        externalFactsVerified: details.externalFactsVerified,
        verifiedAt: at,
      },
    };
  }
}

/** Backward-compatible structural predicate used by existing callers/tests. */
export function evaluateCompletion(
  task: Pick<TaskRecord, "completionCriteria">,
  report: WorkerReport,
): { ok: boolean; reason: string } {
  const result = structuralCheck(task, report);
  return result.ok ? { ok: true, reason: "" } : { ok: false, reason: result.reason };
}
