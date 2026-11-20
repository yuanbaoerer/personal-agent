import { createHash } from "node:crypto";

import { stableStringify } from "../actions/tooling.ts";

/** First and only supported host contract. Bump with a migration. */
export const PLUGIN_API_VERSION = "1";

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TOOL_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const SECRET_KEY_PATTERN = /(token|secret|password|credential|private[-_]?key|api[-_]?key)/i;

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

export type PluginReplayPolicy = "verify" | "never";

export interface PluginToolCapability {
  name: string;
  resource: string;
  readOnly: boolean;
  replayPolicy: PluginReplayPolicy;
  timeoutMs: number;
  permissions: string[];
  /** Operations the owner may authorize. Descriptive, not an authority. */
  operations: string[];
  /** Host-rendered Worker guidance. Still untrusted text; never authority. */
  guidance?: string;
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  trust: "builtin";
  entrypoint: string;
  exports: {
    tools: string[];
    skills: string[];
  };
  capabilities: PluginToolCapability[];
  auth: string[];
  permissions: string[];
  defaultPolicy: "enabled" | "disabled";
  /** Non-secret plugin configuration declaration. */
  config: Record<string, unknown>;
  description?: string;
}

export function pluginDigest(manifest: PluginManifest): string {
  return createHash("sha256")
    .update(stableStringify(manifest), "utf8")
    .digest("hex");
}

/**
 * Parse a builtin manifest from data. The host trusts the provider code, not
 * this JSON: validation prevents namespace squatting and schema drift, while
 * the catalog still verifies that returned tools match the declaration.
 */
export function parsePluginManifest(value: unknown): PluginManifest {
  const record = asRecord(value, "manifest");
  rejectUnknownKeys(record, [
    "id",
    "name",
    "version",
    "apiVersion",
    "trust",
    "entrypoint",
    "exports",
    "capabilities",
    "auth",
    "permissions",
    "defaultPolicy",
    "config",
    "description",
  ], "manifest");

  const id = stringValue(record.id, "manifest.id", 64);
  if (!ID_PATTERN.test(id)) {
    throw new PluginManifestError(
      "manifest.id must be lowercase letters, digits or dashes and start with a letter",
    );
  }
  const name = stringValue(record.name, "manifest.name", 120);
  const version = stringValue(record.version, "manifest.version", 64);
  if (!VERSION_PATTERN.test(version)) {
    throw new PluginManifestError("manifest.version must be a semantic version");
  }
  const apiVersion = stringValue(record.apiVersion, "manifest.apiVersion", 16);
  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginManifestError(
      `unsupported plugin apiVersion ${apiVersion}; expected ${PLUGIN_API_VERSION}`,
    );
  }
  if (record.trust !== "builtin") {
    throw new PluginManifestError("V1 only accepts trust=builtin plugins");
  }
  const entrypoint = stringValue(record.entrypoint, "manifest.entrypoint", 200);
  if (!entrypoint.startsWith("builtin:")) {
    throw new PluginManifestError("entrypoint must use the builtin: namespace");
  }

  const exports = asRecord(record.exports, "manifest.exports");
  rejectUnknownKeys(exports, ["tools", "skills"], "manifest.exports");
  const exportedTools = stringArray(exports.tools, "manifest.exports.tools", 50);
  const exportedSkills = stringArray(exports.skills, "manifest.exports.skills", 50);

  const capabilitiesRaw = record.capabilities;
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length > 50) {
    throw new PluginManifestError("manifest.capabilities must be an array");
  }
  const capabilities = capabilitiesRaw.map((item, index) =>
    parseCapability(item, `manifest.capabilities[${index}]`),
  );

  const auth = stringArray(record.auth, "manifest.auth", 20).map((item) => {
    if (!PERMISSION_PATTERN.test(item)) {
      throw new PluginManifestError("manifest.auth entries must be lowercase identifiers");
    }
    return item;
  });
  const permissions = stringArray(record.permissions, "manifest.permissions", 50).map(
    (item) => {
      if (!PERMISSION_PATTERN.test(item)) {
        throw new PluginManifestError(
          "manifest.permissions entries must be lowercase identifiers",
        );
      }
      return item;
    },
  );

  const defaultPolicy = record.defaultPolicy;
  if (defaultPolicy !== "enabled" && defaultPolicy !== "disabled") {
    throw new PluginManifestError("defaultPolicy must be enabled or disabled");
  }
  const config = asRecord(record.config, "manifest.config");
  assertNoSecretConfig(config, "manifest.config");

  const description =
    record.description === undefined
      ? undefined
      : stringValue(record.description, "manifest.description", 2_000);

  return {
    id,
    name,
    version,
    apiVersion,
    trust: "builtin",
    entrypoint,
    exports: { tools: exportedTools, skills: exportedSkills },
    capabilities,
    auth,
    permissions,
    defaultPolicy,
    config,
    description,
  };
}

/**
 * Reject duplicate ids/tools and namespace escapes before any lifecycle code
 * runs. A plugin may only export tools and skills under its own id.
 */
