import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCacheRegistry } from "../../src/cache-registry.ts";

async function createDownloadsCache(prefix: string): Promise<{ cacheDir: string; sqlitePath: string; jarPath: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cacheDir = join(root, "cache");
  await mkdir(join(cacheDir, "downloads"), { recursive: true });
  const jarPath = join(cacheDir, "downloads", "client.jar");
  await writeFile(jarPath, "jar");
  return { cacheDir, sqlitePath: join(cacheDir, "source-cache.db"), jarPath };
}

test("cache registry rebuild apply reports nothing rebuilt and points at delete instead", async () => {
  const { cacheDir, sqlitePath, jarPath } = await createDownloadsCache("cache-registry-rebuild-apply-");
  const registry = createCacheRegistry({ cacheDir, sqlitePath });

  const applied = await registry.rebuildEntries({
    cacheKinds: ["downloads"],
    selector: { entryId: "client.jar" },
    executionMode: "apply"
  });

  assert.equal(applied.rebuiltEntries, 0);
  assert.equal(applied.warnings.length, 1);
  const warning = applied.warnings[0] ?? "";
  assert.match(warning, /not implemented/i);
  assert.match(warning, /downloads/);
  assert.match(warning, /delete/i);
  // Nothing was rebuilt and nothing was destroyed either.
  assert.equal(existsSync(jarPath), true);
});

test("cache registry rebuild preview makes the same no-op promise as apply", async () => {
  const { cacheDir, sqlitePath } = await createDownloadsCache("cache-registry-rebuild-preview-");
  const registry = createCacheRegistry({ cacheDir, sqlitePath });

  const previewed = await registry.rebuildEntries({
    cacheKinds: ["downloads"],
    executionMode: "preview"
  });

  assert.equal(previewed.rebuiltEntries, 0);
  assert.match(previewed.warnings[0] ?? "", /not implemented/i);
});

test("cache registry rebuild still rejects a malformed olderThan selector as invalid input", async () => {
  const { cacheDir, sqlitePath } = await createDownloadsCache("cache-registry-rebuild-selector-");
  const registry = createCacheRegistry({ cacheDir, sqlitePath });

  await assert.rejects(
    () =>
      registry.rebuildEntries({
        cacheKinds: ["downloads"],
        selector: { olderThan: "thirty days" },
        executionMode: "apply"
      }),
    (error: { code?: string }) => error.code === "ERR_INVALID_INPUT"
  );
});

test("cache registry delete does not open the artifact index when no artifact-index entry is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-no-open-"));
  const cacheDir = join(root, "cache");
  const downloadsDir = join(cacheDir, "downloads");
  await mkdir(downloadsDir, { recursive: true });
  const jarPath = join(downloadsDir, "client.jar");
  await writeFile(jarPath, "jar");

  // Not a SQLite database at all: opening it runs the consistency check, which
  // fails and moves the file aside. Leaving these bytes untouched is the
  // observable proof that a downloads-only delete never opened the index.
  const sqlitePath = join(cacheDir, "source-cache.db");
  const sentinel = "this is not a sqlite database";
  await writeFile(sqlitePath, sentinel);

  const registry = createCacheRegistry({ cacheDir, sqlitePath });
  const result = await registry.deleteEntries({
    cacheKinds: ["downloads"],
    selector: { entryId: "client.jar" },
    executionMode: "apply"
  });

  assert.equal(result.deletedEntries, 1);
  assert.equal(existsSync(jarPath), false);
  assert.equal(
    (await readFile(sqlitePath, "utf8")).slice(0, sentinel.length),
    sentinel,
    "the artifact index must not have been opened, checked or rebuilt"
  );
  assert.equal(
    (await readdir(cacheDir)).some((entry) => entry.includes(".corrupted.")),
    false,
    "opening the index would have moved the unreadable file aside"
  );
});
