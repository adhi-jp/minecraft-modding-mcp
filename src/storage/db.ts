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

function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function runIntegrityCheck(db: SqliteDatabase): void {
  const result = db.prepare("PRAGMA integrity_check").get() as SqliteIntegrityResult | undefined;
  if (!result || result.integrity_check !== "ok") {
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: "SQLite integrity check failed.",
      details: { integrityCheck: result }
    });
  }
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

export function openDatabase(config: Config, logger: Logger = buildDefaultLogger()): InitializedDatabase {
  let db: SqliteDatabase | undefined;
  try {
    ensureParentDirectory(config.sqlitePath);

    db = new Database(config.sqlitePath);

    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");

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
      const backupPath = backupCorruptedDb(config.sqlitePath);
      logger.warn("SQLite database integrity check failed. Recreated database after backup", {
        sqlitePath: config.sqlitePath,
        backupPath
      });

      const rebuilt = new Database(config.sqlitePath);
      rebuilt.pragma("foreign_keys = ON");
      rebuilt.pragma("journal_mode = WAL");
      rebuilt.pragma("synchronous = NORMAL");
      rebuilt.pragma("busy_timeout = 5000");

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
