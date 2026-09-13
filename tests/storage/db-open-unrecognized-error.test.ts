import assert from "node:assert/strict";
import test from "node:test";

import Database from "../../src/storage/sqlite.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { withTempDir } from "../helpers/temp-dir.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/** A logger that keeps the error chatter out of the test output. */
const silentLogger = {
  warn: () => {},
  info: () => {},
  error: () => {}
};

test("openDatabase classifies an unrecognized SQLite failure (e.g. SQLITE_BUSY) as ERR_DB_FAILURE", (t) =>
  withTempDir("db-open-unrecognized-error-", async (root) => {
    const config = buildTestConfig(root);

    // SQLITE_BUSY (another connection holds the lock) is neither an ERR_IO
    // shaped error, a schema-version mismatch, nor recognized corruption
    // (isCorruptionError only matches SQLITE_CORRUPT/SQLITE_NOTADB). The
    // adjacent comment in openDatabase claims every exit besides the
    // recognized branches still surfaces as a typed ERR_DB_FAILURE - this
    // pragma call is where that claim is put to the test.
    t.mock.method(Database.prototype, "pragma", () => {
      const busyError = new Error("database is locked") as Error & { code: string };
      busyError.code = "SQLITE_BUSY";
      throw busyError;
    });

    assert.throws(
      () => openDatabase(config, silentLogger),
      (error) => {
        assert.equal((error as { code?: string }).code, "ERR_DB_FAILURE");
        assert.match(String((error as Error).message), /SQLITE_BUSY|database is locked/i);
        return true;
      }
    );
  }));
