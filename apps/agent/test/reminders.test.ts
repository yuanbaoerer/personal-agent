import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ScheduleRecord } from "../src/domain/types.ts";
import { createServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function fixture() {
  const scheduled: ScheduleRecord[] = [];
  const cancelled: string[] = [];
  let failSchedule = false;
  const services = createServices({
    now: () => NOW,
    reminderTimer: {
      async schedule(schedule) {
        if (failSchedule) throw new Error("host timer rejected");
        scheduled.push(schedule);
      },
      async cancel(id) {
        cancelled.push(id);
      },
    },
  });
  return {
    services,
    scheduled,
    cancelled,
    failNextSchedule() {
      failSchedule = true;
    },
  };
}

async function createReminder(services: ReturnType<typeof fixture>["services"]) {
  return services.reminders.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    text: "water",
    dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    timezone: "UTC",
  });
}

describe("reminder rescheduling", () => {
  it("updates dueAt and hands the new schedule to the host timer", async () => {
    const { services, scheduled, cancelled } = fixture();
    const reminder = await createReminder(services);
    const dueAt = new Date(NOW.getTime() + 7_200_000).toISOString();
    const result = await services.reminders.update(reminder.id, services.owner.id, {
      text: "water twice",
      dueAt,
      timezone: "Europe/London",
    });
    assert.equal(result.ok, true);
    assert.equal(result.schedule?.dueAt, dueAt);
    assert.equal(result.schedule?.text, "water twice");
    assert.equal(result.schedule?.timezone, "Europe/London");
    assert.equal(cancelled.at(-1), reminder.id);
    assert.equal(scheduled.at(-1)?.dueAt, dueAt);
  });

  it("restores the old row when the host timer rejects a reschedule", async () => {
    const { services, failNextSchedule } = fixture();
    const reminder = await createReminder(services);
    const oldDue = reminder.dueAt;
    failNextSchedule();
    const result = await services.reminders.update(reminder.id, services.owner.id, {
      dueAt: new Date(NOW.getTime() + 10_800_000).toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timer_failed");
    const restored = services.reminders.list(services.owner.id).find((row) => row.id === reminder.id);
    assert.equal(restored?.dueAt, oldDue);
  });

  it("rejects rescheduling a non-pending reminder", async () => {
    const { services } = fixture();
    const reminder = await createReminder(services);
    assert.equal((await services.reminders.cancel(reminder.id, services.owner.id)).ok, true);
    const result = await services.reminders.update(reminder.id, services.owner.id, {
      dueAt: new Date(NOW.getTime() + 10_800_000).toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "schedule_cancelled");
  });
});
