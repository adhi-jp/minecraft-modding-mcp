import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../../src/types.ts";
import { createJar } from "../helpers/zip.ts";

const DATASET_FILE_COUNT = 2_000;

function buildTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: ":memory:",
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

function readSearchIoMetrics(service: { getRuntimeMetrics: () => unknown }): {
  dbRoundtrips: number;
  rowsScanned: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    dbRoundtrips:
      typeof snapshot.search_db_roundtrips === "number" ? snapshot.search_db_roundtrips : 0,
    rowsScanned:
      typeof snapshot.search_rows_scanned === "number" ? snapshot.search_rows_scanned : 0
  };
}

test("separator-query token mode stays on indexed path and avoids full scan I/O", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "search-separator-perf-"));
  const binaryJarPath = join(root, "separator-perf.jar");
  const sourcesJarPath = join(root, "separator-perf-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourceEntries: Record<string, string> = {};
  for (let index = 0; index < DATASET_FILE_COUNT; index += 1) {
    const filePath = `net/minecraft/generated/Perf${index}.java`;
    sourceEntries[filePath] = [
      "package net.minecraft.generated;",
      `public class Perf${index} {`,
      index === 1_234
        ? "  void register() { dispatcher.register(literal(\"test\")); }"
        : `  void noop${index}() {}`,
      "}"
    ].join("\n");
  }

  await createJar(sourcesJarPath, sourceEntries);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const request = {
    artifactId: resolved.artifactId,
    query: "dispatcher.register",
    intent: "text" as const,
    match: "contains" as const,
    limit: 50
  };

  const beforeToken = readSearchIoMetrics(service);
  const tokenResult = await service.searchClassSource({
    ...request,
    queryMode: "token"
  });
  const afterToken = readSearchIoMetrics(service);

  const beforeLiteral = readSearchIoMetrics(service);
  const literalResult = await service.searchClassSource({
    ...request,
    queryMode: "literal"
  });
  const afterLiteral = readSearchIoMetrics(service);

  const tokenRowsScanned = afterToken.rowsScanned - beforeToken.rowsScanned;
  const tokenDbRoundtrips = afterToken.dbRoundtrips - beforeToken.dbRoundtrips;
  const literalRowsScanned = afterLiteral.rowsScanned - beforeLiteral.rowsScanned;

  assert.ok(tokenResult.hits.length > 0);
  assert.ok(literalResult.hits.length > 0);
  assert.ok(tokenRowsScanned < literalRowsScanned, `${tokenRowsScanned} should be < ${literalRowsScanned}`);
  assert.ok(tokenDbRoundtrips < 4, `${tokenDbRoundtrips} should stay in the indexed path`);
  assert.ok(literalRowsScanned >= DATASET_FILE_COUNT, `${literalRowsScanned} should reflect a scan over the dataset`);
});
