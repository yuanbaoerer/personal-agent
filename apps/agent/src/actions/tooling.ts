import { createHash } from "node:crypto";

export class ToolRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRejectedError";
  }
}

/** The external side may have changed; the local caller did not observe it. */
export class ToolUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUnknownError";
  }
}

/** The dispatcher stopped waiting; a write may still complete externally. */
export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

/** Experimental until D11; bump only with a documented migration. */
export const TOOL_CONTRACT_VERSION = 1;

/**
 * Execution identity supplied by the trusted dispatcher. Tools must derive
 * owner/project scope from here, never from model-controlled arguments.
 */
export interface ToolExecutionContext {
  ownerId: string;
  taskId?: string;
  /** Task mandate project; absent means global/owner-level scope. */
  project?: string;
}

export interface ToolDescriptor {
  name: string;
  resource?: string;
  readOnly: boolean;
  replayPolicy: "verify" | "never";
  timeoutMs: number;
}

export interface ToolExecution {
  evidence: Record<string, unknown>;
  externalRef?: string;
}

export interface ToolVerification {
  satisfied: boolean;
  evidence: Record<string, unknown>;
}

export interface ActionTool {
  readonly name: string;
  /** Mandate resource required to use this tool, if any. */
  readonly resource?: string;
  /** A timed-out read is safely retryable; a write may have landed. */
  readonly readOnly?: boolean;
  /** `verify` permits reconcile retry only after verify(); default never retries. */
  readonly replayPolicy?: "verify" | "never";
  /** Bound on one tool call; defaults to 15s. */
  readonly timeoutMs?: number;
  readonly description?: string;
  canonicalize(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecution>;
  verify(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolVerification>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ActionTool>();

  register(tool: ActionTool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ActionTool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  describe(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .map((tool) => ({
        name: tool.name,
        resource: tool.resource,
        readOnly: tool.readOnly === true,
        replayPolicy: tool.replayPolicy ?? "never",
        timeoutMs: tool.timeoutMs ?? 15_000,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

export function hashArgs(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}:${stableStringify(args)}`, "utf8")
    .digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
