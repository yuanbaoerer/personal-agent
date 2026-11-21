import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClientApiService, type ClientApiRequest } from "../src/client-api.ts";
import { runCli } from "../src/cli.ts";
import type { ProjectBinding } from "../src/domain/types.ts";
import {
  ProjectValidationError,
  type BindProjectInput,
} from "../src/personal/projects.ts";
import { ProjectConflictError } from "../src/storage/projects.ts";
import { createServices } from "./services.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADMIN = "admin-secret";

function input(overrides: Partial<BindProjectInput> = {}): BindProjectInput {
  return {
    projectKey: "personal-agent",
    repositoryId: 101,
    repositoryFullName: "yuanbaoerer/personal-agent",
    defaultBranch: "main",
    credentialRef: "github:default",
    allowedPlanPaths: ["README.md", "docs/24-github-project-management.md"],
    ...overrides,
  };
}

function fixture() {
  const services = createServices({ now: () => NOW });
  const api = new ClientApiService({
    store: services.store,
    services,
    ownerId: services.owner.id,
    adminToken: ADMIN,
    now: () => NOW,
  });
  return { services, api };
}

async function call(
  api: ClientApiService,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    query?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ClientApiRequest = {
    method,
    path,
    query: new URLSearchParams(options.query),
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  return api.handle(request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (message: string) => out.push(message),
      err: (message: string) => err.push(message),
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("project bindings", () => {
  it("isolates bindings by owner and fences duplicate keys and repositories", () => {
    const { services } = fixture();
    const owner = services.owner.id;
    const first = services.projectService.bind(owner, input(), "admin");
    assert.equal(first.created, true);
    assert.equal(first.project.status, "active");
    assert.equal(first.project.version, 1);
    assert.deepEqual(first.project.allowedPlanPaths, [
      "README.md",
      "docs/24-github-project-management.md",
    ]);

    const second = services.projectService.bind(
      owner,
      input({
        projectKey: "personal-agent-docs",
        repositoryId: 102,
        repositoryFullName: "yuanbaoerer/docs",
      }),
      "admin",
    );
    assert.equal(second.created, true);
    assert.equal(services.projectService.list(owner).length, 2);
    assert.equal(services.projectService.list(owner, "active").length, 2);
    assert.equal(services.projectService.get(owner, first.project.id)?.projectKey, "personal-agent");

    const other = services.store.bindOwner({
      channel: "feishu",
      accountId: "other-app",
      actorId: "other-owner",
      verifiedAt: NOW.toISOString(),
    });
    assert.deepEqual(services.projectService.list(other.id), []);

    const repeated = services.projectService.bind(owner, input(), "admin");
    assert.equal(repeated.created, false);
    assert.equal(repeated.project.id, first.project.id);

    const renamed = services.projectService.bind(
      owner,
      input({ repositoryFullName: "yuanbaoerer/personal-agent-renamed" }),
      "admin",
    );
    assert.equal(renamed.created, false);
    assert.equal(renamed.project.id, first.project.id);
    assert.equal(renamed.project.version, 2);
    assert.equal(
      renamed.project.repositoryFullName,
      "yuanbaoerer/personal-agent-renamed",
    );

    assert.throws(
      () =>
        services.projectService.bind(
          owner,
          input({ repositoryId: 103 }),
          "admin",
        ),
      ProjectConflictError,
    );
    assert.throws(
      () =>
        services.projectService.bind(
          owner,
          input({
            projectKey: "another-key",
            repositoryId: 101,
          }),
          "admin",
        ),
      ProjectConflictError,
    );
    services.store.close();
  });

  it("revokes and rebinds without losing the historical row", () => {
    const { services } = fixture();
    const owner = services.owner.id;
    const bound = services.projectService.bind(owner, input(), "admin").project;
    const revoked = services.projectService.unbind(owner, bound.id, "admin");
    assert.ok(revoked);
    assert.equal(revoked.changed, true);
    assert.equal(revoked.project.status, "revoked");
    assert.equal(revoked.project.version, 2);
    assert.deepEqual(services.projectService.list(owner, "active"), []);
    assert.equal(services.projectService.list(owner, "revoked").length, 1);

    const repeated = services.projectService.unbind(owner, bound.id, "admin");
    assert.ok(repeated);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.project.version, 2);

    const rebound = services.projectService.bind(owner, input(), "admin");
    assert.equal(rebound.created, true);
    assert.notEqual(rebound.project.id, bound.id);
    assert.equal(services.projectService.list(owner).length, 2);
    services.store.close();
  });

  it("rejects invalid keys, repository ids, branches and plan paths", () => {
    const { services } = fixture();
    const owner = services.owner.id;
    const invalid = [
      input({ projectKey: "Bad Key" }),
      input({ repositoryId: 0 }),
      input({ repositoryFullName: "owner" }),
      input({ repositoryFullName: "owner/.." }),
      input({ defaultBranch: "main/../release" }),
      input({ credentialRef: "" }),
      input({ allowedPlanPaths: ["../secret"] }),
      input({ allowedPlanPaths: ["/etc/passwd"] }),
      input({ allowedPlanPaths: ["docs//x"] }),
    ];
    for (const value of invalid) {
      assert.throws(
        () => services.projectService.bind(owner, value, "admin"),
        ProjectValidationError,
      );
    }
    assert.deepEqual(services.projectService.list(owner), []);
    services.store.close();
  });

  it("serves bind/list/get/unbind through the authenticated API", async () => {
    const { services, api } = fixture();
    const created = await call(api, "POST", "/api/v1/projects", {
      token: ADMIN,
      body: input(),
    });
    assert.equal(created.status, 201);
    const project = created.body.project as ProjectBinding;
    assert.equal(created.body.created, true);
    assert.equal(project.projectKey, "personal-agent");
    assert.match(project.id.length > 0 ? project.id : "", /./);

    const listed = await call(api, "GET", "/api/v1/projects", { token: ADMIN });
    assert.equal(listed.status, 200);
    assert.equal((listed.body.projects as ProjectBinding[]).length, 1);

    const fetched = await call(api, "GET", `/api/v1/projects/${project.id}`, {
      token: ADMIN,
    });
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body.project as ProjectBinding).projectKey, "personal-agent");

    const conflict = await call(api, "POST", "/api/v1/projects", {
      token: ADMIN,
      body: input({ repositoryId: 202 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "project_conflict");

    const invalid = await call(api, "POST", "/api/v1/projects", {
      token: ADMIN,
      body: input({ allowedPlanPaths: ["../escape"] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_project");

    const unbound = await call(api, "DELETE", `/api/v1/projects/${project.id}`, {
      token: ADMIN,
    });
    assert.equal(unbound.status, 200);
    assert.equal(unbound.body.changed, true);
    assert.equal((unbound.body.project as ProjectBinding).status, "revoked");
    const again = await call(api, "DELETE", `/api/v1/projects/${project.id}`, {
      token: ADMIN,
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    const missing = await call(api, "GET", "/api/v1/projects/missing", {
      token: ADMIN,
    });
    assert.equal(missing.status, 404);
    assert.equal((await call(api, "GET", "/api/v1/projects")).status, 401);
    services.store.close();
  });

  it("binds and unbinds through the CLI without exposing a token", async () => {
    const project: ProjectBinding = {
      id: "project-1",
      ownerId: "owner-1",
      projectKey: "personal-agent",
      repositoryId: 101,
      repositoryFullName: "yuanbaoerer/personal-agent",
      defaultBranch: "main",
      credentialRef: "github:default",
      allowedPlanPaths: ["README.md"],
      status: "active",
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const seen: { method: string; url: string; body?: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        method: request.method,
        url: request.url,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      if (request.method === "POST") {
        return jsonResponse({ project, created: true }, 201);
      }
      if (request.method === "DELETE") {
        return jsonResponse({
          project: { ...project, status: "revoked", version: 2 },
          changed: true,
        });
      }
      return jsonResponse({ projects: [project] });
    };
    const env = { PA_API_URL: "http://api.local", PA_API_TOKEN: "pa_secret" };

    const bindIo = captureIo();
    assert.equal(
      await runCli(
        [
          "projects",
          "bind",
          "personal-agent",
          "yuanbaoerer/personal-agent",
          "--repo-id",
          "101",
          "--plan-paths",
          "README.md",
          "--json",
        ],
        env,
        bindIo.io,
        fakeFetch,
      ),
      0,
    );
    assert.equal(JSON.parse(bindIo.out[0] ?? "{}").created, true);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "http://api.local/api/v1/projects");
    assert.match(seen[0]?.body ?? "", /"repositoryId":101/);
    assert.ok(!bindIo.out.join("\n").includes("pa_secret"));

    const refusedIo = captureIo();
    assert.equal(
      await runCli(["projects", "unbind", project.id], env, refusedIo.io, fakeFetch),
      2,
    );
    assert.equal(seen.length, 1);

    const unbindIo = captureIo();
    assert.equal(
      await runCli(
        ["projects", "unbind", project.id, "--yes", "--json"],
        env,
        unbindIo.io,
        fakeFetch,
      ),
      0,
    );
    assert.equal(seen[1]?.method, "DELETE");
    assert.match(seen[1]?.url ?? "", /\/api\/v1\/projects\/project-1$/);
    assert.equal(JSON.parse(unbindIo.out[0] ?? "{}").changed, true);
  });
});
