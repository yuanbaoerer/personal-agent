import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { ClientApiService, type ClientApiRequest } from "../src/client-api.ts";
import { runCli } from "../src/cli.ts";
import type { CapabilityView } from "../src/plugins/fence.ts";
import type { SkillBinding } from "../src/domain/types.ts";
import { FileSkillRuntime, SKILL_FILE_MAX_BYTES } from "../src/plugins/skills.ts";
import { createServices, type TestServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

function skillFile(options: {
  id?: string;
  version?: string;
  description?: string;
  plugins?: string[];
  permissions?: string[];
  priority?: number;
  body?: string;
} = {}): string {
  const id = options.id ?? "github.project-review";
  const version = options.version ?? "1.0.0";
  const description = options.description ?? "Review a project";
  const plugins = options.plugins ?? ["github"];
  const permissions = options.permissions ?? ["repository.read"];
  const priority = options.priority ?? 0;
  const body = options.body ?? "SKILL_BODY_MARKER: inspect the receipts only.";
  return [
    "---",
    `id: ${id}`,
    `version: ${version}`,
    `description: ${description}`,
    `plugins: [${plugins.join(", ")}]`,
    `permissions: [${permissions.join(", ")}]`,
    `priority: ${priority}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function withSkillDir(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pa-skills-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function capabilityView(): CapabilityView {
  return {
    generation: () => 1,
    toolNames: () => ["github.read"],
    resources: () => ["chat", "github"],
    resourceForTool: (name) => (name === "github.read" ? "github" : undefined),
    toolInfo: (name) =>
      name === "github.read"
        ? {
            name,
            resource: "github",
            readOnly: true,
            replayPolicy: "verify",
            timeoutMs: 10_000,
            pluginId: "github",
            pluginVersion: "0.1.0",
            permissions: ["repository.read"],
            operations: ["repo"],
          }
        : undefined,
  };
}

function pluginBindings() {
  return [{ id: "github", version: "0.1.0", digest: "a".repeat(64) }];
}

function githubServices(skills: FileSkillRuntime): TestServices {
  return createServices({
    now: () => NOW,
    github: { token: "secret", allowedRepos: ["owner/repo"] },
    skills,
  });
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${ADMIN}` },
  };
  return api.handle(request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

describe("SKILL.md index", () => {
  it("indexes metadata and keeps bodies out of list()", async () => {
    await withSkillDir(
      {
        "a/SKILL.md": skillFile({ priority: 5 }),
        "b/SKILL.md": skillFile({
          id: "github.project-digest",
          description: "Digest",
        }),
      },
      async (root) => {
        const runtime = new FileSkillRuntime({ root });
        const skills = runtime.list();
        assert.deepEqual(
          skills.map((skill) => skill.id),
          ["github.project-digest", "github.project-review"],
        );
        assert.equal(skills[1]?.priority, 5);
        assert.equal(skills[1]?.digest.length, 64);
        assert.equal(skills.some((skill) => "body" in skill), false);
        assert.equal(runtime.errors().length, 0);
      },
    );
  });

  it("reports invalid, duplicate and oversized skills without executing them", async () => {
    await withSkillDir(
      {
        "broken/SKILL.md": "no frontmatter",
        "dup-a/SKILL.md": skillFile(),
        "dup-b/SKILL.md": skillFile(),
        "bad-plugin/SKILL.md": skillFile({
          id: "github.bad",
          plugins: ["github", "missing"],
        }),
        "huge/SKILL.md": skillFile({
          id: "github.huge",
          body: "x".repeat(SKILL_FILE_MAX_BYTES),
        }),
        "ignored/script.sh": "echo no",
      },
      async (root) => {
        const runtime = new FileSkillRuntime({ root });
        assert.deepEqual(
          runtime.list().map((skill) => skill.id),
          ["github.bad", "github.project-review"],
        );
        const reasons = runtime.errors().map((error) => error.reason);
        assert.ok(reasons.some((reason) => reason.includes("missing_frontmatter")));
        assert.ok(reasons.includes("duplicate skill id: github.project-review"));
        assert.ok(reasons.includes("skill_too_large"));
      },
    );
  });

  it("skips symlinks that escape the configured root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pa-skills-outside-"));
    await writeFile(join(outside, "SKILL.md"), skillFile({ id: "outside.skill" }));
    await withSkillDir({}, async (root) => {
      await symlink(join(outside, "SKILL.md"), join(root, "SKILL.md"));
      const runtime = new FileSkillRuntime({ root });
      assert.deepEqual(runtime.list(), []);
    });
    await rm(outside, { recursive: true, force: true });
  });
});

