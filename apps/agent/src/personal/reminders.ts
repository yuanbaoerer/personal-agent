import { randomUUID } from "node:crypto";

import type { ScheduleRecord } from "../domain/types.ts";
import type { ScheduleRepository } from "../storage/personal.ts";
import type { Store } from "../storage/store.ts";
import type { WakeScheduler } from "../runtime/types.ts";

export interface ReminderTimer {
  schedule(schedule: ScheduleRecord): Promise<void>;
  cancel(scheduleId: string): Promise<void>;
}

export const noopReminderTimer: ReminderTimer = {
  async schedule() {},
  async cancel() {},
};

export interface ReminderServiceDeps {
  store: Store;
  schedules: ScheduleRepository;
  wake: WakeScheduler;
  timer?: ReminderTimer;
  now?: () => Date;
  defaultTtlMs?: number;
}

export interface CreateReminderInput {
  ownerId: string;
  conversationId: string;
  text: string;
  dueAt: string;
  timezone: string;
  runKey?: string;
  ttlMs?: number;
}

/**
 * One-shot reminders. The unique runKey and the outbox businessKey both make
 * duplicate alarms and repeated firing harmless.
 */
export class ReminderService {
  readonly #store: Store;
  readonly #schedules: ScheduleRepository;
  readonly #wake: WakeScheduler;
  readonly #timer: ReminderTimer;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(deps: ReminderServiceDeps) {
    this.#store = deps.store;
    this.#schedules = deps.schedules;
    this.#wake = deps.wake;
    this.#timer = deps.timer ?? noopReminderTimer;
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.defaultTtlMs ?? 60 * 60_000;
  }

  async create(input: CreateReminderInput): Promise<ScheduleRecord> {
    const now = this.#now();
    const due = new Date(input.dueAt);
    if (Number.isNaN(due.getTime())) {
      throw new Error("dueAt must be an ISO timestamp");
    }
    if (due.getTime() <= now.getTime()) {
      throw new Error("dueAt must be in the future");
    }
    assertTimezone(input.timezone);

    const createdAt = now.toISOString();
    const runKey = input.runKey ?? `reminder:${randomUUID()}`;
    const { inserted, schedule } = this.#schedules.insert({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      runKey,
      dueAt: due.toISOString(),
      timezone: input.timezone,
      text: input.text,
      expiresAt: new Date(due.getTime() + (input.ttlMs ?? this.#ttlMs)).toISOString(),
      createdAt,
    });

    if (inserted) {
      try {
        await this.#timer.schedule(schedule);
      } catch (error) {
        // The row must not remain live if the host timer rejected it; the
        // polling/maintenance path would otherwise fire it at dueAt even
        // though the owner was told creation failed.
        this.#schedules.cancel(schedule.id, createdAt);
        this.#store.recordAudit({
          event: "schedule.timer_failed",
          subjectType: "schedule",
          subjectId: schedule.id,
          after: {
            runKey: schedule.runKey,
            error: error instanceof Error ? error.message : String(error),
          },
          traceId: `schedule:${schedule.id}`,
          occurredAt: createdAt,
        });
        throw error;
      }
      this.#store.recordAudit({
        event: "schedule.created",
        subjectType: "schedule",
        subjectId: schedule.id,
        after: {
          dueAt: schedule.dueAt,
          timezone: schedule.timezone,
          runKey: schedule.runKey,
        },
        traceId: `schedule:${schedule.id}`,
        occurredAt: createdAt,
      });
      this.#reply(
        schedule,
        "status",
        `提醒已创建：${formatInTimezone(schedule.dueAt, schedule.timezone)}（${schedule.timezone}）。`,
        "created",
      );
    }

    void this.#wake.wake();
    return schedule;
  }

  async fire(scheduleId: string): Promise<void> {
    const schedule = this.#schedules.get(scheduleId);
    if (schedule === undefined || schedule.status !== "pending") {
      return;
    }

    const now = this.#now();
    if (now.getTime() < new Date(schedule.dueAt).getTime()) {
      await this.#timer.schedule(schedule);
      return;
    }
    if (now.getTime() > new Date(schedule.expiresAt).getTime()) {
      if (this.#schedules.markSkipped(schedule.id, now.toISOString())) {
        this.#store.recordAudit({
          event: "schedule.skipped",
          subjectType: "schedule",
          subjectId: schedule.id,
          after: { reason: "expired", dueAt: schedule.dueAt },
          traceId: `schedule:${schedule.id}`,
          occurredAt: now.toISOString(),
        });
      }
      return;
    }

    if (!this.#schedules.markFired(schedule.id, now.toISOString())) {
      return;
    }

    const conversation = this.#store.getConversation(schedule.conversationId);
    if (conversation !== undefined) {
      this.#store.enqueueOutbox({
        businessKey: `reminder:${schedule.runKey}`,
        ownerId: schedule.ownerId,
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.platformConversationId,
        purpose: "reminder",
        text: schedule.text,
        createdAt: now.toISOString(),
        traceId: `schedule:${schedule.id}`,
      });
    }
    this.#store.recordAudit({
      event: "schedule.fired",
      subjectType: "schedule",
      subjectId: schedule.id,
      after: { runKey: schedule.runKey, firedAt: now.toISOString() },
      traceId: `schedule:${schedule.id}`,
      occurredAt: now.toISOString(),
    });
    void this.#wake.wake();
  }

  async fireDue(): Promise<number> {
    let fired = 0;
    for (const schedule of this.#schedules.listDue(this.#now().toISOString())) {
      await this.fire(schedule.id);
      fired += 1;
    }
    return fired;
  }

  async update(
    scheduleId: string,
    ownerId: string,
    changes: { text?: string; dueAt?: string; timezone?: string },
  ): Promise<{ ok: boolean; reason?: string; schedule?: ScheduleRecord }> {
    if (
      changes.text === undefined &&
      changes.dueAt === undefined &&
      changes.timezone === undefined
    ) {
      return { ok: false, reason: "no_changes" };
    }
    const normalizedText =
      changes.text === undefined ? undefined : changes.text.trim();
    if (
      normalizedText !== undefined &&
      (normalizedText.length === 0 || normalizedText.length > 1_000)
    ) {
      return { ok: false, reason: "invalid_text" };
    }
    const schedule = this.#schedules.get(scheduleId);
    if (schedule === undefined) {
      return { ok: false, reason: "schedule_not_found" };
    }
    if (schedule.ownerId !== ownerId) {
      return { ok: false, reason: "not_owner" };
    }
    if (schedule.status !== "pending") {
      return { ok: false, reason: `schedule_${schedule.status}` };
    }

    const nowDate = this.#now();
    const due =
      changes.dueAt === undefined ? new Date(schedule.dueAt) : new Date(changes.dueAt);
    if (Number.isNaN(due.getTime())) {
      return { ok: false, reason: "invalid_due_at" };
    }
    if (changes.dueAt !== undefined && due.getTime() <= nowDate.getTime()) {
      return { ok: false, reason: "due_at_not_future" };
    }
    const timezone = changes.timezone ?? schedule.timezone;
    try {
      assertTimezone(timezone);
    } catch {
      return { ok: false, reason: "invalid_timezone" };
    }

    const dueChanged = due.toISOString() !== schedule.dueAt;
    const ttlMs = Math.max(
      60_000,
      new Date(schedule.expiresAt).getTime() - new Date(schedule.dueAt).getTime(),
    );
    const expiresAt = dueChanged
      ? new Date(due.getTime() + ttlMs).toISOString()
      : undefined;
    const now = nowDate.toISOString();
    const updated = this.#schedules.updatePending(
      scheduleId,
      ownerId,
      {
        text: normalizedText,
        dueAt: dueChanged ? due.toISOString() : undefined,
        timezone: changes.timezone,
        expiresAt,
      },
      now,
    );
    if (updated === undefined) {
      return { ok: false, reason: "schedule_not_pending" };
    }

    if (dueChanged) {
      try {
        await this.#timer.cancel(scheduleId);
        await this.#timer.schedule(updated);
      } catch (error) {
        // Restore the old row and timer; the owner must not be told a
        // reschedule succeeded when the host timer rejected it.
        this.#schedules.updatePending(
          scheduleId,
          ownerId,
          {
            text: schedule.text,
            dueAt: schedule.dueAt,
            timezone: schedule.timezone,
            expiresAt: schedule.expiresAt,
          },
          now,
        );
        try {
          await this.#timer.schedule(schedule);
        } catch {
          // Maintenance polling remains the fallback.
        }
        this.#store.recordAudit({
          event: "schedule.timer_failed",
          subjectType: "schedule",
          subjectId: scheduleId,
          after: {
            runKey: schedule.runKey,
            error: error instanceof Error ? error.message : String(error),
          },
          traceId: `schedule:${scheduleId}`,
          occurredAt: now,
        });
        return { ok: false, reason: "timer_failed" };
      }
    }

    this.#store.recordAudit({
      event: "schedule.updated",
      subjectType: "schedule",
      subjectId: updated.id,
      after: {
        runKey: updated.runKey,
        dueAt: updated.dueAt,
        timezone: updated.timezone,
      },
      traceId: `schedule:${updated.id}`,
      occurredAt: now,
    });
    this.#reply(
      updated,
      "status",
      dueChanged
        ? `提醒已更新：${formatInTimezone(updated.dueAt, updated.timezone)}（${updated.timezone}）。`
        : "提醒已更新。",
      `updated:${randomUUID()}`,
    );
    return { ok: true, schedule: updated };
  }

  async cancel(
    scheduleId: string,
    ownerId: string,
  ): Promise<{ ok: boolean; reason?: string; schedule?: ScheduleRecord }> {
    const schedule = this.#schedules.get(scheduleId);
    if (schedule === undefined) {
      return { ok: false, reason: "schedule_not_found" };
    }
    if (schedule.ownerId !== ownerId) {
      return { ok: false, reason: "not_owner" };
    }
    if (!this.#schedules.cancel(scheduleId, this.#now().toISOString())) {
      return { ok: false, reason: `schedule_${schedule.status}` };
    }

    await this.#timer.cancel(scheduleId);
    this.#store.cancelOutboxByBusinessKey(`reminder:${schedule.runKey}`, this.#now().toISOString());
    this.#reply(schedule, "status", "提醒已取消。", "cancelled");
    this.#store.recordAudit({
      event: "schedule.cancelled",
      subjectType: "schedule",
      subjectId: schedule.id,
      after: { runKey: schedule.runKey },
      traceId: `schedule:${schedule.id}`,
      occurredAt: this.#now().toISOString(),
    });
    return { ok: true, schedule };
  }

  list(ownerId: string): ScheduleRecord[] {
    return this.#schedules.listByOwner(ownerId);
  }

  #reply(
    schedule: ScheduleRecord,
    purpose: "status" | "reminder",
    text: string,
    suffix: string,
  ): void {
    const conversation = this.#store.getConversation(schedule.conversationId);
    if (conversation === undefined) {
      return;
    }
    this.#store.enqueueOutbox({
      businessKey: `schedule:${schedule.id}:${suffix}`,
      ownerId: schedule.ownerId,
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.platformConversationId,
      purpose,
      text,
      createdAt: this.#now().toISOString(),
      traceId: `schedule:${schedule.id}`,
    });
  }
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid timezone: ${timezone}`);
  }
}

export function formatInTimezone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(iso));
}
