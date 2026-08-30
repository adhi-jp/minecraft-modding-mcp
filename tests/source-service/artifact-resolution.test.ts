import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";
import {
  type CacheAccountingRepo,
  type CacheFixtureArtifact,
  type CacheFixtureArtifactInput,
  type SourceServiceFixture,
  computeSourceEntriesBytes,
  createCacheAccountingFixture,
  defaultBinaryEntriesFor,
  instrumentCacheAccountingRepo
} from "../helpers/source-service-fixtures.ts";

test("SourceService resolves/searches/reads class source through artifactId flow", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-main-"));
  const binaryJarPath = join(root, "server-1.0.0.jar");
  const sourcesJarPath = join(root, "server-1.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/world/World.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "import net.minecraft.world.World;",
      "public class Main {",
      "  void tickServer() {",
      "    World.update();",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/world/World.java": [
      "package net.minecraft.world;",
      "public class World {",
      "  static void update() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.requestedMapping, "obfuscated");
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.equal(resolved.provenance.target.kind, "jar");
  assert.equal(resolved.provenance.target.value, binaryJarPath);
  // The resolver picks the sibling sources jar as canonical when present, so
  // the readable token reflects the resolver-canonical path (server-1.0.0-sources)
  // rather than the caller's request value (server-1.0.0.jar). This is the
  // canonical-alias contract: alias derives from the artifact
  // row, not from the user's request spelling.
  assert.match(
    resolved.artifactAlias,
    /^jar-server-1-0-0-sources-[0-9a-f]{12}$/,
    "artifactAlias must be canonical (no mapping/scope tokens) and 1:1 with artifactId"
  );
  assert.equal(resolved.artifactAlias.endsWith(resolved.artifactId.slice(0, 12)), true);

  // The repo lookup must accept the alias just like the artifactId.
  const lookedUpByAlias = await service.searchClassSource({
    artifactId: resolved.artifactAlias,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    limit: 5
  });
  assert.ok(lookedUpByAlias.hits.length >= 1);

  const searched = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    limit: 5
  });
  assert.ok(searched.hits.length >= 1);
  assert.equal(searched.hits[0]?.symbol?.symbolName, "tickServer");
  assert.equal("snippet" in (searched.hits[0] ?? {}), false);
  assert.equal("startLine" in (searched.hits[0] ?? {}), false);
  assert.equal("endLine" in (searched.hits[0] ?? {}), false);
  assert.equal("relations" in searched, false);
  assert.equal("totalApprox" in searched, false);
  assert.equal(searched.mappingApplied, "obfuscated");

  const textRegexSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tick[A-Za-z]+",
    intent: "text",
    match: "regex",
    limit: 5
  });
  assert.ok(textRegexSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/Main.java"));
  assert.equal(textRegexSearch.mappingApplied, "obfuscated");

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "net/minecraft/server/Main.java"
  });
  assert.match(file.content, /class Main/);
  assert.equal(file.mappingApplied, "obfuscated");

  const classSource = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main"
  });
  assert.equal(classSource.mode, "metadata");
  assert.equal(classSource.mappingApplied, "obfuscated");
  assert.match(classSource.sourceText, /tickServer/);
  assert.equal(classSource.provenance.target.kind, "jar");
});

test("SourceService getArtifactFile truncation preserves UTF-8 boundaries", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-get-file-utf8-"));
  const binaryJarPath = join(root, "utf8.jar");
  const sourcesJarPath = join(root, "utf8-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/Utf8.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "com/example/Utf8.java": "public class Utf8 { String s = \"é漢😀\"; }"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const full = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "com/example/Utf8.java"
  });
  const cleanBoundaryBytes = Buffer.byteLength("public class Utf8 { String s = \"é漢", "utf8");
  const targetBytes = cleanBoundaryBytes + 2;
  assert.ok(targetBytes < full.contentBytes);

  const truncated = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "com/example/Utf8.java",
    maxBytes: targetBytes
  });

  assert.equal(truncated.truncated, true);
  assert.equal(Buffer.byteLength(truncated.content, "utf8"), cleanBoundaryBytes);
  assert.ok(Buffer.byteLength(truncated.content, "utf8") < targetBytes);
  assert.doesNotMatch(truncated.content, /�/);
  assert.equal(Buffer.from(truncated.content, "utf8").toString("utf8"), truncated.content);
});

