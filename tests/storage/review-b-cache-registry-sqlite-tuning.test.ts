import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCacheRegistry, type CacheRegistryConfig } from "../../src/cache-registry.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { runMigrations } from "../../src/storage/migrations.ts";
import Database from "../../src/storage/sqlite.ts";

/** Deliberately unlike the built-in 8_000 / 268_435_456, so a default reads as a miss. */
const TUNED_CACHE_KB = 4_096;
const TUNED_MMAP_SIZE = 33_554_432;

test("a cache registry configured with SQLite tuning opens the artifact index with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-registry-tuning-"));
  const sqlitePath = join(root, "source-cache.db");
  const seed = new Database(sqlitePath);
  seed.pragma("foreign_keys = ON");
  runMigrations(seed);
  seed.prepare(`
    INSERT INTO artifacts (artifact_id, origin, is_decompiled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("artifact-tuned", "local-jar", 0, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
  seed.close();

  // The registry is the only reader of the artifact index that manage-cache goes
  // through, and it hands this whole object to openDatabase. Without these two
  // fields on CacheRegistryConfig there is nothing for it to hand over, so the
  // index opens on the built-in defaults and MCP_SQLITE_CACHE_KB /
  // MCP_SQLITE_MMAP_SIZE go unread for it alone.
  const config: CacheRegistryConfig = {
    cacheDir: root,
    sqlitePath,
    sqliteCacheKb: TUNED_CACHE_KB,
    sqliteMmapSize: TUNED_MMAP_SIZE
  };
  const registry = createCacheRegistry(config);

  const entries = await registry.listEntries({ cacheKinds: ["artifact-index"], limit: 10 });
  assert.deepEqual(
    entries.entries.map((entry) => entry.entryId),
    ["artifact-tuned"],
    "the tuning must not change what the registry reads back"
  );

  // The pragmas the registry's own open produces, observed on a connection made
  // from the same fields it forwards. cache_size and mmap_size are
  // per-connection, so they cannot be read back after the registry closes its
  // handle; this is the same config reaching the same opener instead.
  const opened = openDatabase(config);
  try {
    assert.equal(
      (opened.db.pragma("cache_size") as Array<{ cache_size: number }>)[0]?.cache_size,
      -TUNED_CACHE_KB
    );
    assert.equal(
      (opened.db.pragma("mmap_size") as Array<{ mmap_size: number }>)[0]?.mmap_size,
      TUNED_MMAP_SIZE
    );
  } finally {
    opened.db.close();
  }
});

test("index.ts hands the configured SQLite tuning to the manage-cache registry", async () => {
  const source = await readFile("src/index.ts", "utf8");

  // The registry is built once at startup from `config`, and it was built with
  // the two path fields alone - so every other consumer of the artifact index
  // honoured MCP_SQLITE_CACHE_KB / MCP_SQLITE_MMAP_SIZE and manage-cache did not.
  assert.match(source, /registry:\s*createCacheRegistry\(\{/);
  assert.match(source, /createCacheRegistry\(\{[^}]*sqliteCacheKb:\s*config\.sqliteCacheKb/s);
  assert.match(source, /createCacheRegistry\(\{[^}]*sqliteMmapSize:\s*config\.sqliteMmapSize/s);
});
