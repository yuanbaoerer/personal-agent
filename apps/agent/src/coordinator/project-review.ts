import { createHash } from "node:crypto";

import type {
  ActionRecord,
  IssueDraft,
  ProjectFinding,
  ProjectFindingClassification,
  ProjectFindingSeverity,
} from "../domain/types.ts";

const MAX_FINDINGS = 50;
const MAX_DRAFTS = 20;
const MAX_EVIDENCE_REFS = 20;
const SHA = /^[0-9a-f]{40}$/;
const DRAFT_KEY = /^[0-9a-f]{32}$/;
const FINDING_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CLASSIFICATIONS = new Set<ProjectFindingClassification>([
  "observed",
  "inferred",
  "unknown",
]);
const SEVERITIES = new Set<ProjectFindingSeverity>([
  "critical",
  "high",
  "medium",
  "low",
]);

export interface ProjectReviewValidation {
  checked: string[];
  missing: string[];
  observed: number;
  inferred: number;
  unknown: number;
  drafts: number;
}

interface Receipt {
  projectKey?: string;
  repositoryId?: number;
  operation?: string;
  commitSha?: string;
  headSha?: string;
  stale: boolean;
  truncated: boolean;
  refs: Set<string>;
  issues: Map<number, { title: string; body?: string }>;
}

/**
 * Deterministic idempotency key for a read-only issue draft. A later write
 * phase can reuse it to avoid duplicate creates after a retry.
 */
