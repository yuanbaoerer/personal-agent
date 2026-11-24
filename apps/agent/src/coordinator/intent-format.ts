import type { SchedulePolicyRecord, ScheduleRecord } from "../domain/types.ts";

export function formatSchedules(schedules: readonly ScheduleRecord[]): string {
  if (schedules.length === 0) {
    return "当前没有提醒。";
  }
  return schedules
    .map(
      (schedule) =>
        `- ${schedule.id} ${schedule.status} ${schedule.dueAt} ${schedule.text}`,
    )
    .join("\n");
}

export function describeReminderCancelFailure(reason: string | undefined): string {
  if (reason === "schedule_not_found" || reason === "not_owner") {
    return "找不到属于你的该提醒。";
  }
  if (reason !== undefined && reason.startsWith("schedule_")) {
    return `该提醒当前状态为 ${reason.slice("schedule_".length)}，无法取消。`;
  }
  return reason ?? "未知原因";
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** Human-readable target: repository or owner-level internal state. */
export function scheduleTargetLabel(policy: SchedulePolicyRecord): string {
  return policy.kind === "internal" ? "内部状态" : policy.repo;
}

export function scheduleCadenceLabel(policy: SchedulePolicyRecord): string {
  if (policy.cadence === "weekdays") {
    return "工作日";
  }
  if (policy.cadence === "weekly") {
    const weekday = policy.weekday ?? 1;
    return `每周${WEEKDAY_LABELS[weekday] ?? ""}`;
  }
  return "每天";
}

export function formatSchedulePolicy(
  policy: SchedulePolicyRecord,
  full = false,
): string {
  const id = full ? policy.id : policy.id.slice(0, 8);
  const cadence = scheduleCadenceLabel(policy);
  const next = policy.nextRunAt === undefined ? "未排期" : policy.nextRunAt;
  return [
    `- ${id} [${policy.status}] ${cadence} ${policy.localTime} ${policy.timezone} ${scheduleTargetLabel(policy)}`,
    `  下次 ${next}，截止 ${policy.expiresAt}，版本 ${policy.version}`,
    `  内容：${policy.goal}`,
  ].join("\n");
}
