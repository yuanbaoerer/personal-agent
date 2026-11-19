import type { RouterDecision } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";
import type { MemoryService } from "../personal/memory.ts";
import type { ConfirmationService } from "../personal/confirmations.ts";
import type { ReminderService } from "../personal/reminders.ts";
import { assertTimezone, formatInTimezone } from "../personal/reminders.ts";
import type { SchedulePolicyService } from "../personal/schedule-policies.ts";
import {
  describeReminderCancelFailure,
  formatSchedulePolicy,
} from "./intent-format.ts";
import {
  extractProjectFlag,
  formatReminderCandidates,
  formatScheduleCandidates,
  resolveReminderReference,
  resolveScheduleReference,
  type ScheduleAction,
} from "./state-query.ts";

export interface IntentContext {
  ownerId: string;
  conversationId: string;
  inboxId: string;
  text: string;
}

export interface IntentReply {
  text: string;
  purpose: "ack" | "status" | "failure";
}

export interface IntentOutcome {
  replies: IntentReply[];
  /** The caller must wake the host after a confirmed schedule. */
  wake?: boolean;
}

export type PersonalIntentAction =
  | "save_memory"
  | "forget_memory"
  | "remind"
  | "cancel_reminder"
  | "draft_schedule"
  | "confirm_schedule"
  | "cancel_schedule";

const PERSONAL_ACTIONS: ReadonlySet<RouterDecision["action"]> = new Set([
  "save_memory",
  "forget_memory",
  "remind",
  "cancel_reminder",
  "draft_schedule",
  "confirm_schedule",
  "cancel_schedule",
]);

export interface PersonalIntentDeps {
  store: Store;
  memory: MemoryService;
  confirmation: ConfirmationService;
  reminders: ReminderService;
  schedulePolicy?: SchedulePolicyService;
  now: () => Date;
  timezone: string;
}

function reply(
  text: string,
  purpose: IntentReply["purpose"] = "ack",
): IntentOutcome {
  return { replies: [{ text, purpose }] };
}

/**
 * Owner-visible personal writes. Every path either reuses Confirmation or an
 * existing service; none mutates memory, reminders, or schedules directly.
 */
export class PersonalIntentHandler {
  readonly #store: Store;
  readonly #memory: MemoryService;
  readonly #confirmation: ConfirmationService;
  readonly #reminders: ReminderService;
  readonly #schedulePolicy?: SchedulePolicyService;
  readonly #now: () => Date;
  readonly #timezone: string;

  constructor(deps: PersonalIntentDeps) {
    this.#store = deps.store;
    this.#memory = deps.memory;
    this.#confirmation = deps.confirmation;
    this.#reminders = deps.reminders;
    this.#schedulePolicy = deps.schedulePolicy;
    this.#now = deps.now;
    this.#timezone = deps.timezone;
  }

  handles(action: RouterDecision["action"]): action is PersonalIntentAction {
    return PERSONAL_ACTIONS.has(action);
  }

  async handle(
    decision: RouterDecision,
    context: IntentContext,
  ): Promise<IntentOutcome> {
    switch (decision.action) {
      case "save_memory":
        return this.#saveMemory(decision, context);
      case "forget_memory":
        return this.#forgetMemory(decision, context);
      case "remind":
        return this.#remind(decision, context);
      case "cancel_reminder":
        return this.#cancelReminder(decision, context);
      case "draft_schedule":
        return this.#draftSchedule(decision, context);
      case "confirm_schedule":
      case "cancel_schedule":
        return this.#confirmOrCancelSchedule(decision, context);
      default:
        return reply("我还不能处理这个请求。", "failure");
    }
  }

