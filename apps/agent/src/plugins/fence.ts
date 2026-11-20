import type { ActionRecord, TaskRecord } from "../domain/types.ts";

export interface PluginToolBinding {
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  catalogGeneration: number;
  permissions: string[];
}

/**
 * Core-side authority check for plugin-provided tools. The catalog is the
 * only source for tool metadata; this interface keeps ActionService unaware
 * of plugin lifecycle internals.
 */
export interface CapabilityFence {
  generation(): number;
  bindingForTool(name: string): PluginToolBinding | undefined;
  /** Reject a new proposal when the task/catalog pair is stale. */
  checkProposal(task: TaskRecord, toolName: string): string | undefined;
  /** True when the task's ExtensionPolicy forces an owner approval. */
  requiresApproval(task: TaskRecord, toolName: string): boolean;
  /** Re-check immediately before acting on a previously approved action. */
  checkAction(
    action: ActionRecord,
    task: TaskRecord,
    toolName: string,
  ): string | undefined;
}

/** What Router/Worker may see about the live catalog. */
export interface CapabilityView {
  generation(): number;
  toolNames(): string[];
  resources(): string[];
  resourceForTool(name: string): string | undefined;
  toolInfo(name: string): CapabilityInfo | undefined;
}

export interface CapabilityInfo {
  name: string;
  resource?: string;
  readOnly: boolean;
  replayPolicy: "verify" | "never";
  timeoutMs: number;
  pluginId?: string;
  pluginVersion?: string;
  permissions: string[];
  operations: string[];
  guidance?: string;
  description?: string;
}
