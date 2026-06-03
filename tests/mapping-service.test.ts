import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import fastGlob from "fast-glob";

import { ERROR_CODES } from "../src/errors.ts";
import type { MappingService as MappingServiceType } from "../src/mapping-service.ts";
import type { SourceMapping } from "../src/types.ts";
import { withGradleUserHome } from "./helpers/env.ts";
import { buildMappingTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

// Isolate all tests from the host's real ~/.gradle to avoid scanning
// large real Loom caches (which can cause OOM in the single-process runner).
let savedGradleUserHome: string | undefined;
before(() => {
  savedGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = join(tmpdir(), "mapping-service-test-gradle-home-nonexistent");
});
after(() => {
  if (savedGradleUserHome === undefined) {
    delete process.env.GRADLE_USER_HOME;
  } else {
    process.env.GRADLE_USER_HOME = savedGradleUserHome;
  }
});

const buildTestConfig = buildMappingTestConfig;

async function withCwd<T>(nextCwd: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(nextCwd);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

const TEST_MOJANG_CLIENT_MAPPINGS = [
  "com.mojang.NamedClass -> a.b.C:",
  "    int namedField -> d",
  "    void namedMethod(int) -> e",
  "    4:4:void overloaded(int) -> f",
  "    8:8:void overloaded(java.lang.String) -> f"
].join("\n");

const TEST_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

const TEST_TINY_ALT = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/AltNamedClass"
].join("\n");

const TEST_TINY_OFFICIAL = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

const TEST_AMBIGUOUS_METHOD_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\te\tinterMethodAlt\tnamedMethod"
].join("\n");

const TEST_AMBIGUOUS_CLASS_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/one/C\tyarn/one/C",
  "c\ta/b/C\tinter/two/C\tyarn/two/C"
].join("\n");

const TEST_DESCRIPTOR_REMAP_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2338\tnet/minecraft/class_2338\tnet/minecraft/core/BlockPos",
  "c\tnet/minecraft/class_2680\tnet/minecraft/class_2680\tnet/minecraft/world/level/block/state/BlockState",
  "c\tnet/minecraft/class_1937\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z\tmethod_1725\tmethod_1725\tsetBlock"
].join("\n");

// Fixture where the method descriptor mixes a remapped Minecraft class and an unmapped
// JDK class (java/lang/String). The projection graph has no entry for java/lang/String,
// so projectMethodDescriptorToTarget leaves it unchanged and marks the projection
// incomplete. checkSymbolExists must still accept the partial projection and match the
// record, otherwise the most common "MC class + String name" overload shape fails lookup.
const TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_1792\tnet/minecraft/class_1792\tnet/minecraft/world/item/Item",
  "c\tnet/minecraft/class_1799\tnet/minecraft/class_1799\tnet/minecraft/world/item/ItemStack",
  "\tm\t(Lnet/minecraft/class_1799;Ljava/lang/String;)V\tmethod_9000\tmethod_9000\ttagWithLabel"
].join("\n");

const TEST_DESCRIPTOR_REMAP_TINY_PROJECT = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2338\tnet/minecraft/class_2338\tnet/minecraft/core/BlockPos",
  "c\tnet/minecraft/class_1937\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z\tmethod_1725\tmethod_1725\tsetBlock"
].join("\n");

const TEST_DESCRIPTOR_REMAP_TINY_GRADLE_HOME = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2680\tnet/minecraft/class_2680\tnet/minecraft/world/level/block/state/BlockState"
].join("\n");

// Three distinct methods on one owner that ALL reference the same parameter class,
// so their descriptor class-projections are identical and can be shared graph-wide.
const TEST_SHARED_CLASS_REF_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/Owner\tinter/Owner\tnamed/Owner",
  "\tm\t(La/b/Shared;)V\tm1\tinterM1\talpha",
  "\tm\t(La/b/Shared;)V\tm2\tinterM2\tbeta",
  "\tm\t(La/b/Shared;)V\tm3\tinterM3\tgamma",
  "c\ta/b/Shared\tinter/Shared\tnamed/Shared"
].join("\n");

// A standalone Fabric yarn tiny declares only `intermediary named` (no obfuscated
// column), so the stored method descriptor is in INTERMEDIARY coordinates.
const TEST_TINY_YARN_2COL = [
  "tiny\t2\t0\tintermediary\tnamed",
  "c\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_1937;)V\tmethod_x\tdoThing"
].join("\n");

function createVersionServiceStub(mappingsUrl?: string) {
  return {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: `https://example.test/versions/${version}.json`,
        mappingsUrl
      };
    }
  };
}

async function writeLoomTinyCache(root: string, tiny: string, version = "1.21.10"): Promise<string> {
  const loomTinyPath = join(root, ".gradle", "loom-cache", version, "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", version), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");
  return loomTinyPath;
}

