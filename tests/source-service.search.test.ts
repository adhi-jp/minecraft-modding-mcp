import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import {
  readListFilesDurationMetric,
  readSearchIoMetrics,
  readSearchPathMetrics
} from "./helpers/source-service-metrics.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

async function createResolvedSearchFixture(input: {
  rootPrefix: string;
  jarBaseName: string;
  sourceEntries: Record<string, string>;
  binaryEntries?: Record<string, Buffer>;
  configOverrides?: Partial<Config>;
  mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
}): Promise<{
  service: InstanceType<(typeof import("../src/source-service.ts"))["SourceService"]>;
  resolved: Awaited<ReturnType<InstanceType<(typeof import("../src/source-service.ts"))["SourceService"]>["resolveArtifact"]>>;
}> {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
  const binaryJarPath = join(root, `${input.jarBaseName}.jar`);
  const sourcesJarPath = join(root, `${input.jarBaseName}-sources.jar`);

  await createJar(
    binaryJarPath,
    input.binaryEntries ?? {
      "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    }
  );
  await createJar(sourcesJarPath, input.sourceEntries);

  const service = new SourceService(buildTestConfig(root, input.configOverrides));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    ...(input.mapping === undefined ? {} : { mapping: input.mapping })
  });

  return { service, resolved };
}

type SearchFixture = Awaited<ReturnType<typeof createResolvedSearchFixture>>;
type SearchClassSourceCaseInput = Omit<
  Parameters<SearchFixture["service"]["searchClassSource"]>[0],
  "artifactId"
>;
type SearchClassSourceCaseResult = Awaited<
  ReturnType<SearchFixture["service"]["searchClassSource"]>
>;

test("SourceService searchClassSource returns compact hits without snippets or relations", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-defaults-"));
  const binaryJarPath = join(root, "server-search-defaults.jar");
  const sourcesJarPath = join(root, "server-search-defaults-sources.jar");

  const preLines = Array.from({ length: 12 }, (_, index) => `  int pre${index} = ${index};`);
  const postLines = Array.from({ length: 12 }, (_, index) => `  int post${index} = ${index};`);

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/world/World.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "import net.minecraft.world.World;",
      "public class Main {",
      ...preLines,
      "  void tickServer() {",
      "    World.update();",
      "  }",
      ...postLines,
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

  const searched = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    limit: 5
  });

  const tickServerHit = searched.hits.find((hit) => hit.symbol?.symbolName === "tickServer");
  assert.ok(tickServerHit);
  assert.equal("snippet" in tickServerHit, false);
  assert.equal("startLine" in tickServerHit, false);
  assert.equal("endLine" in tickServerHit, false);
  assert.equal("relations" in searched, false);
  assert.equal("totalApprox" in searched, false);
});

test("SourceService records list-files duration metric", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-list-files-metric-"));
  const binaryJarPath = join(root, "server-list-files-metric.jar");
  const sourcesJarPath = join(root, "server-list-files-metric-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const listed = await service.listArtifactFiles({
    artifactId: resolved.artifactId,
    limit: 10
  });
  assert.ok(listed.items.length >= 1);

  const metric = readListFilesDurationMetric(service);
  assert.ok(metric.count >= 1);
  assert.ok(metric.totalMs >= 0);
  assert.ok(metric.lastMs >= 0);
});

