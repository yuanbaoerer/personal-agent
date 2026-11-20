import type { Store } from "../storage/store.ts";
import type {
  BudgetCheck,
  BudgetCheckContext,
  BudgetService,
} from "./magpie.ts";

const TASK_PREFIX = "budget:model_calls:task:";
const DAY_PREFIX = "budget:model_calls:day:";

export interface CallBudgetConfig {
  store: Store;
  /** Hard model-request limit for one task. Default 10. */
  maxCallsPerTask?: number;
  /** Optional daily model-request limit across Router and Workers. */
  maxCallsPerDay?: number;
  /** Optional external quota source (Magpie); checked first. */
  upstream?: BudgetService;
  now?: () => Date;
}

/**
 * Persistent request-count budget. It counts a model request only after all
 * checks pass; a rejected request never consumes quota. Counters live in
 * pa_meta so a restart does not reset the limit.
 */
export class CallBudget implements BudgetService {
  readonly #store: Store;
  readonly #maxCallsPerTask: number;
  readonly #maxCallsPerDay?: number;
  readonly #upstream?: BudgetService;
  readonly #now: () => Date;

  constructor(config: CallBudgetConfig) {
    this.#store = config.store;
    this.#maxCallsPerTask = config.maxCallsPerTask ?? 10;
    this.#maxCallsPerDay = config.maxCallsPerDay;
    this.#upstream = config.upstream;
    this.#now = config.now ?? (() => new Date());
  }

  async check(context?: BudgetCheckContext): Promise<BudgetCheck> {
    if (this.#upstream !== undefined) {
      const upstream = await this.#upstream.check(context);
      if (!upstream.ok) {
        return upstream;
      }
    }
    const taskId = context?.taskId;
    const taskCount =
      taskId === undefined ? undefined : this.#count(`${TASK_PREFIX}${taskId}`);
    if (
      taskCount !== undefined &&
      taskCount >= this.#maxCallsPerTask
    ) {
      return {
        ok: false,
        permanent: true,
        reason: `任务模型请求已达上限（${this.#maxCallsPerTask} 次）`,
      };
    }
    const dayKey = this.#dayKey(this.#now());
    const dayCount = this.#count(dayKey);
    if (
      this.#maxCallsPerDay !== undefined &&
      dayCount >= this.#maxCallsPerDay
    ) {
      return {
        ok: false,
        retryAt: this.#nextUtcMidnight(this.#now()),
        reason: `今日模型请求已达上限（${this.#maxCallsPerDay} 次）`,
      };
    }

    // Reserve synchronously: no await between read and write.
    if (taskId !== undefined && taskCount !== undefined) {
      this.#store.metaSet(`${TASK_PREFIX}${taskId}`, String(taskCount + 1));
    }
    this.#store.metaSet(dayKey, String(dayCount + 1));
    return { ok: true };
  }

  async summaryText(): Promise<string> {
    const now = this.#now();
    const dayKey = this.#dayKey(now);
    const used = this.#count(dayKey);
    const daily =
      this.#maxCallsPerDay === undefined
        ? `今日 ${used} 次（每日上限未配置）`
        : `今日 ${used}/${this.#maxCallsPerDay} 次`;
    const local = `模型请求预算（本地持久计数，UTC 日）：${daily}；单任务上限 ${this.#maxCallsPerTask} 次。`;
    if (this.#upstream === undefined) {
      return local;
    }
    return `${await this.#upstream.summaryText()}\n${local}`;
  }

  #count(key: string): number {
    const raw = this.#store.metaGet(key);
    const value = raw === undefined ? 0 : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  #dayKey(date: Date): string {
    return `${DAY_PREFIX}${date.toISOString().slice(0, 10)}`;
  }

  #nextUtcMidnight(date: Date): string {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
      ),
    ).toISOString();
  }
}
