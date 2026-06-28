import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { withGradleUserHome } from "./helpers/env.ts";
import { seedIndexedArtifact } from "./helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "./helpers/source-service-metrics.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";
import {
  type SourceServiceFixture,
  withVersionApproximationFixture
} from "./helpers/source-service-fixtures.ts";

test("SourceService text search respects exact (case-sensitive) and prefix (case-insensitive) match semantics", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-text-match-semantics-"));
  const binaryJarPath = join(root, "server-text-match.jar");
  const sourcesJarPath = join(root, "server-text-match-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      '  String marker = "UniqueTestMarker";',
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // exact match with correct case → hit
  const exactHit = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "UniqueTestMarker",
    intent: "text",
    match: "exact",
    limit: 10
  });
  assert.ok(exactHit.hits.some((h) => h.filePath === "net/minecraft/server/Main.java"));

  // exact match with wrong case → no hit (case-sensitive)
  const exactMiss = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "uniquetestmarker",
    intent: "text",
    match: "exact",
    limit: 10
  });
  assert.equal(
    exactMiss.hits.filter((h) => h.filePath === "net/minecraft/server/Main.java").length,
    0
  );

  // prefix match with wrong case → hit (case-insensitive)
  const prefixHit = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "uniquetestmarker",
    intent: "text",
    match: "prefix",
    limit: 10
  });
  assert.ok(prefixHit.hits.some((h) => h.filePath === "net/minecraft/server/Main.java"));
});

test("SourceService searchClassSource with ** glob pattern does not crash", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-glob-doublestar-"));
  const binaryJarPath = join(root, "glob-test.jar");
  const sourcesJarPath = join(root, "glob-test-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "com/example/Other.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/world/level/block/Blocks.java": [
      "package net.minecraft.world.level.block;",
      "public class Blocks {",
      "  public static final int STONE = 1;",
      "}"
    ].join("\n"),
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void start() {}",
      "}"
    ].join("\n"),
    "com/example/Other.java": [
      "package com.example;",
      "public class Other {",
      "  void run() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // ** glob should not throw (previously caused SyntaxError: Nothing to repeat)
  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "class",
    intent: "text",
    match: "contains",
    scope: {
      fileGlob: "net/minecraft/**/*.java"
    },
    limit: 10
  });

  // Should only return files matching the glob (net/minecraft/...), not com/example/
  assert.ok(result.hits.length >= 1);
  for (const hit of result.hits) {
    assert.ok(
      hit.filePath.startsWith("net/minecraft/"),
      `Expected hit in net/minecraft/ but got ${hit.filePath}`
    );
  }
});

test("SourceService validateMixin reuses class mapping lookups across batch entries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-batch-cache-"));
  const sourceA = join(root, "MainMixinA.java");
  const sourceB = join(root, "MainMixinB.java");
  const jarPath = join(root, "client.jar");
  const mixinSource = [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    "@Mixin(Main.class)",
    "public abstract class MainMixin {}"
  ].join("\n");

  await writeFile(sourceA, mixinSource, "utf8");
  await writeFile(sourceB, mixinSource.replace("MainMixin", "SecondMainMixin"), "utf8");
  await createJar(jarPath, {});

  const service = new SourceService(buildTestConfig(root));
  let classMappingLookups = 0;

  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).mappingService = {
    async checkMappingHealth() {
      return {
        mojangMappingsAvailable: true,
        tinyMappingsAvailable: true,
        memberRemapAvailable: true,
        degradations: []
      };
    },
    async findMapping(input: {
      kind?: "class" | "field" | "method";
      sourceMapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
      targetMapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    }) {
      if (input.kind === "class" && input.sourceMapping === "mojang" && input.targetMapping === "obfuscated") {
        classMappingLookups += 1;
      }
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: { name: "a" },
        candidates: []
      };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "a",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "paths",
      paths: [sourceA, sourceB]
    },
    version: "1.21",
    mapping: "mojang"
  } as never);

  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.processingErrors, 0);
  assert.equal(result.results[0]?.result?.valid, true);
  assert.equal(result.results[1]?.result?.valid, true);
  assert.equal(classMappingLookups, 1);
});

