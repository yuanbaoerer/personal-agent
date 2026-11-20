import { ActionService } from "../src/actions/service.ts";
import { StateReadService } from "../src/actions/state.ts";
import {
  createDefaultToolRegistry,
  type MockLampTool,
  type ToolRegistry,
} from "../src/actions/tools.ts";
import type { GitHubReadConfig } from "../src/actions/github.ts";
import { PluginCatalog } from "../src/plugins/catalog.ts";
import { createGithubPlugin } from "../src/plugins/github.ts";
import { ExtensionService } from "../src/plugins/service.ts";
import type { BuiltinPlugin } from "../src/plugins/types.ts";
import { Router, StaticRouterModel } from "../src/coordinator/router.ts";
import { IngressService } from "../src/coordinator/ingress.ts";
import { TaskService } from "../src/coordinator/tasks.ts";
import { EffectDispatcher } from "../src/delivery/effects.ts";
import type { ConversationRecord, OwnerIdentity } from "../src/domain/types.ts";
import { MemoryService } from "../src/personal/memory.ts";
import { ConfirmationService } from "../src/personal/confirmations.ts";
import { PreauthorizationService } from "../src/personal/preauthorizations.ts";
import { SchedulePolicyService } from "../src/personal/schedule-policies.ts";
import { MagpieBudget, type BudgetService, type MagpieConfig } from "../src/observability/magpie.ts";
import { ReminderService, type ReminderTimer } from "../src/personal/reminders.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { noopWake, type WakeScheduler } from "../src/runtime/types.ts";
import { ActionRepository } from "../src/storage/actions.ts";
import { ConfirmationRepository } from "../src/storage/confirmations.ts";
import { PreauthorizationRepository } from "../src/storage/preauthorizations.ts";
import { SchedulePolicyRepository } from "../src/storage/schedule-policies.ts";
import { EffectRepository } from "../src/storage/effects.ts";
import { MemoryRepository, ScheduleRepository } from "../src/storage/personal.ts";
import { TaskRepository } from "../src/storage/tasks.ts";
import type { Store } from "../src/storage/store.ts";
import { APP_ID, CONVERSATION_ID, OWNER_OPEN_ID, createStore, inbound } from "./helpers.ts";

export interface TestServices {
  store: Store;
  owner: OwnerIdentity;
  conversation: ConversationRecord;
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  schedules: ScheduleRepository;
  memories: MemoryRepository;
  confirmations: ConfirmationRepository;
  preauthorizations: PreauthorizationRepository;
  schedulePolicies: SchedulePolicyRepository;
  runtime: FakeRuntime;
  lamp: MockLampTool;
  tools: ToolRegistry;
  taskService: TaskService;
  actionService: ActionService;
  reminders: ReminderService;
  memory: MemoryService;
  confirmation: ConfirmationService;
  preauthorization: PreauthorizationService;
  schedulePolicy: SchedulePolicyService;
  state: StateReadService;
  budget?: BudgetService;
  catalog: PluginCatalog;
  plugins: ExtensionService;
  router: Router;
  ingress: IngressService;
  model: StaticRouterModel;
  effectDispatcher: EffectDispatcher;
  now: () => Date;
}