async function writeFabricLoomTinyCache(
  gradleUserHome: string,
  tiny: string,
  version = "1.21.10",
  fileName = "mappings.tiny"
): Promise<string> {
  const loomTinyPath = join(gradleUserHome, "caches", "fabric-loom", version, fileName);
  await mkdir(join(gradleUserHome, "caches", "fabric-loom", version), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");
  return loomTinyPath;
}

async function createLoomService(
  prefix: string,
  tiny: string
): Promise<{ root: string; service: MappingServiceType }> {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const config = buildTestConfig(root, { sourceRepos: [] });
  await writeLoomTinyCache(root, tiny);
  return {
    root,
    service: new MappingService(config, createVersionServiceStub(), globalThis.fetch)
  };
}

type SymbolQueryInput = {
  kind: "class" | "field" | "method";
  name: string;
  owner?: string;
  descriptor?: string;
};

function queryFromSymbol(symbol: string): SymbolQueryInput {
  const trimmed = symbol.trim();
  const normalized = trimmed.replace(/\//g, ".");
  const descriptorStart = normalized.indexOf("(");
  if (descriptorStart >= 0) {
    const ownerAndName = normalized.slice(0, descriptorStart);
    const dotIndex = ownerAndName.lastIndexOf(".");
    return {
      kind: "method",
      owner: ownerAndName.slice(0, dotIndex),
      name: ownerAndName.slice(dotIndex + 1),
      descriptor: normalized.slice(descriptorStart)
    };
  }

  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) {
    return {
      kind: "class",
      name: normalized
    };
  }
  const owner = normalized.slice(0, dotIndex);
  const name = normalized.slice(dotIndex + 1);
  if (/^[A-Z$]/.test(name)) {
    return {
      kind: "class",
      name: normalized
    };
  }
  return {
    kind: "field",
    owner,
    name
  };
}

test("MappingService releaseGraphCacheEntry evicts all mode/projectPath variants for a version", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-release-cache-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const service = new MappingService(
      config,
      createVersionServiceStub("https://example.test/mappings/client.txt"),
      fetchStub
    );

    // Populate the graph cache with a lookup
    await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    const graphCache = (service as any).graphCache as Map<string, unknown>;
    const keysBefore = [...graphCache.keys()].filter((k: string) => k.startsWith("1.21.10|"));
    assert.ok(keysBefore.length > 0, "Graph cache should have entries for 1.21.10");

    // Evict
    service.releaseGraphCacheEntry("1.21.10");

    const keysAfter = [...graphCache.keys()].filter((k: string) => k.startsWith("1.21.10|"));
    assert.equal(keysAfter.length, 0, "All 1.21.10 entries should be evicted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService shares class-descriptor projections across members on one graph", async () => {
  const { root, service } = await createLoomService(
    "mapping-service-shared-projection-",
    TEST_SHARED_CLASS_REF_TINY
  );
  try {
    const resolveMethod = (name: string) =>
      withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.Owner",
          name,
          descriptor: "(La/b/Shared;)V",
          sourceMapping: "obfuscated",
          targetMapping: "yarn",
          signatureMode: "exact"
        })
      );

    // Warm the graph-scoped projection cache with the first member.
    const first = await resolveMethod("m1");
    assert.equal(first.resolved, true);

    // Distinct members sharing the same parameter class projection must reuse the
    // cached result, so resolving them triggers ZERO new class-projection computes.
    const before = service.classProjectionStats.computes;
    const second = await resolveMethod("m2");
    const third = await resolveMethod("m3");
    const after = service.classProjectionStats.computes;

    assert.equal(second.resolved, true);
    assert.equal(third.resolved, true);
    assert.equal(
      after - before,
      0,
      `members sharing a class ref must reuse the cached projection; saw ${after - before} new computes`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps obfuscated -> mojang and caches repeated lookups", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-mojang-"));
  try {
    const config = buildTestConfig(root);

    const fetchCalls: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const first = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(first.candidates[0]?.symbol, "com.mojang.NamedClass");
    assert.equal(first.mappingContext.sourceMapping, "obfuscated");
    assert.equal(first.mappingContext.targetMapping, "mojang");

    const second = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });
    assert.equal(second.candidates[0]?.symbol, "com.mojang.NamedClass");
    assert.equal(fetchCalls.filter((url) => url === "https://example.test/mappings/client.txt").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService skips tiny namespace loading for mojang <-> obfuscated lookups", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-mojang-obf-only-"));
  try {
    const config = buildTestConfig(root);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const service = new MappingService(config, createVersionServiceStub("https://example.test/mappings/client.txt"), fetchStub);

    let loomTinyLoads = 0;
    let mavenTinyLoads = 0;
    (service as unknown as {
      loadTinyPairsFromLoom: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
    }).loadTinyPairsFromLoom = async () => {
      loomTinyLoads += 1;
      return {
        pairs: new Map(),
        warnings: [],
        mappingArtifact: "loom-cache:none"
      };
    };
    (service as unknown as {
      loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
    }).loadTinyPairsFromMaven = async () => {
      mavenTinyLoads += 1;
      return {
        pairs: new Map(),
        warnings: [],
        mappingArtifact: "maven:none"
      };
    };

    const classResult = await service.findMapping({
      version: "1.21.10",
      kind: "class",
      name: "com.mojang.NamedClass",
      sourceMapping: "mojang",
      targetMapping: "obfuscated"
    });
    const methodResult = await service.resolveMethodMappingExact({
      version: "1.21.10",
      owner: "com.mojang.NamedClass",
      name: "namedMethod",
      descriptor: "(I)V",
      sourceMapping: "mojang",
      targetMapping: "obfuscated"
    });

    assert.equal(classResult.status, "resolved");
    assert.equal(classResult.resolvedSymbol?.symbol, "a.b.C");
    assert.equal(methodResult.status, "resolved");
    assert.equal(methodResult.resolvedSymbol?.symbol, "a.b.C.e(I)V");
    assert.equal(loomTinyLoads, 0);
    assert.equal(mavenTinyLoads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps obfuscated -> yarn from Loom tiny cache", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-loom-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.equal(result.candidates[0]?.symbol, "yarn.pkg.NamedClass");
    assert.equal(result.provenance?.source, "loom-cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService loads Loom tiny mappings from GRADLE_USER_HOME fabric-loom cache", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-gradle-home-"));
  try {
    const gradleUserHome = join(root, "gradle-home");
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeFabricLoomTinyCache(gradleUserHome, TEST_TINY);

    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
    const result = await withGradleUserHome(gradleUserHome, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.equal(result.resolved, true);
    assert.equal(result.candidates[0]?.symbol, "yarn.pkg.NamedClass");
    assert.equal(result.provenance?.source, "loom-cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService prefers explicit gradleUserHome over process GRADLE_USER_HOME", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-explicit-gradle-home-"));
  try {
    const defaultGradleUserHome = join(root, "default-gradle-home");
    const explicitGradleUserHome = join(root, "explicit-gradle-home");
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeFabricLoomTinyCache(defaultGradleUserHome, TEST_TINY_ALT);
    await writeFabricLoomTinyCache(explicitGradleUserHome, TEST_TINY);

    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
    const result = await withGradleUserHome(defaultGradleUserHome, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "yarn",
        gradleUserHome: explicitGradleUserHome
      } as any)
    );

    assert.equal(result.resolved, true);
    assert.equal(result.candidates[0]?.symbol, "yarn.pkg.NamedClass");
    assert.equal(result.provenance?.mappingArtifact.startsWith(explicitGradleUserHome), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService does not issue unbounded Loom tiny version globs", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-bounded-loom-glob-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = await writeLoomTinyCache(root, TEST_TINY);
    const gradleUserHome = join(root, "gradle-home");
    await mkdir(join(gradleUserHome, "caches", "fabric-loom"), { recursive: true });

    const unboundedCalls: Array<{ cwd: string | undefined; patterns: string[] }> = [];
    const projectVersionRoot = join(root, ".gradle", "loom-cache", "1.21.10");
    const originalGlob = fastGlob.glob;
    fastGlob.glob = async (patterns, options) => {
      const patternList = Array.isArray(patterns) ? patterns : [patterns];
      if (patternList.some((pattern) => pattern.startsWith("**/1.21.10/"))) {
        unboundedCalls.push({
          cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
          patterns: patternList
        });
        return [];
      }
      return options?.cwd === projectVersionRoot ? [loomTinyPath] : [];
    };

    try {
      const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
      const result = await withGradleUserHome(gradleUserHome, () =>
        withCwd(root, () =>
          service.findMapping({
            version: "1.21.10",
            ...queryFromSymbol("a.b.C"),
            sourceMapping: "obfuscated",
            targetMapping: "yarn"
          })
        )
      );

      assert.equal(result.resolved, true);
      assert.equal(unboundedCalls.length, 0);
    } finally {
      fastGlob.glob = originalGlob;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService merges Loom tiny mappings across project and GRADLE_USER_HOME roots", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-gradle-merge-"));
  try {
    const gradleUserHome = join(root, "gradle-home");
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeLoomTinyCache(root, TEST_DESCRIPTOR_REMAP_TINY_PROJECT);
    await writeFabricLoomTinyCache(gradleUserHome, TEST_DESCRIPTOR_REMAP_TINY_GRADLE_HOME, "1.21.10", "mappings-mojang.tiny");

    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
    const result = await withGradleUserHome(gradleUserHome, () =>
      withCwd(root, () =>
        service.resolveMethodMappingExact({
          version: "1.21.10",
          owner: "net.minecraft.class_1937",
          name: "method_1725",
          descriptor: "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z",
          sourceMapping: "intermediary",
          targetMapping: "yarn"
        })
      )
    );

    assert.equal(result.resolved, true);
    assert.equal(
      result.resolvedSymbol?.descriptor,
      "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService caches Loom graphs by effective cwd when projectPath is omitted", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const serviceRoot = await mkdtemp(join(tmpdir(), "mapping-service-cwd-cache-service-"));
  const projectRootA = await mkdtemp(join(tmpdir(), "mapping-service-cwd-cache-a-"));
  const projectRootB = await mkdtemp(join(tmpdir(), "mapping-service-cwd-cache-b-"));
  try {
    const gradleUserHome = join(serviceRoot, "gradle-home");
    const config = buildTestConfig(serviceRoot, { sourceRepos: [], maxMappingGraphCache: 2 });
    await writeLoomTinyCache(projectRootA, TEST_TINY);
    await writeLoomTinyCache(projectRootB, TEST_TINY_ALT);

    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
    const [first, second] = await withGradleUserHome(gradleUserHome, async () => [
      await withCwd(projectRootA, () =>
        service.findMapping({
          version: "1.21.10",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "yarn"
        })
      ),
      await withCwd(projectRootB, () =>
        service.findMapping({
          version: "1.21.10",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "yarn"
        })
      )
    ]);

    assert.equal(first.resolvedSymbol?.name, "yarn.pkg.NamedClass");
    assert.equal(second.resolvedSymbol?.name, "yarn.pkg.AltNamedClass");
  } finally {
    rmSync(serviceRoot, { recursive: true, force: true });
    rmSync(projectRootA, { recursive: true, force: true });
    rmSync(projectRootB, { recursive: true, force: true });
  }
});

test("MappingService falls back to Maven tiny when Loom cache is unavailable", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-fallback-"));
  try {
    const config = buildTestConfig(root);

    const tinyJarPath = join(root, "tiny.jar");
    await createJar(tinyJarPath, {
      "mappings/mappings.tiny": `${TEST_TINY}\n`
    });
    const tinyJarBuffer = await readFile(tinyJarPath);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        return new Response(
          [
            "<metadata>",
            "<versioning>",
            "<versions>",
            "<version>1.21.10+build.1</version>",
            "</versions>",
            "</versioning>",
            "</metadata>"
          ].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    assert.equal(result.candidates[0]?.symbol, "intermediary.pkg.InterClass");
    assert.equal(result.provenance?.source, "maven");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolves mojang named namespace paths through official tiny headers from Loom cache", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-official-loom-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeLoomTinyCache(root, TEST_TINY_OFFICIAL);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = createVersionServiceStub("https://example.test/mappings/client.txt");
    const service = new MappingService(config, versionServiceStub, fetchStub);

    const mojangToIntermediary = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "com.mojang.NamedClass",
        sourceMapping: "mojang",
        targetMapping: "intermediary"
      })
    );
    const mojangToYarn = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "com.mojang.NamedClass",
        sourceMapping: "mojang",
        targetMapping: "yarn"
      })
    );
    const intermediaryToMojang = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "intermediary.pkg.InterClass",
        sourceMapping: "intermediary",
        targetMapping: "mojang"
      })
    );

    assert.equal(mojangToIntermediary.status, "resolved");
    assert.equal(mojangToIntermediary.resolvedSymbol?.symbol, "intermediary.pkg.InterClass");
    assert.equal(mojangToYarn.status, "resolved");
    assert.equal(mojangToYarn.resolvedSymbol?.symbol, "yarn.pkg.NamedClass");
    assert.equal(intermediaryToMojang.status, "resolved");
    assert.equal(intermediaryToMojang.resolvedSymbol?.symbol, "com.mojang.NamedClass");
    assert.ok(mojangToIntermediary.warnings.every((warning) => !warning.includes("No mapping path is available")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolves mojang named namespace paths through official tiny headers from Maven fallback", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-official-maven-"));
  try {
    const config = buildTestConfig(root, { mappingSourcePriority: "maven-first" });

    const tinyJarPath = join(root, "official-tiny.jar");
    await createJar(tinyJarPath, {
      "mappings/mappings.tiny": `${TEST_TINY_OFFICIAL}\n`
    });
    const tinyJarBuffer = await readFile(tinyJarPath);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        return new Response(
          [
            "<metadata>",
            "<versioning>",
            "<versions>",
            "<version>1.21.10+build.1</version>",
            "</versions>",
            "</versioning>",
            "</metadata>"
          ].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = createVersionServiceStub("https://example.test/mappings/client.txt");
    const service = new MappingService(config, versionServiceStub, fetchStub);

    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "com.mojang.NamedClass",
        sourceMapping: "mojang",
        targetMapping: "intermediary"
      })
    );

    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedSymbol?.symbol, "intermediary.pkg.InterClass");
    assert.equal(result.mappingContext.sourcePriorityApplied, "maven-first");
    assert.ok(result.warnings.every((warning) => !warning.includes("No mapping path is available")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService fetches Maven tiny jars in parallel during fallback loading", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-parallel-"));
  try {
    const config = buildTestConfig(root);

    const tinyJarPath = join(root, "parallel-tiny.jar");
    await createJar(tinyJarPath, {
      "mappings/mappings.tiny": `${TEST_TINY}\n`
    });
    const tinyJarBuffer = await readFile(tinyJarPath);

    let activeJarFetches = 0;
    let maxActiveJarFetches = 0;

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        return new Response(
          [
            "<metadata>",
            "<versioning>",
            "<versions>",
            "<version>1.21.10+build.1</version>",
            "</versions>",
            "</versioning>",
            "</metadata>"
          ].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        activeJarFetches += 1;
        maxActiveJarFetches = Math.max(maxActiveJarFetches, activeJarFetches);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeJarFetches -= 1;
        return new Response(tinyJarBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    assert.ok(maxActiveJarFetches > 1, `expected parallel jar fetches, got ${maxActiveJarFetches}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService supports sourcePriority override over config default", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-priority-"));
  try {
    const config = buildTestConfig(root, {
      mappingSourcePriority: "loom-first"
    });

    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(
      loomTinyPath,
      [
        "tiny\t2\t0\tobfuscated\tintermediary",
        "c\ta/b/C\tloom/pkg/InterClass"
      ].join("\n"),
      "utf8"
    );

    const mavenTinyJar = join(root, "maven-tiny.jar");
    await createJar(mavenTinyJar, {
      "mappings/mappings.tiny": [
        "tiny\t2\t0\tobfuscated\tintermediary",
        "c\ta/b/C\tmaven/pkg/InterClass"
      ].join("\n")
    });
    const tinyJarBuffer = await readFile(mavenTinyJar);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith(".jar")) {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        return new Response("<metadata><versioning><versions></versions></versioning></metadata>", {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C"),
        sourceMapping: "obfuscated",
        targetMapping: "intermediary",
        sourcePriority: "maven-first"
      })
    );

    assert.equal(result.candidates[0]?.symbol, "maven.pkg.InterClass");
    assert.equal(result.provenance?.source, "maven");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService suppresses raw Loom miss warnings when Maven fallback resolves tiny mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-priority-warning-fallback-"));
  try {
    const config = buildTestConfig(root, {
      mappingSourcePriority: "loom-first",
      sourceRepos: ["https://example.test"]
    });

    const mavenTinyJar = join(root, "maven-tiny.jar");
    await createJar(mavenTinyJar, {
      "mappings/mappings.tiny": [
        "tiny\t2\t0\tobfuscated\tintermediary",
        "c\ta/b/C\tmaven/pkg/InterClass"
      ].join("\n")
    });
    const tinyJarBuffer = await readFile(mavenTinyJar);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/net/fabricmc/intermediary/1.21.10/intermediary-1.21.10-v2.jar") {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      if (url === "https://example.test/net/fabricmc/intermediary/1.21.10/intermediary-1.21.10.jar") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://example.test/net/fabricmc/yarn/maven-metadata.xml") {
        return new Response("<metadata><versioning><versions></versions></versioning></metadata>", {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      service.checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated"
      } as never)
    );

    assert.equal(result.resolved, true);
    assert.equal(result.status, "resolved");
    assert.ok(result.warnings.every((warning) => !warning.includes("No Loom tiny mapping files matched version")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists matches a descriptor against an intermediary-coordinate yarn tiny", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-yarn-2col-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeLoomTinyCache(root, TEST_TINY_YARN_2COL);
    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);

    const result = await withCwd(root, () =>
      service.checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.level.Level",
        name: "doThing",
        // Query descriptor is in yarn (named) coordinates; the stored descriptor
        // is in intermediary coordinates. Projecting only to obfuscated (absent
        // from this graph) used to miss it and report not_found.
        descriptor: "(Lnet/minecraft/world/level/Level;)V",
        sourceMapping: "yarn"
      } as never)
    );

    assert.equal(result.resolved, true, `expected resolved, got ${JSON.stringify(result)}`);
    assert.equal(result.status, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService extractTinyFromJar limits single-open tiny extraction to the first matching entry", async () => {
  const source = await readFile("src/mapping-service.ts", "utf8");
  const extractTinyBlock =
    source.match(/async function extractTinyFromJar\([\s\S]*?return true;\n\}/m)?.[0] ?? "";

  assert.match(extractTinyBlock, /collectMatchedJarEntriesAsUtf8\(/);
  assert.match(extractTinyBlock, /maxEntries:\s*1/);
});

test("MappingService limits returned candidates while preserving ambiguity metadata", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-max-candidates-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "f",
      descriptor: "(I)V",
      sourceMapping: "obfuscated",
      targetMapping: "mojang",
      maxCandidates: 1
    } as never);

    assert.equal(result.resolved, false);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidateCount, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidatesTruncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps field symbols and returns structured candidate metadata", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-field-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C.d"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(result.warnings.length, 0);
    assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedField");
    assert.equal(result.candidates[0]?.kind, "field");
    assert.equal(result.candidates[0]?.owner, "com.mojang.NamedClass");
    assert.equal(result.candidates[0]?.name, "namedField");
    assert.equal(result.candidates[0]?.descriptor, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps descriptor-qualified methods through tiny mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-tiny-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C.e(I)V"),
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    assert.equal(result.warnings.length, 0);
    assert.equal(result.candidates[0]?.symbol, "intermediary.pkg.InterClass.interMethod(I)V");
    assert.equal(result.candidates[0]?.kind, "method");
    assert.equal(result.candidates[0]?.owner, "intermediary.pkg.InterClass");
    assert.equal(result.candidates[0]?.name, "interMethod");
    assert.equal(result.candidates[0]?.descriptor, "(I)V");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolves exact method descriptor through mojang client mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-mojang-fallback-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C.e(I)V"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(result.resolved, true);
    assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedMethod(I)V");
    assert.equal(result.candidates[0]?.kind, "method");
    assert.equal(result.candidates[0]?.descriptor, "(I)V");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns identity candidate when source/target mapping are equal", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-identity-"));
  try {
    const config = buildTestConfig(root);
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const sourceMapping: SourceMapping = "yarn";
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("net.minecraft.server.MinecraftServer"),
      sourceMapping,
      targetMapping: sourceMapping
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.symbol, "net.minecraft.server.MinecraftServer");
    assert.equal(result.candidates[0]?.confidence, 1);
    assert.equal(result.candidates[0]?.kind, "class");
    assert.equal(result.candidates[0]?.name, "net.minecraft.server.MinecraftServer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolveMethodMappingExact resolves representative exact lookup backends", async (t) => {
  const { MappingService } = await import("../src/mapping-service.ts");

  await t.test("remaps descriptor class refs before strict matching", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-descriptor-remap-",
      TEST_DESCRIPTOR_REMAP_TINY
    );
    try {
      const descriptor = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";
      const expectedTargetDescriptor =
        "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z";

      const exactResult = await withCwd(root, () =>
        service.resolveMethodMappingExact({
          version: "1.21.10",
          owner: "net.minecraft.class_1937",
          name: "method_1725",
          descriptor,
          sourceMapping: "intermediary",
          targetMapping: "yarn"
        })
      );

      assert.equal(exactResult.resolved, true);
      assert.equal(exactResult.status, "resolved");
      assert.equal(exactResult.resolvedSymbol?.name, "setBlock");
      assert.equal(exactResult.resolvedSymbol?.owner, "net.minecraft.world.level.Level");
      assert.equal(exactResult.resolvedSymbol?.descriptor, expectedTargetDescriptor);

      // findMapping now defaults to signatureMode="name-only" at the service layer too, so
      // internal callers that want strict descriptor preservation must opt in explicitly.
      const findResult = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "method",
          owner: "net.minecraft.class_1937",
          name: "method_1725",
          descriptor,
          sourceMapping: "intermediary",
          targetMapping: "yarn",
          signatureMode: "exact"
        })
      );
      assert.equal(findResult.resolved, true);
      assert.equal(findResult.resolvedSymbol?.descriptor, expectedTargetDescriptor);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("preserves descriptor path through tiny mappings", async () => {
    const { root, service } = await createLoomService("mapping-service-method-exact-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
              sourcePriority?: "loom-first" | "maven-first";
            }) => Promise<{
              resolved: boolean;
              status: string;
              resolvedSymbol?: {
                name: string;
                owner?: string;
                descriptor?: string;
              };
              warnings: string[];
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, true);
      assert.equal(result.status, "resolved");
      assert.equal(result.resolvedSymbol?.name, "interMethod");
      assert.equal(result.resolvedSymbol?.owner, "intermediary.pkg.InterClass");
      assert.equal(result.resolvedSymbol?.descriptor, "(I)V");
      assert.equal(result.warnings.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("resolves through mojang client mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-mojang-"));
    try {
      const config = buildTestConfig(root);
      const fetchStub = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.test/mappings/client.txt") {
          return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const service = new MappingService(
        config,
        createVersionServiceStub("https://example.test/mappings/client.txt"),
        fetchStub
      );
      const result = await (
        service as unknown as {
          resolveMethodMappingExact: (input: {
            version: string;
            kind: "method";
            owner: string;
            name: string;
            descriptor: string;
            sourceMapping: SourceMapping;
            targetMapping: SourceMapping;
          }) => Promise<{
            resolved: boolean;
            status: string;
            warnings: string[];
          }>;
        }
      ).resolveMethodMappingExact({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        sourceMapping: "obfuscated",
        targetMapping: "mojang"
      });

      assert.equal(result.resolved, true);
      assert.equal(result.status, "resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService resolveMethodMappingExact reports representative unresolved result states", async (t) => {
  await t.test("returns explicit not_found for misses", async () => {
    const { root, service } = await createLoomService("mapping-service-method-exact-miss-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
            }) => Promise<{
              resolved: boolean;
              status: string;
              candidates: unknown[];
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "missing",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, false);
      assert.equal(result.status, "not_found");
      assert.equal(result.candidates.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("returns ambiguous when duplicate target names exist", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-ambiguous-",
      TEST_AMBIGUOUS_METHOD_TINY
    );
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            resolveMethodMappingExact: (input: {
              version: string;
              kind: "method";
              owner: string;
              name: string;
              descriptor: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
            }) => Promise<{
              resolved: boolean;
              status: string;
              candidates: Array<{ name: string }>;
            }>;
          }
        ).resolveMethodMappingExact({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.resolved, false);
      assert.equal(result.status, "ambiguous");
      assert.equal(result.candidates.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("applies maxCandidates to ambiguous result sets", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-method-exact-max-candidates-",
      TEST_AMBIGUOUS_METHOD_TINY
    );
    try {
      const result = await withCwd(root, () =>
        service.resolveMethodMappingExact({
          version: "1.21.10",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary",
          maxCandidates: 1
        } as never)
      );

      assert.equal(result.status, "ambiguous");
      assert.equal(result.candidateCount, 2);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidatesTruncated, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService builds class API matrix across mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          getClassApiMatrix: (input: {
            version: string;
            className: string;
            classNameMapping: SourceMapping;
          }) => Promise<{
            classIdentity: Record<string, string | undefined>;
            rows: Array<{
              kind: string;
              descriptor?: string;
              obfuscated?: { name: string };
              intermediary?: { name: string };
              yarn?: { name: string };
              mojang?: { name: string };
            }>;
          }>;
        }
      ).getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated"
      })
    );

    assert.equal(result.classIdentity.obfuscated, "a.b.C");
    assert.equal(result.classIdentity.intermediary, "intermediary.pkg.InterClass");
    assert.equal(result.classIdentity.yarn, "yarn.pkg.NamedClass");
    assert.equal(result.classIdentity.mojang, "com.mojang.NamedClass");

    const row = result.rows.find(
      (entry) => entry.kind === "method" && entry.descriptor === "(I)V" && entry.obfuscated?.name === "e"
    );
    assert.ok(row);
    assert.equal(row?.intermediary?.name, "interMethod");
    assert.equal(row?.yarn?.name, "namedMethod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix supports maxRows", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-maxrows-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 2
      } as never)
    );

    assert.equal(result.rowCount > 2, true);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowsTruncated, true);

    // An over-cap maxRows is silently clamped to 5000 downstream; surface a clamp warning.
    const clamped = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 100000
      } as never)
    );
    assert.ok(
      clamped.warnings.some((w: string) => /maxRows was clamped to 5000 from 100000\./.test(w)),
      "expected a maxRows clamp warning"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix maps only the windowed rows (per-row mapping scales with maxRows, not rowCount)", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-windowmap-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const query = { version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated" } as const;

    const beforeWindow = service.apiMatrixStats.rowMaps;
    const windowed = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1 } as never));
    const windowMaps = service.apiMatrixStats.rowMaps - beforeWindow;

    const beforeFull = service.apiMatrixStats.rowMaps;
    const full = await withCwd(root, () => service.getClassApiMatrix({ ...query } as never));
    const fullMaps = service.apiMatrixStats.rowMaps - beforeFull;

    // rowCount stays the full deduped count regardless of the window.
    assert.equal(windowed.rowCount, full.rowCount);
    assert.equal(full.rowCount > 1, true);
    // The single-row window maps far fewer rows than the whole class.
    assert.equal(windowMaps < fullMaps, true);
    // Bounded by ~ window rows * (SUPPORTED_MAPPINGS-1) + class-identity hops.
    assert.equal(windowMaps <= 1 * 3 + 6, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix paginates rows with a stable nextCursor", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-cursor-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    // Injective row key: include the descriptor so overloaded members (same
    // name, different descriptor) are distinct, making this a real no-overlap
    // oracle.
    const rowKey = (r: { kind: string; descriptor?: string; obfuscated?: { name?: string }; mojang?: { name?: string } }) =>
      `${r.kind}:${r.obfuscated?.name ?? r.mojang?.name ?? ""}:${r.descriptor ?? ""}`;

    const page1 = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1
      } as never)
    );
    assert.equal(page1.rows.length, 1);
    assert.equal(page1.rowsTruncated, true);
    assert.ok(page1.nextCursor, "page 1 must carry a continuation cursor");
    const total = page1.rowCount;
    assert.ok(total > 2, "fixture must have several rows to exercise pagination");

    // Walk every page with maxRows:1; collect keys to prove gap-free, no-overlap,
    // terminating pagination.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await withCwd(root, () =>
        service.getClassApiMatrix({
          version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1,
          ...(cursor ? { cursor } : {})
        } as never)
      );
      assert.equal(page.cursorIgnored, undefined);
      assert.ok(page.rows.length <= 1);
      for (const r of page.rows) seen.push(rowKey(r));
      pages += 1;
      assert.ok(pages <= total + 2, "pagination must terminate");
      if (!page.nextCursor) {
        // The final page must not advertise a continuation.
        assert.equal(page.rowsTruncated, undefined);
        break;
      }
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, total, "every row returned exactly once across all pages");
    assert.equal(new Set(seen).size, total, "no row was returned twice (keys are unique)");

    // A malformed cursor is ignored and the scan restarts from the first row.
    const restarted = await withCwd(root, () =>
      service.getClassApiMatrix({
        version: "1.21.10", className: "a.b.C", classNameMapping: "obfuscated", maxRows: 1,
        cursor: "not-a-valid-cursor"
      } as never)
    );
    assert.equal(restarted.cursorIgnored, true);
    assert.equal(rowKey(restarted.rows[0]!), rowKey(page1.rows[0]!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix prefers the explicit classNameMapping over obfuscated base rows", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-explicit-base-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);

    (service as any).loadGraph = async () => ({
      version: "1.21.10",
      priority: "loom-first",
      pairs: new Map(),
      adjacency: new Map(),
      pathCache: new Map(),
      classProjectionCache: new Map(),
      warnings: [],
      recordsByTarget: new Map([
        [
          "mojang",
          [
            {
              kind: "class",
              symbol: "com.mojang.NamedClass",
              name: "NamedClass"
            },
            {
              kind: "method",
              symbol: "com.mojang.NamedClass.namedMethod(I)V",
              owner: "com.mojang.NamedClass",
              name: "namedMethod",
              descriptor: "(I)V"
            }
          ]
        ],
        ["obfuscated", []],
        ["intermediary", []],
        ["yarn", []]
      ])
    });

    (service as any).mapRecordBetweenMappings = (
      _graph: unknown,
      sourceMapping: SourceMapping,
      targetMapping: SourceMapping,
      record: {
        kind: "class" | "field" | "method";
        owner?: string;
        name: string;
        descriptor?: string;
        symbol: string;
      }
    ) => {
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "obfuscated") {
        return [{ kind: "class", symbol: "a.b.C", name: "C" }];
      }
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "intermediary") {
        return [{ kind: "class", symbol: "intermediary.pkg.InterClass", name: "InterClass" }];
      }
      if (record.kind === "class" && sourceMapping === "mojang" && targetMapping === "yarn") {
        return [{ kind: "class", symbol: "yarn.pkg.NamedClass", name: "NamedClass" }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "obfuscated") {
        return [{
          kind: "method",
          symbol: "a.b.C.e(I)V",
          owner: "a.b.C",
          name: "e",
          descriptor: "(I)V"
        }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "intermediary") {
        return [{
          kind: "method",
          symbol: "intermediary.pkg.InterClass.interMethod(I)V",
          owner: "intermediary.pkg.InterClass",
          name: "interMethod",
          descriptor: "(I)V"
        }];
      }
      if (record.kind === "method" && sourceMapping === "mojang" && targetMapping === "yarn") {
        return [{
          kind: "method",
          symbol: "yarn.pkg.NamedClass.namedMethod(I)V",
          owner: "yarn.pkg.NamedClass",
          name: "namedMethod",
          descriptor: "(I)V"
        }];
      }
      return [];
    };

    const result = await service.getClassApiMatrix({
      version: "1.21.10",
      className: "com.mojang.NamedClass",
      classNameMapping: "mojang"
    } as never);

    assert.equal(result.classIdentity.mojang, "com.mojang.NamedClass");
    assert.equal(result.classIdentity.obfuscated, "a.b.C");
    assert.equal(result.rowCount, 2);
    assert.ok(
      result.rows.some(
        (row) => row.kind === "method" && row.mojang?.name === "namedMethod" && row.obfuscated?.name === "e"
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checks symbol existence across class/field/method kinds", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const classExists = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            owner?: string;
            sourceMapping: SourceMapping;
            descriptor?: string;
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated"
      })
    );
    assert.equal(classExists.resolved, true);
    assert.equal(classExists.status, "resolved");

    await assert.rejects(
      () =>
        withCwd(root, () =>
          (
            service as unknown as {
              checkSymbolExists: (input: {
                version: string;
                kind: "class" | "field" | "method";
                owner?: string;
                name: string;
                sourceMapping: SourceMapping;
                descriptor?: string;
                signatureMode?: "exact" | "name-only";
              }) => Promise<{ resolved: boolean; status: string }>;
            }
          ).checkSymbolExists({
            version: "1.21.10",
            kind: "method",
            owner: "a.b.C",
            name: "f",
            sourceMapping: "obfuscated",
            // Default signatureMode is now name-only; assert the strict path explicitly.
            signatureMode: "exact"
          })
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );

    const methodExists = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            descriptor?: string;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        // Default signatureMode is now name-only (would ignore the descriptor and go ambiguous);
        // assert exact descriptor resolution explicitly.
        signatureMode: "exact",
        sourceMapping: "obfuscated"
      })
    );
    assert.equal(methodExists.resolved, true);
    assert.equal(methodExists.status, "resolved");

    // signatureMode=name-only should NOT throw when descriptor is omitted
    const nameOnlyResult = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string; candidates: unknown[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        sourceMapping: "obfuscated",
        signatureMode: "name-only"
      })
    );
    // Two overloads of "f" exist, so name-only resolves as ambiguous
    assert.equal(nameOnlyResult.status, "ambiguous");
    assert.ok(nameOnlyResult.candidates.length >= 2);

    // signatureMode=name-only with unique method "e" should resolve
    const nameOnlyUnique = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string; candidates: unknown[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "e",
        sourceMapping: "obfuscated",
        signatureMode: "name-only"
      })
    );
    assert.equal(nameOnlyUnique.resolved, true);
    assert.equal(nameOnlyUnique.status, "resolved");
    assert.equal(nameOnlyUnique.candidates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService.findMapping honors nameMode=auto for dotless non-obfuscated class names", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-find-namemode-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const service = new MappingService(
      config,
      createVersionServiceStub("https://example.test/mappings/client.txt"),
      fetchStub
    );

    // nameMode=auto lets a dotless non-obfuscated class name through to resolution
    // (no ERR_INVALID_INPUT at the normalize step). It need not resolve — just not be rejected.
    const lenient = await service.findMapping({
      version: "1.21.10",
      kind: "class",
      name: "NamedClass",
      sourceMapping: "mojang",
      targetMapping: "obfuscated",
      nameMode: "auto"
    });
    assert.ok(
      ["resolved", "not_found", "ambiguous", "mapping_unavailable"].includes(lenient.status),
      `expected a resolution status, got ${lenient.status}`
    );

    // nameMode=fqcn still requires a fully-qualified name for a non-obfuscated mapping.
    await assert.rejects(
      () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "NamedClass",
          sourceMapping: "mojang",
          targetMapping: "obfuscated",
          nameMode: "fqcn"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists projects descriptor class references before matching overloads", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-projection-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Tiny records store the descriptor with intermediary/obfuscated class refs like
    // `Lnet/minecraft/class_2338;`. The caller uses yarn namespace with the named class
    // references (`BlockPos`, `BlockState`). Without descriptor projection the verbatim
    // comparison would fail; with projection the yarn descriptor is translated to the
    // intermediary/obfuscated form before matching and the lookup resolves.
    const yarnDescriptor =
      "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z";
    const resolved = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            descriptor?: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{
            resolved: boolean;
            status: string;
            candidates: Array<{ name: string; descriptor?: string }>;
          }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.level.Level",
        name: "setBlock",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(resolved.resolved, true, "exact descriptor with remapped class refs should resolve");
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0]?.name, "setBlock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping signatureMode=exact accepts partial projection for mixed MC + JDK descriptors", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-exact-mixed-jdk-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Before the fix, findMapping returned mapping_unavailable here because projection.complete
    // was false (Ljava/lang/String; is not in the mapping graph). The partial projection is
    // still useful: ItemStack gets remapped to class_1799 while String passes through, and the
    // resulting descriptor matches the stored record verbatim.
    const yarnDescriptor = "(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V";
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.item.ItemStack",
        name: "tagWithLabel",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        targetMapping: "obfuscated",
        signatureMode: "exact"
      })
    );

    assert.equal(mapped.resolved, true, "mixed MC + JDK descriptor should still resolve in exact mode");
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "method_9000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping signatureMode=exact accepts obfuscated-canonical descriptors on multi-hop paths", async () => {
  // Mojang -> Yarn lookups traverse mojang -> obfuscated -> intermediary -> yarn. Tiny v2
  // stores a single descriptor (typically obfuscated) and shares it across columns, so the
  // final Yarn candidate can carry an obfuscated-form descriptor instead of the yarn-form
  // projection that the strict filter's `strictDescriptor` holds. The filter must still
  // accept the candidate; otherwise the advertised exact retry path produces false `not_found`
  // for the most common migration shape (Mojang method whose descriptor references a remapped
  // Minecraft class).
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-exact-multihop-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Use the obfuscated-form descriptor the caller sees via resolveMethodMappingExact's
    // projection target. Source namespace is obfuscated so the lookup is exact-identity on
    // the descriptor side but still exercises the strict filter's accepted-descriptors set.
    const descriptor = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.class_1937",
        name: "method_1725",
        descriptor,
        sourceMapping: "obfuscated",
        targetMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(
      mapped.resolved,
      true,
      "multi-hop exact lookup must resolve even when candidate descriptor stays in obfuscated form"
    );
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "setBlock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping omitted signatureMode behaves as name-only at the service layer", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-omitted-sigmode-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_AMBIGUOUS_METHOD_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // When signatureMode is omitted the service default must match the public tool schema
    // default ("name-only"). Callers that omit the descriptor entirely on kind=method must
    // therefore not receive ERR_INVALID_INPUT from the descriptor-required path.
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "e",
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    // The fixture has two `e` overloads sharing `(I)V`, so name-only returns both.
    assert.notEqual(result.status, "mapping_unavailable");
    assert.ok(result.candidates.length >= 1, "omitted signatureMode must not error on missing descriptor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists accepts partial projection when descriptor mixes remapped MC classes with unmapped JDK classes", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-mixed-jdk-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Caller uses yarn-named classes for the MC type and the JDK String class reference.
    // projectMethodDescriptorToTarget cannot resolve `java/lang/String` (not in the mapping
    // graph) and marks the projection incomplete, but the partial projection still maps
    // `ItemStack -> class_1799` while leaving `Ljava/lang/String;` pass-through, so the
    // result aligns with the stored record descriptor `(Lclass_1799;Ljava/lang/String;)V`.
    const yarnDescriptor = "(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V";
    const resolved = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            descriptor?: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{
            resolved: boolean;
            status: string;
            candidates: Array<{ name: string }>;
          }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.item.ItemStack",
        name: "tagWithLabel",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(
      resolved.resolved,
      true,
      "partial projection (MC class remapped, JDK class pass-through) should still resolve the exact overload"
    );
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0]?.name, "tagWithLabel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService supports short class name checks when nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            sourceMapping: SourceMapping;
            nameMode?: "fqcn" | "auto";
          }) => Promise<{ resolved: boolean; status: string; resolvedSymbol?: { symbol: string } }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto"
      })
    );

    assert.equal(result.resolved, true);
    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedSymbol?.symbol, "a.b.C");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists supports maxCandidates", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-max-candidates-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const tiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/one/C\tyarn/one/C",
      "c\tx/y/C\tinter/two/C\tyarn/two/C"
    ].join("\n");
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      service.checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto",
        maxCandidates: 1
      } as never)
    );

    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidateCount, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidatesTruncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns ambiguous for short class names when multiple FQCNs match nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-ambiguous-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const tiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/one/C\tyarn/one/C",
      "c\tx/y/C\tinter/two/C\tyarn/two/C"
    ].join("\n");
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            sourceMapping: SourceMapping;
            nameMode?: "fqcn" | "auto";
          }) => Promise<{ resolved: boolean; status: string; candidates: Array<{ symbol: string }>; warnings: string[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto"
      })
    );

    assert.equal(result.resolved, false);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("fully-qualified class name")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping handles representative ambiguity metadata flows", async (t) => {
  await t.test("includes ambiguityReasons and warning when multiple owners match", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-ambiguity-reasons-",
      TEST_AMBIGUOUS_CLASS_TINY
    );
    try {
      const result = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.status, "ambiguous");
      assert.ok(result.warnings.some((warning) => warning.includes("Ambiguous mapping")));
      assert.ok(result.ambiguityReasons);
      assert.ok(result.ambiguityReasons.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("supports disambiguation hints for ambiguous class matches", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-find-disambiguation-",
      TEST_AMBIGUOUS_CLASS_TINY
    );
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            findMapping: (input: {
              version: string;
              kind: "class" | "field" | "method";
              name: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
              disambiguation?: { ownerHint?: string; descriptorHint?: string };
            }) => Promise<{ status: string; resolvedSymbol?: { symbol: string } }>;
          }
        ).findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary",
          disambiguation: { ownerHint: "inter.two" }
        })
      );

      assert.equal(result.status, "resolved");
      assert.equal(result.resolvedSymbol?.symbol, "inter.two.C");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("omits ambiguityReasons when a single candidate resolves", async () => {
    const { root, service } = await createLoomService("mapping-service-no-ambiguity-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.status, "resolved");
      assert.equal(result.ambiguityReasons, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService returns mapping_unavailable for symbol existence when mapping graph is absent", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-unavailable-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          owner?: string;
          name: string;
          sourceMapping: SourceMapping;
        }) => Promise<{ resolved: boolean; status: string }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "class",
      name: "intermediary.pkg.InterClass",
      sourceMapping: "intermediary"
    });

    assert.equal(result.resolved, false);
    assert.equal(result.status, "mapping_unavailable");

    await assert.rejects(
      () =>
        (
          service as unknown as {
            checkSymbolExists: (input: {
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              sourceMapping: SourceMapping;
              descriptor?: string;
              signatureMode?: "exact" | "name-only";
            }) => Promise<{ resolved: boolean; status: string }>;
          }
        ).checkSymbolExists({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "f",
          sourceMapping: "obfuscated",
          // Default signatureMode is now name-only; assert the strict descriptor-required path.
          signatureMode: "exact"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );

    await assert.rejects(
      () =>
        (
          service as unknown as {
            checkSymbolExists: (input: {
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              sourceMapping: SourceMapping;
            }) => Promise<{ resolved: boolean; status: string }>;
          }
        ).checkSymbolExists({
          version: "1.21.10",
          kind: "class",
          owner: "a.b.C",
          name: "a.b.C",
          sourceMapping: "obfuscated"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns empty graph for unobfuscated version (26.1)", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-unobfuscated-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    const fetchCalls: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "26.1",
      kind: "class",
      name: "a.b.C",
      sourceMapping: "obfuscated",
      targetMapping: "yarn"
    });

    assert.equal(result.status, "mapping_unavailable");
    assert.ok(
      result.warnings.some((w) => w.includes("No mapping path")),
      "Expected a warning about missing mapping path"
    );
    assert.equal(fetchCalls.length, 0, "No network requests should be made for unobfuscated versions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkMappingHealth treats unobfuscated mojang runtime names as healthy", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-unobfuscated-health-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    const fetchStub = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const mojangHealth = await service.checkMappingHealth({
      version: "26.1",
      requestedMapping: "mojang"
    });
    const yarnHealth = await service.checkMappingHealth({
      version: "26.1",
      requestedMapping: "yarn"
    });

    assert.deepEqual(mojangHealth, {
      mojangMappingsAvailable: true,
      tinyMappingsAvailable: true,
      memberRemapAvailable: true,
      degradations: []
    });
    assert.deepEqual(yarnHealth, {
      mojangMappingsAvailable: true,
      tinyMappingsAvailable: false,
      memberRemapAvailable: false,
      degradations: ["Version 26.1 is unobfuscated; yarn mappings are not applicable."]
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkMappingHealth skips tiny namespace loading for mojang and obfuscated requests", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");

  async function assertHealthSkipsTiny(requestedMapping: "mojang" | "obfuscated") {
    const root = await mkdtemp(join(tmpdir(), `mapping-service-health-${requestedMapping}-`));
    try {
      const config = buildTestConfig(root);
      const fetchStub = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.test/mappings/client.txt") {
          return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const service = new MappingService(
        config,
        createVersionServiceStub("https://example.test/mappings/client.txt"),
        fetchStub
      );

      let loomTinyLoads = 0;
      let mavenTinyLoads = 0;
      (service as unknown as {
        loadTinyPairsFromLoom: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
        loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      }).loadTinyPairsFromLoom = async () => {
        loomTinyLoads += 1;
        return {
          pairs: new Map(),
          warnings: ["unexpected loom tiny load"],
          mappingArtifact: "loom-cache:none"
        };
      };
      (service as unknown as {
        loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      }).loadTinyPairsFromMaven = async () => {
        mavenTinyLoads += 1;
        return {
          pairs: new Map(),
          warnings: ["unexpected maven tiny load"],
          mappingArtifact: "maven:none"
        };
      };

      const health = await service.checkMappingHealth({
        version: "1.21.10",
        requestedMapping
      });

      assert.equal(health.mojangMappingsAvailable, true);
      assert.equal(health.tinyMappingsAvailable, true);
      assert.equal(health.memberRemapAvailable, true);
      assert.equal(loomTinyLoads, 0);
      assert.equal(mavenTinyLoads, 0);
      assert.deepEqual(health.degradations, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  await assertHealthSkipsTiny("mojang");
  await assertHealthSkipsTiny("obfuscated");
});

const TEST_TINY_V1 = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tv1/pkg/VersionOneClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

test("MappingService Loom cache version filter handles representative candidate path variants", async (t) => {
  const { MappingService } = await import("../src/mapping-service.ts");

  const assertVersionFilteredResult = (result: {
    candidates: Array<{ symbol?: string }>;
    provenance?: { source?: string };
  }) => {
    assert.equal(result.candidates[0]?.symbol, "v1.pkg.VersionOneClass");
    assert.equal(result.provenance?.source, "loom-cache");
  };

  await t.test("ignores version prefix collisions between Loom cache directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapping-service-version-collision-"));
    try {
      const config = buildTestConfig(root, { sourceRepos: [] });

      await writeLoomTinyCache(root, TEST_TINY_V1, "1.21.1");
      await writeLoomTinyCache(root, TEST_TINY, "1.21.10");

      const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
      const result = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.1",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "yarn"
        })
      );

      assertVersionFilteredResult(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("normalizes backslash separated candidate paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapping-service-backslash-path-"));
    try {
      const config = buildTestConfig(root, { sourceRepos: [] });

      const pseudoWindowsPath121_1 = join(root, ".gradle", "loom-cache\\1.21.1\\mappings.tiny");
      const pseudoWindowsPath121_10 = join(root, ".gradle", "loom-cache\\1.21.10\\mappings.tiny");
      await mkdir(join(root, ".gradle"), { recursive: true });
      await writeFile(pseudoWindowsPath121_1, `${TEST_TINY_V1}\n`, "utf8");
      await writeFile(pseudoWindowsPath121_10, `${TEST_TINY}\n`, "utf8");

      const originalGlob = fastGlob.glob;
      fastGlob.glob = async () => [pseudoWindowsPath121_1, pseudoWindowsPath121_10];
      try {
        const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);
        const result = await service.findMapping({
          version: "1.21.1",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "yarn"
        });

        assertVersionFilteredResult(result);
      } finally {
        fastGlob.glob = originalGlob;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService rejects class queries that include owner", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-owner-invalid-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    await assert.rejects(
      () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          owner: "a.b",
          sourceMapping: "obfuscated",
          targetMapping: "mojang"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService uses async Loom cache candidate discovery", async () => {
  const source = await readFile("src/mapping-service.ts", "utf8");

  assert.doesNotMatch(source, /fastGlob\.sync\(/);
});

test("MappingService getClassApiMatrix includes competing candidates in ambiguity warnings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-matrix-competing-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    // Create ambiguous tiny data: two intermediary mappings for the same obfuscated method
    const ambiguousTiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/pkg/C\tyarn/pkg/C",
      "\tm\t(I)V\te\tinterMethod1\tnamedMethod",
      "\tm\t(I)V\te\tinterMethod2\tnamedMethodAlt"
    ].join("\n");

    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${ambiguousTiny}\n`, "utf8");

    const fetchStub = (async () => {
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          getClassApiMatrix: (input: {
            version: string;
            className: string;
            classNameMapping: SourceMapping;
          }) => Promise<{
            warnings: string[];
            ambiguousRowCount?: number;
            rows: Array<{ kind: string }>;
          }>;
        }
      ).getClassApiMatrix({
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated"
      })
    );

    const competingWarnings = result.warnings.filter((w: string) => w.includes("competing="));
    assert.equal(result.ambiguousRowCount, 1);
    assert.ok(competingWarnings.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService getClassApiMatrix scopes ambiguity warnings to the returned page (B1)", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-matrix-competing-page-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    // Class row (a/b/C, non-ambiguous) sorts before the ambiguous method row.
    const ambiguousTiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/pkg/C\tyarn/pkg/C",
      "\tm\t(I)V\te\tinterMethod1\tnamedMethod",
      "\tm\t(I)V\te\tinterMethod2\tnamedMethodAlt"
    ].join("\n");

    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${ambiguousTiny}\n`, "utf8");

    const fetchStub = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub) as unknown as {
      getClassApiMatrix: (input: {
        version: string;
        className: string;
        classNameMapping: SourceMapping;
        maxRows?: number;
        cursor?: string;
      }) => Promise<{ warnings: string[]; ambiguousRowCount?: number; rowCount: number; nextCursor?: string }>;
    };
    const query = { version: "1.21.10" as const, className: "a.b.C", classNameMapping: "obfuscated" as const };

    // Page 1 (the non-ambiguous class row): ambiguity is NOT reported for rows the caller cannot see.
    const page1 = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1 }));
    assert.equal(page1.rowCount, 2, "rowCount stays the full deduped count");
    assert.equal(page1.ambiguousRowCount, undefined);
    assert.equal(page1.warnings.filter((w) => w.includes("competing=")).length, 0);
    assert.ok(page1.nextCursor);

    // Page 2 (the ambiguous method row): now the page-scoped ambiguity surfaces.
    const page2 = await withCwd(root, () => service.getClassApiMatrix({ ...query, maxRows: 1, cursor: page1.nextCursor }));
    assert.equal(page2.ambiguousRowCount, 1);
    assert.ok(page2.warnings.filter((w) => w.includes("competing=")).length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