test("SourceService getClassSource falls back to sibling binary artifact when source jar coverage is partial", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-fallback-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "dhl.java": [
      "public class dhl {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {",
      "  public void use() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "mojang"
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "mojang"
  });

  assert.match(source.sourceText, /class Item/);
  assert.ok(source.warnings.some((warning) => warning.includes("Falling back to binary artifact")));
});

test("SourceService targetKind=jar handles representative sibling sources-jar adoption rules", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type JarSiblingFixture = {
    binaryJarPath: string;
    root: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createJarSiblingFixture(input: {
    rootPrefix: string;
    extraSourcesJars: Array<{ fileName: string; entries: Record<string, string> }>;
  }): Promise<JarSiblingFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, "a.jar");
    await createJar(binaryJarPath, {
      "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });

    for (const sourceJar of input.extraSourcesJars) {
      await createJar(join(root, sourceJar.fileName), sourceJar.entries);
    }

    return {
      binaryJarPath,
      root,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<JarSiblingFixture>;
    run: (fixture: JarSiblingFixture) => Promise<void>;
  }> = [
    {
      name: "does not adopt unrelated *-sources.jar files",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-unrelated-sources-",
          extraSourcesJars: [
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, service }) => {
        await assert.rejects(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: binaryJarPath },
              allowDecompile: false
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
        );
      }
    },
    {
      name: "only adopts <basename>-sources.jar",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-exact-sources-",
          extraSourcesJars: [
            {
              fileName: "a-sources.jar",
              entries: {
                "com/example/A.java": [
                  "package com.example;",
                  "public class A {}"
                ].join("\n")
              }
            },
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, root, service }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "jar", value: binaryJarPath }
        });

        assert.equal(resolved.origin, "local-jar");
        assert.equal(resolved.isDecompiled, false);
        assert.equal(resolved.resolvedSourceJarPath, join(root, "a-sources.jar"));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
});

test("SourceService mod APIs align missing-jar existence errors with analyze-mod-jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { analyzeModJar } = await import("../../src/mod-analyzer.ts");
  const root = await mkdtemp(join(tmpdir(), "service-mod-path-alignment-"));
  const missingJarPath = join(root, "missing.jar");

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => analyzeModJar(missingJarPath),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () => service.decompileModJar({ jarPath: missingJarPath }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () =>
      service.getModClassSource({
        jarPath: missingJarPath,
        className: "com.example.Missing"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );

  await assert.rejects(
    () =>
      service.searchModSource({
        jarPath: missingJarPath,
        query: "Missing"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );
});

test("SourceService accepts artifactAlias on findClass and getClassSource", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-canonical-"));
  const binaryJarPath = join(root, "alias-canonical.jar");
  const sourcesJarPath = join(root, "alias-canonical-sources.jar");

  await createJar(binaryJarPath, {
    "pkg/Greeter.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "pkg/Greeter.java": [
      "package pkg;",
      "public class Greeter {",
      "  public String hello() { return \"hi\"; }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });
  const alias = resolved.artifactAlias;
  assert.notEqual(alias, resolved.artifactId);

  // findClass: symbolsRepo is keyed by canonical artifact_id only; alias must
  // be normalized in the entry method or the lookup silently returns nothing.
  const findResult = service.findClass({ artifactId: alias, className: "Greeter" });
  assert.equal(findResult.total, 1);
  assert.equal(findResult.matches[0]?.qualifiedName, "pkg.Greeter");

  // getClassSource: filesRepo is keyed by canonical id too. mode=full so we
  // exercise the source-fetch path, not the metadata short-circuit.
  const sourceResult = await service.getClassSource({
    artifactId: alias,
    className: "pkg.Greeter",
    mode: "full"
  });
  assert.match(sourceResult.sourceText, /class Greeter/);
  assert.equal(sourceResult.artifactId, resolved.artifactId);
});

test("SourceService produces identical alias when the same jar is resolved through a symlink", async () => {
  const { symlink } = await import("node:fs/promises");
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-symlink-"));
  const realJarPath = join(root, "real.jar");
  const realSourcesJarPath = join(root, "real-sources.jar");
  const linkJarPath = join(root, "link-to-real.jar");

  await createJar(realJarPath, {
    "pkg/Marker.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(realSourcesJarPath, {
    "pkg/Marker.java": "package pkg;\npublic class Marker {}"
  });
  await symlink(realJarPath, linkJarPath);

  const service = new SourceService(buildTestConfig(root));
  const viaReal = await service.resolveArtifact({ target: { kind: "jar", value: realJarPath } });
  const viaLink = await service.resolveArtifact({ target: { kind: "jar", value: linkJarPath } });

  // Same canonical artifact row; alias must NOT rotate because it derives
  // from the resolver-canonical path, not the caller's raw input string.
  assert.equal(viaReal.artifactId, viaLink.artifactId);
  assert.equal(viaReal.artifactAlias, viaLink.artifactAlias);

  // The original alias must still resolve after the second call (no rotation).
  const file = await service.getArtifactFile({
    artifactId: viaReal.artifactAlias,
    filePath: "pkg/Marker.java"
  });
  assert.match(file.content, /class Marker/);
});

test("SourceService changes artifactId when source jar signature changes", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-signature-"));
  const binaryJarPath = join(root, "server-2.0.0.jar");
  const sourcesJarPath = join(root, "server-2.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const first = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java":
      "package net.minecraft.server;\npublic class Main { void afterUpdate() {} }"
  });

  const second = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });
  assert.notEqual(first.artifactId, second.artifactId);
});

