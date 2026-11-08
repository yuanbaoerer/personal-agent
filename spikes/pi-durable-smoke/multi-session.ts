// Local multi-session experiment: one Router + two independent Worker contexts.
// It does not claim Cloudflare/DO behavior; it only verifies Pi session semantics.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(), "pa-pi-multi-"));
const dbPath = join(dir, "agent.sqlite");

const holdStarted = Promise.withResolvers<void>();
const holdRelease = Promise.withResolvers<void>();
const hold = defineTool({
  name: "hold",
  description: "Block until the test releases the Worker.",
  parameters: obj({}),
  execute: async () => {
    holdStarted.resolve();
    await holdRelease.promise;
    return { output: [{ type: "text", text: "hold released" }] };
  },
});

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "multi-session-tools",
    tools: [hold],
  }),
);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("hold", {}, { id: "call-hold" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("router reply"),
  fauxAssistantMessage("worker B reply"),
  fauxAssistantMessage("worker A reply"),
]);

const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry },
  context,
);

const agent = { model: { provider: "faux", modelId: "faux-1" } };
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

let workerASettled = false;
const workerASubmission = await workerA.submit(
  { type: "input", content: "worker A input" },
  context,
);
const workerAWait = workerASubmission.wait(context).then((result) => {
  workerASettled = true;
  return result;
});
await holdStarted.promise;
assert.equal(workerASettled, false, "Worker A should be busy in its tool");

const routerSettled = await (
  await router.submit({ type: "input", content: "router input" }, context)
).wait(context);
assert.equal(routerSettled.status, "done");
assert.equal(workerASettled, false, "Router must answer while Worker A is busy");
const routerAnsweredWhileWorkerABusy = workerASettled === false;

const workerBSettled = await (
  await workerB.submit({ type: "input", content: "worker B input" }, context)
).wait(context);
assert.equal(workerBSettled.status, "done");
assert.equal(workerASettled, false, "Worker B must finish while Worker A is busy");
const workerBFinishedWhileWorkerABusy = workerASettled === false;

holdRelease.resolve();
const workerAResult = await workerAWait;
assert.equal(workerAResult.status, "done");
assert.equal(workerASettled, true);

for (const [conversation, result] of [
  [router, routerSettled],
  [workerA, workerAResult],
  [workerB, workerBSettled],
] as const) {
  if (result.status !== "done") {
    throw new Error(`conversation ${conversation.id} did not finish: ${JSON.stringify(result)}`);
  }
  await conversation.commit(
    (tx) => tx.entry(AssistantEntry, result.answer),
    context,
  );
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

assert.match(serialized.router, /router input/);
assert.match(serialized.router, /router reply/);
assert.doesNotMatch(serialized.router, /worker A input/);
assert.doesNotMatch(serialized.router, /worker B input/);

assert.match(serialized.workerA, /worker A input/);
assert.match(serialized.workerA, /worker A reply/);
assert.doesNotMatch(serialized.workerA, /router input/);
assert.doesNotMatch(serialized.workerA, /worker B input/);

assert.match(serialized.workerB, /worker B input/);
assert.match(serialized.workerB, /worker B reply/);
assert.doesNotMatch(serialized.workerB, /router input/);
assert.doesNotMatch(serialized.workerB, /worker A input/);

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

function preview(view: { messages: readonly unknown[] }) {
  return view.messages.map((message) => {
    const role =
      typeof message === "object" && message !== null && "role" in message
        ? message.role
        : undefined;
    return { role, text: messageText(message) };
  });
}

const result = {
  dbPath,
  conversationIds: {
    router: router.id,
    workerA: workerA.id,
    workerB: workerB.id,
  },
  concurrency: {
    routerAnsweredWhileWorkerABusy,
    workerBFinishedWhileWorkerABusy,
    workerASettledAfterRelease: workerASettled,
  },
  contexts: {
    router: preview(views.router),
    workerA: preview(views.workerA),
    workerB: preview(views.workerB),
  },
};

console.log(JSON.stringify(result, null, 2));

await harness.close(context);
