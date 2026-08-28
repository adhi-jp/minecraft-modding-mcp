import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { buildInnerJarBytes, createShellJar } from "../helpers/nested-jar.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("SourceService returns class source with line range filtering", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    int a = 1;",
      "    int b = 2;",
      "    int c = a + b;",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "full",
    startLine: 3,
    endLine: 7,
    maxLines: 3
  });

  assert.equal(source.totalLines, 8);
  assert.equal(source.returnedRange.start, 3);
  assert.equal(source.returnedRange.end, 5);
  assert.equal(source.truncated, true);
  assert.equal(source.className, "net.minecraft.server.Main");
  assert.match(source.sourceText, /void tickServer\(\)/);
  assert.match(source.sourceText, /int b = 2/);
  assert.doesNotMatch(source.sourceText, /int c = a \+ b/);
});

test("SourceService getClassSource mode='snippet' applies the 200-line default truncation with a continuation", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-snippet-default-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  // A 250-line class: line 1 = package, line 2 = class header, lines 3..249 =
  // `int fieldN = N;` (field0 on line 3 ... field197 on line 200), line 250 = }.
  const lines = [
    "package net.minecraft.server;",
    "public class Main {",
    ...Array.from({ length: 247 }, (_, i) => `  int field${i} = ${i};`),
    "}"
  ];

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": lines.join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "snippet"
  });

  assert.equal(source.mode, "snippet");
  assert.equal(source.totalLines, 250);
  assert.equal(source.returnedRange.start, 1);
  assert.equal(source.returnedRange.end, 200);
  assert.equal(source.truncated, true);
  assert.equal(source.nextStartLine, 201);
  // Only the first 200 lines come back: field197 (line 200) is the boundary and
  // field198 (line 201) must be withheld for the next page.
  assert.match(source.sourceText, /int field0 = 0;/);
  assert.match(source.sourceText, /int field197 = 197;/);
  assert.doesNotMatch(source.sourceText, /int field198 = 198;/);

  const suggested = source.suggestedCall as { tool?: string; params?: Record<string, unknown> } | undefined;
  assert.equal(suggested?.tool, "get-class-source");
  assert.equal(suggested?.params?.mode, "snippet");
  assert.equal(suggested?.params?.startLine, 201);
  assert.equal(suggested?.params?.maxLines, 200);
});

test("SourceService getClassSource truncation reports nextStartLine and an executable continuation suggestedCall", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-cont-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    int a = 1;",
      "    int b = 2;",
      "    int c = a + b;",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "full",
    startLine: 3,
    endLine: 7,
    maxLines: 3
  });

  assert.equal(source.truncated, true);
  assert.equal(source.returnedRange.end, 5);
  // The next complete line the caller has not yet seen.
  assert.equal(source.nextStartLine, 6);
  const suggested = source.suggestedCall as { tool?: string; params?: Record<string, unknown> } | undefined;
  assert.equal(suggested?.tool, "get-class-source");
  assert.equal(suggested?.params?.startLine, 6);
  assert.equal(suggested?.params?.className, "net.minecraft.server.Main");
  // The caller's original endLine window must be preserved so the continuation
  // does not read past line 7.
  assert.equal(suggested?.params?.endLine, 7);
  assert.deepEqual(suggested?.params?.target, {
    kind: "artifact",
    artifactId: resolved.artifactId
  });
});

test("SourceService getClassSource omits a line continuation for metadata-mode maxChars truncation", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-meta-chars-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {}",
      "  void shutdown() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  // The metadata outline is a synthesized summary, not a line window into the
  // source, so a maxChars cut must not produce a (bogus) line continuation.
  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "metadata",
    maxChars: 20
  });

  assert.equal(source.mode, "metadata");
  assert.equal(source.charsTruncated, true);
  assert.equal(source.nextStartLine, undefined);
  assert.equal(source.suggestedCall, undefined);
});

test("SourceService getClassSource omits a line continuation when maxChars cuts within the first line", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-firstline-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;", // line 1, 29 chars — longer than maxChars
      "public class Main {}",
      "int x = 1;"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  // A cut inside the first returned line cannot advance by line; resuming at the
  // same startLine with the same maxChars would loop, so emit no continuation.
  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "full",
    maxChars: 10
  });

  assert.equal(source.charsTruncated, true);
  assert.equal(source.truncated, true);
  assert.equal(source.nextStartLine, undefined);
  assert.equal(source.suggestedCall, undefined);
});

