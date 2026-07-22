import { existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "./sqlite.js";
import type { Config } from "../types.js";
import { runMigrations } from "./migrations.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { log } from "../logger.js";

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

type SqliteIntegrityResult = {
  integrity_check: string;
};

type DatabaseConfig = Pick<Config, "sqlitePath"> &
  Partial<Pick<Config, "sqliteCacheKb" | "sqliteMmapSize">>;

const DEFAULT_SQLITE_CACHE_KB = 8_000;
const DEFAULT_SQLITE_MMAP_SIZE = 268_435_456;

function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function runIntegrityCheck(db: SqliteDatabase): void {
  const result = db.prepare("PRAGMA integrity_check").get() as SqliteIntegrityResult | undefined;
  if (!result || result.integrity_check !== "ok") {
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: "SQLite integrity check failed.",
      details: { reason: "integrity_check_failed", integrityCheck: result }
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

const SQLITE_CORRUPT_ERRCODE = 11;
const SQLITE_NOTADB_ERRCODE = 26;

function isCorruptionError(error: unknown): boolean {
  if (isAppError(error)) {
    return (
      error.code === ERROR_CODES.DB_FAILURE && error.details?.reason === "integrity_check_failed"
    );
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
  try {
    ensureParentDirectory(config.sqlitePath);

    db = new Database(config.sqlitePath);

    applyPragmas(db, config);

    const schemaVersion = runMigrations(db);
    runIntegrityCheck(db);

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
        throw caughtError;
      }

      const backupPath = backupCorruptedDb(config.sqlitePath);
      logger.warn("SQLite database integrity check failed. Recreated database after backup", {
        sqlitePath: config.sqlitePath,
        backupPath
      });

      const rebuilt = new Database(config.sqlitePath);
      applyPragmas(rebuilt, config);

      const schemaVersion = runMigrations(rebuilt);
      runIntegrityCheck(rebuilt);
      return { db: rebuilt, schemaVersion };
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