test("SourceService routes representative search queries through indexed and fallback paths", async (t) => {
  const sourceEntries = {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    String indexedNeedle = \"needleValueToken\";",
      "    String fallbackNeedle = \"needleValueToken\";",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/server/NeedlePath.java": [
      "package net.minecraft.server;",
      "public class NeedlePath {}"
    ].join("\n")
  };

  const cases: Array<{
    name: string;
    rootPrefix: string;
    jarBaseName: string;
    configOverrides?: Partial<Config>;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    search: SearchClassSourceCaseInput;
    expectedFilePath: string;
    expectedPathMetrics: { indexedHits: number; fallbackHits: number };
    expectSnippetsOmitted?: boolean;
  }> = [
    {
      name: "contains text uses indexed search",
      rootPrefix: "service-indexed-contains-text-",
      jarBaseName: "server-indexed-text",
      mapping: "obfuscated",
      search: {
        query: "needleValueToken",
        intent: "text",
        match: "contains",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/Main.java",
      expectedPathMetrics: { indexedHits: 1, fallbackHits: 0 },
      expectSnippetsOmitted: true
    },
    {
      name: "contains path uses indexed search",
      rootPrefix: "service-indexed-contains-path-",
      jarBaseName: "server-indexed-path",
      mapping: "obfuscated",
      search: {
        query: "NeedlePath",
        intent: "path",
        match: "contains",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/NeedlePath.java",
      expectedPathMetrics: { indexedHits: 1, fallbackHits: 0 },
      expectSnippetsOmitted: true
    },
    {
      name: "exact path uses indexed search",
      rootPrefix: "service-indexed-exact-path-",
      jarBaseName: "server-indexed-exact",
      mapping: "obfuscated",
      search: {
        query: "net/minecraft/server/NeedlePath.java",
        intent: "path",
        match: "exact",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/NeedlePath.java",
      expectedPathMetrics: { indexedHits: 1, fallbackHits: 0 },
      expectSnippetsOmitted: true
    },
    {
      name: "prefix path uses indexed search",
      rootPrefix: "service-indexed-prefix-path-",
      jarBaseName: "server-indexed-prefix",
      mapping: "obfuscated",
      search: {
        query: "net/minecraft/server/Needle",
        intent: "path",
        match: "prefix",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/NeedlePath.java",
      expectedPathMetrics: { indexedHits: 1, fallbackHits: 0 },
      expectSnippetsOmitted: true
    },
    {
      name: "regex text falls back to scan path",
      rootPrefix: "service-indexed-regex-fallback-",
      jarBaseName: "server-indexed-regex",
      search: {
        query: "needleValue[A-Za-z]+",
        intent: "text",
        match: "regex",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/Main.java",
      expectedPathMetrics: { indexedHits: 0, fallbackHits: 1 }
    },
    {
      name: "config can disable indexed search",
      rootPrefix: "service-indexed-disabled-",
      jarBaseName: "server-indexed-disabled",
      configOverrides: { indexedSearchEnabled: false },
      search: {
        query: "needleValueToken",
        intent: "text",
        match: "contains",
        limit: 10
      },
      expectedFilePath: "net/minecraft/server/Main.java",
      expectedPathMetrics: { indexedHits: 0, fallbackHits: 1 }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service, resolved } = await createResolvedSearchFixture({
        rootPrefix: testCase.rootPrefix,
        jarBaseName: testCase.jarBaseName,
        sourceEntries,
        configOverrides: testCase.configOverrides,
        mapping: testCase.mapping
      });

      const result = await service.searchClassSource({
        artifactId: resolved.artifactId,
        ...testCase.search
      });

      assert.ok(result.hits.some((hit) => hit.filePath === testCase.expectedFilePath));
      if (testCase.expectSnippetsOmitted === true) {
        assert.equal(result.hits.every((hit) => !("snippet" in hit)), true);
      }

      const metrics = readSearchPathMetrics(service);
      assert.deepEqual(metrics, testCase.expectedPathMetrics);
    });
  }
});

test("SourceService accumulates indexed path metrics across multiple queries on one service", async () => {
  const sourceEntries = {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    String indexedNeedle = \"needleValueToken\";",
      "  }",
      "}"
    ].join("\n"),
    "net/minecraft/server/NeedlePath.java": [
      "package net.minecraft.server;",
      "public class NeedlePath {}"
    ].join("\n")
  };

  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-indexed-accumulate-",
    jarBaseName: "server-indexed-accumulate",
    sourceEntries,
    mapping: "obfuscated"
  });

  const textSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needleValueToken",
    intent: "text",
    match: "contains",
    limit: 10
  });
  assert.ok(textSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/Main.java"));

  const pathSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "NeedlePath",
    intent: "path",
    match: "contains",
    limit: 10
  });
  assert.ok(pathSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/NeedlePath.java"));

  const metrics = readSearchPathMetrics(service);
  assert.equal(metrics.indexedHits, 2);
  assert.equal(metrics.fallbackHits, 0);
});

