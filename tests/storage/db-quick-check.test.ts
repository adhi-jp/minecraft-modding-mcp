import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  attachRuntimeCorruptionObserver,
  clearIntegrityCheckRequestFiles,
  convertRuntimeSqliteCorruption,
  isRawSqliteCorruptionError,
  listIntegrityCheckRequestFiles,
  openDatabase,
  requestFullIntegrityCheck
} from "../../src/storage/db.ts";
import RawDatabase from "../../src/storage/sqlite.ts";
import { withTempDir } from "../helpers/temp-dir.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/**
 * Builds a healthy database with one large value in `artifacts.provenance_json`,
 * corrupts the row's own LEAF page (not one of the value's overflow pages),
 * and returns the artifact_id of that row.
 *
 * Empirically verified while building this fixture: garbage-filling a
 * pure overflow page - which holds only a chunk of the raw payload bytes, no
 * structural metadata - does NOT make a later `SELECT` throw. SQLite copies
 * the (now garbage) bytes back with the correct declared length and no
 * complaint; only `PRAGMA quick_check`/`integrity_check` notice, because
 * those actually re-derive and cross-check structure rather than just
 * following it. Only corrupting the row's LEAF page - which holds the cell
 * header and the pointer into the overflow chain - makes an ordinary read
 * throw a raw, catchable SQLite corruption error, which is what a live tool
 * call hitting real corruption looks like. `dbstat` (available in node:sqlite)
 * identifies that exact page deterministically instead of guessing from file
 * layout.
 */