test("SourceService getClassSource maxChars truncation resumes at a safe line boundary", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-chars-"));
  const binaryJarPath = join(root, "server-3.0.0.jar");
  const sourcesJarPath = join(root, "server-3.0.0-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;", // line 1 (29 chars + newline)
      "public class Main {},,,,,,,,,,", // line 2
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // line 3
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"  // line 4
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  // Cut mid line 2: only line 1 is a complete returned line, so a safe resume
  // re-reads line 2 in full.
  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    mode: "full",
    maxChars: 40
  });

  assert.equal(source.charsTruncated, true);
  assert.equal(source.truncated, true);
  assert.equal(source.nextStartLine, 2);
  const suggested = source.suggestedCall as { params?: Record<string, unknown> } | undefined;
  assert.equal(suggested?.params?.startLine, 2);
});

test("SourceService findClass resolves qualified names even with many same-name symbols", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-find-class-qualified-"));
  const binaryJarPath = join(root, "many-main.jar");
  const sourcesJarPath = join(root, "many-main-sources.jar");

  const binaryEntries: Record<string, Buffer> = {};
  const sourceEntries: Record<string, string> = {};

  for (let i = 0; i < 30; i++) {
    const packageName = `a${String(i).padStart(2, "0")}`;
    const basePath = `${packageName}/Main`;
    binaryEntries[`${basePath}.class`] = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
    sourceEntries[`${basePath}.java`] = [
      `package ${packageName};`,
      "public class Main {}"
    ].join("\n");
  }

  binaryEntries["z/desired/Main.class"] = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
  sourceEntries["z/desired/Main.java"] = [
    "package z.desired;",
    "public class Main {",
    "  void marker() {}",
    "}"
  ].join("\n");

  await createJar(binaryJarPath, binaryEntries);
  await createJar(sourcesJarPath, sourceEntries);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const found = service.findClass({
    className: "z.desired.Main",
    artifactId: resolved.artifactId,
    limit: 20
  });

  assert.equal(found.total, 1);
  assert.equal(found.matches[0]?.qualifiedName, "z.desired.Main");
  assert.equal(found.matches[0]?.filePath, "z/desired/Main.java");
});

test("SourceService findClass pushes type symbolKinds and a bounded limit to findScopedSymbols", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-findclass-pushdown-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "pushdown-artifact",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [{ filePath: "pkg/Main.java", content: "package pkg;\npublic class Main {}" }],
    symbols: [
      { filePath: "pkg/Main.java", symbolKind: "class", symbolName: "Main", qualifiedName: "pkg.Main", line: 2 }
    ]
  });

  const captured: Array<{ symbolKinds?: string[]; limit?: number }> = [];
  const repo = (service as unknown as {
    symbolsRepo: {
      findScopedSymbols: (options: { symbolKinds?: string[]; limit?: number }) => unknown;
    };
  }).symbolsRepo;
  const original = repo.findScopedSymbols.bind(repo);
  repo.findScopedSymbols = (options) => {
    captured.push({ symbolKinds: options.symbolKinds, limit: options.limit });
    return original(options);
  };

  // Unqualified branch and qualified branch must BOTH push the kind filter to SQL
  // and bound the over-fetch at limit*5 (not the old hard-coded 5000).
  service.findClass({ className: "Main", artifactId: "pushdown-artifact", limit: 7 });
  service.findClass({ className: "pkg.Main", artifactId: "pushdown-artifact", limit: 7 });

  assert.equal(captured.length, 2);
  for (const call of captured) {
    assert.deepEqual(call.symbolKinds, ["class", "interface", "enum", "record"]);
    assert.equal(call.limit, 35);
  }
});

