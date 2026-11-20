import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  ToolRejectedError,
  type ActionTool,
  type ToolExecution,
  type ToolVerification,
} from "../actions/tooling.ts";
import { parsePluginManifest, type PluginManifest } from "./manifest.ts";
import type { BuiltinPlugin, PluginConnection } from "./types.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_SUFFIX = /^[a-z][a-z0-9_.-]{0,100}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const AUTH_ENV = /^PA_MCP_[A-Z0-9_]{1,80}$/;
const MAX_TOOLS = 50;
const MAX_TEXT_BYTES = 32 * 1024;

export interface McpArgSpec {
  type: "string" | "number" | "boolean";
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: string[];
}

export interface McpToolDefinition {
  /** Exact tool name advertised by the remote server. */
  remoteName: string;
  /** Local suffix; the catalog exposes `<server-id>.<name>`. */
  name: string;
  resource?: string;
  description?: string;
  timeoutMs?: number;
  args?: Record<string, McpArgSpec>;
}

export interface McpServerDefinition {
  id: string;
  name: string;
  version?: string;
  url: string;
  /** Environment variable holding the bearer token; never a token itself. */
  authEnv?: string;
  /** Explicit opt-in for http://localhost test servers only. */
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
  tools: McpToolDefinition[];
}

export interface McpConnectOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface McpPluginResult {
  plugin: BuiltinPlugin;
  error?: string;
}

/**
 * Connect one explicitly configured remote MCP server and expose only the
 * allowlisted tools as read-only ActionTools. Discovery can confirm presence
 * but can never add a capability that the host config did not declare.
 */
export async function connectMcpPlugin(
  definition: McpServerDefinition,
  options: McpConnectOptions = {},
): Promise<McpPluginResult> {
  const normalized = normalizeDefinition(definition);
  const manifest = mcpManifest(normalized);
  const timeoutMs = normalized.timeoutMs ?? 15_000;
  let failure: string | undefined;
  let client: Client | undefined;
  try {
    await assertSafeUrl(normalized.url, normalized.allowInsecureLocalhost === true);
    const token = resolveAuth(normalized, options.env ?? process.env);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
    };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(normalized.url), {
      requestInit: {
        headers,
        redirect: "error",
      },
      fetch: options.fetch,
    });
    client = new Client(
      { name: "personal-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), timeoutMs, "connect");
    const listed = await listAllTools(client, timeoutMs);
    const remoteNames = new Set(listed.map((tool) => tool.name));
    for (const tool of normalized.tools) {
      if (!remoteNames.has(tool.remoteName)) {
        throw new Error(`declared MCP tool is missing remotely: ${tool.remoteName}`);
      }
    }

    return {
      plugin: providerFor(normalized, manifest, client),
    };
  } catch (error) {
    failure = errorMessage(error);
    void client?.close();
  }

  // A failed connection still yields a manifest so the catalog can show the
  // plugin as installed/error and keep all tools unavailable.
  return {
    plugin: {
      manifest,
      configured: false,
      createTools(): ActionTool[] {
        throw new Error(failure ?? "MCP connection unavailable");
      },
      connection(): PluginConnection {
        return { status: "error", detail: failure ?? "MCP connection unavailable" };
      },
    },
    error: failure,
  };
}

export async function connectMcpPlugins(
  definitions: readonly McpServerDefinition[],
  options: McpConnectOptions = {},
): Promise<{ plugins: BuiltinPlugin[]; errors: { id: string; error: string }[] }> {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`duplicate MCP server id: ${definition.id}`);
    }
    ids.add(definition.id);
  }
  const plugins: BuiltinPlugin[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const definition of definitions) {
    try {
      const result = await connectMcpPlugin(definition, options);
      plugins.push(result.plugin);
      if (result.error !== undefined) {
        errors.push({ id: definition.id, error: result.error });
      }
    } catch (error) {
      errors.push({ id: definition.id, error: errorMessage(error) });
    }
  }
  return { plugins, errors };
}

export function parseMcpServers(value: unknown): McpServerDefinition[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP config must be an object with servers[]");
  }
  const record = value as Record<string, unknown>;
  const servers = record.servers;
  if (!Array.isArray(servers) || servers.length > 20) {
    throw new Error("MCP config.servers must be an array with at most 20 entries");
  }
  return servers.map((item, index) => normalizeDefinition(parseServer(item, index)));
}

