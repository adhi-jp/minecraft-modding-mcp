import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fastGlob from "fast-glob";

import { withEnv, withGradleUserHome } from "../helpers/env.ts";
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
    await writeLoomTinyCache(root, TEST_TINY);

    const versionServiceStub = createVersionServiceStub();

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

    const versionServiceStub = createVersionServiceStub();

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

    const versionServiceStub = createVersionServiceStub();

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

    await writeLoomTinyCache(
      root,
      [
        "tiny\t2\t0\tobfuscated\tintermediary",
        "c\ta/b/C\tloom/pkg/InterClass"
      ].join("\n")
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

    const versionServiceStub = createVersionServiceStub();

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

    const versionServiceStub = createVersionServiceStub();

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

const MAVEN_VERSION = "1.21.10";
const YARN_BUILD = `${MAVEN_VERSION}+build.1`;
const REPO_A = "https://repo-a.test";
const REPO_B = "https://repo-b.test";
const REPO_C = "https://repo-c.test";
const CLIENT_MAPPINGS_URL = "https://example.test/mappings/client.txt";

// Intermediary and yarn jars carry different namespace pairs, so a lookup from
// obfuscated names shows which of the two jars the graph actually loaded. The
// second class lets a later lookup miss the per-query resolution cache and read
// the graph cache.
const MAVEN_INTERMEDIARY_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary",
  "c\ta/b/C\tintermediary/pkg/InterClass",
  "c\ta/b/D\tintermediary/pkg/OtherInterClass"
].join("\n");
const MAVEN_YARN_TINY = [
  "tiny\t2\t0\tintermediary\tnamed",
  "c\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "c\tintermediary/pkg/OtherInterClass\tyarn/pkg/OtherNamedClass"
].join("\n");

function mavenUrls(base: string) {
  return {
    metadata: `${base}/net/fabricmc/yarn/maven-metadata.xml`,
    intermediary: `${base}/net/fabricmc/intermediary/${MAVEN_VERSION}/intermediary-${MAVEN_VERSION}-v2.jar`,
    yarn: `${base}/net/fabricmc/yarn/${YARN_BUILD}/yarn-${YARN_BUILD}-v2.jar`
  };
}

function yarnMetadataResponse(): Response {
  return new Response(
    `<metadata><versioning><versions><version>${YARN_BUILD}</version></versions></versioning></metadata>`,
    { status: 200 }
  );
}

type MavenJars = { intermediary: Buffer; yarn: Buffer; noTiny: Buffer };

async function buildMavenJars(root: string): Promise<MavenJars> {
  const intermediaryPath = join(root, "maven-intermediary.jar");
  const yarnPath = join(root, "maven-yarn.jar");
  const noTinyPath = join(root, "maven-no-tiny.jar");
  await createJar(intermediaryPath, { "mappings/mappings.tiny": `${MAVEN_INTERMEDIARY_TINY}\n` });
  await createJar(yarnPath, { "mappings/mappings.tiny": `${MAVEN_YARN_TINY}\n` });
  await createJar(noTinyPath, { "README.txt": "no mappings here\n" });
  return {
    intermediary: await readFile(intermediaryPath),
    yarn: await readFile(yarnPath),
    noTiny: await readFile(noTinyPath)
  };
}

type MavenRoute = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** Answers each URL through `route`, and 404 for every URL it leaves unanswered. */
function routedFetch(route: MavenRoute): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return (await route(url, init)) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function servedJar(bytes: Buffer): Response {
  return new Response(bytes, { status: 200 });
}

function failedAnswer(status: number): Response {
  return new Response("unavailable", { status });
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

function stallingBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), {
        once: true
      });
    }
  });
}

function graphCacheKeysFor(service: unknown, version: string): string[] {
  const graphCache = (service as { graphCache: Map<string, unknown> }).graphCache;
  return [...graphCache.keys()].filter((key) => key.startsWith(`${version}|`));
}

