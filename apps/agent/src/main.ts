import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createApp, type AppServices } from "./app.ts";
import { CredentialBroker } from "./actions/credentials.ts";
import { CredentialRepository } from "./storage/credentials.ts";
import { createGithubPlugin } from "./plugins/github.ts";
import type { GitHubIssueWriteConfig } from "./actions/github-issue.ts";
import { connectMcpPlugins, parseMcpServers } from "./plugins/mcp.ts";
import { FileSkillRuntime } from "./plugins/skills.ts";
import type { BuiltinPlugin } from "./plugins/types.ts";
import { ClientApiService } from "./client-api.ts";
import { FeishuAdapter } from "./channels/feishu/adapter.ts";
import { FeishuLongConnection } from "./channels/feishu/long-connection.ts";
import {
  GitHubOAuthService,
  type GitHubOAuthStatus,
} from "./personal/github-oauth.ts";
import { GitHubTokenVault } from "./personal/github-token-vault.ts";
import {
  GitHubConnectionService,
  type GitHubConnectionView,
} from "./personal/github-connection.ts";
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

function oauthStatus(view: GitHubConnectionView): GitHubOAuthStatus {
  return {
    connected: view.status === "connected",
    ...(view.accountLogin === undefined ? {} : { login: view.accountLogin }),
    ...(view.githubScopes === undefined
      ? {}
      : { scopes: view.githubScopes.join(",") }),
    ...(view.updatedAt === undefined ? {} : { updatedAt: view.updatedAt }),
  };
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
  const githubVault =
    config.github.encryptionKey !== undefined && owner !== undefined
      ? new GitHubTokenVault({
          db: store.db,
          ownerId: owner.id,
          encryptionKey: config.github.encryptionKey,
        })
      : undefined;
  const githubOAuth =
    config.github.oauth !== undefined && owner !== undefined
      ? new GitHubOAuthService({
          db: store.db,
          ownerId: owner.id,
          config: config.github.oauth,
          ...(githubVault === undefined ? {} : { vault: githubVault }),
        })
      : undefined;
  const projectBindings =
    owner === undefined ? undefined : new ProjectRepository(store.db);
  const resolveProject =
    owner === undefined || projectBindings === undefined
      ? undefined
      : (projectKey: string) =>
          projectBindings.findActiveByKey(owner.id, projectKey);
  const storedTokenProvider =
    githubVault === undefined ? undefined : () => githubVault.accessToken();
  const envTokenProvider =
    config.github.token === undefined ? undefined : () => config.github.token;
  const githubCredentialProvider =
    storedTokenProvider === undefined
      ? envTokenProvider
      : envTokenProvider === undefined
        ? storedTokenProvider
        : () => {
            // A stored credential wins. A wrong key throws and fails closed;
            // it must not silently fall back to a higher-privilege env PAT.
            if (githubVault?.metadata() !== undefined) {
              return storedTokenProvider();
            }
            return envTokenProvider();
          };
  const credentials = new CredentialBroker(
    () => new Date(),
    new CredentialRepository(store.db),
  );
  const githubCredentialMetadata: {
    ownerId?: string;
    pluginId: string;
    account: string;
    scopes: string[];
  } = {
    ...(owner === undefined ? {} : { ownerId: owner.id }),
    pluginId: "github",
    account:
      githubVault?.metadata()?.login ?? (owner === undefined ? "default" : owner.id),
    scopes: ["repository.read"],
  };
  if (githubCredentialProvider !== undefined) {
    // Revocation and the credential epoch survive a restart for both PAT and
    // OAuth. A stored credential is re-attached through the vault; a legacy
    // env PAT is passed by value so a changed token rotates the epoch.
    credentials.restore("github:default", {
      ...githubCredentialMetadata,
      ...(githubVault?.metadata() !== undefined || config.github.token === undefined
        ? { provider: githubCredentialProvider }
        : { token: config.github.token }),
    });
  }
  if (
    config.github.issueWriteToken !== undefined &&
    owner !== undefined
  ) {
    // Separate least-privilege write credential. It is never derived from
    // the read PAT/OAuth token and must be explicitly configured.
    credentials.register(config.github.issueWriteCredentialRef, {
      token: config.github.issueWriteToken,
      scopes: ["repository.read", "issues.write"],
      ownerId: owner.id,
      pluginId: "github",
      account: "issues-write",
    });
  }
  const issueWriteConfig: GitHubIssueWriteConfig | undefined =
    config.github.issueWriteToken === undefined || owner === undefined
      ? undefined
      : {
          allowedRepos: config.github.issueWriteRepos,
          issueCredentialRef: config.github.issueWriteCredentialRef,
          resolveProject,
          credentials,
        };
  const github = {
    token: config.github.token,
    allowedRepos: config.github.allowedRepos,
    resolveProject,
    credentials,
    tokenProvider: githubCredentialProvider,
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
  const appRef: { current?: AppServices } = {};
  const connections =
    owner === undefined
      ? undefined
      : new GitHubConnectionService({
          store,
          ownerId: owner.id,
          credentials,
          ...(githubVault === undefined ? {} : { vault: githubVault }),
          ...(githubOAuth === undefined ? {} : { oauth: githubOAuth }),
          oauthConfigured: config.github.oauth !== undefined,
          envPatConfigured: config.github.token !== undefined,
          onChange: async (change) => {
            const services = appRef.current;
            if (services === undefined) {
              return;
            }
            try {
              services.issueDrafts.supersedeForCredential(
                owner.id,
                "github:default",
              );
              services.issueDrafts.supersedeForCredential(
                owner.id,
                config.github.issueWriteCredentialRef,
              );
              await services.plugins.credentialChanged(
                "github",
                change.actorId,
              );
            } catch (error) {
              logger.error("github_connection_change_failed", {
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        });
  const mcpPlugins = await loadMcpPlugins(config.mcpConfigPath, logger);
  const app = createApp({
    store,
    runtime: local.runtime,
    wake: noopWake,
    github,
    ...(issueWriteConfig === undefined
      ? {}
      : {
          githubIssueWrite: {
            credentialRef: issueWriteConfig.issueCredentialRef,
          },
        }),
    magpie: config.magpie,
    budgetLimits: config.budget,
    skills,
    builtinPlugins: [
      createGithubPlugin(github, issueWriteConfig, () =>
        connections?.pluginConnection(),
      ),
      ...mcpPlugins,
    ],
    // A keyless process must not persist a placeholder session id: the next
    // run with a model key would inherit an id Pi cannot resolve.
    model:
      config.model.apiKey === undefined
        ? new StaticRouterModel()
        : new PiRouterModel(store, local.runtime),
  });

  appRef.current = app;
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
          ...(connections === undefined ? {} : { connections }),
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
    oauth:
      config.github.oauth === undefined || connections === undefined
        ? undefined
        : {
            start: () => connections.beginOAuth().authorizeUrl,
            complete: async (code, state) =>
              oauthStatus(
                await connections.completeOAuth(code, state, "oauth"),
              ),
            status: () => oauthStatus(connections.status()),
            disconnect: async () =>
              (await connections.disconnect("oauth")).disconnected,
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
        app.planExecutor.sweep();
        const expiredConfirmations = app.confirmation.expirePending();
        const expiredDrafts = app.issueDrafts.expireDue();
        const settledDrafts =
          owner === undefined
            ? 0
            : (app.issueDraftApproval?.reconcileOwner(owner.id) ?? 0);
        const fired = await app.reminders.fireDue();
        const scheduled = app.schedulePolicy.fireDue();
        const effectResult = await app.effectDispatcher.drain(20);
        const result = await dispatcher.drain(10);
        const changed =
          recovered +
          expiredConfirmations +
          expiredDrafts +
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
            expiredDrafts,
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
