import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { VersionDiffService } from "../src/version-diff-service.ts";

function buildTestConfig(root = "/tmp"): Config {
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
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

test("compareVersions throws when registry-only comparison fails", async () => {
  const service = new VersionDiffService(
    buildTestConfig(),
    {} as any,
    {
      async getRegistryData() {
        throw createError({
          code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
          message: "registry generation failed"
        });
      }
    } as any
  );

  await assert.rejects(
    () =>
      service.compareVersions({
        fromVersion: "1.20.4",
        toVersion: "1.21.1",
        category: "registry"
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.REGISTRY_GENERATION_FAILED);
      return true;
    }
  );
});
