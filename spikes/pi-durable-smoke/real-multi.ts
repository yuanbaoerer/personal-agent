// Real-model multi-session check: one Router + two Workers on opencode-go.
// It verifies real model calls and transcript isolation; deterministic busy
// behavior is covered separately by multi-session.ts with faux responses.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  AssistantEntry,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

if (!process.env.OPENCODE_API_KEY) {
  throw new Error("OPENCODE_API_KEY is not set; load .env or export it");
}

const context = BACKGROUND_CONTEXT;
const modelId = process.env.OPENCODE_MODEL ?? "deepseek-v4.1-flash";
const dir = await mkdtemp(join(tmpdir(), "pa-pi-real-multi-"));
const dbPath = join(dir, "agent.sqlite");

const models = createModels();
models.setProvider(opencodeGoProvider());
const agent = { model: { provider: "opencode-go", modelId } };

const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry: createRegistry() },
  context,
);
const router = await harness.root(context, { agent });
const workerA = await harness.createConversation(
  { ownership: { kind: "ownerless" }, agent },
  context,
);
const workerB = await harness.createConversation(
  { ownership: { kind: "ownerless" }, agent },
  context,
);

assert.notEqual(router.id, workerA.id);
assert.notEqual(router.id, workerB.id);
assert.notEqual(workerA.id, workerB.id);

const startedAt = Date.now();
const inputs = {
  router: "Reply with exactly ROUTER_REAL_OK and nothing else.",
  workerA: "Reply with exactly WORKER_A_REAL_OK and nothing else.",
  workerB: "Reply with exactly WORKER_B_REAL_OK and nothing else.",
};

const [routerSettled, workerASettled, workerBSettled] = await Promise.all([
  (await router.submit({ type: "input", content: inputs.router }, context)).wait(context),
  (await workerA.submit({ type: "input", content: inputs.workerA }, context)).wait(context),
  (await workerB.submit({ type: "input", content: inputs.workerB }, context)).wait(context),
]);
const elapsedMs = Date.now() - startedAt;

for (const [conversation, result] of [
  [router, routerSettled],
  [workerA, workerASettled],
  [workerB, workerBSettled],
] as const) {
  assert.equal(result.status, "done");
  await conversation.commit((tx) => tx.entry(AssistantEntry, result.answer), context);
}

const views = {
  router: await router.context(context),
  workerA: await workerA.context(context),
  workerB: await workerB.context(context),
};
const serialized = {
  router: JSON.stringify(views.router.messages),
  workerA: JSON.stringify(views.workerA.messages),
  workerB: JSON.stringify(views.workerB.messages),
};

assert.match(serialized.router, /ROUTER_REAL_OK/);
assert.doesNotMatch(serialized.router, /WORKER_A_REAL_OK|WORKER_B_REAL_OK/);
assert.match(serialized.workerA, /WORKER_A_REAL_OK/);
assert.doesNotMatch(serialized.workerA, /ROUTER_REAL_OK|WORKER_B_REAL_OK/);
assert.match(serialized.workerB, /WORKER_B_REAL_OK/);
assert.doesNotMatch(serialized.workerB, /ROUTER_REAL_OK|WORKER_A_REAL_OK/);

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null || !("text" in part)) {
        return "";
      }
      const text = part.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

const answerOf = (view: { messages: readonly unknown[] }): string => {
  const assistant = view.messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant",
  );
  return assistant.map(messageText).filter(Boolean).at(-1) ?? "";
};

console.log(
  JSON.stringify(
    {
      dbPath,
      provider: "opencode-go",
      modelId,
      elapsedMs,
      conversationIds: {
        router: router.id,
        workerA: workerA.id,
        workerB: workerB.id,
      },
      statuses: {
        router: routerSettled.status,
        workerA: workerASettled.status,
        workerB: workerBSettled.status,
      },
      answers: {
        router: answerOf(views.router),
        workerA: answerOf(views.workerA),
        workerB: answerOf(views.workerB),
      },
    },
    null,
    2,
  ),
);

await harness.close(context);
