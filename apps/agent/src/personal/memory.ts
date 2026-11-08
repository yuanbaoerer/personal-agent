import type { MemoryRecord } from "../domain/types.ts";
import type { MemoryRepository } from "../storage/personal.ts";
import type { Store } from "../storage/store.ts";

export interface MemoryServiceDeps {
  store: Store;
  memories: MemoryRepository;
  now?: () => Date;
}

/**
 * Explicit memory only. A third-party document or a Worker's inference never
 * writes here; the owner's request and the displayed value do.
 */
export class MemoryService {
  readonly #store: Store;
  readonly #memories: MemoryRepository;
  readonly #now: () => Date;

  constructor(deps: MemoryServiceDeps) {
    this.#store = deps.store;
    this.#memories = deps.memories;
    this.#now = deps.now ?? (() => new Date());
  }

  save(
    ownerId: string,
    key: string,
    value: string,
    sourceEventId?: string,
  ): MemoryRecord {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (normalizedKey.length === 0 || normalizedKey.length > 64) {
      throw new Error("memory key must be 1-64 characters");
    }
    if (normalizedValue.length === 0 || normalizedValue.length > 1_000) {
      throw new Error("memory value must be 1-1000 characters");
    }

    const now = this.#now().toISOString();
    const memory = this.#memories.upsert({
      ownerId,
      key: normalizedKey,
      value: normalizedValue,
      sourceEventId,
      now,
    });
    this.#store.recordAudit({
      event: "memory.saved",
      subjectType: "memory",
      subjectId: memory.id,
      after: { key: memory.key, version: memory.version },
      traceId: `memory:${memory.id}`,
      occurredAt: now,
    });
    return memory;
  }

  list(ownerId: string): MemoryRecord[] {
    return this.#memories.listActive(ownerId);
  }

  get(ownerId: string, key: string): MemoryRecord | undefined {
    return this.#memories.get(ownerId, key);
  }

  forget(ownerId: string, key: string): MemoryRecord | undefined {
    const now = this.#now().toISOString();
    const memory = this.#memories.softDelete(ownerId, key, now);
    if (memory !== undefined) {
      this.#store.recordAudit({
        event: "memory.forgotten",
        subjectType: "memory",
        subjectId: memory.id,
        after: { key: memory.key, version: memory.version },
        traceId: `memory:${memory.id}`,
        occurredAt: now,
      });
    }
    return memory;
  }
}