async function buildDatabaseWithCorruptedArtifactOverflow(
  config: ReturnType<typeof buildTestConfig>
): Promise<{ artifactId: string }> {
  const artifactId = "artifact-observer";

  const initial = openDatabase(config);
  const largeProvenance = "P".repeat(2_000_000);
  initial.db
    .prepare(
      `INSERT INTO artifacts (artifact_id, origin, is_decompiled, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(artifactId, "local-jar", 0, largeProvenance, "2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z");

  const pageSizeRow = (initial.db.pragma("page_size") as Array<{ page_size: number }>)[0];
  const pageSize = pageSizeRow?.page_size ?? 4096;

  const leafPages = initial.db
    .prepare(`SELECT pageno FROM dbstat WHERE name = 'artifacts' AND pagetype = 'leaf'`)
    .all() as Array<{ pageno: number }>;
  assert.equal(leafPages.length, 1, "expected exactly one leaf page for a single-row artifacts table");
  const leafPageNumber = leafPages[0]!.pageno;

  initial.db.pragma("wal_checkpoint(TRUNCATE)");
  initial.db.close();

  const dbPath = config.sqlitePath;
  const raw = await readFile(dbPath);
  assert.ok(raw.length > pageSize * 4, "expected the large provenance_json to span multiple pages");

  const corrupted = Buffer.from(raw);
  const leafPageStart = (leafPageNumber - 1) * pageSize;
  corrupted.fill(0xff, leafPageStart, leafPageStart + pageSize);
  await writeFile(dbPath, corrupted);

  return { artifactId };
}

function selectProvenance(db: InstanceType<typeof RawDatabase>, target: { artifactId: string }): unknown {
  return db.prepare(`SELECT provenance_json FROM artifacts WHERE artifact_id = ?`).get(target.artifactId);
}

const LATEST_SCHEMA_VERSION = 4;

type CapturedLog = { message: string; details?: Record<string, unknown> };

function createCapturingLogger(): {
  logger: { warn: (m: string, d?: Record<string, unknown>) => void; info: (m: string, d?: Record<string, unknown>) => void; error: (m: string, d?: Record<string, unknown>) => void };
  warnCalls: CapturedLog[];
  infoCalls: CapturedLog[];
} {
  const warnCalls: CapturedLog[] = [];
  const infoCalls: CapturedLog[] = [];
  return {
    logger: {
      warn: (message, details) => warnCalls.push({ message, details }),
      info: (message, details) => infoCalls.push({ message, details }),
      error: () => {
        // not exercised by these tests
      }
    },
    warnCalls,
    infoCalls
  };
}

test("openDatabase keeps existing rows and schema version on a healthy reopen, with no corruption backup", () =>
  withTempDir("quick-check-healthy-", async (root) => {
    const config = buildTestConfig(root);

    const first = openDatabase(config);
    first.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("artifact-quick-check", "local-jar", 0, "2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z");
    first.db.close();

    const { logger } = createCapturingLogger();
    const second = openDatabase(config, logger);
    try {
      assert.equal(second.schemaVersion, LATEST_SCHEMA_VERSION);
      const row = second.db
        .prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?")
        .get("artifact-quick-check") as { artifact_id?: string } | undefined;
      assert.equal(row?.artifact_id, "artifact-quick-check");

      const cacheEntries = await readdir(join(root, "cache"));
      assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), false);
    } finally {
      second.db.close();
    }
  }));

test("openDatabase detects a corrupted data page, backs up the file, and rebuilds a fresh database", () =>
  withTempDir("quick-check-corrupt-", async (root) => {
    const config = buildTestConfig(root);

    const initial = openDatabase(config);
    initial.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("artifact-large", "local-jar", 0, "2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z");

    // A large payload spread across many overflow pages, inserted AFTER migrations
    // already ran to completion. On the NEXT open, runMigrations only re-reads
    // cache_meta's schema_version (already current, so no statements execute) -
    // it never visits this table's pages. Only the consistency check walks the
    // full schema, including this table's overflow chain, so corrupting a page
    // here isolates detection to the check itself rather than to migrations.
    const largeContent = "x".repeat(2_000_000);
    initial.db
      .prepare(
        `INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("artifact-large", "Large.java", largeContent, largeContent.length, "deadbeef");

    const pageSizeRow = (initial.db.pragma("page_size") as Array<{ page_size: number }>)[0];
    const pageSize = pageSizeRow?.page_size ?? 4096;

    // Force WAL contents into the main file (and truncate the WAL) so the bytes
    // we corrupt below live in the actual cache/source-cache.db file.
    initial.db.pragma("wal_checkpoint(TRUNCATE)");
    initial.db.close();

    const dbPath = config.sqlitePath;
    const raw = await readFile(dbPath);
    assert.ok(raw.length > pageSize * 4, "expected the large content to span multiple pages");

    // Corrupt the LAST page of the file. A fresh database that has only ever
    // grown allocates pages append-only, so the highest-numbered (last) page is
    // never page 1 (the schema/sqlite_master page) and never the small
    // cache_meta page written near the start of the file during migrations.
    // It is usually a `files_fts_data` page (FTS5, page sizes 512-32768), not
    // an overflow page of `files.content` as an earlier version of this
    // comment claimed: the INSERT INTO `files` above fires the `files_fts`
    // triggers, and those trigger-driven index writes allocate pages after
    // the row's own overflow chain, landing later in the file. Either way the
    // corrupted page sits inside the schema the consistency check walks, so
    // the assertion strategy - corrupt the last page, expect detection - holds
    // regardless of which table actually owns it.
    const corrupted = Buffer.from(raw);
    const lastPageStart = corrupted.length - pageSize;
    corrupted.fill(0xff, lastPageStart, corrupted.length);
    await writeFile(dbPath, corrupted);

    const { logger, warnCalls } = createCapturingLogger();
    const reopened = openDatabase(config, logger);
    try {
      assert.equal(reopened.schemaVersion, LATEST_SCHEMA_VERSION);
      // The rebuilt database is fresh: the row inserted before corruption is gone.
      const row = reopened.db
        .prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?")
        .get("artifact-large") as { artifact_id?: string } | undefined;
      assert.equal(row, undefined);
    } finally {
      reopened.db.close();
    }

    const cacheEntries = await readdir(join(root, "cache"));
    assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), true);

    assert.equal(warnCalls.length, 1);
    const reason = warnCalls[0]?.details?.reason;
    assert.equal(typeof reason, "string");
    // The reason must come from the consistency check itself, not from a migration failure.
    assert.match(reason as string, /integrity check failed/i);
  }));

