import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ID } from "./helpers.ts";
import { createServices, sendText } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

describe("model-interpreted personal writes", () => {
  it("waits for confirmation before saving memory", async () => {
    const services = createServices();
    services.model.push({
      action: "save_memory",
      key: "drink",
      value: "tea",
      text: "可能需要记住",
    });

    await sendText(services, "我平时喝什么？", "evt_confirm_memory");
    assert.equal(services.memory.get(services.owner.id, "drink"), undefined);
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);
    const prompt = services.store
      .listRecentOutbox(10)
      .find((row) => row.text.includes("请确认是否记住"));
    assert.ok(prompt);

    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_confirm_memory_yes",
    );

    assert.equal(services.memory.get(services.owner.id, "drink")?.value, "tea");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
  });

  it("cancels without writing and keeps explicit commands immediate", async () => {
    const services = createServices();
    services.model.push({
      action: "save_memory",
      key: "drink",
      value: "coffee",
      text: "可能需要记住",
    });
    await sendText(services, "记住我喝咖啡", "evt_cancel_memory");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);

    await sendText(
      services,
      `/取消确认 ${pending.id.slice(0, 8)}`,
      "evt_cancel_memory_no",
    );
    assert.equal(services.memory.get(services.owner.id, "drink"), undefined);
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);

    await sendText(services, "/remember city=Shanghai", "evt_explicit_memory");
    assert.equal(services.memory.get(services.owner.id, "city")?.value, "Shanghai");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
  });

  it("expires an unconfirmed write", async () => {
    let current = START;
    const services = createServices({ now: () => current });
    services.model.push({
      action: "save_memory",
      key: "drink",
      value: "water",
      text: "可能需要记住",
    });
    await sendText(services, "记住我喝水", "evt_expire_memory");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);

    current = new Date(START.getTime() + 11 * 60_000);
    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_expire_memory_yes",
    );

    assert.equal(services.memory.get(services.owner.id, "drink"), undefined);
    assert.equal(services.confirmations.get(pending.id)?.status, "expired");
  });

  it("rejects confirmation by another owner", async () => {
    const services = createServices();
    services.model.push({
      action: "save_memory",
      key: "drink",
      value: "tea",
      text: "可能需要记住",
    });
    await sendText(services, "记住我喝茶", "evt_owner_memory");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);
    const other = services.store.bindOwner({
      channel: "feishu",
      accountId: APP_ID,
      actorId: "ou_other",
      verifiedAt: START.toISOString(),
    });

    const result = services.confirmation.resolvePending(other.id, pending.id);

    assert.equal(result.status, "failure");
    assert.equal(services.memory.get(services.owner.id, "drink"), undefined);
  });

  it("waits for confirmation before creating a reminder", async () => {
    const services = createServices({ now: () => START });
    const dueAt = new Date(START.getTime() + 3_600_000).toISOString();
    services.model.push({
      action: "remind",
      text: "喝水",
      dueAt,
      timezone: "Asia/Shanghai",
    });

    await sendText(services, "一小时后提醒我喝水", "evt_confirm_reminder");
    assert.equal(services.reminders.list(services.owner.id).length, 0);
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);

    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_confirm_reminder_yes",
    );

    const schedules = services.reminders.list(services.owner.id);
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.text, "喝水");
    assert.match(schedules[0]?.runKey ?? "", /^inbox:.+:reminder$/);
  });

  it("rejects invalid reminder input before creating a confirmation", async () => {
    const services = createServices({ now: () => START });
    services.model.push({
      action: "remind",
      text: "喝水",
      dueAt: "not-a-date",
      timezone: "Asia/Shanghai",
    });
    await sendText(services, "提醒我喝水", "evt_bad_due");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
    assert.ok(
      services.store.listRecentOutbox(5).some((row) => row.text.includes("无法解析")),
    );

    services.model.push({
      action: "remind",
      text: "喝水",
      dueAt: new Date(START.getTime() + 3_600_000).toISOString(),
      timezone: "UTC+8",
    });
    await sendText(services, "提醒我喝水", "evt_bad_timezone");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("无法发起提醒确认")),
    );
  });

  it("rejects a memory confirmation superseded by an explicit change", async () => {
    let current = START;
    const services = createServices({ now: () => current });
    services.model.push({
      action: "save_memory",
      key: "drink",
      value: "tea",
      text: "可能需要记住",
    });
    await sendText(services, "记住我喝茶", "evt_stale_memory");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);

    current = new Date(START.getTime() + 60_000);
    await sendText(services, "/remember drink=coffee", "evt_newer_memory");
    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_stale_memory_yes",
    );

    assert.equal(services.memory.get(services.owner.id, "drink")?.value, "coffee");
    assert.equal(services.confirmations.get(pending.id)?.status, "cancelled");
  });

  it("closes a confirmation whose apply step fails", async () => {
    const services = createServices();
    services.model.push({
      action: "save_memory",
      key: "k".repeat(65),
      value: "v",
      text: "可能需要记住",
    });
    await sendText(services, "记住这个", "evt_invalid_memory");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);

    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_invalid_memory_yes",
    );

    assert.equal(services.confirmations.get(pending.id)?.status, "cancelled");
    assert.equal(services.confirmations.listPending(services.owner.id).length, 0);
  });

  it("sweeps expired pending confirmations and excludes them from the count", () => {
    let current = START;
    const services = createServices({ now: () => current });
    const { confirmation } = services.confirmation.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceInboxId: "inbox:expire-sweep",
      kind: "memory_save",
      payload: { key: "drink", value: "tea" },
    });
    assert.equal(services.confirmation.countPending(), 1);

    current = new Date(START.getTime() + 11 * 60_000);
    assert.equal(services.confirmation.countPending(), 0);
    assert.equal(services.confirmation.countPending("other-owner"), 0);
    assert.equal(services.confirmation.expirePending(), 1);
    assert.equal(services.confirmations.get(confirmation.id)?.status, "expired");
    assert.equal(services.confirmation.countPending(), 0);
  });

  it("never leaves a live schedule when the host timer rejects", async () => {
    const services = createServices({
      now: () => START,
      reminderTimer: {
        async schedule() {
          throw new Error("timer down");
        },
        async cancel() {},
      },
    });

    await sendText(
      services,
      `/remind ${new Date(START.getTime() + 3_600_000).toISOString()} drink tea`,
      "evt_timer_failure",
    );

    const schedules = services.reminders.list(services.owner.id);
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.status, "cancelled");
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("无法创建提醒")),
    );
  });

  it("never advertises a confirmation window beyond the reminder due time", async () => {
    let current = START;
    const services = createServices({ now: () => current });
    const dueAt = new Date(START.getTime() + 3 * 60_000);
    services.model.push({
      action: "remind",
      text: "喝水",
      dueAt: dueAt.toISOString(),
      timezone: "Asia/Shanghai",
    });

    await sendText(services, "3 分钟后提醒我喝水", "evt_short_reminder");
    const [pending] = services.confirmations.listPending(services.owner.id);
    assert.ok(pending);
    assert.equal(pending.expiresAt, dueAt.toISOString());
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("3 分钟内有效")),
    );

    current = new Date(dueAt.getTime() + 1_000);
    await sendText(
      services,
      `/确认 ${pending.id.slice(0, 8)}`,
      "evt_short_reminder_yes",
    );
    assert.equal(services.confirmations.get(pending.id)?.status, "expired");
    assert.equal(services.reminders.list(services.owner.id).length, 0);
  });
});
