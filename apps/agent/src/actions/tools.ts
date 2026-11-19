import { GitHubReadTool, type GitHubReadConfig } from "./github.ts";
import {
  ToolRejectedError,
  ToolRegistry,
  ToolUnknownError,
  type ActionTool,
  type ToolExecution,
  type ToolVerification,
} from "./tooling.ts";
import { createStateTools, type StateReadService } from "./state.ts";
import type { Store } from "../storage/store.ts";

export * from "./tooling.ts";

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
  readonly readOnly = false;
  readonly replayPolicy = "verify" as const;
  timeoutMs = 5_000;
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

export function createDefaultToolRegistry(
  store: Store,
  now?: () => Date,
  github?: GitHubReadConfig,
  state?: StateReadService,
): {
  registry: ToolRegistry;
  lamp: MockLampTool;
} {
  const registry = new ToolRegistry();
  const lamp = new MockLampTool(store, now);
  registry.register(lamp);
  if (state !== undefined) {
    for (const tool of createStateTools(state)) {
      registry.register(tool);
    }
  }
  if (
    github !== undefined &&
    (github.tokenProvider !== undefined ||
      (github.token !== undefined && github.token.trim().length > 0)) &&
    github.allowedRepos.length > 0
  ) {
    registry.register(new GitHubReadTool(github));
  }
  return { registry, lamp };
}
