import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { listIntegrityCheckRequestFiles } from "../../src/storage/db.ts";
import RawDatabase, { isRawSqliteCorruptionError } from "../../src/storage/sqlite.ts";

import { readSearchScanMetrics } from "../helpers/source-service-metrics.ts";
import { createResolvedSearchFixture } from "../helpers/source-service-search-fixtures.ts";

test("fallback ASCII contains uses the LIKE prefilter and stays case-insensitive", async () => {
  const sourceEntries = {
    "net/minecraft/a/Upper.java": "package net.minecraft.a;\npublic class Upper { String s = \"NEEDLETOKEN\"; }",
    "net/minecraft/a/Mixed.java": "package net.minecraft.a;\npublic class Mixed { String s = \"NeedleToken\"; }",
    "net/minecraft/a/Lower.java": "package net.minecraft.a;\npublic class Lower { String s = \"needletoken\"; }"
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-like-prefilter-",
    jarBaseName: "server-like-prefilter",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needletoken",
    intent: "text",
    match: "contains",
    limit: 10
  });

  const hitPaths = new Set(result.hits.map((hit) => hit.filePath));
  assert.ok(hitPaths.has("net/minecraft/a/Upper.java"));
  assert.ok(hitPaths.has("net/minecraft/a/Mixed.java"));
  assert.ok(hitPaths.has("net/minecraft/a/Lower.java"));
  // The ASCII non-regex fallback must route through the LIKE prefilter exactly once.
  assert.equal(readSearchScanMetrics(service).likePrefilter, 1);
});

test("fallback ASCII exact match stays case-sensitive through the LIKE prefilter", async () => {
  const sourceEntries = {
    "net/minecraft/a/Upper.java": "package net.minecraft.a;\npublic class Upper { String s = \"NEEDLETOKEN\"; }",
    "net/minecraft/a/Mixed.java": "package net.minecraft.a;\npublic class Mixed { String s = \"NeedleToken\"; }",
    "net/minecraft/a/Lower.java": "package net.minecraft.a;\npublic class Lower { String s = \"needletoken\"; }"
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-like-exact-",
    jarBaseName: "server-like-exact",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "NeedleToken",
    intent: "text",
    match: "exact",
    limit: 10
  });

  // Exact content match is case-sensitive (content.indexOf): only the exactly-cased file.
  const hitPaths = result.hits.map((hit) => hit.filePath);
  assert.deepEqual(hitPaths, ["net/minecraft/a/Mixed.java"]);
  assert.equal(readSearchScanMetrics(service).likePrefilter, 1);
});

test("fallback text scan early-aborts at the byte budget with a truncation warning", async () => {
  const body = "x".repeat(60);
  const sourceEntries = {
    "net/minecraft/a/One.java": `package net.minecraft.a;\n// budgettoken ${body}`,
    "net/minecraft/a/Two.java": `package net.minecraft.a;\n// budgettoken ${body}`,
    "net/minecraft/a/Three.java": `package net.minecraft.a;\n// budgettoken ${body}`
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-budget-",
    jarBaseName: "server-budget",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false, searchScanMaxBytes: 40 }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "budgettoken",
    intent: "text",
    match: "contains",
    limit: 10
  });

  assert.ok(result.warnings && result.warnings.some((w) => /scan budget/.test(w) && /incomplete/.test(w)));
  assert.equal(readSearchScanMetrics(service).scanTruncated, 1);
});

test("fallback regex text search never takes the LIKE prefilter branch", async () => {
  const sourceEntries = {
    "net/minecraft/a/Regex.java": "package net.minecraft.a;\npublic class Regex { int n = needle42; }"
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-regex-noprefilter-",
    jarBaseName: "server-regex-noprefilter",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needle[0-9]+",
    intent: "text",
    match: "regex",
    limit: 10
  });

  assert.ok(result.hits.some((hit) => hit.filePath === "net/minecraft/a/Regex.java"));
  // Regex always scans; it must NOT use the LIKE prefilter.
  assert.equal(readSearchScanMetrics(service).likePrefilter, 0);
});

test("fallback non-ASCII needle skips the LIKE prefilter and stays correct", async () => {
  const sourceEntries = {
    "net/minecraft/a/UpperAccent.java": "package net.minecraft.a;\npublic class UpperAccent { String s = \"CAFÉ\"; }",
    "net/minecraft/a/LowerAccent.java": "package net.minecraft.a;\npublic class LowerAccent { String s = \"café\"; }"
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-nonascii-",
    jarBaseName: "server-nonascii",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "café",
    intent: "text",
    match: "contains",
    limit: 10
  });

  // JS toLocaleLowerCase folds the accented uppercase form; SQLite LIKE would NOT,
  // so a non-ASCII needle must use the full scan (no LIKE prefilter) to stay correct.
  const hitPaths = new Set(result.hits.map((hit) => hit.filePath));
  assert.ok(hitPaths.has("net/minecraft/a/UpperAccent.java"));
  assert.ok(hitPaths.has("net/minecraft/a/LowerAccent.java"));
  assert.equal(readSearchScanMetrics(service).likePrefilter, 0);
});