test("SourceService indexed search reports compact path hits and db I/O metrics", async (t) => {
  const cases: Array<{
    name: string;
    fixture: Parameters<typeof createResolvedSearchFixture>[0];
    beforeMetrics?: (service: SearchFixture["service"]) => {
      dbRoundtrips: number;
      rowsScanned: number;
      rowsReturned: number;
    };
    search: SearchClassSourceCaseInput;
    verify: (
      result: SearchClassSourceCaseResult,
      before:
        | { dbRoundtrips: number; rowsScanned: number; rowsReturned: number }
        | undefined,
      after: { dbRoundtrips: number; rowsScanned: number; rowsReturned: number }
    ) => void;
  }> = [
    {
      name: "path indexed search avoids file-content hydration for hit construction",
      fixture: {
        rootPrefix: "service-indexed-path-compact-",
        jarBaseName: "server-indexed-path-compact",
        mapping: "obfuscated",
        sourceEntries: {
          "net/minecraft/server/NeedlePath.java": [
            "package net.minecraft.server;",
            "public class NeedlePath {",
            `  // ${"x".repeat(5_000)}`,
            "  void afterLongLine() {}",
            "}"
          ].join("\n")
        }
      },
      beforeMetrics: readSearchIoMetrics,
      search: {
        query: "NeedlePath",
        intent: "path",
        match: "contains",
        limit: 10
      },
      verify: (result, before, after) => {
        const hit = result.hits.find((entry) => entry.filePath === "net/minecraft/server/NeedlePath.java");
        assert.ok(hit);
        assert.equal("snippet" in hit, false);
        assert.equal(after.dbRoundtrips - (before?.dbRoundtrips ?? 0), 1);
      }
    },
    {
      name: "indexed text search records search db I/O metrics",
      fixture: {
        rootPrefix: "service-indexed-io-metrics-",
        jarBaseName: "server-indexed-io",
        mapping: "obfuscated",
        sourceEntries: {
          "net/minecraft/server/Main.java": [
            "package net.minecraft.server;",
            "public class Main {",
            "  void tickServer() {",
            "    String token = \"indexedMetricsToken\";",
            "  }",
            "}"
          ].join("\n")
        }
      },
      search: {
        query: "indexedMetricsToken",
        intent: "text",
        match: "contains",
        limit: 10
      },
      verify: (result, _before, after) => {
        assert.ok(result.hits.length > 0);
        assert.ok(after.dbRoundtrips > 0);
        assert.ok(after.rowsScanned > 0);
        assert.ok(after.rowsReturned > 0);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service, resolved } = await createResolvedSearchFixture(testCase.fixture);
      const before = testCase.beforeMetrics?.(service);
      const result = await service.searchClassSource({
        artifactId: resolved.artifactId,
        ...testCase.search
      });
      const after = readSearchIoMetrics(service);
      testCase.verify(result, before, after);
    });
  }
});

test("SourceService can manually reindex an artifact", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-index-artifact-"));
  const binaryJarPath = join(root, "server-index-artifact.jar");
  const sourcesJarPath = join(root, "server-index-artifact-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const result = await (service as { indexArtifact: (input: { artifactId: string; force?: boolean }) => Promise<{
    artifactId: string;
    reindexed: boolean;
    reason: string;
    counts: { files: number; symbols: number; ftsRows: number };
  }> }).indexArtifact({
    artifactId: resolved.artifactId,
    force: true
  });

  assert.equal(result.artifactId, resolved.artifactId);
  assert.equal(result.reindexed, true);
  assert.equal(result.reason, "force");
  assert.ok(result.counts.files >= 1);
  assert.ok(result.counts.symbols >= 1);
  assert.ok(result.counts.ftsRows >= 1);
});

