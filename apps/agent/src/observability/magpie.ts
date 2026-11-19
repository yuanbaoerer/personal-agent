export interface BudgetCheckContext {
  role: "router" | "worker";
  /** Worker attempts are counted against this task's hard limit. */
  taskId?: string;
}

export interface BudgetCheck {
  ok: boolean;
  /** Present when a subscription window or gateway-key budget is exhausted. */
  reason?: string;
  /** Magpie was unreachable; direct providers are unaffected. */
  degraded?: boolean;
  /** The limit is permanent for this task; do not retry it. */
  permanent?: boolean;
  /** A time-scoped limit; retry no earlier than this ISO timestamp. */
  retryAt?: string;
}

export interface BudgetService {
  check(context?: BudgetCheckContext): Promise<BudgetCheck>;
  summaryText(): Promise<string>;
}

export interface MagpieConfig {
  baseUrl?: string;
  gatewayKey?: string;
  minRemainingPercent?: number;
  timeoutMs?: number;
  cacheMs?: number;
  fetch?: typeof fetch;
}

interface MagpieWindow {
  name: string;
  used?: number;
  remaining?: number;
  resetsAt?: string;
  limited?: boolean;
}

interface MagpieCard {
  plan?: string;
  windows: MagpieWindow[];
}

interface MagpieSnapshot {
  available: boolean;
  version?: string;
  cards: MagpieCard[];
  usage?: {
    period?: string;
    calls?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    unpriced?: number;
    errors?: number;
  };
  limited?: boolean;
  error?: string;
  fetchedAt: string;
}

const OPENCODE = /opencode/i;

/**
 * Reads the local Magpie gateway's usage/quotas surface. Magpie is optional:
 * an unreachable gateway degrades the budget view instead of blocking direct
 * providers. Subscription windows are matched only to OpenCode cards.
 */
export class MagpieBudget implements BudgetService {
  readonly #config: Required<Pick<MagpieConfig, "minRemainingPercent" | "timeoutMs" | "cacheMs">> &
    MagpieConfig;
  #cached?: { at: number; snapshot: Promise<MagpieSnapshot> };

  constructor(config: MagpieConfig) {
    this.#config = {
      ...config,
      minRemainingPercent: config.minRemainingPercent ?? 5,
      timeoutMs: config.timeoutMs ?? 5_000,
      cacheMs: config.cacheMs ?? 30_000,
    };
  }

  async check(): Promise<BudgetCheck> {
    const snapshot = await this.#snapshot();
    if (!snapshot.available) {
      return { ok: true, degraded: true, reason: snapshot.error ?? "magpie unavailable" };
    }
    if (snapshot.limited === true) {
      return { ok: false, reason: "Magpie gateway key budget is exhausted" };
    }
    const min = this.#config.minRemainingPercent;
    for (const card of snapshot.cards) {
      for (const window of card.windows) {
        if (window.limited === true) {
          return {
            ok: false,
            reason: `OpenCode Go window ${window.name} is limited`,
          };
        }
        const remaining =
          window.remaining ?? (window.used === undefined ? undefined : 100 - window.used);
        if (remaining !== undefined && remaining <= min) {
          return {
            ok: false,
            reason: `OpenCode Go window ${window.name} has ${remaining}% left`,
          };
        }
      }
    }
    return { ok: true };
  }

  async summaryText(): Promise<string> {
    const snapshot = await this.#snapshot();
    if (!snapshot.available) {
      return `Magpie：不可用（${snapshot.error ?? "未知原因"}）；Direct Provider 不受影响。`;
    }
    const version = snapshot.version?.trim();
    const lines = [
      `${version === undefined || version.length === 0 ? "Magpie" : `Magpie ${version}`} 网关今日用量（所有 Provider；订阅额度来自网关）`,
    ];
    if (snapshot.usage !== undefined) {
      const usage = snapshot.usage;
      lines.push(
        `请求 ${usage.calls ?? 0}，input ${usage.input ?? 0}，output ${usage.output ?? 0}，` +
          `cache read ${usage.cacheRead ?? 0}，费用 $${(usage.cost ?? 0).toFixed(4)}` +
          `${(usage.unpriced ?? 0) > 0 ? `（${usage.unpriced} 条未定价）` : "（估算/订阅）"}。`,
      );
    }
    if (snapshot.cards.length === 0) {
      lines.push("未发现 OpenCode Go 订阅卡；预算只按本地/网关 key 计数。");
    }
    for (const card of snapshot.cards) {
      lines.push(`OpenCode Go${card.plan === undefined ? "" : ` · ${card.plan}`}`);
      for (const window of card.windows) {
        const remaining =
          window.remaining ?? (window.used === undefined ? undefined : 100 - window.used);
        lines.push(
          `- ${window.name}: 已用 ${window.used ?? "?"}%，剩余 ${remaining ?? "?"}%` +
            `${window.resetsAt === undefined ? "" : `，重置 ${window.resetsAt}`}` +
            `${window.limited === true ? "（受限）" : ""}`,
        );
      }
    }
    if (snapshot.limited === true) {
      lines.push("Magpie gateway key 预算已耗尽，新的模型请求会被拒绝。");
    }
    return lines.join("\n");
  }

  #snapshot(): Promise<MagpieSnapshot> {
    const now = Date.now();
    if (this.#cached !== undefined && now - this.#cached.at < this.#config.cacheMs) {
      return this.#cached.snapshot;
    }
    const snapshot = this.#load();
    this.#cached = { at: now, snapshot };
    return snapshot;
  }

  async #load(): Promise<MagpieSnapshot> {
    const fetchedAt = new Date().toISOString();
    try {
      const [hello, quotas, usage, limit] = await Promise.allSettled([
        this.#get("/api/hello"),
        this.#get("/v1/magpie/quotas"),
        this.#get("/v1/magpie/usage?period=today"),
        this.#get("/v1/magpie/limit"),
      ]);
      if (quotas.status === "rejected") {
        throw quotas.reason;
      }
      return {
        available: true,
        version:
          hello.status === "fulfilled"
            ? stringField(asRecord(hello.value), "version")
            : undefined,
        cards: openCodeCards(quotas.value),
        usage: usage.status === "fulfilled" ? parseUsage(usage.value) : undefined,
        limited:
          limit.status === "fulfilled"
            ? booleanField(asRecord(limit.value), "limited")
            : undefined,
        fetchedAt,
      };
    } catch (error) {
      return {
        available: false,
        cards: [],
        error: error instanceof Error ? error.message : String(error),
        fetchedAt,
      };
    }
  }

  async #get(path: string): Promise<unknown> {
    const base = this.#config.baseUrl;
    if (base === undefined || base.trim().length === 0) {
      throw new Error("MAGPIE_URL is not configured");
    }
    const fetcher = this.#config.fetch ?? fetch;
    const response = await fetcher(new URL(path, base), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#config.gatewayKey ?? "magpie-personal-agent"}`,
        "user-agent": "personal-agent/0.1",
      },
      signal: AbortSignal.timeout(this.#config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`magpie request failed with status ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("magpie response was not valid JSON");
    }
  }
}

