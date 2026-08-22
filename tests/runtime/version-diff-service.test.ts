import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { RegistryData } from "../../src/registry-service.ts";
import { VersionDiffService } from "../../src/version-diff-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

function createRegistryData(entries: string[]): RegistryData {
  return {
    entries: Object.fromEntries(
      entries.map((entry, index) => [entry, { protocol_id: index }])
    )
  };
}

test("compareVersions throws when registry-only comparison fails", async () => {
  const service = new VersionDiffService(
    buildTestConfig("/tmp"),
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
  const service = new VersionDiffService(buildTestConfig("/tmp"), {} as any, {} as any);

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
    unchanged: 1,
    // Packaged class names are already real names; no mapping load happens.
    namespace: "mojang",
    packageFilter: {
      value: "com.example",
      namespace: "mojang",
      matchedFrom: 3,
      matchedTo: 3
    }
  });
  assert.deepEqual(result.warnings, [
    "Class additions truncated: showing 1 of 2. Use packageFilter to narrow results.",
    "Class removals truncated: showing 1 of 2. Use packageFilter to narrow results."
  ]);
});

test("compareVersions warns when maxClassResults is clamped above 5000", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-diff-maxclass-clamp-"));
  const fromJar = join(root, "from.jar");
  const toJar = join(root, "to.jar");
  await createJar(fromJar, { "com/example/Alpha.class": "" });
  await createJar(toJar, { "com/example/Beta.class": "" });

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
    maxClassResults: 100000
  });

  assert.ok(
    result.warnings.some((w: string) => /maxClassResults was clamped to 5000 from 100000\./.test(w)),
    "expected a maxClassResults clamp warning"
  );
});

test("compareVersions summarizes registry additions, removals, and registry creation/removal", async () => {
  const service = new VersionDiffService(
    buildTestConfig("/tmp"),
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
    unchanged: 0,
    namespace: "mojang"
  });
  assert.equal(result.registry, undefined);
  assert.deepEqual(result.warnings, ["Registry comparison failed: boom"]);
});

// ---------------------------------------------------------------------------
// Namespace agreement between the diff and packageFilter.
//
// Regression: a vanilla client jar for an obfuscated release lists `dlp.class`,
// not `net/minecraft/world/item/Item.class`. compareVersions diffed those raw
// entries, so `packageFilter: "net.minecraft.world.item"` matched nothing and
// returned `unchanged: 0` with no signal at all — indistinguishable from
// "nothing changed".
// ---------------------------------------------------------------------------

const MOJANG_TINY_FROM = [
  "tiny\t2\t0\tobfuscated\tmojang",
  "c\tdlp\tnet/minecraft/world/item/Item",
  "c\tdlq\tnet/minecraft/world/item/BlockItem",
  "c\tcom/mojang/blaze3d/systems/GpuBuffer\tcom/mojang/blaze3d/systems/GpuBuffer",
  ""
].join("\n");

const MOJANG_TINY_TO = [
  "tiny\t2\t0\tobfuscated\tmojang",
  "c\tdlp\tnet/minecraft/world/item/Item",
  "c\tdlq\tnet/minecraft/world/item/BlockItem",
  "c\tije\tnet/minecraft/world/item/PotionItem",
  "c\tcom/mojang/blaze3d/systems/GpuBuffer\tcom/mojang/blaze3d/systems/GpuBuffer",
  ""
].join("\n");

/**
 * Builds a service over two OBFUSCATED-shaped jars (default-package short
 * names) whose merged mojang tiny files are pre-seeded into the cache, so
 * resolveMojangTinyFile short-circuits on the cached path without any network.
 */
