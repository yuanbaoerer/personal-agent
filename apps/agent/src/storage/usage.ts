import { randomUUID } from "node:crypto";

import type { RuntimeUsage, UsageAmounts } from "../domain/types.ts";
import type { Db } from "./db.ts";

export type UsageSource = "worker" | "router";
export type UsageCostKind = "provider" | "catalog" | "mixed" | "none";

export interface RecordUsageInput {
  ownerId: string;
  conversationId: string;
  source: UsageSource;
  /** Stable idempotency key: assignment id for workers, inbox id for Router calls. */
  operationId: string;
  sessionId: string;
  taskId?: string;
  assignmentId?: string;
  /** Cumulative conversation usage reported by the runtime. */
  cumulative: RuntimeUsage;
  durationMs?: number;
  at: string;
}

export interface UsageBySource {
  source: UsageSource;
  operations: number;
  totalTokens: number;
  costTotal: number;
}

export interface UsageByModel {
  model: string;
  totalTokens: number;
  costTotal: number;
}

export interface UsageLatency {
  samples: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

export interface UsageSummary {
  collected: boolean;
  operations: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costTotal: number;
  costKind: UsageCostKind;
  bySource: UsageBySource[];
  byModel: UsageByModel[];
  workerLatency: UsageLatency;
}

interface UsageRow {
  source: UsageSource;
  usage_json: string;
  cost_kind: UsageCostKind;
  duration_ms: number | null;
}

const ZERO_AMOUNTS: UsageAmounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function clamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function subtractAmounts(
  current: UsageAmounts,
  previous: UsageAmounts | undefined,
): UsageAmounts {
  const prior = previous ?? ZERO_AMOUNTS;
  const reasoning =
    current.reasoning === undefined && prior.reasoning === undefined
      ? undefined
      : clamp((current.reasoning ?? 0) - (prior.reasoning ?? 0));
  const totalCost = clamp(current.cost.total - prior.cost.total);
  return {
    input: clamp(current.input - prior.input),
    output: clamp(current.output - prior.output),
    cacheRead: clamp(current.cacheRead - prior.cacheRead),
    cacheWrite: clamp(current.cacheWrite - prior.cacheWrite),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: clamp(current.totalTokens - prior.totalTokens),
    cost: {
      input: clamp(current.cost.input - prior.cost.input),
      output: clamp(current.cost.output - prior.cost.output),
      cacheRead: clamp(current.cost.cacheRead - prior.cost.cacheRead),
      cacheWrite: clamp(current.cost.cacheWrite - prior.cost.cacheWrite),
      total: totalCost,
      ...(totalCost > 0 && current.cost.totalFromProvider === true
        ? { totalFromProvider: true }
        : {}),
    },
  };
}

function isEmptyAmounts(value: UsageAmounts): boolean {
  return (
    value.input === 0 &&
    value.output === 0 &&
    value.cacheRead === 0 &&
    value.cacheWrite === 0 &&
    (value.reasoning ?? 0) === 0 &&
    value.totalTokens === 0 &&
    value.cost.total === 0
  );
}

function subtractBuckets(
  current: Record<string, UsageAmounts>,
  previous: Record<string, UsageAmounts> | undefined,
): Record<string, UsageAmounts> {
  const result: Record<string, UsageAmounts> = {};
  for (const [key, bucket] of Object.entries(current)) {
    const prior = previous?.[key];
    const delta = subtractAmounts(bucket, prior);
    // A bucket that existed in the cursor but did not move is not a new call.
    if (prior !== undefined && isEmptyAmounts(delta)) {
      continue;
    }
    result[key] = delta;
  }
  return result;
}

/** Cumulative to per-operation delta, so a reused Router session is not double-counted. */
export function subtractUsage(
  current: RuntimeUsage,
  previous: RuntimeUsage | undefined,
): RuntimeUsage {
  return {
    models: subtractBuckets(current.models, previous?.models),
    tools: subtractBuckets(current.tools, previous?.tools),
  };
}

function parseUsage(text: string): RuntimeUsage | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const models = record.models;
    const tools = record.tools;
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models) ||
      typeof tools !== "object" ||
      tools === null ||
      Array.isArray(tools)
    ) {
      return undefined;
    }
    return { models: models as Record<string, UsageAmounts>, tools: tools as Record<string, UsageAmounts> };
  } catch {
    return undefined;
  }
}

function classifyCost(usage: RuntimeUsage): UsageCostKind {
  let provider = 0;
  let catalog = 0;
  for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
    if (bucket.cost.total <= 0) {
      continue;
    }
    if (bucket.cost.totalFromProvider === true) {
      provider += 1;
    } else {
      catalog += 1;
    }
  }
  if (provider === 0 && catalog === 0) {
    return "none";
  }
  if (catalog === 0) {
    return "provider";
  }
  if (provider === 0) {
    return "catalog";
  }
  return "mixed";
}