test("resolve-artifact keeps the resolver's own quality flags, not just the mapping pipeline's", async () => {
  // The resolver and the mapping pipeline observe DIFFERENT things, and both
  // observations belong in the one `qualityFlags` list the caller is handed.
  // The pipeline reports what mapping did; the resolver reports what the
  // artifact turned out to be - here, a binary jar holding no `.class` entry at
  // all, which is why nothing decompiles out of it. The pipeline builds its list
  // from empty and knows nothing about that, so `resolveArtifact` must MERGE the
  // two rather than overwrite with the pipeline's.
  //
  // The whole stack runs: ingestion is NOT stubbed, so the flag is asserted on
  // the object the tool actually answers with, after the indexer has had its
  // turn at it. Stubbing `ingestIfNeeded` here would remove the only layer
  // between the resolver and the response and prove nothing about the caller.
  //
  // The fixture is a Jar-in-Jar shell: class-free like every other artifact
  // this flag describes, and the one class-free shape ingestion can currently
  // carry to a response, because it short-circuits before the decompiler.
  // A class-free jar that is NOT a shell - a mapping jar, a resource-only mod -
  // still dead-ends in ERR_DECOMPILER_FAILED inside `buildRebuiltArtifactData`
  // rather than arriving flagged; that gap lives in the indexer's decompile
  // branch, not here, and is pinned as current behaviour by
  // tests/mod/nested-jar-shell.test.ts ("resolveArtifact still fails for a
  // classless jar that is not a shell").
  const { SourceService } = await import("../../src/source-service.ts");
  const { DEFAULT_DETAIL_BY_TOOL, projectByDetail } = await import("../../src/response-utils.ts");
  const { buildInnerJarBytes, createShellJar } = await import("../helpers/nested-jar.ts");
  const root = await mkdtemp(join(tmpdir(), "service-coordinate-no-classes-"));
  // A readable, well-formed, entirely legitimate jar reached through the
  // ordinary local-m2 coordinate cascade.
  const binaryJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "no-classes",
    "1.0.0",
    "no-classes-1.0.0.jar"
  );
  await createShellJar(binaryJarPath, {
    "META-INF/jars/inner-api-1.0.0.jar": await buildInnerJarBytes({
      "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
    })
  });

  // A decompiler path that cannot exist: if anything on this path tried to
  // decompile, the resolve would fail instead of answering.
  const service = new SourceService(
    buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower-missing.jar") })
  );

  const resolved = await withGradleUserHome(join(root, "gradle-home"), () =>
    service.resolveArtifact({
      target: { kind: "coordinate", value: "com.example:no-classes:1.0.0" },
      mapping: "obfuscated"
    })
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.deepEqual(
    resolved.qualityFlags,
    ["binary-jar-no-classes", "decompiled", "shell-jar"],
    "the resolver's observation, the mapping pipeline's and the indexer's must ALL survive"
  );

  // And it survives the default projection the tool applies before answering,
  // so this is what a caller of `resolve-artifact` actually receives.
  const projected = projectByDetail(
    "resolve-artifact",
    resolved as unknown as Record<string, unknown>,
    DEFAULT_DETAIL_BY_TOOL["resolve-artifact"] ?? "summary",
    new Set<string>()
  );
  assert.deepEqual(projected.qualityFlags, ["binary-jar-no-classes", "decompiled", "shell-jar"]);
});
