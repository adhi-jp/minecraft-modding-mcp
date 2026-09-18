import { existsSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import Database, { isRawSqliteCorruptionError } from "./sqlite.js";
import type { Config } from "../types.js";
import { runMigrations } from "./migrations.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { log } from "../logger.js";

// Re-exported for callers that already import the predicate from this module
// (it now lives in ./sqlite.js so the Database wrapper can call it directly
// without a module cycle back to this file).
export { isRawSqliteCorruptionError };

type SqliteDatabase = InstanceType<typeof Database>;

type Logger = {
  warn: (message: string, details?: Record<string, unknown>) => void;
  info: (message: string, details?: Record<string, unknown>) => void;
  error: (message: string, details?: Record<string, unknown>) => void;
};

export interface InitializedDatabase {
  db: SqliteDatabase;
  schemaVersion: number;
}

type SqliteConsistencyCheckRow = Record<string, string>;

type IntegrityCheckMode = "quick" | "full";

type DatabaseConfig = Pick<Config, "sqlitePath"> &
  Partial<Pick<Config, "sqliteCacheKb" | "sqliteMmapSize">>;

const DEFAULT_SQLITE_CACHE_KB = 8_000;
const DEFAULT_SQLITE_MMAP_SIZE = 268_435_456;

// Per-request escalation files created by the runtime-corruption recovery
// path (see attachRuntimeCorruptionObserver / convertRuntimeSqliteCorruption
// below): a SQLite error surfaced while serving a tool call - not at open
// time - means quick_check already passed for this file, so the NEXT open
// must pay for the full integrity_check instead of trusting quick_check
// again.
//
// Each request is its OWN immutable, uniquely-named file (exclusive-create,
// never overwritten), rather than one shared marker whose content gets
// replaced. That is what makes two requests race-free even across processes
// sharing one cache directory: an open lists whatever request files exist at
// its OWN decision point and remembers those exact names; after honoring
// them, it deletes only those names. A request file created by someone else
// AFTER that decision (a concurrent process, or a second corruption event)
// is simply a name that open never saw, so it can never be swept up by a
// clear meant for a different, earlier decision - it waits for the NEXT
// open. (An earlier single shared marker file, `<sqlitePath>.integrity-check-
// requested`, was never released, so there is no old name to keep reading
// for compatibility; it is dropped outright rather than special-cased.)
const INTEGRITY_CHECK_REQUEST_INFIX = ".integrity-check-requested.";

function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function integrityCheckRequestFileName(sqlitePath: string, token: string): string {
  return `${basename(sqlitePath)}${INTEGRITY_CHECK_REQUEST_INFIX}${token}`;
}

function integrityCheckRequestFileNamePrefix(sqlitePath: string): string {
  return `${basename(sqlitePath)}${INTEGRITY_CHECK_REQUEST_INFIX}`;
}

/**
 * Best-effort request that the NEXT `openDatabase` for `sqlitePath` run the
 * full `PRAGMA integrity_check` instead of the default `quick_check`. Creates
 * a new, uniquely-named request file (see the block comment above) with
 * exclusive-create so it can never collide with or overwrite another
 * pending request. Never throws: a failure to write the file only means the
 * escalation is missed, which is logged rather than allowed to mask the
 * caller's real error. Returns whether the file was actually written, so a
 * caller that cannot schedule the follow-up check can say so instead of
 * promising one.
 */
export function requestFullIntegrityCheck(sqlitePath: string, logger: Logger = buildDefaultLogger()): boolean {
  const token = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const requestPath = join(dirname(sqlitePath), integrityCheckRequestFileName(sqlitePath, token));
  try {
    ensureParentDirectory(sqlitePath);
    writeFileSync(requestPath, "", { flag: "wx" });
    return true;
  } catch (writeError) {
    logger.warn("Failed to request a full SQLite integrity check", {
      sqlitePath,
      reason: writeError instanceof Error ? writeError.message : String(writeError)
    });
    return false;
  }
}

/**
 * Lists the full paths of every currently pending full-integrity-check
 * request file for `sqlitePath`. Best-effort: a missing or unreadable
 * directory is treated as "no requests pending" rather than as an error,
 * since the fallback (a quick_check) is always safe to run.
 */
export function listIntegrityCheckRequestFiles(sqlitePath: string): string[] {
  const dir = dirname(sqlitePath);
  const prefix = integrityCheckRequestFileNamePrefix(sqlitePath);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Deletes EXACTLY the given request file paths - the ones an earlier
 * `listIntegrityCheckRequestFiles` call returned, never a fresh listing - so
 * a request file created after that decision point is never deleted by a
 * clear that only ever meant to honor the requests it actually acted on.
 * Best-effort per file: ENOENT (already gone) is ignored, anything else is
 * logged, not thrown.
 *
 * Exported so a unit test can exercise the race guard directly:
 * `openDatabase` lists-then-clears synchronously with no `await` in between,
 * so there is no way to interleave a concurrent request file appearing
 * between "decide" and "clear" from outside that call.
 */
export function clearIntegrityCheckRequestFiles(
  requestFiles: string[],
  logger: Logger = buildDefaultLogger()
): void {
  for (const requestFile of requestFiles) {
    try {
      unlinkSync(requestFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      logger.warn("Failed to clear a SQLite full-integrity-check request file", {
        requestFile,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function runIntegrityCheck(db: SqliteDatabase, logger: Logger, mode: IntegrityCheckMode = "quick"): void {
  const resultKey = mode === "full" ? "integrity_check" : "quick_check";
  const startedAt = Date.now();
  const result = db.prepare(`PRAGMA ${resultKey}`).get() as SqliteConsistencyCheckRow | undefined;
  const durationMs = Date.now() - startedAt;
  logger.info("SQLite consistency check completed", { durationMs, check: resultKey });

  if (!result || result[resultKey] !== "ok") {
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: "SQLite integrity check failed.",
      details: { reason: "integrity_check_failed", check: resultKey, checkResult: result }
    });
  }
}

function applyPragmas(db: SqliteDatabase, config: DatabaseConfig): void {
  const sqliteCacheKb = config.sqliteCacheKb ?? DEFAULT_SQLITE_CACHE_KB;
  const sqliteMmapSize = config.sqliteMmapSize ?? DEFAULT_SQLITE_MMAP_SIZE;

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma(`cache_size = -${sqliteCacheKb}`);
  db.pragma(`mmap_size = ${sqliteMmapSize}`);
  db.pragma("temp_store = MEMORY");
}

function backupCorruptedDb(sqlitePath: string): string {
  const backupPath = `${sqlitePath}.corrupted.${Date.now()}`;
  renameSync(sqlitePath, backupPath);
  return backupPath;
}

function isMissingPath(path: string): boolean {
  return !existsSync(path);
}

function safeCloseDatabase(db?: SqliteDatabase): void {
  if (!db) {
    return;
  }
  try {
    db.close();
  } catch {
    // best-effort cleanup
  }
}

function isSchemaVersionMismatchError(error: unknown): boolean {
  if (!isAppError(error)) {
    return false;
  }
  if (error.code !== ERROR_CODES.DB_FAILURE) {
    return false;
  }
  return (
    error.details?.reason === "schema_version_unsupported" ||
    error.details?.reason === "schema_version_invalid"
  );
}

function isCorruptionError(error: unknown): boolean {
  if (isAppError(error)) {
    return (
      error.code === ERROR_CODES.DB_FAILURE && error.details?.reason === "integrity_check_failed"
    );
  }
  return isRawSqliteCorruptionError(error);
}

/**
 * Wires a Database instance's corruption observer (see sqlite.ts) so that a
 * raw corruption error thrown by ANY later statement on this handle - no
 * matter what catches and wraps it further up the call stack, including a
 * tool-specific error wrapper that never reaches runTool's own catch block -
 * still schedules the next open's full integrity_check. Exported so a unit
 * test can attach the same wiring to a Database instance opened directly
 * (bypassing openDatabase's own open-time check, which would otherwise catch
 * a test's injected corruption before a "successfully opened" handle ever
 * existed to query against).
 */
export function attachRuntimeCorruptionObserver(
  db: SqliteDatabase,
  sqlitePath: string,
  logger: Logger = buildDefaultLogger()
): void {
  db.setCorruptionObserver(() => {
    requestFullIntegrityCheck(sqlitePath, logger);
  });
}

/**
 * runTool catch-path helper: when `caughtError` is a raw SQLite corruption
 * error observed while serving a tool call (not at open time - open-time
 * corruption is already an AppError by the time it reaches here), this
 * requests a full integrity check on the next open and returns a typed
 * ERR_DB_FAILURE the caller should report instead of the raw error. Any other
 * error is returned unchanged so non-corruption failures are unaffected.
 *
 * The marker request here is redundant with the Database corruption observer
 * (attachRuntimeCorruptionObserver) for an UNWRAPPED raw error, since that
 * observer already fired deeper in the call stack; it is kept because
 * `convertRuntimeSqliteCorruption` is the only place with reliable access to
 * whether scheduling succeeded, which decides which `nextAction` to publish.
 */
export function convertRuntimeSqliteCorruption(
  error: unknown,
  sqlitePath: string,
  logger: Logger = buildDefaultLogger()
): unknown {
  if (!isRawSqliteCorruptionError(error)) {
    return error;
  }

  const scheduled = requestFullIntegrityCheck(sqlitePath, logger);

  const nextAction = scheduled
    ? "Restart the MCP server so the cache database is fully checked and rebuilt if necessary, then retry the request."
    : `The automatic full check could not be scheduled. Stop every MCP server process that uses this cache, delete the cache database at ${sqlitePath} together with its -wal and -shm files, then restart; the cache is rebuilt on the next start.`;

  return createError({
    code: ERROR_CODES.DB_FAILURE,
    message: "A SQLite consistency error occurred while serving this request.",
    details: {
      sqlitePath,
      reason: "runtime_corruption",
      nextAction
    }
  });
}

function buildDefaultLogger(): Logger {
  return {
    warn: (message, details) => {
      log("warn", "db.warn", {
        message,
        ...(details ?? {})
      });
    },
    info: (message, details) => {
      log("info", "db.info", {
        message,
        ...(details ?? {})
      });
    },
    error: (message, details) => {
      log("error", "db.error", {
        message,
        ...(details ?? {})
      });
    }
  };
}

export function openDatabase(
  config: DatabaseConfig,
  logger: Logger = buildDefaultLogger()
): InitializedDatabase {
  let db: SqliteDatabase | undefined;
  const pendingRequestFiles = listIntegrityCheckRequestFiles(config.sqlitePath);
  try {
    ensureParentDirectory(config.sqlitePath);

    db = new Database(config.sqlitePath);

    applyPragmas(db, config);

    const schemaVersion = runMigrations(db);
    runIntegrityCheck(db, logger, pendingRequestFiles.length > 0 ? "full" : "quick");
    if (pendingRequestFiles.length > 0) {
      clearIntegrityCheckRequestFiles(pendingRequestFiles, logger);
    }
    // Only attach the runtime-corruption observer once the open itself
    // (migrations + consistency check) has fully succeeded: open-time
    // failures must keep going through the backup/rebuild path below, not
    // silently re-request a check that is about to happen anyway.
    attachRuntimeCorruptionObserver(db, config.sqlitePath, logger);

    return { db, schemaVersion };
  } catch (caughtError) {
    safeCloseDatabase(db);

    const errorMessage = caughtError instanceof Error ? caughtError.message : String(caughtError);

    if ((caughtError as { code?: string })?.code === "ERR_IO") {
      logger.error("Failed to open SQLite database", {
        path: config.sqlitePath,
        reason: errorMessage
      });
      throw createError({
        code: ERROR_CODES.DB_FAILURE,
        message: `Failed to open SQLite database at ${config.sqlitePath}`,
        details: { sqlitePath: config.sqlitePath }
      });
    }

    if (isSchemaVersionMismatchError(caughtError)) {
      logger.error("SQLite schema version mismatch", {
        path: config.sqlitePath,
        reason: errorMessage
      });
      throw caughtError;
    }

    if (!isMissingPath(config.sqlitePath)) {
      if (!isCorruptionError(caughtError)) {
        logger.error("SQLite initialization failed", {
          path: config.sqlitePath,
          reason: errorMessage
        });
        throw createError({
          code: ERROR_CODES.DB_FAILURE,
          message: `Failed to open SQLite database at ${config.sqlitePath}: ${errorMessage}`,
          details: { sqlitePath: config.sqlitePath, reason: (caughtError as { code?: string })?.code }
        });
      }

      // The rebuild runs INSIDE the handler for the failure it is recovering
      // from, so it needs a guard of its own: without one a throw from here left
      // the handle it had already opened dangling and escaped untyped, while
      // every other exit from this function is a typed ERR_DB_FAILURE the caller
      // can classify. The original message is kept - it is the only account of
      // what actually went wrong.
      let rebuilt: SqliteDatabase | undefined;
      try {
        const backupPath = backupCorruptedDb(config.sqlitePath);
        logger.warn("SQLite database integrity check failed. Recreated database after backup", {
          sqlitePath: config.sqlitePath,
          backupPath,
          reason: errorMessage
        });

        rebuilt = new Database(config.sqlitePath);
        applyPragmas(rebuilt, config);

        const schemaVersion = runMigrations(rebuilt);
        runIntegrityCheck(rebuilt, logger);
        if (pendingRequestFiles.length > 0) {
          clearIntegrityCheckRequestFiles(pendingRequestFiles, logger);
        }
        attachRuntimeCorruptionObserver(rebuilt, config.sqlitePath, logger);
        return { db: rebuilt, schemaVersion };
      } catch (rebuildError) {
        safeCloseDatabase(rebuilt);
        const rebuildMessage =
          rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
        logger.error("SQLite rebuild after corruption failed", {
          path: config.sqlitePath,
          reason: rebuildMessage
        });
        throw createError({
          code: ERROR_CODES.DB_FAILURE,
          message: `Failed to rebuild SQLite database at ${config.sqlitePath}: ${rebuildMessage}`,
          details: { sqlitePath: config.sqlitePath, reason: "rebuild_failed" }
        });
      }
    }

    logger.error("SQLite initialization failed", {
      path: config.sqlitePath,
      reason: errorMessage
    });
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: "Failed to initialize SQLite database.",
      details: { sqlitePath: config.sqlitePath }
    });
  }
}