test("SourceService getClassSource rejects package-incompatible fallback matches", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-pkg-compat-"));
  const binaryJarPath = join(root, "pkg-compat.jar");
  const sourcesJarPath = join(root, "pkg-compat-sources.jar");

  // Tags.java contains an inner class named "Blocks", but lives in a different package.
  // When requesting net.minecraft.world.level.block.Blocks, the service should NOT
  // return Tags.java just because it contains a symbol named "Blocks".
  await createJar(binaryJarPath, {
    "net/neoforged/neoforge/common/Tags.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/neoforged/neoforge/common/Tags.java": [
      "package net.neoforged.neoforge.common;",
      "public class Tags {",
      "  public static class Blocks {",
      "    public static final String STONE = \"stone\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // Requesting a class from a completely different package should fail with
  // CLASS_NOT_FOUND rather than returning the wrong file
  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        className: "net.minecraft.world.level.block.Blocks"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.CLASS_NOT_FOUND
      );
    }
  );
});

test("SourceService getClassSource accepts canonical inner-class dot notation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-inner-class-dot-"));
  const binaryJarPath = join(root, "inner-class.jar");
  const sourcesJarPath = join(root, "inner-class-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/Outer.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "com/example/Outer$Inner.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "com/example/Outer.java": [
      "package com.example;",
      "public class Outer {",
      "  public static class Inner {",
      "    public static final String VALUE = \"ok\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "com.example.Outer.Inner"
  });

  assert.match(source.sourceText, /class Outer/);
  assert.match(source.sourceText, /class Inner/);
});

test("SourceService resolveArtifact returns sampleEntries for source JAR", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-sample-entries-"));
  const binaryJarPath = join(root, "server-1.0.0.jar");
  const sourcesJarPath = join(root, "server-1.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}",
    "net/minecraft/world/World.java": "package net.minecraft.world;\npublic class World {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated",
    includeSampleEntries: true
  });

  assert.ok(resolved.sampleEntries);
  assert.ok(resolved.sampleEntries.length >= 2);
  assert.ok(resolved.sampleEntries.some((entry: string) => entry.endsWith(".java")));
});

test("SourceService resolveArtifact returns undefined sampleEntries for decompile-only", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-sample-entries-none-"));
  const binaryJarPath = join(root, "nosource.jar");

  await createJar(binaryJarPath, {
    "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: binaryJarPath },
        allowDecompile: false
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
      );
    }
  );
});

test("resolveArtifact preserves representative suggestedCall hint variants", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ResolveArtifactHintFixture = {
    root: string;
    jarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createResolveArtifactHintFixture(input: {
    rootPrefix: string;
    jarName: string;
    jarEntries: Record<string, string | Buffer>;
  }): Promise<ResolveArtifactHintFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const jarPath = join(root, input.jarName);
    await createJar(jarPath, input.jarEntries);

    return {
      root,
      jarPath,
      service: new SourceService(buildTestConfig(root))
    };
  }

  async function expectMappingNotApplied(
    action: () => Promise<unknown>,
    verify: (details: Record<string, unknown>, suggested: { tool: string; params: Record<string, unknown> }) => void
  ): Promise<void> {
    await assert.rejects(action, (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const suggested = details.suggestedCall as
        | { tool: string; params: Record<string, unknown> }
        | undefined;
      assert.ok(suggested != null);
      verify(details, suggested);
      return true;
    });
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<ResolveArtifactHintFixture>;
    run: (fixture: ResolveArtifactHintFixture) => Promise<void>;
  }> = [
    {
      name: "preserves scope in suggestedCall when mapping fails",
      createFixture: () =>
        createResolveArtifactHintFixture({
          rootPrefix: "service-b2-scope-",
          jarName: "server-b2.jar",
          jarEntries: {
            "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          }
        }),
      run: async ({ jarPath, service }) => {
        await expectMappingNotApplied(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: jarPath },
              mapping: "mojang",
              scope: "vanilla",
              allowDecompile: false
            } as any),
          (_details, suggested) => {
            assert.equal(suggested.params.scope, "vanilla");
          }
        );
      }
    },
    {
      name: "preserves scope in intermediary no-version suggestedCall",
      createFixture: () =>
        createResolveArtifactHintFixture({
          rootPrefix: "service-b2-intermediary-",
          jarName: "demo-sources.jar",
          jarEntries: {
            "com/example/Demo.java": "package com.example;\npublic class Demo {}"
          }
        }),
      run: async ({ jarPath, service }) => {
        await expectMappingNotApplied(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: jarPath },
              mapping: "intermediary",
              scope: "merged"
            } as any),
          (_details, suggested) => {
            assert.equal(suggested.params.scope, "merged");
            assert.equal(typeof suggested.params.target, "object");
            assert.notEqual(suggested.params.target, null);
            assert.equal((suggested.params.target as { kind?: string }).kind, "version");
            assert.equal("targetKind" in suggested.params, false);
            assert.equal("targetValue" in suggested.params, false);
          }
        );
      }
    },
    {
      name: "vanilla+mojang with projectPath suggests scope=merged",
      createFixture: () =>
        createResolveArtifactHintFixture({
          rootPrefix: "service-b3-vanilla-mojang-",
          jarName: "server-b3.jar",
          jarEntries: {
            "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          }
        }),
      run: async ({ root, jarPath, service }) => {
        await expectMappingNotApplied(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: jarPath },
              mapping: "mojang",
              scope: "vanilla",
              projectPath: root,
              allowDecompile: false
            } as any),
          (details, suggested) => {
            assert.equal(suggested.params.scope, "merged");
            assert.equal(suggested.params.mapping, "mojang");
            assert.equal(typeof suggested.params.target, "object");
            assert.notEqual(suggested.params.target, null);
            assert.equal((suggested.params.target as { kind?: string; value?: string }).kind, "jar");
            assert.equal((suggested.params.target as { kind?: string; value?: string }).value, jarPath);
            assert.equal("targetKind" in suggested.params, false);
            assert.equal("targetValue" in suggested.params, false);
            assert.equal(typeof suggested.params.projectPath, "string");
            assert.equal(typeof details.nextAction, "string");
            assert.match(details.nextAction as string, /scope=vanilla blocks Loom/);
          }
        );
      }
    },
    {
      name: "vanilla+mojang without projectPath suggests mapping=obfuscated",
      createFixture: () =>
        createResolveArtifactHintFixture({
          rootPrefix: "service-b3-no-project-",
          jarName: "server-b3np.jar",
          jarEntries: {
            "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          }
        }),
      run: async ({ jarPath, service }) => {
        await expectMappingNotApplied(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: jarPath },
              mapping: "mojang",
              scope: "vanilla",
              allowDecompile: false
            } as any),
          (details, suggested) => {
            assert.equal(suggested.params.mapping, "obfuscated");
            assert.equal(suggested.params.scope, "vanilla");
            assert.equal(typeof suggested.params.target, "object");
            assert.notEqual(suggested.params.target, null);
            assert.equal((suggested.params.target as { kind?: string; value?: string }).kind, "jar");
            assert.equal((suggested.params.target as { kind?: string; value?: string }).value, jarPath);
            assert.equal("targetKind" in suggested.params, false);
            assert.equal("targetValue" in suggested.params, false);
            assert.equal(typeof details.nextAction, "string");
            assert.match(details.nextAction as string, /mapping=obfuscated/);
          }
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await testCase.createFixture();
      await testCase.run(fixture);
    });
  }
});

