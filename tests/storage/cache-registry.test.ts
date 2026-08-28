import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCacheRegistry, pathContainsVersion } from "../../src/cache-registry.ts";
import { downloadSidecarPath } from "../../src/repo-downloader.ts";
import { runMigrations } from "../../src/storage/migrations.ts";
import Database from "../../src/storage/sqlite.ts";

test("pathContainsVersion matches whole version tokens, not coarse substrings", () => {
  // Exact and major.minor.patch sweep should match.
  assert.equal(pathContainsVersion("/cache/registries/1.2/data", "1.2"), true);
  assert.equal(pathContainsVersion("/cache/registries/1.21.4/data", "1.21"), true);
  assert.equal(pathContainsVersion("/cache/downloads/minecraft-1.21.4-sources.jar", "1.21.4"), true);
  // The bug: a coarse "1.2" selector must NOT match a "1.21" path (destructive prune safety).
  assert.equal(pathContainsVersion("/cache/registries/1.21/data", "1.2"), false);
  assert.equal(pathContainsVersion("/cache/registries/1.214/data", "1.21"), false);
});

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

test("cache registry listEntries pagination does not drop mixed-case entries across pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-case-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const names = ["another.jar", "beta.jar", "MyMod.jar", "Zeta.jar"];
  for (const name of names) {
    await writeFile(join(root, "downloads", name), "jar");
  }

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const collected: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await registry.listEntries({
      cacheKinds: ["downloads"],
      limit: 2,
      cursor
    });
    collected.push(...page.entries.map((entry) => entry.entryId));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual([...collected].sort(), [...names].sort());
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

test("cache registry inventories `<cacheDir>/remapped/<artifactId>.jar` as the binary-remap kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-binremap-"));
  await mkdir(join(root, "remapped"), { recursive: true });
  await writeFile(join(root, "remapped", "alpha.jar"), "remapped-jar");
  await writeFile(join(root, "remapped", "beta.jar"), "remapped-jar-2");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const summary = await registry.summarize({ cacheKinds: ["binary-remap"] });
  assert.equal(summary.kinds["binary-remap"]?.entryCount, 2);
  assert.equal(summary.kinds["binary-remap"]?.totalBytes, "remapped-jar".length + "remapped-jar-2".length);

  const filteredByArtifactId = await registry.listEntries({
    cacheKinds: ["binary-remap"],
    selector: { artifactId: "alpha" },
    limit: 10
  });
  assert.deepEqual(filteredByArtifactId.entries.map((entry) => entry.entryId), ["alpha.jar"]);

  const deletion = await registry.deleteEntries({
    cacheKinds: ["binary-remap"],
    selector: { artifactId: "alpha" },
    executionMode: "apply"
  });
  assert.equal(deletion.deletedEntries, 1);
  assert.equal(deletion.deletedBytes, "remapped-jar".length);

  const remaining = await registry.listEntries({ cacheKinds: ["binary-remap"], limit: 10 });
  assert.deepEqual(remaining.entries.map((entry) => entry.entryId), ["beta.jar"]);
});