export function validatePluginSet(manifests: readonly PluginManifest[]): void {
  const ids = new Set<string>();
  const tools = new Set<string>();
  const skills = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) {
      throw new PluginManifestError(`duplicate plugin id: ${manifest.id}`);
    }
    ids.add(manifest.id);

    const declared = new Set(manifest.capabilities.map((item) => item.name));
    if (declared.size !== manifest.capabilities.length) {
      throw new PluginManifestError(`plugin ${manifest.id} has duplicate capabilities`);
    }
    for (const name of manifest.exports.tools) {
      if (!declared.has(name)) {
        throw new PluginManifestError(
          `plugin ${manifest.id} exports ${name} without a capability declaration`,
        );
      }
      if (!name.startsWith(`${manifest.id}.`)) {
        throw new PluginManifestError(
          `tool ${name} is outside the ${manifest.id}. namespace`,
        );
      }
      if (tools.has(name)) {
        throw new PluginManifestError(`duplicate tool across plugins: ${name}`);
      }
      tools.add(name);
    }
    for (const name of manifest.exports.skills) {
      if (!name.startsWith(`${manifest.id}.`)) {
        throw new PluginManifestError(
          `skill ${name} is outside the ${manifest.id}. namespace`,
        );
      }
      if (skills.has(name)) {
        throw new PluginManifestError(`duplicate skill across plugins: ${name}`);
      }
      skills.add(name);
    }
    const resourceSet = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (
        capability.resource !== manifest.id &&
        !capability.resource.startsWith(`${manifest.id}.`)
      ) {
        throw new PluginManifestError(
          `resource ${capability.resource} is outside the ${manifest.id} namespace`,
        );
      }
      if (resourceSet.has(capability.resource)) {
        // Reusing one resource across tools in the same plugin is valid.
        continue;
      }
      resourceSet.add(capability.resource);
    }
  }
}

function parseCapability(value: unknown, field: string): PluginToolCapability {
  const record = asRecord(value, field);
  rejectUnknownKeys(record, [
    "name",
    "resource",
    "readOnly",
    "replayPolicy",
    "timeoutMs",
    "permissions",
    "operations",
    "guidance",
    "description",
  ], field);

  const name = stringValue(record.name, `${field}.name`, 128);
  if (!TOOL_PATTERN.test(name)) {
    throw new PluginManifestError(
      `${field}.name must be a lowercase dotted tool name`,
    );
  }
  const resource = stringValue(record.resource, `${field}.resource`, 64);
  if (!RESOURCE_PATTERN.test(resource)) {
    throw new PluginManifestError(
      `${field}.resource must be a lowercase identifier`,
    );
  }
  if (typeof record.readOnly !== "boolean") {
    throw new PluginManifestError(`${field}.readOnly must be a boolean`);
  }
  const replayPolicy = record.replayPolicy;
  if (replayPolicy !== "verify" && replayPolicy !== "never") {
    throw new PluginManifestError(`${field}.replayPolicy must be verify or never`);
  }
  const timeoutRaw = record.timeoutMs;
  if (
    typeof timeoutRaw !== "number" ||
    !Number.isInteger(timeoutRaw) ||
    timeoutRaw < 100 ||
    timeoutRaw > 120_000
  ) {
    throw new PluginManifestError(
      `${field}.timeoutMs must be an integer between 100 and 120000`,
    );
  }
  const permissions = stringArray(record.permissions ?? [], `${field}.permissions`, 20).map(
    (item) => {
      if (!PERMISSION_PATTERN.test(item)) {
        throw new PluginManifestError(
          `${field}.permissions entries must be lowercase identifiers`,
        );
      }
      return item;
    },
  );
  const operations = stringArray(record.operations ?? [], `${field}.operations`, 50).map(
    (item) => {
      if (!PERMISSION_PATTERN.test(item)) {
        throw new PluginManifestError(
          `${field}.operations entries must be lowercase identifiers`,
        );
      }
      return item;
    },
  );
  const guidance =
    record.guidance === undefined
      ? undefined
      : stringValue(record.guidance, `${field}.guidance`, 4_000);
  const description =
    record.description === undefined
      ? undefined
      : stringValue(record.description, `${field}.description`, 2_000);

  return {
    name,
    resource,
    readOnly: record.readOnly,
    replayPolicy,
    timeoutMs: timeoutRaw,
    permissions,
    operations,
    guidance,
    description,
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginManifestError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new PluginManifestError(`${field} must be a non-empty string <= ${max} chars`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new PluginManifestError(`${field} must be an array with at most ${max} items`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) {
      throw new PluginManifestError(`${field} entries must be non-empty strings`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new PluginManifestError(`${field} entries must be non-empty strings`);
    }
    if (seen.has(trimmed)) {
      throw new PluginManifestError(`${field} contains duplicate ${trimmed}`);
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new PluginManifestError(`${field} has unknown key ${key}`);
    }
  }
}

function assertNoSecretConfig(value: unknown, field: string, depth = 0): void {
  if (depth > 5) {
    throw new PluginManifestError(`${field} is nested too deeply`);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretConfig(item, `${field}[${index}]`, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const isEnvName = /(?:env|variable|name|ref)$/i.test(key);
    if (!isEnvName && SECRET_KEY_PATTERN.test(key)) {
      throw new PluginManifestError(
        `${field}.${key} looks like a secret; manifests may only declare env names`,
      );
    }
    if (
      !isEnvName &&
      typeof item === "string" &&
      /^(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)/.test(item)
    ) {
      throw new PluginManifestError(`${field}.${key} contains a credential-looking value`);
    }
    assertNoSecretConfig(item, `${field}.${key}`, depth + 1);
  }
}