test("SourceService findClass resolves a qualified inner-class name to its outer file", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-find-class-inner-"));
  const binaryJarPath = join(root, "inner.jar");
  const sourcesJarPath = join(root, "inner-sources.jar");

  await createJar(binaryJarPath, {
    "a/b/Outer.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "a/b/Outer$Inner.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "a/b/Outer.java": [
      "package a.b;",
      "public class Outer {",
      "  public static class Inner {",
      "    void marker() {}",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const inner = service.findClass({ className: "a.b.Outer.Inner", artifactId: resolved.artifactId });
  assert.equal(inner.total, 1, `inner-class lookup should resolve, got ${JSON.stringify(inner.matches)}`);
  assert.equal(inner.matches[0]?.qualifiedName, "a.b.Outer.Inner");
  assert.equal(inner.matches[0]?.filePath, "a/b/Outer.java");

  // The outer class must still resolve unchanged.
  const outer = service.findClass({ className: "a.b.Outer", artifactId: resolved.artifactId });
  assert.equal(outer.matches[0]?.qualifiedName, "a.b.Outer");
  assert.equal(outer.matches[0]?.filePath, "a/b/Outer.java");
});

test("SourceService findClass warns when obfuscated mapping is queried with deobfuscated class names", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-findclass-namespace-warning-"));
  const sourceJarPath = join(root, "obfuscated-sources.jar");

  await createJar(sourceJarPath, {
    "dhl.java": "public class dhl {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  const result = service.findClass({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    limit: 10
  });

  assert.equal(result.matches.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("obfuscated runtime names")));
  assert.ok(result.warnings.some((warning) => warning.includes("mapping=\"mojang\"")));
});

test("SourceService findClass does not label a native dependency miss as Minecraft obfuscation", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-findclass-dependency-warning-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "native-dependency",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: ["dependency-mapping-unverified"],
    files: [],
    symbols: [],
    provenance: {
      target: { kind: "coordinate", value: "com.example:fixture-lib:1.0.0" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-m2",
        coordinate: "com.example:fixture-lib:1.0.0"
      },
      transformChain: [],
      dependencyResolution: {
        group: "com.example",
        name: "fixture-lib",
        resolvedVersion: "1.0.0",
        source: "gradle.properties:fixture_lib_version",
        cacheHit: false
      }
    }
  });

  const result = service.findClass({
    artifactId: "native-dependency",
    className: "MissingApi"
  });

  assert.equal(result.total, 0);
  assert.ok(result.warnings.every((warning) => !warning.includes("obfuscated runtime names")));
});

// The find-class miss above is guarded; the get-class-source miss was not, and
// the two answered the same artifact differently. A native dependency reaches
// `mappingApplied: "obfuscated"` by SUBSTITUTION -- the mapping pipeline declined
// and the resolver stamped the namespace anyway -- so its class names are the
// library's own and no Mojang mapping exists to look them up in. The hint's
// name test only asks for a capitalized simple name, so an ordinary library
// class qualifies and the caller was told to remap a jar that was never
// obfuscated instead of being told the class is absent.
test("SourceService getClassSource does not blame Minecraft obfuscation for a native dependency miss", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-getclasssource-dependency-hint-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "native-dependency-source",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: ["dependency-mapping-unverified"],
    files: [],
    symbols: [],
    provenance: {
      target: { kind: "coordinate", value: "com.example:fixture-lib:1.0.0" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-m2",
        coordinate: "com.example:fixture-lib:1.0.0"
      },
      transformChain: [],
      dependencyResolution: {
        group: "com.example",
        name: "fixture-lib",
        resolvedVersion: "1.0.0",
        source: "gradle.properties:fixture_lib_version",
        cacheHit: false
      }
    }
  });

  const caught = await service
    .getClassSource({
      artifactId: "native-dependency-source",
      className: "GameTest",
      mode: "full"
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  const details = (caught as { code?: string; details?: { nextAction?: string } } | undefined);
  assert.equal(details?.code, ERROR_CODES.CLASS_NOT_FOUND);
  const nextAction = details?.details?.nextAction ?? "";
  assert.ok(nextAction.includes("find-class"), "the miss must still route the caller to find-class");
  assert.ok(
    !nextAction.includes("indexed in obfuscated runtime names"),
    `a native dependency miss must not advise remapping; got: ${nextAction}`
  );
});

