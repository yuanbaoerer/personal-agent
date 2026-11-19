import { writeFileSync } from "node:fs";

import { ClientApiService } from "../../src/client-api.ts";
import { FeishuAdapter } from "../../src/channels/feishu/adapter.ts";
import type { FeishuConfig } from "../../src/channels/feishu/types.ts";
import { createHttpServer, type AppLogger } from "../../src/server.ts";
import { openStore } from "../../src/storage/node.ts";
import { createServices } from "../services.ts";

const databasePath = process.argv[2];
const portFile = process.argv[3];
if (databasePath === undefined || portFile === undefined) {
  process.stderr.write("usage: sse-server.ts <database> <port-file>\n");
  process.exit(2);
}

const logger: AppLogger = { info() {}, error() {} };
const config: FeishuConfig = {
  appId: "app_1",
  appSecret: "app-secret",
  verificationToken: "verification-token",
  accountId: "app_1",
};
const store = openStore(databasePath);
const services = createServices({ store, now: () => new Date() });
const adminToken = "sse-admin";
const clientApi = new ClientApiService({
  store,
  services,
  ownerId: services.owner.id,
  adminToken,
});
store.recordAudit({
  event: "sse.startup",
  subjectType: "test",
  subjectId: process.pid.toString(),
  traceId: `sse:${process.pid}`,
  occurredAt: new Date().toISOString(),
});
const server = createHttpServer({
  feishu: new FeishuAdapter(config, { now: () => new Date() }),
  ingress: services.ingress,
  logger,
  adminToken,
  clientApi,
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.exit(1);
  }
  writeFileSync(portFile, String(address.port), { mode: 0o600 });
});
const shutdown = () => {
  server.closeAllConnections();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