function openCodeCards(value: unknown): MagpieCard[] {
  const data = arrayField(asRecord(value), "data");
  const cards: MagpieCard[] = [];
  const opencodeOnly: Record<string, unknown>[] = [];
  for (const item of data) {
    const record = asRecord(item);
    const provider = stringField(record, "provider");
    const name = stringField(record, "name");
    const plan = stringField(record, "plan");
    const label = `${provider ?? ""} ${name ?? ""} ${plan ?? ""}`;
    if (!OPENCODE.test(label)) {
      continue;
    }
    if (!/\bgo\b/i.test(label)) {
      // A single OpenCode card without a literal "go" is still treated as
      // the Go subscription; with multiple OpenCode cards, only an explicit
      // Go label is used so Zen/ChatGPT cards cannot gate it.
      opencodeOnly.push(record);
      continue;
    }
    cards.push({ plan, windows: parseWindows(record) });
  }
  if (cards.length > 0) {
    return cards;
  }
  if (opencodeOnly.length === 1) {
    const record = opencodeOnly[0] as Record<string, unknown>;
    cards.push({ plan: stringField(record, "plan"), windows: parseWindows(record) });
  }
  return cards;
}

function parseWindows(record: Record<string, unknown>): MagpieWindow[] {
  const windows: MagpieWindow[] = [];
  for (const rawWindow of arrayField(record, "windows")) {
    const window = asRecord(rawWindow);
    const name = stringField(window, "name");
    if (name === undefined) {
      continue;
    }
    windows.push({
      name,
      used: numberField(window, "used"),
      remaining: numberField(window, "remaining"),
      resetsAt: stringField(window, "resetsAt"),
      limited: booleanField(window, "limited"),
    });
  }
  return windows;
}

function parseUsage(value: unknown): MagpieSnapshot["usage"] {
  const record = asRecord(value);
  return {
    period: stringField(record, "period"),
    calls: numberField(record, "calls"),
    input: numberField(record, "input"),
    output: numberField(record, "output"),
    cacheRead: numberField(record, "cache_read"),
    cacheWrite: numberField(record, "cache_write"),
    cost: numberField(record, "cost"),
    unpriced: numberField(record, "unpriced"),
    errors: numberField(record, "errors"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