test("SourceService getClassSource rejects representative invalid input combinations", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type ClassSourceInvalidFixture = {
    binaryJarPath: string;
    resolvedArtifactId: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createClassSourceInvalidFixture(rootPrefix: string): Promise<ClassSourceInvalidFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const binaryJarPath = join(root, "server.jar");
    const sourcesJarPath = join(root, "server-sources.jar");

    await createJar(binaryJarPath, {
      "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });
    await createJar(sourcesJarPath, {
      "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
    });

    const service = new SourceService(buildTestConfig(root));
    const resolved = await service.resolveArtifact({
      target: { kind: "jar", value: binaryJarPath }
    });

    return {
      binaryJarPath,
      resolvedArtifactId: resolved.artifactId,
      service
    };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    run: (fixture: ClassSourceInvalidFixture) => Promise<void>;
  }> = [
    {
      name: "rejects invalid class source line range",
      rootPrefix: "service-range-invalid-",
      run: async ({ resolvedArtifactId, service }) => {
        await assert.rejects(
          () =>
            service.getClassSource({
              artifactId: resolvedArtifactId,
              className: "net.minecraft.server.Main",
              startLine: 10,
              endLine: 2
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.INVALID_LINE_RANGE
        );
      }
    },
    {
      name: "rejects getClassSource when artifactId and target are both provided",
      rootPrefix: "service-class-source-exclusive-",
      run: async ({ binaryJarPath, resolvedArtifactId, service }) => {
        await assert.rejects(
          () =>
            service.getClassSource({
              artifactId: resolvedArtifactId,
              target: {
                kind: "jar",
                value: binaryJarPath
              },
              className: "net.minecraft.server.Main"
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await createClassSourceInvalidFixture(testCase.rootPrefix));
    });
  }
});

test("SourceService getClassMembers rejects representative unresolved preconditions", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  const cases: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [
    {
      name: "rejects non-obfuscated mapping without version",
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), "service-members-map-"));
        const binaryJarPath = join(root, "server-members.jar");
        const sourcesJarPath = join(root, "server-members-sources.jar");

        await createJar(binaryJarPath, {
          "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
        });
        await createJar(sourcesJarPath, {
          "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
        });

        const service = new SourceService(buildTestConfig(root));
        const resolved = await service.resolveArtifact({
          target: {
            kind: "jar",
            value: binaryJarPath
          }
        });

        await assert.rejects(
          () =>
            (service as unknown as {
              getClassMembers: (input: {
                artifactId: string;
                className: string;
                mapping: "mojang";
              }) => Promise<unknown>;
            }).getClassMembers({
              artifactId: resolved.artifactId,
              className: "net.minecraft.server.Main",
              mapping: "mojang"
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.MAPPING_NOT_APPLIED
        );
      }
    },
    {
      name: "rejects source-only artifacts without binary jar",
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), "service-members-source-only-"));
        const coordinate = "com.example:demo:1.0.0";
        const sourceJarPath = join(
          root,
          "m2",
          "com",
          "example",
          "demo",
          "1.0.0",
          "demo-1.0.0-sources.jar"
        );
        await createJar(sourceJarPath, {
          "com/example/Demo.java": [
            "package com.example;",
            "public class Demo {}"
          ].join("\n")
        });

        const service = new SourceService(buildTestConfig(root));
        const resolved = await service.resolveArtifact({
          target: {
            kind: "coordinate",
            value: coordinate
          }
        });

        await assert.rejects(
          () =>
            (service as unknown as {
              getClassMembers: (input: {
                artifactId: string;
                className: string;
              }) => Promise<unknown>;
            }).getClassMembers({
              artifactId: resolved.artifactId,
              className: "com.example.Demo"
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.CONTEXT_UNRESOLVED
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run();
    });
  }
});

// `issueOrigin` is derived from the error CODE alone, and ERR_CONTEXT_UNRESOLVED
// is classified `code_issue` because it also covers real caller mistakes (naming
// a version no artifact carries). This site is not one of those: the artifact was
// resolved by the TOOL, and whether it carries a binary jar is not something the
// request can express. Published as caller-fixable, it invites an agent to keep
// re-sending an input that was never at fault. The per-throw-site override fixes
// this ONE site; the code-keyed default map must stay exactly as it was.
test("a members lookup on an artifact with no binary jar is published as a tool issue", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { mapErrorToProblem } = await import("../../src/tool-guidance.ts");
  const { issueOriginForErrorCode } = await import("../../src/error-mapping.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-no-binary-origin-"));
  const sourceJarPath = join(root, "source-only.jar");
  await createJar(sourceJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "source-only-artifact",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    sourceJarPath,
    files: [{ filePath: "com/example/Demo.java", content: "package com.example;\npublic class Demo {}" }],
    symbols: []
  });

  const caught = await (service as unknown as {
    getClassMembers: (input: { artifactId: string; className: string }) => Promise<unknown>;
  })
    .getClassMembers({ artifactId: "source-only-artifact", className: "com.example.Demo" })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  assert.equal((caught as { code?: string } | undefined)?.code, ERROR_CODES.CONTEXT_UNRESOLVED);

  const problem = mapErrorToProblem(caught, "members-no-binary-req") as {
    code: string;
    issueOrigin: string;
    context?: Record<string, unknown>;
  };
  assert.equal(problem.code, ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(
    problem.issueOrigin,
    "tool_issue",
    "a missing binary jar on a tool-resolved artifact is not something the caller's input can fix"
  );
  // The override is per-error only: the code-keyed default is untouched, so the
  // sibling caller-error sites keep classifying as code_issue.
  assert.equal(issueOriginForErrorCode(ERROR_CODES.CONTEXT_UNRESOLVED), "code_issue");
  // The override key must not ride out in the public primitive context blob.
  assert.equal(problem.context?.issueOrigin, undefined);
});