function parseServer(value: unknown, index: number): McpServerDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`servers[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id, `servers[${index}].id`, 64);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`servers[${index}].id is invalid`);
  }
  const name = stringValue(record.name, `servers[${index}].name`, 120);
  const url = stringValue(record.url, `servers[${index}].url`, 2_000);
  const authEnv =
    record.authEnv === undefined
      ? undefined
      : stringValue(record.authEnv, `servers[${index}].authEnv`, 100);
  if (authEnv !== undefined && !AUTH_ENV.test(authEnv)) {
    throw new Error(
      `servers[${index}].authEnv must start with PA_MCP_ to avoid leaking host credentials`,
    );
  }
  if (record.allowInsecureLocalhost !== undefined && typeof record.allowInsecureLocalhost !== "boolean") {
    throw new Error(`servers[${index}].allowInsecureLocalhost must be a boolean`);
  }
  const timeoutMs = optionalInteger(record.timeoutMs, `servers[${index}].timeoutMs`, 500, 120_000);
  if (!Array.isArray(record.tools) || record.tools.length === 0 || record.tools.length > MAX_TOOLS) {
    throw new Error(`servers[${index}].tools must contain 1-${MAX_TOOLS} entries`);
  }
  const tools = record.tools.map((tool, toolIndex) =>
    parseTool(tool, `servers[${index}].tools[${toolIndex}]`),
  );
  const version =
    record.version === undefined
      ? undefined
      : stringValue(record.version, `servers[${index}].version`, 64);
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    throw new Error(`servers[${index}].version must be a semantic version`);
  }
  return {
    id,
    name,
    version,
    url,
    authEnv,
    allowInsecureLocalhost: record.allowInsecureLocalhost === true,
    timeoutMs,
    tools,
  };
}

function parseTool(value: unknown, field: string): McpToolDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const remoteName = stringValue(record.remoteName, `${field}.remoteName`, 200);
  const name = stringValue(record.name, `${field}.name`, 100);
  if (!TOOL_SUFFIX.test(name)) {
    throw new Error(`${field}.name must be a lowercase identifier`);
  }
  const argsRecord = record.args;
  let args: Record<string, McpArgSpec> | undefined;
  if (argsRecord !== undefined) {
    if (argsRecord === null || typeof argsRecord !== "object" || Array.isArray(argsRecord)) {
      throw new Error(`${field}.args must be an object`);
    }
    args = {};
    for (const [key, spec] of Object.entries(argsRecord)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
        throw new Error(`${field}.args has invalid key ${key}`);
      }
      args[key] = parseArg(spec, `${field}.args.${key}`);
    }
  }
  const resource =
    record.resource === undefined
      ? undefined
      : stringValue(record.resource, `${field}.resource`, 64);
  const description =
    record.description === undefined
      ? undefined
      : stringValue(record.description, `${field}.description`, 2_000);
  const timeoutMs = optionalInteger(record.timeoutMs, `${field}.timeoutMs`, 500, 120_000);
  return { remoteName, name, resource, description, timeoutMs, args };
}

function parseArg(value: unknown, field: string): McpArgSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "string" && type !== "number" && type !== "boolean") {
    throw new Error(`${field}.type must be string, number or boolean`);
  }
  const spec: McpArgSpec = { type };
  if (record.required !== undefined) {
    if (typeof record.required !== "boolean") {
      throw new Error(`${field}.required must be a boolean`);
    }
    spec.required = record.required;
  }
  if (record.maxLength !== undefined) {
    spec.maxLength = optionalInteger(record.maxLength, `${field}.maxLength`, 1, 10_000);
  }
  if (record.min !== undefined) {
    spec.min = optionalNumber(record.min, `${field}.min`);
  }
  if (record.max !== undefined) {
    spec.max = optionalNumber(record.max, `${field}.max`);
  }
  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum) || record.enum.length === 0 || record.enum.length > 50) {
      throw new Error(`${field}.enum must be a non-empty array`);
    }
    if (!record.enum.every((item) => typeof item === "string")) {
      throw new Error(`${field}.enum entries must be strings`);
    }
    if (type !== "string") {
      throw new Error(`${field}.enum is only supported for string arguments`);
    }
    spec.enum = record.enum as string[];
  }
  return spec;
}

function normalizeDefinition(definition: McpServerDefinition): McpServerDefinition {
  const id = definition.id.trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error("MCP server id is invalid");
  }
  const names = new Set<string>();
  const tools = definition.tools.map((tool) => {
    if (names.has(tool.name)) {
      throw new Error(`duplicate MCP tool name: ${id}.${tool.name}`);
    }
    names.add(tool.name);
    const resource = tool.resource ?? id;
    if (resource !== id && !resource.startsWith(`${id}.`)) {
      throw new Error(`MCP tool resource ${resource} is outside the ${id} namespace`);
    }
    return {
      ...tool,
      resource,
    };
  });
  return {
    ...definition,
    id,
    tools,
    timeoutMs: definition.timeoutMs ?? 15_000,
  };
}

function mcpManifest(definition: McpServerDefinition): PluginManifest {
  return parsePluginManifest({
    id: definition.id,
    name: definition.name,
    version: definition.version ?? "0.1.0",
    apiVersion: "1",
    trust: "builtin",
    entrypoint: "builtin:mcp",
    exports: {
      tools: definition.tools.map((tool) => `${definition.id}.${tool.name}`),
      skills: [],
    },
    capabilities: definition.tools.map((tool) => ({
      name: `${definition.id}.${tool.name}`,
      resource: tool.resource ?? definition.id,
      readOnly: true,
      replayPolicy: "verify",
      timeoutMs: tool.timeoutMs ?? definition.timeoutMs ?? 15_000,
      permissions: [`${definition.id}.read`],
      operations: ["read"],
      description: tool.description,
    })),
    auth: definition.authEnv === undefined ? [] : ["bearer-env"],
    permissions: [`${definition.id}.read`],
    defaultPolicy: "enabled",
    config: {
      url: definition.url,
      authEnv: definition.authEnv,
      tools: definition.tools.map((tool) => tool.remoteName),
    },
    description: `Remote read-only MCP server ${definition.name}`,
  });
}

function providerFor(
  definition: McpServerDefinition,
  manifest: PluginManifest,
  client: Client,
): BuiltinPlugin {
  const tools = definition.tools.map((definitionTool) =>
    mcpTool(definition, definitionTool, client),
  );
  return {
    manifest,
    configured: true,
    createTools(): ActionTool[] {
      return tools;
    },
    connection(): PluginConnection {
      return { status: "connected", detail: `${definition.tools.length} allowlisted tool(s)` };
    },
    close(): void {
      void client.close();
    },
  };
}

function mcpTool(
  server: McpServerDefinition,
  tool: McpToolDefinition,
  client: Client,
): ActionTool {
  const localName = `${server.id}.${tool.name}`;
  const timeoutMs = tool.timeoutMs ?? server.timeoutMs ?? 15_000;
  return {
    name: localName,
    resource: tool.resource ?? server.id,
    readOnly: true,
    replayPolicy: "verify",
    timeoutMs,
    description: tool.description,
    canonicalize(args: Record<string, unknown>): Record<string, unknown> {
      return canonicalArgs(tool, args);
    },
    async execute(args: Record<string, unknown>): Promise<ToolExecution> {
      const canonical = canonicalArgs(tool, args);
      let result;
      try {
        result = await client.callTool(
          { name: tool.remoteName, arguments: canonical },
          undefined,
          { timeout: Math.max(500, timeoutMs - 500) },
        );
      } catch (error) {
        throw new ToolRejectedError(
          `MCP call failed: ${errorMessage(error)}`,
        );
      }
      const evidence = mcpEvidence(server, tool, result);
      if (result.isError === true) {
        throw new ToolRejectedError("MCP server reported a tool error");
      }
      return {
        evidence,
        externalRef: `mcp:${server.id}:${tool.remoteName}`,
      };
    },
    async verify(args: Record<string, unknown>): Promise<ToolVerification> {
      canonicalArgs(tool, args);
      return {
        satisfied: false,
        evidence: { readOnly: true, server: server.id, tool: tool.remoteName },
      };
    },
  };
}

function canonicalArgs(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolRejectedError("MCP arguments must be an object");
  }
  const specs = tool.args ?? {};
  const allowed = new Set(Object.keys(specs));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new ToolRejectedError(`MCP argument not allowed: ${key}`);
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = args[key];
    if (value === undefined) {
      if (spec.required === true) {
        throw new ToolRejectedError(`MCP argument required: ${key}`);
      }
      continue;
    }
    if (spec.type === "string") {
      if (typeof value !== "string") {
        throw new ToolRejectedError(`MCP argument ${key} must be a string`);
      }
      if (value.length > (spec.maxLength ?? 2_000)) {
        throw new ToolRejectedError(`MCP argument ${key} is too long`);
      }
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        throw new ToolRejectedError(`MCP argument ${key} is not an allowed value`);
      }
      result[key] = value;
      continue;
    }
    if (spec.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ToolRejectedError(`MCP argument ${key} must be a number`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new ToolRejectedError(`MCP argument ${key} is below the minimum`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new ToolRejectedError(`MCP argument ${key} is above the maximum`);
      }
      result[key] = value;
      continue;
    }
    if (typeof value !== "boolean") {
      throw new ToolRejectedError(`MCP argument ${key} must be a boolean`);
    }
    result[key] = value;
  }
  return result;
}

function mcpEvidence(
  server: McpServerDefinition,
  tool: McpToolDefinition,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  let textBytes = 0;
  let truncated = false;
  const blocks: Record<string, unknown>[] = [];
  for (const block of content.slice(0, 20)) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const remaining = MAX_TEXT_BYTES - textBytes;
      const text = truncateUtf8(record.text, remaining);
      if (text.length !== record.text.length) {
        truncated = true;
      }
      textBytes += Buffer.byteLength(text, "utf8");
      blocks.push({ type: "text", text });
      continue;
    }
    blocks.push({ type: typeof record.type === "string" ? record.type : "unknown" });
  }
  if (content.length > 20) {
    truncated = true;
  }
  let structuredContent: unknown;
  if (result.structuredContent !== undefined) {
    const serialized = JSON.stringify(result.structuredContent);
    if (Buffer.byteLength(serialized, "utf8") <= 8 * 1024) {
      structuredContent = result.structuredContent;
    } else {
      truncated = true;
    }
  }
  return {
    server: server.id,
    tool: tool.remoteName,
    content: blocks,
    truncated,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function listAllTools(
  client: Client,
  timeoutMs: number,
): Promise<{ name: string }[]> {
  return listAllToolsInner(client, timeoutMs);
}

async function listAllToolsInner(
  client: Client,
  timeoutMs: number,
): Promise<{ name: string }[]> {
  const tools: { name: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await withTimeout(
      client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: timeoutMs,
      }),
      timeoutMs,
      "listTools",
    );
    tools.push(...listed.tools.map((tool) => ({ name: tool.name })));
    if (listed.nextCursor === undefined || listed.nextCursor.length === 0) {
      return tools;
    }
    cursor = listed.nextCursor;
    if (tools.length > 500) {
      throw new Error("MCP tools/list exceeded 500 entries");
    }
  }
  throw new Error("MCP tools/list exceeded 10 pages");
}

function resolveAuth(
  definition: McpServerDefinition,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (definition.authEnv === undefined) {
    return undefined;
  }
  const value = env[definition.authEnv]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`MCP auth is missing: ${definition.authEnv}`);
  }
  return value;
}

async function assertSafeUrl(raw: string, allowLocalhost: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP url is invalid");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("MCP url must not contain credentials");
  }
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const localhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (url.protocol !== "https:" && !(allowLocalhost && localhost && url.protocol === "http:")) {
    throw new Error("MCP url must use https (http is only allowed for explicit localhost tests)");
  }
  if (isIP(hostname) !== 0) {
    if (!(allowLocalhost && localhost) && isPrivateAddress(hostname)) {
      throw new Error("MCP url resolves to a private address");
    }
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((address) => isPrivateAddress(address.address))
  ) {
    if (!(allowLocalhost && localhost)) {
      throw new Error("MCP url resolves to a private address");
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) {
      return true;
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    if (normalized.startsWith("ff")) {
      return true;
    }
    if (normalized.startsWith("64:ff9b:") || normalized.startsWith("2001:db8")) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
      return mapped?.[1] === undefined || isPrivateAddress(mapped[1]);
    }
    return false;
  }
  if (isIP(address) !== 4) {
    return true;
  }
  const parts = address.split(".").map(Number);
  const [a = -1, b = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  phase: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`MCP ${phase} timed out after ${ms}ms`)),
    ms,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function stringValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string <= ${max} chars`);
  }
  return value.trim();
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let used = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    result += character;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
