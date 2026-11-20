import { ActionService } from "./actions/service.ts";
import { StateReadService } from "./actions/state.ts";
import { createDefaultToolRegistry } from "./actions/tools.ts";
import type { ToolRegistry } from "./actions/tools.ts";
import type { GitHubReadConfig } from "./actions/github.ts";
import { PluginCatalog } from "./plugins/catalog.ts";
import { createGithubPlugin } from "./plugins/github.ts";
import { ExtensionService } from "./plugins/service.ts";
import type { BuiltinPlugin } from "./plugins/types.ts";
import { IngressService } from "./coordinator/ingress.ts";
import type { RouterModel } from "./coordinator/router.ts";
import { Router } from "./coordinator/router.ts";
import { TaskService } from "./coordinator/tasks.ts";
import { EffectDispatcher } from "./delivery/effects.ts";
import { MemoryService } from "./personal/memory.ts";
import { ConfirmationService } from "./personal/confirmations.ts";
import { PreauthorizationService } from "./personal/preauthorizations.ts";
import { SchedulePolicyService } from "./personal/schedule-policies.ts";
import {
  MagpieBudget,
  type BudgetService,
  type MagpieConfig,
} from "./observability/magpie.ts";
import { CallBudget } from "./observability/call-budget.ts";
import { ReminderService, noopReminderTimer, type ReminderTimer } from "./personal/reminders.ts";
import type { AgentRuntime, WakeScheduler } from "./runtime/types.ts";
import { ActionRepository } from "./storage/actions.ts";
import { ConfirmationRepository } from "./storage/confirmations.ts";
import { PreauthorizationRepository } from "./storage/preauthorizations.ts";
import { SchedulePolicyRepository } from "./storage/schedule-policies.ts";
import { EffectRepository } from "./storage/effects.ts";
import { MemoryRepository, ScheduleRepository } from "./storage/personal.ts";
import type { Store } from "./storage/store.ts";
import { TaskRepository } from "./storage/tasks.ts";

/**
 * Everything the business logic needs that only a host can supply. Node and
 * the Durable Object differ here and nowhere else: storage primitive, model
 * runtime, wake mechanism, reminder timer.
 */
export interface AppDeps {
  store: Store;
  runtime: AgentRuntime;
  wake: WakeScheduler;
  /** Router decisions come from the host's model runtime. */
  model: RouterModel;
  /** Durable timer for reminders; Node polls instead. */
  reminderTimer?: ReminderTimer;
  /** Read-only GitHub connector; omitted means the tool is unavailable. */
  github?: GitHubReadConfig;
  /** Optional Magpie usage/quotas adapter; omitted means local-only reporting. */
  magpie?: MagpieConfig;
  /** Local persistent request-count limits. */
  budgetLimits?: {
    maxCallsPerTask: number;
    maxCallsPerDay?: number;
    maxToolCallsPerTask: number;
    maxScheduleRunsPerDay: number;
  };
  /** Host/extension seam for additional tools; keep writes in ActionService. */
  registerTools?: (registry: ToolRegistry) => void;
  /** Override the built-in plugin set (tests and future trust tiers). */
  builtinPlugins?: readonly BuiltinPlugin[];
  now?: () => Date;
  maxActiveWorkers?: number;
}

export interface AppServices {
  tasks: TaskRepository;
  actions: ActionRepository;
  effects: EffectRepository;
  schedules: ScheduleRepository;
  memories: MemoryRepository;
  confirmations: ConfirmationRepository;
  preauthorizations: PreauthorizationRepository;
  schedulePolicies: SchedulePolicyRepository;
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
  effectDispatcher: EffectDispatcher;
}

/**
 * One wiring of the Coordinator, used by both hosts. Host-specific concerns
 * (HTTP, Feishu transport, outbox, alarms) stay in the host entry points.
 */
export function createApp(deps: AppDeps): AppServices {
  const { store } = deps;
  const db = store.db;
  const upstreamBudget =
    deps.magpie?.baseUrl === undefined ? undefined : new MagpieBudget(deps.magpie);
  const budget = new CallBudget({
    store,
    upstream: upstreamBudget,
    maxCallsPerTask: deps.budgetLimits?.maxCallsPerTask ?? 10,
    maxCallsPerDay: deps.budgetLimits?.maxCallsPerDay,
    now: deps.now,
  });
  const maxToolCallsPerTask = deps.budgetLimits?.maxToolCallsPerTask ?? 20;
  const maxScheduleRunsPerDay =
    deps.budgetLimits?.maxScheduleRunsPerDay ?? 20;
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
    now: deps.now,
  });
  const { registry } = createDefaultToolRegistry(store, deps.now, state);
  deps.registerTools?.(registry);
  const catalog = new PluginCatalog({
    store,
    registry,
    plugins: deps.builtinPlugins ?? [createGithubPlugin(deps.github)],
    now: deps.now,
  });

  const taskService = new TaskService({
    store,
    tasks,
    actions,
    effects,
    runtime: deps.runtime,
    wake: deps.wake,
    now: deps.now,
    maxActiveWorkers: deps.maxActiveWorkers,
    budget,
    memories,
    state,
    extensions: catalog,
    capabilities: catalog,
  });
  const preauthorization = new PreauthorizationService({
    store,
    preauthorizations,
    allowedRepos: deps.github?.allowedRepos ?? [],
    now: deps.now,
  });
  const schedulePolicy = new SchedulePolicyService({
    store,
    policies: schedulePolicies,
    tasks: taskService,
    allowedRepos: deps.github?.allowedRepos ?? [],
    now: deps.now,
    maxRunsPerDay: maxScheduleRunsPerDay,
    capabilities: catalog,
  });
  const actionService = new ActionService({
    store,
    actions,
    effects,
    tools: registry,
    wake: deps.wake,
    now: deps.now,
    tasks,
    maxToolCallsPerTask,
    preauthorizations: preauthorization,
    schedulePolicies: schedulePolicy,
    onSettled: (taskId) => taskService.onActionSettled(taskId),
    capabilities: catalog,
  });
  taskService.setActionProposer(actionService);
  const plugins = new ExtensionService({
    catalog,
    actions: actionService,
  });

  const reminders = new ReminderService({
    store,
    schedules,
    wake: deps.wake,
    timer: deps.reminderTimer ?? noopReminderTimer,
    now: deps.now,
  });
  const memory = new MemoryService({ store, memories });
  const confirmation = new ConfirmationService({
    store,
    confirmations,
    now: deps.now,
  });

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
    model: deps.model,
    wake: deps.wake,
    now: deps.now,
    capabilities: catalog,
  });

  const effectDispatcher = new EffectDispatcher({ effects });
  taskService.install(effectDispatcher);
  actionService.install(effectDispatcher);
  router.install(effectDispatcher);

  const ingress = new IngressService({ store, handler: router });

  return {
    tasks,
    actions,
    effects,
    schedules,
    memories,
    confirmations,
    preauthorizations,
    schedulePolicies,
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
    effectDispatcher,
  };
}