test("SourceService getClassMembers delegates to explorer and returns member payload", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-delegate-"));
  const binaryJarPath = join(root, "server-members-delegate.jar");
  const sourcesJarPath = join(root, "server-members-delegate-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: {
      kind: "jar",
      value: binaryJarPath
    }
  });

  const explorerCalls: Array<Record<string, unknown>> = [];
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: Record<string, unknown>) {
      explorerCalls.push(input);
      return {
        constructors: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "<init>",
            javaSignature: "public Main()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "VALUE",
            javaSignature: "public static int VALUE",
            jvmDescriptor: "I",
            accessFlags: 0x0009,
            isSynthetic: false
          }
        ],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: ["explorer-warning"],
        context: {
          minecraftVersion: "1.0.0",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await (
    service as unknown as {
      getClassMembers: (input: {
        artifactId: string;
        className: string;
        access: "all";
        includeSynthetic: boolean;
        includeInherited: boolean;
        memberPattern: string;
        maxMembers: number;
      }) => Promise<{
        members: {
          constructors: unknown[];
          fields: unknown[];
          methods: unknown[];
        };
        counts: {
          constructors: number;
          fields: number;
          methods: number;
          total: number;
        };
        truncated: boolean;
        warnings: string[];
      }>;
    }
  ).getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main",
    access: "all",
    includeSynthetic: true,
    includeInherited: true,
    memberPattern: "tick",
    maxMembers: 3
  });

  assert.equal(explorerCalls.length, 1);
  assert.equal(explorerCalls[0]?.fqn, "net.minecraft.server.Main");
  assert.equal(explorerCalls[0]?.jarPath, binaryJarPath);
  assert.equal(explorerCalls[0]?.access, "all");
  assert.equal(explorerCalls[0]?.includeSynthetic, true);
  assert.equal(explorerCalls[0]?.includeInherited, true);
  assert.equal(explorerCalls[0]?.memberPattern, "tick");

  assert.equal(result.members.constructors.length, 1);
  assert.equal(result.members.fields.length, 1);
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.counts.constructors, 1);
  assert.equal(result.counts.fields, 1);
  assert.equal(result.counts.methods, 2);
  assert.equal(result.counts.total, 4);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("explorer-warning"));
});

