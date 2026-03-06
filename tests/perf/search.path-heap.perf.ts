import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../../src/types.ts";
import { createJar } from "../helpers/zip.ts";

function buildTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: ":memory:",
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    maxContentBytes: 10_000_000,
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

async function createLargePathSearchJar(root: string): Promise<string> {
  const binaryJarPath = join(root, "path-heap.jar");
  const sourcesJarPath = join(root, "path-heap-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourceEntries: Record<string, string> = {};
  for (let index = 0; index < 120; index += 1) {
    const filler = Array.from({ length: 4_000 }, () => `  // ${"x".repeat(180)}`).join("\n");
    sourceEntries[`net/minecraft/generated/NeedlePath${index}.java`] = [
      "package net.minecraft.generated;",
      `public class NeedlePath${index} {`,
      filler,
      "}"
    ].join("\n");
  }

  await createJar(sourcesJarPath, sourceEntries);
  return binaryJarPath;
}

test("path-intent indexed search keeps heap growth bounded for large files", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "path-heap-perf-"));
  const binaryJarPath = await createLargePathSearchJar(root);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const request = {
    artifactId: resolved.artifactId,
    query: "NeedlePath",
    intent: "path" as const,
    match: "contains" as const,
    limit: 120
  };

  for (let i = 0; i < 2; i += 1) {
    const warm = await service.searchClassSource(request);
    assert.equal(warm.hits.length, 120);
  }

  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  for (let i = 0; i < 5; i += 1) {
    const result = await service.searchClassSource(request);
    assert.equal(result.hits.length, 120);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }

  const heapDeltaBytes = Math.max(0, Math.trunc(heapPeak - heapStart));
  console.info(JSON.stringify({ event: "perf.search.path_heap", heapDeltaBytes }));

  assert.ok(
    heapDeltaBytes <= 150 * 1024 * 1024,
    `Expected path-intent heap delta <= 150 MiB, got ${heapDeltaBytes} bytes`
  );
});