async function buildObfuscatedDiffService(): Promise<{
  service: VersionDiffService;
  root: string;
}> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "version-diff-namespace-"));
  const fromJar = join(root, "from.jar");
  const toJar = join(root, "to.jar");

  await createJar(fromJar, {
    "dlp.class": "",
    "dlq.class": "",
    "com/mojang/blaze3d/systems/GpuBuffer.class": ""
  });
  await createJar(toJar, {
    "dlp.class": "",
    "dlq.class": "",
    "ije.class": "",
    "com/mojang/blaze3d/systems/GpuBuffer.class": ""
  });

  const config = buildTestConfig(root);
  await mkdir(join(config.cacheDir, "mappings"), { recursive: true });
  await writeFile(join(config.cacheDir, "mappings", "1.21.10-mojang-merged.tiny"), MOJANG_TINY_FROM, "utf8");
  await writeFile(join(config.cacheDir, "mappings", "1.21.11-mojang-merged.tiny"), MOJANG_TINY_TO, "utf8");

  const service = new VersionDiffService(
    config,
    {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: version === "1.21.10" ? fromJar : toJar,
          source: "downloaded",
          clientJarUrl: "https://example.invalid/client.jar"
        };
      }
    } as any,
    {} as any
  );
  return { service, root };
}

test("compareVersions reports obfuscated jar classes in mojang names", async () => {
  const { service } = await buildObfuscatedDiffService();

  const result = await service.compareVersions({
    fromVersion: "1.21.10",
    toVersion: "1.21.11",
    category: "classes"
  });

  assert.equal(result.classes?.namespace, "mojang");
  // Pre-fix this was ["ije"] — an obfuscated name handed to the caller.
  assert.deepEqual(result.classes?.added, ["net.minecraft.world.item.PotionItem"]);
  assert.equal(result.classes?.unchanged, 3);
});

test("compareVersions packageFilter matches the namespace the diff runs in", async () => {
  const { service } = await buildObfuscatedDiffService();

  const result = await service.compareVersions({
    fromVersion: "1.21.10",
    toVersion: "1.21.11",
    category: "classes",
    packageFilter: "net.minecraft.world.item"
  });

  // Pre-fix: addedCount 0, unchanged 0 — a silent all-zero diff.
  assert.equal(result.classes?.addedCount, 1);
  assert.equal(result.classes?.unchanged, 2);
  assert.deepEqual(result.classes?.packageFilter, {
    value: "net.minecraft.world.item",
    namespace: "mojang",
    matchedFrom: 2,
    matchedTo: 3
  });
});

test("compareVersions says so when packageFilter matches nothing instead of reporting zeros", async () => {
  const { service } = await buildObfuscatedDiffService();

  const result = await service.compareVersions({
    fromVersion: "1.21.10",
    toVersion: "1.21.11",
    category: "classes",
    packageFilter: "com.example.definitely.nothing"
  });

  assert.equal(result.classes?.addedCount, 0);
  assert.equal(result.classes?.unchanged, 0);
  assert.deepEqual(result.classes?.packageFilter, {
    value: "com.example.definitely.nothing",
    namespace: "mojang",
    matchedFrom: 0,
    matchedTo: 0
  });
  assert.ok(
    result.warnings.some(
      (warning) => warning.includes("matched no class") && warning.includes('not "nothing changed"')
    ),
    `expected an explicit non-match warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("compareVersions degrades to the obfuscated namespace with a warning when mappings are unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-diff-nomap-"));
  const fromJar = join(root, "from.jar");
  const toJar = join(root, "to.jar");
  await createJar(fromJar, { "dlp.class": "", "dlq.class": "" });
  await createJar(toJar, { "dlp.class": "", "ije.class": "" });

  const service = new VersionDiffService(
    buildTestConfig(root),
    {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: version === "1.21.10" ? fromJar : toJar,
          source: "downloaded",
          clientJarUrl: "https://example.invalid/client.jar"
        };
      },
      async resolveVersionMappings() {
        throw new Error("offline");
      }
    } as any,
    {} as any
  );

  const result = await service.compareVersions({
    fromVersion: "1.21.10",
    toVersion: "1.21.11",
    category: "classes",
    packageFilter: "net.minecraft.world.item"
  });

  assert.equal(result.classes?.namespace, "obfuscated");
  assert.ok(
    result.warnings.some((warning) => warning.includes("OBFUSCATED namespace")),
    `expected a namespace-degradation warning, got: ${JSON.stringify(result.warnings)}`
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("matched no class")),
    `expected an explicit non-match warning, got: ${JSON.stringify(result.warnings)}`
  );
});