test("openDatabase runs a full integrity_check instead of quick_check when the escalation marker is present, keeps rows on success, and clears the marker", () =>
  withTempDir("quick-check-marker-healthy-", async (root) => {
    const config = buildTestConfig(root);

    const first = openDatabase(config);
    first.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        "artifact-marker-healthy",
        "local-jar",
        0,
        "2026-03-10T00:00:00.000Z",
        "2026-03-10T00:00:00.000Z"
      );
    first.db.close();

    requestFullIntegrityCheck(config.sqlitePath);
    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      1,
      "expected requestFullIntegrityCheck to write one request file"
    );

    const { logger, infoCalls } = createCapturingLogger();
    const second = openDatabase(config, logger);
    try {
      assert.equal(second.schemaVersion, LATEST_SCHEMA_VERSION);
      const row = second.db
        .prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?")
        .get("artifact-marker-healthy") as { artifact_id?: string } | undefined;
      assert.equal(row?.artifact_id, "artifact-marker-healthy");
    } finally {
      second.db.close();
    }

    const fullCheckLog = infoCalls.find((entry) => entry.details?.check === "integrity_check");
    assert.ok(fullCheckLog, "expected a logged consistency check with check: \"integrity_check\"");
    assert.equal(
      infoCalls.some((entry) => entry.details?.check === "quick_check"),
      false,
      "expected no quick_check to have run while the marker was present"
    );

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      0,
      "expected the request file to be cleared after a healthy full check"
    );
  }));

