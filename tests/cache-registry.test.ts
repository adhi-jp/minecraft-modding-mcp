import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCacheRegistry } from "../src/cache-registry.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import Database from "../src/storage/sqlite.ts";

test("cache registry inventories logical public cache kinds from filesystem state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  await mkdir(join(root, "registries", "1.21.10"), { recursive: true });
  await mkdir(join(root, "decompiled"), { recursive: true });
  await mkdir(join(root, "remapped-mods"), { recursive: true });
  await writeFile(join(root, "downloads", "client.jar"), "jar");
  await writeFile(join(root, "registries", "1.21.10", "registries.json"), "{}");
  await writeFile(join(root, "decompiled", "artifact.txt"), "src");
  await writeFile(join(root, "remapped-mods", "example.jar"), "jar");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const summary = await registry.summarize({
    cacheKinds: ["downloads", "registry", "decompiled-source", "mod-remap"]
  });

  assert.equal(summary.kinds.downloads.entryCount, 1);
  assert.equal(summary.kinds.registry.entryCount, 1);
  assert.equal(summary.kinds["decompiled-source"].entryCount, 1);
  assert.equal(summary.kinds["mod-remap"].entryCount, 1);
  assert.equal(summary.kinds.downloads.status, "healthy");
});

test("cache registry listEntries paginates and normalizes WSL jarPath selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-page-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const alpha = join(root, "downloads", "alpha.jar");
  const beta = join(root, "downloads", "beta.jar");
  await writeFile(alpha, "alpha");
  await writeFile(beta, "beta");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db"),
    pathRuntimeInfo: {
      platform: "linux",
      isWsl: true,
      wslDistro: "UnitTestDistro"
    }
  });

  const normalizedSelector = await registry.listEntries({
    cacheKinds: ["downloads"],
    selector: {
      jarPath: `\\\\wsl$\\UnitTestDistro${alpha.replaceAll("/", "\\")}`
    },
    limit: 1
  });

  assert.equal(normalizedSelector.entries.length, 1);
  assert.equal(normalizedSelector.entries[0]?.entryId, "alpha.jar");

  const page1 = await registry.listEntries({
    cacheKinds: ["downloads"],
    limit: 1
  });
  assert.equal(page1.entries[0]?.entryId, "alpha.jar");
  assert.ok(page1.nextCursor);

  const page2 = await registry.listEntries({
    cacheKinds: ["downloads"],
    limit: 1,
    cursor: page1.nextCursor
  });

  assert.equal(page2.entries.length, 1);
  assert.equal(page2.entries[0]?.entryId, "beta.jar");
});

test("cache registry filters stale filesystem entries via olderThan and status selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-stale-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const staleFile = join(root, "downloads", "stale.jar");
  const freshFile = join(root, "downloads", "fresh.jar");
  await writeFile(staleFile, "stale");
  await writeFile(freshFile, "fresh");

  const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  await utimes(staleFile, staleDate, staleDate);

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const result = await registry.listEntries({
    cacheKinds: ["downloads"],
    selector: {
      olderThan: "P30D",
      status: "stale"
    },
    limit: 10
  });

  assert.deepEqual(result.entries.map((entry) => entry.entryId), ["stale.jar"]);
});

test("cache registry matches artifact-index entries by mapping, scope, and projectPath selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-artifacts-"));
  const workspace = join(root, "workspace");
  const loomCache = join(workspace, ".gradle", "loom-cache");
  await mkdir(loomCache, { recursive: true });
  const binaryJarPath = join(loomCache, "1.21.10-merged.jar");
  await writeFile(binaryJarPath, "jar");

  const sqlitePath = join(root, "source-cache.db");
  const db = new Database(sqlitePath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`
    INSERT INTO artifacts (
      artifact_id,
      origin,
      binary_jar_path,
      requested_mapping,
      mapping_applied,
      version,
      is_decompiled,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artifact-merged",
    "local-jar",
    binaryJarPath,
    "mojang",
    "mojang",
    "1.21.10",
    0,
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z"
  );
  db.prepare(`
    INSERT INTO artifact_content_bytes (artifact_id, total_content_bytes)
    VALUES (?, ?)
  `).run("artifact-merged", 3);
  db.close();

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath
  });

  const result = await registry.listEntries({
    cacheKinds: ["artifact-index"],
    selector: {
      mapping: "mojang",
      scope: "merged",
      projectPath: workspace
    },
    limit: 10
  });

  assert.deepEqual(result.entries.map((entry) => entry.entryId), ["artifact-merged"]);
});
