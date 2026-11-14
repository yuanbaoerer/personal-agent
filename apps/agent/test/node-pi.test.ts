import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";

import { createOpencodeModels, NodePiRuntime } from "../src/runtime/node-pi.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

interface Fixture {
  path: string;
  faux: FauxProviderHandle;
  runtime: NodePiRuntime;
  reopen(): NodePiRuntime;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pa-node-pi-"));
  const path = join(dir, "pi.sqlite");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const create = (): NodePiRuntime =>
    new NodePiRuntime({ databasePath: path, model: MODEL, models });
  return {
    path,
    faux,
    runtime: create(),
    reopen: create,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("node pi runtime", () => {
  it("answers a submission and dedupes a retried operation id", async () => {
    const fx = await fixture();
    try {
      fx.faux.setResponses([fauxAssistantMessage("PA_NODE_OK")]);
      const session = await fx.runtime.open({ role: "worker", brief: "worker" });

      await fx.runtime.submit(session.id, "do the work", "assignment:1");
      // The second submit must reuse the admitted submission; scripted exactly
      // one answer, so a duplicate admission would leave the wait pending.
      await fx.runtime.submit(session.id, "do the work", "assignment:1");

      const first = await fx.runtime.wait(session.id, "assignment:1", 5_000);
      assert.deepEqual(first, { status: "answered", text: "PA_NODE_OK" });

      const again = await fx.runtime.wait(session.id, "assignment:1", 5_000);
      assert.deepEqual(again, { status: "answered", text: "PA_NODE_OK" });
    } finally {
      await fx.runtime.close();
      await fx.cleanup();
    }
  });

  it("re-attaches to a settled operation after the process reopens", async () => {
    const fx = await fixture();
    try {
      fx.faux.setResponses([fauxAssistantMessage("PA_DURABLE_OK")]);
      const session = await fx.runtime.open({ role: "router", brief: "router" });
      await fx.runtime.submit(session.id, "decide", "router:inbox-1");
      const answer = await fx.runtime.wait(session.id, "router:inbox-1", 5_000);
      assert.equal(answer.status, "answered");
      await fx.runtime.close();

      // A restarted process knows nothing in memory; the submission id and
      // transcript come from the SQLite file.
      const reopened = fx.reopen();
      try {
        const replay = await reopened.wait(session.id, "router:inbox-1", 5_000);
        assert.deepEqual(replay, { status: "answered", text: "PA_DURABLE_OK" });
      } finally {
        await reopened.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("reports pending while the model is still running, then answers", async () => {
    const fx = await fixture();
    try {
      // The model response stays unsettled until this test releases it, so
      // "pending" is observed without guessing at a duration.
      const gate = Promise.withResolvers<AssistantMessage>();
      fx.faux.setResponses([() => gate.promise]);
      const session = await fx.runtime.open({ role: "worker", brief: "worker" });
      await fx.runtime.submit(session.id, "slow", "assignment:slow");

      const pending = await fx.runtime.wait(session.id, "assignment:slow", 50);
      assert.deepEqual(pending, { status: "pending" });

      gate.resolve(fauxAssistantMessage("PA_LATE_OK"));
      const answer = await fx.runtime.wait(session.id, "assignment:slow", 5_000);
      assert.deepEqual(answer, { status: "answered", text: "PA_LATE_OK" });
    } finally {
      await fx.runtime.close();
      await fx.cleanup();
    }
  });

  it("resolves the default production model in the opencode-go catalog", () => {
    // A wrong default here fails every task at request time, so pin it
    // against the catalog the runtime is built with.
    const models = createOpencodeModels("test-key");
    const model = models.getModelOfType("chat", "opencode-go", "deepseek-v4.1-flash");
    assert.equal(model?.provider, "opencode-go");
    assert.equal(model?.id, "deepseek-v4.1-flash");
  });

  it("rejects an unknown session id instead of creating one", async () => {
    const fx = await fixture();
    try {
      await assert.rejects(
        () => fx.runtime.submit("999999", "hello", "assignment:missing"),
        /unknown pi session/i,
      );
    } finally {
      await fx.runtime.close();
      await fx.cleanup();
    }
  });
});
