import { openStore } from "../../src/storage/node.ts";
import { createServices } from "../services.ts";

const databasePath = process.argv[2];
const at = process.argv[3] ?? "2026-01-01T09:00:00.000Z";
if (databasePath === undefined) {
  process.stderr.write("usage: schedule-fire.ts <database> [at]\n");
  process.exit(2);
}

const store = openStore(databasePath);
const now = () => new Date(at);
const services = createServices({ store, now });
try {
  const fired = services.schedulePolicy.fireDue();
  process.stdout.write(`fired=${fired}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  store.close();
  process.exit(1);
}

// Keep the process alive so the parent can SIGKILL it after the committed
// fire. The parent tests the persisted run/task invariants on restart.
const keepAlive = Promise.withResolvers<void>();
process.stdin.resume();
process.stdin.once("end", () => keepAlive.resolve());
await keepAlive.promise;
