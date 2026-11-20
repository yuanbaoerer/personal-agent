import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TaskRecord } from "../src/domain/types.ts";
import { ExtensionPolicyError } from "../src/domain/errors.ts";
import { ClientApiService, type ClientApiRequest } from "../src/client-api.ts";
import { runCli } from "../src/cli.ts";
import { FileSkillRuntime } from "../src/plugins/skills.ts";
import { createServices, sendText, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

function githubServices(): TestServices {
  return createServices({
    now: () => NOW,
    github: { token: "secret", allowedRepos: ["owner/repo"] },
    skills: new FileSkillRuntime({ root: "skills" }),
  });
}

function createReadTask(
  services: TestServices,
  key: string,
  options: {
    extensionPolicy?: NonNullable<TaskRecord["extension"]>["policy"];
    skills?: string[];
  } = {},
): TaskRecord {
  return services.taskService.create({
    ownerId: services.owner.id,
    conversationId: services.conversation.id,
    sourceKey: `policy:${key}`,
    goal: "read repo",
    completionCriteria: "summary",
    mandate: {
      resources: ["chat", "github"],
      tools: ["github.read"],
      skills: options.skills,
    },
    extensionPolicy: options.extensionPolicy,
  });
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(),
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "idempotency-key": `test-${Math.random()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  return api.handle(request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

describe("ExtensionPolicy", () => {
  it("persists a narrowing policy on the task revision", () => {
    const services = githubServices();
    const task = createReadTask(services, "persist", {
      extensionPolicy: { plugins: ["github"] },
    });
    assert.deepEqual(task.extension?.policy, { plugins: ["github"] });
    services.store.close();
  });

  it("rejects a mandate outside the plugin allowlist or permission ceiling", () => {
    const services = githubServices();
    assert.throws(
      () =>
        createReadTask(services, "plugin-denied", {
          extensionPolicy: { plugins: ["other"] },
        }),
      (error: unknown) =>
        error instanceof ExtensionPolicyError && /does not allow github/.test(error.message),
    );
    assert.throws(
      () =>
        createReadTask(services, "permission-denied", {
          extensionPolicy: { permissions: { "repository.read": "deny" } },
        }),
      (error: unknown) =>
        error instanceof ExtensionPolicyError && /denies repository\.read/.test(error.message),
    );
    services.store.close();
  });

  it("rejects a skill outside the policy allowlist", () => {
    const services = githubServices();
    assert.throws(
      () =>
        createReadTask(services, "skill-denied", {
          extensionPolicy: { skills: ["github.project-digest"] },
          skills: ["github.project-review"],
        }),
      (error: unknown) =>
        error instanceof ExtensionPolicyError && /does not allow github\.project-review/.test(error.message),
    );
    const allowed = createReadTask(services, "skill-allowed", {
      extensionPolicy: { skills: ["github.project-review"] },
      skills: ["github.project-review"],
    });
    assert.deepEqual(
      allowed.extension?.skills?.map((skill) => skill.id),
      ["github.project-review"],
    );
    services.store.close();
  });

  it("forces owner approval even with a read preauthorization", async () => {
    const services = githubServices();
    await sendText(services, "/allow-read owner/repo", "evt_policy_preauth");
    const task = createReadTask(services, "approval", {
      extensionPolicy: {
        permissions: { "repository.read": "require_approval" },
      },
    });
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const action = services.actionService.propose(task, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.ok(action);
    assert.equal(services.actions.get(action.id)?.status, "proposed");
    assert.equal(
      services.store
        .listRecentOutbox(20)
        .some((row) => row.text.includes("需要批准动作")),
      true,
    );
    services.store.close();
  });

  it("re-checks policy at proposal time even for a legacy task", () => {
    const services = githubServices();
    const task = createReadTask(services, "legacy-policy");
    const claimed = services.tasks.claimNext(NOW.toISOString(), 60_000, 2);
    assert.ok(claimed);
    const revised = services.tasks.revise(
      task.id,
      {
        extension: {
          ...(task.extension as NonNullable<TaskRecord["extension"]>),
          policy: { permissions: { "repository.read": "deny" } },
        },
      },
      NOW.toISOString(),
    );
    assert.ok(revised);
    const action = services.actionService.propose(revised, claimed.assignment, {
      tool: "github.read",
      args: { operation: "repo", repo: "owner/repo" },
    });
    assert.equal(action, undefined);
    const rejected = services.store.db.all<{ after_json: string }>(
      "SELECT after_json FROM pa_audit WHERE event = ? ORDER BY seq DESC LIMIT 1",
      "action.proposal_rejected",
    );
    assert.match(rejected[0]?.after_json ?? "", /permission_denied_by_policy/);
    services.store.close();
  });

  it("validates and applies extensionPolicy through the Client API", async () => {
    const services = githubServices();
    const api = new ClientApiService({
      store: services.store,
      services,
      ownerId: services.owner.id,
      adminToken: ADMIN,
      now: () => NOW,
    });
    const ok = await call(api, "POST", "/api/v1/tasks", {
      goal: "read repo",
      completionCriteria: "summary",
      mandate: {
        resources: ["chat", "github"],
        tools: ["github.read"],
      },
      extensionPolicy: {
        permissions: { "repository.read": "require_approval" },
      },
    });
    assert.equal(ok.status, 201);
    const task = ok.body.task as TaskRecord;
    assert.deepEqual(task.extension?.policy, {
      permissions: { "repository.read": "require_approval" },
    });

    const denied = await call(api, "POST", "/api/v1/tasks", {
      goal: "read repo",
      completionCriteria: "summary",
      mandate: { resources: ["chat", "github"], tools: ["github.read"] },
      extensionPolicy: { permissions: { "repository.read": "deny" } },
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error, "invalid_extension_policy");

    const invalid = await call(api, "POST", "/api/v1/tasks", {
      goal: "read repo",
      completionCriteria: "summary",
      extensionPolicy: { permissions: { "repository.read": "maybe" } },
    });
    assert.equal(invalid.status, 400);
    services.store.close();
  });

  it("sends policy flags through the CLI request body", async () => {
    let body = "";
    const fakeFetch: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          task: {
            id: "task-1",
            status: "queued",
            revision: 1,
            goal: "read repo",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const out: string[] = [];
    const code = await runCli(
      [
        "create",
        "read repo",
        "--tools",
        "github.read",
        "--plugins",
        "github",
        "--skills",
        "github.project-review",
        "--deny-permissions",
        "issue.write",
        "--require-approval",
        "repository.read",
        "--json",
      ],
      { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" },
      { out: (line) => out.push(line), err: () => {} },
      fakeFetch,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(body) as {
      mandate: { skills?: string[] };
      extensionPolicy: {
        plugins?: string[];
        permissions?: Record<string, string>;
      };
    };
    assert.deepEqual(parsed.mandate.skills, ["github.project-review"]);
    assert.deepEqual(parsed.extensionPolicy.plugins, ["github"]);
    assert.deepEqual(parsed.extensionPolicy.permissions, {
      "issue.write": "deny",
      "repository.read": "require_approval",
    });
  });
});
