import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createServices, sendText, type TestServices } from "./services.ts";

function ownerMemories(services: TestServices, project?: string) {
  return services.memory
    .listApplicable(services.owner.id, project)
    .map((memory) => `${memory.project ?? "global"}:${memory.key}=${memory.value}`)
    .sort();
}

describe("project-scoped memory", () => {
  it("keeps global and project values separate", () => {
    const services = createServices();
    services.memory.save(services.owner.id, "city", "Shanghai");
    services.memory.save(services.owner.id, "city", "Beijing", "evt_a", "alpha");
    services.memory.save(services.owner.id, "owner", "alpha-team", "evt_b", "beta");

    assert.equal(services.memory.get(services.owner.id, "city")?.value, "Shanghai");
    assert.equal(
      services.memory.get(services.owner.id, "city", "alpha")?.value,
      "Beijing",
    );
    assert.equal(
      services.memory.get(services.owner.id, "owner", "alpha"),
      undefined,
    );
    assert.deepEqual(ownerMemories(services, "alpha"), [
      "alpha:city=Beijing",
      "global:city=Shanghai",
    ]);
    assert.deepEqual(ownerMemories(services, "beta"), [
      "beta:owner=alpha-team",
      "global:city=Shanghai",
    ]);

    assert.throws(
      () => services.memory.save(services.owner.id, "bad", "x", undefined, "bad scope"),
      /project must/,
    );
  });

  it("executes a block of slash commands in order without the model", async () => {
    const services = createServices();
    await sendText(
      services,
      [
        "/remember --project=pa-test repo=personal-agent",
        "/memory --project=pa-test",
      ].join("\n"),
      "evt_multi_command",
    );
    assert.equal(
      services.memory.get(services.owner.id, "repo", "pa-test")?.value,
      "personal-agent",
    );
    const texts = services.store.listRecentOutbox(5).map((row) => row.text);
    assert.ok(texts.some((text) => text.includes("已记住")));
    assert.ok(texts.some((text) => text.includes("repo = personal-agent")));
    assert.equal(services.runtime.submissions.length, 0);
  });

  it("supports scoped remember/list/forget commands", async () => {
    const services = createServices();
    await sendText(
      services,
      "/remember --project=alpha repo=personal-agent",
      "evt_project_memory",
    );
    await sendText(services, "/remember repo=global-repo", "evt_global_memory");
    assert.equal(
      services.memory.get(services.owner.id, "repo", "alpha")?.value,
      "personal-agent",
    );
    assert.equal(services.memory.get(services.owner.id, "repo")?.value, "global-repo");

    await sendText(services, "/memory --project=alpha", "evt_project_list");
    const listing = services.store
      .listRecentOutbox(5)
      .map((row) => row.text)
      .join("\n");
    assert.match(listing, /\[项目 alpha\] repo = personal-agent/);
    assert.match(listing, /\[全局\] repo = global-repo/);

    await sendText(services, "/forget --project=alpha repo", "evt_project_forget");
    assert.equal(services.memory.get(services.owner.id, "repo", "alpha")?.status, "deleted");
    assert.equal(services.memory.get(services.owner.id, "repo")?.value, "global-repo");

    await sendText(services, "/forget --project=项目 repo", "evt_bad_project");
    await sendText(services, "/memory --project=项目", "evt_bad_project_list");
    const rejection = services.store
      .listRecentOutbox(5)
      .map((row) => row.text)
      .join("\n");
    assert.match(rejection, /项目名无效/);
  });

  it("injects only global and same-project memories into a Worker prompt", async () => {
    const services = createServices();
    services.memory.save(services.owner.id, "tone", "concise");
    services.memory.save(services.owner.id, "repo", "alpha-repo", "evt_a", "alpha");
    services.memory.save(services.owner.id, "repo", "beta-repo", "evt_b", "beta");
    services.taskService.create({
      ownerId: services.owner.id,
      conversationId: services.conversation.id,
      sourceKey: "memory:alpha-task",
      goal: "summarize",
      completionCriteria: "summary",
      mandate: { resources: ["chat"], tools: [], project: "alpha" },
    });
    await services.effectDispatcher.drain(20);

    const prompt = services.runtime.submissions.at(-1)?.text ?? "";
    assert.match(prompt, /"project":null,"key":"tone","value":"concise"/);
    assert.match(prompt, /"project":"alpha","key":"repo","value":"alpha-repo"/);
    assert.ok(!prompt.includes("beta-repo"));
  });

  it("requires confirmation for a model-interpreted project memory", async () => {
    const services = createServices();
    services.model.push({
      action: "save_memory",
      text: "我看到你在做项目",
      key: "deploy",
      value: "staging",
      project: "alpha",
    });
    await sendText(services, "记住项目部署环境", "evt_model_project_memory");
    assert.equal(services.memory.get(services.owner.id, "deploy", "alpha"), undefined);
    const text = services.store
      .listRecentOutbox(5)
      .map((row) => row.text)
      .join("\n");
    assert.match(text, /\[项目 alpha\] deploy = staging/);
    const id = /\/确认 ([0-9a-f-]+)/.exec(text)?.[1];
    assert.ok(id);
    await sendText(services, `/确认 ${id}`, "evt_confirm_project_memory");
    assert.equal(
      services.memory.get(services.owner.id, "deploy", "alpha")?.value,
      "staging",
    );
  });
});
