/**
 * The application store runs on two SQLite hosts:
 *
 * - Node's `node:sqlite` for local process and tests;
 * - a Durable Object's `ctx.storage.sql` for the deployed Worker.
 *
 * Repositories only use this narrow synchronous interface. Keeping the
 * abstraction here avoids importing `node:sqlite` into Worker code.
 */
export type SqlValue = string | number | null;

export type SqlRow = Record<string, SqlValue>;

export interface Db {
  all<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T[];
  /** Returns the number of rows written by the statement. */
  run(sql: string, ...params: SqlValue[]): number;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

interface NodeStatement {
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): { changes: number | bigint };
}

interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

export class NodeDb implements Db {
  readonly #db: NodeDatabase;

  constructor(database: NodeDatabase) {
    this.#db = database;
  }

  all<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}

interface SqlCursorLike {
  toArray(): SqlRow[];
  readonly rowsWritten: number;
}

interface SqlStorageLike {
  exec(sql: string, ...params: SqlValue[]): SqlCursorLike;
}

export interface DurableStorageLike {
  readonly sql: SqlStorageLike;
  transactionSync<T>(fn: () => T): T;
}

/**
 * Adapter for a Durable Object's SQLite storage. Durable Objects do not
 * support explicit SQL `BEGIN`; `transactionSync` is the atomic primitive.
 */
export class DoDb implements Db {
  readonly #storage: DurableStorageLike;

  constructor(storage: DurableStorageLike) {
    this.#storage = storage;
  }

  all<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.#storage.sql.exec(sql, ...params).toArray() as T[];
  }

  run(sql: string, ...params: SqlValue[]): number {
    return this.#storage.sql.exec(sql, ...params).rowsWritten;
  }

  exec(sql: string): void {
    this.#storage.sql.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(fn);
  }
}
