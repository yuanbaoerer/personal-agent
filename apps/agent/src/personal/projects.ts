import type { ProjectBinding, ProjectStatus } from "../domain/types.ts";
import {
  ProjectConflictError,
  ProjectRepository,
  type NewProjectBinding,
} from "../storage/projects.ts";
import type { Store } from "../storage/store.ts";

const PROJECT_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const CREDENTIAL_REF = /^[a-z][a-z0-9._:-]{0,127}$/;
const CREDENTIAL_VALUE = /^(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)/i;

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

export interface BindProjectInput {
  projectKey: string;
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch?: string;
  credentialRef?: string;
  allowedPlanPaths?: string[];
}

export interface BindProjectResult {
  project: ProjectBinding;
  created: boolean;
}

export interface UnbindProjectResult {
  project: ProjectBinding;
  changed: boolean;
}

/**
 * Owner-facing project binding operations. This layer validates stable keys,
 * immutable repository ids, branch/path shapes and records audit evidence; the
 * GitHub read/write layers will consume the resulting active bindings later.
 */
export class ProjectService {
  readonly #projects: ProjectRepository;
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(deps: {
    projects: ProjectRepository;
    store: Store;
    now?: () => Date;
  }) {
    this.#projects = deps.projects;
    this.#store = deps.store;
    this.#now = deps.now ?? (() => new Date());
  }

  list(ownerId: string, status?: ProjectStatus): ProjectBinding[] {
    return this.#projects.list(ownerId, status);
  }

  get(ownerId: string, id: string): ProjectBinding | undefined {
    return this.#projects.get(ownerId, id);
  }

  bind(
    ownerId: string,
    input: BindProjectInput,
    actorId: string,
  ): BindProjectResult {
    const normalized = normalizeInput(input);
    const byKey = this.#projects.findActiveByKey(ownerId, normalized.projectKey);
    if (byKey !== undefined) {
      if (byKey.repositoryId !== normalized.repositoryId) {
        throw new ProjectConflictError(
          `project key ${normalized.projectKey} is already bound to repository ${byKey.repositoryId}`,
        );
      }
      if (sameBinding(byKey, normalized)) {
        return { project: byKey, created: false };
      }
      const updated = this.#projects.updateDetails(
        ownerId,
        byKey.id,
        normalized,
        this.#now().toISOString(),
      );
      if (updated === undefined) {
        throw new ProjectConflictError(
          `project key ${normalized.projectKey} changed concurrently`,
        );
      }
      this.#store.recordAudit({
        actorId,
        event: "project.updated",
        subjectType: "project",
        subjectId: updated.id,
        before: {
          repositoryId: byKey.repositoryId,
          repositoryFullName: byKey.repositoryFullName,
          defaultBranch: byKey.defaultBranch,
          credentialRef: byKey.credentialRef,
          allowedPlanPaths: byKey.allowedPlanPaths,
          version: byKey.version,
        },
        after: {
          repositoryId: updated.repositoryId,
          repositoryFullName: updated.repositoryFullName,
          defaultBranch: updated.defaultBranch,
          credentialRef: updated.credentialRef,
          allowedPlanPaths: updated.allowedPlanPaths,
          version: updated.version,
        },
        traceId: `project:${updated.id}`,
        occurredAt: updated.updatedAt,
      });
      return { project: updated, created: false };
    }
    const byRepository = this.#projects.findActiveByRepository(
      ownerId,
      normalized.repositoryId,
    );
    if (byRepository !== undefined) {
      throw new ProjectConflictError(
        `repository ${normalized.repositoryId} is already bound to project ${byRepository.projectKey}`,
      );
    }
    const at = this.#now().toISOString();
    const project = this.#projects.create({
      ...normalized,
      ownerId,
      createdAt: at,
    });
    this.#audit("project.bound", actorId, project, undefined);
    return { project, created: true };
  }

  unbind(
    ownerId: string,
    id: string,
    actorId: string,
  ): UnbindProjectResult | undefined {
    const at = this.#now().toISOString();
    const result = this.#projects.revoke(ownerId, id, at);
    if (result === undefined) {
      return undefined;
    }
    if (result.changed) {
      this.#audit("project.unbound", actorId, result.project, "active");
    }
    return result;
  }

  #audit(
    event: string,
    actorId: string,
    project: ProjectBinding,
    previousStatus: ProjectStatus | undefined,
  ): void {
    this.#store.recordAudit({
      actorId,
      event,
      subjectType: "project",
      subjectId: project.id,
      before:
        previousStatus === undefined
          ? undefined
          : { status: previousStatus },
      after: {
        projectKey: project.projectKey,
        repositoryId: project.repositoryId,
        repositoryFullName: project.repositoryFullName,
        defaultBranch: project.defaultBranch,
        credentialRef: project.credentialRef,
        status: project.status,
        version: project.version,
      },
      traceId: `project:${project.id}`,
      occurredAt: project.updatedAt,
    });
  }
}

