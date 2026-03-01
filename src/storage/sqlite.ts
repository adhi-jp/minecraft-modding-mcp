import { DatabaseSync, type StatementSync } from "node:sqlite";

type NamedParameters = Record<string, unknown>;

function isPlainObject(value: unknown): value is NamedParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeParameters(args: unknown[]): { positional?: unknown[]; named?: NamedParameters } {
  if (args.length === 1) {
    const [single] = args;
    if (Array.isArray(single)) {
      return { positional: single };
    }
    if (isPlainObject(single)) {
      return { named: single };
    }
  }
  return { positional: args };
}

export class Statement<T = unknown> {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): unknown {
    return this.invoke("run", params);
  }

  get(...params: unknown[]): T | undefined {
    return this.invoke("get", params) as T | undefined;
  }

  all(...params: unknown[]): T[] {
    return this.invoke("all", params) as T[];
  }

  iterate(...params: unknown[]): Iterable<T> {
    return this.invoke("iterate", params) as Iterable<T>;
  }

  private invoke(method: "run" | "get" | "all" | "iterate", params: unknown[]): unknown {
    const normalized = normalizeParameters(params);
    const target = this.stmt[method] as (...args: unknown[]) => unknown;
    if (normalized.named !== undefined) {
      return target.call(this.stmt, normalized.named);
    }
    return target.call(this.stmt, ...(normalized.positional ?? []));
  }
}

let transactionSerial = 0;

export default class Database {
  private readonly inner: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  pragma(pragma: string): unknown {
    const sql = `PRAGMA ${pragma}`;
    if (pragma.includes("=")) {
      this.inner.exec(sql);
      return undefined;
    }

    return this.inner.prepare(sql).all();
  }

  prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
    return new Statement<T>(this.inner.prepare(sql));
  }

  transaction<T>(fn: () => T): () => T {
    return () => this.runInTransaction(fn);
  }

  close(): void {
    this.inner.close();
  }

  private runInTransaction<T>(fn: () => T): T {
    const initialDepth = this.transactionDepth;
    const isOutermost = initialDepth === 0;
    const savepoint = `sp_${++transactionSerial}`;

    try {
      if (isOutermost) {
        this.inner.exec("BEGIN");
      } else {
        this.inner.exec(`SAVEPOINT ${savepoint}`);
      }

      this.transactionDepth = initialDepth + 1;
      const result = fn();
      this.transactionDepth = initialDepth;

      if (isOutermost) {
        this.inner.exec("COMMIT");
      } else {
        this.inner.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      this.transactionDepth = initialDepth;
      try {
        if (isOutermost) {
          this.inner.exec("ROLLBACK");
        } else {
          this.inner.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.inner.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // best-effort rollback cleanup
      }
      throw error;
    }
  }
}
