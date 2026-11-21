import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createApp } from "./app.ts";
import { CredentialBroker } from "./actions/credentials.ts";
import { createGithubPlugin } from "./plugins/github.ts";
import { connectMcpPlugins, parseMcpServers } from "./plugins/mcp.ts";
import { FileSkillRuntime } from "./plugins/skills.ts";
import type { BuiltinPlugin } from "./plugins/types.ts";
import { ClientApiService } from "./client-api.ts";
import { FeishuAdapter } from "./channels/feishu/adapter.ts";
import { FeishuLongConnection } from "./channels/feishu/long-connection.ts";
import { GitHubOAuthService } from "./personal/github-oauth.ts";
import { loadConfig, type ModelConfig } from "./config.ts";
import { PiRouterModel } from "./coordinator/pi-router.ts";
import { StaticRouterModel } from "./coordinator/router.ts";
import { OutboxDispatcher } from "./delivery/outbox.ts";
import { ConfigError } from "./domain/errors.ts";
import { createOpencodeModels, NodePiRuntime } from "./runtime/node-pi.ts";
import type {
  AgentRuntime,
  OpenedSession,
  RuntimeAnswer,
  RuntimeSessionSpec,
  RuntimeSubmission,
} from "./runtime/types.ts";
import { noopWake } from "./runtime/types.ts";
import { createHttpServer, type AppLogger } from "./server.ts";
import { openStore } from "./storage/node.ts";
import { ProjectRepository } from "./storage/projects.ts";

const MAINTENANCE_INTERVAL_MS = 1_000;

const logger: AppLogger = {
  info(message, fields) {
    console.info(JSON.stringify({ level: "info", message, ...fields }));
  },
  error(message, fields) {
    console.error(JSON.stringify({ level: "error", message, ...fields }));
  },
};

/**
 * Fallback when no model key is configured. Deterministic commands, Feishu
 * transport, Inbox/Outbox and the Coordinator still run; model tasks fail with
 * an explicit report instead of pretending to work.
 */
class LocalRuntime implements AgentRuntime {
  async open(_spec: RuntimeSessionSpec): Promise<OpenedSession> {
    return { id: "local-unavailable" };
  }

  async submit(
    _sessionId: string,
    _text: string,
    operationId: string,
  ): Promise<RuntimeSubmission> {
    return { operationId };
  }

  async wait(): Promise<RuntimeAnswer> {
    return {
      status: "answered",
      text: JSON.stringify({
        status: "failed",
        summary: "本地进程没有模型运行时；请配置 OPENCODE_API_KEY 或改用 Worker 执行模型任务。",
        evidence: [],
      }),
    };
  }

  async interrupt(): Promise<void> {
    // Nothing to interrupt locally.
  }
}

interface LocalRuntimeHandle {
  runtime: AgentRuntime;
  close(): Promise<void>;
}

function createRuntime(
  model: ModelConfig,
  piDatabasePath: string,
): LocalRuntimeHandle {
  if (model.apiKey === undefined) {
    logger.error("model_key_missing", {
      message:
        "OPENCODE_API_KEY is unset; model tasks fail explicitly. Deterministic commands still work.",
    });
    return { runtime: new LocalRuntime(), close: async () => {} };
  }
  const runtime = new NodePiRuntime({
    databasePath: piDatabasePath,
    model: { provider: model.provider, modelId: model.modelId },
    models: createOpencodeModels(model.apiKey),
  });
  return { runtime, close: () => runtime.close() };
}

