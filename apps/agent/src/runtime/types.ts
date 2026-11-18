/** Experimental until D11; bump only with a documented migration. */
export const RUNTIME_CONTRACT_VERSION = 1;

/**
 * The runtime seam. Production uses PiHarness sessions in the Durable Object;
 * tests and the local Node process use deterministic implementations.
 */
export interface RuntimeSessionSpec {
  role: "router" | "worker";
  /** Human-readable brief used by the runtime when it has no session yet. */
  brief: string;
}

export interface OpenedSession {
  id: string;
}

export interface RuntimeSubmission {
  operationId: string;
}

export type RuntimeAnswer =
  | { status: "answered"; text: string }
  | { status: "unanswered"; reason: string }
  /** The wait timed out; the operation may still be running. */
  | { status: "pending" };

export interface AgentRuntime {
  open(spec: RuntimeSessionSpec): Promise<OpenedSession>;
  submit(
    sessionId: string,
    text: string,
    operationId: string,
    entryKind?: string,
  ): Promise<RuntimeSubmission>;
  wait(
    sessionId: string,
    operationId: string,
    timeoutMs?: number,
  ): Promise<RuntimeAnswer>;
  interrupt(sessionId: string): Promise<void>;
}

/** A durable wake seam: Lifecycle jobs in the Worker, a no-op locally. */
export interface WakeScheduler {
  wake(at?: Date): Promise<void>;
}

export const noopWake: WakeScheduler = {
  async wake() {
    // The local Node process polls maintenance every second.
  },
};