test("SourceService getClassSource flags decompiled origin as compile-unverified", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-b3-decompiled-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "b3-decompiled",
    origin: "decompiled",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["decompiled"],
    version: "1.21.10",
    isDecompiled: true,
    files: [
      {
        filePath: "com/example/Foo.java",
        content: ["package com.example;", "public class Foo {", "  public void bar() {}", "}"].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "com/example/Foo.java",
        symbolKind: "class",
        symbolName: "Foo",
        qualifiedName: "com.example.Foo",
        line: 2
      }
    ]
  });

  const result = await service.getClassSource({
    artifactId: "b3-decompiled",
    className: "com.example.Foo",
    mode: "full"
  });

  assert.equal(result.origin, "decompiled");
  assert.ok(
    result.qualityFlags.includes("decompiled-source-signatures-unverified"),
    "decompiled source must carry the compile-unverified quality flag"
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("get-class-members")),
    "decompiled source must advise verifying signatures via get-class-members"
  );
});

test("SourceService getClassSource does not flag non-decompiled origin", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-b3-sourcejar-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "b3-sourcejar",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    version: "1.21.10",
    isDecompiled: false,
    sourceJarPath: join(root, "foo-sources.jar"),
    files: [
      {
        filePath: "com/example/Foo.java",
        content: ["package com.example;", "public class Foo {", "  public void bar() {}", "}"].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "com/example/Foo.java",
        symbolKind: "class",
        symbolName: "Foo",
        qualifiedName: "com.example.Foo",
        line: 2
      }
    ]
  });

  const result = await service.getClassSource({
    artifactId: "b3-sourcejar",
    className: "com.example.Foo",
    mode: "full"
  });

  assert.notEqual(result.origin, "decompiled");
  assert.ok(!result.qualityFlags.includes("decompiled-source-signatures-unverified"));
  assert.ok(!result.warnings.some((warning) => warning.includes("get-class-members")));
});

// ---------------------------------------------------------------------------
// Derivation vs provenance.
//
// `origin` records WHERE the bytes came from; the persisted `isDecompiled`
// flag records WHETHER the indexed text was produced by decompiling them. The
// two axes are orthogonal and disagree in practice (a Jar-in-Jar shell keeps
// the resolver's origin while ingest clears its derivation flag), so every
// derivation question must be answered from the boolean.
// ---------------------------------------------------------------------------

test("SourceService getClassSource flags decompiled text whose origin is not decompiled", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-m2-decompiled-"));
  const service = new SourceService(buildTestConfig(root));
  // Bytes came from the local m2 repository; the indexed text was produced by
  // decompiling them. Provenance "local-m2", derivation true.
  seedIndexedArtifact(service, {
    artifactId: "m2-decompiled",
    origin: "local-m2",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    version: "1.21.10",
    isDecompiled: true,
    sourceJarPath: join(root, "foo-sources.jar"),
    files: [
      {
        filePath: "com/example/Foo.java",
        content: ["package com.example;", "public class Foo {", "  public void bar() {}", "}"].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "com/example/Foo.java",
        symbolKind: "class",
        symbolName: "Foo",
        qualifiedName: "com.example.Foo",
        line: 2
      }
    ]
  });

  const result = await service.getClassSource({
    artifactId: "m2-decompiled",
    className: "com.example.Foo",
    mode: "full"
  });

  assert.equal(result.origin, "local-m2");
  assert.ok(
    result.qualityFlags.includes("decompiled-source-signatures-unverified"),
    "decompiled text must be flagged even when the origin names a repository"
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("get-class-members")),
    "decompiled text must advise verifying signatures via get-class-members"
  );
  assert.equal(
    result.artifactContents.sourceKind,
    "decompiled-binary",
    "artifactContents must describe the persisted derivation, not the origin"
  );
});

