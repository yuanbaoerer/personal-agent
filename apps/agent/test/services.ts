import { ActionService } from "../src/actions/service.ts";
import { createDefaultToolRegistry, type MockLampTool } from "../src/actions/tools.ts";
import { Router, StaticRouterModel } from "../src/coordinator/router.ts";
import { IngressService } from "../src/coordinator/ingress.ts";
import { TaskService } from "../src/coordinator/tasks.ts";
import { EffectDispatcher } from "../src/delivery/effects.ts";
import type { ConversationRecord, OwnerIdentity } from "../src/domain/types.ts";
import { MemoryService } from "../src/personal/memory.ts";
import { ReminderService } from "../src/personal/reminders.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { noopWake } from "../src/runtime/types.ts";
import { ActionRepository } from "../src/storage/actions.ts";
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
  runtime: FakeRuntime;
  lamp: MockLampTool;
  taskService: TaskService;
  actionService: ActionService;
  reminders: ReminderService;
  memory: MemoryService;
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
  const { registry, lamp } = createDefaultToolRegistry(store, now);
  const runtime = new FakeRuntime();

  const taskService = new TaskService({
    store,
    tasks,
    actions,
    effects,
    runtime,
    wake: noopWake,
    now,
    maxActiveWorkers: options.maxActiveWorkers ?? 2,
    assignmentLeaseMs: options.assignmentLeaseMs,
    assignmentMaxLifetimeMs: options.assignmentMaxLifetimeMs,
    maxTaskAttempts: options.maxTaskAttempts,
  });
  const actionService = new ActionService({
    store,
    actions,
    effects,
    tools: registry,
    wake: noopWake,
    now,
    actionTtlMs: options.actionTtlMs,
    tasks,
    onSettled: (taskId) => taskService.onActionSettled(taskId),
  });
  taskService.setActionProposer(actionService);

  const reminders = new ReminderService({ store, schedules, wake: noopWake, now });
  const memory = new MemoryService({ store, memories, now });
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
    model,
    wake: noopWake,
    now,
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
    runtime,
    lamp,
    taskService,
    actionService,
    reminders,
    memory,
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
