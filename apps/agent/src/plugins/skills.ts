import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  SkillBinding,
  SkillRejection,
  TaskExtensionBinding,
} from "../domain/types.ts";
import type { CapabilityView } from "./fence.ts";
import type {
  SkillDocument,
  SkillLoadResult,
  SkillMetadata,
  SkillRuntime,
  SkillSelectionInput,
  SkillSelectionResult,
} from "./skills-contract.ts";

export const SKILL_FILE_MAX_BYTES = 64 * 1024;
export const SKILL_BODY_MAX_BYTES = 8 * 1024;
export const SKILL_TOTAL_BODY_MAX_BYTES = 16 * 1024;
export const MAX_SKILLS_PER_TASK = 8;
const MAX_INDEX_FILES = 100;
const MAX_DEPTH = 4;

const ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const FRONTMATTER_KEYS: Record<string, true> = {
  id: true,
  version: true,
  description: true,
  plugins: true,
  permissions: true,
  priority: true,
};

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

interface IndexedSkill {
  metadata: SkillMetadata;
  path: string;
}

export interface FileSkillRuntimeDeps {
  root: string;
}

interface ParsedSkill {
  metadata: Omit<SkillMetadata, "digest">;
  body: string;
}

/**
 * Node-only SKILL.md index. Only files named SKILL.md under the configured
 * root are read; symlinks, path escapes and oversized files are ignored.
 * Bodies are re-read and digest-checked on every load, never cached.
 */
export class FileSkillRuntime implements SkillRuntime {
  readonly #root: string;
  readonly #skills = new Map<string, IndexedSkill>();
  readonly #errors: { path: string; reason: string }[] = [];

  constructor(deps: FileSkillRuntimeDeps) {
    if (!existsSync(deps.root)) {
      this.#root = deps.root;
      return;
    }
    this.#root = realpathSync(deps.root);
    this.#index();
  }

  list(): SkillMetadata[] {
    return [...this.#skills.values()]
      .map((entry) => entry.metadata)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  errors(): { path: string; reason: string }[] {
    return [...this.#errors];
  }

  select(input: SkillSelectionInput): SkillSelectionResult {
    const rejected: SkillRejection[] = [];
    const requested = [
      ...new Set((input.mandate.skills ?? []).map((id) => id.trim()).filter(Boolean)),
    ];
    const selected: { metadata: SkillMetadata; binding: SkillBinding }[] = [];
    for (const id of requested) {
      if (selected.length >= MAX_SKILLS_PER_TASK) {
        rejected.push({ id, reason: "skill_limit" });
        continue;
      }
      const entry = this.#skills.get(id);
      if (entry === undefined) {
        rejected.push({ id, reason: "skill_not_found" });
        continue;
      }
      const dependencyReason = dependencyRejection(
        entry.metadata,
        input.plugins,
        input.capabilities,
      );
      if (dependencyReason !== undefined) {
        rejected.push({ id, reason: dependencyReason });
        continue;
      }
      selected.push({
        metadata: entry.metadata,
        binding: bindingOf(entry.metadata),
      });
    }
    selected.sort(
      (left, right) =>
        right.metadata.priority - left.metadata.priority ||
        left.metadata.id.localeCompare(right.metadata.id),
    );
    return {
      skills: selected.map((item) => item.binding),
      rejected,
    };
  }

  load(
    bindings: readonly SkillBinding[],
    enabledPlugins: readonly string[],
  ): SkillLoadResult {
    const enabled = new Set(enabledPlugins);
    const rejected: SkillRejection[] = [];
    const skills: SkillDocument[] = [];
    let totalBytes = 0;
    for (const binding of bindings) {
      const entry = this.#skills.get(binding.id);
      if (entry === undefined) {
        rejected.push({ id: binding.id, reason: "skill_not_found" });
        continue;
      }
      if (
        entry.metadata.version !== binding.version ||
        entry.metadata.digest !== binding.digest
      ) {
        rejected.push({ id: binding.id, reason: "skill_version_changed" });
        continue;
      }
      if (entry.metadata.plugins.some((id) => !enabled.has(id))) {
        rejected.push({ id: binding.id, reason: "plugin_disabled" });
        continue;
      }
      let raw: string;
      try {
        const current = realpathSync(entry.path);
        if (!isInside(this.#root, current)) {
          rejected.push({ id: binding.id, reason: "path_escape" });
          continue;
        }
        raw = this.#read(current);
      } catch {
        rejected.push({ id: binding.id, reason: "skill_unreadable" });
        continue;
      }
      if (digestOf(raw) !== binding.digest) {
        rejected.push({ id: binding.id, reason: "skill_digest_changed" });
        continue;
      }
      const parsed = parseSkill(raw);
      if (
        parsed.metadata.id !== binding.id ||
        parsed.metadata.version !== binding.version
      ) {
        rejected.push({ id: binding.id, reason: "skill_identity_changed" });
        continue;
      }
      const bodyBytes = Buffer.byteLength(parsed.body, "utf8");
      if (
        bodyBytes > SKILL_BODY_MAX_BYTES ||
        totalBytes + bodyBytes > SKILL_TOTAL_BODY_MAX_BYTES
      ) {
        rejected.push({ id: binding.id, reason: "skill_body_budget" });
        continue;
      }
      totalBytes += bodyBytes;
      skills.push({
        ...parsed.metadata,
        digest: binding.digest,
        body: parsed.body,
      });
    }
    return { skills, rejected };
  }

  #index(): void {
    let files = 0;
    const walk = (directory: string, depth: number): void => {
      if (depth > MAX_DEPTH) {
        return;
      }
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files >= MAX_INDEX_FILES) {
          return;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".")) {
            continue;
          }
          walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile() || entry.name !== "SKILL.md") {
          continue;
        }
        files += 1;
        this.#indexFile(path);
      }
    };
    walk(this.#root, 0);
  }