  #saveMemory(decision: RouterDecision, context: IntentContext): IntentOutcome {
    if (decision.key === undefined || decision.value === undefined) {
      return reply("请提供要记住的 key 和 value。");
    }
    try {
      const project = extractProjectFlag(context.text) ?? decision.project;
      const created = this.#confirmation.create({
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        sourceInboxId: context.inboxId,
        kind: "memory_save",
        payload: { key: decision.key, value: decision.value, project },
      });
      const { confirmation } = created;
      if (confirmation.status !== "pending") {
        return reply("该记忆确认已处理，无需重复确认。");
      }
      const storedKey =
        typeof confirmation.payload.key === "string"
          ? confirmation.payload.key
          : decision.key;
      const storedValue =
        typeof confirmation.payload.value === "string"
          ? confirmation.payload.value
          : decision.value;
      const storedProject =
        typeof confirmation.payload.project === "string"
          ? confirmation.payload.project
          : undefined;
      return reply(
        `${created.inserted ? "" : "已存在同一消息的待确认项，展示原始内容：\n"}` +
          `请确认是否记住：${storedProject === undefined ? "" : `[项目 ${storedProject}] `}${storedKey} = ${storedValue}\n` +
          `回复 /确认 ${confirmation.id.slice(0, 8)}（10 分钟内有效）；` +
          `/取消确认 ${confirmation.id.slice(0, 8)} 可撤销。`,
        "status",
      );
    } catch (error) {
      return reply(
        `无法发起记忆确认：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #forgetMemory(decision: RouterDecision, context: IntentContext): IntentOutcome {
    if (decision.key === undefined) {
      return reply("请提供要忘记的记忆 key。");
    }
    try {
      const project = extractProjectFlag(context.text) ?? decision.project;
      const existing = this.#memory.get(context.ownerId, decision.key, project);
      if (existing === undefined) {
        return reply(
          `没有找到${project === undefined ? "" : `[项目 ${project}] `}记忆：${decision.key}`,
          "failure",
        );
      }
      const created = this.#confirmation.create({
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        sourceInboxId: context.inboxId,
        kind: "memory_save",
        payload: { operation: "forget", key: decision.key, project },
      });
      const { confirmation } = created;
      if (confirmation.status !== "pending") {
        return reply("该记忆确认已处理，无需重复确认。");
      }
      return reply(
        `${created.inserted ? "" : "已存在同一消息的待确认项，展示原始内容：\n"}` +
          `请确认是否忘记：${project === undefined ? "" : `[项目 ${project}] `}${decision.key}\n` +
          `回复 /确认 ${confirmation.id.slice(0, 8)}（10 分钟内有效）；` +
          `/取消确认 ${confirmation.id.slice(0, 8)} 可撤销。`,
        "status",
      );
    } catch (error) {
      return reply(
        `无法发起记忆删除确认：${error instanceof Error ? error.message : String(error)}`,
        "failure",
      );
    }
  }

  #remind(decision: RouterDecision, context: IntentContext): IntentOutcome {
    if (decision.dueAt === undefined || decision.text.trim().length === 0) {
      return reply("请提供提醒时间和内容。");
    }
    try {
      const timezone = decision.timezone ?? this.#timezone;
      const parsed = new Date(decision.dueAt);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.getTime() <= this.#now().getTime()
      ) {
        return reply("提醒时间无法解析或已经过去，请重新说明时间。");
      }
      assertTimezone(timezone);
      const minutes = Math.max(
        1,
        Math.min(
          10,
          Math.floor((parsed.getTime() - this.#now().getTime()) / 60_000),
        ),
      );
      const created = this.#confirmation.create({
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        sourceInboxId: context.inboxId,
        kind: "reminder_create",
        payload: {
          text: decision.text,
          dueAt: parsed.toISOString(),
          timezone,
          runKey: `inbox:${context.inboxId}:reminder`,
        },
        expiresAt: parsed.toISOString(),
      });
      const { confirmation } = created;
      if (confirmation.status !== "pending") {
        return reply("该提醒确认已处理，无需重复确认。");
      }
      const storedDueAt =
        typeof confirmation.payload.dueAt === "string"
          ? confirmation.payload.dueAt
          : parsed.toISOString();
      const storedTimezone =
        typeof confirmation.payload.timezone === "string"
          ? confirmation.payload.timezone
          : timezone;
      const storedText =
        typeof confirmation.payload.text === "string"
          ? confirmation.payload.text
          : decision.text;
      const when = `${formatInTimezone(storedDueAt, storedTimezone)}（${storedTimezone}）`;
      return reply(
        `${created.inserted ? "" : "已存在同一消息的待确认项，展示原始内容：\n"}` +
          `请确认提醒：${when}\n${storedText}\n` +
          `回复 /确认 ${confirmation.id.slice(0, 8)}（${minutes} 分钟内有效）；` +
          `/取消确认 ${confirmation.id.slice(0, 8)} 可撤销。`,
        "status",
      );
    } catch (error) {
      return reply(
        `无法发起提醒确认：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #cancelReminder(
    decision: RouterDecision,
    context: IntentContext,
  ): Promise<IntentOutcome> {
    const ref = decision.reminderRef ?? decision.scheduleId;
    const resolution = resolveReminderReference(
      context.ownerId,
      ref,
      this.#reminders.listPending(context.ownerId),
    );
    if (resolution.status === "ambiguous") {
      return reply(formatReminderCandidates(resolution.items), "failure");
    }
    if (resolution.status === "not_found") {
      return reply(resolution.reason, "failure");
    }
    const result = await this.#reminders.cancel(
      resolution.item.id,
      context.ownerId,
    );
    if (!result.ok) {
      return reply(
        `无法取消提醒：${describeReminderCancelFailure(result.reason)}`,
        "failure",
      );
    }
    // ReminderService already enqueued the owner-visible cancellation.
    return { replies: [] };
  }

  #draftSchedule(
    decision: RouterDecision,
    context: IntentContext,
  ): IntentOutcome {
    const service = this.#schedulePolicy;
    if (service === undefined) {
      return reply("当前运行未启用周期计划。", "failure");
    }
    const spec = decision.schedule;
    const missing = [
      spec?.repo === undefined ? "仓库（owner/name）" : undefined,
      spec?.localTime === undefined ? "本地时间（HH:MM）" : undefined,
      spec?.cadence === undefined ? "频率（每天/工作日）" : undefined,
      spec?.goal === undefined ? "汇报内容" : undefined,
    ].filter((item): item is string => item !== undefined);
    if (missing.length > 0) {
      return reply(
        `请补充周期计划：${missing.join("、")}。例如：工作日 09:00 总结 owner/name 的 PR。`,
        "failure",
      );
    }
    try {
      const result = service.createDraft(context.ownerId, context.conversationId, {
        repo: spec?.repo as string,
        localTime: spec?.localTime as string,
        cadence: spec?.cadence as "daily" | "weekdays",
        goal: spec?.goal as string,
        timezone: spec?.timezone,
        until: spec?.until,
      });
      if (!result.ok) {
        return reply(`无法创建计划草稿：${result.reason}`, "failure");
      }
      const receiver =
        this.#store.getConversation(context.conversationId)
          ?.platformConversationId ?? context.conversationId;
      return reply(
        [
          "已创建计划草稿（未激活，不会触发任务）：",
          formatSchedulePolicy(result.policy, true),
          `收件人：当前会话（${receiver}）`,
          "确认后才会按上述频率、仓库与内容创建任务并回传。",
          `确认：/schedule confirm ${result.policy.id}`,
          `或直接回复“确认计划 ${result.policy.id.slice(0, 8)}”。`,
          `取消：/schedule cancel ${result.policy.id}`,
        ].join("\n"),
        "status",
      );
    } catch (error) {
      return reply(
        `无法创建计划草稿：${error instanceof Error ? error.message : String(error)}`,
        "failure",
      );
    }
  }

  #confirmOrCancelSchedule(
    decision: RouterDecision,
    context: IntentContext,
  ): IntentOutcome {
    const service = this.#schedulePolicy;
    if (service === undefined) {
      return reply("当前运行未启用周期计划。", "failure");
    }
    const action: ScheduleAction =
      decision.action === "confirm_schedule" ? "confirm" : "cancel";
    if (
      action === "confirm" &&
      !/(?:确认|激活|启用|开启|同意|批准|可以|好的?|执行)/.test(context.text)
    ) {
      return reply(
        "激活周期计划需要明确确认。请回复“确认计划 <编号>”。",
        "failure",
      );
    }
    const ref = decision.scheduleId ?? decision.scheduleRef;
    const resolution = resolveScheduleReference(
      context.ownerId,
      ref,
      service.list(context.ownerId),
      action,
    );
    if (resolution.status === "ambiguous") {
      return reply(
        formatScheduleCandidates(resolution.items, action),
        "failure",
      );
    }
    if (resolution.status === "not_found") {
      return reply(resolution.reason, "failure");
    }
    const result =
      action === "confirm"
        ? service.confirm(context.ownerId, resolution.item.id)
        : service.cancel(context.ownerId, resolution.item.id);
    if (!result.ok) {
      return reply(
        `无法${action === "confirm" ? "确认" : "取消"}计划：${result.reason}`,
        "failure",
      );
    }
    return {
      replies: [
        {
          text: `${action === "confirm" ? "已确认并激活" : "已取消"}。\n${formatSchedulePolicy(result.policy, true)}`,
          purpose: "status",
        },
      ],
      wake: action === "confirm",
    };
  }
}
