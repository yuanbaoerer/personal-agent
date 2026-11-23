import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  EntryId,
  EntryRecord,
  UsageState as PiUsageState,
  Wake,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import type { RuntimeUsage, UsageAmounts } from "../domain/types.ts";
import type {
  AgentRuntime,
  OpenedSession,
  RuntimeAnswer,
  RuntimeSessionSpec,
  RuntimeSubmission,
} from "./types.ts";

export interface NodePiRuntimeOptions {
  /**
   * Pi owns pi_* tables. They live in their own SQLite file so a single
   * writer (node:sqlite) never contends between the application store and
   * Pi's storage handle.
   */
  databasePath: string;
  /** Provider and model id Pi resolves through `Models` at each request. */
  model: { provider: string; modelId: string };
  /** The model catalog Pi resolves `model` against. */
  models: Models;
  /** Tool rounds one run may take before it ends unanswered. */
  maxTurns?: number;
}

const DEFAULT_MAX_TURNS = 8;

function copyUsageAmounts(value: UsageAmounts): UsageAmounts {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    totalTokens: value.totalTokens,
    cost: {
      input: value.cost.input,
      output: value.cost.output,
      cacheRead: value.cost.cacheRead,
      cacheWrite: value.cost.cacheWrite,
      total: value.cost.total,
      ...(value.cost.totalFromProvider === undefined
        ? {}
        : { totalFromProvider: value.cost.totalFromProvider }),
    },
  };
}

function hasUsage(usage: RuntimeUsage): boolean {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].some(
    (bucket) =>
      bucket.totalTokens > 0 ||
      bucket.cost.total > 0 ||
      bucket.input > 0 ||
      bucket.output > 0 ||
      bucket.cacheRead > 0 ||
      bucket.cacheWrite > 0,
  );
}

