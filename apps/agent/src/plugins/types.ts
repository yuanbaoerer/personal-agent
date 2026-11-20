import type { ActionTool } from "../actions/tooling.ts";
import type { PluginManifest } from "./manifest.ts";

export type PluginConnectionStatus =
  | "unconfigured"
  | "connected"
  | "expired"
  | "revoked"
  | "error";

export interface PluginConnection {
  status: PluginConnectionStatus;
  /** Display identity only; never a token. */
  account?: string;
  scopes?: string[];
  detail?: string;
}

/**
 * A trusted, statically linked builtin plugin. V1 never downloads or imports
 * third-party code: the host constructs this object at build time.
 */
export interface BuiltinPlugin {
  readonly manifest: PluginManifest;
  /** Whether host configuration can currently supply the declared tools. */
  readonly configured: boolean;
  createTools(): ActionTool[];
  connection(): PluginConnection | Promise<PluginConnection>;
  close?(): void;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  trust: "builtin";
  digest: string;
  enabled: boolean;
  lifecycle: "enabled" | "disabled" | "error";
  connection: PluginConnection;
  auth: string[];
  permissions: string[];
  tools: string[];
  activeTools: string[];
  defaultPolicy: "enabled" | "disabled";
  installedAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface PluginChange {
  changed: boolean;
  generation: number;
  plugin: PluginView;
  addedTools: string[];
  removedTools: string[];
}

export interface PluginLifecycleResult extends PluginChange {
  revokedActions: number;
  inFlightActions: number;
}
