import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { withTempDir } from "../helpers/temp-dir.ts";

test("SourceService searchClassSource scopes explicit runtime namespace FQCNs even when names are identical", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");
  for (const mappingApplied of ["obfuscated", "mojang"] as const) {
    for (const queryNamespace of ["obfuscated", "mojang"] as const) {
      await t.test(`${mappingApplied} index with ${queryNamespace} query`, async () => {
        await withTempDir("search-runtime-identity-", async (root) => {
          const service = new SourceService(buildTestConfig(root));
          const filePath = "net/minecraft/world/level/Level.java";
          const otherPath = "com/example/Level.java";
          // This warm row predates runtime provenance. Namespace reporting already
          // derives its Minecraft runtime proof from the stored version context.
          seedIndexedArtifact(service, {
            artifactId: "runtime-identity", origin: "local-jar", version: "26.2",
            requestedMapping: mappingApplied, mappingApplied, qualityFlags: [],
            files: [{ filePath, content: "class Level {}" }, { filePath: otherPath, content: "class Level {}" }],
            symbols: [
              { filePath, symbolKind: "class", symbolName: "Level", qualifiedName: "net.minecraft.world.level.Level", line: 1 },
              { filePath: otherPath, symbolKind: "class", symbolName: "Level", qualifiedName: "com.example.Level", line: 1 }
            ]
          });
          const result = await service.searchClassSource({
            artifactId: "runtime-identity", query: "net.minecraft.world.level.Level", intent: "symbol", match: "exact", queryNamespace
          });
          assert.deepEqual(result.hits.map((hit) => hit.filePath), [filePath]);
          assert.equal(result.translatedQuery, undefined, "identity must not report a changed query");
          assert.ok(!result.warnings?.some((warning) => /mapping.*unavailable|no .* mapping found/i.test(warning)));
          const scoped = await service.searchClassSource({
            artifactId: "runtime-identity", query: "net.minecraft.world.level.Level", intent: "symbol", match: "exact", queryNamespace,
            scope: { packagePrefix: "com/example" }
          });
          assert.deepEqual(scoped.hits.map((hit) => hit.filePath), [otherPath], "caller package scope takes precedence");
          const literal = await service.searchClassSource({
            artifactId: "runtime-identity", query: "net.minecraft.world.level.Level", intent: "symbol", match: "exact"
          });
          assert.deepEqual(literal.hits, [], "omitted queryNamespace retains literal symbol matching");
        });
      });
    }
  }
});

test("SourceService searchClassSource trusts runtime provenance when a warm row has no version label", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  await withTempDir("search-provenance-identity-", async (root) => {
    const service = new SourceService(buildTestConfig(root));
    const filePath = "net/minecraft/world/level/Level.java";
    seedIndexedArtifact(service, {
      artifactId: "provenance-identity", origin: "local-jar", requestedMapping: "obfuscated", mappingApplied: "obfuscated", qualityFlags: [],
      provenance: { target: { kind: "version", value: "26.2" }, resolvedFrom: { version: "26.2" } },
      files: [{ filePath, content: "class Level {}" }],
      symbols: [{ filePath, symbolKind: "class", symbolName: "Level", qualifiedName: "net.minecraft.world.level.Level", line: 1 }]
    });
    const result = await service.searchClassSource({
      artifactId: "provenance-identity", query: "net.minecraft.world.level.Level", queryNamespace: "mojang", intent: "symbol", match: "exact"
    });
    assert.equal(result.mappingApplied, "mojang", "the existing reporting proof already trusts the provenance version");
    assert.deepEqual(result.hits.map((hit) => hit.filePath), [filePath]);
    assert.ok(!result.warnings?.some((warning) => /no version/.test(warning)));
  });
});

test("SourceService searchClassSource prepares an unchanged resolved FQCN for the symbol index", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  await withTempDir("search-unchanged-translation-", async (root) => {
    const service = new SourceService(buildTestConfig(root));
    const filePath = "net/minecraft/world/level/Level.java";
    seedIndexedArtifact(service, {
      artifactId: "unchanged-translation", origin: "local-jar", version: "1.21.10",
      requestedMapping: "mojang", mappingApplied: "mojang", qualityFlags: [],
      files: [{ filePath, content: "class Level {}" }],
      symbols: [{ filePath, symbolKind: "class", symbolName: "Level", qualifiedName: "net.minecraft.world.level.Level", line: 1 }]
    });
    service.mappingService.findMapping = async () => ({
      resolved: true, status: "resolved", resolvedSymbol: { kind: "class", name: "net.minecraft.world.level.Level", symbol: "net.minecraft.world.level.Level" },
      candidates: [], candidateCount: 0, warnings: [], querySymbol: { kind: "class", name: "Level", symbol: "Level" },
      mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "mojang", sourcePriorityApplied: "loom-first" }
    });
    const result = await service.searchClassSource({
      artifactId: "unchanged-translation", query: "net.minecraft.world.level.Level", queryNamespace: "obfuscated", intent: "symbol", match: "exact"
    });
    assert.deepEqual(result.hits.map((hit) => hit.filePath), [filePath]);
    assert.equal(result.translatedQuery, undefined);
  });
});

