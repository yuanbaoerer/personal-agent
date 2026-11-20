import type { ActionTool, ToolRegistry } from "../actions/tooling.ts";
import type {
  ActionRecord,
  TaskExtensionSnapshot,
  TaskRecord,
} from "../domain/types.ts";
import type { Store } from "../storage/store.ts";
import type {
  CapabilityFence,
  CapabilityInfo,
  CapabilityView,
  PluginToolBinding,
} from "./fence.ts";
import {
  pluginDigest,
  validatePluginSet,
  type PluginManifest,
  type PluginToolCapability,
} from "./manifest.ts";
import type {
  BuiltinPlugin,
  PluginChange,
  PluginConnection,
  PluginView,
} from "./types.ts";

const GENERATION_KEY = "extensions.catalog_generation";
const FINGERPRINT_KEY = "extensions.catalog_fingerprint";
const BASE_RESOURCES = ["chat", "weather"];

interface PluginRow {
  id: string;
  version: string;
  digest: string;
  enabled: number;
  status: "enabled" | "disabled" | "error";
  config_json: string;
  error: string | null;
  installed_at: string;
  updated_at: string;
  enabled_at: string | null;
  disabled_at: string | null;
}

interface CatalogEntry extends CapabilityInfo {
  tool: ActionTool;
  pluginVersion?: string;
  pluginDigest?: string;
}

