import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActionTool } from "../src/actions/tools.ts";
import { ToolRegistry } from "../src/actions/tools.ts";
import { ClientApiService, type ClientApiRequest } from "../src/client-api.ts";
import type { ActionRecord, TaskRecord } from "../src/domain/types.ts";
import { PluginCatalog } from "../src/plugins/catalog.ts";
import {
  parsePluginManifest,
  pluginDigest,
  validatePluginSet,
  type PluginManifest,
} from "../src/plugins/manifest.ts";
import type { BuiltinPlugin, PluginConnection } from "../src/plugins/types.ts";
import { createStore } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

class FakeEchoTool implements ActionTool {
  readonly name = "fake.echo";
  readonly resource = "fake";
  readonly readOnly = true;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs = 1_000;

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    return { value: typeof args.value === "string" ? args.value : "" };
  }

  async execute(args: Record<string, unknown>) {
    return { evidence: { echo: this.canonicalize(args).value } };
  }

  async verify(args: Record<string, unknown>) {
    return { satisfied: true, evidence: { echo: this.canonicalize(args).value } };
  }
}

class SlowWriteTool implements ActionTool {
  readonly name = "fake.write";
  readonly resource = "fake";
  readonly readOnly = false;
  readonly replayPolicy = "verify" as const;
  readonly timeoutMs = 5_000;
  readonly #release: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    const gate = Promise.withResolvers<void>();
    this.#gate = gate.promise;
    this.#release = gate.resolve;
  }

  release(): void {
    this.#release();
  }

  canonicalize(args: Record<string, unknown>): Record<string, unknown> {
    return { value: typeof args.value === "string" ? args.value : "" };
  }

  async execute(args: Record<string, unknown>) {
    await this.#gate;
    return { evidence: { wrote: this.canonicalize(args).value } };
  }

  async verify(args: Record<string, unknown>) {
    return { satisfied: true, evidence: { wrote: this.canonicalize(args).value } };
  }
}