function normalizeInput(input: BindProjectInput): Omit<
  NewProjectBinding,
  "ownerId" | "createdAt"
> {
  const projectKey =
    typeof input.projectKey === "string" ? input.projectKey.trim() : "";
  if (!PROJECT_KEY.test(projectKey)) {
    throw new ProjectValidationError(
      "projectKey must be 1-64 lowercase letters, digits, dot, underscore or dash and start with a letter",
    );
  }
  if (
    typeof input.repositoryId !== "number" ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId < 1
  ) {
    throw new ProjectValidationError(
      "repositoryId must be a positive safe integer",
    );
  }
  const repositoryFullName = normalizeRepositoryName(input.repositoryFullName);
  const defaultBranch = normalizeBranch(input.defaultBranch ?? "main");
  const credentialRef = normalizeCredentialRef(
    input.credentialRef ?? "github:default",
  );
  const allowedPlanPaths = normalizePlanPaths(input.allowedPlanPaths ?? []);
  return {
    projectKey,
    repositoryId: input.repositoryId,
    repositoryFullName,
    defaultBranch,
    credentialRef,
    allowedPlanPaths,
  };
}

function normalizeRepositoryName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length > 200 || !REPOSITORY.test(name)) {
    throw new ProjectValidationError("repositoryFullName must be owner/name");
  }
  const parts = name.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new ProjectValidationError("repositoryFullName must be owner/name");
  }
  return name;
}

function normalizeBranch(value: unknown): string {
  const branch = typeof value === "string" ? value.trim() : "";
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    !BRANCH.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch === "@" ||
    branch.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ProjectValidationError("defaultBranch is invalid");
  }
  return branch;
}

function normalizeCredentialRef(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!CREDENTIAL_REF.test(ref) || CREDENTIAL_VALUE.test(ref)) {
    throw new ProjectValidationError(
      "credentialRef must be a lowercase reference such as github:default, not a token",
    );
  }
  return ref;
}

function normalizePlanPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ProjectValidationError("allowedPlanPaths must be an array with at most 20 entries");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ProjectValidationError("allowedPlanPaths entries must be strings");
    }
    const path = item.trim();
    if (
      path.length === 0 ||
      path.length > 255 ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new ProjectValidationError(`allowedPlanPaths entry is invalid: ${path}`);
    }
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

function sameBinding(
  existing: ProjectBinding,
  input: Omit<NewProjectBinding, "ownerId" | "createdAt">,
): boolean {
  return (
    existing.repositoryId === input.repositoryId &&
    existing.repositoryFullName === input.repositoryFullName &&
    existing.defaultBranch === input.defaultBranch &&
    existing.credentialRef === input.credentialRef &&
    existing.allowedPlanPaths.join("\u0000") === input.allowedPlanPaths.join("\u0000")
  );
}
