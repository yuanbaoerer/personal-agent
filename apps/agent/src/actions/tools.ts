import { createHash } from "node:crypto";

import type { Store } from "../storage/store.ts";

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
  canonicalize(args: Record<string, unknown>): Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolExecution>;
  verify(args: Record<string, unknown>): Promise<ToolVerification>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ActionTool>();

  register(tool: ActionTool): void {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ActionTool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
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

interface LampState {
  brightness: number;
  updatedAt: string;
}

const LAMP_STATE_KEY = "mock_lamp.state";

/**
 * A controllable lamp. Its state lives in the same SQLite database so a
 * crash between the state write and the action row write can be reproduced:
 * `failAfter` throws after the state is visible.
 */
export class MockLampTool implements ActionTool {
  readonly name = "lamp.set_brightness";
  readonly #store: Store;
  readonly #now: () => Date;

  failBefore = false;
  failAfter = false;
  delayMs = 0;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    const brightness = args.brightness;
    if (
      typeof brightness !== "number" ||
      !Number.isInteger(brightness) ||
      brightness < 0 ||
      brightness > 100
    ) {
      throw new ToolRejectedError("brightness must be an integer between 0 and 100");
    }
    return { brightness };
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecution> {
    const canonical = this.canonicalize(args);
    if (this.failBefore) {
      throw new ToolRejectedError("mock lamp rejected before applying the change");
    }
    if (this.delayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, this.delayMs);
      await promise;
    }

    const brightness = canonical.brightness as number;
    this.#writeState({ brightness, updatedAt: this.#now().toISOString() });

    if (this.failAfter) {
      throw new ToolUnknownError("mock lamp applied the change but the caller lost the result");
    }

    return {
      evidence: { brightness, state: "applied" },
      externalRef: `mock-lamp:${brightness}`,
    };
  }

  async verify(args: Record<string, unknown>): Promise<ToolVerification> {
    const canonical = this.canonicalize(args);
    const target = canonical.brightness as number;
    const state = this.getState();
    return {
      satisfied: state.brightness === target,
      evidence: { brightness: state.brightness, target },
    };
  }

  getState(): LampState {
    const raw = this.#store.metaGet(LAMP_STATE_KEY);
    if (raw === undefined) {
      return { brightness: 0, updatedAt: "" };
    }
    try {
      const parsed = JSON.parse(raw) as LampState;
      return {
        brightness: typeof parsed.brightness === "number" ? parsed.brightness : 0,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    } catch {
      return { brightness: 0, updatedAt: "" };
    }
  }

  #writeState(state: LampState): void {
    this.#store.metaSet(LAMP_STATE_KEY, JSON.stringify(state));
  }
}

export function createDefaultToolRegistry(store: Store, now?: () => Date): {
  registry: ToolRegistry;
  lamp: MockLampTool;
} {
  const registry = new ToolRegistry();
  const lamp = new MockLampTool(store, now);
  registry.register(lamp);
  return { registry, lamp };
}
