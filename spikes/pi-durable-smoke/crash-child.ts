// Child process for the independent-kill durability check. It commits a run,
// writes a marker, announces READY, then waits forever for the parent to SIGKILL it.
import { writeFile } from "node:fs/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dbPath = process.argv[2];
const markerPath = process.argv[3];
if (dbPath === undefined || markerPath === undefined) {
  throw new Error("usage: crash-child.ts <db-path> <marker-path>");
}

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("durable answer")]);

const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const settled = await (
  await root.submit({ type: "input", content: "commit then hold" }, context)
).wait(context);
if (settled.status !== "done") {
  throw new Error(`run did not finish: ${JSON.stringify(settled)}`);
}

await root.commit(
  (tx) => tx.entry(AssistantEntry, settled.answer),
  context,
);
const entries = await root.entries({}, 50, undefined, context);
await writeFile(
  markerPath,
  JSON.stringify({ rootId: root.id, entryCount: entries.items.length }),
);

process.stdout.write("READY\n");
await new Promise<void>(() => {
  // Intentionally never resolves; the parent kills this process.
});