test("SourceService getClassSource does not flag an artifact whose decompiled origin outlived its persisted flag", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-shell-origin-"));
  const service = new SourceService(buildTestConfig(root));
  // The Jar-in-Jar shell shape: ingest leaves the resolver's origin alone and
  // clears isDecompiled (src/source/indexer.ts), so the persisted row pairs
  // origin "decompiled" with derivation false. The row holds no decompiled
  // source, so it must not claim unverified decompiled signatures.
  seedIndexedArtifact(service, {
    artifactId: "shell-decompiled-origin",
    origin: "decompiled",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["shell-jar"],
    version: "1.21.10",
    isDecompiled: false,
    files: [
      {
        filePath: "com/example/Foo.java",
        content: ["package com.example;", "public class Foo {", "  public void bar() {}", "}"].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "com/example/Foo.java",
        symbolKind: "class",
        symbolName: "Foo",
        qualifiedName: "com.example.Foo",
        line: 2
      }
    ]
  });

  const result = await service.getClassSource({
    artifactId: "shell-decompiled-origin",
    className: "com.example.Foo",
    mode: "full"
  });

  assert.equal(result.origin, "decompiled", "the published origin value stays untouched");
  assert.ok(
    !result.qualityFlags.includes("decompiled-source-signatures-unverified"),
    "an artifact the index records as not decompiled must not carry the decompiled flag"
  );
  assert.ok(
    !result.warnings.some((warning) => warning.includes("get-class-members")),
    "an artifact the index records as not decompiled must not warn about decompiled signatures"
  );
});

test("SourceService getClassMembers reports artifactContents from the persisted decompiled flag", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-flag-"));
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "m2-decompiled-members",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    isDecompiled: true,
    sourceJarPath: join(root, "foo-sources.jar"),
    binaryJarPath: join(root, "foo.jar"),
    files: [],
    symbols: []
  });
  stubExplorer(service, {
    methods: [
      {
        ownerFqn: "com.example.Foo",
        name: "bar",
        javaSignature: "public void bar()",
        jvmDescriptor: "()V",
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ]
  });

  const result = await service.getClassMembers({
    artifactId: "m2-decompiled-members",
    className: "com.example.Foo"
  });

  assert.equal(result.origin, "local-m2");
  assert.equal(
    result.artifactContents.sourceKind,
    "decompiled-binary",
    "the members path must describe the persisted derivation, not the origin"
  );
});

test("SourceService getClassSource takes the decompiled derivation from the inner artifact after a nested-jar redirect", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-nested-decompiled-"));
  const innerJar = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": innerJar });

  const service = new SourceService(buildTestConfig(root));
  // The shell carries no source of its own and is not decompiled.
  seedIndexedArtifact(service, {
    artifactId: "shell-outer",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: ["shell-jar"],
    isDecompiled: false,
    binaryJarPath: shellPath,
    provenance: {
      target: { kind: "jar", value: shellPath },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar", binaryJarPath: shellPath },
      transformChain: [],
      nestedJars: ["META-INF/jars/api.jar"]
    },
    files: [],
    symbols: []
  });
  // The artifact the redirect lands on: decompiled text under a repo origin.
  seedIndexedArtifact(service, {
    artifactId: "inner-decompiled",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    isDecompiled: true,
    files: [
      {
        filePath: "com/example/inner/Api.java",
        content: ["package com.example.inner;", "public class Api {", "  public void call() {}", "}"].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "com/example/inner/Api.java",
        symbolKind: "class",
        symbolName: "Api",
        qualifiedName: "com.example.inner.Api",
        line: 2
      }
    ]
  });
  // The redirect resolves the extracted nested jar; stand in for that resolve
  // so the inner artifact's own derivation is fixed by the fixture.
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "inner-decompiled",
    artifactAlias: "inner-decompiled",
    origin: "local-m2" as const,
    isDecompiled: true,
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "jar" as const, value: "api.jar" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await service.getClassSource({
    artifactId: "shell-outer",
    className: "com.example.inner.Api",
    mapping: "obfuscated",
    mode: "full"
  });

  assert.equal(result.artifactId, "inner-decompiled");
  assert.equal(result.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");
  assert.ok(result.qualityFlags.includes("nested-jar-redirect"));
  assert.ok(
    result.qualityFlags.includes("decompiled-source-signatures-unverified"),
    "the redirect must report the inner artifact's derivation, not the shell's"
  );
  assert.ok(result.warnings.some((warning) => warning.includes("get-class-members")));
});

// ---------------------------------------------------------------------------
// Nested-type reporting and ranking.
//
// Regression: the symbol extractor stores ONE qualifiedName per FILE (the
// top-level type), so a nested `ClipContext.Block` was reported as
// `net.minecraft.world.level.ClipContext` — a name that does not contain the
// searched token — AND ranked above the real
// `net.minecraft.world.level.block.Block`. Feeding match[0] into
// get-class-source then fetched the wrong class.
// ---------------------------------------------------------------------------

