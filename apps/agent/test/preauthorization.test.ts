import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "../src/app.ts";
import { StaticRouterModel } from "../src/coordinator/router.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { noopWake } from "../src/runtime/types.ts";
import { APP_ID, OWNER_OPEN_ID, createStore } from "./helpers.ts";
import { createServices, sendText, type TestServices } from "./services.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function githubFixture() {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          full_name: "owner/repo",
          default_branch: "main",
          pushed_at: START.toISOString(),
          open_issues_count: 1,
          html_url: "https://github.com/owner/repo",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  };
}

function readTask(services: TestServices, key: string) {
  return services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `source:${key}`,
    goal: "read repo",
    completionCriteria: "summary",
    mandate: { resources: ["chat", "github"], tools: ["github.read"] },
  });
}

describe("read-only preauthorization", () => {
  it("auto-approves an allow-listed GitHub read without an approval card", async () => {
    const github = githubFixture();
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_read");
    assert.equal(services.preauthorization.list(services.owner.id).length, 1);

    const task = readTask(services, "preauth-allowed");
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    assert.equal(services.actions.get(action.id)?.status, "approved");
    assert.equal(
      services.store
        .listRecentOutbox(10)
        .some((row) => row.text.includes("需要批准动作")),
      false,
    );

    await services.effectDispatcher.drain(20);

    assert.equal(services.actions.get(action.id)?.status, "succeeded");
    assert.equal(github.calls.length, 1);
    assert.match(
      services.store
        .listRecentOutbox(20)
        .map((row) => row.text)
        .join("\n"),
      /已按只读预授权执行/,
    );
  });

  it("does not auto-approve after revoke or outside the grant", async () => {
    const github = githubFixture();
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo", "owner/other"],
        fetch: github.fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_revoke");
    await sendText(services, "/revoke-read owner/repo", "evt_revoke");

    const task = readTask(services, "preauth-revoked");
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    assert.equal(services.actions.get(action.id)?.status, "proposed");

    const outside = readTask(services, "preauth-outside");
    const claimedAgain = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimedAgain);
    const other = services.actionService.propose(outside, claimedAgain.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/other" },
    });
    assert.ok(other);
    assert.equal(services.actions.get(other.id)?.status, "proposed");
    assert.equal(github.calls.length, 0);
  });

  it("auto-approves a report-proposed read after the report transaction commits", async () => {
    const github = githubFixture();
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_report");
    const task = readTask(services, "preauth-report");
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);

    services.taskService.report(claimed.assignment.id, claimed.assignment.fencingToken, 1, {
      status: "ready",
      summary: "read the repo",
      evidence: [{ kind: "test", value: "ok" }],
      proposedActions: [
        { tool: "github.read", args: { operation: "repo", repo: "owner/repo" } },
      ],
    });

    const [action] = services.actions.listByTask(task.id);
    assert.ok(action);
    assert.equal(action.status, "approved");
    services.taskService.report(claimed.assignment.id, claimed.assignment.fencingToken, 1, {
      status: "ready",
      summary: "read the repo",
      evidence: [{ kind: "test", value: "ok" }],
      proposedActions: [
        { tool: "github.read", args: { operation: "repo", repo: "owner/repo" } },
      ],
    });
    const messages = services.store.listRecentOutbox(20).map((row) => row.text).join("\n");
    assert.ok(!messages.includes("无法批准"));
    assert.ok(!messages.includes("需要批准动作"));
    assert.equal(
      services.store.db.all(
        "SELECT id FROM pa_audit WHERE event = ? AND subject_id = ?",
        "action.auto_approved",
        action.id,
      ).length,
      1,
    );

    await services.effectDispatcher.drain(20);
    assert.equal(services.actions.get(action.id)?.status, "succeeded");
    assert.equal(github.calls.length, 1);
  });

  it("stops an auto-approved read when the grant is revoked before execution", async () => {
    const github = githubFixture();
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_revoke_execute");
    const task = readTask(services, "preauth-revoke-execute");
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    services.taskService.report(claimed.assignment.id, claimed.assignment.fencingToken, 1, {
      status: "ready",
      summary: "read the repo",
      evidence: [{ kind: "test", value: "ok" }],
      proposedActions: [
        { tool: "github.read", args: { operation: "repo", repo: "owner/repo" } },
      ],
    });
    const [action] = services.actions.listByTask(task.id);
    assert.ok(action);
    assert.equal(action.status, "approved");

    await sendText(services, "/revoke-read owner/repo", "evt_revoke_before_execute");
    await services.effectDispatcher.drain(20);

    assert.equal(services.actions.get(action.id)?.status, "superseded");
    assert.equal(github.calls.length, 0);
  });

  it("does not auto-approve a different repo while a grant is active", async () => {
    const github = githubFixture();
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo", "owner/other"],
        fetch: github.fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_scope");

    const task = readTask(services, "preauth-scope");
    const claimed = services.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/other" },
    });
    assert.ok(action);
    assert.equal(services.actions.get(action.id)?.status, "proposed");
    assert.equal(github.calls.length, 0);
  });

  it("shows expired grants as expired and scopes grants to the owner", async () => {
    let current = START;
    const services = createServices({
      now: () => current,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: githubFixture().fetch,
      },
    });
    await sendText(services, "/allow-read owner/repo", "evt_allow_expiry");
    current = new Date(START.getTime() + 25 * 60 * 60_000);

    const [grant] = services.preauthorization.list(services.owner.id);
    assert.equal(grant?.status, "expired");
    const other = services.store.bindOwner({
      channel: "feishu",
      accountId: "app_1",
      actorId: "ou_other",
      verifiedAt: START.toISOString(),
    });
    assert.equal(
      services.preauthorization.isAllowed(other.id, "github.read", "owner/repo"),
      false,
    );

    await sendText(services, "/preauth", "evt_preauth_list");
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("expired")),
    );
  });

  it("wires preauthorization into createApp, not just the test harness", async () => {
    const github = githubFixture();
    const store = createStore();
    const owner = store.findOwner("feishu", APP_ID, OWNER_OPEN_ID);
    assert.ok(owner);
    const conversation = store.upsertConversation({
      ownerId: owner.id,
      channel: "feishu",
      accountId: APP_ID,
      platformConversationId: "oc_1",
      kind: "p2p",
      createdAt: START.toISOString(),
    });
    const app = createApp({
      store,
      runtime: new FakeRuntime(),
      wake: noopWake,
      model: new StaticRouterModel(),
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: github.fetch,
      },
    });
    assert.equal(app.preauthorization.grant(owner.id, "owner/repo").ok, true);
    const task = app.taskService.create({
      ownerId: owner.id,
      conversationId: conversation.id,
      sourceKey: "source:preauth-create-app",
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
    });
    const claimed = app.tasks.claimNext(START.toISOString(), 60_000, 2);
    assert.ok(claimed);

    app.taskService.report(claimed.assignment.id, claimed.assignment.fencingToken, 1, {
      status: "ready",
      summary: "read the repo",
      evidence: [{ kind: "test", value: "ok" }],
      proposedActions: [
        { tool: "github.read", args: { operation: "repo", repo: "owner/repo" } },
      ],
    });

    const [action] = app.actions.listByTask(task.id);
    assert.ok(action);
    assert.equal(action.status, "approved");
    store.close();
  });

  it("refuses a repo outside the connector allow list", async () => {
    const services = createServices({
      now: () => START,
      github: {
        token: "secret",
        allowedRepos: ["owner/repo"],
        fetch: githubFixture().fetch,
      },
    });

    await sendText(services, "/allow-read owner/other", "evt_allow_outside");

    assert.equal(services.preauthorization.list(services.owner.id).length, 0);
    assert.ok(
      services.store
        .listRecentOutbox(5)
        .some((row) => row.text.includes("不在 GITHUB_ALLOWED_REPOS")),
    );
  });
});