describe("skill selection and loading", () => {
  it("selects only skills whose plugin and permissions are active", async () => {
    await withSkillDir(
      {
        "review/SKILL.md": skillFile({ priority: 20 }),
        "write/SKILL.md": skillFile({
          id: "github.issue-write",
          permissions: ["issue.write"],
        }),
        "missing/SKILL.md": skillFile({
          id: "missing.skill",
          plugins: ["missing"],
        }),
      },
      async (root) => {
        const runtime = new FileSkillRuntime({ root });
        const result = runtime.select({
          mandate: {
            resources: ["github"],
            tools: ["github.read"],
            skills: [
              "github.issue-write",
              "missing.skill",
              "github.project-review",
              "not.indexed",
            ],
          },
          plugins: pluginBindings(),
          capabilities: capabilityView(),
        });
        assert.deepEqual(
          result.skills.map((skill) => skill.id),
          ["github.project-review"],
        );
        assert.deepEqual(
          result.rejected.map((item) => item.reason),
          ["permission_not_granted", "plugin_not_enabled", "skill_not_found"],
        );
      },
    );
  });

  it("rejects digest or version drift and disabled dependencies on load", async () => {
    await withSkillDir(
      { "review/SKILL.md": skillFile() },
      async (root) => {
        const runtime = new FileSkillRuntime({ root });
        const metadata = runtime.list()[0];
        assert.ok(metadata);
        const binding: SkillBinding = {
          id: metadata.id,
          version: metadata.version,
          digest: metadata.digest,
        };
        const loaded = runtime.load([binding], ["github"]);
        assert.equal(loaded.skills[0]?.body.includes("SKILL_BODY_MARKER"), true);
        assert.deepEqual(loaded.rejected, []);

        const disabled = runtime.load([binding], []);
        assert.deepEqual(disabled.rejected, [
          { id: binding.id, reason: "plugin_disabled" },
        ]);

        await writeFile(join(root, "review/SKILL.md"), skillFile({ body: "changed" }));
        const changed = runtime.load([binding], ["github"]);
        assert.deepEqual(changed.rejected, [
          { id: binding.id, reason: "skill_digest_changed" },
        ]);

        const versioned = runtime.load(
          [{ ...binding, version: "9.9.9" }],
          ["github"],
        );
        assert.deepEqual(versioned.rejected, [
          { id: binding.id, reason: "skill_version_changed" },
        ]);
      },
    );
  });

  it("rejects a body over the per-skill byte budget at load time", async () => {
    const body = "y".repeat(9 * 1024);
    await withSkillDir({ "big/SKILL.md": skillFile({ body }) }, async (root) => {
      const runtime = new FileSkillRuntime({ root });
      const metadata = runtime.list()[0];
      assert.ok(metadata);
      const loaded = runtime.load(
        [{ id: metadata.id, version: metadata.version, digest: metadata.digest }],
        ["github"],
      );
      assert.deepEqual(loaded.rejected, [
        { id: metadata.id, reason: "skill_body_budget" },
      ]);
    });
  });
});

describe("skill integration", () => {
  it("pins selected skills on the task and injects bounded guidance", async () => {
    await withSkillDir({ "review/SKILL.md": skillFile() }, async (root) => {
      const runtime = new FileSkillRuntime({ root });
      const services = githubServices(runtime);
      const task = services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: "skills:selected",
        goal: "review the repo",
        completionCriteria: "summary",
        mandate: {
          resources: ["chat", "github"],
          tools: ["github.read"],
          skills: ["github.project-review"],
        },
      });
      assert.deepEqual(
        task.extension?.skills?.map((skill) => skill.id),
        ["github.project-review"],
      );
      assert.equal(task.extension?.skills?.[0]?.digest.length, 64);
      await services.effectDispatcher.drain(20);
      const prompt = services.runtime.submissions.at(-1)?.text ?? "";
      assert.match(prompt, /Selected skills/);
      assert.match(prompt, /skill github\.project-review/);
      assert.match(prompt, /SKILL_BODY_MARKER/);
      services.store.close();
    });
  });

  it("records rejected skill requests and surfaces them to the Worker", async () => {
    await withSkillDir({ "review/SKILL.md": skillFile() }, async (root) => {
      const runtime = new FileSkillRuntime({ root });
      const services = githubServices(runtime);
      const task = services.taskService.create({
        ownerId: services.owner.id,
        conversationId: services.conversation.id,
        sourceKey: "skills:rejected",
        goal: "review the repo",
        completionCriteria: "summary",
        mandate: {
          resources: ["chat", "github"],
          tools: ["github.read"],
          skills: ["missing.skill"],
        },
      });
      assert.deepEqual(task.extension?.rejectedSkills, [
        { id: "missing.skill", reason: "skill_not_found" },
      ]);
      await services.effectDispatcher.drain(20);
      assert.match(
        services.runtime.submissions.at(-1)?.text ?? "",
        /missing\.skill: skill_not_found/,
      );
      services.store.close();
    });
  });

  it("serves skill metadata through the read-only API and CLI", async () => {
    await withSkillDir({ "review/SKILL.md": skillFile() }, async (root) => {
      const runtime = new FileSkillRuntime({ root });
      const services = githubServices(runtime);
      const api = new ClientApiService({
        store: services.store,
        services,
        ownerId: services.owner.id,
        adminToken: ADMIN,
        now: () => NOW,
      });
      const response = await call(api, "GET", "/api/v1/skills");
      assert.equal(response.status, 200);
      assert.equal(response.body.available, true);
      const skills = response.body.skills as { id: string; digest: string }[];
      assert.equal(skills[0]?.id, "github.project-review");
      assert.equal(skills[0]?.digest.length, 64);

      const out: string[] = [];
      const code = await runCli(
        ["skills", "list", "--json"],
        { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" },
        { out: (line) => out.push(line), err: () => {} },
        (async () =>
          new Response(JSON.stringify(response.body), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      );
      assert.equal(code, 0);
      assert.match(out.join("\n"), /github\.project-review/);
      services.store.close();
    });
  });
});