test("getClassSource CLASS_NOT_FOUND preserves representative context details", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ClassNotFoundFixture = {
    root: string;
    binaryJarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createClassNotFoundFixture(input: {
    rootPrefix: string;
    binaryJarName: string;
    binaryEntries: Record<string, Buffer>;
    sourceEntries: Record<string, string>;
  }): Promise<ClassNotFoundFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, input.binaryJarName);
    const sourcesJarPath = join(root, input.binaryJarName.replace(/\.jar$/, "-sources.jar"));
    await createJar(binaryJarPath, input.binaryEntries);
    await createJar(sourcesJarPath, input.sourceEntries);

    return {
      root,
      binaryJarPath,
      service: new SourceService(buildTestConfig(root))
    };
  }

  async function expectClassNotFound(
    action: () => Promise<unknown>,
    verify: (details: Record<string, unknown>) => void
  ): Promise<void> {
    await assert.rejects(action, (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.CLASS_NOT_FOUND) return false;
      verify((error as { details?: Record<string, unknown> }).details ?? {});
      return true;
    });
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<ClassNotFoundFixture>;
    run: (fixture: ClassNotFoundFixture) => Promise<void>;
  }> = [
    {
      name: "includes scope-independent artifact context and retry hints",
      createFixture: () =>
        createClassNotFoundFixture({
          rootPrefix: "service-b1-class-",
          binaryJarName: "server-b1.jar",
          binaryEntries: {
            "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          },
          sourceEntries: {
            "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
          }
        }),
      run: async ({ binaryJarPath, service }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "jar", value: binaryJarPath },
          mapping: "obfuscated"
        });

        await expectClassNotFound(
          () =>
            service.getClassSource({
              artifactId: resolved.artifactId,
              className: "net.minecraft.world.level.block.Blocks",
              mode: "full"
            }),
          (details) => {
            assert.equal(details.artifactId, resolved.artifactId);
            assert.equal(details.mapping, "obfuscated");
            assert.equal(typeof details.nextAction, "string");
            assert.ok(details.suggestedCall != null);
          }
        );
      }
    },
    {
      name: "includes target scope and explicit target coordinates",
      createFixture: () =>
        createClassNotFoundFixture({
          rootPrefix: "service-b1-target-",
          binaryJarName: "server-b1t.jar",
          binaryEntries: {
            "com/example/Existing.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          },
          sourceEntries: {
            "com/example/Existing.java": "package com.example;\npublic class Existing {}"
          }
        }),
      run: async ({ binaryJarPath, service }) => {
        await expectClassNotFound(
          () =>
            service.getClassSource({
              target: { kind: "jar", value: binaryJarPath },
              className: "com.example.Missing",
              scope: "vanilla",
              mode: "full"
            } as any),
          (details) => {
            assert.equal(details.scope, "vanilla");
            assert.equal(details.targetKind, "jar");
            assert.equal(details.targetValue, binaryJarPath);
          }
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await testCase.createFixture();
      await testCase.run(fixture);
    });
  }
});

