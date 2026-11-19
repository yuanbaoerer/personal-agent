import type { StateQuery, TaskRecord } from "../domain/types.ts";
import type { StateReadService, StateToolName } from "../actions/state.ts";
import type { TaskRepository } from "../storage/tasks.ts";
import type { Store } from "../storage/store.ts";
import type { IntentReply } from "./intent-types.ts";
import {
  extractProjectFlag,
  formatStateQuery,
  formatTaskCandidates,
  formatTaskNotFound,
  inferStateQuery,
  invalidProjectFlag,
  resolveTaskId,
  resolveTaskReference,
  taskFocusKey,
} from "./state-query.ts";

export interface StateQueryContext {
  ownerId: string;
  conversationId: string;
  inboxId: string;
  text?: string;
}

export interface StateQueryHandlerDeps {
  tasks: TaskRepository;
  state: StateReadService;
  store: Store;
  now: () => Date;
  timezone: string;
}

/**
 * Deterministic owner-scoped state reads. The model only proposes a target;
 * every id, ordinal, reference, and filter is resolved and read here.
 */
export class StateQueryHandler {
  readonly #tasks: TaskRepository;
  readonly #state: StateReadService;
  readonly #store: Store;
  readonly #now: () => Date;
  readonly #timezone: string;

  constructor(deps: StateQueryHandlerDeps) {
    this.#tasks = deps.tasks;
    this.#state = deps.state;
    this.#store = deps.store;
    this.#now = deps.now;
    this.#timezone = deps.timezone;
  }

  handle(
    context: StateQueryContext,
    requested?: StateQuery,
  ): IntentReply[] {
    const text = context.text ?? "";
    const flagProject = extractProjectFlag(text);
    if (invalidProjectFlag(text, flagProject)) {
      return [this.#failure("项目名无效：只允许 1–64 位字母、数字、点、下划线或连字符。")];
    }
    const query = requested ?? inferStateQuery(text) ?? { target: "summary" };
    const project = flagProject ?? query.project;
    if (
      project !== undefined &&
      (query.target === "reminders" || query.target === "schedules")
    ) {
      return [this.#failure("提醒和周期计划是 owner 级数据，不支持项目范围；请去掉项目筛选。")];
    }

    const resolvedTask = this.#resolveTask(query, context, text, project);
    if (resolvedTask.replies !== undefined) {
      return resolvedTask.replies;
    }
    const taskId = resolvedTask.taskId;

    const tool: StateToolName =
      query.target === "summary"
        ? "state.summary"
        : query.target === "tasks"
          ? "task.list"
          : query.target === "task"
            ? "task.get"
            : query.target === "reminders"
              ? "reminder.list"
              : query.target === "memories"
                ? "memory.list"
                : "schedule.list";
    const args: Record<string, unknown> = {};
    if (query.target === "tasks") {
      args.limit = query.limit ?? 5;
      args.offset = query.offset ?? 0;
      if (query.status !== undefined) {
        args.status = query.status;
      }
    } else if (query.target === "task") {
      args.taskId = taskId;
    } else if (
      query.target === "reminders" ||
      query.target === "memories" ||
      query.target === "schedules"
    ) {
      args.limit = query.limit ?? 5;
      args.offset = query.offset ?? 0;
    }

    let snapshot;
    try {
      snapshot = this.#state.read(
        tool,
        { ownerId: context.ownerId, project },
        args,
      );
    } catch (error) {
      return [
        this.#failure(
          `无法读取状态：${error instanceof Error ? error.message : String(error)}`,
        ),
      ];
    }

    this.#store.recordAudit({
      event: "state.query",
      subjectType: "owner",
      subjectId: context.ownerId,
      after: {
        source: "router.state_query",
        tool: snapshot.tool,
        target: query.target,
        args: snapshot.args,
        project: project ?? null,
        snapshotHash: snapshot.snapshotHash,
        snapshotAt: snapshot.snapshotAt,
        byteLength: snapshot.byteLength,
      },
      traceId: `inbox:${context.inboxId}`,
      occurredAt: this.#now().toISOString(),
    });

    const body = formatStateQuery(snapshot, this.#timezone);
    if (query.target !== "summary") {
      return [{ text: body, purpose: "status" }];
    }
    const service = [
      `服务：受理 ${this.#store.countInbox("accepted")} 条，拒绝 ${this.#store.countInbox("rejected")} 条；`,
      `待发送 ${this.#store.countOutbox("pending")} 条，` +
        `待核对投递 ${this.#store.countOutbox("unknown")} 条，` +
        `需人工 ${this.#store.countOutbox("needs_manual")} 条。`,
    ].join("");
    return [{ text: `${body}\n${service}`, purpose: "status" }];
  }

  #resolveTask(
    query: StateQuery,
    context: StateQueryContext,
    text: string,
    project: string | undefined,
  ): { taskId?: string; replies?: IntentReply[] } {
    if (query.target !== "task") {
      return {};
    }
    const explicitRef = query.taskId ?? query.taskRef;
    const textRef =
      explicitRef ??
      (/(?:第\s*(?:\d+|[一二两三四五六七八九十]+)|刚才|刚刚|之前|那个|这个|上一个)/.test(
        text,
      )
        ? text
        : undefined);
    if (textRef === undefined) {
      return {
        replies: [
          this.#failure(
            "请说明要查询哪一个任务：给出任务编号、序号或“刚才那个任务”。",
          ),
        ],
      };
    }
    const resolution =
      query.taskId === undefined
        ? resolveTaskReference(
            context.ownerId,
            context.conversationId,
            textRef,
            this.#tasks,
            {
              preferredTaskId: this.#store.metaGet(
                taskFocusKey(context.conversationId),
              ),
              project,
            },
          )
        : (() => {
            const explicit = resolveTaskId(
              context.ownerId,
              query.taskId,
              this.#tasks,
            );
            if (explicit.status === "ok") {
              const task = this.#tasks.get(explicit.id);
              return task === undefined ||
                (project !== undefined && task.mandate.project !== project)
                ? ({
                    status: "not_found",
                    reason: "找不到属于你的该任务。",
                  } as const)
                : ({ status: "ok", task } as const);
            }
            if (explicit.status === "ambiguous") {
              return {
                status: "ambiguous",
                candidates: explicit.ids
                  .map((id) => this.#tasks.get(id))
                  .filter((task): task is TaskRecord => task !== undefined),
              } as const;
            }
            return {
              status: "not_found",
              reason: "找不到属于你的该任务。",
            } as const;
          })();
    if (resolution.status === "ambiguous") {
      return {
        replies: [this.#failure(formatTaskCandidates(resolution.candidates))],
      };
    }
    if (resolution.status === "not_found") {
      return {
        replies: [this.#failure(formatTaskNotFound(resolution.reason, textRef))],
      };
    }
    this.#store.metaSet(
      taskFocusKey(context.conversationId),
      resolution.task.id,
    );
    return { taskId: resolution.task.id };
  }

  #failure(text: string): IntentReply {
    return { text, purpose: "failure" };
  }
}
