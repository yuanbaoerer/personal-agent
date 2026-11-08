import type { PiHarness } from "agents/harness/pi";

import type {
  AgentRuntime,
  OpenedSession,
  RuntimeAnswer,
  RuntimeSessionSpec,
  RuntimeSubmission,
} from "./types.ts";

/**
 * PiHarness-backed runtime. Sessions are real Pi conversations stored in the
 * Durable Object's SQLite database; operation ids are the application's
 * idempotency keys.
 */
export class PiRuntime implements AgentRuntime {
  readonly #harness: PiHarness;

  constructor(harness: PiHarness) {
    this.#harness = harness;
  }

  async open(_spec: RuntimeSessionSpec): Promise<OpenedSession> {
    const session = await this.#harness.sessions.create();
    return { id: session.id };
  }

  async submit(
    sessionId: string,
    text: string,
    operationId: string,
    entryKind?: string,
  ): Promise<RuntimeSubmission> {
    const session = this.#harness.session(sessionId);
    const receipt = await session.submit(text, {
      operationId,
      entry: entryKind === undefined ? undefined : { kind: entryKind },
    });
    return { operationId: receipt.operationId };
  }

  async wait(
    sessionId: string,
    operationId: string,
    timeoutMs = 20_000,
  ): Promise<RuntimeAnswer> {
    let result;
    try {
      result = await this.#harness
        .session(sessionId)
        .wait(operationId, AbortSignal.timeout(timeoutMs));
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { status: "pending" };
      }
      throw error;
    }
    if (result.status === "done") {
      return { status: "answered", text: result.text ?? "" };
    }
    return {
      status: "unanswered",
      reason: result.reason ?? "unanswered",
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    try {
      await this.#harness.session(sessionId).abort();
    } catch (error) {
      // A placeholder session that never opened (or a session the harness
      // already dropped) has nothing to abort. Cancellation must still
      // resolve so the task cannot get stuck behind a missing conversation.
      if (error instanceof Error && error.message.includes("Unknown pi session")) {
        return;
      }
      throw error;
    }
  }
}