test("cache registry lists and deletes corrupt top-level binary-remap directories by artifactId", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-binremap-corrupt-"));
  const remappedRoot = join(root, "remapped");
  await mkdir(join(remappedRoot, "alpha.jar", "nested"), { recursive: true });
  await mkdir(join(remappedRoot, "beta.jar.tmp.123.456.abcdef", "nested"), { recursive: true });
  await mkdir(join(remappedRoot, "gamma.tmp.123.456.abcdef.jar", "nested"), { recursive: true });
  await writeFile(join(remappedRoot, "alpha.jar", "nested", "poison.txt"), "directory");
  await writeFile(join(remappedRoot, "beta.jar.tmp.123.456.abcdef", "nested", "poison.txt"), "legacy temp");
  await writeFile(join(remappedRoot, "gamma.tmp.123.456.abcdef.jar", "nested", "poison.txt"), "new temp");
  await writeFile(join(remappedRoot, "healthy.jar"), "remapped-jar");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const listed = await registry.listEntries({ cacheKinds: ["binary-remap"], limit: 10 });
  const byId = new Map(listed.entries.map((entry) => [entry.entryId, entry]));

  assert.equal(byId.get("alpha.jar")?.status, "corrupt");
  assert.equal(byId.get("alpha.jar")?.meta?.artifactId, "alpha");
  assert.equal(byId.get("beta.jar.tmp.123.456.abcdef")?.status, "corrupt");
  assert.equal(byId.get("beta.jar.tmp.123.456.abcdef")?.meta?.artifactId, "beta");
  assert.equal(byId.get("gamma.tmp.123.456.abcdef.jar")?.status, "corrupt");
  assert.equal(byId.get("gamma.tmp.123.456.abcdef.jar")?.meta?.artifactId, "gamma");
  assert.equal(byId.get("healthy.jar")?.status, "healthy");

  const summary = await registry.summarize({ cacheKinds: ["binary-remap"] });
  assert.equal(summary.kinds["binary-remap"]?.status, "corrupt");

  const deletion = await registry.deleteEntries({
    cacheKinds: ["binary-remap"],
    selector: { artifactId: "alpha" },
    executionMode: "apply"
  });

  assert.equal(deletion.deletedEntries, 1);
  assert.equal(deletion.deletedBytes, "directory".length);
  assert.equal(existsSync(join(remappedRoot, "alpha.jar")), false);
  assert.equal(existsSync(join(remappedRoot, "healthy.jar")), true);
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

test("cache registry backs up and recovers a corrupt artifact-index database while listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-corrupt-db-"));
  const sqlitePath = join(root, "source-cache.db");
  await writeFile(sqlitePath, "not a sqlite database");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath
  });

  const result = await registry.listEntries({
    cacheKinds: ["artifact-index"],
    limit: 10
  });

  assert.deepEqual(result.entries, []);
  assert.equal(existsSync(sqlitePath), true);
  const backupNames = (await readdir(root)).filter((name) =>
    name.startsWith("source-cache.db.corrupted.")
  );
  assert.equal(backupNames.length, 1);
  assert.equal(await readFile(join(root, backupNames[0]!), "utf8"), "not a sqlite database");
});

test("cache registry does not create a missing artifact-index database while listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-missing-db-"));
  const sqlitePath = join(root, "source-cache.db");
  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath
  });

  const result = await registry.listEntries({
    cacheKinds: ["artifact-index"],
    limit: 10
  });

  assert.deepEqual(result.entries, []);
  assert.equal(existsSync(sqlitePath), false);
});


test("cache registry summarizes and lists workspace context cache entries", async () => {
  const { createWorkspaceContextCache } = await import("../../src/workspace-context-cache.ts");
  const root = await mkdtemp(join(tmpdir(), "cache-registry-workspace-"));
  const sqlitePath = join(root, "source-cache.db");
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: "/tmp/project-a",
    minecraftVersion: "1.21.10",
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath,
    workspaceContextCache: cache
  });

  const summary = await registry.summarize({ cacheKinds: ["workspace"] });
  assert.equal(summary.kinds.workspace.entryCount, 1);
  assert.equal(summary.kinds.workspace.status, "healthy");

  const list = await registry.listEntries({ cacheKinds: ["workspace"] });
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0]?.entryId, "/tmp/project-a");
});

test("cache registry deletes a single workspace entry by projectPath selector", async () => {
  const { createWorkspaceContextCache } = await import("../../src/workspace-context-cache.ts");
  const root = await mkdtemp(join(tmpdir(), "cache-registry-workspace-del-"));
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: "/tmp/project-a",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });
  cache.write({
    projectPath: "/tmp/project-b",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db"),
    workspaceContextCache: cache
  });

  const result = await registry.deleteEntries({
    cacheKinds: ["workspace"],
    selector: { projectPath: "/tmp/project-a" },
    executionMode: "apply"
  });

  assert.equal(result.deletedEntries, 1);
  assert.equal(cache.read("/tmp/project-a"), undefined);
  assert.ok(cache.read("/tmp/project-b"));
});