test("fallback ASCII search recovers high-score matches beyond the LIKE candidate cap", async () => {
  // 501 files match the needle; the LIKE prefilter caps candidates at 500 (prefix/exact)
  // ordered by file_path ASC, so the late-sorting zzz/High.java is excluded from the cap.
  // But High.java has the needle at index 0 (highest score), so the old exhaustive scan
  // would rank it #1. The fast path must detect the cap overflow and fall through to the
  // exhaustive scan instead of silently dropping it.
  const padding = "x".repeat(220);
  const sourceEntries: Record<string, string> = {};
  for (let i = 1; i <= 500; i += 1) {
    const n = String(i).padStart(4, "0");
    // needle appears LATE -> low score
    sourceEntries[`aaa/Low${n}.java`] = `// ${padding} needletoken`;
  }
  // needle at index 0 -> highest score; path sorts last so the cap would drop it
  sourceEntries["zzz/High.java"] = `needletoken ${padding}`;

  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-overflow-",
    jarBaseName: "server-overflow",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needletoken",
    intent: "text",
    match: "prefix",
    queryMode: "literal",
    limit: 1
  });

  assert.equal(result.hits[0]?.filePath, "zzz/High.java");
});

test("fallback byte budget counts UTF-8 bytes, not UTF-16 code units", async () => {
  // Each file is 50 multibyte chars = 50 UTF-16 units but 150 UTF-8 bytes. With a 200-byte
  // budget, a byte-accurate budget truncates at the 3rd file (>=200 after 2x150); a
  // char-length budget (50 each) would never reach 200 across 3 files and never truncate.
  const body = "あ".repeat(50);
  const sourceEntries = {
    "a/F1.java": body,
    "a/F2.java": body,
    "a/F3.java": body
  };
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-search-budget-bytes-",
    jarBaseName: "server-budget-bytes",
    sourceEntries,
    configOverrides: { indexedSearchEnabled: false, searchScanMaxBytes: 200 }
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "あ",
    intent: "text",
    match: "contains",
    queryMode: "literal",
    limit: 10
  });

  assert.ok(result.warnings && result.warnings.some((w) => /scan budget/.test(w)));
  assert.equal(readSearchScanMetrics(service).scanTruncated, 1);
});

// A damaged full-text index makes the indexed query throw a raw SQLite
// corruption error. Every page of the FTS5 data table is overwritten in the
// database file, which is how a damaged index looks to the next query. Modes
// that have a full-scan fallback must keep answering from the `files` table; a
// token-only search has no fallback, so it must fail instead of returning an
// empty page that looks like "no matches".
async function createFixtureWithDamagedFullTextIndex(rootPrefix: string) {
  const fixture = await createResolvedSearchFixture({
    rootPrefix,
    jarBaseName: "server-damaged-fts",
    sourceEntries: {
      "net/minecraft/a/Needle.java": "package net.minecraft.a;\npublic class Needle { String s = \"damagedindextoken\"; }"
    }
  });
  const { sqlitePath } = (fixture.service as unknown as { config: { sqlitePath: string } }).config;

  const inspector = new RawDatabase(sqlitePath);
  let pageSize: number;
  let pageNumbers: number[];
  try {
    pageSize = (inspector.pragma("page_size") as Array<{ page_size: number }>)[0]!.page_size;
    pageNumbers = (
      inspector.prepare("SELECT pageno FROM dbstat WHERE name = 'files_fts_data'").all() as Array<{ pageno: number }>
    ).map((row) => row.pageno);
    inspector.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    inspector.close();
  }
  assert.ok(pageNumbers.length > 0, "expected the FTS5 data table to own at least one page");

  const bytes = Buffer.from(await readFile(sqlitePath));
  for (const pageNumber of pageNumbers) {
    bytes.fill(0xff, (pageNumber - 1) * pageSize, pageNumber * pageSize);
  }
  await writeFile(sqlitePath, bytes);
  return { ...fixture, sqlitePath };
}

test("token-mode text search fails with a raw corruption error when the full-text index is damaged, instead of returning no hits", async () => {
  const { service, resolved } = await createFixtureWithDamagedFullTextIndex("service-search-damaged-fts-token-");

  await assert.rejects(
    () =>
      service.searchClassSource({
        artifactId: resolved.artifactId,
        query: "damagedindextoken",
        intent: "text",
        match: "contains",
        queryMode: "token",
        limit: 10
      }),
    (error) => {
      assert.equal(isRawSqliteCorruptionError(error), true, `unexpected error: ${String(error)}`);
      return true;
    }
  );
});

test("auto-mode text search still returns the full-scan hits when the full-text index is damaged", async () => {
  const { service, resolved, sqlitePath } = await createFixtureWithDamagedFullTextIndex("service-search-damaged-fts-auto-");

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "damagedindextoken",
    intent: "text",
    match: "contains",
    queryMode: "auto",
    limit: 10
  });

  assert.deepEqual(
    result.hits.map((hit) => hit.filePath),
    ["net/minecraft/a/Needle.java"]
  );
  // The indexed query really did hit the damage (the runtime observer asked for
  // a full check on the next start); the hits above came from the full scan.
  assert.equal(listIntegrityCheckRequestFiles(sqlitePath).length, 1);
});
