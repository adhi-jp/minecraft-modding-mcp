import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTestConfig } from "./helpers/test-config.ts";

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

test("SourceService searchClassSource warns when symbol intent query is not a fully-qualified class name", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-search-queryns-symbol-nonfqcn-"));
  const service = new SourceService(buildTestConfig(root));

  const repos = service as unknown as {
    artifactsRepo: {
      upsertArtifact: (value: Record<string, unknown>) => void;
    };
  };
  repos.artifactsRepo.upsertArtifact({
    artifactId: "artifact-symbol-nonfqcn-warn",
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