test("cache registry deleteEntries(executionMode='preview') does not delete files but reports the deletion count", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-preview-"));
  await mkdir(join(root, "remapped"), { recursive: true });
  const jarPath = join(root, "remapped", "alpha.jar");
  await writeFile(jarPath, "remapped-jar-bytes");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const preview = await registry.deleteEntries({
    cacheKinds: ["binary-remap"],
    selector: { artifactId: "alpha" },
    executionMode: "preview"
  });

  assert.equal(preview.deletedEntries, 1, "preview must still report the matched count");
  assert.ok(preview.deletedBytes > 0, "preview must still report the matched bytes");
  assert.equal(existsSync(jarPath), true, "preview must NOT delete the file on disk");
  // Verify the bytes are intact, not silently truncated/replaced by a partial
  // write. Just checking existsSync would miss a regression that opens with
  // O_TRUNC then aborts.
  assert.equal(
    await readFile(jarPath, "utf8"),
    "remapped-jar-bytes",
    "preview must leave the jar bytes intact"
  );
});

test("cache registry listEntries rejects invalid `olderThan` selector with ERR_INVALID_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-olderthan-bad-"));
  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  for (const value of ["30D", "P0D", "garbage"]) {
    await assert.rejects(
      () =>
        registry.listEntries({
          cacheKinds: ["downloads"],
          selector: { olderThan: value }
        } as any),
      (err: any) => err.code === "ERR_INVALID_INPUT",
      `expected ERR_INVALID_INPUT for olderThan="${value}"`
    );
  }
});

test("cache registry deleteEntries on binary-remap leaves non-binary-remap caches untouched (non-recursive scope)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-scope-"));
  // binary-remap entry to delete
  await mkdir(join(root, "remapped"), { recursive: true });
  await writeFile(join(root, "remapped", "alpha.jar"), "remapped-bytes");
  // downloads entry that must stay
  await mkdir(join(root, "downloads"), { recursive: true });
  const downloadFile = join(root, "downloads", "neighbour.bin");
  await writeFile(downloadFile, "download-bytes");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  await registry.deleteEntries({
    cacheKinds: ["binary-remap"],
    selector: { artifactId: "alpha" },
    executionMode: "apply"
  });

  assert.equal(existsSync(join(root, "remapped", "alpha.jar")), false, "binary-remap entry was deleted");
  assert.equal(existsSync(downloadFile), true, "downloads cache must remain untouched");
});

// ---------------------------------------------------------------------------
// Download sidecars.
//
// `resolveCachedDownload` writes `<jar>.cache.json` next to every cached jar
// (src/repo-downloader.ts). That file is the jar's identity record, not a
// cache artifact of its own: it must never be inventoried, sized, or deleted
// independently of the jar it describes.
// ---------------------------------------------------------------------------

test("cache registry folds a download sidecar into the jar entry it describes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-sidecar-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const jarPath = join(root, "downloads", "client.jar");
  const sidecarPath = downloadSidecarPath(jarPath);
  await writeFile(jarPath, "jar-bytes");
  await writeFile(
    sidecarPath,
    JSON.stringify({
      version: 1,
      url: "https://example.invalid/client.jar",
      contentSha256: "abc",
      contentLength: "jar-bytes".length
    })
  );
  const sidecarBytes = (await readFile(sidecarPath)).byteLength;

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const listed = await registry.listEntries({ cacheKinds: ["downloads"], limit: 10 });

  assert.deepEqual(
    listed.entries.map((entry) => entry.entryId),
    ["client.jar"],
    "the sidecar belongs to the jar's entry; it must not be listed on its own"
  );
  assert.equal(
    listed.entries[0]?.meta?.jarPath,
    jarPath,
    "jarPath must name the jar, never a sidecar JSON file"
  );
  assert.equal(
    listed.entries[0]?.sizeBytes,
    "jar-bytes".length + sidecarBytes,
    "the sidecar's bytes must be folded into the jar entry, not dropped"
  );

  // The accounting rule, stated once: totals cover every byte that belongs to a
  // cache entry, and a sidecar's bytes belong to the jar it describes. Bytes
  // that describe nothing - an orphan sidecar, an interrupted write - belong to
  // no entry and are therefore invisible here (see the orphan test below).
  const summary = await registry.summarize({ cacheKinds: ["downloads"] });
  assert.equal(summary.kinds.downloads?.entryCount, 1);
  assert.equal(
    summary.kinds.downloads?.totalBytes,
    "jar-bytes".length + sidecarBytes,
    "a sidecar's bytes are part of its jar's entry, so the total must include them"
  );
});

