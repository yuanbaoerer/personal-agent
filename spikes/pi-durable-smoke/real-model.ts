// Real-model smoke: opencode-go through the user's local omp login.
// The API key is read from OPENCODE_API_KEY; this script never prints it.
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
const dir = await mkdtemp(join(tmpdir(), "pa-pi-real-"));
const dbPath = join(dir, "agent.sqlite");

const models = createModels();
models.setProvider(opencodeGoProvider());

const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "opencode-go", modelId } },
});

const startedAt = Date.now();
const settled = await (
  await root.submit(
    { type: "input", content: "Reply with exactly PA_REAL_MODEL_OK and nothing else." },
    context,
  )
).wait(context);
const elapsedMs = Date.now() - startedAt;

assert.equal(settled.status, "done");
const answer = await root.commit(
  (tx) => tx.entry(AssistantEntry, settled.answer),
  context,
);
const message = answer?.model?.[0];
const text =
  message?.role === "assistant"
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : "";

assert.match(text, /PA_REAL_MODEL_OK/);
const entries = await root.entries({}, 50, undefined, context);

console.log(
  JSON.stringify(
    {
      dbPath,
      provider: "opencode-go",
      modelId,
      status: settled.status,
      text,
      elapsedMs,
      entryCount: entries.items.length,
    },
    null,
    2,
  ),
);

await harness.close(context);