function findFromObfuscated(
  service: { findMapping: (input: never) => Promise<unknown> },
  root: string,
  targetMapping: "intermediary" | "yarn",
  symbol = "a.b.C"
) {
  return withCwd(root, () =>
    service.findMapping({
      version: MAVEN_VERSION,
      ...queryFromSymbol(symbol),
      sourceMapping: "obfuscated",
      targetMapping
    } as never)
  ) as Promise<{
    candidates: Array<{ symbol?: string }>;
    provenance?: { source?: string; mappingArtifact?: string };
  }>;
}

test("MappingService loads the Maven intermediary jar again after a 503 and caches the recovered graph", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-intermediary-503-"));
  try {
    const jars = await buildMavenJars(root);
    const urls = mavenUrls(REPO_A);
    let intermediaryAvailable = false;
    const { fetchFn, calls } = routedFetch((url) => {
      if (url === urls.metadata) {
        return yarnMetadataResponse();
      }
      if (url === urls.intermediary) {
        return intermediaryAvailable ? servedJar(jars.intermediary) : failedAnswer(503);
      }
      if (url === urls.yarn) {
        return servedJar(jars.yarn);
      }
      return undefined;
    });
    const service = new MappingService(
      buildTestConfig(root, { sourceRepos: [REPO_A] }),
      createVersionServiceStub(),
      fetchFn
    );

    const failed = await findFromObfuscated(service, root, "intermediary");
    assert.equal(failed.candidates.length, 0);
    assert.deepEqual(graphCacheKeysFor(service, MAVEN_VERSION), []);

    intermediaryAvailable = true;
    const recovered = await findFromObfuscated(service, root, "intermediary");
    assert.equal(recovered.candidates[0]?.symbol, "intermediary.pkg.InterClass");
    assert.equal(recovered.provenance?.source, "maven");
    assert.equal(recovered.provenance?.mappingArtifact, urls.intermediary);
    assert.equal(graphCacheKeysFor(service, MAVEN_VERSION).length, 1);

    const callsAfterRecovery = calls.length;
    const cached = await findFromObfuscated(service, root, "intermediary", "a.b.D");
    assert.equal(cached.candidates[0]?.symbol, "intermediary.pkg.OtherInterClass");
    assert.equal(calls.length, callsAfterRecovery, "a cached graph must not fetch again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const metadataFailure of [
  { label: "answers 503", answer: () => failedAnswer(503) },
  { label: "never answers", answer: (init: RequestInit | undefined) => waitForAbort(init?.signal) },
  {
    label: "stalls its body",
    answer: (init: RequestInit | undefined) => new Response(stallingBody(init?.signal), { status: 200 })
  }
]) {
  test(`MappingService loads yarn again after the yarn build list ${metadataFailure.label}, and caches the recovered graph`, { timeout: 10_000 }, async () => {
    const { MappingService } = await import("../../src/mapping-service.ts");
    const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-yarn-metadata-"));
    try {
      const jars = await buildMavenJars(root);
      const urls = mavenUrls(REPO_A);
      let metadataAvailable = false;
      const { fetchFn, calls } = routedFetch((url, init) => {
        if (url === urls.metadata) {
          return metadataAvailable ? yarnMetadataResponse() : metadataFailure.answer(init);
        }
        if (url === urls.intermediary) {
          return servedJar(jars.intermediary);
        }
        if (url === urls.yarn) {
          return servedJar(jars.yarn);
        }
        return undefined;
      });
      const service = new MappingService(
        buildTestConfig(root, { sourceRepos: [REPO_A], fetchTimeoutMs: 100 }),
        createVersionServiceStub(),
        fetchFn
      );

      const failed = await findFromObfuscated(service, root, "yarn");
      assert.equal(failed.candidates.length, 0);
      assert.deepEqual(graphCacheKeysFor(service, MAVEN_VERSION), []);

      metadataAvailable = true;
      const recovered = await findFromObfuscated(service, root, "yarn");
      assert.equal(recovered.candidates[0]?.symbol, "yarn.pkg.NamedClass");
      assert.equal(graphCacheKeysFor(service, MAVEN_VERSION).length, 1);

      const callsAfterRecovery = calls.length;
      const cached = await findFromObfuscated(service, root, "yarn", "a.b.D");
      assert.equal(cached.candidates[0]?.symbol, "yarn.pkg.OtherNamedClass");
      assert.equal(calls.length, callsAfterRecovery, "a cached graph must not fetch again");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

type MavenCacheRow = {
  label: string;
  cached: boolean;
  sourceRepos: string[];
  mappingSourcePriority?: "maven-first";
  loomTiny?: string;
  clientMappingsStatus?: number;
  route: (jars: MavenJars) => MavenRoute;
};

/** Every repository in `bases` serves the yarn build list, and `base`'s jars where `serve` says so. */
function serveFrom(
  jars: MavenJars,
  serve: { intermediary?: string; yarn?: string },
  bases: string[]
): MavenRoute {
  return (url) => {
    for (const base of bases) {
      const urls = mavenUrls(base);
      if (url === urls.metadata) {
        return yarnMetadataResponse();
      }
      if (serve.intermediary === base && url === urls.intermediary) {
        return servedJar(jars.intermediary);
      }
      if (serve.yarn === base && url === urls.yarn) {
        return servedJar(jars.yarn);
      }
    }
    return undefined;
  };
}

function withOverrides(overrides: Record<string, () => Response>, fallback: MavenRoute): MavenRoute {
  return (url, init) => overrides[url]?.() ?? fallback(url, init);
}

for (const stage of ["content-length", "stream"]) {
  test(`MappingService does not repeat Maven downloads refused by the ${stage} size limit`, async () => {
    const { MappingService } = await import("../../src/mapping-service.ts");
    const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-size-limit-"));
    try {
      await withEnv({ MCP_MAX_DOWNLOAD_BYTES: String(1024 * 1024) }, async () => {
        const jars = await buildMavenJars(root);
        const urls = mavenUrls(REPO_A);
        const { fetchFn, calls } = routedFetch((url) => {
          if (url === urls.intermediary) {
            return stage === "content-length"
              ? new Response("unread", { headers: { "content-length": "2097152" } })
              : new Response(Buffer.alloc(1024 * 1024 + 1));
          }
          return serveFrom(jars, { yarn: REPO_A }, [REPO_A])(url, undefined);
        });
        const service = new MappingService(
          buildTestConfig(root, { sourceRepos: [REPO_A] }),
          createVersionServiceStub(),
          fetchFn
        );

        const first = await findFromObfuscated(service, root, "intermediary");
        const second = await findFromObfuscated(service, root, "intermediary");

        assert.equal(first.candidates.length, 0);
        assert.equal(second.candidates.length, 0);
        assert.equal(
          calls.filter((url) => url === urls.intermediary).length,
          1,
          "an identical lookup must not download the same over-limit jar again"
        );
        assert.equal(graphCacheKeysFor(service, MAVEN_VERSION).length, 1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const mavenCacheRows: MavenCacheRow[] = [
  {
    label: "one repository answers 503 for the intermediary jar while another serves it",
    cached: true,
    sourceRepos: [REPO_A, REPO_B],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => failedAnswer(503) },
        serveFrom(jars, { intermediary: REPO_B, yarn: REPO_A }, [REPO_A, REPO_B])
      )
  },
  {
    label: "every repository answers 404",
    cached: true,
    sourceRepos: [REPO_A, REPO_B],
    route: () => () => undefined
  },
  {
    label: "a 503 and then a 404 for the intermediary jar while a third repository serves it",
    cached: true,
    sourceRepos: [REPO_A, REPO_B, REPO_C],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => failedAnswer(503) },
        serveFrom(jars, { intermediary: REPO_C, yarn: REPO_A }, [REPO_A, REPO_C])
      )
  },
  {
    label: "one repository answers 503 for the yarn build list while another serves yarn",
    cached: true,
    sourceRepos: [REPO_A, REPO_B],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).metadata]: () => failedAnswer(503) },
        serveFrom(jars, { intermediary: REPO_A, yarn: REPO_B }, [REPO_A, REPO_B])
      )
  },
  {
    label: "the served intermediary jar has no tiny entry",
    cached: true,
    sourceRepos: [REPO_A],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => servedJar(jars.noTiny) },
        serveFrom(jars, { yarn: REPO_A }, [REPO_A])
      )
  },
  {
    label: "the served intermediary jar cannot be read",
    cached: true,
    sourceRepos: [REPO_A],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => servedJar(Buffer.from("not a jar")) },
        serveFrom(jars, { yarn: REPO_A }, [REPO_A])
      )
  },
  {
    label: "under maven-first, Maven fails with a 503 and the Loom cache answers",
    cached: true,
    sourceRepos: [REPO_A],
    mappingSourcePriority: "maven-first",
    loomTiny: TEST_TINY,
    route: () =>
      withOverrides(
        {
          [mavenUrls(REPO_A).metadata]: () => failedAnswer(503),
          [mavenUrls(REPO_A).intermediary]: () => failedAnswer(503)
        },
        () => undefined
      )
  },
  {
    label: "the yarn jar answers 503 and no repository serves yarn",
    cached: false,
    sourceRepos: [REPO_A],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).yarn]: () => failedAnswer(503) },
        serveFrom(jars, { intermediary: REPO_A }, [REPO_A])
      )
  },
  {
    label: "one repository answers 503 and the other 404 for an intermediary jar no one serves",
    cached: false,
    sourceRepos: [REPO_A, REPO_B],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => failedAnswer(503) },
        serveFrom(jars, { yarn: REPO_A }, [REPO_A])
      )
  },
  {
    label: "the intermediary jar answers 503 and no repository serves any tiny jar",
    cached: false,
    sourceRepos: [REPO_A],
    route: () =>
      withOverrides({ [mavenUrls(REPO_A).intermediary]: () => failedAnswer(503) }, () => undefined)
  },
  {
    label: "the intermediary jar answers 429",
    cached: false,
    sourceRepos: [REPO_A],
    route: (jars) =>
      withOverrides(
        { [mavenUrls(REPO_A).intermediary]: () => failedAnswer(429) },
        serveFrom(jars, { yarn: REPO_A }, [REPO_A])
      )
  },
  {
    label: "the yarn jar request throws a network error",
    cached: false,
    sourceRepos: [REPO_A],
    route: (jars) =>
      withOverrides(
        {
          [mavenUrls(REPO_A).yarn]: () => {
            throw new TypeError("fetch failed");
          }
        },
        serveFrom(jars, { intermediary: REPO_A }, [REPO_A])
      )
  },
  {
    label: "the Mojang client mappings answer 503 while Maven serves both tiny jars",
    cached: false,
    sourceRepos: [REPO_A],
    clientMappingsStatus: 503,
    route: (jars) => serveFrom(jars, { intermediary: REPO_A, yarn: REPO_A }, [REPO_A])
  }
];

for (const row of mavenCacheRows) {
  test(`MappingService ${row.cached ? "caches" : "does not cache"} the full graph when ${row.label}`, async () => {
    const { MappingService } = await import("../../src/mapping-service.ts");
    const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-cache-row-"));
    try {
      const jars = await buildMavenJars(root);
      if (row.loomTiny) {
        await writeLoomTinyCache(root, row.loomTiny);
      }
      const mavenRoute = row.route(jars);
      const { fetchFn } = routedFetch((url, init) =>
        url === CLIENT_MAPPINGS_URL && row.clientMappingsStatus !== undefined
          ? failedAnswer(row.clientMappingsStatus)
          : mavenRoute(url, init)
      );
      const service = new MappingService(
        buildTestConfig(root, {
          sourceRepos: row.sourceRepos,
          ...(row.mappingSourcePriority ? { mappingSourcePriority: row.mappingSourcePriority } : {})
        }),
        createVersionServiceStub(row.clientMappingsStatus !== undefined ? CLIENT_MAPPINGS_URL : undefined),
        fetchFn
      );

      await findFromObfuscated(service, root, "intermediary");

      assert.equal(graphCacheKeysFor(service, MAVEN_VERSION).length, row.cached ? 1 : 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