export class PluginNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown plugin: ${id}`);
    this.name = "PluginNotFoundError";
  }
}

export interface PluginCatalogDeps {
  store: Store;
  registry: ToolRegistry;
  plugins: readonly BuiltinPlugin[];
  now?: () => Date;
}

/**
 * The single host-side capability catalog. It owns plugin lifecycle rows, the
 * atomic ToolRegistry swap, and the monotonic catalog generation used to fence
 * task proposals and approved actions.
 */
export class PluginCatalog implements CapabilityFence, CapabilityView {
  readonly #store: Store;
  readonly #registry: ToolRegistry;
  readonly #providers = new Map<string, BuiltinPlugin>();
  readonly #rows = new Map<string, PluginRow>();
  readonly #coreTools: ActionTool[];
  readonly #now: () => Date;
  #entries = new Map<string, CatalogEntry>();
  #generation = 0;
  #fingerprint = "";

  constructor(deps: PluginCatalogDeps) {
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#now = deps.now ?? (() => new Date());
    for (const plugin of deps.plugins) {
      if (this.#providers.has(plugin.manifest.id)) {
        throw new Error(`duplicate plugin id: ${plugin.manifest.id}`);
      }
      this.#providers.set(plugin.manifest.id, plugin);
    }
    validatePluginSet([...this.#providers.values()].map((plugin) => plugin.manifest));
    this.#coreTools = deps.registry.list();

    const existing = this.#store.db.all<PluginRow>(
      "SELECT * FROM pa_plugins ORDER BY id ASC",
    );
    for (const row of existing) {
      this.#rows.set(row.id, row);
    }
    for (const provider of this.#providers.values()) {
      this.#ensureRow(provider);
    }
    this.#rebuild("boot");
  }

  generation(): number {
    return this.#generation;
  }

  snapshot(): TaskExtensionSnapshot {
    const plugins = [...this.#providers.values()]
      .filter((plugin) => this.#rows.get(plugin.manifest.id)?.enabled === 1)
      .map((plugin) => ({
        id: plugin.manifest.id,
        version: plugin.manifest.version,
        digest: pluginDigest(plugin.manifest),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { catalogGeneration: this.#generation, plugins };
  }

  toolNames(): string[] {
    return [
      ...new Set([...this.#entries.keys(), ...this.#registry.names()]),
    ].sort();
  }

  resources(): string[] {
    return [
      ...new Set([
        ...BASE_RESOURCES,
        ...[...this.#entries.values()]
          .map((entry) => entry.resource)
          .filter((resource): resource is string => resource !== undefined),
        ...this.#registry
          .list()
          .map((tool) => tool.resource)
          .filter((resource): resource is string => resource !== undefined),
      ]),
    ].sort();
  }

  resourceForTool(name: string): string | undefined {
    return this.#entries.get(name)?.resource ?? this.#registry.get(name)?.resource;
  }

  toolInfo(name: string): CapabilityInfo | undefined {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      const tool = this.#registry.get(name);
      return tool === undefined ? undefined : coreEntry(tool);
    }
    return {
      name: entry.name,
      resource: entry.resource,
      readOnly: entry.readOnly,
      replayPolicy: entry.replayPolicy,
      timeoutMs: entry.timeoutMs,
      pluginId: entry.pluginId,
      pluginVersion: entry.pluginVersion,
      permissions: entry.permissions,
      operations: entry.operations,
      guidance: entry.guidance,
      description: entry.description,
    };
  }

  bindingForTool(name: string): PluginToolBinding | undefined {
    const entry = this.#entries.get(name);
    if (
      entry?.pluginId === undefined ||
      entry.pluginVersion === undefined ||
      entry.pluginDigest === undefined
    ) {
      return undefined;
    }
    return {
      pluginId: entry.pluginId,
      pluginVersion: entry.pluginVersion,
      pluginDigest: entry.pluginDigest,
      catalogGeneration: this.#generation,
      permissions: entry.permissions,
    };
  }

  checkProposal(task: TaskRecord, toolName: string): string | undefined {
    const entry = this.#entries.get(toolName);
    if (entry === undefined) {
      // Host-registered core/test tools can appear after catalog boot.
      return this.#registry.get(toolName) === undefined
        ? "plugin_not_enabled"
        : undefined;
    }
    const policyReason = this.#policyRejection(task, entry);
    if (policyReason !== undefined) {
      return policyReason;
    }
    if (entry.pluginId === undefined) {
      return undefined;
    }
    if (task.extension === undefined) {
      // Tasks created before the catalog existed keep read-only compatibility;
      // a write-like capability needs an explicit new task revision.
      return entry.readOnly ? undefined : "task_requires_reconfirmation";
    }
    const binding = task.extension.plugins.find(
      (plugin) => plugin.id === entry.pluginId,
    );
    if (binding === undefined) {
      return "plugin_not_in_task_snapshot";
    }
    if (task.extension.catalogGeneration !== this.#generation) {
      return "task_catalog_generation_changed";
    }
    if (
      binding.version !== entry.pluginVersion ||
      binding.digest !== entry.pluginDigest
    ) {
      return "plugin_version_changed";
    }
    return undefined;
  }

  requiresApproval(task: TaskRecord, toolName: string): boolean {
    const policy = task.extension?.policy;
    if (policy?.permissions === undefined) {
      return false;
    }
    const entry = this.#entries.get(toolName);
    if (entry === undefined) {
      return false;
    }
    return entry.permissions.some(
      (permission) => policy.permissions?.[permission] === "require_approval",
    );
  }

  checkAction(
    action: ActionRecord,
    task: TaskRecord,
    toolName: string,
  ): string | undefined {
    const entry = this.#entries.get(toolName);
    if (entry === undefined) {
      if (action.pluginId === undefined && this.#registry.get(toolName) !== undefined) {
        return undefined;
      }
      return "plugin_disabled";
    }
    if (entry.pluginId === undefined) {
      return action.pluginId === undefined ? undefined : "tool_binding_changed";
    }
    if (
      action.pluginId === undefined ||
      action.pluginVersion === undefined ||
      action.pluginDigest === undefined ||
      action.catalogGeneration === undefined
    ) {
      return "action_plugin_binding_missing";
    }
    if (
      action.pluginId !== entry.pluginId ||
      action.pluginVersion !== entry.pluginVersion ||
      action.pluginDigest !== entry.pluginDigest
    ) {
      return "plugin_version_changed";
    }
    if (action.catalogGeneration !== this.#generation) {
      return "catalog_generation_changed";
    }
    return this.checkProposal(task, toolName);
  }

  /**
   * A login, logout or account switch invalidates approvals bound to the old
   * credential even though the tool set is unchanged. The epoch is part of the
   * fingerprint, so the catalog generation advances.
   */
  rotateCredential(id: string, actorId: string): number {
    const provider = this.#providers.get(id);
    const row = this.#rows.get(id);
    if (provider === undefined || row === undefined) {
      throw new PluginNotFoundError(id);
    }
    const key = credentialKey(id);
    const current = Number(this.#store.metaGet(key) ?? "0");
    const next = Number.isInteger(current) && current >= 0 ? current + 1 : 1;
    const at = this.#now().toISOString();
    this.#store.metaSet(key, String(next));
    this.#rebuild("credential");
    this.#store.recordAudit({
      event: "plugin.credential_changed",
      subjectType: "plugin",
      subjectId: id,
      after: { actorId, credentialEpoch: next, generation: this.#generation },
      traceId: `plugin:${id}`,
      occurredAt: at,
    });
    return this.#generation;
  }

  #policyRejection(
    task: TaskRecord,
    entry: CatalogEntry,
  ): string | undefined {
    const policy = task.extension?.policy;
    if (policy === undefined) {
      return undefined;
    }
    if (
      policy.plugins !== undefined &&
      entry.pluginId !== undefined &&
      !policy.plugins.includes(entry.pluginId)
    ) {
      return "plugin_not_allowed_by_policy";
    }
    for (const permission of entry.permissions) {
      if (policy.permissions?.[permission] === "deny") {
        return "permission_denied_by_policy";
      }
    }
    return undefined;
  }

  async list(): Promise<PluginView[]> {
    const ids = [...this.#providers.keys()].sort();
    const views = await Promise.all(ids.map((id) => this.#view(id)));
    return views.filter((view): view is PluginView => view !== undefined);
  }

  async get(id: string): Promise<PluginView | undefined> {
    return this.#view(id);
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    actorId: string,
  ): Promise<PluginChange> {
    const provider = this.#providers.get(id);
    const row = this.#rows.get(id);
    if (provider === undefined || row === undefined) {
      throw new PluginNotFoundError(id);
    }

    const beforeTools = this.toolNamesFor(id);
    const already = row.enabled === 1;
    if (already === enabled && row.status !== "error") {
      const plugin = await this.#view(id);
      if (plugin === undefined) {
        throw new PluginNotFoundError(id);
      }
      return {
        changed: false,
        generation: this.#generation,
        plugin,
        addedTools: [],
        removedTools: [],
      };
    }

    const at = this.#now().toISOString();
    if (enabled) {
      row.enabled = 1;
      row.status = "enabled";
      row.error = null;
      row.enabled_at = at;
      row.disabled_at = null;
    } else {
      row.enabled = 0;
      row.status = "disabled";
      row.error = null;
      row.disabled_at = at;
    }
    row.updated_at = at;
    this.#saveRow(row);
    this.#rebuild(enabled ? "enable" : "disable");
    this.#store.recordAudit({
      event: enabled ? "plugin.enabled" : "plugin.disabled",
      subjectType: "plugin",
      subjectId: id,
      after: {
        actorId,
        version: provider.manifest.version,
        digest: pluginDigest(provider.manifest),
        generation: this.#generation,
      },
      traceId: `plugin:${id}`,
      occurredAt: at,
    });

    const afterTools = new Set(this.toolNamesFor(id));
    const beforeSet = new Set(beforeTools);
    const plugin = await this.#view(id);
    if (plugin === undefined) {
      throw new PluginNotFoundError(id);
    }
    return {
      changed: true,
      generation: this.#generation,
      plugin,
      addedTools: afterTools.size === 0 ? [] : [...afterTools].filter((name) => !beforeSet.has(name)),
      removedTools: beforeTools.filter((name) => !afterTools.has(name)),
    };
  }

  close(): void {
    for (const plugin of this.#providers.values()) {
      plugin.close?.();
    }
  }

  toolNamesFor(id: string): string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.pluginId === id)
      .map((entry) => entry.name)
      .sort();
  }

  #ensureRow(provider: BuiltinPlugin): void {
    const manifest = provider.manifest;
    const digest = pluginDigest(manifest);
    const at = this.#now().toISOString();
    const existing = this.#rows.get(manifest.id);
    if (existing === undefined) {
      const enabled =
        manifest.defaultPolicy === "enabled" && provider.configured;
      const row: PluginRow = {
        id: manifest.id,
        version: manifest.version,
        digest,
        enabled: enabled ? 1 : 0,
        status: enabled ? "enabled" : "disabled",
        config_json: JSON.stringify(manifest.config),
        error: null,
        installed_at: at,
        updated_at: at,
        enabled_at: enabled ? at : null,
        disabled_at: enabled ? null : at,
      };
      this.#rows.set(manifest.id, row);
      this.#store.db.run(
        `INSERT INTO pa_plugins
          (id, version, digest, enabled, status, config_json, error,
           installed_at, updated_at, enabled_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        row.id,
        row.version,
        row.digest,
        row.enabled,
        row.status,
        row.config_json,
        row.installed_at,
        row.updated_at,
        row.enabled_at,
        row.disabled_at,
      );
      this.#store.recordAudit({
        event: "plugin.installed",
        subjectType: "plugin",
        subjectId: row.id,
        after: { version: row.version, digest: row.digest, enabled: row.enabled === 1 },
        traceId: `plugin:${row.id}`,
        occurredAt: at,
      });
      return;
    }

    if (existing.version !== manifest.version || existing.digest !== digest) {
      const before = {
        version: existing.version,
        digest: existing.digest,
      };
      existing.version = manifest.version;
      existing.digest = digest;
      existing.config_json = JSON.stringify(manifest.config);
      existing.updated_at = at;
      this.#saveRow(existing);
      this.#store.recordAudit({
        event: "plugin.updated",
        subjectType: "plugin",
        subjectId: existing.id,
        before,
        after: { version: manifest.version, digest },
        traceId: `plugin:${existing.id}`,
        occurredAt: at,
      });
    }
  }

  /**
   * Rebuild the complete snapshot off to the side, then swap the live registry
   * once. A plugin that returns undeclared or duplicate tools is disabled for
   * this generation without taking down the Core.
   */
  #rebuild(reason: "boot" | "enable" | "disable" | "credential"): void {
    const next = new Map<string, CatalogEntry>();
    const tools: ActionTool[] = [...this.#coreTools];
    for (const tool of this.#coreTools) {
      next.set(tool.name, coreEntry(tool));
    }

    for (const provider of this.#providers.values()) {
      const row = this.#rows.get(provider.manifest.id);
      if (row === undefined) {
        continue;
      }
      if (row.enabled !== 1) {
        if (row.status !== "disabled" || row.error !== null) {
          row.status = "disabled";
          row.error = null;
          row.updated_at = this.#now().toISOString();
          this.#saveRow(row);
        }
        continue;
      }
      try {
        const created = provider.createTools();
        const accepted: CatalogEntry[] = [];
        for (const tool of created) {
          const declaration = provider.manifest.capabilities.find(
            (item) => item.name === tool.name,
          );
          if (declaration === undefined) {
            throw new Error(`tool ${tool.name} is not declared by ${provider.manifest.id}`);
          }
          assertToolMatchesDeclaration(provider.manifest, declaration, tool);
          if (next.has(tool.name)) {
            throw new Error(`tool name conflict: ${tool.name}`);
          }
          accepted.push(pluginEntry(provider.manifest, declaration, tool));
        }
        for (const entry of accepted) {
          next.set(entry.name, entry);
          tools.push(entry.tool);
        }
        if (row.status !== "enabled" || row.error !== null) {
          row.status = "enabled";
          row.error = null;
          row.updated_at = this.#now().toISOString();
          this.#saveRow(row);
        }
      } catch (error) {
        const message = truncate(
          error instanceof Error ? error.message : String(error),
          500,
        );
        row.status = "error";
        row.error = message;
        row.updated_at = this.#now().toISOString();
        this.#saveRow(row);
        this.#store.recordAudit({
          event: "plugin.error",
          subjectType: "plugin",
          subjectId: provider.manifest.id,
          after: { reason: message },
          traceId: `plugin:${provider.manifest.id}`,
          occurredAt: row.updated_at,
        });
      }
    }

    this.#registry.swap(tools);
    this.#entries = next;
    this.#publishSnapshot(reason);
  }

  #publishSnapshot(reason: "boot" | "enable" | "disable" | "credential"): void {
    const fingerprint = this.#computeFingerprint();
    const rawGeneration = Number(this.#store.metaGet(GENERATION_KEY) ?? "0");
    const storedGeneration =
      Number.isInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : 0;
    const storedFingerprint = this.#store.metaGet(FINGERPRINT_KEY);
    let generation: number;
    if (storedFingerprint === fingerprint && storedGeneration > 0) {
      generation = storedGeneration;
    } else {
      generation = Math.max(1, storedGeneration + 1);
    }
    const changed = generation !== this.#generation || fingerprint !== this.#fingerprint;
    this.#generation = generation;
    this.#fingerprint = fingerprint;
    this.#store.metaSet(GENERATION_KEY, String(generation));
    this.#store.metaSet(FINGERPRINT_KEY, fingerprint);

    if (changed && reason !== "boot") {
      this.#store.recordAudit({
        event: "plugin.catalog_published",
        subjectType: "plugin_catalog",
        subjectId: "catalog",
        after: {
          generation,
          reason,
          tools: this.toolNames(),
          plugins: this.snapshot().plugins,
        },
        traceId: "plugin:catalog",
        occurredAt: this.#now().toISOString(),
      });
    }
  }

  #computeFingerprint(): string {
    const parts: string[] = [];
    for (const id of [...this.#providers.keys()].sort()) {
      const plugin = this.#providers.get(id) as BuiltinPlugin;
      const row = this.#rows.get(id);
      if (row === undefined) {
        continue;
      }
      const tools = this.toolNamesFor(id);
      parts.push(
        JSON.stringify({
          id,
          version: plugin.manifest.version,
          digest: pluginDigest(plugin.manifest),
          enabled: row.enabled === 1,
          status: row.status,
          credentialEpoch: this.#credentialEpoch(id),
          tools,
        }),
      );
    }
    return parts.join("|");
  }

  #credentialEpoch(id: string): number {
    const raw = Number(this.#store.metaGet(credentialKey(id)) ?? "0");
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
  }

  #saveRow(row: PluginRow): void {
    this.#store.db.run(
      `UPDATE pa_plugins
       SET version = ?, digest = ?, enabled = ?, status = ?, config_json = ?,
           error = ?, updated_at = ?, enabled_at = ?, disabled_at = ?
       WHERE id = ?`,
      row.version,
      row.digest,
      row.enabled,
      row.status,
      row.config_json,
      row.error,
      row.updated_at,
      row.enabled_at,
      row.disabled_at,
      row.id,
    );
    this.#rows.set(row.id, row);
  }

  async #view(id: string): Promise<PluginView | undefined> {
    const provider = this.#providers.get(id);
    const row = this.#rows.get(id);
    if (provider === undefined || row === undefined) {
      return undefined;
    }
    let connection: PluginConnection;
    try {
      connection = await provider.connection();
    } catch {
      connection = { status: "error", detail: "connection check failed" };
    }
    return {
      id,
      name: provider.manifest.name,
      version: provider.manifest.version,
      apiVersion: provider.manifest.apiVersion,
      trust: provider.manifest.trust,
      digest: pluginDigest(provider.manifest),
      enabled: row.enabled === 1,
      lifecycle:
        row.status === "error"
          ? "error"
          : row.enabled === 1
            ? "enabled"
            : "disabled",
      connection,
      auth: [...provider.manifest.auth],
      permissions: [...provider.manifest.permissions],
      tools: [...provider.manifest.exports.tools],
      activeTools: this.toolNamesFor(id),
      defaultPolicy: provider.manifest.defaultPolicy,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      lastError: row.error ?? undefined,
    };
  }
}

