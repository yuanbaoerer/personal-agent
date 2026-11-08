// Minimal local spike for the proposed Personal Agent runtime.
// Verifies: durable SQLite transcript, tool execution, pre-tool approval hook,
// and transcript survival across process restart.
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
  hook,
  ToolResultEntry,
  ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(), "pa-pi-durable-"));
const dbPath = join(dir, "agent.sqlite");
let executed = false;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const danger = defineTool({
  name: "danger",
  description: "A side-effecting action. The smoke test must block it.",
  parameters: obj({}),
  execute: async () => {
    executed = true;
    return { output: [{ type: "text", text: "SIDE EFFECT RAN" }] };
  },
});

// This is the primitive the real project will build approvals on:
// model proposes -> hook blocks -> UI approves -> host executes.
const approval = defineExtension({
  name: "approval",
  tools: [danger],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) =>
        call.name === "danger" ? { block: "Needs human approval" } : undefined,
    }),
  ],
});

const registry = createRegistry();
registry.install(approval);

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("danger", {}, { id: "call-1" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("I need approval before doing that."),
]);

const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const settled = await (
  await root.submit(
    { type: "input", content: "Run the dangerous action." },
    context,
  )
).wait(context);

if (settled.status !== "done") {
  throw new Error(`run did not finish: ${JSON.stringify(settled)}`);
}
const answer = await root.commit(
  (tx) => tx.entry(AssistantEntry, settled.answer),
  context,
);
const message = answer?.model?.[0];
const answerText =
  message?.role === "assistant"
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : "";

const before = await root.entries({}, 50, undefined, context);
const toolResults = before.items.filter(ToolResultEntry.is).map((entry) => {
  const result = entry.model?.[0];
  if (!result || result.role !== "toolResult") return "";
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
});

console.log(
  JSON.stringify(
    {
      dir,
      answer: answerText,
      executed,
      toolResult: toolResults.at(-1),
      entryCount: before.items.length,
    },
    null,
    2,
  ),
);

assert.equal(executed, false, "the guarded tool must not execute");
assert.equal(answerText, "I need approval before doing that.");
assert.match(toolResults.at(-1) ?? "", /blocked/i);
assert.equal(toolResults.length, 1);
assert.equal(before.items.length, 5);

await harness.close(context);

// Reopen the same SQLite file to prove the transcript is durable.
const reopened = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry },
  context,
);
const again = await reopened.root(context);
const after = await again.entries({}, 50, undefined, context);
console.log(
  JSON.stringify(
    { reopenedEntryCount: after.items.length, sameRoot: again.id === root.id },
    null,
    2,
  ),
);

assert.equal(after.items.length, before.items.length);
assert.equal(again.id, root.id);

await reopened.close(context);