  #indexFile(path: string): void {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      this.#error(path, "skill_unreadable");
      return;
    }
    if (!isInside(this.#root, real)) {
      this.#error(path, "path_escape");
      return;
    }
    let raw: string;
    try {
      raw = this.#read(real);
    } catch (error) {
      this.#error(path, error instanceof Error ? error.message : "skill_unreadable");
      return;
    }
    let parsed: ParsedSkill;
    try {
      parsed = parseSkill(raw);
    } catch (error) {
      this.#error(path, error instanceof Error ? error.message : "invalid_skill");
      return;
    }
    if (this.#skills.has(parsed.metadata.id)) {
      this.#error(path, `duplicate skill id: ${parsed.metadata.id}`);
      return;
    }
    this.#skills.set(parsed.metadata.id, {
      metadata: {
        ...parsed.metadata,
        digest: digestOf(raw),
      },
      path: real,
    });
  }

  #read(path: string): string {
    const size = statSync(path).size;
    if (size > SKILL_FILE_MAX_BYTES) {
      throw new SkillError("skill_too_large");
    }
    return readFileSync(path, "utf8");
  }

  #error(path: string, reason: string): void {
    this.#errors.push({
      path: relative(this.#root, path).split(sep).join("/"),
      reason,
    });
  }
}

function parseSkill(raw: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) {
    throw new SkillError("missing_frontmatter");
  }
  const frontmatter = match[1] ?? "";
  if (Buffer.byteLength(frontmatter, "utf8") > 4_096) {
    throw new SkillError("frontmatter_too_large");
  }
  const values = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new SkillError("invalid_frontmatter_line");
    }
    const key = trimmed.slice(0, separator).trim();
    if (!Object.hasOwn(FRONTMATTER_KEYS, key)) {
      throw new SkillError(`unknown_frontmatter_key:${key}`);
    }
    if (values.has(key)) {
      throw new SkillError(`duplicate_frontmatter_key:${key}`);
    }
    values.set(key, trimmed.slice(separator + 1).trim());
  }

  const id = required(values, "id");
  if (!ID_PATTERN.test(id)) {
    throw new SkillError("invalid_skill_id");
  }
  const version = required(values, "version");
  if (!VERSION_PATTERN.test(version)) {
    throw new SkillError("invalid_skill_version");
  }
  const description = required(values, "description");
  if (description.length > 500) {
    throw new SkillError("description_too_long");
  }
  const plugins = parseList(values.get("plugins"));
  const permissions = parseList(values.get("permissions"));
  if (
    plugins.length > 0 &&
    !plugins.some((plugin) => id.startsWith(`${plugin}.`))
  ) {
    throw new SkillError("skill_namespace_mismatch");
  }
  const priorityRaw = values.get("priority");
  const priority =
    priorityRaw === undefined || priorityRaw.length === 0
      ? 0
      : Number(priorityRaw);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
    throw new SkillError("invalid_priority");
  }
  const body = raw.slice(match[0].length).trim();
  if (body.length === 0) {
    throw new SkillError("empty_skill_body");
  }
  return {
    metadata: {
      id,
      version,
      description,
      plugins,
      permissions,
      priority,
    },
    body,
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new SkillError(`missing_${key}`);
  }
  return value;
}

function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0 || raw === "[]") {
    return [];
  }
  const inner =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const values = inner
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unique = [...new Set(values)];
  for (const value of unique) {
    if (!NAME_PATTERN.test(value)) {
      throw new SkillError("invalid_skill_list_entry");
    }
  }
  return unique;
}

function dependencyRejection(
  metadata: SkillMetadata,
  plugins: readonly TaskExtensionBinding[],
  capabilities: CapabilityView,
): string | undefined {
  if (metadata.plugins.length === 0 && metadata.permissions.length > 0) {
    return "permission_without_plugin";
  }
  const pinned = new Set(plugins.map((plugin) => plugin.id));
  for (const pluginId of metadata.plugins) {
    if (!pinned.has(pluginId) || !pluginIsActive(pluginId, capabilities)) {
      return "plugin_not_enabled";
    }
  }
  const allowed = new Set<string>();
  for (const tool of capabilities.toolNames()) {
    const info = capabilities.toolInfo(tool);
    if (info?.pluginId !== undefined && metadata.plugins.includes(info.pluginId)) {
      for (const permission of info.permissions) {
        allowed.add(permission);
      }
    }
  }
  for (const permission of metadata.permissions) {
    if (!allowed.has(permission)) {
      return "permission_not_granted";
    }
  }
  return undefined;
}

function pluginIsActive(pluginId: string, capabilities: CapabilityView): boolean {
  return capabilities
    .toolNames()
    .some((tool) => capabilities.toolInfo(tool)?.pluginId === pluginId);
}

function bindingOf(metadata: SkillMetadata): SkillBinding {
  return {
    id: metadata.id,
    version: metadata.version,
    digest: metadata.digest,
  };
}

function digestOf(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function isInside(root: string, path: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