test("cache registry deletes a download sidecar together with the jar it describes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-sidecar-delete-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const jarPath = join(root, "downloads", "client.jar");
  const sidecarPath = downloadSidecarPath(jarPath);
  const keptJarPath = join(root, "downloads", "other.jar");
  const keptSidecarPath = downloadSidecarPath(keptJarPath);
  await writeFile(jarPath, "jar-bytes");
  await writeFile(sidecarPath, "{}");
  await writeFile(keptJarPath, "other-bytes");
  await writeFile(keptSidecarPath, "{}");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const deletion = await registry.deleteEntries({
    cacheKinds: ["downloads"],
    selector: { jarPath },
    executionMode: "apply"
  });

  assert.equal(deletion.deletedEntries, 1);
  assert.equal(existsSync(jarPath), false, "the jar is deleted");
  assert.equal(existsSync(sidecarPath), false, "a prune must not leave the sidecar orphaned");
  assert.equal(existsSync(keptJarPath), true, "an unselected jar stays");
  assert.equal(existsSync(keptSidecarPath), true, "an unselected jar keeps its sidecar");
});

test("cache registry ignores an orphan download sidecar whose jar is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-sidecar-orphan-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const orphanSidecarPath = downloadSidecarPath(join(root, "downloads", "vanished.jar"));
  await writeFile(orphanSidecarPath, "{}");
  await writeFile(join(root, "downloads", "neighbour.jar"), "neighbour");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const listed = await registry.listEntries({ cacheKinds: ["downloads"], limit: 10 });
  assert.deepEqual(
    listed.entries.map((entry) => entry.entryId),
    ["neighbour.jar"],
    "a sidecar without its jar describes nothing and must not surface as an entry"
  );

  const summary = await registry.summarize({ cacheKinds: ["downloads"] });
  assert.equal(summary.kinds.downloads?.entryCount, 1);
  assert.equal(
    summary.kinds.downloads?.totalBytes,
    "neighbour".length,
    // This is the other half of the rule the fold test states: the orphan's
    // bytes are deliberately unaccounted. Entry membership wins over disk
    // occupancy - a total is what the listed entries weigh, not what `du`
    // reports - because there is no entry these bytes could belong to.
    "an orphan sidecar belongs to no entry, so its bytes are not in the total"
  );
  assert.equal(
    existsSync(orphanSidecarPath),
    true,
    "inventory is read-only: listing must never delete files"
  );
});

test("cache registry still inventories a `.cache.json` file outside the downloads root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-sidecar-scope-"));
  await mkdir(join(root, "mappings"), { recursive: true });
  const mappingPath = join(root, "mappings", "mojang-1.21.10.tiny.cache.json");
  await writeFile(mappingPath, "{}");

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const listed = await registry.listEntries({ cacheKinds: ["mapping"], limit: 10 });
  assert.deepEqual(
    listed.entries.map((entry) => entry.entryId),
    ["mojang-1.21.10.tiny.cache.json"],
    "the sidecar rule is scoped to the downloads kind; other kinds keep every file"
  );
});

test("cache registry ignores the leftover of an interrupted download sidecar write", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-registry-sidecar-tmp-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  const jarPath = join(root, "downloads", "client.jar");
  await writeFile(jarPath, "jar-bytes");
  // A process killed inside the sidecar's temp-file-plus-rename leaves this
  // behind. It is a half-written description of `client.jar`, so it must be
  // filtered for exactly the reason the finished sidecar is: listing it would
  // report a downloads entry whose jarPath is a JSON temp, and hand a jarPath
  // selector a description to delete instead of the thing described.
  const interruptedWritePath = `${downloadSidecarPath(jarPath)}.1a2b3c4d.tmp`;
  await writeFile(interruptedWritePath, '{"version":1,"url":"https://exam');

  const registry = createCacheRegistry({
    cacheDir: root,
    sqlitePath: join(root, "source-cache.db")
  });

  const listed = await registry.listEntries({ cacheKinds: ["downloads"], limit: 10 });
  assert.deepEqual(
    listed.entries.map((entry) => entry.entryId),
    ["client.jar"],
    "an interrupted sidecar write is not a cached artifact"
  );
  assert.equal(listed.entries[0]?.meta?.jarPath, jarPath);
  assert.equal(
    existsSync(interruptedWritePath),
    true,
    "inventory is read-only: listing must never delete files"
  );
});
