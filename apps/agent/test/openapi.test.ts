import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const specPath = fileURLToPath(new URL("../../../docs/api/openapi.json", import.meta.url));

const expected: Record<string, string[]> = {
  "/health": ["get"],
  "/status": ["get"],
  "/diagnostics": ["get"],
  "/usage": ["get"],
  "/tasks": ["get", "post"],
  "/tasks/{id}": ["get"],
  "/tasks/{id}/cancel": ["post"],
  "/tasks/{id}/revise": ["post"],
  "/tasks/{id}/supplement": ["post"],
  "/approvals": ["get"],
  "/approvals/{id}": ["get"],
  "/approvals/{id}/approve": ["post"],
  "/approvals/{id}/deny": ["post"],
  "/memories": ["get", "post"],
  "/memories/{key}": ["delete"],
  "/reminders": ["get", "post"],
  "/reminders/{id}": ["patch", "delete"],
  "/events": ["get"],
  "/events/stream": ["get"],
  "/tokens": ["get", "post"],
  "/tokens/{id}": ["delete"],
  "/plugins": ["get"],
  "/plugins/{id}": ["get"],
  "/plugins/{id}/enable": ["post"],
  "/plugins/{id}/disable": ["post"],
  "/skills": ["get"],
};

describe("OpenAPI contract", () => {
  it("documents the complete local API surface", async () => {
    const spec = JSON.parse(await readFile(specPath, "utf8")) as {
      openapi: string;
      servers: { url: string }[];
      security: { bearerAuth: string[] }[];
      paths: Record<string, Record<string, unknown>>;
      components: {
        securitySchemes: Record<string, unknown>;
        schemas: Record<string, unknown>;
        responses: Record<string, unknown>;
      };
    };
    assert.equal(spec.openapi, "3.1.0");
    assert.deepEqual(spec.servers, [{ url: "/api/v1" }]);
    assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
    assert.ok(spec.components.securitySchemes.bearerAuth);
    assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(expected).sort());

    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(expected)) {
      const item = spec.paths[path];
      assert.ok(item, path);
      for (const method of methods) {
        const operation = item[method] as {
          operationId?: string;
          responses?: Record<string, unknown>;
          security?: unknown;
        };
        assert.ok(operation, `${method} ${path}`);
        const operationId = operation.operationId;
        assert.equal(typeof operationId, "string");
        assert.ok(operationId !== undefined && operationId.length > 0);
        assert.equal(operationIds.has(operationId), false);
        operationIds.add(operationId);
        assert.ok(operation.responses?.["401"], `${method} ${path} 401`);
        assert.ok(operation.responses?.["429"], `${method} ${path} 429`);
        assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      }
    }
    const refs = [...JSON.stringify(spec).matchAll(/#\/components\/(schemas|responses)\/([A-Za-z0-9_]+)/g)];
    for (const match of refs) {
      const section = match[1] === "schemas" ? spec.components.schemas : spec.components.responses;
      assert.ok(section[match[2] as string], `missing component ${match[0]}`);
    }
  });
});