async function loadMcpPlugins(
  configPath: string | undefined,
  log: AppLogger,
): Promise<BuiltinPlugin[]> {
  if (configPath === undefined) {
    return [];
  }
  try {
    const raw = readFileSync(resolve(configPath), "utf8");
    const parsed = parseMcpServers(JSON.parse(raw));
    const definitions = parsed.filter((definition) => {
      if (definition.id === "github") {
        log.error("mcp_plugin_reserved_id", { id: definition.id });
        return false;
      }
      return true;
    });
    const result = await connectMcpPlugins(definitions, { env: process.env });
    for (const failure of result.errors) {
      log.error("mcp_plugin_unavailable", {
        id: failure.id,
        message: failure.error,
      });
    }
    log.info("mcp_plugins_loaded", {
      requested: definitions.length,
      connected: result.plugins.filter((plugin) => plugin.configured).length,
    });
    return result.plugins;
  } catch (error) {
    log.error("mcp_config_invalid", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const databasePath =
    config.databasePath === ":memory:" ? config.databasePath : resolve(config.databasePath);
  const piDatabasePath =
    config.piDatabasePath === ":memory:" ? config.piDatabasePath : resolve(config.piDatabasePath);
  for (const path of [databasePath, piDatabasePath]) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  const store = openStore(databasePath);
  if (config.feishu.encryptKey === undefined) {
    logger.info("feishu_encrypt_key_missing", {
      message: "event authenticity relies on the verification token; configure FEISHU_ENCRYPT_KEY",
    });
  }
  if (config.ownerOpenId !== undefined) {
    store.bindOwner({
      channel: "feishu",
      accountId: config.feishu.accountId ?? config.feishu.appId,
      actorId: config.ownerOpenId,
      verifiedAt: new Date().toISOString(),
    });
  } else {
    logger.error("owner_not_bound", {
      message: "OWNER_FEISHU_OPEN_ID is unset; every inbound message will be rejected",
    });
  }

  const owner =
    config.ownerOpenId === undefined
      ? undefined
      : store.findOwner(
          "feishu",
          config.feishu.accountId ?? config.feishu.appId,
          config.ownerOpenId,
        );
  const githubOAuth =
    config.github.oauth !== undefined && owner !== undefined
      ? new GitHubOAuthService({
          db: store.db,
          ownerId: owner.id,
          config: config.github.oauth,
        })
      : undefined;
  const projectBindings =
    owner === undefined ? undefined : new ProjectRepository(store.db);
  const resolveProject =
    owner === undefined || projectBindings === undefined
      ? undefined
      : (projectKey: string) =>
          projectBindings.findActiveByKey(owner.id, projectKey);
  const githubCredentialProvider =
    githubOAuth === undefined
      ? config.github.token === undefined
        ? undefined
        : () => config.github.token
      : () => githubOAuth.accessToken();
  const credentials = new CredentialBroker();
  if (githubCredentialProvider !== undefined) {
    credentials.register("github:default", {
      provider: githubCredentialProvider,
      scopes: ["repository.read"],
    });
  }
  const github = {
    token: config.github.token,
    allowedRepos: config.github.allowedRepos,
    resolveProject,
    credentials,
    tokenProvider:
      githubOAuth === undefined ? undefined : () => githubOAuth.accessToken(),
  };
  const local = createRuntime(config.model, piDatabasePath);
  const skillsRoot = config.skillsDir ?? resolve("skills");
  const skills = existsSync(skillsRoot)
    ? new FileSkillRuntime({ root: skillsRoot })
    : undefined;
  if (skills !== undefined) {
    logger.info("skills_indexed", {
      root: skillsRoot,
      count: skills.list().length,
      errors: skills.errors().length,
    });
  }
  const mcpPlugins = await loadMcpPlugins(config.mcpConfigPath, logger);
  const app = createApp({
    store,
    runtime: local.runtime,
    wake: noopWake,
    github,
    magpie: config.magpie,
    budgetLimits: config.budget,
    skills,
    builtinPlugins: [createGithubPlugin(github), ...mcpPlugins],
    // A keyless process must not persist a placeholder session id: the next
    // run with a model key would inherit an id Pi cannot resolve.
    model:
      config.model.apiKey === undefined
        ? new StaticRouterModel()
        : new PiRouterModel(store, local.runtime),
  });

  const feishu = new FeishuAdapter(config.feishu);
  const longConnection =
    config.eventMode === "long_connection"
      ? new FeishuLongConnection({
          config: config.feishu,
          ingress: app.ingress,
          logger,
        })
      : undefined;
  const dispatcher = new OutboxDispatcher({
    store,
    channel: feishu,
    leaseMs: config.outbox.leaseMs,
    maxAttempts: config.outbox.maxAttempts,
    retryBaseMs: config.outbox.retryBaseMs,
  });

  const clientApi =
    owner === undefined || config.adminToken === undefined
      ? undefined
      : new ClientApiService({
          store,
          services: app,
          ownerId: owner.id,
          adminToken: config.adminToken,
        });
  if (clientApi === undefined) {
    logger.info("client_api_disabled", {
      message:
        owner === undefined || config.adminToken === undefined
          ? "client API needs a bound owner and ADMIN_TOKEN"
          : "client API disabled",
    });
  }

  const server = createHttpServer({
    feishu,
    ingress: app.ingress,
    logger,
    adminToken: config.adminToken,
    clientApi,
    onCredentialChange: async () => {
      if (githubCredentialProvider === undefined) {
        credentials.revoke("github:default");
      } else {
        credentials.rotate("github:default", {
          provider: githubCredentialProvider,
          scopes: ["repository.read"],
        });
      }
      await app.plugins.credentialChanged("github", "oauth");
    },
    oauth:
      githubOAuth === undefined
        ? undefined
        : {
            start: () => githubOAuth.start(),
            complete: (code, state) => githubOAuth.complete(code, state),
            status: () => githubOAuth.status(),
            disconnect: () => githubOAuth.disconnect(),
          },
  });

  let running = false;
  let stopping = false;
  const timer = setInterval(() => {
    if (running || stopping) {
      return;
    }
    running = true;
    void (async () => {
      try {
        const recovered = await app.ingress.recoverPending(20);
        app.taskService.sweep();
        app.actionService.sweep();
        const expiredConfirmations = app.confirmation.expirePending();
        const fired = await app.reminders.fireDue();
        const scheduled = app.schedulePolicy.fireDue();
        const effectResult = await app.effectDispatcher.drain(20);
        const result = await dispatcher.drain(10);
        const changed =
          recovered +
          expiredConfirmations +
          fired +
          scheduled +
          effectResult.done +
          effectResult.retried +
          effectResult.failed +
          result.accepted +
          result.retried +
          result.failed +
          result.unknown +
          result.manual;
        if (changed > 0) {
          logger.info("maintenance", {
            recovered,
            expiredConfirmations,
            fired,
            scheduled,
            effects: effectResult,
            ...result,
          });
        }
      } catch (error) {
        logger.error("maintenance_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = false;
      }
    })();
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();

  const listen = Promise.withResolvers<void>();
  server.once("error", listen.reject);
  server.listen(config.port, config.host, () => {
    server.off("error", listen.reject);
    listen.resolve();
  });
  await listen.promise;

  logger.info("listening", {
    host: config.host,
    port: config.port,
    databasePath,
    piDatabasePath,
    eventMode: config.eventMode,
    githubOAuth: githubOAuth === undefined ? "disabled" : "configured",
    model:
      config.model.apiKey === undefined
        ? "unavailable"
        : `${config.model.provider}/${config.model.modelId}`,
  });

  if (longConnection !== undefined) {
    void longConnection.start().catch((error: unknown) => {
      logger.error("feishu_ws_start_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopping = true;
    clearInterval(timer);
    logger.info("shutting_down", { signal });
    longConnection?.stop();
    server.closeAllConnections();
    server.close(() => {
      void local.close().finally(() => {
        store.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error("config_invalid", { message: error.message });
  } else {
    logger.error("startup_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  process.exitCode = 1;
});