export function createServices(options: {
  now?: () => Date;
  store?: Store;
  maxActiveWorkers?: number;
  assignmentLeaseMs?: number;
  assignmentMaxLifetimeMs?: number;
  maxTaskAttempts?: number;
  actionTtlMs?: number;
  model?: StaticRouterModel;
  github?: GitHubReadConfig;
  builtinPlugins?: readonly BuiltinPlugin[];
  reminderTimer?: ReminderTimer;
  maxConcurrentTools?: number;
  maxToolCallsPerTask?: number;
  maxScheduleRunsPerDay?: number;
  budget?: BudgetService;
  magpie?: MagpieConfig;
  wake?: WakeScheduler;
} = {}): TestServices {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createStore();
  const owner =
    store.findOwner("feishu", APP_ID, OWNER_OPEN_ID) ??
    store.bindOwner({
      channel: "feishu",
      accountId: APP_ID,
      actorId: OWNER_OPEN_ID,
      verifiedAt: now().toISOString(),
    });
  const conversation = store.upsertConversation({
    ownerId: owner.id,
    channel: "feishu",
    accountId: APP_ID,
    platformConversationId: CONVERSATION_ID,
    kind: "p2p",
    createdAt: now().toISOString(),
  });

  const db = store.db;
  const tasks = new TaskRepository(db);
  const actions = new ActionRepository(db);
  const effects = new EffectRepository(db);
  const schedules = new ScheduleRepository(db);
  const memories = new MemoryRepository(db);
  const confirmations = new ConfirmationRepository(db);
  const preauthorizations = new PreauthorizationRepository(db);
  const schedulePolicies = new SchedulePolicyRepository(db);
  const state = new StateReadService({
    tasks,
    schedules,
    memories,
    schedulePolicies,
    now,
  });
  const { registry, lamp } = createDefaultToolRegistry(
    store,
    now,
    state,
  );
  const catalog = new PluginCatalog({
    store,
    registry,
    plugins: options.builtinPlugins ?? [createGithubPlugin(options.github)],
    now,
  });
  const runtime = new FakeRuntime();
  const wake = options.wake ?? noopWake;

  const budget = options.budget ?? (options.magpie === undefined ? undefined : new MagpieBudget(options.magpie));
  const taskService = new TaskService({
    store,
    tasks,
    actions,
    effects,
    runtime,
    wake,
    now,
    budget,
    maxActiveWorkers: options.maxActiveWorkers ?? 2,
    assignmentLeaseMs: options.assignmentLeaseMs,
    assignmentMaxLifetimeMs: options.assignmentMaxLifetimeMs,
    maxTaskAttempts: options.maxTaskAttempts,
    memories,
    state,
    extensions: catalog,
    capabilities: catalog,
  });
  const preauthorization = new PreauthorizationService({
    store,
    preauthorizations,
    allowedRepos: options.github?.allowedRepos ?? [],
    now,
  });
  const schedulePolicy = new SchedulePolicyService({
    store,
    policies: schedulePolicies,
    tasks: taskService,
    allowedRepos: options.github?.allowedRepos ?? [],
    now,
    maxRunsPerDay: options.maxScheduleRunsPerDay,
    capabilities: catalog,
  });
  const actionService = new ActionService({
    store,
    actions,
    effects,
    tools: registry,
    wake,
    now,
    actionTtlMs: options.actionTtlMs,
    maxConcurrentTools: options.maxConcurrentTools,
    maxToolCallsPerTask: options.maxToolCallsPerTask,
    tasks,
    preauthorizations: preauthorization,
    schedulePolicies: schedulePolicy,
    onSettled: (taskId) => taskService.onActionSettled(taskId),
    capabilities: catalog,
  });
  taskService.setActionProposer(actionService);
  const plugins = new ExtensionService({ catalog, actions: actionService });

  const reminders = new ReminderService({
    store,
    schedules,
    wake,
    timer: options.reminderTimer,
    now,
  });
  const memory = new MemoryService({ store, memories, now });
  const confirmation = new ConfirmationService({ store, confirmations, now });
  const model = options.model ?? new StaticRouterModel();
  const router = new Router({
    store,
    tasks,
    actions,
    effects,
    taskService,
    actionService,
    reminders,
    memory,
    confirmation,
    preauthorization,
    schedulePolicy,
    state,
    budget,
    model,
    wake,
    now,
    capabilities: catalog,
  });

  const effectDispatcher = new EffectDispatcher({ effects, now, maxAttempts: 20 });
  taskService.install(effectDispatcher);
  actionService.install(effectDispatcher);
  router.install(effectDispatcher);

  const ingress = new IngressService({ store, handler: router, now });

  return {
    store,
    owner,
    conversation,
    tasks,
    actions,
    effects,
    schedules,
    memories,
    confirmations,
    preauthorizations,
    schedulePolicies,
    runtime,
    lamp,
    tools: registry,
    taskService,
    actionService,
    reminders,
    memory,
    confirmation,
    preauthorization,
    schedulePolicy,
    state,
    budget,
    catalog,
    plugins,
    router,
    ingress,
    model,
    effectDispatcher,
    now,
  };
}

export async function sendText(
  services: TestServices,
  text: string,
  eventId = `evt_${Math.random().toString(36).slice(2)}`,
): Promise<void> {
  await services.ingress.accept(inbound({ text, platformEventId: eventId }));
  await services.effectDispatcher.drain(200);
}