function totalsFor(usage: RuntimeUsage): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costTotal: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let totalTokens = 0;
  let costTotal = 0;
  for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
    input += bucket.input;
    output += bucket.output;
    cacheRead += bucket.cacheRead;
    cacheWrite += bucket.cacheWrite;
    reasoning += bucket.reasoning ?? 0;
    totalTokens += bucket.totalTokens;
    costTotal += bucket.cost.total;
  }
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, costTotal };
}

function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index];
}

export class UsageRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Returns false when the same `(source, operationId)` was already recorded. */
  record(input: RecordUsageInput): boolean {
    return this.#db.transaction(() => {
      const existing = this.#db.all<{ id: string }>(
        "SELECT id FROM pa_usage WHERE source = ? AND operation_id = ?",
        input.source,
        input.operationId,
      )[0];
      if (existing !== undefined) {
        return false;
      }
      const cursorRow = this.#db.all<{ usage_json: string }>(
        "SELECT usage_json FROM pa_usage_cursors WHERE source = ? AND session_id = ?",
        input.source,
        input.sessionId,
      )[0];
      const previous =
        cursorRow === undefined ? undefined : parseUsage(cursorRow.usage_json);
      const delta = subtractUsage(input.cumulative, previous);
      const totals = totalsFor(delta);
      this.#db.run(
        `INSERT INTO pa_usage
          (id, owner_id, conversation_id, task_id, assignment_id, session_id,
           operation_id, source, usage_json, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
           cost_total, cost_kind, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        input.ownerId,
        input.conversationId,
        input.taskId ?? null,
        input.assignmentId ?? null,
        input.sessionId,
        input.operationId,
        input.source,
        JSON.stringify(delta),
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.reasoning > 0 ? totals.reasoning : null,
        totals.totalTokens,
        totals.costTotal,
        classifyCost(delta),
        input.durationMs === undefined ? null : Math.max(0, Math.round(input.durationMs)),
        input.at,
      );
      this.#db.run(
        `INSERT INTO pa_usage_cursors (source, session_id, usage_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (source, session_id) DO UPDATE SET
           usage_json = excluded.usage_json,
           updated_at = excluded.updated_at`,
        input.source,
        input.sessionId,
        JSON.stringify(input.cumulative),
        input.at,
      );
      return true;
    });
  }

  summary(ownerId: string): UsageSummary {
    const rows = this.#db.all<UsageRow>(
      `SELECT source, usage_json, cost_kind, duration_ms
         FROM pa_usage
        WHERE owner_id = ?
        ORDER BY created_at ASC`,
      ownerId,
    );
    const bySource = new Map<UsageSource, UsageBySource>();
    const byModel = new Map<string, UsageByModel>();
    const durations: number[] = [];
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let totalTokens = 0;
    let costTotal = 0;
    let providerRows = 0;
    let catalogRows = 0;
    for (const row of rows) {
      const usage = parseUsage(row.usage_json);
      if (usage === undefined) {
        continue;
      }
      const totals = totalsFor(usage);
      input += totals.input;
      output += totals.output;
      cacheRead += totals.cacheRead;
      cacheWrite += totals.cacheWrite;
      reasoning += totals.reasoning;
      totalTokens += totals.totalTokens;
      costTotal += totals.costTotal;
      if (row.cost_kind === "provider") {
        providerRows += 1;
      } else if (row.cost_kind === "catalog") {
        catalogRows += 1;
      } else if (row.cost_kind === "mixed") {
        providerRows += 1;
        catalogRows += 1;
      }
      const source = bySource.get(row.source) ?? {
        source: row.source,
        operations: 0,
        totalTokens: 0,
        costTotal: 0,
      };
      source.operations += 1;
      source.totalTokens += totals.totalTokens;
      source.costTotal += totals.costTotal;
      bySource.set(row.source, source);
      for (const [model, bucket] of Object.entries(usage.models)) {
        const entry = byModel.get(model) ?? {
          model,
          totalTokens: 0,
          costTotal: 0,
        };
        entry.totalTokens += bucket.totalTokens;
        entry.costTotal += bucket.cost.total;
        byModel.set(model, entry);
      }
      if (row.source === "worker" && row.duration_ms !== null) {
        durations.push(row.duration_ms);
      }
    }
    durations.sort((left, right) => left - right);
    const costKind: UsageCostKind =
      providerRows > 0 && catalogRows > 0
        ? "mixed"
        : providerRows > 0
          ? "provider"
          : catalogRows > 0
            ? "catalog"
            : "none";
    return {
      collected: rows.length > 0,
      operations: rows.length,
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      totalTokens,
      costTotal,
      costKind,
      bySource: [...bySource.values()].sort((left, right) =>
        left.source.localeCompare(right.source),
      ),
      byModel: [...byModel.values()].sort((left, right) =>
        left.model.localeCompare(right.model),
      ),
      workerLatency: {
        samples: durations.length,
        ...(percentile(durations, 0.5) === undefined
          ? {}
          : {
              p50Ms: percentile(durations, 0.5),
              p95Ms: percentile(durations, 0.95),
              maxMs: durations.at(-1),
            }),
      },
    };
  }
}