test("openDatabase escalates to a full integrity_check when the marker is present, and still backs up and rebuilds a corrupted database while clearing the marker", () =>
  withTempDir("quick-check-marker-corrupt-", async (root) => {
    const config = buildTestConfig(root);

    const initial = openDatabase(config);
    initial.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        "artifact-marker-corrupt",
        "local-jar",
        0,
        "2026-03-10T00:00:00.000Z",
        "2026-03-10T00:00:00.000Z"
      );

    const largeContent = "x".repeat(2_000_000);
    initial.db
      .prepare(
        `INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("artifact-marker-corrupt", "Large.java", largeContent, largeContent.length, "deadbeef");

    const pageSizeRow = (initial.db.pragma("page_size") as Array<{ page_size: number }>)[0];
    const pageSize = pageSizeRow?.page_size ?? 4096;

    initial.db.pragma("wal_checkpoint(TRUNCATE)");
    initial.db.close();

    const dbPath = config.sqlitePath;
    const raw = await readFile(dbPath);
    assert.ok(raw.length > pageSize * 4, "expected the large content to span multiple pages");

    // Same deterministic technique as the corruption test above: garbage-fill
    // the last (highest-numbered) page. This is a plain page corruption, not
    // a targeted index/table-mismatch fixture (the scenario integrity_check
    // catches and quick_check does not) - a deterministic version of that
    // fixture was not built for this test, so it does not prove selectivity
    // between the two checks. It does prove the marker-driven escalation path
    // itself: the check that runs while the marker is present is the full
    // integrity_check (asserted below via the logged check name), it detects
    // this corruption, and the existing backup+rebuild path fires and clears
    // the marker afterward.
    const corrupted = Buffer.from(raw);
    const lastPageStart = corrupted.length - pageSize;
    corrupted.fill(0xff, lastPageStart, corrupted.length);
    await writeFile(dbPath, corrupted);

    requestFullIntegrityCheck(config.sqlitePath);

    const { logger, warnCalls, infoCalls } = createCapturingLogger();
    const reopened = openDatabase(config, logger);
    try {
      assert.equal(reopened.schemaVersion, LATEST_SCHEMA_VERSION);
      const row = reopened.db
        .prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?")
        .get("artifact-marker-corrupt") as { artifact_id?: string } | undefined;
      assert.equal(row, undefined);
    } finally {
      reopened.db.close();
    }

    const cacheEntries = await readdir(join(root, "cache"));
    assert.equal(cacheEntries.some((entry) => entry.includes(".corrupted.")), true);

    assert.equal(warnCalls.length, 1);
    const reason = warnCalls[0]?.details?.reason;
    assert.equal(typeof reason, "string");
    assert.match(reason as string, /integrity check failed/i);

    const fullCheckAttempt = infoCalls.find((entry) => entry.details?.check === "integrity_check");
    assert.ok(fullCheckAttempt, "expected the failing consistency check to have run as a full integrity_check");

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      0,
      "expected the request file to be cleared after a successful rebuild"
    );
  }));

test("openDatabase runs plain quick_check (not integrity_check) when no marker is present", () =>
  withTempDir("quick-check-no-marker-", async (root) => {
    const config = buildTestConfig(root);
    const first = openDatabase(config);
    first.db.close();

    const { logger, infoCalls } = createCapturingLogger();
    const second = openDatabase(config, logger);
    second.db.close();

    assert.equal(
      infoCalls.some((entry) => entry.details?.check === "quick_check"),
      true,
      "expected the default open (no marker) to run quick_check"
    );
    assert.equal(
      infoCalls.some((entry) => entry.details?.check === "integrity_check"),
      false,
      "expected no full integrity_check without a marker"
    );
  }));

test("isRawSqliteCorruptionError recognizes a node:sqlite-shaped corruption error by errcode, and rejects everything else", () => {
  assert.equal(isRawSqliteCorruptionError({ code: "ERR_SQLITE_ERROR", errcode: 11 }), true);
  assert.equal(isRawSqliteCorruptionError({ code: "ERR_SQLITE_ERROR", errcode: 26 }), true);
  assert.equal(isRawSqliteCorruptionError({ code: "SQLITE_CORRUPT" }), true);
  assert.equal(isRawSqliteCorruptionError({ code: "ERR_SQLITE_ERROR", errcode: 5 }), false);
  assert.equal(isRawSqliteCorruptionError(new Error("boom")), false);
  assert.equal(isRawSqliteCorruptionError(undefined), false);
});

test("convertRuntimeSqliteCorruption converts a raw corruption error into ERR_DB_FAILURE with restart guidance, and requests a full integrity check", () =>
  withTempDir("runtime-corruption-convert-", async (root) => {
    const config = buildTestConfig(root);
    const rawError = { code: "ERR_SQLITE_ERROR", errcode: 11, message: "database disk image is malformed" };

    const converted = convertRuntimeSqliteCorruption(rawError, config.sqlitePath) as {
      code?: string;
      details?: Record<string, unknown>;
    };

    assert.equal(converted.code, "ERR_DB_FAILURE");
    assert.equal(converted.details?.reason, "runtime_corruption");
    assert.equal(converted.details?.sqlitePath, config.sqlitePath);
    assert.equal(typeof converted.details?.nextAction, "string");
    assert.match(converted.details?.nextAction as string, /restart/i);

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      1,
      "expected a full-integrity-check request file to be written as a side effect"
    );
  }));

test("convertRuntimeSqliteCorruption returns non-corruption errors unchanged and requests no integrity check", () =>
  withTempDir("runtime-corruption-passthrough-", async (root) => {
    const config = buildTestConfig(root);
    const original = new Error("not a corruption error");

    const converted = convertRuntimeSqliteCorruption(original, config.sqlitePath);

    assert.equal(converted, original);
    assert.equal(listIntegrityCheckRequestFiles(config.sqlitePath).length, 0);
  }));

test("convertRuntimeSqliteCorruption falls back to manual-recovery guidance naming the cache path when the follow-up check cannot be scheduled", () =>
  withTempDir("runtime-corruption-schedule-failure-", async (root) => {
    // Make the marker's parent directory impossible to create: a plain FILE
    // occupies where a directory component needs to be, so
    // mkdirSync(..., { recursive: true }) - and therefore
    // requestFullIntegrityCheck - fails with ENOTDIR.
    const blockingFilePath = join(root, "not-a-directory");
    await writeFile(blockingFilePath, "");
    const sqlitePath = join(blockingFilePath, "cache", "source-cache.db");

    const rawError = { code: "ERR_SQLITE_ERROR", errcode: 11, message: "database disk image is malformed" };
    const converted = convertRuntimeSqliteCorruption(rawError, sqlitePath) as {
      code?: string;
      details?: Record<string, unknown>;
    };

    assert.equal(converted.code, "ERR_DB_FAILURE");
    assert.equal(converted.details?.reason, "runtime_corruption");
    const nextAction = converted.details?.nextAction as string;
    assert.match(nextAction, /could not be scheduled/i);
    assert.equal(nextAction.includes(sqlitePath), true, "expected the cache path to be named in the fallback guidance");
    assert.match(nextAction, /stop every mcp server process/i);
    assert.match(nextAction, /-wal and -shm/i);
    assert.equal(
      /restart the mcp server so the cache database is fully checked/i.test(nextAction),
      false,
      "expected the fallback guidance, not the normal restart guidance"
    );
    assert.equal(
      /manage-cache/i.test(nextAction),
      false,
      "expected no manage-cache mention - it only rewrites rows through the same damaged database"
    );
  }));

test("Database.setCorruptionObserver fires exactly once with the ORIGINAL error, which is still rethrown unchanged, when a live query hits a corrupted page", () =>
  withTempDir("sqlite-observer-raw-", async (root) => {
    const config = buildTestConfig(root);
    const target = await buildDatabaseWithCorruptedArtifactOverflow(config);

    // Open with the raw Database class directly - no consistency check at
    // all - to get a "successfully opened" handle over the corrupted file,
    // mirroring what a real runtime corruption looks like: whatever check
    // ran (or didn't) at open time passed, and corruption is discovered only
    // by a later, ordinary query.
    const rawDb = new RawDatabase(config.sqlitePath);
    const observed: unknown[] = [];
    rawDb.setCorruptionObserver((error) => observed.push(error));

    let thrown: unknown;
    try {
      selectProvenance(rawDb, target);
      assert.fail("expected the query to throw over the corrupted overflow page");
    } catch (error) {
      thrown = error;
    }

    assert.equal(observed.length, 1, "expected the observer to fire exactly once");
    assert.equal(observed[0], thrown, "expected the observer to receive the SAME error object that was rethrown");
    assert.equal(isRawSqliteCorruptionError(thrown), true);

    rawDb.close();
  }));

test("a second corrupted query on the same handle does not fire the observer again (at most once per Database instance)", () =>
  withTempDir("sqlite-observer-once-", async (root) => {
    const config = buildTestConfig(root);
    const target = await buildDatabaseWithCorruptedArtifactOverflow(config);

    const rawDb = new RawDatabase(config.sqlitePath);
    const observed: unknown[] = [];
    rawDb.setCorruptionObserver((error) => observed.push(error));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        selectProvenance(rawDb, target);
      } catch {
        // expected: the corrupted overflow page throws on every attempt
      }
    }

    assert.equal(observed.length, 1, "expected the observer to fire at most once per Database instance");
    rawDb.close();
  }));

test("Database.prepare() reaches the observer when PREPARING itself throws a raw corruption error (damaged schema), not just when running a prepared statement", () =>
  withTempDir("sqlite-observer-prepare-", async (root) => {
    const config = buildTestConfig(root);

    const initial = openDatabase(config);
    initial.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("artifact-schema", "local-jar", 0, "2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z");
    const pageSizeRow = (initial.db.pragma("page_size") as Array<{ page_size: number }>)[0];
    const pageSize = pageSizeRow?.page_size ?? 4096;
    initial.db.pragma("wal_checkpoint(TRUNCATE)");
    initial.db.close();

    // A real, reproduced fixture (not a stub): corrupt the SCHEMA page (page
    // 1 / sqlite_master) itself, past the 100-byte file header. A brand-new
    // connection has not yet loaded any schema, so opening it still succeeds
    // (the constructor does not eagerly parse sqlite_master), but its FIRST
    // prepare() call needs the schema to compile a statement against - and
    // throws while doing so, before Statement.invoke (or any run/get/all) is
    // ever reached. Empirically confirmed while building this fixture: with
    // prepare() unwrapped, this reproduces errcode 11 with the observer never
    // notified - exactly the gap this fix closes.
    const dbPath = config.sqlitePath;
    const raw = await readFile(dbPath);
    const corrupted = Buffer.from(raw);
    corrupted.fill(0xff, 100, pageSize);
    await writeFile(dbPath, corrupted);

    const rawDb = new RawDatabase(dbPath);
    const observed: unknown[] = [];
    rawDb.setCorruptionObserver((error) => observed.push(error));

    assert.throws(() =>
      rawDb.prepare("SELECT artifact_id FROM artifacts WHERE artifact_id = ?").get("artifact-schema")
    );

    assert.equal(observed.length, 1, "expected prepare()'s own corruption error to reach the observer");
    assert.equal(isRawSqliteCorruptionError(observed[0]), true);
  }));

test("attachRuntimeCorruptionObserver - the wiring openDatabase itself uses - requests a full integrity check when a later query on that handle hits a corrupted page", () =>
  withTempDir("sqlite-observer-openDatabase-wiring-", async (root) => {
    const config = buildTestConfig(root);
    const target = await buildDatabaseWithCorruptedArtifactOverflow(config);

    // openDatabase's OWN open-time check would already catch this exact
    // corruption (as the "detects a corrupted data page" test above proves)
    // and go straight to backup+rebuild before ever handing back a
    // "successfully opened" live handle - so there is no way to make
    // openDatabase itself return a handle over this corrupted file to query
    // against. Attaching the SAME wiring helper openDatabase uses
    // (attachRuntimeCorruptionObserver) to a handle opened directly exercises
    // exactly the wiring under test without that catch-22.
    const rawDb = new RawDatabase(config.sqlitePath);
    const { logger } = createCapturingLogger();
    attachRuntimeCorruptionObserver(rawDb, config.sqlitePath, logger);

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      0,
      "expected no request file before the corruption is hit"
    );

    assert.throws(() => selectProvenance(rawDb, target));

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      1,
      "expected the observer to request a full integrity check"
    );

    rawDb.close();
  }));

// The earlier single shared marker file could still race across processes:
// one process reads its token, a second process overwrites the marker with
// its own newer token, and the first process's clear then deletes that
// newer, not-yet-honored request. Replaced by one immutable, uniquely-named
// request file per request (exclusive-create) plus these two tests: a plain
// removal, and the race case where a request file created strictly after the
// "decision" (openDatabase's own list-then-clear, or here a stand-in
// list-then-clear around requestFullIntegrityCheck) must survive being
// cleared by a decision that never saw it.
test("clearIntegrityCheckRequestFiles removes exactly the request files it is given", () =>
  withTempDir("marker-request-remove-", async (root) => {
    const config = buildTestConfig(root);
    const { logger } = createCapturingLogger();

    requestFullIntegrityCheck(config.sqlitePath, logger);
    const requestFiles = listIntegrityCheckRequestFiles(config.sqlitePath);
    assert.equal(requestFiles.length, 1);

    clearIntegrityCheckRequestFiles(requestFiles, logger);

    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      0,
      "expected the exact request file passed in to be removed"
    );
  }));

test("clearIntegrityCheckRequestFiles leaves a request file created after the decision point untouched", () =>
  withTempDir("marker-request-race-", async (root) => {
    const config = buildTestConfig(root);
    const { logger } = createCapturingLogger();

    // The "decision": list what is pending right now (this is exactly what
    // openDatabase does before running its consistency check).
    requestFullIntegrityCheck(config.sqlitePath, logger);
    const decidedFiles = listIntegrityCheckRequestFiles(config.sqlitePath);
    assert.equal(decidedFiles.length, 1);

    // A NEW request arrives strictly after that decision - a concurrent
    // process, or a second corruption event - standing in for the moment
    // between openDatabase's own list and its clear, which (being
    // synchronous with no `await` in between) cannot be interleaved from
    // outside that call.
    requestFullIntegrityCheck(config.sqlitePath, logger);
    assert.equal(
      listIntegrityCheckRequestFiles(config.sqlitePath).length,
      2,
      "expected both the original and the new request file to exist"
    );

    clearIntegrityCheckRequestFiles(decidedFiles, logger);

    const remaining = listIntegrityCheckRequestFiles(config.sqlitePath);
    assert.equal(remaining.length, 1, "expected only the file NOT seen at the decision point to survive");
    assert.notEqual(
      remaining[0],
      decidedFiles[0],
      "expected the surviving file to be the newer request, not the one the decision saw and cleared"
    );
  }));

test("Statement.iterate forwards early termination to the underlying sqlite iterator", async () => {
  const { Statement } = await import("../../src/storage/sqlite.ts");
  let returnCalls = 0;
  const rows = [{ x: 1 }, { x: 2 }, { x: 3 }];
  const fakeStatement = {
    iterate: () => {
      let index = 0;
      return {
        next: () => (index < rows.length ? { value: rows[index++], done: false } : { value: undefined, done: true }),
        return: () => {
          returnCalls += 1;
          return { value: undefined, done: true };
        },
        [Symbol.iterator]() {
          return this;
        }
      };
    }
  };
  const statement = new Statement<{ x: number }>(fakeStatement as never, () => {});

  for (const row of statement.iterate()) {
    if (row.x === 1) {
      break;
    }
  }

  assert.equal(returnCalls, 1, "breaking out of the loop must close the underlying iterator");
});
