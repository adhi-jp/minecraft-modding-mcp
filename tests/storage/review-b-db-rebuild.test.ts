import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/storage/db.ts";
import { withTempDir } from "../helpers/temp-dir.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/** A logger that keeps the rebuild chatter out of the test output. */
const silentLogger = {
  warn: () => {},
  info: () => {},
  error: () => {}
};

test("openDatabase reports a failed rebuild as a typed database failure", {
  // A directory mode is what makes the backup rename fail here, and root is not
  // subject to one - nor is Windows, where these bits do not mean this.
  skip:
    process.platform === "win32"
      ? "directory permission bits do not gate rename here"
      : process.getuid?.() === 0
        ? "root is not subject to the directory mode this stages"
        : false
}, () =>
  withTempDir("review-b-db-rebuild-fail-", async (root) => {
    const config = buildTestConfig(root);
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(config.sqlitePath, "this is not a sqlite database");
    // Renaming the corrupted file aside needs write permission on the DIRECTORY.
    // Withhold it and the rebuild branch fails at its first step, with the
    // corruption already diagnosed - the one exit from openDatabase that used to
    // escape as a raw fs error while every other one is a typed ERR_DB_FAILURE.
    await chmod(cacheDir, 0o555);
    try {
      assert.throws(
        () => openDatabase(config, silentLogger),
        (error) => {
          assert.equal((error as { code?: string }).code, "ERR_DB_FAILURE");
          assert.match(String((error as Error).message), /EACCES|permission denied/i);
          return true;
        }
      );
    } finally {
      await chmod(cacheDir, 0o755);
    }
  }));