export function projectReviewDraftKey(
  repositoryId: number,
  commitSha: string,
  requirementRefs: readonly string[],
): string {
  const normalized = [...new Set(requirementRefs.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort();
  return createHash("sha256")
    .update(`${repositoryId}\u0000${commitSha.toLowerCase()}\u0000${normalized.join("\u0000")}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Verify model-declared project findings against the executor's GitHub
 * receipts. Only program-checkable facts are accepted; narrative text stays
 * unverified even when a finding is structurally valid.
 */
export function validateProjectReview(input: {
  findings: readonly ProjectFinding[];
  drafts: readonly IssueDraft[];
  actions: readonly ActionRecord[];
  repo?: string;
  projectKey?: string;
}): ProjectReviewValidation {
  const receipts = buildReceipts(input.actions, input.repo);
  const checked: string[] = [];
  const missing: string[] = [];
  const refs = new Set<string>();
  const issues = new Map<number, { title: string; body?: string }>();
  for (const receipt of receipts) {
    for (const ref of receipt.refs) {
      refs.add(ref);
    }
    for (const [number, issue] of receipt.issues) {
      if (issue.body !== undefined || !issues.has(number)) {
        issues.set(number, issue);
      }
    }
  }
  const issueNumbers = new Set(issues.keys());
  if (receipts.length === 0) {
    missing.push("project_review:no_github_receipt");
  }
  if (input.projectKey !== undefined) {
    const scoped = receipts.some(
      (receipt) =>
        receipt.projectKey?.toLowerCase() === input.projectKey?.toLowerCase(),
    );
    if (!scoped) {
      missing.push("project_review:project_binding_receipt_missing");
    } else {
      checked.push("project_review:project_binding_receipt");
    }
  }

  const ids = new Set<string>();
  const byId = new Map<string, ProjectFinding>();
  let observed = 0;
  let inferred = 0;
  let unknown = 0;

  input.findings.forEach((finding, index) => {
    const id = finding.id ?? `finding-${index + 1}`;
    if (ids.has(id)) {
      missing.push(`finding:${id}:duplicate_id`);
      return;
    }
    ids.add(id);
    byId.set(id, finding);
    let valid = true;
    const fail = (reason: string): void => {
      valid = false;
      missing.push(`finding:${id}:${reason}`);
    };

    if (!FINDING_ID.test(id)) {
      fail("invalid_id");
    }
    if (
      finding.requirementRef.trim().length === 0 ||
      finding.requirementRef.length > 300
    ) {
      fail("requirement_ref_invalid");
    }
    if (!CLASSIFICATIONS.has(finding.classification)) {
      fail("classification_invalid");
    }
    if (!SEVERITIES.has(finding.severity)) {
      fail("severity_invalid");
    }
    if (
      !Number.isSafeInteger(finding.repositoryId) ||
      finding.repositoryId < 1
    ) {
      fail("repository_id_invalid");
    }
    const revisionKnown = finding.commitSha !== "unknown";
    if (
      !SHA.test(finding.commitSha) &&
      !(finding.classification === "unknown" && !revisionKnown)
    ) {
      fail("commit_sha_invalid");
    }
    if (finding.suggestedAction.trim().length === 0) {
      fail("suggested_action_missing");
    }
    if (finding.classification === "unknown") {
      unknown += 1;
      if (
        finding.evidenceGap === undefined ||
        finding.evidenceGap.trim().length === 0
      ) {
        fail("evidence_gap_missing");
      }
    } else if (finding.classification === "observed") {
      observed += 1;
      if (
        finding.expected.trim().length === 0 ||
        finding.actual.trim().length === 0 ||
        finding.impact.trim().length === 0
      ) {
        fail("observed_fields_missing");
      }
    } else {
      inferred += 1;
      if (finding.impact.trim().length === 0) {
        fail("impact_missing");
      }
    }

    const revisionReceipts = !revisionKnown
      ? receipts.filter(
          (receipt) => receipt.repositoryId === finding.repositoryId,
        )
      : receipts.filter(
          (receipt) =>
            !receipt.stale &&
            receipt.repositoryId === finding.repositoryId &&
            (receipt.commitSha === finding.commitSha.toLowerCase() ||
              receipt.headSha === finding.commitSha.toLowerCase()),
        );
    if (!receipts.some((receipt) => receipt.repositoryId === finding.repositoryId)) {
      fail("repository_receipt_missing");
    }
    if (revisionKnown && revisionReceipts.length === 0) {
      fail("revision_receipt_missing");
    }

    if (finding.evidenceRefs.length === 0) {
      if (finding.classification !== "unknown") {
        fail("evidence_refs_missing");
      }
    }
    let citedRevision = false;
    let citedTruncated = false;
    for (const raw of finding.evidenceRefs) {
      const normalized = normalizeRef(raw);
      if (normalized === undefined || !refs.has(normalized)) {
        fail(`evidence_ref_unverified:${truncateForMessage(raw)}`);
        continue;
      }
      if (
        revisionReceipts.some((receipt) => receipt.refs.has(normalized))
      ) {
        citedRevision = true;
      }
      if (receipts.some((receipt) => receipt.truncated && receipt.refs.has(normalized))) {
        citedTruncated = true;
      }
    }
    if (
      finding.classification === "observed" &&
      finding.evidenceRefs.length > 0 &&
      !citedRevision
    ) {
      fail("observed_ref_not_at_revision");
    }
    if (finding.path !== undefined) {
      const pathVerified = revisionReceipts.some((receipt) =>
        receipt.refs.has(finding.path as string),
      );
      if (!pathVerified) {
        fail(`path_unverified:${truncateForMessage(finding.path)}`);
      }
    }
    if (finding.sourceUrl !== undefined) {
      const normalized = normalizeRef(finding.sourceUrl);
      if (
        normalized === undefined ||
        !revisionReceipts.some((receipt) => receipt.refs.has(normalized))
      ) {
        fail("source_url_unverified");
      }
    }
    if (finding.coverage === "complete" && citedTruncated) {
      fail("coverage_overstates_truncated_evidence");
    }
    if (citedTruncated && finding.truncated !== true) {
      fail("truncated_evidence_not_marked");
    }

    const matches = finding.existingIssueMatches;
    for (const number of matches) {
      if (!Number.isSafeInteger(number) || number < 1) {
        fail("issue_match_invalid");
      } else if (!issueNumbers.has(number)) {
        fail(`issue_match_unverified:${number}`);
      }
    }
    if (valid) {
      checked.push(`finding:${id}:evidence`);
    }
  });

  if (input.findings.length === 0) {
    missing.push("finding:at_least_one");
  }

  const actionable = input.findings.some(
    (finding) => finding.classification !== "unknown",
  );
  if (actionable && input.drafts.length === 0) {
    missing.push("draft:at_least_one");
  }

  const draftKeys = new Set<string>();
  input.drafts.forEach((draft, index) => {
    const label = `draft:${index + 1}`;
    let valid = true;
    const fail = (reason: string): void => {
      valid = false;
      missing.push(`${label}:${reason}`);
    };
    if (
      draft.action !== "create" &&
      draft.action !== "update" &&
      draft.action !== "comment"
    ) {
      fail("action_invalid");
    }
    if (draft.title.trim().length === 0 || draft.title.length > 300) {
      fail("title_invalid");
    }
    if (draft.body.trim().length === 0 || draft.body.length > 20_000) {
      fail("body_invalid");
    }
    if (draft.findingIds.length === 0) {
      fail("finding_ids_missing");
    }
    const linked: ProjectFinding[] = [];
    for (const id of draft.findingIds) {
      const finding = byId.get(id);
      if (finding === undefined) {
        fail(`finding_id_unknown:${truncateForMessage(id)}`);
      } else {
        linked.push(finding);
      }
    }
    if (draft.action === "create") {
      if (draft.targetIssue !== undefined) {
        fail("create_must_not_target_issue");
      }
      for (const finding of linked) {
        if (finding.existingIssueMatches.length > 0) {
          fail("create_with_existing_issue_match");
        }
      }
      for (const [number, issue] of issues) {
        if (titlesSimilar(draft.title, issue.title)) {
          fail(`create_matches_existing_issue:${number}`);
        }
      }
    } else if (
      draft.targetIssue === undefined ||
      !issueNumbers.has(draft.targetIssue)
    ) {
      fail("target_issue_unverified");
    } else {
      const target = draft.targetIssue;
      const linkedToTarget = linked.some((finding) =>
        finding.existingIssueMatches.includes(target),
      );
      if (!linkedToTarget) {
        fail("target_issue_not_linked_to_finding");
      }
      if (draft.action === "update") {
        const issue = issues.get(target);
        if (issue?.body === undefined) {
          fail("before_hash_unverifiable");
        } else if (draft.beforeHash === undefined) {
          fail("before_hash_missing");
        } else if (
          draft.beforeHash !==
          createHash("sha256")
            .update(`${issue.title}\n${issue.body}`)
            .digest("hex")
        ) {
          fail("before_hash_mismatch");
        }
      }
    }
    if (draft.requiresOwnerApproval !== true) {
      fail("owner_approval_missing");
    }
    if (linked.length > 0) {
      const first = linked[0];
      if (first !== undefined) {
        const sameRevision = linked.every(
          (finding) =>
            finding.repositoryId === first.repositoryId &&
            finding.commitSha === first.commitSha,
        );
        if (!sameRevision) {
          fail("mixed_revisions");
        }
        const expected = projectReviewDraftKey(
          first.repositoryId,
          first.commitSha,
          linked.map((finding) => finding.requirementRef),
        );
        if (
          draft.idempotencyKey === undefined ||
          !DRAFT_KEY.test(draft.idempotencyKey)
        ) {
          fail("idempotency_key_invalid");
        } else if (draft.idempotencyKey !== expected) {
          fail("idempotency_key_mismatch");
        }
      }
    }
    if (draft.idempotencyKey !== undefined) {
      if (draftKeys.has(draft.idempotencyKey)) {
        fail("idempotency_key_duplicate");
      }
      draftKeys.add(draft.idempotencyKey);
    }
    if (valid) {
      checked.push(`${label}:${draft.action}`);
    }
  });

  return {
    checked,
    missing,
    observed,
    inferred,
    unknown,
    drafts: input.drafts.length,
  };
}

export function parseProjectFindings(value: unknown): ProjectFinding[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const findings: ProjectFinding[] = [];
  for (const item of value.slice(0, MAX_FINDINGS)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const classification = record.classification;
    const severity = record.severity;
    const repositoryId = record.repositoryId;
    const commitSha = record.commitSha;
    const evidenceRefs = stringArray(record.evidenceRefs, MAX_EVIDENCE_REFS, 2_000);
    const existingIssueMatches = integerArray(
      record.existingIssueMatches,
      20,
    );
    if (
      (classification !== "observed" &&
        classification !== "inferred" &&
        classification !== "unknown") ||
      (severity !== "critical" &&
        severity !== "high" &&
        severity !== "medium" &&
        severity !== "low") ||
      typeof repositoryId !== "number" ||
      !Number.isSafeInteger(repositoryId) ||
      repositoryId < 1 ||
      typeof commitSha !== "string" ||
      (!SHA.test(commitSha) &&
        !(classification === "unknown" && commitSha === "unknown")) ||
      evidenceRefs === undefined ||
      existingIssueMatches === undefined
    ) {
      continue;
    }
    const requirementRef = text(record.requirementRef, 300);
    const expected = text(record.expected, 4_000, true);
    const actual = text(record.actual, 4_000, true);
    const impact = text(record.impact, 4_000, true);
    const suggestedAction = text(record.suggestedAction, 2_000);
    if (
      requirementRef === undefined ||
      expected === undefined ||
      actual === undefined ||
      impact === undefined ||
      suggestedAction === undefined
    ) {
      continue;
    }
    const finding: ProjectFinding = {
      requirementRef,
      classification,
      severity,
      repositoryId,
      commitSha: commitSha.toLowerCase(),
      evidenceRefs,
      expected,
      actual,
      impact,
      existingIssueMatches,
      suggestedAction,
    };
    const id = text(record.id, 64);
    if (id !== undefined) finding.id = id;
    const evidenceGap = text(record.evidenceGap, 2_000);
    if (evidenceGap !== undefined) finding.evidenceGap = evidenceGap;
    const path = text(record.path, 500);
    if (path !== undefined) finding.path = path;
    if (
      typeof record.line === "number" &&
      Number.isSafeInteger(record.line) &&
      record.line > 0
    ) {
      finding.line = record.line;
    }
    const sourceUrl = text(record.sourceUrl, 2_000);
    if (sourceUrl !== undefined && /^https:\/\//.test(sourceUrl)) {
      finding.sourceUrl = sourceUrl;
    }
    if (
      record.coverage === "complete" ||
      record.coverage === "partial" ||
      record.coverage === "unknown"
    ) {
      finding.coverage = record.coverage;
    }
    if (typeof record.truncated === "boolean") {
      finding.truncated = record.truncated;
    }
    if (typeof record.requiresOwnerApproval === "boolean") {
      finding.requiresOwnerApproval = record.requiresOwnerApproval;
    }
    findings.push(finding);
  }
  return findings.length > 0 ? findings : undefined;
}

/**
 * The idempotency key is program-derived from the verified repository,
 * revision and requirement refs. A model-supplied key is not trusted; it is
 * replaced when the draft links to known findings.
 */
export function assignDraftKeys(
  findings: readonly ProjectFinding[],
  drafts: readonly IssueDraft[],
): IssueDraft[] {
  const byId = new Map<string, ProjectFinding>();
  findings.forEach((finding, index) => {
    byId.set(finding.id ?? `finding-${index + 1}`, finding);
  });
  return drafts.map((draft) => {
    const linked = draft.findingIds
      .map((id) => byId.get(id))
      .filter((finding): finding is ProjectFinding => finding !== undefined);
    if (linked.length === 0) {
      return draft;
    }
    const first = linked[0];
    if (first === undefined) {
      return draft;
    }
    const sameRevision = linked.every(
      (finding) =>
        finding.repositoryId === first.repositoryId &&
        finding.commitSha === first.commitSha,
    );
    if (!sameRevision) {
      return draft;
    }
    return {
      ...draft,
      idempotencyKey: projectReviewDraftKey(
        first.repositoryId,
        first.commitSha,
        linked.map((finding) => finding.requirementRef),
      ),
    };
  });
}

export function parseIssueDrafts(value: unknown): IssueDraft[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const drafts: IssueDraft[] = [];
  for (const item of value.slice(0, MAX_DRAFTS)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const action = record.action;
    const title = text(record.title, 300);
    const body = text(record.body, 20_000);
    const findingIds = stringArray(record.findingIds, 20, 64);
    const suppliedKey = text(record.idempotencyKey, 64);
    if (
      (action !== "create" && action !== "update" && action !== "comment") ||
      title === undefined ||
      body === undefined ||
      findingIds === undefined ||
      findingIds.length === 0 ||
      record.requiresOwnerApproval !== true
    ) {
      continue;
    }
    const draft: IssueDraft = {
      action,
      title,
      body,
      findingIds,
      idempotencyKey:
        suppliedKey !== undefined && DRAFT_KEY.test(suppliedKey)
          ? suppliedKey
          : "",
      requiresOwnerApproval: true,
    };
    if (
      typeof record.targetIssue === "number" &&
      Number.isSafeInteger(record.targetIssue) &&
      record.targetIssue > 0
    ) {
      draft.targetIssue = record.targetIssue;
    }
    const beforeHash = text(record.beforeHash, 64);
    if (beforeHash !== undefined && /^[0-9a-f]{64}$/.test(beforeHash)) {
      draft.beforeHash = beforeHash;
    }
    drafts.push(draft);
  }
  return drafts.length > 0 ? drafts : undefined;
}

function buildReceipts(
  actions: readonly ActionRecord[],
  repoFilter?: string,
): Receipt[] {
  const receipts: Receipt[] = [];
  for (const action of actions) {
    if (action.status !== "succeeded" || action.tool !== "github.read") {
      continue;
    }
    const evidence =
      typeof action.evidence === "object" && action.evidence !== null
        ? action.evidence
        : {};
    const repo =
      typeof evidence.repo === "string"
        ? evidence.repo
        : typeof action.args.repo === "string"
          ? action.args.repo
          : undefined;
    if (
      repo === undefined ||
      (repoFilter !== undefined && repo.toLowerCase() !== repoFilter.toLowerCase())
    ) {
      continue;
    }
    const refs = new Set<string>();
    const addRef = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = normalizeRef(value);
      if (normalized !== undefined) {
        refs.add(normalized);
      }
    };
    addRef(action.externalRef);
    addRef(`action:${action.id}`);
    addRef(evidence.source);
    addRef(evidence.url);
    addRef(evidence.permanentUrl);
    addRef(evidence.ref);
    addRef(evidence.requestedRef);
    addRef(evidence.path);
    addObjectRefs(evidence.item, addRef);
    const items = Array.isArray(evidence.items) ? evidence.items : [];
    for (const item of items) {
      addObjectRefs(item, addRef);
    }
    const operation =
      typeof action.args.operation === "string"
        ? action.args.operation
        : undefined;
    const issues = new Map<number, { title: string; body?: string }>();
    if (operation === "issues" || operation === "issue") {
      collectIssueEntries(evidence, issues);
    }
    receipts.push({
      operation,
      projectKey:
        typeof evidence.projectKey === "string"
          ? evidence.projectKey
          : undefined,
      repositoryId:
        typeof evidence.repositoryId === "number"
          ? evidence.repositoryId
          : undefined,
      commitSha:
        typeof evidence.commitSha === "string"
          ? evidence.commitSha.toLowerCase()
          : action.args.operation === "ref" &&
              typeof evidence.sha === "string" &&
              /^[0-9a-f]{40}$/i.test(evidence.sha)
            ? evidence.sha.toLowerCase()
            : undefined,
      headSha:
        typeof evidence.headSha === "string"
          ? evidence.headSha.toLowerCase()
          : undefined,
      stale: evidence.stale === true,
      truncated: evidenceIsTruncated(evidence),
      refs,
      issues,
    });
  }
  return receipts;
}

/**
 * Any truncated field in a receipt invalidates complete/absence claims, not
 * just the top-level `truncated` flag. File content, issue bodies, patches and
 * check output all carry their own truncation markers.
 */
function evidenceIsTruncated(
  evidence: Record<string, unknown>,
  depth = 0,
): boolean {
  if (depth > 3 || evidence === null || typeof evidence !== "object") {
    return false;
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (
      (key === "truncated" || key.endsWith("Truncated")) &&
      value === true
    ) {
      return true;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) {
        if (
          item !== null &&
          typeof item === "object" &&
          evidenceIsTruncated(item as Record<string, unknown>, depth + 1)
        ) {
          return true;
        }
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      evidenceIsTruncated(value as Record<string, unknown>, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

function addObjectRefs(
  value: unknown,
  addRef: (value: unknown) => void,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "url",
    "htmlUrl",
    "html_url",
    "downloadUrl",
    "detailsUrl",
    "permanentUrl",
    "path",
    "filename",
    "name",
  ]) {
    addRef(record[key]);
  }
}

function collectIssueEntries(
  evidence: Record<string, unknown>,
  output: Map<number, { title: string; body?: string }>,
): void {
  const add = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return;
    }
    const record = entry as Record<string, unknown>;
    const number = record.number;
    if (typeof number === "number" && Number.isSafeInteger(number)) {
      output.set(number, {
        title: typeof record.title === "string" ? record.title : "",
        ...(typeof record.body === "string" ? { body: record.body } : {}),
      });
    }
  };
  add(evidence.item);
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  for (const entry of items) {
    add(entry);
  }
}

const TITLE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "issue",
  "项目",
  "问题",
  "任务",
  "实现",
  "支持",
  "需要",
]);

function titleTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && !TITLE_STOP_WORDS.has(token)),
  );
}

function titlesSimilar(left: string, right: string): boolean {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size < 2 || b.size < 2) {
    return false;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
    }
  }
  const union = a.size + b.size - shared;
  return shared >= 2 && shared / union >= 0.6;
}

function normalizeRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) {
    return undefined;
  }
  if (!/^https:\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
      return trimmed;
    }
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

function text(
  value: unknown,
  max: number,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || value.length > max) {
    return undefined;
  }
  return trimmed;
}

function stringArray(
  value: unknown,
  max: number,
  maxLength: number,
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value.slice(0, max)) {
    if (typeof item !== "string") {
      return undefined;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) {
      return undefined;
    }
    result.push(trimmed);
  }
  return result;
}

function integerArray(value: unknown, max: number): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: number[] = [];
  for (const item of value.slice(0, max)) {
    if (
      typeof item !== "number" ||
      !Number.isSafeInteger(item) ||
      item < 1
    ) {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function truncateForMessage(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ");
  return singleLine.length > 80 ? `${singleLine.slice(0, 80)}…` : singleLine;
}

/**
 * Bounded owner-facing summary. Draft content is shown as a proposal, never
 * as an executed write; full reports remain in the assignment record.
 */
export function summarizeProjectReview(
  findings: readonly ProjectFinding[],
  drafts: readonly IssueDraft[],
): string {
  const lines: string[] = ["项目评估（结构化证据已核对）："];
  for (const finding of findings.slice(0, 8)) {
    const ref = finding.evidenceRefs[0] ?? finding.sourceUrl ?? "no-ref";
    lines.push(
      `- [${finding.severity}/${finding.classification}] ${finding.requirementRef}: ` +
        `${finding.expected} → ${finding.actual}` +
        (finding.existingIssueMatches.length > 0
          ? ` (issues: ${finding.existingIssueMatches.join(",")})`
          : "") +
        ` [${ref}]`,
    );
  }
  if (findings.length > 8) {
    lines.push(`- … ${findings.length - 8} more finding(s) in the assignment record`);
  }
  if (drafts.length > 0) {
    lines.push("待办草稿（只读，未写入；需主人批准）：");
    for (const draft of drafts.slice(0, 5)) {
      const target =
        draft.targetIssue === undefined ? "" : ` #${draft.targetIssue}`;
      lines.push(
        `- ${draft.action}${target} ${draft.title}: ${draft.body.slice(0, 300)}` +
          ` (key ${draft.idempotencyKey ?? "unassigned"}, approval required)`,
      );
    }
    if (drafts.length > 5) {
      lines.push(`- … ${drafts.length - 5} more draft(s)`);
    }
  } else {
    lines.push("没有可提交的 Issue 草稿。");
  }
  const text = lines.join("\n");
  return text.length > 2_500 ? `${text.slice(0, 2_500)}…` : text;
}
