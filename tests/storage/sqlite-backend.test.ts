import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/storage/db.ts";
import { runMigrations } from "../../src/storage/migrations.ts";
import Database from "../../src/storage/sqlite.ts";
import { withTempDir } from "../helpers/temp-dir.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

const LATEST_SCHEMA_VERSION = 4;

function readTrackedContentBytes(db: Database, artifactId: string): number {
  const row = db
    .prepare(`
      SELECT COALESCE(artifact_content_bytes.total_content_bytes, 0) AS total
      FROM artifacts
      LEFT JOIN artifact_content_bytes
        ON artifact_content_bytes.artifact_id = artifacts.artifact_id
      WHERE artifacts.artifact_id = ?
      LIMIT 1
    `)
    .get(artifactId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

test("openDatabase initializes cache schema without native addon prerequisites", () =>
  withTempDir("sqlite-backend-", async (root) => {
    const initialized = openDatabase(buildTestConfig(root));
    assert.equal(initialized.schemaVersion, LATEST_SCHEMA_VERSION);
    const table = initialized.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .get() as { name?: string } | undefined;
    assert.equal(table?.name, "artifacts");

    const indexMeta = initialized.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_index_meta'")
      .get() as { name?: string } | undefined;
    assert.equal(indexMeta?.name, "artifact_index_meta");

    const symbolNameLowerIndex = initialized.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_symbols_name_lower'")
      .get() as { name?: string } | undefined;
    assert.equal(symbolNameLowerIndex?.name, "idx_symbols_name_lower");

    const artifactContentBytesTable = initialized.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_content_bytes'")
      .get() as { name?: string } | undefined;
    assert.equal(artifactContentBytesTable?.name, "artifact_content_bytes");

    const contentBytesInsertTrigger = initialized.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_files_content_bytes_insert'"
      )
      .get() as { name?: string } | undefined;
    assert.equal(contentBytesInsertTrigger?.name, "trg_files_content_bytes_insert");
  }));

test("openDatabase fails when cache schema_version exceeds supported version", () =>
  withTempDir("sqlite-backend-", async (root) => {
    const config = buildTestConfig(root);
    await mkdir(join(root, "cache"), { recursive: true });

    const db = new Database(config.sqlitePath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("UPDATE cache_meta SET value = ? WHERE key = ?").run(["999", "schema_version"]);
    db.close();

    assert.throws(
      () => openDatabase(config),
      (error) => {
        assert.equal((error as { code?: string }).code, "ERR_DB_FAILURE");
        assert.match(String((error as Error).message), /schema version/i);
        return true;
      }
    );

    assert.equal(existsSync(config.sqlitePath), true);
    const cacheEntries = await readdir(join(root, "cache"));
    assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), false);
  }));

test("openDatabase backs up and rebuilds a corrupted database file", () =>
  withTempDir("sqlite-backend-", async (root) => {
    const config = buildTestConfig(root);
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(config.sqlitePath, "this is not a sqlite database");

    const initialized = openDatabase(config);
    assert.equal(initialized.schemaVersion, LATEST_SCHEMA_VERSION);
    initialized.db.close();

    const cacheEntries = await readdir(join(root, "cache"));
    assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), true);
  }));

test("openDatabase rethrows non-corruption migration errors without recreating the database", () =>
  withTempDir("sqlite-backend-", async (root) => {
    const config = buildTestConfig(root);
    const initialized = openDatabase(config);
    initialized.db
      .prepare("UPDATE cache_meta SET value = ? WHERE key = ?")
      .run(["3", "schema_version"]);
    initialized.db.close();

    assert.throws(
      () => openDatabase(config),
      (error) => {
        assert.match(String((error as Error).message), /duplicate column name/i);
        return true;
      }
    );

    assert.equal(existsSync(config.sqlitePath), true);
    const cacheEntries = await readdir(join(root, "cache"));
    assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), false);
  }));

test("artifact_content_bytes stays in sync when files rows change", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const version = runMigrations(db);
  assert.equal(version, LATEST_SCHEMA_VERSION);

  db.prepare(`
    INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("artifact-a", "local-jar", 0, "2026-02-24T00:00:00.000Z", "2026-02-24T00:00:00.000Z");
  db.prepare(`
    INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("artifact-b", "local-jar", 0, "2026-02-24T00:00:00.000Z", "2026-02-24T00:00:00.000Z");

  db.prepare(`
    INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run("artifact-a", "pkg/A.java", "class A {}", 10, "h-a");
  assert.equal(readTrackedContentBytes(db, "artifact-a"), 10);

  db.prepare(`
    INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run("artifact-a", "pkg/B.java", "class B {}", 20, "h-b");
  assert.equal(readTrackedContentBytes(db, "artifact-a"), 30);

  db.prepare(`
    UPDATE files
    SET content_bytes = ?
    WHERE artifact_id = ? AND file_path = ?
  `).run(14, "artifact-a", "pkg/A.java");
  assert.equal(readTrackedContentBytes(db, "artifact-a"), 34);

  db.prepare(`
    UPDATE files
    SET artifact_id = ?, file_path = ?
    WHERE artifact_id = ? AND file_path = ?
  `).run("artifact-b", "pkg/A.java", "artifact-a", "pkg/A.java");
  assert.equal(readTrackedContentBytes(db, "artifact-a"), 20);
  assert.equal(readTrackedContentBytes(db, "artifact-b"), 14);

  db.prepare(`
    DELETE FROM files
    WHERE artifact_id = ? AND file_path = ?
  `).run("artifact-b", "pkg/A.java");
  assert.equal(readTrackedContentBytes(db, "artifact-b"), 0);
});