function coreEntry(tool: ActionTool): CatalogEntry {
  return {
    tool,
    name: tool.name,
    resource: tool.resource,
    readOnly: tool.readOnly === true,
    replayPolicy: tool.replayPolicy ?? "never",
    timeoutMs: tool.timeoutMs ?? 15_000,
    permissions: [],
    operations: [],
    guidance: undefined,
    description: tool.description,
  };
}

function pluginEntry(
  manifest: PluginManifest,
  declaration: PluginToolCapability,
  tool: ActionTool,
): CatalogEntry {
  return {
    tool,
    name: tool.name,
    resource: declaration.resource,
    readOnly: declaration.readOnly,
    replayPolicy: declaration.replayPolicy,
    timeoutMs: tool.timeoutMs ?? declaration.timeoutMs,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    pluginDigest: pluginDigest(manifest),
    permissions: [...declaration.permissions],
    operations: [...declaration.operations],
    guidance: declaration.guidance,
    description: declaration.description,
  };
}

function assertToolMatchesDeclaration(
  manifest: PluginManifest,
  declaration: PluginToolCapability,
  tool: ActionTool,
): void {
  if (
    tool.resource !== declaration.resource ||
    (tool.readOnly === true) !== declaration.readOnly ||
    (tool.replayPolicy ?? "never") !== declaration.replayPolicy
  ) {
    throw new Error(
      `tool ${tool.name} does not match its ${manifest.id} manifest declaration`,
    );
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function credentialKey(id: string): string {
  return `extensions.credential.${id}`;
}
