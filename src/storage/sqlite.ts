import { DatabaseSync, type StatementSync } from "node:sqlite";

import { isAppError } from "../errors.js";

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

const SQLITE_CORRUPT_ERRCODE = 11;
const SQLITE_NOTADB_ERRCODE = 26;

/**
 * Recognizes a raw (non-AppError) SQLite corruption error - the shape
 * node:sqlite throws mid-query, e.g. `{ code: "ERR_SQLITE_ERROR", errcode: 11 }`.
 * Lives here (rather than storage/db.ts, which imports this module) so the
 * Database wrapper below can call it directly without a module cycle; db.ts
 * re-exports it for callers that used to import it from there.
 */
export function isRawSqliteCorruptionError(error: unknown): boolean {
  if (isAppError(error)) {
    return false;
  }
  const sqliteError = error as { code?: string; errcode?: number } | undefined;
  if (sqliteError?.code === "SQLITE_CORRUPT" || sqliteError?.code === "SQLITE_NOTADB") {
    return true;
  }
  if (typeof sqliteError?.errcode !== "number") {
    return false;
  }
  const primaryErrcode = sqliteError.errcode & 0xff;
  return primaryErrcode === SQLITE_CORRUPT_ERRCODE || primaryErrcode === SQLITE_NOTADB_ERRCODE;
}

/**
 * Notified, at most once per `Database` instance, the first time a raw SQLite
 * corruption error is thrown by any statement/pragma/transaction path on that
 * instance. Called BEFORE the triggering error is rethrown unchanged, so it
 * runs regardless of how (or whether) a caller further up the stack wraps or
 * swallows that error - a wrapping catch block elsewhere in the codebase can
 * no longer hide a runtime corruption from this observer.
 */
export type SqliteCorruptionObserver = (error: unknown) => void;

export class Statement<T = unknown> {
  constructor(
    private readonly stmt: StatementSync,
    private readonly notifyCorruption: (error: unknown) => void
  ) {}

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
    const rawIterable = this.invoke("iterate", params) as Iterable<T>;
    return this.wrapIterable(rawIterable);
  }

  // node:sqlite's iterate() returns lazily: the corrupted page is only ever
  // touched once the consumer actually pulls a row, i.e. inside next(), not
  // at the call above. Wrap the iterator itself so a mid-iteration corruption
  // error still reaches the observer before propagating to the consumer.
  private wrapIterable(iterable: Iterable<T>): Iterable<T> {
    const notifyCorruption = this.notifyCorruption;
    return {
      [Symbol.iterator](): Iterator<T> {
        const inner = iterable[Symbol.iterator]();
        const wrapped: Iterator<T> = {
          next(): IteratorResult<T> {
            try {
              return inner.next();
            } catch (error) {
              notifyCorruption(error);
              throw error;
            }
          }
        };
        // Forward early termination (a `break` out of for...of, or a consuming
        // generator being closed) so the underlying statement is reset instead
        // of being left mid-iteration with its read snapshot open.
        if (typeof inner.return === "function") {
          wrapped.return = (value?: unknown): IteratorResult<T> =>
            inner.return!(value as T) as IteratorResult<T>;
        }
        return wrapped;
      }
    };
  }

  private invoke(method: "run" | "get" | "all" | "iterate", params: unknown[]): unknown {
    const normalized = normalizeParameters(params);
    const target = this.stmt[method] as (...args: unknown[]) => unknown;
    try {
      if (normalized.named !== undefined) {
        return target.call(this.stmt, normalized.named);
      }
      return target.call(this.stmt, ...(normalized.positional ?? []));
    } catch (error) {
      this.notifyCorruption(error);
      throw error;
    }
  }
}

let transactionSerial = 0;

export default class Database {
  private readonly inner: DatabaseSync;
  private transactionDepth = 0;
  private corruptionObserver: SqliteCorruptionObserver | undefined;
  private corruptionNotified = false;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  /**
   * Registers (or clears, with `undefined`) the observer notified on this
   * instance's first raw corruption error. Best-effort: an observer that
   * throws is swallowed so it can never mask the real SQLite error being
   * rethrown, and it fires at most once per instance.
   */
  setCorruptionObserver(observer: SqliteCorruptionObserver | undefined): void {
    this.corruptionObserver = observer;
  }

  private notifyCorruption(error: unknown): void {
    if (this.corruptionNotified) {
      return;
    }
    const observer = this.corruptionObserver;
    if (!observer) {
      return;
    }
    if (!isRawSqliteCorruptionError(error)) {
      return;
    }
    this.corruptionNotified = true;
    try {
      observer(error);
    } catch {
      // best-effort: never let the observer mask the real error being rethrown
    }
  }

  private runRaw<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.notifyCorruption(error);
      throw error;
    }
  }

  pragma(pragma: string): unknown {
    const sql = `PRAGMA ${pragma}`;
    if (pragma.includes("=")) {
      this.runRaw(() => this.inner.exec(sql));
      return undefined;
    }

    return this.runRaw(() => this.inner.prepare(sql).all());
  }

  prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
    // Wrapped in runRaw: PREPARING a statement can itself throw a raw
    // corruption error - e.g. damage to the schema (sqlite_master) that a
    // fresh connection only discovers while compiling its first statement -
    // not just running one. Without this, that error skipped the observer
    // entirely (reproduced: errcode 11, observer never notified).
    const stmt = this.runRaw(() => this.inner.prepare(sql));
    return new Statement<T>(stmt, (error) => this.notifyCorruption(error));
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
        this.runRaw(() => this.inner.exec("BEGIN"));
      } else {
        this.runRaw(() => this.inner.exec(`SAVEPOINT ${savepoint}`));
      }

      this.transactionDepth = initialDepth + 1;
      const result = fn();
      this.transactionDepth = initialDepth;

      if (isOutermost) {
        this.runRaw(() => this.inner.exec("COMMIT"));
      } else {
        this.runRaw(() => this.inner.exec(`RELEASE SAVEPOINT ${savepoint}`));
      }
      return result;
    } catch (error) {
      this.transactionDepth = initialDepth;
      try {
        if (isOutermost) {
          this.runRaw(() => this.inner.exec("ROLLBACK"));
        } else {
          this.runRaw(() => this.inner.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`));
          this.runRaw(() => this.inner.exec(`RELEASE SAVEPOINT ${savepoint}`));
        }
      } catch {
        // best-effort rollback cleanup - runRaw already notified the
        // observer (if any) before this catch swallows the rollback failure
      }
      throw error;
    }
  }
}