test("SourceService searchClassSource handles representative edge cases", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type SearchEdgeCaseFixture = {
    service: InstanceType<typeof SourceService>;
    artifactId: string;
  };

  function isInvalidInputError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  }

  async function createSearchEdgeCaseFixture(input: {
    rootPrefix: string;
    binaryJarName: string;
    indexedSearchEnabled?: boolean;
    sources: Record<string, string>;
  }): Promise<SearchEdgeCaseFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, input.binaryJarName);
    const sourcesJarPath = join(root, input.binaryJarName.replace(/\.jar$/, "-sources.jar"));

    await createJar(
      binaryJarPath,
      Object.fromEntries(
        Object.keys(input.sources).map((filePath) => [
          filePath.replace(/\.java$/, ".class"),
          Buffer.from([0xca, 0xfe, 0xba, 0xbe])
        ])
      )
    );
    await createJar(sourcesJarPath, input.sources);

    const service = new SourceService(
      buildTestConfig(root, {
        indexedSearchEnabled: input.indexedSearchEnabled ?? true
      })
    );
    const resolved = await service.resolveArtifact({
      target: { kind: "jar", value: binaryJarPath },
      mapping: "obfuscated"
    });

    return {
      service,
      artifactId: resolved.artifactId
    };
  }

  const filler = "x".repeat(420);
  const cases: Array<{
    name: string;
    createFixture: () => Promise<SearchEdgeCaseFixture>;
    run: (fixture: SearchEdgeCaseFixture) => Promise<void>;
  }> = [
    {
      name: "rejects symbolKind scope filters for text and path intents",
      createFixture: () =>
        createSearchEdgeCaseFixture({
          rootPrefix: "service-symbolkind-scope-",
          binaryJarName: "server-scope.jar",
          indexedSearchEnabled: false,
          sources: {
            "net/minecraft/server/Main.java": [
              "package net.minecraft.server;",
              "public class Main {",
              "  void tickServer() {",
              "    String methodToken = \"METHOD_TOKEN\";",
              "  }",
              "}"
            ].join("\n"),
            "net/minecraft/server/OnlyField.java": [
              "package net.minecraft.server;",
              "public class OnlyField {",
              "  static String fieldToken = \"FIELD_TOKEN\";",
              "}"
            ].join("\n")
          }
        }),
      run: async ({ service, artifactId }) => {
        await assert.rejects(
          () =>
            service.searchClassSource({
              artifactId,
              query: "FIELD_TOKEN",
              intent: "text",
              match: "contains",
              scope: {
                symbolKind: "method"
              },
              limit: 10
            }),
          isInvalidInputError
        );

        await assert.rejects(
          () =>
            service.searchClassSource({
              artifactId,
              query: "OnlyField.java",
              intent: "path",
              match: "contains",
              scope: {
                symbolKind: "method"
              },
              limit: 10
            }),
          isInvalidInputError
        );
      }
    },
    {
      name: "ignores cursor when search intent changes",
      createFixture: () =>
        createSearchEdgeCaseFixture({
          rootPrefix: "service-cursor-intent-mismatch-",
          binaryJarName: "server-cursor-intent.jar",
          indexedSearchEnabled: false,
          sources: {
            "net/minecraft/server/FooNeedleA.java": [
              "package net.minecraft.server;",
              "public class FooNeedleA {",
              `  String payload = "${filler}FooNeedle";`,
              "}"
            ].join("\n"),
            "net/minecraft/server/FooNeedleB.java": [
              "package net.minecraft.server;",
              "public class FooNeedleB {",
              `  String payload = "${filler}FooNeedle";`,
              "}"
            ].join("\n")
          }
        }),
      run: async ({ service, artifactId }) => {
        const textPage = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "text",
          match: "contains",
          limit: 1
        });
        assert.ok(textPage.nextCursor);

        const pathWithoutCursor = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "path",
          match: "contains",
          limit: 1
        });
        assert.equal(pathWithoutCursor.hits.length, 1);

        const pathWithForeignCursor = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "path",
          match: "contains",
          cursor: textPage.nextCursor,
          limit: 1
        });

        assert.equal(pathWithForeignCursor.hits.length, 1);
        assert.equal(pathWithForeignCursor.hits[0]?.filePath, pathWithoutCursor.hits[0]?.filePath);
      }
    },
    {
      name: "ignores cursor when queryMode changes",
      createFixture: () =>
        createSearchEdgeCaseFixture({
          rootPrefix: "service-cursor-query-mode-mismatch-",
          binaryJarName: "server-cursor-mode.jar",
          sources: {
            "net/minecraft/server/FooNeedleA.java": [
              "package net.minecraft.server;",
              "public class FooNeedleA {",
              "  String payload = \"FooNeedle at start\";",
              "}"
            ].join("\n"),
            "net/minecraft/server/FooNeedleB.java": [
              "package net.minecraft.server;",
              "public class FooNeedleB {",
              "  String payload = \"xxxxxxxxxxxxxxxxxxxx FooNeedle later\";",
              "}"
            ].join("\n")
          }
        }),
      run: async ({ service, artifactId }) => {
        const literalPage = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "text",
          match: "contains",
          queryMode: "literal",
          limit: 1
        });
        assert.ok(literalPage.nextCursor);

        const tokenWithoutCursor = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "text",
          match: "contains",
          queryMode: "token",
          limit: 1
        });
        assert.equal(tokenWithoutCursor.hits.length, 1);

        const tokenWithForeignCursor = await service.searchClassSource({
          artifactId,
          query: "FooNeedle",
          intent: "text",
          match: "contains",
          queryMode: "token",
          cursor: literalPage.nextCursor,
          limit: 1
        });

        assert.equal(tokenWithForeignCursor.hits.length, 1);
        assert.equal(tokenWithForeignCursor.hits[0]?.filePath, tokenWithoutCursor.hits[0]?.filePath);
      }
    },
    {
      name: "rejects regex queries longer than guard limit",
      createFixture: () =>
        createSearchEdgeCaseFixture({
          rootPrefix: "service-regex-guard-",
          binaryJarName: "server-regex-guard.jar",
          sources: {
            "net/minecraft/server/Main.java": [
              "package net.minecraft.server;",
              "public class Main {",
              '  String marker = "needle";',
              "}"
            ].join("\n")
          }
        }),
      run: async ({ service, artifactId }) => {
        await assert.rejects(
          () =>
            service.searchClassSource({
              artifactId,
              query: "a".repeat(201),
              intent: "text",
              match: "regex",
              limit: 20
            }),
          isInvalidInputError
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
});

test("SourceService searchClassSource translates symbol intent via queryNamespace when artifact namespace differs", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-symbol-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: {
      upsertArtifact: (value: Record<string, unknown>) => void;
    };
    filesRepo: {
      insertFilesForArtifact: (
        id: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (
        id: string,
        symbols: Array<{ filePath: string; symbolKind: string; symbolName: string; qualifiedName?: string; line: number }>
      ) => void;
    };
  };
  const timestamp = new Date().toISOString();
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-query-ns",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp
  });
  repos.filesRepo.insertFilesForArtifact("artifact-query-ns", [
    {
      filePath: "czl.java",
      content: "package czl;\npublic class czl {}",
      contentBytes: Buffer.byteLength("package czl;\npublic class czl {}", "utf8"),
      contentHash: "hash"
    }
  ]);
  repos.symbolsRepo.insertSymbolsForArtifact("artifact-query-ns", [
    {
      filePath: "czl.java",
      symbolKind: "class",
      symbolName: "czl",
      qualifiedName: "czl",
      line: 2
    }
  ]);

  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    async findMapping(request: {
      name: string;
      sourceMapping: string;
      targetMapping: string;
    }) {
      assert.equal(request.sourceMapping, "mojang");
      assert.equal(request.targetMapping, "obfuscated");
      assert.equal(request.name, "net.minecraft.world.entity.player.Player");
      return {
        resolved: true,
        status: "resolved" as const,
        resolvedSymbol: {
          kind: "class" as const,
          name: "czl.czl",
          symbol: "czl.czl"
        },
        candidates: [],
        warnings: [],
        candidateCount: 0,
        querySymbol: { kind: "class" as const, name: "", symbol: "" },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "mojang" as const,
          targetMapping: "obfuscated" as const,
          sourcePriorityApplied: "loom-first" as const
        }
      };
    }
  };

  const result = await service.searchClassSource({
    artifactId: "artifact-query-ns",
    query: "net.minecraft.world.entity.player.Player",
    intent: "symbol",
    queryNamespace: "mojang"
  });

  assert.ok(result.translatedQuery, "translatedQuery should be populated");
  assert.equal(result.translatedQuery?.original, "net.minecraft.world.entity.player.Player");
  assert.equal(result.translatedQuery?.translated, "czl.czl");
  assert.equal(result.translatedQuery?.fromNamespace, "mojang");
  assert.equal(result.translatedQuery?.toNamespace, "obfuscated");
});