test("resolveArtifact flags representative version-approximated mismatches", { concurrency: false }, async (t) => {
  const cases: Array<{
    name: string;
    rootPrefix: string;
    requestedVersion: string;
    loomSourceVersion: string;
    verify: (resolved: { qualityFlags: string[]; warnings: string[] }) => void;
  }> = [
    {
      name: "source jar version mismatch marks result as approximated",
      rootPrefix: "service-b4-approx-",
      requestedVersion: "1.21.11",
      loomSourceVersion: "1.21.10",
      verify: (resolved) => {
        assert.ok(
          resolved.qualityFlags.includes("version-approximated"),
          `Expected version-approximated flag, got: ${JSON.stringify(resolved.qualityFlags)}`
        );
        assert.ok(
          resolved.warnings.some((w) => w.includes("1.21.11") && w.includes("does not contain exact version")),
          `Expected version approximation warning, got: ${JSON.stringify(resolved.warnings)}`
        );
      }
    },
    {
      name: "prefix-substring version mismatch still marks result as approximated",
      rootPrefix: "service-b4-prefix-",
      requestedVersion: "1.21.1",
      loomSourceVersion: "1.21.10",
      verify: (resolved) => {
        assert.ok(
          resolved.qualityFlags.includes("version-approximated"),
          `Expected version-approximated flag for prefix mismatch, got: ${JSON.stringify(resolved.qualityFlags)}`
        );
        assert.ok(
          resolved.warnings.some((w) => w.includes('Requested version "1.21.1"')),
          `Expected version approximation warning, got: ${JSON.stringify(resolved.warnings)}`
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withVersionApproximationFixture(
        {
          rootPrefix: testCase.rootPrefix,
          requestedVersion: testCase.requestedVersion,
          loomSourceVersion: testCase.loomSourceVersion
        },
        async ({ service, projectPath }) => {
          const resolved = await service.resolveArtifact({
            target: { kind: "version", value: testCase.requestedVersion },
            mapping: "mojang",
            projectPath
          } as any);
          testCase.verify(resolved);
        }
      );
    });
  }
});

test("F-01: resolveArtifact handles strictVersion for approximated version results", { concurrency: false }, async (t) => {
  const cases: Array<{
    name: string;
    rootPrefix: string;
    verify: (args: { service: SourceServiceFixture; projectPath: string }) => Promise<void>;
  }> = [
    {
      name: "strictVersion=true throws on version mismatch",
      rootPrefix: "service-f01-strict-",
      verify: async ({ service, projectPath }) => {
        await assert.rejects(
          () =>
            service.resolveArtifact({
              target: { kind: "version", value: "1.21.11" },
              mapping: "mojang",
              projectPath,
              strictVersion: true
            } as any),
          (error: any) => {
            assert.equal(error.code, ERROR_CODES.VERSION_NOT_FOUND);
            assert.match(String(error.message), /Strict version match failed/);
            assert.equal(error.details.requestedVersion, "1.21.11");
            assert.ok(error.details.suggestedCall);
            assert.equal(error.details.suggestedCall.tool, "resolve-artifact");
            return true;
          }
        );
      }
    },
    {
      name: "strictVersion=false still returns version-approximated flag",
      rootPrefix: "service-f01-lax-",
      verify: async ({ service, projectPath }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "version", value: "1.21.11" },
          mapping: "mojang",
          projectPath,
          strictVersion: false
        } as any);
        assert.ok(
          resolved.qualityFlags.includes("version-approximated"),
          `Expected version-approximated flag, got: ${JSON.stringify(resolved.qualityFlags)}`
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withVersionApproximationFixture(
        {
          rootPrefix: testCase.rootPrefix,
          requestedVersion: "1.21.11",
          loomSourceVersion: "1.21.10"
        },
        testCase.verify
      );
    });
  }
});

