import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import type { RegistryData } from "../src/registry-service.ts";
import type { Config } from "../src/types.ts";
import { VersionDiffService } from "../src/version-diff-service.ts";
import { createJar } from "./helpers/zip.ts";

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

function createRegistryData(entries: string[]): RegistryData {
  return {
    entries: Object.fromEntries(
      entries.map((entry, index) => [entry, { protocol_id: index }])
    )
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

test("compareVersions rejects blank version inputs", async () => {
  const service = new VersionDiffService(buildTestConfig(), {} as any, {} as any);

  await assert.rejects(
    () =>
      service.compareVersions({
        fromVersion: "  ",
        toVersion: "1.21.1"
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.INVALID_INPUT);
      return true;
    }
  );
});

test("compareVersions filters class diffs, ignores nested classes, and warns on truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-diff-classes-"));
  const fromJar = join(root, "from.jar");
  const toJar = join(root, "to.jar");

  await createJar(fromJar, {
    "com/example/Alpha.class": "",
    "com/example/Removed.class": "",
    "com/example/Shared.class": "",
    "com/example/Removed$Inner.class": "",
    "META-INF/versions/9/com/example/Ignored.class": "",
    "org/other/Outside.class": ""
  });
  await createJar(toJar, {
    "com/example/Added.class": "",
    "com/example/Beta.class": "",
    "com/example/Shared.class": "",
    "com/example/Added$Inner.class": "",
    "META-INF/MANIFEST.MF": "",
    "org/other/Outside.class": ""
  });

  const service = new VersionDiffService(
    buildTestConfig(root),
    {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: version === "1.20.4" ? fromJar : toJar,
          source: "downloaded",
          clientJarUrl: "https://example.invalid/client.jar"
        };
      }
    } as any,
    {} as any
  );

  const result = await service.compareVersions({
    fromVersion: "1.20.4",
    toVersion: "1.21.1",
    category: "classes",
    packageFilter: "com.example",
    maxClassResults: 1
  });

  assert.deepEqual(result.classes, {
    added: ["com.example.Added"],
    removed: ["com.example.Alpha"],
    addedCount: 2,
    removedCount: 2,
    unchanged: 1
  });
  assert.deepEqual(result.warnings, [
    "Class additions truncated: showing 1 of 2. Use packageFilter to narrow results.",
    "Class removals truncated: showing 1 of 2. Use packageFilter to narrow results."
  ]);
});

test("compareVersions summarizes registry additions, removals, and registry creation/removal", async () => {
  const service = new VersionDiffService(
    buildTestConfig(),
    {} as any,
    {
      async getRegistryData({ version }: { version: string }) {
        if (version === "1.20.4") {
          return {
            data: {
              "minecraft:item": createRegistryData(["minecraft:apple", "minecraft:stick"]),
              "minecraft:block": createRegistryData(["minecraft:stone"])
            }
          };
        }

        return {
          data: {
            "minecraft:item": createRegistryData(["minecraft:stick", "minecraft:carrot"]),
            "minecraft:biome": createRegistryData(["minecraft:plains"])
          }
        };
      }
    } as any
  );

  const result = await service.compareVersions({
    fromVersion: "1.20.4",
    toVersion: "1.21.1",
    category: "registry"
  });

  assert.deepEqual(result.registry, {
    added: {
      "minecraft:item": ["minecraft:carrot"],
      "minecraft:biome": ["minecraft:plains"]
    },
    removed: {
      "minecraft:item": ["minecraft:apple"],
      "minecraft:block": ["minecraft:stone"]
    },
    newRegistries: ["minecraft:biome"],
    removedRegistries: ["minecraft:block"],
    summary: {
      registriesChanged: 3,
      totalAdded: 2,
      totalRemoved: 2
    }
  });
  assert.deepEqual(result.warnings, []);
});

test("compareVersions keeps class results when registry comparison fails in all mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-diff-all-"));
  const fromJar = join(root, "from.jar");
  const toJar = join(root, "to.jar");

  await createJar(fromJar, {
    "com/example/Alpha.class": ""
  });
  await createJar(toJar, {
    "com/example/Beta.class": ""
  });

  const service = new VersionDiffService(
    buildTestConfig(root),
    {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: version === "1.20.4" ? fromJar : toJar,
          source: "downloaded",
          clientJarUrl: "https://example.invalid/client.jar"
        };
      }
    } as any,
    {
      async getRegistryData() {
        throw new Error("boom");
      }
    } as any
  );

  const result = await service.compareVersions({
    fromVersion: "1.20.4",
    toVersion: "1.21.1",
    category: "all"
  });

  assert.deepEqual(result.classes, {
    added: ["com.example.Beta"],
    removed: ["com.example.Alpha"],
    addedCount: 1,
    removedCount: 1,
    unchanged: 0
  });
  assert.equal(result.registry, undefined);
  assert.deepEqual(result.warnings, ["Registry comparison failed: boom"]);
});