test("SourceService searchClassSource does not translate when mapping result is ambiguous", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-ambiguous-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-query-ambiguous",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp: new Date().toISOString()
  });

  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    async findMapping() {
      return {
        resolved: false,
        status: "ambiguous" as const,
        candidates: [
          { kind: "class", name: "czl.czl", symbol: "czl.czl", matchKind: "name-only", confidence: 0.5 },
          { kind: "class", name: "dhl.dhl", symbol: "dhl.dhl", matchKind: "name-only", confidence: 0.4 }
        ],
        candidateCount: 2,
        warnings: [],
        querySymbol: { kind: "class", name: "", symbol: "" },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "mojang",
          targetMapping: "obfuscated",
          sourcePriorityApplied: "loom-first"
        }
      };
    }
  };

  const result = await service.searchClassSource({
    artifactId: "artifact-query-ambiguous",
    query: "net.minecraft.world.entity.player.Player",
    intent: "symbol",
    queryNamespace: "mojang"
  });

  assert.equal(result.translatedQuery, undefined, "ambiguous translation must not set translatedQuery");
  assert.ok(Array.isArray(result.warnings), "warnings should be present");
  assert.ok(
    result.warnings!.some((warning) => warning.includes("ambiguous") && warning.includes("2 candidates")),
    `should warn about ambiguity with candidate count, got: ${JSON.stringify(result.warnings)}`
  );
});