function fakeWriteManifest(): PluginManifest {
  return parsePluginManifest({
    id: "fake",
    name: "Fake",
    version: "0.1.0",
    apiVersion: "1",
    trust: "builtin",
    entrypoint: "builtin:fake",
    exports: { tools: ["fake.write"], skills: [] },
    capabilities: [
      {
        name: "fake.write",
        resource: "fake",
        readOnly: false,
        replayPolicy: "verify",
        timeoutMs: 5_000,
        permissions: [],
        operations: ["write"],
      },
    ],
    auth: [],
    permissions: [],
    defaultPolicy: "enabled",
    config: {},
  });
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function fakeManifest(version = "0.1.0"): PluginManifest {
  return parsePluginManifest({
    id: "fake",
    name: "Fake",
    version,
    apiVersion: "1",
    trust: "builtin",
    entrypoint: "builtin:fake",
    exports: { tools: ["fake.echo"], skills: [] },
    capabilities: [
      {
        name: "fake.echo",
        resource: "fake",
        readOnly: true,
        replayPolicy: "verify",
        timeoutMs: 1_000,
        permissions: [],
        operations: ["read"],
      },
    ],
    auth: [],
    permissions: [],
    defaultPolicy: "enabled",
    config: {},
  });
}

function fakePlugin(version = "0.1.0", configured = true): BuiltinPlugin {
  return {
    manifest: fakeManifest(version),
    configured,
    createTools() {
      return configured ? [new FakeEchoTool()] : [];
    },
    connection(): PluginConnection {
      return { status: configured ? "connected" : "unconfigured" };
    },
  };
}

function taskWith(
  extension: TaskRecord["extension"],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id: "task-1",
    ownerId: "owner-1",
    conversationId: "conversation-1",
    sourceKey: "source-1",
    goal: "echo",
    completionCriteria: "echo",
    mandate: { resources: ["chat", "fake"], tools: ["fake.echo"] },
    revision: 1,
    status: "queued",
    priority: 0,
    attempts: 0,
    extension,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function actionWith(
  catalog: PluginCatalog,
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  const binding = catalog.bindingForTool("fake.echo");
  assert.ok(binding);
  return {
    id: "action-1",
    ownerId: "owner-1",
    conversationId: "conversation-1",
    taskId: "task-1",
    taskRevision: 1,
    fencingToken: 1,
    tool: "fake.echo",
    args: { value: "x" },
    argsHash: "hash",
    status: "approved",
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    nonce: "nonce-1",
    executionAttempts: 0,
    pluginId: binding.pluginId,
    pluginVersion: binding.pluginVersion,
    pluginDigest: binding.pluginDigest,
    catalogGeneration: binding.catalogGeneration,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function catalogFor(
  store: ReturnType<typeof createStore>,
  plugins: BuiltinPlugin[] = [fakePlugin()],
): { catalog: PluginCatalog; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  const catalog = new PluginCatalog({
    store,
    registry,
    plugins,
    now: () => NOW,
  });
  return { catalog, registry };
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
  token = ADMIN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${token}` },
  };
  return api.handle(request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

describe("plugin manifest", () => {
  it("accepts a namespaced builtin manifest and hashes it stably", () => {
    const manifest = fakeManifest();
    assert.equal(manifest.id, "fake");
    assert.equal(pluginDigest(manifest), pluginDigest(fakeManifest()));
  });

  it("rejects invalid ids, api versions, namespaces, duplicates and secrets", () => {
    const base = fakeManifest();
    assert.throws(
      () => parsePluginManifest({ ...base, id: "Bad Id" }),
      /manifest.id/,
    );
    assert.throws(
      () => parsePluginManifest({ ...base, apiVersion: "2" }),
      /apiVersion/,
    );
    assert.throws(
      () =>
        validatePluginSet([
          base,
          {
            ...base,
            exports: { tools: ["fake.echo"], skills: [] },
          },
        ]),
      /duplicate plugin id/,
    );
    const escaped = parsePluginManifest({
      ...base,
      exports: { tools: ["other.read"], skills: [] },
      capabilities: [
        {
          name: "other.read",
          resource: "fake",
          readOnly: true,
          replayPolicy: "verify",
          timeoutMs: 1_000,
          permissions: [],
          operations: [],
        },
      ],
    });
    assert.throws(() => validatePluginSet([escaped]), /outside the fake./);
    assert.throws(
      () =>
        parsePluginManifest({
          ...base,
          config: { token: "ghp_example" },
        }),
      /secret/,
    );
    assert.doesNotThrow(() =>
      parsePluginManifest({
        ...base,
        config: { tokenEnv: "GITHUB_TOKEN" },
      }),
    );
  });
});

describe("plugin catalog", () => {
  it("keeps Core available with no GitHub configuration", async () => {
    const services = createServices();
    const plugins = await services.plugins.list();
    const github = plugins.find((plugin) => plugin.id === "github");
    assert.ok(github);
    assert.equal(github.lifecycle, "disabled");
    assert.equal(github.connection.status, "unconfigured");
    assert.equal(services.tools.get("github.read"), undefined);
    assert.ok(services.tools.get("lamp.set_brightness"));
    assert.equal(services.catalog.generation() > 0, true);
    assert.deepEqual(services.catalog.snapshot().plugins, []);
    services.store.close();
  });

  it("refuses to enable an unconfigured plugin", async () => {
    const services = createServices({ now: () => NOW });
    await assert.rejects(
      services.plugins.enable("github", "owner"),
      /not configured/,
    );
    const plugin = await services.plugins.get("github");
    assert.equal(plugin?.enabled, false);
    services.store.close();
  });

  it("enables GitHub as a builtin plugin, disables it hot, and fences tasks", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    assert.ok(services.tools.get("github.read"));
    const initialGeneration = services.catalog.generation();
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:github-task",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    assert.deepEqual(
      task.extension?.plugins.map((plugin) => plugin.id),
      ["github"],
    );
    assert.equal(task.extension?.catalogGeneration, initialGeneration);

    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    assert.equal(action.pluginId, "github");
    assert.equal(action.catalogGeneration, initialGeneration);
    assert.ok(action.pluginDigest);

    const disabled = await services.plugins.disable("github", "owner");
    assert.equal(disabled.changed, true);
    assert.equal(disabled.generation, initialGeneration + 1);
    assert.deepEqual(disabled.removedTools, ["github.read"]);
    assert.equal(disabled.revokedActions, 1);
    assert.equal(services.actions.get(action.id)?.status, "superseded");
    assert.equal(services.tools.get("github.read"), undefined);
    assert.equal(
      services.catalog.checkAction(
        services.actions.get(action.id) as ActionRecord,
        task,
        "github.read",
      ),
      "plugin_disabled",
    );

    const enabled = await services.plugins.enable("github", "owner");
    assert.equal(enabled.changed, true);
    assert.equal(enabled.generation, initialGeneration + 2);
    assert.deepEqual(enabled.addedTools, ["github.read"]);
    assert.ok(services.tools.get("github.read"));
    assert.equal(
      services.catalog.checkAction(
        services.actions.get(action.id) as ActionRecord,
        task,
        "github.read",
      ),
      "catalog_generation_changed",
    );
    services.store.close();
  });

  it("revokes approvals when the GitHub credential changes", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:credential-change",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    const generation = services.catalog.generation();

    const result = await services.plugins.credentialChanged("github", "owner");
    assert.equal(result.generation, generation + 1);
    assert.equal(result.revokedActions, 1);
    assert.equal(services.actions.get(action.id)?.status, "superseded");
    assert.equal(
      services.actionService.propose(task, claimed.assignment, {
        tool: "github.read",
        args: { operation: "repo", repo: "owner/repo" },
      }),
      undefined,
    );
    services.store.close();
  });

  it("turns an in-flight write unknown when the plugin is disabled", async () => {
    const tool = new SlowWriteTool();
    const writePlugin: BuiltinPlugin = {
      manifest: fakeWriteManifest(),
      configured: true,
      createTools: () => [tool],
      connection: () => ({ status: "connected" }),
    };
    const services = createServices({
      now: () => NOW,
      builtinPlugins: [writePlugin],
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:in-flight-write",
      goal: "write",
      completionCriteria: "write",
      mandate: { resources: ["chat", "fake"], tools: ["fake.write"] },
    });
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "fake.write",
      args: { value: "x" },
    });
    assert.ok(action);
    assert.equal(
      services.actionService.approve({
        actionId: action.id,
        nonce: action.nonce,
        approverId: services.owner.id,
        conversationId: services.conversation.id,
      }).ok,
      true,
    );

    const running = services.actionService.handleExecute({ actionId: action.id });
    await sleep(5);
    const disabled = await services.plugins.disable("fake", "owner");
    assert.equal(disabled.inFlightActions, 1);
    tool.release();
    await running;

    assert.equal(services.actions.get(action.id)?.status, "unknown");
    assert.ok(
      services.effects
        .listPending()
        .some(
          (effect) =>
            effect.kind === "action.reconcile" &&
            effect.payload.actionId === action.id,
        ),
    );
    await services.effectDispatcher.drain(20);
    assert.equal(services.actions.get(action.id)?.status, "needs_manual");
    services.store.close();
  });

  it("keeps an in-flight write needs_manual when only the generation changed", async () => {
    const tool = new SlowWriteTool();
    const writePlugin: BuiltinPlugin = {
      manifest: fakeWriteManifest(),
      configured: true,
      createTools: () => [tool],
      connection: () => ({ status: "connected" }),
    };
    const services = createServices({
      now: () => NOW,
      builtinPlugins: [writePlugin],
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:reconcile-generation",
      goal: "write",
      completionCriteria: "write",
      mandate: { resources: ["chat", "fake"], tools: ["fake.write"] },
    });
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "fake.write",
      args: { value: "x" },
    });
    assert.ok(action);
    services.actionService.approve({
      actionId: action.id,
      nonce: action.nonce,
      approverId: services.owner.id,
      conversationId: services.conversation.id,
    });

    const running = services.actionService.handleExecute({ actionId: action.id });
    await sleep(5);
    const rotated = await services.plugins.credentialChanged("fake", "owner");
    assert.equal(rotated.generation, services.catalog.generation());
    tool.release();
    await running;
    assert.equal(services.actions.get(action.id)?.status, "unknown");

    await services.effectDispatcher.drain(20);
    assert.equal(services.actions.get(action.id)?.status, "needs_manual");
    assert.notEqual(services.actions.get(action.id)?.status, "superseded");
    services.store.close();
  });

  it("does not create a task for a capability that is not enabled", async () => {
    const services = createServices();
    services.model.push({
      action: "create_task",
      text: "好的",
      task: {
        goal: "read GitHub",
        completionCriteria: "summary",
        mandate: { resources: ["chat", "github"], tools: ["github.read"] },
      },
    });
    await sendText(services, "read GitHub owner/repo", "evt_plugin_disabled");
    assert.equal(services.tasks.listByOwner(services.owner.id).length, 0);
    assert.match(
      services.store
        .listRecentOutbox(10)
        .map((row) => row.text)
        .join("\n"),
      /未启用/,
    );
    services.store.close();
  });

  it("pauses a queued task when its capability is disabled before dispatch", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:queued-task",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    await services.plugins.disable("github", "owner");
    await services.effectDispatcher.drain(20);
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.match(current?.lastError ?? "", /capability unavailable/);
    services.store.close();
  });

  it("pauses a queued task when the catalog generation changed", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const task = services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "plugin:stale-generation-task",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    await services.plugins.disable("github", "owner");
    await services.plugins.enable("github", "owner");
    await services.effectDispatcher.drain(20);
    const current = services.tasks.get(task.id);
    assert.equal(current?.status, "needs_review");
    assert.match(current?.lastError ?? "", /catalog generation changed/);
    services.store.close();
  });

  it("persists disable across restart without bumping the generation", async () => {
    const store = createStore();
    const first = createServices({
      store,
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const disabled = await first.plugins.disable("github", "owner");
    const firstGeneration = disabled.generation;
    const second = createServices({
      store,
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const plugin = await second.plugins.get("github");
    assert.equal(plugin?.lifecycle, "disabled");
    assert.equal(second.tools.get("github.read"), undefined);
    assert.equal(second.catalog.generation(), firstGeneration);
    store.close();
  });

  it("rejects a plugin tool that collides with a core tool", async () => {
    const store = createStore();
    const registry = new ToolRegistry();
    registry.register(new FakeEchoTool());
    const catalog = new PluginCatalog({
      store,
      registry,
      plugins: [fakePlugin()],
      now: () => NOW,
    });
    const plugin = await catalog.get("fake");
    assert.equal(plugin?.lifecycle, "error");
    assert.match(plugin?.lastError ?? "", /conflict/);
    assert.ok(registry.get("fake.echo"));
    store.close();
  });

  it("invalidates an approved action when the catalog generation changes", async () => {
    const store = createStore();
    const first = catalogFor(store);
    const task = taskWith(first.catalog.snapshot());
    const action = actionWith(first.catalog);

    await first.catalog.setEnabled("fake", false, "owner");
    assert.equal(
      first.catalog.checkAction(action, task, "fake.echo"),
      "plugin_disabled",
    );
    await first.catalog.setEnabled("fake", true, "owner");
    assert.equal(
      first.catalog.checkAction(action, task, "fake.echo"),
      "catalog_generation_changed",
    );
    store.close();
  });

  it("fences old bindings after a plugin version change", async () => {
    const store = createStore();
    const first = catalogFor(store);
    const task = taskWith(first.catalog.snapshot());
    const action = actionWith(first.catalog);

    const secondRegistry = new ToolRegistry();
    const second = new PluginCatalog({
      store,
      registry: secondRegistry,
      plugins: [fakePlugin("0.1.1")],
      now: () => NOW,
    });
    assert.equal(second.generation(), first.catalog.generation() + 1);
    assert.equal(
      second.checkAction(action, task, "fake.echo"),
      "plugin_version_changed",
    );
    store.close();
  });
});

describe("plugin control plane", () => {
  it("serves list, status, enable and disable through the authenticated API", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "secret", allowedRepos: ["owner/repo"] },
    });
    const api = new ClientApiService({
      store: services.store,
      services,
      ownerId: services.owner.id,
      adminToken: ADMIN,
      now: () => NOW,
    });

    const list = await call(api, "GET", "/api/v1/plugins");
    assert.equal(list.status, 200);
    const plugins = list.body.plugins as { id: string; lifecycle: string }[];
    assert.equal(plugins[0]?.id, "github");

    const status = await call(api, "GET", "/api/v1/plugins/github");
    assert.equal(status.status, 200);
    assert.equal((status.body.plugin as { lifecycle: string }).lifecycle, "enabled");

    const disabled = await call(api, "POST", "/api/v1/plugins/github/disable");
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.changed, true);
    assert.equal((disabled.body.plugin as { lifecycle: string }).lifecycle, "disabled");

    const enabled = await call(api, "POST", "/api/v1/plugins/github/enable");
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body.plugin as { lifecycle: string }).lifecycle, "enabled");

    const missing = await call(api, "GET", "/api/v1/plugins/nope");
    assert.equal(missing.status, 404);
    services.store.close();
  });

  it("requires authentication and never exposes credentials", async () => {
    const services = createServices({
      now: () => NOW,
      github: { token: "super-secret-token", allowedRepos: ["owner/repo"] },
    });
    const api = new ClientApiService({
      store: services.store,
      services,
      ownerId: services.owner.id,
      adminToken: ADMIN,
      now: () => NOW,
    });
    const unauthenticated = await call(api, "POST", "/api/v1/plugins/github/disable", "");
    assert.equal(unauthenticated.status, 401);
    const list = await call(api, "GET", "/api/v1/plugins");
    assert.ok(!JSON.stringify(list.body).includes("super-secret-token"));
    services.store.close();
  });
});
