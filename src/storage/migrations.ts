import { createError, ERROR_CODES } from "../errors.js";
import { SCHEMA_V1_STATEMENTS, SCHEMA_V2_STATEMENTS } from "./schema.js";

interface MigrationMeta {
  version: number;
  statements: string[];
}

type MigrationRunner = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export const LATEST_SCHEMA_VERSION = 2;

const migrations: MigrationMeta[] = [
  {
    version: 1,
    statements: SCHEMA_V1_STATEMENTS
  },
  {
    version: 2,
    statements: SCHEMA_V2_STATEMENTS
  }
];

function selectSchemaVersion(tx: MigrationRunner): number {
  tx.prepare(
    `CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  ).run();

  const row = tx.prepare(`SELECT value FROM cache_meta WHERE key = ?`).get(["schema_version"]) as {
    value?: string;
  } | undefined;

  if (!row?.value) {
    return 0;
  }

  const parsed = Number.parseInt(row.value, 10);
  if (!Number.isFinite(parsed)) {
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: `Invalid SQLite schema version '${row.value}'.`,
      details: {
        reason: "schema_version_invalid",
        schemaVersion: row.value
      }
    });
  }

  return parsed;
}

function assertSchemaVersionSupported(version: number): void {
  if (version > LATEST_SCHEMA_VERSION) {
    throw createError({
      code: ERROR_CODES.DB_FAILURE,
      message: `SQLite schema version ${version} exceeds supported version ${LATEST_SCHEMA_VERSION}.`,
      details: {
        reason: "schema_version_unsupported",
        schemaVersion: version,
        latestSchemaVersion: LATEST_SCHEMA_VERSION
      }
    });
  }
}

function setSchemaVersion(tx: MigrationRunner, version: number): void {
  tx.prepare(`
    INSERT INTO cache_meta(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(["schema_version", String(version)]);
}

export function runMigrations(db: MigrationRunner): number {
  const txn = db.transaction(() => {
    const initialVersion = selectSchemaVersion(db);
    assertSchemaVersionSupported(initialVersion);

    let currentVersion = initialVersion;
    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }

      for (const statement of migration.statements) {
        db.prepare(statement).run();
      }

      setSchemaVersion(db, migration.version);
      currentVersion = migration.version;
    }

    return currentVersion;
  });

  return txn();
}