test("SourceService searchClassSource warns when queryNamespace used with intent=text", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-text-warn-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: {
      upsertArtifact: (value: Record<string, unknown>) => void;
    };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-text-warn",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp: new Date().toISOString()
  });

  const result = await service.searchClassSource({
    artifactId: "artifact-text-warn",
    query: "addAdditionalSaveData",
    intent: "text",
    queryNamespace: "mojang"
  });

  assert.ok(Array.isArray(result.warnings), "warnings should be present");
  assert.ok(
    result.warnings!.some((warning) => warning.includes("queryNamespace=mojang") && warning.includes("text")),
    `expected text-intent warning, got: ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.translatedQuery, undefined);
});

test("SourceService searchClassSource warns when queryNamespace cannot be applied because artifact has no version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-no-version-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-no-version",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    timestamp: new Date().toISOString()
  });

  const result = await service.searchClassSource({
    artifactId: "artifact-no-version",
    query: "net.minecraft.world.entity.player.Player",
    intent: "symbol",
    queryNamespace: "mojang"
  });

  assert.ok(Array.isArray(result.warnings), "warnings should be present");
  assert.ok(
    result.warnings!.some((warning) =>
      warning.includes("queryNamespace=mojang") && warning.includes("no version")
    ),
    `should warn about versionless translation skip, got: ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.translatedQuery, undefined);
});

