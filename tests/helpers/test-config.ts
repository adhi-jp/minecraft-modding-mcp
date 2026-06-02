import { join } from "node:path";

import type { Config } from "../../src/types.ts";

/**
 * Base test config with safe defaults for all fields.
 * fetch disabled (retries=0, timeout=1s), small caches, no external tools.
 */
function baseTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
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
    searchScanMaxBytes: 67_108_864,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    tinyRemapperJarPath: undefined,
    remapTimeoutMs: 600_000,
    remapMaxMemoryMb: 4_096,
  };
}

/** General-purpose test config. Override specific fields as needed. */
export function buildTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return { ...baseTestConfig(root), ...overrides };
}

/** Mapping-oriented test config (Fabric repo, small graph cache). */
export function buildMappingTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return buildTestConfig(root, {
    sourceRepos: ["https://maven.fabricmc.net"],
    maxMappingGraphCache: 1,
    ...overrides,
  });
}