test("F-03: search-class-source handles representative queryMode behavior for separator queries", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type SearchQueryModeFixture = {
    service: InstanceType<typeof SourceService>;
    artifactId: string;
  };

  const separatorQueryFixtureContent = [
    "package net.minecraft.commands;",
    "public class CommandDispatcher {",
    "  public void register() {",
    '    dispatcher.register(literal("test"));',
    "  }",
    "}"
  ].join("\n");

  async function createSearchQueryModeFixture(
    rootPrefix: string,
    configOverrides: Partial<Config> = {}
  ): Promise<SearchQueryModeFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const service = new SourceService(buildTestConfig(root, configOverrides));
    const jarPath = join(root, "test-sources.jar");

    await createJar(jarPath, {
      "net/minecraft/commands/CommandDispatcher.java": separatorQueryFixtureContent
    });

    const resolved = await service.resolveArtifact({
      target: { kind: "jar", value: jarPath }
    } as any);

    return {
      service,
      artifactId: resolved.artifactId
    };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    configOverrides?: Partial<Config>;
    run: (fixture: SearchQueryModeFixture) => Promise<void>;
  }> = [
    {
      name: "queryMode=auto keeps separator queries on the indexed path",
      rootPrefix: "service-f03-auto-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "auto"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "auto mode should find separator-containing query through indexed search");
        assert.equal("totalApprox" in result, false);
        assert.equal(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits, 0);
        assert.ok(afterPathMetrics.indexedHits - beforePathMetrics.indexedHits >= 1);
        assert.equal(afterModeMetrics.autoCount - beforeModeMetrics.autoCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 0);
      }
    },
    {
      name: "queryMode=token resolves separator query through normalized indexed lookup",
      rootPrefix: "service-f03-token-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "token"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "token mode should find separator-containing query through the indexed path");
        assert.equal(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits, 0);
        assert.ok(afterPathMetrics.indexedHits - beforePathMetrics.indexedHits >= 1);
        assert.equal(afterModeMetrics.tokenCount - beforeModeMetrics.tokenCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 0);
      }
    },
    {
      name: "queryMode=token does not fallback when indexed search is disabled",
      rootPrefix: "service-f03-token-no-index-",
      configOverrides: { indexedSearchEnabled: false },
      run: async ({ service, artifactId }) => {
        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "token"
        });
        assert.equal(result.hits.length, 0, "token mode should not fallback to literal scan when indexed search is disabled");
      }
    },
    {
      name: "queryMode=literal forces substring scan",
      rootPrefix: "service-f03-literal-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "literal"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "literal mode should find via substring scan");
        assert.ok(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits >= 1);
        assert.equal(afterModeMetrics.literalCount - beforeModeMetrics.literalCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 1);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createSearchQueryModeFixture(testCase.rootPrefix, testCase.configOverrides);
      await testCase.run(fixture);
    });
  }
});

test("target.kind=jar preserves ERR_JAR_NOT_FOUND across representative entry points", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type MissingJarFixture = {
    missingJarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createMissingJarFixture(rootPrefix: string): Promise<MissingJarFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    return {
      missingJarPath: join(root, "missing.jar"),
      service: new SourceService(buildTestConfig(root))
    };
  }

  async function expectJarNotFound(action: () => Promise<unknown>): Promise<void> {
    await assert.rejects(action, (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.JAR_NOT_FOUND);
      assert.match(String((error as { message?: string }).message), /missing\.jar/);
      return true;
    });
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    run: (fixture: MissingJarFixture) => Promise<void>;
  }> = [
    {
      name: "resolveArtifact maps missing target.kind=jar paths to ERR_JAR_NOT_FOUND",
      rootPrefix: "service-missing-jar-resolve-",
      run: async ({ missingJarPath, service }) => {
        await expectJarNotFound(() =>
          service.resolveArtifact({
            target: { kind: "jar", value: missingJarPath }
          } as any)
        );
      }
    },
    {
      name: "getClassSource preserves ERR_JAR_NOT_FOUND for missing target.kind=jar paths",
      rootPrefix: "service-missing-jar-source-",
      run: async ({ missingJarPath, service }) => {
        await expectJarNotFound(() =>
          service.getClassSource({
            className: "net.minecraft.world.level.block.Block",
            target: { kind: "jar", value: missingJarPath }
          } as any)
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createMissingJarFixture(testCase.rootPrefix);
      await testCase.run(fixture);
    });
  }
});
