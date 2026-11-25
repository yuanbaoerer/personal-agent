import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/storage/node.ts";
import { createServices } from "./services.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/schedule-fire.ts", import.meta.url),
);
const CREATED_AT = "2026-01-01T08:00:00.000Z";
const DUE_AT = "2026-01-01T09:00:00.000Z";

async function waitForOutput(
  child: ReturnType<typeof spawn>,
  needle: string,
  stderr: () => string,
): Promise<void> {
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onData = (chunk: string | Buffer) => {
    stdout += String(chunk);
    if (stdout.includes(needle)) {
      cleanup();
      resolve();
    }
  };
  const onExit = () => {
    cleanup();
    reject(new Error(`schedule fixture exited before ${needle}: ${stderr()}`));
  };
  const cleanup = () => {
    child.stdout?.off("data", onData);
    child.off("exit", onExit);
  };
  child.stdout?.on("data", onData);
  child.once("exit", onExit);
  await promise;
}

describe("schedule policy after a real child-process kill", () => {
  it(
    "does not duplicate a fired occurrence after SIGKILL and restart",
    { timeout: 10_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pa-schedule-kill-"));
      const database = join(directory, "agent.sqlite");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const store = openStore(database);
        const services = createServices({
          store,
          now: () => new Date(CREATED_AT),
        });
        const draft = services.schedulePolicy.createDraft(
          services.owner.id,
          services.conversation.id,
          {
            kind: "internal",
            localTime: "09:00",
            cadence: "daily",
            goal: "汇总当前任务与提醒",
            timezone: "UTC",
            until: "2026-01-05",
          },
        );
        assert.equal(draft.ok, true);
        if (!draft.ok) return;
        const confirmed = services.schedulePolicy.confirm(
          services.owner.id,
          draft.policy.id,
        );
        assert.equal(confirmed.ok, true);
        store.close();

        let stderr = "";
        child = spawn(process.execPath, [fixture, database, DUE_AT], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        await waitForOutput(child, "fired=1", () => stderr);
        child.kill("SIGKILL");
        await once(child, "exit");
        assert.equal(child.signalCode, "SIGKILL");
        child = undefined;

        const reopened = openStore(database);
        try {
          // Simulate a crash after the run claim committed but before the
          // timer advanced. The run ledger, not next_run_at alone, must stop
          // a replay after restart.
          reopened.db.run(
            "UPDATE pa_schedule_policies SET next_run_at = ? WHERE id = ?",
            DUE_AT,
            draft.policy.id,
          );
          const restarted = createServices({
            store: reopened,
            now: () => new Date(DUE_AT),
          });
          assert.equal(restarted.schedulePolicy.fireDue(), 0);
          assert.equal(
            restarted.tasks.listByOwner(restarted.owner.id).length,
            1,
          );
          assert.equal(
            restarted.schedulePolicies.listRuns(draft.policy.id).length,
            1,
          );
          assert.equal(
            restarted.schedulePolicies.listRuns(draft.policy.id)[0]?.status,
            "dispatched",
          );
        } finally {
          reopened.close();
        }
      } finally {
        child?.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
