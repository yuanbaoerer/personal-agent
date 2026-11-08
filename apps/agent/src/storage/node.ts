import { DatabaseSync } from "node:sqlite";

import { NodeDb } from "./db.ts";
import { Store } from "./store.ts";

/** Node-only entry point; Worker code must not import `node:sqlite`. */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return new Store(new NodeDb(db));
}