/** Pi reports JSON-safe usage; copy it so the app ledger never aliases Pi storage. */
function toRuntimeUsage(state: Readonly<PiUsageState>): RuntimeUsage {
  return {
    models: Object.fromEntries(
      Object.entries(state.models).map(([key, value]) => [
        key,
        copyUsageAmounts(value as UsageAmounts),
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([key, value]) => [
        key,
        copyUsageAmounts(value as UsageAmounts),
      ]),
    ),
  };
}

/** opencode-go catalog used by the local Node process, mirroring the Worker. */
export function createOpencodeModels(apiKey: string): Models {
  const models = createModels({
    authContext: {
      env: async (name) => (name === "OPENCODE_API_KEY" ? apiKey : undefined),
      fileExists: async () => false,
    },
  });
  models.setProvider(opencodeGoProvider());
  return models;
}

/**
 * AgentRuntime over pi-durable's Harness, persisted in a local SQLite file.
 *
 * `operationId` is Pi's `requestId`, so a retried submit or a restart that
 * re-reads the submission never places the same input twice (K03).
 */
export class NodePiRuntime implements AgentRuntime {
  readonly #options: NodePiRuntimeOptions;
  #harness?: Promise<Harness>;
  #storage?: Promise<SqliteStorage>;
  #resumeTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: NodePiRuntimeOptions) {
    this.#options = options;
  }

  async open(spec: RuntimeSessionSpec): Promise<OpenedSession> {
    const harness = await this.#open();
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.#options.model,
          instructions: spec.brief,
          maxTurns: this.#options.maxTurns ?? DEFAULT_MAX_TURNS,
        },
      },
      BACKGROUND_CONTEXT,
    );
    return { id: String(conversation.id) };
  }

  async submit(
    sessionId: string,
    text: string,
    operationId: string,
    entryKind?: string,
  ): Promise<RuntimeSubmission> {
    const conversation = await this.#conversation(sessionId);
    // pi-durable dedupes by requestId: resubmitting after a crash returns the
    // submission that was already admitted instead of starting a second run.
    await conversation.submit(
      {
        type: "input",
        content: text,
        requestId: operationId,
        entry: entryKind === undefined ? undefined : { kind: entryKind },
      },
      BACKGROUND_CONTEXT,
    );
    return { operationId };
  }

  async wait(
    sessionId: string,
    operationId: string,
    timeoutMs = 20_000,
  ): Promise<RuntimeAnswer> {
    const harness = await this.#open();
    const storage = await this.#openStorage();
    const conversationId = toConversationId(sessionId);
    // The submission id is durable, so a wait after restart re-attaches to
    // the same operation rather than submitting the work again.
    const record = await storage.submissionByRequest(
      conversationId,
      operationId,
      BACKGROUND_CONTEXT,
    );
    if (record === undefined) {
      return { status: "unanswered", reason: "submission_not_found" };
    }
    const submission = await harness.submission(record.id, BACKGROUND_CONTEXT);
    if (submission === undefined) {
      return { status: "unanswered", reason: "submission_not_found" };
    }

    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, Math.max(1, timeoutMs));

    try {
      const settled = await submission.wait(context);
      if (settled.status !== "done") {
        return { status: "unanswered", reason: settled.reason ?? "unanswered" };
      }
      if (settled.answer === undefined) {
        return { status: "unanswered", reason: "answer_entry_missing" };
      }
      const text = await this.#answerText(sessionId, settled.answer);
      const usage = await this.#conversationUsage(conversationId);
      return {
        status: "answered",
        text,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (timedOut) {
        // The submission is still admitted; the caller retries the wait.
        return { status: "pending" };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const harness = await this.#open();
    const conversation = await harness.conversation(
      toConversationId(sessionId),
      BACKGROUND_CONTEXT,
    );
    // A session that never opened, or one the harness no longer knows, has
    // nothing to abort; cancellation must still resolve.
    await conversation?.abort(BACKGROUND_CONTEXT);
  }

  /** Stops Pi's scheduler timer and closes the storage handle. */
  close(): Promise<void> {
    // One closer: a second call waits for the first instead of returning
    // early while the harness is still shutting down.
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#resumeTimer);
    const harness = this.#harness;
    this.#harness = undefined;
    this.#storage = undefined;
    if (harness !== undefined) {
      try {
        await (await harness).close(BACKGROUND_CONTEXT);
      } catch {
        // Closing a harness that already failed must not block shutdown.
      }
    }
  }

  async #conversationUsage(
    conversationId: ConversationId,
  ): Promise<RuntimeUsage | undefined> {
    const storage = await this.#openStorage();
    const address = {
      kind: UsageDoc.definition.kind,
      scope: { kind: "conversation" as const, conversationId },
    };
    const record = await storage.findDocument(address, "current", BACKGROUND_CONTEXT);
    if (record === undefined) {
      return undefined;
    }
    const document = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
    if (document === undefined) {
      return undefined;
    }
    const usage = toRuntimeUsage(document.value as unknown as PiUsageState);
    return hasUsage(usage) ? usage : undefined;
  }

  async #answerText(sessionId: string, answer: EntryId): Promise<string> {
    const harness = await this.#open();
    const conversation = await harness.conversation(
      toConversationId(sessionId),
      BACKGROUND_CONTEXT,
    );
    if (conversation === undefined) {
      return "";
    }
    const page = await conversation.entries(
      { minEntryId: answer, maxEntryId: answer },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );
    return assistantText(page.items[0]);
  }

  async #open(): Promise<Harness> {
    if (this.#closed) {
      throw new Error("runtime closed");
    }
    if (this.#harness === undefined) {
      const opening = (async () => {
        const storage = await this.#openStorage();
        const harness = await Harness.open(
          storage,
          {
            models: this.#options.models,
            registry: createRegistry(),
            onWake: (wake) => this.#scheduleResume(wake),
          },
          BACKGROUND_CONTEXT,
        );
        harness.resume();
        return harness;
      })();
      this.#harness = opening;
      // A failed open closes the storage it was given, so neither handle may
      // stay cached: the next call retries with a fresh one.
      void opening.catch(() => {
        if (this.#harness === opening) {
          this.#harness = undefined;
          this.#storage = undefined;
        }
      });
    }
    return this.#harness;
  }

  async #openStorage(): Promise<SqliteStorage> {
    if (this.#closed) {
      throw new Error("runtime closed");
    }
    if (this.#storage === undefined) {
      this.#storage = openNodeSqliteStorage(this.#options.databasePath);
    }
    return this.#storage;
  }

  async #conversation(sessionId: string): Promise<Conversation> {
    const harness = await this.#open();
    const conversation = await harness.conversation(
      toConversationId(sessionId),
      BACKGROUND_CONTEXT,
    );
    if (conversation === undefined) {
      throw new Error(`Unknown pi session ${sessionId}`);
    }
    return conversation;
  }

  /**
   * Node has no alarm. Pi asks to be woken when its tasks need the process;
   * one timer arms the next `resume()`, the local counterpart of Lifecycle.
   */
  #scheduleResume(wake: Wake): void {
    clearTimeout(this.#resumeTimer);
    this.#resumeTimer = undefined;
    if (this.#closed) {
      return;
    }
    const delay = wake.active
      ? 0
      : wake.at === undefined
        ? undefined
        : Math.max(0, wake.at - Date.now());
    if (delay === undefined) {
      return;
    }
    this.#resumeTimer = setTimeout(() => {
      this.#resumeTimer = undefined;
      void this.#resume();
    }, delay);
    this.#resumeTimer.unref?.();
  }

  async #resume(): Promise<void> {
    try {
      (await this.#open()).resume();
    } catch {
      // A closed harness needs a reopen, which the next call performs.
    }
  }
}

function toConversationId(sessionId: string): ConversationId {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid pi session id ${sessionId}`);
  }
  return id as ConversationId;
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") {
    return "";
  }
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
