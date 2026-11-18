import { ActionService } from "./actions/service.ts";
import { createDefaultToolRegistry } from "./actions/tools.ts";
import type { ToolRegistry } from "./actions/tools.ts";
import type { GitHubReadConfig } from "./actions/github.ts";
import { IngressService } from "./coordinator/ingress.ts";
import type { RouterModel } from "./coordinator/router.ts";
import { Router } from "./coordinator/router.ts";
import { TaskService } from "./coordinator/tasks.ts";
import { EffectDispatcher } from "./delivery/effects.ts";
import { MemoryService } from "./personal/memory.ts";
import { ConfirmationService } from "./personal/confirmations.ts";
import { PreauthorizationService } from "./personal/preauthorizations.ts";
import { MagpieBudget, type MagpieConfig } from "./observability/magpie.ts";
import { ReminderService, noopReminderTimer, type ReminderTimer } from "./personal/reminders.ts";
import type { AgentRuntime, WakeScheduler } from "./runtime/types.ts";
import { ActionRepository } from "./storage/actions.ts";
import { ConfirmationRepository } from "./storage/confirmations.ts";
import { PreauthorizationRepository } from "./storage/preauthorizations.ts";
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
  /** Host/extension seam for additional tools; keep writes in ActionService. */
  registerTools?: (registry: ToolRegistry) => void;
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
  taskService: TaskService;
  actionService: ActionService;
  reminders: ReminderService;
  memory: MemoryService;
  confirmation: ConfirmationService;
  preauthorization: PreauthorizationService;
  budget?: MagpieBudget;
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
  const budget =
    deps.magpie?.baseUrl === undefined ? undefined : new MagpieBudget(deps.magpie);
  const tasks = new TaskRepository(db);
  const actions = new ActionRepository(db);
  const effects = new EffectRepository(db);
  const schedules = new ScheduleRepository(db);
  const memories = new MemoryRepository(db);
  const confirmations = new ConfirmationRepository(db);
  const preauthorizations = new PreauthorizationRepository(db);
  const { registry } = createDefaultToolRegistry(store, deps.now, deps.github);
  deps.registerTools?.(registry);

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
  });
  const preauthorization = new PreauthorizationService({
    store,
    preauthorizations,
    allowedRepos: deps.github?.allowedRepos ?? [],
    now: deps.now,
  });
  const actionService = new ActionService({
    store,
    actions,
    effects,
    tools: registry,
    wake: deps.wake,
    now: deps.now,
    tasks,
    preauthorizations: preauthorization,
    onSettled: (taskId) => taskService.onActionSettled(taskId),
  });
  taskService.setActionProposer(actionService);

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
    budget,
    model: deps.model,
    wake: deps.wake,
    now: deps.now,
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
    taskService,
    actionService,
    reminders,
    memory,
    confirmation,
    preauthorization,
    budget,
    router,
    ingress,
    effectDispatcher,
  };
}
