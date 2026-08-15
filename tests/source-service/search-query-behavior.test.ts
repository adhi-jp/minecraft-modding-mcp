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
  type SourceServiceFixture,
  withVersionApproximationFixture
} from "../helpers/source-service-fixtures.ts";

test("SourceService text search respects exact (case-sensitive) and prefix (case-insensitive) match semantics", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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

test("search-class-source handles representative queryMode behavior for separator queries", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

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
