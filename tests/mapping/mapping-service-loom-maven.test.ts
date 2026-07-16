import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fastGlob from "fast-glob";

import { withGradleUserHome } from "../helpers/env.ts";
import { createJar } from "../helpers/zip.ts";
import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  withCwd,
  createVersionServiceStub,
  queryFromSymbol,
  writeLoomTinyCache,
  writeFabricLoomTinyCache,
  TEST_TINY,
  TEST_TINY_ALT,
  TEST_TINY_OFFICIAL,
  TEST_DESCRIPTOR_REMAP_TINY_PROJECT,
  TEST_DESCRIPTOR_REMAP_TINY_GRADLE_HOME,
  TEST_MOJANG_CLIENT_MAPPINGS,
  TEST_TINY_V1
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

test("MappingService maps obfuscated -> yarn from Loom tiny cache", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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

test("MappingService stops Maven tiny fallback at the first successful jar per artifact", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-sequential-"));
  try {
    const config = buildTestConfig(root);

    const tinyJarPath = join(root, "sequential-tiny.jar");
    await createJar(tinyJarPath, {
      "mappings/mappings.tiny": `${TEST_TINY}\n`
    });
    const tinyJarBuffer = await readFile(tinyJarPath);

    const fetchedJarUrls: string[] = [];

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        return new Response(
          [
            "<metadata>",
            "<versioning>",
            "<versions>",
            "<version>1.21.10+build.1</version>",
            "<version>1.21.10+build.2</version>",
            "<version>1.21.10+build.3</version>",
            "</versions>",
            "</versioning>",
            "</metadata>"
          ].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        fetchedJarUrls.push(url);
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

    assert.deepEqual(fetchedJarUrls, [
      "https://maven.fabricmc.net/net/fabricmc/intermediary/1.21.10/intermediary-1.21.10-v2.jar",
      "https://maven.fabricmc.net/net/fabricmc/yarn/1.21.10+build.3/yarn-1.21.10+build.3-v2.jar"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService supports sourcePriority override over config default", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
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
  const { MappingService } = await import("../../src/mapping-service.ts");
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

test("MappingService extractTinyFromJar limits single-open tiny extraction to the first matching entry", async () => {
  const source = await readFile("src/mapping-service.ts", "utf8");
  const extractTinyBlock =
    source.match(/async function extractTinyFromJar\([\s\S]*?return true;\n\}/m)?.[0] ?? "";

  assert.match(extractTinyBlock, /collectMatchedJarEntriesAsUtf8\(/);
  assert.match(extractTinyBlock, /maxEntries:\s*1/);
});

test("MappingService Loom cache version filter handles representative candidate path variants", async (t) => {
  const { MappingService } = await import("../../src/mapping-service.ts");

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

test("resolveTinyMappingFile yarn re-resolves the newest build after the metadata TTL, reuses within it, and falls back on outage", async () => {
  const { resolveTinyMappingFile } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "resolve-yarn-ttl-"));
  try {
    const tinyJarPath = join(root, "yarn-tiny.jar");
    await createJar(tinyJarPath, { "mappings/mappings.tiny": `${TEST_TINY}\n` });
    const tinyJarBuffer = await readFile(tinyJarPath);

    // The fetch stub is reconfigured per phase via these closures.
    let builds: string[] = ["1.21.1+build.10"];
    let metadataReachable = true;
    let metadataFetches = 0;

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        metadataFetches += 1;
        if (!metadataReachable) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(
          ["<metadata><versioning><versions>",
            ...builds.map((b) => `<version>${b}</version>`),
            "</versions></versioning></metadata>"].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const clock = { t: 1_000_000 };
    const now = () => clock.t;

    // First resolve -> fetches metadata, picks build.10, coordinate-keyed.
    const first = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now });
    assert.equal(first.coordinate, "1.21.1+build.10");
    assert.match(first.path, /1\.21\.1\+build\.10\.tiny$/);
    assert.equal(metadataFetches, 1);

    // Within TTL -> zero network, same coordinate (metadata fetch count unchanged).
    const second = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now });
    assert.equal(second.coordinate, "1.21.1+build.10");
    assert.equal(metadataFetches, 1, "within TTL must not re-fetch maven metadata");

    // TTL expires + Fabric publishes build.11 -> re-resolves to build.11.
    clock.t += 25 * 60 * 60 * 1000; // > 24h TTL
    builds = ["1.21.1+build.10", "1.21.1+build.11"];
    const third = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now });
    assert.equal(third.coordinate, "1.21.1+build.11");
    assert.match(third.path, /1\.21\.1\+build\.11\.tiny$/);
    assert.equal(metadataFetches, 2);

    // TTL expires again but Maven is unreachable -> fall back to last-known-good
    // build.11 instead of throwing MAPPING_UNAVAILABLE.
    clock.t += 25 * 60 * 60 * 1000;
    metadataReachable = false;
    const fourth = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now });
    assert.equal(fourth.coordinate, "1.21.1+build.11", "must serve last-known-good on metadata outage");
    assert.equal(metadataFetches, 3, "outage still attempts one metadata fetch before falling back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTinyMappingFile yarn forceRefresh bypasses the metadata TTL", async () => {
  const { resolveTinyMappingFile } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "resolve-yarn-force-"));
  try {
    const tinyJarPath = join(root, "yarn-tiny.jar");
    await createJar(tinyJarPath, { "mappings/mappings.tiny": `${TEST_TINY}\n` });
    const tinyJarBuffer = await readFile(tinyJarPath);

    let builds: string[] = ["1.21.1+build.10"];
    let metadataFetches = 0;
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
        metadataFetches += 1;
        return new Response(
          ["<metadata><versioning><versions>",
            ...builds.map((b) => `<version>${b}</version>`),
            "</versions></versioning></metadata>"].join(""),
          { status: 200 }
        );
      }
      if (url.endsWith(".jar")) {
        return new Response(tinyJarBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const now = () => 5_000_000; // fixed clock: TTL would normally keep build.10
    const first = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now });
    assert.equal(first.coordinate, "1.21.1+build.10");
    assert.equal(metadataFetches, 1);

    // Same clock (within TTL) but forceRefresh must re-fetch and pick the new build.
    builds = ["1.21.1+build.10", "1.21.1+build.11"];
    const forced = await resolveTinyMappingFile("1.21.1", "yarn", root, fetchStub, { now, forceRefresh: true });
    assert.equal(forced.coordinate, "1.21.1+build.11");
    assert.equal(metadataFetches, 2, "forceRefresh must re-fetch metadata even within TTL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