test("findClass reports a nested type by its own FQN and ranks the top-level match first", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { seedIndexedArtifact } = await import("../helpers/seed-artifact.ts");
  const root = await mkdtemp(join(tmpdir(), "findclass-nested-"));
  const service = new SourceService(buildTestConfig(root));
  const artifactId = "artifact-nested-ranking";

  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    version: "1.21.11",
    files: [
      {
        filePath: "net/minecraft/world/level/ClipContext.java",
        content: "package net.minecraft.world.level;\npublic class ClipContext {\n  public static enum Block {}\n}\n"
      },
      {
        filePath: "net/minecraft/world/level/block/Block.java",
        content: "package net.minecraft.world.level.block;\npublic class Block {}\n"
      }
    ],
    symbols: [
      {
        filePath: "net/minecraft/world/level/ClipContext.java",
        symbolKind: "class",
        symbolName: "ClipContext",
        qualifiedName: "net.minecraft.world.level.ClipContext",
        line: 2
      },
      {
        // The nested enum: stored under the OUTER type's qualifiedName.
        filePath: "net/minecraft/world/level/ClipContext.java",
        symbolKind: "enum",
        symbolName: "Block",
        qualifiedName: "net.minecraft.world.level.ClipContext",
        line: 3
      },
      {
        filePath: "net/minecraft/world/level/block/Block.java",
        symbolKind: "class",
        symbolName: "Block",
        qualifiedName: "net.minecraft.world.level.block.Block",
        line: 2
      }
    ]
  });

  const result = (service as unknown as {
    findClass: (input: { className: string; artifactId: string; limit?: number }) => {
      matches: Array<{ qualifiedName: string; nested?: boolean; enclosingClass?: string; symbolKind: string }>;
      total: number;
    };
  }).findClass({ className: "Block", artifactId, limit: 10 });

  assert.equal(result.total, 2);
  // Pre-fix match[0] was "net.minecraft.world.level.ClipContext".
  assert.equal(result.matches[0].qualifiedName, "net.minecraft.world.level.block.Block");
  assert.equal(result.matches[0].nested, undefined);
  assert.equal(result.matches[1].qualifiedName, "net.minecraft.world.level.ClipContext.Block");
  assert.equal(result.matches[1].nested, true);
  assert.equal(result.matches[1].enclosingClass, "net.minecraft.world.level.ClipContext");
  assert.equal(result.matches[1].symbolKind, "enum");
});

test("findClass hands back a working call when partial coverage makes the index unable to answer", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { seedIndexedArtifact } = await import("../helpers/seed-artifact.ts");
  const root = await mkdtemp(join(tmpdir(), "findclass-partial-"));
  const service = new SourceService(buildTestConfig(root));
  const artifactId = "artifact-partial-coverage";

  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    // The merged Loom source jar carries loader classes but no net/minecraft.
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.11",
    files: [{ filePath: "net/neoforged/Loader.java", content: "package net.neoforged;\npublic class Loader {}\n" }],
    symbols: [
      {
        filePath: "net/neoforged/Loader.java",
        symbolKind: "class",
        symbolName: "Loader",
        qualifiedName: "net.neoforged.Loader",
        line: 2
      }
    ]
  });

  const result = (service as unknown as {
    findClass: (input: { className: string; artifactId: string }) => {
      total: number;
      warnings: string[];
      suggestedCall?: { tool: string; params: Record<string, unknown> };
    };
  }).findClass({ className: "Item", artifactId });

  assert.equal(result.total, 0);
  assert.ok(
    result.warnings.some((warning) => warning.includes("excludes net.minecraft")),
    `expected a coverage warning, got: ${JSON.stringify(result.warnings)}`
  );
  // Pre-fix the empty result carried no machine-usable recovery route.
  assert.equal(result.suggestedCall?.tool, "get-class-source");
  assert.deepEqual(result.suggestedCall?.params.target, { kind: "artifact", artifactId });
  assert.equal(result.suggestedCall?.params.className, "Item");
});