test("SourceService searchClassSource warns when queryNamespace used with intent=path", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-path-warn-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-path-warn",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp: new Date().toISOString()
  });

  const result = await service.searchClassSource({
    artifactId: "artifact-path-warn",
    query: "net/minecraft/",
    intent: "path",
    queryNamespace: "mojang"
  });

  assert.ok(Array.isArray(result.warnings), "warnings should be present");
  assert.ok(
    result.warnings!.some((warning) => warning.includes("queryNamespace=mojang") && warning.includes("path")),
    `expected path-intent warning, got: ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.translatedQuery, undefined);
});

test("SourceService searchClassSource translated symbol query uses simple name + package scope", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-packageful-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
    filesRepo: {
      insertFilesForArtifact: (
        id: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (
        id: string,
        symbols: Array<{ filePath: string; symbolKind: string; symbolName: string; qualifiedName?: string; line: number }>
      ) => void;
    };
  };
  const timestamp = new Date().toISOString();
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-packageful-mojang",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp
  });
  const filePath = "net/minecraft/world/entity/player/Player.java";
  const content = "package net.minecraft.world.entity.player;\npublic class Player {}";
  repos.filesRepo.insertFilesForArtifact("artifact-packageful-mojang", [
    {
      filePath,
      content,
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentHash: "hash"
    }
  ]);
  repos.symbolsRepo.insertSymbolsForArtifact("artifact-packageful-mojang", [
    {
      filePath,
      symbolKind: "class",
      symbolName: "Player",
      qualifiedName: "net.minecraft.world.entity.player.Player",
      line: 2
    }
  ]);

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping() {
      return {
        resolved: true,
        status: "resolved" as const,
        resolvedSymbol: {
          kind: "class" as const,
          name: "net.minecraft.world.entity.player.Player",
          symbol: "net.minecraft.world.entity.player.Player"
        },
        candidates: [],
        warnings: [],
        candidateCount: 0,
        querySymbol: { kind: "class" as const, name: "", symbol: "" },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated" as const,
          targetMapping: "mojang" as const,
          sourcePriorityApplied: "loom-first" as const
        }
      };
    }
  };

  const result = await service.searchClassSource({
    artifactId: "artifact-packageful-mojang",
    query: "czl.czl",
    intent: "symbol",
    queryNamespace: "obfuscated"
  });

  assert.ok(result.translatedQuery, "translatedQuery should be set");
  assert.ok(result.hits.length > 0, `should return Player hit after translation; got hits=${JSON.stringify(result.hits)}`);
  assert.ok(
    result.hits.some((hit) => hit.filePath === filePath),
    `should include the Player.java file in hits; got=${JSON.stringify(result.hits)}`
  );
});

test("SourceService searchClassSource preserves caller-supplied packagePrefix during translation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-preserve-prefix-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: { upsertArtifact: (value: Record<string, unknown>) => void };
    filesRepo: {
      insertFilesForArtifact: (
        id: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (
        id: string,
        symbols: Array<{ filePath: string; symbolKind: string; symbolName: string; qualifiedName?: string; line: number }>
      ) => void;
    };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-preserve-prefix",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    artifactSignature: "sig",
    isDecompiled: false,
    version: "1.21.10",
    timestamp: new Date().toISOString()
  });
  // Two files with the same simple name but different packages; caller's
  // packagePrefix should keep only the entity match.
  const entityFile = "net/minecraft/world/entity/player/Player.java";
  const otherFile = "com/example/other/Player.java";
  repos.filesRepo.insertFilesForArtifact("artifact-preserve-prefix", [
    { filePath: entityFile, content: "x", contentBytes: 1, contentHash: "h1" },
    { filePath: otherFile, content: "x", contentBytes: 1, contentHash: "h2" }
  ]);
  repos.symbolsRepo.insertSymbolsForArtifact("artifact-preserve-prefix", [
    { filePath: entityFile, symbolKind: "class", symbolName: "Player", qualifiedName: "net.minecraft.world.entity.player.Player", line: 2 },
    { filePath: otherFile, symbolKind: "class", symbolName: "Player", qualifiedName: "com.example.other.Player", line: 2 }
  ]);

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping() {
      return {
        resolved: true,
        status: "resolved" as const,
        resolvedSymbol: {
          kind: "class" as const,
          name: "net.minecraft.world.entity.player.Player",
          symbol: "net.minecraft.world.entity.player.Player"
        },
        candidates: [],
        warnings: [],
        candidateCount: 0,
        querySymbol: { kind: "class" as const, name: "", symbol: "" },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated" as const,
          targetMapping: "mojang" as const,
          sourcePriorityApplied: "loom-first" as const
        }
      };
    }
  };

  const result = await service.searchClassSource({
    artifactId: "artifact-preserve-prefix",
    query: "czl.czl",
    intent: "symbol",
    queryNamespace: "obfuscated",
    scope: { packagePrefix: "com/example/" }
  });

  assert.ok(result.translatedQuery);
  const hitPaths = result.hits.map((hit) => hit.filePath);
  assert.equal(
    hitPaths.includes(entityFile),
    false,
    `entity path should be filtered out by caller's packagePrefix; got hits=${JSON.stringify(hitPaths)}`
  );
});
