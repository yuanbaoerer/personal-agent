import type {
  AgentRuntime,
  OpenedSession,
  RuntimeAnswer,
  RuntimeSessionSpec,
  RuntimeSubmission,
} from "./types.ts";

export interface FakeSubmission {
  sessionId: string;
  text: string;
  operationId: string;
  entryKind?: string;
}

let runtimeInstances = 0;

/**
 * Deterministic runtime for contract tests. Answers are queued per session;
 * when the queue is empty the runtime returns a generic JSON report so tests
 * that only care about coordination still progress.
 */
export class FakeRuntime implements AgentRuntime {
  readonly submissions: FakeSubmission[] = [];
  readonly interrupted: string[] = [];
  readonly opened: RuntimeSessionSpec[] = [];
  readonly #answers = new Map<string, RuntimeAnswer[]>();
  readonly #prefix = `fake-${(runtimeInstances += 1)}`;
  #counter = 0;
  defaultAnswer: RuntimeAnswer = {
    status: "answered",
    text: JSON.stringify({
      status: "ready",
      summary: "fake result",
      evidence: [{ kind: "test", value: "fake" }],
    }),
  };

  enqueueAnswer(sessionId: string, answer: RuntimeAnswer): void {
    const queue = this.#answers.get(sessionId) ?? [];
    queue.push(answer);
    this.#answers.set(sessionId, queue);
  }

  enqueueText(sessionId: string, text: string): void {
    this.enqueueAnswer(sessionId, { status: "answered", text });
  }

  async open(spec: RuntimeSessionSpec): Promise<OpenedSession> {
    this.#counter += 1;
    this.opened.push(spec);
    return { id: `${this.#prefix}-session-${this.#counter}` };
  }

  async submit(
    sessionId: string,
    text: string,
    operationId: string,
    entryKind?: string,
  ): Promise<RuntimeSubmission> {
    this.submissions.push({ sessionId, text, operationId, entryKind });
    return { operationId };
  }

  async wait(
    sessionId: string,
    _operationId: string,
    _timeoutMs?: number,
  ): Promise<RuntimeAnswer> {
    const queue = this.#answers.get(sessionId);
    const answer = queue?.shift();
    if (answer !== undefined) {
      return answer;
    }
    return this.defaultAnswer;
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
  }
}