test("SourceService searchClassSource does not infer runtime namespace identity from dependency or nested jar versions", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");
  for (const fixture of [
    { name: "dependency coordinate", version: "26.2", coordinate: "org.example:library:26.2", provenance: undefined },
    { name: "library release number", version: "26.0.2", coordinate: "org.example:library:26.0.2", provenance: undefined },
    { name: "dependency", version: "26.2", provenance: { unobfuscatedRuntime: true, dependencyResolution: {}, target: { kind: "dependency", group: "org.example", name: "library", version: "26.2" } } },
    { name: "nested", version: "26.2", provenance: { unobfuscatedRuntime: true, nestedJar: { entryPath: "nested.jar" } } },
    { name: "unproven jar", version: "26.2", provenance: { target: { kind: "jar", value: "library.jar" }, resolvedFrom: {} } }
  ]) {
    await t.test(fixture.name, async () => withTempDir("search-unproven-identity-", async (root) => {
      const service = new SourceService(buildTestConfig(root));
      const filePath = "net/minecraft/world/level/Level.java";
      seedIndexedArtifact(service, {
        artifactId: "unproven", origin: "local-jar", version: fixture.version, provenance: fixture.provenance,
        requestedMapping: "obfuscated", mappingApplied: "obfuscated", qualityFlags: [],
        files: [{ filePath, content: "class Level {}" }],
        symbols: [{ filePath, symbolKind: "class", symbolName: "Level", qualifiedName: "net.minecraft.world.level.Level", line: 1 }]
      });
      if (fixture.coordinate) service.artifactsRepo.upsertArtifact({
        ...service.getArtifact("unproven"), coordinate: fixture.coordinate, timestamp: new Date().toISOString()
      });
      if (fixture.version === "26.0.2") service.mappingService.findMapping = async () => ({
        resolved: false, status: "mapping_unavailable", candidates: [], candidateCount: 0, warnings: [],
        querySymbol: { kind: "class", name: "Level", symbol: "Level" },
        mappingContext: { version: "26.0.2", sourceMapping: "mojang", targetMapping: "obfuscated", sourcePriorityApplied: "loom-first" }
      });
      const result = await service.searchClassSource({
        artifactId: "unproven", query: "net.minecraft.world.level.Level", queryNamespace: "mojang", intent: "symbol", match: "exact"
      });
      assert.deepEqual(result.hits, []);
      assert.ok(result.warnings?.some((warning) => /mapping data unavailable/.test(warning)), "unproven artifact retains real mapping-service refusal");
    }));
  }
});

test("SourceService searchClassSource translates symbol intent via queryNamespace when artifact namespace differs", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-symbol-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-query-ns",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "1.21.10",
    files: [
      {
        filePath: "czl.java",
        content: "package czl;\npublic class czl {}"
      }
    ],
    symbols: [
      {
        filePath: "czl.java",
        symbolKind: "class",
        symbolName: "czl",
        qualifiedName: "czl",
        line: 2
      }
    ]
  });

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
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-ambiguous-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-query-ambiguous",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "1.21.10",
    files: [],
    symbols: []
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
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-text-warn-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-text-warn",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "1.21.10",
    files: [],
    symbols: []
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

test("SourceService searchClassSource warns when symbol intent query is not a fully-qualified class name", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-symbol-nonfqcn-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-symbol-nonfqcn-warn",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "1.21.10",
    files: [],
    symbols: []
  });

  const result = await service.searchClassSource({
    artifactId: "artifact-symbol-nonfqcn-warn",
    query: "Level",
    intent: "symbol",
    queryNamespace: "mojang"
  });

  assert.ok(Array.isArray(result.warnings), "warnings should be present");
  assert.ok(
    result.warnings!.some((warning) => warning.includes("queryNamespace=mojang") && warning.includes("fully-qualified")),
    `expected non-FQCN symbol-intent warning, got: ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.translatedQuery, undefined);
});

test("SourceService searchClassSource warns when queryNamespace cannot be applied because artifact has no version", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-no-version-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-no-version",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [],
    symbols: []
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
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-path-warn-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "artifact-path-warn",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "1.21.10",
    files: [],
    symbols: []
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
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-packageful-"));
  const service = new SourceService(buildTestConfig(root));

  const filePath = "net/minecraft/world/entity/player/Player.java";
  const content = "package net.minecraft.world.entity.player;\npublic class Player {}";
  seedIndexedArtifact(service, {
    artifactId: "artifact-packageful-mojang",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    version: "1.21.10",
    files: [{ filePath, content }],
    symbols: [
      {
        filePath,
        symbolKind: "class",
        symbolName: "Player",
        qualifiedName: "net.minecraft.world.entity.player.Player",
        line: 2
      }
    ]
  });

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
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-preserve-prefix-"));
  const service = new SourceService(buildTestConfig(root));

  // Two files with the same simple name but different packages; caller's
  // packagePrefix should keep only the entity match.
  const entityFile = "net/minecraft/world/entity/player/Player.java";
  const otherFile = "com/example/other/Player.java";
  seedIndexedArtifact(service, {
    artifactId: "artifact-preserve-prefix",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    version: "1.21.10",
    files: [
      { filePath: entityFile, content: "x" },
      { filePath: otherFile, content: "x" }
    ],
    symbols: [
      { filePath: entityFile, symbolKind: "class", symbolName: "Player", qualifiedName: "net.minecraft.world.entity.player.Player", line: 2 },
      { filePath: otherFile, symbolKind: "class", symbolName: "Player", qualifiedName: "com.example.other.Player", line: 2 }
    ]
  });

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
