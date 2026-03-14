import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { createJar } from "./helpers/zip.ts";

function buildTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    ...overrides
  };
}

async function withGradleUserHome<T>(gradleUserHome: string, fn: () => Promise<T>): Promise<T> {
  const previousGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  try {
    return await fn();
  } finally {
    if (previousGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previousGradleUserHome;
    }
  }
}

function readSearchPathMetrics(service: { getRuntimeMetrics: () => unknown }): {
  indexedHits: number;
  fallbackHits: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    indexedHits:
      typeof snapshot.search_indexed_hit_count === "number"
        ? snapshot.search_indexed_hit_count
        : -1,
    fallbackHits:
      typeof snapshot.search_fallback_count === "number"
        ? snapshot.search_fallback_count
        : -1
  };
}

function readSearchIoMetrics(service: { getRuntimeMetrics: () => unknown }): {
  dbRoundtrips: number;
  rowsScanned: number;
  rowsReturned: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    dbRoundtrips:
      typeof snapshot.search_db_roundtrips === "number"
        ? snapshot.search_db_roundtrips
        : -1,
    rowsScanned:
      typeof snapshot.search_rows_scanned === "number"
        ? snapshot.search_rows_scanned
        : -1,
    rowsReturned:
      typeof snapshot.search_rows_returned === "number"
        ? snapshot.search_rows_returned
        : -1
  };
}

function readSearchModeMetrics(service: { getRuntimeMetrics: () => unknown }): {
  autoCount: number;
  tokenCount: number;
  literalCount: number;
  explicitLiteralCount: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    autoCount:
      typeof snapshot.search_query_mode_auto_count === "number"
        ? snapshot.search_query_mode_auto_count
        : -1,
    tokenCount:
      typeof snapshot.search_query_mode_token_count === "number"
        ? snapshot.search_query_mode_token_count
        : -1,
    literalCount:
      typeof snapshot.search_query_mode_literal_count === "number"
        ? snapshot.search_query_mode_literal_count
        : -1,
    explicitLiteralCount:
      typeof snapshot.search_literal_explicit_count === "number"
        ? snapshot.search_literal_explicit_count
        : -1
  };
}

function readListFilesDurationMetric(service: { getRuntimeMetrics: () => unknown }): {
  count: number;
  totalMs: number;
  lastMs: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  const raw = snapshot.list_files_duration_ms;
  if (typeof raw !== "object" || raw === null) {
    return { count: -1, totalMs: -1, lastMs: -1 };
  }

  const metric = raw as Record<string, unknown>;
  return {
    count: typeof metric.count === "number" ? metric.count : -1,
    totalMs: typeof metric.totalMs === "number" ? metric.totalMs : -1,
    lastMs: typeof metric.lastMs === "number" ? metric.lastMs : -1
  };
}

function readCacheAccountingMetrics(service: { getRuntimeMetrics: () => unknown }): {
  cacheEntries: number;
  totalContentBytes: number;
  lru: Array<{ artifactId: string; contentBytes: number; updatedAt: string }>;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  const rawRows = Array.isArray(snapshot.cache_artifact_bytes_lru)
    ? snapshot.cache_artifact_bytes_lru
    : [];
  return {
    cacheEntries: typeof snapshot.cache_entries === "number" ? snapshot.cache_entries : -1,
    totalContentBytes:
      typeof snapshot.cache_total_content_bytes === "number"
        ? snapshot.cache_total_content_bytes
        : -1,
    lru: rawRows
      .map((row) => {
        if (typeof row !== "object" || row === null) {
          return undefined;
        }
        const asRecord = row as Record<string, unknown>;
        const artifactId = asRecord.artifact_id;
        const contentBytes = asRecord.content_bytes;
        const updatedAt = asRecord.updated_at;
        if (
          typeof artifactId !== "string" ||
          typeof contentBytes !== "number" ||
          typeof updatedAt !== "string"
        ) {
          return undefined;
        }
        return { artifactId, contentBytes, updatedAt };
      })
      .filter((row): row is { artifactId: string; contentBytes: number; updatedAt: string } => row != null)
  };
}

function seedIndexedArtifact(
  service: unknown,
  input: {
    artifactId: string;
    origin: "local-jar" | "local-m2" | "remote-repo" | "decompiled";
    requestedMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    mappingApplied: "obfuscated" | "mojang" | "intermediary" | "yarn";
    qualityFlags: string[];
    files: Array<{ filePath: string; content: string }>;
    symbols: Array<{
      filePath: string;
      symbolKind: string;
      symbolName: string;
      qualifiedName?: string;
      line: number;
    }>;
    version?: string;
    sourceJarPath?: string;
    binaryJarPath?: string;
    provenance?: Record<string, unknown>;
    isDecompiled?: boolean;
  }
): void {
  const repos = service as {
    artifactsRepo: {
      upsertArtifact: (value: {
        artifactId: string;
        origin: "local-jar" | "local-m2" | "remote-repo" | "decompiled";
        requestedMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
        mappingApplied: "obfuscated" | "mojang" | "intermediary" | "yarn";
        qualityFlags: string[];
        artifactSignature: string;
        isDecompiled: boolean;
        timestamp: string;
        version?: string;
        sourceJarPath?: string;
        binaryJarPath?: string;
        provenance?: Record<string, unknown>;
      }) => void;
    };
    filesRepo: {
      insertFilesForArtifact: (
        artifactId: string,
        files: Array<{ filePath: string; content: string; contentBytes: number; contentHash: string }>
      ) => void;
    };
    symbolsRepo: {
      insertSymbolsForArtifact: (
        artifactId: string,
        symbols: Array<{
          filePath: string;
          symbolKind: string;
          symbolName: string;
          qualifiedName?: string;
          line: number;
        }>
      ) => void;
    };
  };
  const timestamp = new Date().toISOString();
  repos.artifactsRepo.upsertArtifact({
    artifactId: input.artifactId,
    origin: input.origin,
    version: input.version,
    sourceJarPath: input.sourceJarPath,
    binaryJarPath: input.binaryJarPath,
    requestedMapping: input.requestedMapping,
    mappingApplied: input.mappingApplied,
    provenance: input.provenance,
    qualityFlags: input.qualityFlags,
    artifactSignature: `${input.artifactId}-sig`,
    isDecompiled: input.isDecompiled ?? false,
    timestamp
  });
  repos.filesRepo.insertFilesForArtifact(
    input.artifactId,
    input.files.map((file) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `${input.artifactId}:${file.filePath}`
    }))
  );
  repos.symbolsRepo.insertSymbolsForArtifact(input.artifactId, input.symbols);
}

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
type SourceServiceFixture = InstanceType<
  (typeof import("../src/source-service.ts"))["SourceService"]
>;
type SearchClassSourceCaseInput = Omit<
  Parameters<SearchFixture["service"]["searchClassSource"]>[0],
  "artifactId"
>;
type SearchClassSourceCaseResult = Awaited<
  ReturnType<SearchFixture["service"]["searchClassSource"]>
>;

type CacheFixtureArtifactInput = {
  jarBaseName: string;
  sourceEntries: Record<string, string>;
  binaryEntries?: Record<string, Buffer>;
};

type CacheFixtureArtifact = {
  jarPath: string;
  expectedContentBytes: number;
  sourceEntries: Record<string, string>;
};

type CacheAccountingRepo = {
  countArtifacts: () => number;
  totalContentBytes: () => number;
  listArtifactsByLruWithContentBytes: (
    limit: number
  ) => Array<{ artifactId: string; totalContentBytes: number; updatedAt: string }>;
};

function computeSourceEntriesBytes(sourceEntries: Record<string, string>): number {
  return Object.values(sourceEntries).reduce(
    (total, content) => total + Buffer.byteLength(content, "utf8"),
    0
  );
}

function defaultBinaryEntriesFor(sourceEntries: Record<string, string>): Record<string, Buffer> {
  const [firstSourcePath] = Object.keys(sourceEntries);
  const defaultClassPath =
    firstSourcePath?.replace(/\.java$/, ".class") ?? "net/minecraft/server/Main.class";
  return {
    [defaultClassPath]: Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  };
}

async function createCacheAccountingFixture(input: {
  rootPrefix: string;
  configOverrides?: Partial<Config>;
  artifacts: CacheFixtureArtifactInput[];
}): Promise<{
  service: SourceServiceFixture;
  artifacts: CacheFixtureArtifact[];
}> {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
  const artifacts: CacheFixtureArtifact[] = [];

  for (const artifact of input.artifacts) {
    const jarPath = join(root, `${artifact.jarBaseName}.jar`);
    const sourcesJarPath = join(root, `${artifact.jarBaseName}-sources.jar`);
    await createJar(jarPath, artifact.binaryEntries ?? defaultBinaryEntriesFor(artifact.sourceEntries));
    await createJar(sourcesJarPath, artifact.sourceEntries);
    artifacts.push({
      jarPath,
      expectedContentBytes: computeSourceEntriesBytes(artifact.sourceEntries),
      sourceEntries: artifact.sourceEntries
    });
  }

  return {
    service: new SourceService(buildTestConfig(root, input.configOverrides)),
    artifacts
  };
}

function instrumentCacheAccountingRepo(service: SourceServiceFixture): {
  counts: () => { countCalls: number; totalBytesCalls: number; lruCalls: number };
} {
  const artifactsRepo = (service as unknown as {
    artifactsRepo: CacheAccountingRepo;
  }).artifactsRepo;

  let countCalls = 0;
  let totalBytesCalls = 0;
  let lruCalls = 0;

  const originalCountArtifacts = artifactsRepo.countArtifacts.bind(artifactsRepo);
  const originalTotalContentBytes = artifactsRepo.totalContentBytes.bind(artifactsRepo);
  const originalListLru =
    artifactsRepo.listArtifactsByLruWithContentBytes.bind(artifactsRepo);

  artifactsRepo.countArtifacts = () => {
    countCalls += 1;
    return originalCountArtifacts();
  };
  artifactsRepo.totalContentBytes = () => {
    totalBytesCalls += 1;
    return originalTotalContentBytes();
  };
  artifactsRepo.listArtifactsByLruWithContentBytes = (limit: number) => {
    lruCalls += 1;
    return originalListLru(limit);
  };

  return {
    counts: () => ({ countCalls, totalBytesCalls, lruCalls })
  };
}

test("SourceService resolves/searches/reads class source through artifactId flow", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService getClassMembers uses sibling binary jar when artifact is resolved from a source jar input", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-source-input-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: sourceJarPath },
    mapping: "obfuscated"
  });

  assert.equal(resolved.binaryJarPath, binaryJarPath);

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string; fqn: string }) {
      assert.equal(input.jarPath, binaryJarPath);
      assert.equal(input.fqn, "net.minecraft.world.item.Item");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.world.item.Item",
            name: "use",
            javaSignature: "public void use()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: resolved.artifactId,
    className: "net.minecraft.world.item.Item",
    mapping: "obfuscated"
  });

  assert.equal(result.members.methods[0]?.name, "use");
});

test("SourceService getClassSource falls back to sibling binary artifact when source jar coverage is partial", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService targetKind=jar does not adopt unrelated *-sources.jar files", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-jar-unrelated-sources-"));
  const binaryJarPath = join(root, "a.jar");
  const unrelatedSourcesJarPath = join(root, "b-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(unrelatedSourcesJarPath, {
    "com/example/B.java": [
      "package com.example;",
      "public class B {}"
    ].join("\n")
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

test("SourceService targetKind=jar only adopts <basename>-sources.jar", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-jar-exact-sources-"));
  const binaryJarPath = join(root, "a.jar");
  const exactSourcesJarPath = join(root, "a-sources.jar");
  const unrelatedSourcesJarPath = join(root, "b-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(exactSourcesJarPath, {
    "com/example/A.java": [
      "package com.example;",
      "public class A {}"
    ].join("\n")
  });
  await createJar(unrelatedSourcesJarPath, {
    "com/example/B.java": [
      "package com.example;",
      "public class B {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.resolvedSourceJarPath, exactSourcesJarPath);
});

test("SourceService mod APIs align missing-jar existence errors with analyze-mod-jar", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { analyzeModJar } = await import("../src/mod-analyzer.ts");
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

test("SourceService rejects symbolKind scope filters for text and path intents", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-symbolkind-scope-"));
  const binaryJarPath = join(root, "server-scope.jar");
  const sourcesJarPath = join(root, "server-scope-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/server/OnlyField.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
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
  });

  const service = new SourceService(buildTestConfig(root, { indexedSearchEnabled: false }));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  await assert.rejects(
    () =>
      service.searchClassSource({
        artifactId: resolved.artifactId,
        query: "FIELD_TOKEN",
        intent: "text",
        match: "contains",
        scope: {
          symbolKind: "method"
        },
        limit: 10
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );

  await assert.rejects(
    () =>
      service.searchClassSource({
        artifactId: resolved.artifactId,
        query: "OnlyField.java",
        intent: "path",
        match: "contains",
        scope: {
          symbolKind: "method"
        },
        limit: 10
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );
});

test("SourceService ignores cursor when search intent changes", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-cursor-intent-mismatch-"));
  const binaryJarPath = join(root, "server-cursor-intent.jar");
  const sourcesJarPath = join(root, "server-cursor-intent-sources.jar");
  const filler = "x".repeat(420);

  await createJar(binaryJarPath, {
    "net/minecraft/server/FooNeedleA.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/server/FooNeedleB.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
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
  });

  const service = new SourceService(buildTestConfig(root, { indexedSearchEnabled: false }));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const textPage = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "text",
    match: "contains",
    limit: 1
  });
  assert.ok(textPage.nextCursor);

  const pathWithoutCursor = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "path",
    match: "contains",
    limit: 1
  });
  assert.equal(pathWithoutCursor.hits.length, 1);

  const pathWithForeignCursor = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "path",
    match: "contains",
    cursor: textPage.nextCursor,
    limit: 1
  });

  assert.equal(pathWithForeignCursor.hits.length, 1);
  assert.equal(pathWithForeignCursor.hits[0]?.filePath, pathWithoutCursor.hits[0]?.filePath);
});

test("SourceService ignores cursor when queryMode changes", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-cursor-query-mode-mismatch-"));
  const binaryJarPath = join(root, "server-cursor-mode.jar");
  const sourcesJarPath = join(root, "server-cursor-mode-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/FooNeedleA.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/server/FooNeedleB.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await createJar(sourcesJarPath, {
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
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const literalPage = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "text",
    match: "contains",
    queryMode: "literal",
    limit: 1
  });
  assert.ok(literalPage.nextCursor);

  const tokenWithoutCursor = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "text",
    match: "contains",
    queryMode: "token",
    limit: 1
  });
  assert.equal(tokenWithoutCursor.hits.length, 1);

  const tokenWithForeignCursor = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FooNeedle",
    intent: "text",
    match: "contains",
    queryMode: "token",
    cursor: literalPage.nextCursor,
    limit: 1
  });

  assert.equal(tokenWithForeignCursor.hits.length, 1);
  assert.equal(tokenWithForeignCursor.hits[0]?.filePath, tokenWithoutCursor.hits[0]?.filePath);
});

test("SourceService changes artifactId when source jar signature changes", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService evicts oldest artifacts when maxArtifacts is exceeded", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-evict-"));
  const config = buildTestConfig(root, { maxArtifacts: 1, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");

  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: first.artifactId,
        className: "a.A"
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

test("SourceService reports representative cache byte-accounting states", async (t) => {
  const cacheOneSource = "package a;\npublic class CacheOne { String token = \"one\"; }\n";
  const cacheTwoSource = "package b;\npublic class CacheTwo { String token = \"two\"; }\n";
  const alphaSource = "package a;\npublic class A { String payload = \"alpha-alpha-alpha\"; }\n";
  const betaSource = "package b;\npublic class B { String payload = \"beta-beta-beta\"; }\n";

  const cases: Array<{
    name: string;
    rootPrefix: string;
    configOverrides?: Partial<Config>;
    artifacts: CacheFixtureArtifactInput[];
    verify: (input: {
      service: SourceServiceFixture;
      artifacts: CacheFixtureArtifact[];
    }) => Promise<void>;
  }> = [
    {
      name: "tracks byte accounting across multiple artifacts",
      rootPrefix: "service-cache-accounting-",
      configOverrides: { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 },
      artifacts: [
        {
          jarBaseName: "cache-one",
          sourceEntries: { "a/CacheOne.java": cacheOneSource }
        },
        {
          jarBaseName: "cache-two",
          sourceEntries: { "b/CacheTwo.java": cacheTwoSource },
          binaryEntries: { "b/CacheTwo.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 2);
        assert.equal(
          metrics.totalContentBytes,
          artifacts[0]!.expectedContentBytes + artifacts[1]!.expectedContentBytes
        );
        assert.equal(metrics.lru.length, 2);

        const firstRow = metrics.lru.find((entry) => entry.artifactId === first.artifactId);
        const secondRow = metrics.lru.find((entry) => entry.artifactId === second.artifactId);
        assert.equal(firstRow?.contentBytes, artifacts[0]!.expectedContentBytes);
        assert.equal(secondRow?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    },
    {
      name: "keeps byte accounting consistent after maxCacheBytes eviction",
      rootPrefix: "service-evict-bytes-",
      configOverrides: {
        maxArtifacts: 10,
        maxCacheBytes: Buffer.byteLength(alphaSource, "utf8") + 1
      },
      artifacts: [
        {
          jarBaseName: "bytes-one",
          sourceEntries: { "a/A.java": alphaSource },
          binaryEntries: { "a/A.class": Buffer.from([1, 2, 3]) }
        },
        {
          jarBaseName: "bytes-two",
          sourceEntries: { "b/B.java": betaSource },
          binaryEntries: { "b/B.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        await assert.rejects(
          () =>
            service.getClassSource({
              artifactId: first.artifactId,
              className: "a.A"
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

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifacts[1]!.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, second.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        configOverrides: testCase.configOverrides,
        artifacts: testCase.artifacts
      });
      await testCase.verify(fixture);
    });
  }
});

test("SourceService updates cache accounting without rescanning repo tables", async (t) => {
  const cacheHitSource = 'package a;\npublic class CacheHit { String token = "hit"; }\n';
  const ingestSource = 'package a;\npublic class Ingest { String token = "ingest"; }\n';

  const cases: Array<{
    name: string;
    rootPrefix: string;
    artifact: CacheFixtureArtifactInput;
    verify: (input: {
      service: SourceServiceFixture;
      artifact: CacheFixtureArtifact;
    }) => Promise<void>;
  }> = [
    {
      name: "artifact cache hits avoid rescanning accounting tables",
      rootPrefix: "service-cache-hit-metrics-",
      artifact: {
        jarBaseName: "cache-hit",
        sourceEntries: { "a/CacheHit.java": cacheHitSource },
        binaryEntries: { "a/CacheHit.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });
        const repoCounters = instrumentCacheAccountingRepo(service);

        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });
      }
    },
    {
      name: "artifact ingest updates accounting incrementally",
      rootPrefix: "service-ingest-metrics-",
      artifact: {
        jarBaseName: "ingest",
        sourceEntries: { "a/Ingest.java": ingestSource },
        binaryEntries: { "a/Ingest.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        const repoCounters = instrumentCacheAccountingRepo(service);
        const resolved = await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifact.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, resolved.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifact.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service, artifacts } = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        artifacts: [testCase.artifact]
      });
      await testCase.verify({ service, artifact: artifacts[0]! });
    });
  }
});

test("RuntimeMetrics snapshots copy artifact byte accounting rows on read", async () => {
  const { RuntimeMetrics } = await import("../src/observability.ts");
  const metrics = new RuntimeMetrics();
  const lru = [
    {
      artifactId: "artifact-one",
      totalContentBytes: 12,
      updatedAt: "2026-03-14T00:00:00.000Z"
    }
  ];

  metrics.setCacheArtifactByteAccountingRef(lru);

  const first = metrics.snapshot();
  assert.deepEqual(first.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-one",
      content_bytes: 12,
      updated_at: "2026-03-14T00:00:00.000Z"
    }
  ]);

  first.cache_artifact_bytes_lru[0]!.artifact_id = "mutated";
  first.cache_artifact_bytes_lru[0]!.content_bytes = 99;
  lru[0]!.artifactId = "artifact-two";
  lru[0]!.totalContentBytes = 18;
  lru[0]!.updatedAt = "2026-03-14T00:00:01.000Z";

  const second = metrics.snapshot();
  assert.deepEqual(second.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-two",
      content_bytes: 18,
      updated_at: "2026-03-14T00:00:01.000Z"
    }
  ]);
});

test("SourceService returns class source with line range filtering", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService findClass resolves qualified names even with many same-name symbols", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService findClass warns when obfuscated mapping is queried with deobfuscated class names", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService rejects invalid class source line range", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-range-invalid-"));
  const binaryJarPath = join(root, "server-4.0.0.jar");
  const sourcesJarPath = join(root, "server-4.0.0-sources.jar");

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

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        className: "net.minecraft.server.Main",
        startLine: 10,
        endLine: 2
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_LINE_RANGE
      );
    }
  );
});

test("SourceService rejects getClassSource when artifactId and target are both provided", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-exclusive-"));
  const binaryJarPath = join(root, "server-exclusive.jar");
  const sourcesJarPath = join(root, "server-exclusive-sources.jar");

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

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        target: {
          kind: "jar",
          value: binaryJarPath
        },
        className: "net.minecraft.server.Main"
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

test("SourceService getClassMembers rejects non-obfuscated mapping without version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

  // Artifact from jar has no version, so non-obfuscated mapping should fail with MAPPING_NOT_APPLIED
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
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.MAPPING_NOT_APPLIED
      );
    }
  );
});

test("SourceService getClassMembers rejects source-only artifacts without binary jar", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.CONTEXT_UNRESOLVED
      );
    }
  );
});

test("SourceService getClassMembers delegates to explorer and returns member payload", async () => {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService resolves version target through manifest and downloads client jar", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-"));
  const remoteJarPath = join(root, "remote-client.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: {
            release: "1.21.10",
            snapshot: "1.21.11-pre1"
          },
          versions: [
            {
              id: "1.21.10",
              type: "release",
              url: "https://example.test/versions/1.21.10.json",
              time: "2026-01-01T00:00:00+00:00",
              releaseTime: "2026-01-01T00:00:00+00:00"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    if (url === "https://example.test/versions/1.21.10.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.10",
          downloads: {
            client: {
              url: "https://example.test/downloads/client-1.21.10.jar"
            }
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    if (url === "https://example.test/downloads/client-1.21.10.jar") {
      return new Response(remoteJarBytes, {
        status: 200,
        headers: {
          "content-length": String(remoteJarBytes.byteLength),
          etag: "abc123"
        }
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
    const resolved = await service.resolveArtifact({
      target: {
        kind: "version",
        value: "1.21.10"
      },
      mapping: "obfuscated"
    });

    assert.equal(resolved.version, "1.21.10");
    assert.equal(resolved.requestedMapping, "obfuscated");
    assert.equal(resolved.mappingApplied, "obfuscated");
    assert.equal(resolved.origin, "local-jar");
    assert.equal(resolved.isDecompiled, false);
    assert.equal(resolved.provenance.target.kind, "version");
    assert.equal(resolved.provenance.target.value, "1.21.10");

    const source = await service.getClassSource({
      artifactId: resolved.artifactId,
      className: "net.minecraft.server.Main"
    });
    assert.match(source.sourceText, /class Main/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

test("SourceService resolves mojang mapping for version target using workspace Loom source cache", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-workspace-"));
  const projectPath = join(root, "workspace");
  await mkdir(join(projectPath, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  const loomSourceJarPath = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "1.21.10",
    "minecraft-merged-1.21.10-sources.jar"
  );
  await createJar(loomSourceJarPath, {
    "net/minecraft/world/level/block/Blocks.java": [
      "package net.minecraft.world.level.block;",
      "public class Blocks {}"
    ].join("\n")
  });
  const loomBinaryJarPath = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "1.21.10",
    "minecraft-merged-1.21.10.jar"
  );
  await createJar(loomBinaryJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const remoteJarPath = join(root, "remote-1.21.10.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.10" },
          versions: [
            {
              id: "1.21.10",
              type: "release",
              url: "https://example.test/versions/1.21.10.json"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/versions/1.21.10.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.10",
          downloads: {
            client: { url: "https://example.test/downloads/client-1.21.10.jar" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/downloads/client-1.21.10.jar") {
      return new Response(remoteJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
    const resolved = await service.resolveArtifact({
      target: {
        kind: "version",
        value: "1.21.10"
      },
      mapping: "mojang",
      projectPath
    } as any);

    assert.equal(resolved.requestedMapping, "mojang");
    assert.equal(resolved.mappingApplied, "mojang");
    assert.equal(resolved.binaryJarPath, loomBinaryJarPath);
    assert.ok(resolved.qualityFlags.includes("source-backed"));
    assert.ok(resolved.qualityFlags.includes("source-jar-validated"));

    const source = await service.getClassSource({
      artifactId: resolved.artifactId,
      className: "net.minecraft.world.level.block.Blocks"
    });
    assert.match(source.sourceText, /class Blocks/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

test("SourceService resolveArtifact marks merged mojang sources without net.minecraft coverage as partial", { concurrency: false }, async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-partial-"));
  const projectPath = join(root, "workspace");
  const gradleUserHome = join(root, "gradle-user-home");
  const loomCacheDir = join(projectPath, ".gradle", "loom-cache", "1.21.10");
  const loomSourceJarPath = join(loomCacheDir, "minecraft-merged-1.21.10-sources.jar");
  const loomBinaryJarPath = join(loomCacheDir, "minecraft-merged-1.21.10.jar");

  await mkdir(loomCacheDir, { recursive: true });
  await mkdir(gradleUserHome, { recursive: true });
  await createJar(loomSourceJarPath, {
    "dhl.java": [
      "public class dhl {}"
    ].join("\n")
  });
  await createJar(loomBinaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  const resolved = await withGradleUserHome(gradleUserHome, () =>
    service.resolveArtifact({
      target: {
        kind: "version",
        value: "1.21.10"
      },
      mapping: "mojang",
      projectPath
    } as any)
  );

  assert.ok(resolved.qualityFlags.includes("partial-source-no-net-minecraft"));
  assert.ok(
    resolved.warnings.some((warning) => warning.includes("Source coverage does not include net.minecraft"))
  );
  assert.equal(resolved.binaryJarPath, loomBinaryJarPath);
});

test("SourceService getClassSource remaps partial-source binary fallback lookups to the fallback artifact namespace", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-partial-fallback-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");
  const provenance = {
    target: { kind: "version", value: "1.21.10" },
    resolvedAt: new Date().toISOString(),
    resolvedFrom: {
      origin: "local-jar",
      sourceJarPath,
      binaryJarPath,
      version: "1.21.10"
    },
    transformChain: ["mapping:mojang-source-backed"]
  };

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance,
    files: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        content: [
          "package net.neoforged.neoforge.capabilities;",
          "public class Capabilities {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        symbolKind: "class",
        symbolName: "Capabilities",
        qualifiedName: "net.neoforged.neoforge.capabilities.Capabilities",
        line: 2
      }
    ]
  });

  seedIndexedArtifact(service, {
    artifactId: "binary-fallback",
    origin: "decompiled",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: ["decompiled", "binary-fallback"],
    version: "1.21.10",
    binaryJarPath,
    provenance,
    isDecompiled: true,
    files: [
      {
        filePath: "dhl.java",
        content: [
          "public class dhl {",
          "  void use() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "dhl.java",
        symbolKind: "class",
        symbolName: "dhl",
        qualifiedName: "dhl",
        line: 1
      }
    ]
  });

  (service as unknown as { resolveBinaryFallbackArtifact: unknown }).resolveBinaryFallbackArtifact = async () => ({
    artifactId: "binary-fallback",
    artifactSignature: "binary-fallback-sig",
    origin: "decompiled" as const,
    binaryJarPath,
    version: "1.21.10",
    requestedMapping: "mojang" as const,
    mappingApplied: "obfuscated" as const,
    provenance,
    qualityFlags: ["decompiled", "binary-fallback"],
    isDecompiled: true,
    resolvedAt: new Date().toISOString()
  });

  const mappingCalls: Array<Record<string, unknown>> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: Record<string, unknown>) {
      mappingCalls.push(input);
      if (
        input.kind === "class" &&
        input.name === "net.minecraft.world.item.Item" &&
        input.sourceMapping === "mojang" &&
        input.targetMapping === "obfuscated"
      ) {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { name: "dhl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    }
  };

  const result = await service.getClassSource({
    artifactId: "partial-source",
    className: "net.minecraft.world.item.Item"
  });

  assert.equal(result.artifactId, "binary-fallback");
  assert.match(result.sourceText, /class dhl/);
  assert.ok(result.qualityFlags.includes("binary-fallback"));
  assert.ok(result.warnings.some((warning) => warning.includes("Falling back to binary artifact")));
  assert.ok(mappingCalls.some((call) => call.name === "net.minecraft.world.item.Item"));
});

test("SourceService getClassSource reports partial-source fallback failures without redirecting to find-class", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-partial-failure-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");
  const provenance = {
    target: { kind: "version", value: "1.21.10" },
    resolvedAt: new Date().toISOString(),
    resolvedFrom: {
      origin: "local-jar",
      sourceJarPath,
      binaryJarPath,
      version: "1.21.10"
    },
    transformChain: ["mapping:mojang-source-backed"]
  };

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance,
    files: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        content: [
          "package net.neoforged.neoforge.capabilities;",
          "public class Capabilities {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        symbolKind: "class",
        symbolName: "Capabilities",
        qualifiedName: "net.neoforged.neoforge.capabilities.Capabilities",
        line: 2
      }
    ]
  });

  (service as unknown as { resolveBinaryFallbackArtifact: unknown }).resolveBinaryFallbackArtifact = async () => undefined;

  await assert.rejects(
    service.getClassSource({
      artifactId: "partial-source",
      className: "net.minecraft.world.item.Item"
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.equal(error !== null && "code" in error ? (error as { code: string }).code : undefined, ERROR_CODES.CLASS_NOT_FOUND);
      const details = error && typeof error === "object" && "details" in error
        ? (error as { details?: Record<string, unknown> }).details
        : undefined;
      assert.equal(details?.suggestedCall && typeof details.suggestedCall === "object"
        ? (details.suggestedCall as { tool?: string }).tool
        : undefined, "get-class-api-matrix");
      assert.match(String(details?.nextAction ?? ""), /binary fallback/i);
      assert.ok(Array.isArray(details?.qualityFlags));
      assert.ok((details?.qualityFlags as unknown[]).includes("partial-source-no-net-minecraft"));
      return true;
    }
  );
});

test("SourceService findClass suppresses misleading non-vanilla matches for partial-source vanilla lookups", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-findclass-partial-vanilla-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-jar",
        sourceJarPath,
        binaryJarPath,
        version: "1.21.10"
      },
      transformChain: ["mapping:mojang-source-backed"]
    },
    files: [
      {
        filePath: "net/neoforged/neoforge/items/Item.java",
        content: [
          "package net.neoforged.neoforge.items;",
          "public class Item {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/items/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: "net.neoforged.neoforge.items.Item",
        line: 2
      }
    ]
  });

  const result = service.findClass({
    artifactId: "partial-source",
    className: "Item",
    limit: 10
  });

  assert.equal(result.total, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("partial") && warning.includes("net.minecraft")));
});

test("SourceService ignores projectPath Loom source discovery for obfuscated mapping", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-obfuscated-project-path-"));
  const projectPath = join(root, "workspace");
  await mkdir(projectPath, { recursive: true });

  const remoteJarPath = join(root, "remote-1.21.10.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {}"
    ].join("\n")
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.10" },
          versions: [
            {
              id: "1.21.10",
              type: "release",
              url: "https://example.test/versions/1.21.10.json"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/versions/1.21.10.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.10",
          downloads: {
            client: { url: "https://example.test/downloads/client-1.21.10.jar" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/downloads/client-1.21.10.jar") {
      return new Response(remoteJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
    const discoverCalls: Array<{ version: string; projectPath?: string }> = [];
    (
      service as unknown as {
        discoverVersionSourceJar: (input: {
          version: string;
          projectPath?: string;
        }) => Promise<unknown>;
      }
    ).discoverVersionSourceJar = async (input) => {
      discoverCalls.push(input);
      return {
        selectedSourceJarPath: undefined,
        searchedPaths: [],
        candidateArtifacts: []
      };
    };

    const resolved = await service.resolveArtifact({
      target: {
        kind: "version",
        value: "1.21.10"
      },
      mapping: "obfuscated",
      projectPath
    } as any);

    assert.equal(resolved.mappingApplied, "obfuscated");
    assert.equal(discoverCalls.length, 0);
    assert.equal(
      resolved.warnings.some((warning) => warning.includes("Loom cache candidate")),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

test("SourceService exposes searchedPaths diagnostics when mojang mapping cannot be applied for version target", { concurrency: false }, async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-diagnostics-"));
  const projectPath = join(root, "workspace");
  const gradleUserHome = join(root, "gradle-user-home");
  await mkdir(projectPath, { recursive: true });
  await mkdir(gradleUserHome, { recursive: true });

  const remoteJarPath = join(root, "remote-1.21.10.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.10" },
          versions: [
            {
              id: "1.21.10",
              type: "release",
              url: "https://example.test/versions/1.21.10.json"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/versions/1.21.10.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.10",
          downloads: {
            client: { url: "https://example.test/downloads/client-1.21.10.jar" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/downloads/client-1.21.10.jar") {
      return new Response(remoteJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
    await withGradleUserHome(gradleUserHome, () =>
      assert.rejects(
        () =>
          service.resolveArtifact({
            target: {
              kind: "version",
              value: "1.21.10"
            },
            mapping: "mojang",
            projectPath
          } as any),
        (error: unknown) => {
          if (typeof error !== "object" || error === null || !("code" in error)) {
            return false;
          }
          if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) {
            return false;
          }
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          return (
            Array.isArray(details.searchedPaths) &&
            Array.isArray(details.candidateArtifacts) &&
            typeof details.recommendedCommand === "string" &&
            details.artifactOrigin === "decompiled" &&
            typeof details.nextAction === "string" &&
            typeof details.suggestedCall === "object" &&
            details.suggestedCall !== null
          );
        }
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

test("SourceService resolveArtifact prefers Minecraft source jars from sibling Gradle user home over project remapped mod sources", { concurrency: false }, async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-gradle-home-"));
  const projectPath = join(root, "workspace");
  const projectRemappedDir = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "remapped_mods",
    "remapped",
    "net",
    "fabricmc",
    "fabric-api",
    "fabric-api-4abd26ae-common",
    "0.139.4+1.21.11"
  );
  const projectPartialSourceJarPath = join(
    projectRemappedDir,
    "fabric-api-4abd26ae-common-0.139.4+1.21.11-sources.jar"
  );
  const projectPartialBinaryJarPath = join(
    projectRemappedDir,
    "fabric-api-4abd26ae-common-0.139.4+1.21.11.jar"
  );
  const gradleUserHome = join(root, "gradle-user-home");
  const gradleHomeLoomDir = join(gradleUserHome, "loom-cache", "1.21.11");
  const minecraftSourceJarPath = join(gradleHomeLoomDir, "minecraft-merged-1.21.11-sources.jar");
  const minecraftBinaryJarPath = join(gradleHomeLoomDir, "minecraft-merged-1.21.11.jar");
  const versionJarPath = join(root, "client-1.21.11.jar");

  await mkdir(projectRemappedDir, { recursive: true });
  await mkdir(gradleHomeLoomDir, { recursive: true });
  await createJar(projectPartialSourceJarPath, {
    "net/fabricmc/fabric/api/item/v1/FabricItemApi.java": [
      "package net.fabricmc.fabric.api.item.v1;",
      "public final class FabricItemApi {}"
    ].join("\n")
  });
  await createJar(projectPartialBinaryJarPath, {
    "net/fabricmc/fabric/api/item/v1/FabricItemApi.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(minecraftSourceJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });
  await createJar(minecraftBinaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(versionJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: versionJarPath,
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  const resolved = await withGradleUserHome(gradleUserHome, () =>
    service.resolveArtifact({
      target: {
        kind: "version",
        value: "1.21.11"
      },
      mapping: "mojang",
      projectPath
    } as any)
  );

  assert.equal(resolved.resolvedSourceJarPath, minecraftSourceJarPath);
  assert.equal(resolved.binaryJarPath, minecraftBinaryJarPath);
  assert.equal(resolved.mappingApplied, "mojang");
  assert.equal(resolved.qualityFlags.includes("partial-source-no-net-minecraft"), false);
});

test("SourceService resolveArtifact does not treat version-matching mod source jars as Minecraft merged sources", { concurrency: false }, async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-false-positive-"));
  const projectPath = join(root, "workspace");
  const gradleUserHome = join(root, "gradle-user-home");
  const projectRemappedDir = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "remapped_mods",
    "remapped",
    "net",
    "fabricmc",
    "fabric-api",
    "fabric-api-4abd26ae-common",
    "0.139.4+1.21.11"
  );
  const projectPartialSourceJarPath = join(
    projectRemappedDir,
    "fabric-api-4abd26ae-common-0.139.4+1.21.11-sources.jar"
  );
  const projectPartialBinaryJarPath = join(
    projectRemappedDir,
    "fabric-api-4abd26ae-common-0.139.4+1.21.11.jar"
  );
  const versionJarPath = join(root, "client-1.21.11.jar");

  await mkdir(projectRemappedDir, { recursive: true });
  await createJar(projectPartialSourceJarPath, {
    "net/fabricmc/fabric/api/item/v1/FabricItemApi.java": [
      "package net.fabricmc.fabric.api.item.v1;",
      "public final class FabricItemApi {}"
    ].join("\n")
  });
  await createJar(projectPartialBinaryJarPath, {
    "net/fabricmc/fabric/api/item/v1/FabricItemApi.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(versionJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbf])
  });
  await mkdir(gradleUserHome, { recursive: true });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: versionJarPath,
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  await withGradleUserHome(gradleUserHome, () =>
    assert.rejects(
      () =>
        service.resolveArtifact({
          target: {
            kind: "version",
            value: "1.21.11"
          },
          mapping: "mojang",
          projectPath
        } as any),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          return false;
        }
        if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) {
          return false;
        }
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        return (
          Array.isArray(details.candidateArtifacts) &&
          (details.candidateArtifacts as string[]).some((candidate) =>
            candidate.includes("fabric-api-4abd26ae-common-0.139.4+1.21.11-sources.jar")
          )
        );
      }
    )
  );
});

test("SourceService source code does not expose legacy compatibility methods", async () => {
  const source = await readFile("src/source-service.ts", "utf8");

  assert.doesNotMatch(source, /export type ResolveInput/);
  assert.doesNotMatch(source, /export type ResolveOutput/);
  assert.doesNotMatch(source, /async resolveSourceTarget\(/);
  assert.doesNotMatch(source, /async listSourceFiles\(/);
  assert.doesNotMatch(source, /async searchSource\(/);
  assert.doesNotMatch(source, /async searchSourceMulti\(/);
  assert.doesNotMatch(source, /async querySymbols\(/);
  assert.doesNotMatch(source, /async getSourceContext\(/);
  assert.doesNotMatch(source, /async getSourceFile\(/);
});

test("SourceService fails mojang mapping when only decompiled source is available", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-mojang-map-"));
  const binaryJarPath = join(root, "server-5.0.0.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: {
          kind: "jar",
          value: binaryJarPath
        },
        mapping: "mojang",
        allowDecompile: false
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.MAPPING_NOT_APPLIED
      );
    }
  );
});

test("SourceService resolves intermediary mapping for source-backed coordinate artifacts", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-intermediary-map-"));
  const coordinate = "com.example:demo:1.0.0";
  const localSourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "demo",
    "1.0.0",
    "demo-1.0.0-sources.jar"
  );
  await createJar(localSourceJarPath, {
    "com/example/Demo.java": [
      "package com.example;",
      "public class Demo {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const mappingCalls: Array<{ version: string; mapping: string }> = [];
  const mappingStub = {
    async ensureMappingAvailable(input: {
      version: string;
      sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    }) {
      mappingCalls.push({ version: input.version, mapping: input.targetMapping });
      return {
        transformChain: ["mapping-source:loom-cache"],
        warnings: []
      };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    ...mappingStub
  };

  const resolved = await service.resolveArtifact({
    target: {
      kind: "coordinate",
      value: coordinate
    },
    mapping: "intermediary"
  });

  assert.equal(resolved.mappingApplied, "intermediary");
  assert.equal(resolved.requestedMapping, "intermediary");
  assert.equal(resolved.version, "1.0.0");
  assert.ok(resolved.provenance.transformChain.includes("mapping-source:loom-cache"));
  assert.deepEqual(mappingCalls, [{ version: "1.0.0", mapping: "intermediary" }]);
});

test("SourceService rejects intermediary and yarn mappings when artifact version is unknown", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-unsupported-map-"));
  const sourceJarPath = join(root, "server-sources.jar");
  await createJar(sourceJarPath, {
    "com/example/NoVersion.java": [
      "package com.example;",
      "public class NoVersion {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  let called = false;
  const mappingStub = {
    async ensureMappingAvailable() {
      called = true;
      return { transformChain: [], warnings: [] };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    ...mappingStub
  };

  for (const mapping of ["intermediary", "yarn"] as const) {
    await assert.rejects(
      () =>
        service.resolveArtifact({
          target: {
            kind: "jar",
            value: sourceJarPath
          },
          mapping
        }),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          return false;
        }
        if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) {
          return false;
        }
        const details = (error as { details?: Record<string, unknown> }).details;
        return (
          details?.mapping === mapping &&
          typeof details?.nextAction === "string" &&
          details.nextAction.includes("target: { kind: \"version\", value") &&
          typeof details?.suggestedCall === "object" &&
          details.suggestedCall !== null &&
          (details.suggestedCall as { params?: Record<string, unknown> }).params?.target !== undefined
        );
      }
    );
  }
  assert.equal(called, false);
});

test("SourceService delegates representative mapping queries to MappingService", async (t) => {
  const cases: Array<{
    name: string;
    rootPrefix: string;
    method:
      | "findMapping"
      | "resolveMethodMappingExact"
      | "getClassApiMatrix"
      | "checkSymbolExists";
    input: Record<string, unknown>;
    response: Record<string, unknown>;
    verifyDelegateInput: (input: Record<string, unknown>) => void;
    verifyResult: (result: Record<string, unknown>) => void;
  }> = [
    {
      name: "findMapping returns lookup payload",
      rootPrefix: "service-find-mapping-",
      method: "findMapping",
      input: {
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated",
        targetMapping: "mojang",
        maxCandidates: 1
      },
      response: {
        querySymbol: {
          kind: "class",
          name: "a.b.C",
          symbol: "a.b.C"
        },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated",
          targetMapping: "mojang"
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.server.Main",
          symbol: "net.minecraft.server.Main"
        },
        candidates: [
          {
            kind: "class",
            name: "net.minecraft.server.Main",
            symbol: "net.minecraft.server.Main",
            matchKind: "exact",
            confidence: 1
          }
        ],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.version, "1.21.10");
        assert.equal(input.kind, "class");
        assert.equal(input.maxCandidates, 1);
      },
      verifyResult: (result) => {
        assert.equal((result.candidates as Array<{ symbol: string }>)[0]?.symbol, "net.minecraft.server.Main");
      }
    },
    {
      name: "resolveMethodMappingExact forwards maxCandidates",
      rootPrefix: "service-method-exact-",
      method: "resolveMethodMappingExact",
      input: {
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(Ljava/lang/String;)V",
        sourceMapping: "obfuscated",
        targetMapping: "mojang",
        maxCandidates: 1
      },
      response: {
        querySymbol: {
          kind: "method",
          owner: "a.b.C",
          name: "f",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "a.b.C.f(Ljava/lang/String;)V"
        },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated",
          targetMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: "com.example.ValueOutput",
          name: "remove",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V"
        },
        candidates: [
          {
            kind: "method",
            owner: "com.example.ValueOutput",
            name: "remove",
            descriptor: "(Ljava/lang/String;)V",
            symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V",
            matchKind: "exact",
            confidence: 1
          }
        ],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.maxCandidates, 1);
        assert.equal(input.owner, "a.b.C");
      },
      verifyResult: (result) => {
        assert.equal(result.resolved, true);
        assert.equal(
          (result.resolvedSymbol as { name?: string } | undefined)?.name,
          "remove"
        );
      }
    },
    {
      name: "getClassApiMatrix forwards maxRows",
      rootPrefix: "service-class-matrix-",
      method: "getClassApiMatrix",
      input: {
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 2
      },
      response: {
        classIdentity: {
          obfuscated: "a.b.C",
          mojang: "com.example.ValueOutput",
          intermediary: "intermediary/pkg/ValueOutput",
          yarn: "net/minecraft/nbt/visitors/StringNbtWriter$ValueOutput"
        },
        rows: [],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.className, "a.b.C");
        assert.equal(input.maxRows, 2);
      },
      verifyResult: (result) => {
        assert.equal(
          (result.classIdentity as Record<string, string | undefined>).mojang,
          "com.example.ValueOutput"
        );
      }
    },
    {
      name: "checkSymbolExists forwards maxCandidates",
      rootPrefix: "service-symbol-exists-",
      method: "checkSymbolExists",
      input: {
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        sourceMapping: "obfuscated",
        maxCandidates: 1
      },
      response: {
        resolved: true,
        status: "resolved",
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.maxCandidates, 1);
        assert.equal(input.name, "f");
      },
      verifyResult: (result) => {
        assert.equal(result.resolved, true);
        assert.equal(result.status, "resolved");
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { SourceService } = await import("../src/source-service.ts");
      const root = await mkdtemp(join(tmpdir(), testCase.rootPrefix));
      const service = new SourceService(buildTestConfig(root));

      (service as unknown as { mappingService: Record<string, (input: unknown) => Promise<unknown>> }).mappingService = {
        [testCase.method]: async (input: unknown) => {
          testCase.verifyDelegateInput(input as Record<string, unknown>);
          return testCase.response;
        }
      };

      const result = await (
        service as unknown as Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>>
      )[testCase.method](testCase.input);

      testCase.verifyResult(result);
    });
  }
});

test("SourceService resolveWorkspaceSymbol rejects owner for class input", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-workspace-symbol-class-invalid-owner-"));
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      (
        service as unknown as {
          resolveWorkspaceSymbol: (input: {
            projectPath: string;
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
          }) => Promise<unknown>;
        }
      ).resolveWorkspaceSymbol({
        projectPath: root,
        version: "1.21.10",
        kind: "class",
        owner: "a.b",
        name: "a.b.C",
        sourceMapping: "obfuscated"
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );
});

test("SourceService resolveWorkspaceSymbol applies workspace mapping and returns compile-visible symbol", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-workspace-symbol-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectCompileMapping() {
      return {
        resolved: true,
        mappingApplied: "mojang",
        warnings: [],
        evidence: [
          {
            filePath: join(root, "build.gradle"),
            mapping: "mojang",
            reason: "officialMojangMappings()"
          }
        ]
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async resolveMethodMappingExact(input: {
      targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    }) {
      assert.equal(input.targetMapping, "mojang");
      return {
        querySymbol: {
          kind: "method",
          owner: "a.b.C",
          name: "f",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "a.b.C.f(Ljava/lang/String;)V"
        },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated",
          targetMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: "com.example.ValueOutput",
          name: "remove",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V"
        },
        candidates: [
          {
            kind: "method",
            owner: "com.example.ValueOutput",
            name: "remove",
            descriptor: "(Ljava/lang/String;)V",
            symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V",
            matchKind: "exact",
            confidence: 1
          }
        ],
        warnings: []
      };
    }
  };

  const result = await (
    service as unknown as {
      resolveWorkspaceSymbol: (input: {
        projectPath: string;
        version: string;
        kind: "class" | "field" | "method";
        owner: string;
        name: string;
        descriptor?: string;
        sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      }) => Promise<{
        resolved: boolean;
        mappingContext: { targetMapping?: string };
        resolvedSymbol?: { name: string; owner?: string; descriptor?: string };
      }>;
    }
  ).resolveWorkspaceSymbol({
    projectPath: root,
    version: "1.21.10",
    kind: "method",
    owner: "a.b.C",
    name: "f",
    descriptor: "(Ljava/lang/String;)V",
    sourceMapping: "obfuscated"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.mappingContext.targetMapping, "mojang");
  assert.equal(result.resolvedSymbol?.name, "remove");
  assert.equal(result.resolvedSymbol?.owner, "com.example.ValueOutput");
  assert.equal(result.resolvedSymbol?.descriptor, "(Ljava/lang/String;)V");
});

test("SourceService resolveWorkspaceSymbol resolves class via class identity mapping", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-workspace-symbol-class-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectCompileMapping() {
      return {
        resolved: true,
        mappingApplied: "mojang",
        warnings: ["workspace warning"],
        evidence: [
          {
            filePath: join(root, "build.gradle"),
            mapping: "mojang",
            reason: "officialMojangMappings()"
          }
        ]
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async getClassApiMatrix(input: {
      className: string;
      classNameMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      sourcePriority?: "loom-first" | "maven-first";
    }) {
      assert.equal(input.className, "a.b.c");
      assert.equal(input.classNameMapping, "obfuscated");
      assert.equal(input.sourcePriority, "loom-first");
      return {
        classIdentity: {
          obfuscated: "a.b.c",
          mojang: "com.example.valueoutput"
        },
        rows: [],
        warnings: ["matrix warning"]
      };
    },
    async findMapping() {
      throw new Error("findMapping should not be used for kind=class");
    }
  };

  const result = await (
    service as unknown as {
      resolveWorkspaceSymbol: (input: {
        projectPath: string;
        version: string;
        kind: "class" | "field" | "method";
        owner?: string;
        name: string;
        descriptor?: string;
        sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
        sourcePriority?: "loom-first" | "maven-first";
      }) => Promise<{
        resolved: boolean;
        status: string;
        mappingContext: { targetMapping?: string };
        resolvedSymbol?: { name: string };
        warnings: string[];
      }>;
    }
  ).resolveWorkspaceSymbol({
    projectPath: root,
    version: "1.21.10",
    kind: "class",
    name: "a.b.c",
    sourceMapping: "obfuscated",
    sourcePriority: "loom-first"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.mappingContext.targetMapping, "mojang");
  assert.equal(result.resolvedSymbol?.name, "com.example.valueoutput");
  assert.deepEqual(result.warnings, ["workspace warning", "matrix warning"]);
});

test("SourceService resolveArtifact handles unobfuscated version fallback warnings", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  async function createUnobfuscatedVersionService(rootPrefix: string): Promise<{
    service: SourceServiceFixture;
  }> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const binaryJarPath = join(root, "client-26.1.jar");
    const sourcesJarPath = join(root, "client-26.1-sources.jar");

    await createJar(binaryJarPath, {
      "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });
    await createJar(sourcesJarPath, {
      "net/minecraft/server/Main.java": [
        "package net.minecraft.server;",
        "public class Main {",
        "  void run() {}",
        "}"
      ].join("\n")
    });

    const service = new SourceService(buildTestConfig(root));
    (service as unknown as { versionService: unknown }).versionService = {
      async resolveVersionJar(version: string) {
        return {
          version,
          jarPath: binaryJarPath,
          source: "downloaded" as const,
          clientJarUrl: `https://example.test/${version}.jar`
        };
      }
    };

    return { service };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    mapping: "obfuscated" | "yarn";
    verify: (result: { requestedMapping: string; mappingApplied: string; warnings: string[] }) => void;
  }> = [
    {
      name: "yarn falls back to obfuscated with warning",
      rootPrefix: "service-unobfuscated-yarn-",
      mapping: "yarn",
      verify: (result) => {
        assert.equal(result.requestedMapping, "obfuscated");
        assert.equal(result.mappingApplied, "obfuscated");
        assert.ok(result.warnings.some((w) => w.includes("unobfuscated") && w.includes("yarn")));
      }
    },
    {
      name: "obfuscated keeps mapping without fallback warning",
      rootPrefix: "service-unobfuscated-obfuscated-",
      mapping: "obfuscated",
      verify: (result) => {
        assert.equal(result.mappingApplied, "obfuscated");
        assert.ok(!result.warnings.some((w) => w.includes("unobfuscated")));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service } = await createUnobfuscatedVersionService(testCase.rootPrefix);
      const result = await service.resolveArtifact({
        target: { kind: "version", value: "26.1" },
        mapping: testCase.mapping
      });
      testCase.verify(result);
    });
  }
});

test("SourceService traces symbol lifecycle across versions and reports gaps", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.3", "1.0.2", "1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));

  const versionServiceStub = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  const signatureStub = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      const descriptorByVersion: Record<string, string[] | undefined> = {
        "1.0.0": ["()V"],
        "1.0.1": [],
        "1.0.2": ["(I)V"],
        "1.0.3": ["()V", "(I)V"]
      };
      const descriptors = descriptorByVersion[version] ?? [];
      return {
        constructors: [],
        fields: [],
        methods: descriptors.map((descriptor) => ({
          ownerFqn: "net.minecraft.server.Main",
          name: "tickServer",
          javaSignature: "void tickServer()",
          jvmDescriptor: descriptor,
          accessFlags: 0x0001,
          isSynthetic: false
        })),
        context: {
          minecraftVersion: version,
          mappingType: "obfuscated",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  (service as unknown as { versionService: unknown }).versionService = versionServiceStub;
  (service as unknown as { explorerService: unknown }).explorerService = signatureStub;

  const result = await (
    service as unknown as {
      traceSymbolLifecycle: (input: {
        symbol: string;
        descriptor?: string;
        fromVersion?: string;
        toVersion?: string;
        includeTimeline?: boolean;
      }) => Promise<{
        presence: {
          firstSeen?: string;
          lastSeen?: string;
          missingBetween: string[];
          existsNow: boolean;
        };
        timeline?: Array<{ version: string; exists: boolean }>;
      }>;
    }
  ).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.3",
    includeTimeline: true
  });

  assert.equal(result.presence.firstSeen, "1.0.0");
  assert.equal(result.presence.lastSeen, "1.0.3");
  assert.equal(result.presence.existsNow, true);
  assert.deepEqual(result.presence.missingBetween, ["1.0.1", "1.0.2"]);
  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists })),
    [
      { version: "1.0.0", exists: true },
      { version: "1.0.1", exists: false },
      { version: "1.0.2", exists: false },
      { version: "1.0.3", exists: true }
    ]
  );
});

test("SourceService traceSymbolLifecycle with non-obfuscated mapping resolves symbol to obfuscated", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-map-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const mappingCalls: Array<{ name: string; sourceMapping: string; targetMapping: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      mappingCalls.push({ name: input.name, sourceMapping: input.sourceMapping, targetMapping: input.targetMapping });
      // Simulate mapping: yarn name -> obfuscated name
      if (input.kind === "class" && input.name === "net.minecraft.server.YarnMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "yarnTick") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "yarn";
    }) => Promise<{
      query: { className: string; methodName: string; mapping: string };
      presence: { existsNow: boolean };
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.YarnMain.yarnTick",
    mapping: "yarn"
  });

  // Query should echo user's (yarn) names
  assert.equal(result.query.className, "net.minecraft.server.YarnMain");
  assert.equal(result.query.methodName, "yarnTick");
  assert.equal(result.query.mapping, "yarn");
  // Method should be found because it was resolved to obfuscated name
  assert.equal(result.presence.existsNow, true);
  // Verify mapping was called for both class and method
  assert.ok(mappingCalls.some((c) => c.name === "net.minecraft.server.YarnMain" && c.targetMapping === "obfuscated"));
  assert.ok(mappingCalls.some((c) => c.name === "yarnTick" && c.targetMapping === "obfuscated"));
});

test("SourceService traceSymbolLifecycle remaps non-obfuscated symbol per scanned version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-versioned-map-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));
  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      if (version === "1.0.0") {
        if (input.fqn !== "net.minecraft.server.OldMain") {
          throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
        }
        return {
          constructors: [],
          fields: [],
          methods: [
            {
              ownerFqn: "net.minecraft.server.OldMain",
              name: "oldTick",
              javaSignature: "public void oldTick()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: { classExistedInJar: true }
        };
      }
      if (input.fqn !== "net.minecraft.server.NewMain") {
        throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
      }
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.NewMain",
            name: "newTick",
            javaSignature: "public void newTick()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const mappingCalls: Array<{ version: string; kind: string; name: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { version: string; kind: string; name: string }) {
      mappingCalls.push({ version: input.version, kind: input.kind, name: input.name });
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain" && input.version === "1.0.0") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OldMain" }, warnings: [] };
      }
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain" && input.version === "1.0.1") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.NewMain" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "tickInter" && input.version === "1.0.0") {
        return { resolved: true, resolvedSymbol: { name: "oldTick" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "tickInter" && input.version === "1.0.1") {
        return { resolved: true, resolvedSymbol: { name: "newTick" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
      includeTimeline: boolean;
    }) => Promise<{
      presence: { firstSeen?: string; lastSeen?: string; existsNow: boolean };
      timeline?: Array<{ version: string; exists: boolean }>;
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary",
    includeTimeline: true
  });

  assert.equal(result.presence.firstSeen, "1.0.0");
  assert.equal(result.presence.lastSeen, "1.0.1");
  assert.equal(result.presence.existsNow, true);
  assert.deepEqual(result.timeline, [
    { version: "1.0.0", exists: true, reason: undefined },
    { version: "1.0.1", exists: true, reason: undefined }
  ]);
  assert.ok(
    mappingCalls.some((call) => call.version === "1.0.0" && call.kind === "class" && call.name === "net.minecraft.server.InterMain")
  );
  assert.ok(
    mappingCalls.some((call) => call.version === "1.0.1" && call.kind === "class" && call.name === "net.minecraft.server.InterMain")
  );
});

test("SourceService traceSymbolLifecycle with non-obfuscated mapping remaps descriptor before matching", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-descriptor-remap-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.server.OffMain");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.OffMain",
            name: "tickOfficial",
            javaSignature: "public void tickOfficial(net.minecraft.server.OffArg)",
            jvmDescriptor: "(Lnet/minecraft/server/OffArg;)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; descriptor?: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      if (
        input.kind === "method" &&
        input.name === "tickInter" &&
        input.descriptor === "(Lnet/minecraft/server/InterArg;)V"
      ) {
        return {
          resolved: true,
          resolvedSymbol: { name: "tickOfficial", descriptor: "(Lnet/minecraft/server/OffArg;)V" },
          warnings: []
        };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ presence: { existsNow: boolean } }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    descriptor: "(Lnet/minecraft/server/InterArg;)V",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.equal(result.presence.existsNow, true);
});

test("SourceService traceSymbolLifecycle uses name-only mapping when descriptor is omitted", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-name-only-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.server.OffMain");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.OffMain",
            name: "tickOfficial",
            javaSignature: "public void tickOfficial()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: {
      kind: string;
      name: string;
      descriptor?: string;
      signatureMode?: "exact" | "name-only";
    }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.InterMain") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      if (
        input.kind === "method" &&
        input.name === "tickInter" &&
        input.signatureMode === "name-only" &&
        input.descriptor === undefined
      ) {
        return {
          resolved: true,
          resolvedSymbol: { name: "tickOfficial" },
          warnings: []
        };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ presence: { existsNow: boolean } }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.equal(result.presence.existsNow, true);
});

test("SourceService traceSymbolLifecycle surfaces invalid method mapping input details in warnings", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-invalid-warning-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.0"];
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string }) {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OffMain" }, warnings: [] };
      }
      throw Object.assign(new Error("descriptor must be a valid JVM descriptor when kind=method."), {
        code: ERROR_CODES.INVALID_INPUT
      });
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "intermediary";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ warnings: string[] }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.InterMain.tickInter",
    mapping: "intermediary",
    descriptor: "()broken",
    fromVersion: "1.0.0",
    toVersion: "1.0.0"
  });

  assert.ok(
    result.warnings.some((warning) => warning.includes("descriptor must be a valid JVM descriptor"))
  );
});

test("SourceService diffClassSignatures returns member added/removed/modified deltas", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-signatures-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (version === "1.0.0") {
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
              name: "MUTATED_FIELD",
              javaSignature: "public int MUTATED_FIELD",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "REMOVED_FIELD",
              javaSignature: "public int REMOVED_FIELD",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          methods: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "changedAccess",
              javaSignature: "public void changedAccess(int)",
              jvmDescriptor: "(I)V",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "removedMethod",
              javaSignature: "public void removedMethod()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            },
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "changedDescriptor",
              javaSignature: "public void changedDescriptor()",
              jvmDescriptor: "()V",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: {
            minecraftVersion: "1.0.0",
            mappingType: "unknown",
            mappingNamespace: "obfuscated",
            jarHash: "fake",
            generatedAt: new Date().toISOString()
          }
        };
      }

      return {
        constructors: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "<init>",
            javaSignature: "public Main()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "<init>",
            javaSignature: "public Main(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "MUTATED_FIELD",
            javaSignature: "public long MUTATED_FIELD",
            jvmDescriptor: "J",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "NEW_FIELD",
            javaSignature: "public int NEW_FIELD",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "changedAccess",
            javaSignature: "private void changedAccess(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0002,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "newMethod",
            javaSignature: "public void newMethod()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "changedDescriptor",
            javaSignature: "public void changedDescriptor(int)",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: {
          minecraftVersion: "1.0.1",
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
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        constructors: { added: Array<{ jvmDescriptor: string }> };
        methods: {
          added: Array<{ name: string; jvmDescriptor: string }>;
          removed: Array<{ name: string; jvmDescriptor: string }>;
          modified: Array<{ key: string }>;
        };
        fields: {
          added: Array<{ name: string }>;
          removed: Array<{ name: string }>;
          modified: Array<{ key: string }>;
        };
        summary: {
          constructors: { added: number; removed: number; modified: number };
          methods: { added: number; removed: number; modified: number };
          fields: { added: number; removed: number; modified: number };
          total: { added: number; removed: number; modified: number };
        };
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.Main",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });

  assert.equal(result.classChange, "present_in_both");
  assert.deepEqual(
    result.constructors.added.map((entry) => entry.jvmDescriptor),
    ["(I)V"]
  );
  assert.deepEqual(
    result.methods.added.map((entry) => `${entry.name}${entry.jvmDescriptor}`),
    ["changedDescriptor(I)V", "newMethod()V"]
  );
  assert.deepEqual(
    result.methods.removed.map((entry) => `${entry.name}${entry.jvmDescriptor}`),
    ["changedDescriptor()V", "removedMethod()V"]
  );
  assert.deepEqual(
    result.methods.modified.map((entry) => entry.key),
    ["changedAccess#(I)V"]
  );
  assert.deepEqual(
    result.fields.added.map((entry) => entry.name),
    ["NEW_FIELD"]
  );
  assert.deepEqual(
    result.fields.removed.map((entry) => entry.name),
    ["REMOVED_FIELD"]
  );
  assert.deepEqual(
    result.fields.modified.map((entry) => entry.key),
    ["MUTATED_FIELD"]
  );
  assert.deepEqual(result.summary, {
    constructors: { added: 1, removed: 0, modified: 0 },
    methods: { added: 2, removed: 2, modified: 1 },
    fields: { added: 1, removed: 1, modified: 1 },
    total: { added: 4, removed: 3, modified: 2 }
  });
});

test("SourceService diffClassSignatures omits from/to snapshots when includeFullDiff=false", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-compact-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (version === "1.0.0") {
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "MUTATED_FIELD",
              javaSignature: "public int MUTATED_FIELD",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          methods: [],
          warnings: []
        };
      }

      return {
        constructors: [],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "MUTATED_FIELD",
            javaSignature: "public long MUTATED_FIELD",
            jvmDescriptor: "J",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [],
        warnings: []
      };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      includeFullDiff: false;
    }) => Promise<{
      fields: {
        modified: Array<{
          key: string;
          changed: string[];
          from?: unknown;
          to?: unknown;
        }>;
      };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.Main",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    includeFullDiff: false
  });

  assert.deepEqual(result.fields.modified, [
    {
      key: "MUTATED_FIELD",
      changed: ["javaSignature", "jvmDescriptor"]
    }
  ]);
  assert.equal("from" in result.fields.modified[0]!, false);
  assert.equal("to" in result.fields.modified[0]!, false);
});

test("SourceService diffClassSignatures reports class added and absent_in_both states", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-states-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string; fqn: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }

      if (input.fqn === "net.minecraft.server.AlwaysMissing") {
        const error = new Error("missing") as Error & { code: string };
        error.code = ERROR_CODES.CLASS_NOT_FOUND;
        throw error;
      }

      if (version === "1.0.0") {
        const error = new Error("missing") as Error & { code: string };
        error.code = ERROR_CODES.CLASS_NOT_FOUND;
        throw error;
      }

      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: input.fqn,
            name: "presentNow",
            javaSignature: "public void presentNow()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: {
          minecraftVersion: "1.0.1",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const added = await (
    service as unknown as {
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        methods: { added: Array<{ name: string }>; removed: unknown[] };
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.PresentNow",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });
  assert.equal(added.classChange, "added");
  assert.equal(added.methods.removed.length, 0);
  assert.deepEqual(
    added.methods.added.map((entry) => entry.name),
    ["presentNow"]
  );

  const absentInBoth = await (
    service as unknown as {
      diffClassSignatures: (input: {
        className: string;
        fromVersion: string;
        toVersion: string;
      }) => Promise<{
        classChange: string;
        warnings: string[];
      }>;
    }
  ).diffClassSignatures({
    className: "net.minecraft.server.AlwaysMissing",
    fromVersion: "1.0.0",
    toVersion: "1.0.1"
  });
  assert.equal(absentInBoth.classChange, "absent_in_both");
  assert.match(
    absentInBoth.warnings[0] ?? "",
    /Class "net\.minecraft\.server\.AlwaysMissing" was not found in both versions\./
  );
});

test("SourceService diffClassSignatures validates version range order", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-validate-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.0.2", "1.0.1", "1.0.0"];
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  await assert.rejects(
    () =>
      (service as unknown as {
        diffClassSignatures: (input: {
          className: string;
          fromVersion: string;
          toVersion: string;
        }) => Promise<unknown>;
      }).diffClassSignatures({
        className: "net.minecraft.server.Main",
        fromVersion: "1.0.2",
        toVersion: "1.0.0"
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

test("SourceService validateAccessWidener normalizes named namespace to yarn", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-aw-named-"));
  const service = new SourceService(buildTestConfig(root));

  const mappingCalls: string[] = [];

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string }) {
      mappingCalls.push(input.sourceMapping);
      return {
        resolved: true,
        resolvedSymbol: {
          kind: "class",
          name: "a.b.c",
          symbol: "a.b.c"
        }
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
    }
  };

  const result = await (
    service as unknown as {
      validateAccessWidener: (input: {
        content: string;
        version: string;
      }) => Promise<{ valid: boolean }>;
    }
  ).validateAccessWidener({
    content: [
      "accessWidener v2 named",
      "accessible class net/minecraft/server/MinecraftServer"
    ].join("\n"),
    version: "1.21.10"
  });

  assert.equal(result.valid, true);
  assert.deepEqual(mappingCalls, ["yarn"]);
});

test("SourceService validateAccessWidener prefers explicit mapping override over header namespace", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-aw-override-"));
  const service = new SourceService(buildTestConfig(root));

  const mappingCalls: string[] = [];

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string }) {
      mappingCalls.push(input.sourceMapping);
      return {
        resolved: true,
        resolvedSymbol: {
          kind: "class",
          name: "a.b.c",
          symbol: "a.b.c"
        }
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
    }
  };

  const result = await (
    service as unknown as {
      validateAccessWidener: (input: {
        content: string;
        version: string;
        mapping: "mojang";
      }) => Promise<{ valid: boolean }>;
    }
  ).validateAccessWidener({
    content: [
      "accessWidener v2 intermediary",
      "accessible class net/minecraft/server/MinecraftServer"
    ].join("\n"),
    version: "1.21.10",
    mapping: "mojang"
  });

  assert.equal(result.valid, true);
  assert.deepEqual(mappingCalls, ["mojang"]);
});

test("SourceService getClassMembers with mojang mapping remaps className and member names", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-mojang-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      // Should receive obfuscated name after mapping
      assert.equal(input.fqn, "net.minecraft.server.Main");
      return {
        constructors: [],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "f_1234",
            javaSignature: "public int f_1234",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_5678",
            javaSignature: "public void m_5678()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      // Class mapping: mojang -> obfuscated
      if (input.kind === "class" && input.name === "net.minecraft.server.MojangMain" && input.targetMapping === "obfuscated") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      // Field mapping: obfuscated -> mojang
      if (input.kind === "field" && input.name === "f_1234" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "serverPort" }, warnings: [] };
      }
      // Method mapping: obfuscated -> mojang
      if (input.kind === "method" && input.name === "m_5678" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      // Owner class mapping: obfuscated -> mojang
      if (input.kind === "class" && input.name === "net.minecraft.server.Main" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.MojangMain" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  // Stub resolveArtifact to return a versioned artifact
  const originalResolveArtifact = (service as unknown as {
    resolveArtifact: (input: unknown) => Promise<unknown>;
  }).resolveArtifact.bind(service);

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async (input: unknown) => {
    return {
      artifactId: "test-artifact-id",
      origin: "local-jar" as const,
      isDecompiled: false,
      binaryJarPath: join(root, "1.21.4.jar"),
      version: "1.21.4",
      requestedMapping: "mojang" as const,
      mappingApplied: "obfuscated" as const,
      provenance: {
        target: { kind: "version" as const, value: "1.21.4" },
        resolvedAt: new Date().toISOString(),
        resolvedFrom: { origin: "local-jar" as const },
        transformChain: []
      },
      qualityFlags: [],
      warnings: []
    };
  };

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      mapping: "mojang";
    }) => Promise<{
      className: string;
      mappingApplied: string;
      members: {
        fields: Array<{ name: string; ownerFqn: string }>;
        methods: Array<{ name: string; ownerFqn: string }>;
      };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.MojangMain",
    target: { kind: "version", value: "1.21.4" },
    mapping: "mojang"
  });

  // className should echo user's original input
  assert.equal(result.className, "net.minecraft.server.MojangMain");
  assert.equal(result.mappingApplied, "obfuscated");
  // Member names should be remapped to mojang
  assert.equal(result.members.fields[0].name, "serverPort");
  assert.equal(result.members.fields[0].ownerFqn, "net.minecraft.server.MojangMain");
  assert.equal(result.members.methods[0].name, "tickServer");
  assert.equal(result.members.methods[0].ownerFqn, "net.minecraft.server.MojangMain");
});

test("SourceService getClassMembers with non-obfuscated mapping applies memberPattern post-remap", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-pattern-remap-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { memberPattern?: string }) {
      // memberPattern should NOT be passed for non-obfuscated mapping
      assert.equal(input.memberPattern, undefined);
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_1111",
            javaSignature: "public void m_1111()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          },
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "m_2222",
            javaSignature: "public void m_2222()",
            jvmDescriptor: "(I)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; targetMapping: string }) {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { name: input.name }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "m_1111" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      if (input.kind === "method" && input.name === "m_2222" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "saveWorld" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-pattern",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "mojang" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.4" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      mapping: "mojang";
      memberPattern: string;
    }) => Promise<{
      members: { methods: Array<{ name: string }> };
      counts: { methods: number; total: number };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Main",
    target: { kind: "version", value: "1.21.4" },
    mapping: "mojang",
    memberPattern: "tick"
  });

  // Only "tickServer" should match "tick" pattern; "saveWorld" should be filtered out
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.members.methods[0].name, "tickServer");
  assert.equal(result.counts.methods, 1);
  assert.equal(result.counts.total, 1);
});

test("SourceService diffClassSignatures with non-obfuscated mapping remaps member deltas", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-remap-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      // Should receive obfuscated name
      assert.equal(input.fqn, "net.minecraft.server.Main");
      const version = input.jarPath.includes("1.0.0") ? "1.0.0" : "1.0.1";
      if (version === "1.0.0") {
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.server.Main",
              name: "f_old",
              javaSignature: "public int f_old",
              jvmDescriptor: "I",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          methods: [],
          warnings: []
        };
      }
      return {
        constructors: [],
        fields: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "f_new",
            javaSignature: "public int f_new",
            jvmDescriptor: "I",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        methods: [],
        warnings: []
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.IntermediaryMain" && input.targetMapping === "obfuscated") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      if (input.kind === "class" && input.name === "net.minecraft.server.Main" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.IntermediaryMain" }, warnings: [] };
      }
      if (input.kind === "field" && input.name === "f_old" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "field_1234" }, warnings: [] };
      }
      if (input.kind === "field" && input.name === "f_new" && input.targetMapping === "intermediary") {
        return { resolved: true, resolvedSymbol: { name: "field_5678" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
    }) => Promise<{
      query: { className: string; mapping: string };
      fields: {
        added: Array<{ name: string; ownerFqn: string }>;
        removed: Array<{ name: string; ownerFqn: string }>;
      };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.IntermediaryMain",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary"
  });

  // Query should echo user's input
  assert.equal(result.query.className, "net.minecraft.server.IntermediaryMain");
  assert.equal(result.query.mapping, "intermediary");
  // Added members should be remapped
  assert.equal(result.fields.added.length, 1);
  assert.equal(result.fields.added[0].name, "field_5678");
  assert.equal(result.fields.added[0].ownerFqn, "net.minecraft.server.IntermediaryMain");
  // Removed members should be remapped
  assert.equal(result.fields.removed.length, 1);
  assert.equal(result.fields.removed[0].name, "field_1234");
  assert.equal(result.fields.removed[0].ownerFqn, "net.minecraft.server.IntermediaryMain");
});

test("SourceService diffClassSignatures remaps non-obfuscated class per endpoint version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-diff-versioned-map-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.1", "1.0.0"];
  const versionByJarPath = new Map(versions.map((version) => [join(root, `${version}.jar`), version]));
  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versions;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      if (version === "1.0.0") {
        if (input.fqn !== "net.minecraft.server.OldMain") {
          throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
        }
      } else if (input.fqn !== "net.minecraft.server.NewMain") {
        throw Object.assign(new Error("class not found"), { code: ERROR_CODES.CLASS_NOT_FOUND });
      }
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: []
      };
    }
  };

  const mappingCalls: Array<{ version: string; sourceMapping: string; targetMapping: string; name: string }> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { version: string; sourceMapping: string; targetMapping: string; name: string }) {
      mappingCalls.push({
        version: input.version,
        sourceMapping: input.sourceMapping,
        targetMapping: input.targetMapping,
        name: input.name
      });
      if (
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.server.InterMain" &&
        input.version === "1.0.0"
      ) {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OldMain" }, warnings: [] };
      }
      if (
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.server.InterMain" &&
        input.version === "1.0.1"
      ) {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.NewMain" }, warnings: [] };
      }
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const result = await (service as unknown as {
    diffClassSignatures: (input: {
      className: string;
      fromVersion: string;
      toVersion: string;
      mapping: "intermediary";
    }) => Promise<{
      classChange: string;
      summary: { total: { added: number; removed: number; modified: number } };
    }>;
  }).diffClassSignatures({
    className: "net.minecraft.server.InterMain",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    mapping: "intermediary"
  });

  assert.equal(result.classChange, "present_in_both");
  assert.deepEqual(result.summary.total, { added: 0, removed: 0, modified: 0 });
  assert.ok(
    mappingCalls.some(
      (call) =>
        call.version === "1.0.0" &&
        call.sourceMapping === "intermediary" &&
        call.targetMapping === "obfuscated" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
  assert.ok(
    mappingCalls.some(
      (call) =>
        call.version === "1.0.1" &&
        call.sourceMapping === "intermediary" &&
        call.targetMapping === "obfuscated" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
});

test("SourceService getClassMembers with obfuscated mapping is unchanged (regression)", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-obfuscated-regression-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; memberPattern?: string }) {
      // For obfuscated mapping, memberPattern should be passed through
      assert.equal(input.memberPattern, "tick");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tick",
            javaSignature: "public void tick()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-obfuscated",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.4" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      memberPattern: string;
    }) => Promise<{
      className: string;
      mappingApplied: string;
      members: { methods: Array<{ name: string }> };
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Main",
    target: { kind: "version", value: "1.21.4" },
    memberPattern: "tick"
  });

  assert.equal(result.className, "net.minecraft.server.Main");
  assert.equal(result.mappingApplied, "obfuscated");
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.members.methods[0].name, "tick");
});

test("SourceService getClassMembers looks up bytecode using the resolved artifact namespace", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-lookup-namespace-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "merged-mojang",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath,
    version: "1.21.10",
    requestedMapping: "mojang" as const,
    mappingApplied: "mojang" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const, binaryJarPath, version: "1.21.10" },
      transformChain: ["mapping:mojang-source-backed"]
    },
    qualityFlags: ["source-backed"],
    warnings: []
  });

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string; targetMapping: string; name: string }) {
      if (
        input.sourceMapping === "mojang" &&
        input.targetMapping === "obfuscated" &&
        input.name === "net.minecraft.world.item.Item"
      ) {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { name: "dhl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      assert.equal(input.jarPath, binaryJarPath);
      assert.equal(input.fqn, "net.minecraft.world.item.Item");
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "mojang",
          mappingNamespace: "mojang",
          jarHash: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    target: { kind: "version", value: "1.21.10" },
    mapping: "mojang"
  });

  assert.equal(result.mappingApplied, "mojang");
  assert.equal(result.className, "net.minecraft.world.item.Item");
});

test("SourceService getClassMembers infers missing artifact version from projectPath when preferred", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-project-version-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-without-version",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    files: [],
    symbols: []
  });

  let detectedProjectPath: string | undefined;
  (service as unknown as { workspaceMappingService: unknown }).workspaceMappingService = {
    async detectProjectMinecraftVersion(projectPath: string) {
      detectedProjectPath = projectPath;
      return "1.21.10";
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { sourceMapping: string; targetMapping: string; name: string; version: string }) {
      assert.equal(input.version, "1.21.10");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.targetMapping, "obfuscated");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: { name: "dhl" },
        candidates: [],
        warnings: []
      };
    }
  };

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      assert.equal(input.fqn, "dhl");
      assert.equal(input.jarPath, binaryJarPath);
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "1.21.10",
          mappingType: "obfuscated",
          mappingNamespace: "obfuscated",
          jarHash: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-without-version",
    className: "net.minecraft.world.item.Item",
    mapping: "mojang",
    projectPath: root,
    preferProjectVersion: true
  });

  assert.equal(detectedProjectPath, root);
  assert.equal(result.counts.total, 0);
  assert.equal(result.requestedMapping, "mojang");
});

test("SourceService listArtifactFiles explains that indexed artifacts do not include resources", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-list-files-diagnostics-"));
  const service = new SourceService(buildTestConfig(root));

  seedIndexedArtifact(service, {
    artifactId: "source-only-artifact",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    files: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        content: "package net.minecraft.world.item;\npublic class Item {}"
      }
    ],
    symbols: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: "net.minecraft.world.item.Item",
        line: 2
      }
    ],
    sourceJarPath: join(root, "minecraft-sources.jar"),
    binaryJarPath: join(root, "minecraft.jar"),
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-jar",
        sourceJarPath: join(root, "minecraft-sources.jar"),
        binaryJarPath: join(root, "minecraft.jar"),
        version: "1.21.10"
      },
      transformChain: ["mapping:mojang-source-backed"]
    }
  });

  const result = await service.listArtifactFiles({
    artifactId: "source-only-artifact",
    prefix: "assets/minecraft/"
  });

  assert.deepEqual(result.items, []);
  assert.equal(result.mappingApplied, "mojang");
  assert.equal(result.artifactContents.resourcesIncluded, false);
  assert.equal(result.artifactContents.sourceKind, "source-jar");
  assert.equal(result.artifactContents.sourceCoverage, "full");
  assert.ok(result.artifactContents.indexedContentKinds.includes("java-source"));
  assert.ok(result.warnings.some((warning) => warning.includes("resources") && warning.includes("not indexed")));
});

test("SourceService getClassMembers mapping fallback keeps original name and emits warning", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-fallback-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Unknown",
            name: "unknownMethod",
            javaSignature: "public void unknownMethod()",
            jvmDescriptor: "()V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping() {
      // Always fail to resolve
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "test-fallback",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "yarn" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "version" as const, value: "1.21.4" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar" as const },
      transformChain: []
    },
    qualityFlags: [],
    warnings: []
  });

  const result = await (service as unknown as {
    getClassMembers: (input: {
      className: string;
      target: { kind: "version"; value: string };
      mapping: "yarn";
    }) => Promise<{
      className: string;
      members: { methods: Array<{ name: string }> };
      warnings: string[];
    }>;
  }).getClassMembers({
    className: "net.minecraft.server.Unknown",
    target: { kind: "version", value: "1.21.4" },
    mapping: "yarn"
  });

  // Original name should be used as fallback
  assert.equal(result.members.methods[0].name, "unknownMethod");
  // Warnings should indicate mapping failures
  assert.ok(result.warnings.some((w) => w.includes("Could not remap")));
});

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

test("SourceService rejects regex queries longer than guard limit", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-regex-guard-"));
  const binaryJarPath = join(root, "server-regex-guard.jar");
  const sourcesJarPath = join(root, "server-regex-guard-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      '  String marker = "needle";',
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  await assert.rejects(
    () =>
      service.searchClassSource({
        artifactId: resolved.artifactId,
        query: "a".repeat(201),
        intent: "text",
        match: "regex",
        limit: 20
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

test("SourceService hoists fileGlob regex compilation out of regex symbol scan loop", async () => {
  const source = await readFile("src/source-service.ts", "utf8");
  const block =
    source.match(
      /const candidates = this\.symbolsRepo\.listSymbolsForArtifact\(artifactId, scope\?\.symbolKind\);[\s\S]*?return result;/
    )?.[0] ?? "";

  assert.match(
    block,
    /const glob = scope\?\.fileGlob \? buildGlobRegex\(normalizePathStyle\(scope\.fileGlob\)\) : undefined;/
  );
  assert.doesNotMatch(
    block,
    /for \(const symbol of candidates\) \{[\s\S]*const glob = buildGlobRegex\(normalizePathStyle\(scope\.fileGlob\)\);/
  );
});

test("SourceService avoids JSON.stringify equality checks in mixin output compaction", async () => {
  const source = await readFile("src/source-service.ts", "utf8");
  const block =
    source.match(/private applyValidateMixinOutputCompaction\([\s\S]*?private buildValidateMixinOutput/)?.[0] ?? "";

  assert.doesNotMatch(block, /JSON\.stringify\(entry\)/);
});

test("SourceService centralizes quality flag deduplication instead of rebuilding inline Sets", async () => {
  const source = await readFile("src/source-service.ts", "utf8");

  assert.match(source, /function dedupeQualityFlags\(/);
  assert.doesNotMatch(source, /qualityFlags = \[\.\.\.new Set/);
});

test("SourceService resolveClassFilePath delegates to a combined repo lookup instead of sequential probes", async () => {
  const source = await readFile("src/source-service.ts", "utf8");
  const block =
    source.match(/private resolveClassFilePath\([\s\S]*?^\s{2}\}/m)?.[0] ?? "";

  assert.match(block, /return this\.filesRepo\.findBestClassLookupPath\(/);
  assert.doesNotMatch(block, /this\.symbolsRepo\.findBestClassFilePath/);
  assert.doesNotMatch(block, /this\.filesRepo\.findFirstFilePathByName/);
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
    mapping: "obfuscated"
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

// ---------------------------------------------------------------------------
// B2: suggestedCall preserves scope in MAPPING_NOT_APPLIED errors
// ---------------------------------------------------------------------------
test("B2: resolveArtifact preserves scope in suggestedCall when mapping fails", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b2-scope-"));
  const binaryJarPath = join(root, "server-b2.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: binaryJarPath },
        mapping: "mojang",
        scope: "vanilla",
        allowDecompile: false
      } as any),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const suggested = details.suggestedCall as { tool: string; params: Record<string, unknown> } | undefined;
      return (
        suggested != null &&
        suggested.params.scope === "vanilla"
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B2: suggestedCall preserves scope in intermediary/yarn no-version error
// ---------------------------------------------------------------------------
test("B2: resolveArtifact preserves scope in intermediary no-version suggestedCall", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b2-intermediary-"));
  const sourceJarPath = join(root, "demo-sources.jar");

  await createJar(sourceJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: sourceJarPath },
        mapping: "intermediary",
        scope: "merged"
      } as any),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const suggested = details.suggestedCall as { tool: string; params: Record<string, unknown> } | undefined;
      return (
        suggested != null &&
        suggested.params.scope === "merged" &&
        typeof suggested.params.target === "object" &&
        suggested.params.target !== null &&
        (suggested.params.target as { kind?: string }).kind === "version" &&
        !("targetKind" in suggested.params) &&
        !("targetValue" in suggested.params)
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B3: vanilla + mojang error suggests scope=merged when projectPath present
// ---------------------------------------------------------------------------
test("B3: resolveArtifact vanilla+mojang with projectPath suggests scope=merged", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b3-vanilla-mojang-"));
  const binaryJarPath = join(root, "server-b3.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: binaryJarPath },
        mapping: "mojang",
        scope: "vanilla",
        projectPath: root,
        allowDecompile: false
      } as any),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const suggested = details.suggestedCall as { tool: string; params: Record<string, unknown> } | undefined;
      return (
        suggested != null &&
        suggested.params.scope === "merged" &&
        suggested.params.mapping === "mojang" &&
        typeof suggested.params.target === "object" &&
        suggested.params.target !== null &&
        (suggested.params.target as { kind?: string; value?: string }).kind === "jar" &&
        (suggested.params.target as { kind?: string; value?: string }).value === binaryJarPath &&
        !("targetKind" in suggested.params) &&
        !("targetValue" in suggested.params) &&
        typeof suggested.params.projectPath === "string" &&
        typeof details.nextAction === "string" &&
        (details.nextAction as string).includes("scope=vanilla blocks Loom")
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B3: vanilla + mojang without projectPath suggests mapping=obfuscated
// ---------------------------------------------------------------------------
test("B3: resolveArtifact vanilla+mojang without projectPath suggests mapping=obfuscated", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b3-no-project-"));
  const binaryJarPath = join(root, "server-b3np.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: binaryJarPath },
        mapping: "mojang",
        scope: "vanilla",
        allowDecompile: false
      } as any),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const suggested = details.suggestedCall as { tool: string; params: Record<string, unknown> } | undefined;
      return (
        suggested != null &&
        suggested.params.mapping === "obfuscated" &&
        suggested.params.scope === "vanilla" &&
        typeof suggested.params.target === "object" &&
        suggested.params.target !== null &&
        (suggested.params.target as { kind?: string; value?: string }).kind === "jar" &&
        (suggested.params.target as { kind?: string; value?: string }).value === binaryJarPath &&
        !("targetKind" in suggested.params) &&
        !("targetValue" in suggested.params) &&
        typeof details.nextAction === "string" &&
        (details.nextAction as string).includes("mapping=obfuscated")
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B1: CLASS_NOT_FOUND includes scope, target context, and retry hints
// ---------------------------------------------------------------------------
test("B1: getClassSource CLASS_NOT_FOUND includes scope and target context", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b1-class-"));
  const binaryJarPath = join(root, "server-b1.jar");
  const sourcesJarPath = join(root, "server-b1-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        className: "net.minecraft.world.level.block.Blocks",
        mode: "full"
      }),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.CLASS_NOT_FOUND) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      return (
        details.artifactId === resolved.artifactId &&
        details.mapping === "obfuscated" &&
        typeof details.nextAction === "string" &&
        details.suggestedCall != null
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B1: CLASS_NOT_FOUND with target includes scope and targetKind
// ---------------------------------------------------------------------------
test("B1: getClassSource CLASS_NOT_FOUND with target includes scope/targetKind/targetValue", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b1-target-"));
  const binaryJarPath = join(root, "server-b1t.jar");
  const sourcesJarPath = join(root, "server-b1t-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/Existing.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "com/example/Existing.java": "package com.example;\npublic class Existing {}"
  });

  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      service.getClassSource({
        target: { kind: "jar", value: binaryJarPath },
        className: "com.example.Missing",
        scope: "vanilla",
        mode: "full"
      } as any),
    (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.CLASS_NOT_FOUND) return false;
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      return (
        details.scope === "vanilla" &&
        details.targetKind === "jar" &&
        details.targetValue === binaryJarPath
      );
    }
  );
});

// ---------------------------------------------------------------------------
// B4: version-approximated flag when source jar doesn't contain exact version
// ---------------------------------------------------------------------------
test("B4: resolveArtifact flags representative version-approximated mismatches", { concurrency: false }, async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  async function withVersionApproximationFixture(
    input: {
      rootPrefix: string;
      requestedVersion: string;
      loomSourceVersion: string;
    },
    run: (args: { service: SourceServiceFixture; projectPath: string }) => Promise<void>
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const projectPath = join(root, "workspace");
    const loomCache = join(projectPath, ".gradle", "loom-cache");
    await mkdir(loomCache, { recursive: true });
    const loomSourceJarPath = join(
      loomCache,
      `minecraft-${input.loomSourceVersion}-merged-sources.jar`
    );
    await createJar(loomSourceJarPath, {
      "net/minecraft/world/level/block/Blocks.java":
        "package net.minecraft.world.level.block;\npublic class Blocks {}"
    });

    const remoteJarPath = join(root, `remote-${input.requestedVersion}.jar`);
    await createJar(remoteJarPath, {
      "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });
    const remoteJarBytes = await readFile(remoteJarPath);

    const originalFetch = globalThis.fetch;
    const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
    process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

    globalThis.fetch = (async (requestInput: string | URL | Request) => {
      const url =
        typeof requestInput === "string"
          ? requestInput
          : requestInput instanceof URL
            ? requestInput.toString()
            : requestInput.url;
      if (url === "https://example.test/version_manifest_v2.json") {
        return new Response(
          JSON.stringify({
            latest: { release: input.requestedVersion },
            versions: [
              {
                id: input.requestedVersion,
                type: "release",
                url: `https://example.test/versions/${input.requestedVersion}.json`
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === `https://example.test/versions/${input.requestedVersion}.json`) {
        return new Response(
          JSON.stringify({
            id: input.requestedVersion,
            downloads: { client: { url: `https://example.test/downloads/client-${input.requestedVersion}.jar` } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === `https://example.test/downloads/client-${input.requestedVersion}.jar`) {
        return new Response(remoteJarBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const service = new SourceService(buildTestConfig(root));
      await run({ service, projectPath });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalManifestUrl === undefined) {
        delete process.env.MCP_VERSION_MANIFEST_URL;
      } else {
        process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
      }
    }
  }

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

// ---------------------------------------------------------------------------
// B5: compact search output omits totalApprox
// ---------------------------------------------------------------------------
test("B5: searchClassSource omits totalApprox from compact search results", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-b5-totalapprox-"));
  const binaryJarPath = join(root, "server-b5.jar");
  const sourcesJarPath = join(root, "server-b5-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main { int x = 1; }"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // Query that won't match anything in the content
  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "zzz_completely_nonexistent_needle_zzz",
    intent: "text",
    match: "contains",
    limit: 10
  });
  assert.equal(result.hits.length, 0);
  assert.equal("totalApprox" in result, false);
});

test("SourceService validateMixin handles representative scope and mapping resolution flows", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateMixinResolutionContext = {
    root: string;
    jarPath: string;
    service: SourceServiceFixture;
  };

  function buildMixinSource(methodName?: string): string {
    const lines = [
      "import net.minecraft.server.Main;",
      "import org.spongepowered.asm.mixin.Mixin;"
    ];
    if (methodName !== undefined) {
      lines.push("import org.spongepowered.asm.mixin.injection.Inject;");
      lines.push("import org.spongepowered.asm.mixin.injection.At;");
    }
    lines.push("");
    lines.push("@Mixin(Main.class)");
    lines.push("public abstract class MainMixin {");
    if (methodName !== undefined) {
      lines.push(`  @Inject(method = "${methodName}", at = @At("HEAD"))`);
      lines.push(`  private void on${methodName[0]!.toUpperCase()}${methodName.slice(1)}() {}`);
    }
    lines.push("}");
    return lines.join("\n");
  }

  function makeSignature(className: string, methodNames: string[] = []) {
    return {
      className,
      constructors: [],
      methods: methodNames.map((name) => ({
        ownerFqn: className,
        name,
        javaSignature: `void ${name}()`,
        jvmDescriptor: "()V",
        accessFlags: 1,
        isSynthetic: false
      })),
      fields: [],
      warnings: []
    };
  }

  async function createValidateMixinResolutionContext(
    rootPrefix: string,
    configOverrides: Partial<Config> = {},
    jarBaseName = "client"
  ): Promise<ValidateMixinResolutionContext> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const jarPath = join(root, `${jarBaseName}.jar`);
    await createJar(jarPath, {});
    return {
      root,
      jarPath,
      service: new SourceService(buildTestConfig(root, configOverrides))
    };
  }

  const cases: Array<{
    name: string;
    skip?: boolean;
    configOverrides?: Partial<Config>;
    run: (ctx: ValidateMixinResolutionContext) => Promise<void>;
  }> = [
    {
      name: "normalizes WSL UNC sourcePath inputs",
      skip: process.platform !== "linux",
      run: async ({ root, jarPath, service }) => {
        const sourcePath = join(root, "MainMixin.java");
        await writeFile(
          sourcePath,
          [
            "import net.minecraft.server.Main;",
            "import org.spongepowered.asm.mixin.Mixin;",
            "",
            "@Mixin(Main.class)",
            "public abstract class MainMixin {}"
          ].join("\n"),
          "utf8"
        );
        (service as any).versionService = {
          async resolveVersionJar(version: string) {
            return { version, jarPath };
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature("net.minecraft.server.Main");
          }
        };

        const previousDistro = process.env.WSL_DISTRO_NAME;
        const previousInterop = process.env.WSL_INTEROP;
        process.env.WSL_DISTRO_NAME = "UnitTestDistro";
        process.env.WSL_INTEROP = "/tmp/unit-test-interop";
        try {
          const uncSourcePath = `\\\\wsl$\\UnitTestDistro${sourcePath.replace(/\//g, "\\")}`;
          const result = await service.validateMixin({
            input: {
              mode: "path",
              path: uncSourcePath
            },
            version: "1.21",
            mapping: "obfuscated"
          } as never);

          assert.equal(result.mode, "path");
          assert.equal(result.summary.total, 1);
          assert.equal(result.summary.processingErrors, 0);
          assert.equal("errors" in result.summary, false);
          assert.equal(result.results[0]?.source.kind, "path");
          assert.equal(result.results[0]?.source.path, sourcePath);
          assert.equal(result.results[0]?.result?.valid, true);
          assert.equal(result.results[0]?.result?.provenance?.version, "1.21");
          assert.equal(result.results[0]?.result?.provenance?.jarPath, jarPath);
        } finally {
          if (previousDistro == null) {
            delete process.env.WSL_DISTRO_NAME;
          } else {
            process.env.WSL_DISTRO_NAME = previousDistro;
          }
          if (previousInterop == null) {
            delete process.env.WSL_INTEROP;
          } else {
            process.env.WSL_INTEROP = previousInterop;
          }
        }
      }
    },
    {
      name: "applies resolveArtifact mapping fallback metadata for non-vanilla scope",
      run: async ({ root, jarPath, service }) => {
        (service as any).resolveArtifact = async () => ({
          artifactId: "artifact:test",
          origin: "loom-cache",
          warnings: ["Resolve artifact warning from Loom cache."],
          mappingApplied: "obfuscated",
          provenance: {
            target: { kind: "version", value: "1.21" },
            requestedMapping: "mojang",
            mappingApplied: "obfuscated"
          },
          qualityFlags: [],
          binaryJarPath: jarPath,
          version: "1.21"
        });
        (service as any).mappingService = {
          async findMapping() {
            return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" } };
          },
          async resolveMethodMappingExact() {
            return { resolved: false };
          },
          async findCandidatesByName() {
            return [];
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature("net.minecraft.server.Main");
          }
        };

        const result = await service.validateMixin({
          input: { mode: "inline", source: buildMixinSource("missing") },
          version: "1.21",
          mapping: "mojang",
          scope: "merged",
          projectPath: root
        });

        const single = result.results[0]?.result;
        assert.equal(result.mode, "inline");
        assert.equal(single?.provenance?.mappingApplied, "obfuscated");
        assert.equal(single?.summary.definiteErrors, 0);
        assert.equal(single?.summary.uncertainErrors, 1);
        assert.equal(single?.valid, true);
        assert.equal(single?.issues[0]?.confidence, "uncertain");
        assert.ok(single?.warnings.some((w) => w.includes("Resolve artifact warning from Loom cache.")));
      }
    },
    {
      name: "uses applied mapping namespace for merged scope bytecode lookup",
      run: async ({ root, jarPath, service }) => {
        const signatureLookups: string[] = [];
        (service as any).resolveArtifact = async () => ({
          artifactId: "artifact:test",
          origin: "loom-cache",
          warnings: [],
          mappingApplied: "mojang",
          requestedMapping: "mojang",
          resolvedSourceJarPath: join(root, "minecraft-merged-sources.jar"),
          binaryJarPath: jarPath,
          provenance: {
            target: { kind: "version", value: "1.21" }
          },
          qualityFlags: [],
          version: "1.21"
        });
        (service as any).workspaceMappingService = {
          async detectCompileMapping() {
            return { resolved: false, evidence: [], warnings: [] };
          },
          async detectProjectMinecraftVersion() {
            return undefined;
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
          async findMapping() {
            return {
              resolved: true,
              status: "resolved",
              resolvedSymbol: { name: "a" },
              candidates: [],
              warnings: []
            };
          }
        };
        (service as any).explorerService = {
          async getSignature(input: { fqn: string }) {
            signatureLookups.push(input.fqn);
            if (input.fqn !== "net.minecraft.server.Main") {
              throw new Error(`missing bytecode for ${input.fqn}`);
            }
            return makeSignature("net.minecraft.server.Main", ["tick"]);
          }
        };

        const result = await service.validateMixin({
          input: { mode: "inline", source: buildMixinSource("tick") },
          version: "1.21",
          mapping: "mojang",
          scope: "merged",
          projectPath: root
        });

        const single = result.results[0]?.result;
        assert.equal(single?.validationStatus, "full");
        assert.equal(single?.summary.membersValidated, 1);
        assert.deepEqual(signatureLookups, ["net.minecraft.server.Main"]);
      }
    },
    {
      name: "retries with maven-first after loom-first partial validation",
      configOverrides: { mappingSourcePriority: "loom-first" },
      run: async ({ jarPath, service }) => {
        const seenPriorities: string[] = [];
        (service as any).versionService = {
          async resolveVersionJar(version: string) {
            return { version, jarPath };
          }
        };
        (service as any).workspaceMappingService = {
          async detectCompileMapping() {
            return { resolved: false, evidence: [], warnings: [] };
          },
          async detectProjectMinecraftVersion() {
            return undefined;
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
            name?: string;
            owner?: string;
            sourceMapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
            targetMapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
            sourcePriority?: "loom-first" | "maven-first";
          }) {
            seenPriorities.push(input.sourcePriority ?? "loom-first");
            if (input.sourcePriority === "maven-first") {
              const resolvedName =
                input.kind === "class" && input.sourceMapping === "mojang" && input.targetMapping === "obfuscated"
                  ? "a"
                  : input.kind === "class" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang"
                    ? "net.minecraft.server.Main"
                    : input.name ?? "tick";
              return {
                resolved: true,
                status: "resolved",
                resolvedSymbol: { name: resolvedName, owner: input.owner, descriptor: "()V" },
                candidates: [],
                warnings: []
              };
            }
            return {
              resolved: false,
              status: "not_found",
              candidates: [],
              warnings: []
            };
          },
          async checkSymbolExists() {
            return {
              resolved: true,
              status: "resolved",
              candidates: [],
              warnings: []
            };
          }
        };
        (service as any).explorerService = {
          async getSignature(input: { fqn: string }) {
            if (input.fqn !== "a") {
              throw new Error(`missing bytecode for ${input.fqn}`);
            }
            return makeSignature("a", ["tick"]);
          }
        };

        const result = await service.validateMixin({
          input: { mode: "inline", source: buildMixinSource("tick") },
          version: "1.21",
          mapping: "mojang"
        });

        const single = result.results[0]?.result;
        assert.deepEqual(seenPriorities, ["loom-first", "maven-first", "maven-first", "maven-first"]);
        assert.equal(single?.valid, true);
        assert.equal(single?.validationStatus, "full");
        assert.equal(single?.provenance?.requestedSourcePriority, "loom-first");
        assert.equal(single?.provenance?.appliedSourcePriority, "maven-first");
        assert.equal(single?.provenance?.requestedScope, "vanilla");
        assert.equal(single?.provenance?.appliedScope, "vanilla");
        assert.ok(single?.warnings.some((warning) => warning.includes("Retrying validate-mixin with sourcePriority")));
      }
    },
    {
      name: "auto-detects mapping from project when mapping param omitted",
      run: async ({ root, jarPath, service }) => {
        (service as any).versionService = {
          async resolveVersionJar(version: string) {
            return { version, jarPath };
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature("net.minecraft.server.Main", ["tick"]);
          }
        };
        (service as any).workspaceMappingService = {
          async detectCompileMapping() {
            return {
              resolved: true,
              mappingApplied: "mojang",
              evidence: [],
              warnings: ["Found officialMojangMappings() in build.gradle."]
            };
          },
          async detectProjectMinecraftVersion() {
            return undefined;
          }
        };
        (service as any).mappingService = {
          async findMapping() {
            return {
              resolved: true,
              resolvedSymbol: { name: "net.minecraft.server.Main" },
              status: "resolved",
              warnings: []
            };
          }
        };

        const result = await service.validateMixin({
          input: { mode: "inline", source: buildMixinSource() },
          version: "1.21",
          projectPath: root
        });

        const single = result.results[0]?.result;
        assert.equal(result.mode, "inline");
        assert.equal(single?.provenance?.mappingAutoDetected, true);
        assert.equal(single?.provenance?.requestedMapping, "mojang");
        assert.ok(single?.warnings.some((w) => w.includes("Auto-detected mapping")));
      }
    }
  ];

  for (const testCase of cases) {
    if (testCase.skip === true) {
      continue;
    }
    await t.test(testCase.name, async () => {
      const ctx = await createValidateMixinResolutionContext(
        `service-${testCase.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-`,
        testCase.configOverrides
      );
      await testCase.run(ctx);
    });
  }
});

test("SourceService validateMixin handles representative scope fallback and reporting flows", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateMixinReportContext = {
    root: string;
    jarPath: string;
    service: SourceServiceFixture;
  };

  function buildClassOnlyMixinSource(): string {
    return [
      "import net.minecraft.server.Main;",
      "import org.spongepowered.asm.mixin.Mixin;",
      "",
      "@Mixin(Main.class)",
      "public abstract class MainMixin {}"
    ].join("\n");
  }

  function buildBadAccessorSource(): string {
    return [
      "import net.minecraft.server.Main;",
      "import org.spongepowered.asm.mixin.Mixin;",
      "import org.spongepowered.asm.mixin.gen.Accessor;",
      "",
      "@Mixin(Main.class)",
      "public interface BadAccessorMixin {",
      "  @Accessor",
      "  int notAMethod;",
      "}"
    ].join("\n");
  }

  function makeSignature(methodNames: string[] = []) {
    return {
      className: "net.minecraft.server.Main",
      constructors: [],
      methods: methodNames.map((name) => ({
        ownerFqn: "net.minecraft.server.Main",
        name,
        javaSignature: `void ${name}()`,
        jvmDescriptor: "()V",
        accessFlags: 1,
        isSynthetic: false
      })),
      fields: [],
      warnings: []
    };
  }

  async function createValidateMixinReportContext(
    rootPrefix: string,
    jarBaseName = "client"
  ): Promise<ValidateMixinReportContext> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const jarPath = join(root, `${jarBaseName}.jar`);
    await createJar(jarPath, {});
    return {
      root,
      jarPath,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    jarBaseName?: string;
    run: (ctx: ValidateMixinReportContext) => Promise<void>;
  }> = [
    {
      name: "falls back to vanilla when merged resolution fails",
      run: async ({ root, jarPath, service }) => {
        (service as any).versionService = {
          async resolveVersionJar(version: string) {
            return { version, jarPath };
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature(["tick"]);
          }
        };
        (service as any).resolveArtifact = async () => {
          throw new Error("Loom cache not found for version 1.21");
        };
        (service as any).workspaceMappingService = {
          async detectCompileMapping() {
            return { resolved: false, evidence: [], warnings: [] };
          },
          async detectProjectMinecraftVersion() {
            return undefined;
          }
        };

        const result = await service.validateMixin({
          input: {
            mode: "inline",
            source: buildClassOnlyMixinSource()
          },
          version: "1.21",
          mapping: "obfuscated",
          scope: "merged",
          projectPath: root
        });

        const single = result.results[0]?.result;
        assert.ok(single?.provenance?.scopeFallback);
        assert.equal(single?.provenance?.scopeFallback?.requested, "merged");
        assert.equal(single?.provenance?.scopeFallback?.applied, "vanilla");
        assert.ok(single?.provenance?.scopeFallback?.reason.includes("Loom cache"));
        assert.equal(single?.provenance?.jarType, "vanilla-client");
        assert.ok(single?.warnings.some((w) => w.includes("falling back to vanilla")));
      }
    },
    {
      name: "reports requested loader scope separately from applied merged scope",
      jarBaseName: "minecraft-merged-1.21",
      run: async ({ root, jarPath, service }) => {
        (service as any).resolveArtifact = async () => ({
          artifactId: "artifact:test",
          origin: "loom-cache",
          warnings: [],
          mappingApplied: "obfuscated",
          requestedMapping: "obfuscated",
          resolvedSourceJarPath: join(root, "minecraft-merged-1.21-sources.jar"),
          binaryJarPath: jarPath,
          provenance: {
            target: { kind: "version", value: "1.21" }
          },
          qualityFlags: [],
          version: "1.21"
        });
        (service as any).mappingService = {
          async checkMappingHealth() {
            return {
              mojangMappingsAvailable: true,
              tinyMappingsAvailable: true,
              memberRemapAvailable: true,
              degradations: []
            };
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature();
          }
        };

        const result = await service.validateMixin({
          input: {
            mode: "inline",
            source: buildClassOnlyMixinSource()
          },
          version: "1.21",
          mapping: "obfuscated",
          scope: "loader",
          projectPath: root
        });

        const single = result.results[0]?.result;
        assert.equal(single?.provenance?.requestedScope, "loader");
        assert.equal(single?.provenance?.appliedScope, "merged");
        assert.equal(single?.provenance?.jarType, "merged");
      }
    },
    {
      name: "hideUncertain recomputes parseWarnings summary",
      run: async ({ jarPath, service }) => {
        (service as any).versionService = {
          async resolveVersionJar(version: string) {
            return { version, jarPath };
          }
        };
        (service as any).explorerService = {
          async getSignature() {
            return makeSignature();
          }
        };

        const result = await service.validateMixin({
          input: {
            mode: "inline",
            source: buildBadAccessorSource()
          },
          version: "1.21",
          mapping: "obfuscated",
          hideUncertain: true
        });

        const single = result.results[0]?.result;
        assert.equal(single?.issues.length, 0);
        assert.equal(single?.summary.warnings, 0);
        assert.equal(single?.summary.parseWarnings, 0);
        assert.equal(single?.unfilteredSummary?.parseWarnings, 1);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const ctx = await createValidateMixinReportContext(
        `service-${testCase.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-`,
        testCase.jarBaseName
      );
      await testCase.run(ctx);
    });
  }
});

test("SourceService validateMixin summary-first hoists shared provenance and incomplete reasons", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-summary-first-"));
  const service = new SourceService(buildTestConfig(root));

  const sharedProvenance = {
    version: "1.21",
    jarPath: join(root, "client.jar"),
    requestedMapping: "mojang" as const,
    mappingApplied: "mojang" as const,
    requestedScope: "vanilla" as const,
    appliedScope: "vanilla" as const,
    requestedSourcePriority: "loom-first" as const,
    appliedSourcePriority: "loom-first" as const,
    resolutionTrace: [
      {
        target: "net.minecraft.server.Main",
        step: "signature" as const,
        input: "net.minecraft.server.Main",
        output: "missing metadata",
        success: false
      }
    ]
  };

  (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) => ({
    className: sourcePath?.includes("World") ? "WorldMixin" : "PlayerMixin",
    targets: ["net.minecraft.server.Main"],
    valid: true,
    validationStatus: "partial",
    issues: [
      {
        severity: "warning",
        kind: "validation-incomplete",
        annotation: "@Mixin",
        target: "net.minecraft.server.Main",
        message: "Target metadata could not be loaded completely; member validation was skipped.",
        confidence: "uncertain",
        category: "resolution",
        resolutionPath: "source-signature-unavailable",
        issueOrigin: "tool_issue",
        falsePositiveRisk: "high"
      }
    ],
    summary: {
      injections: 1,
      shadows: 0,
      accessors: 0,
      total: 1,
      membersValidated: 0,
      membersSkipped: 1,
      membersMissing: 0,
      errors: 0,
      warnings: 1,
      definiteErrors: 0,
      uncertainErrors: 0,
      resolutionErrors: 1,
      parseWarnings: 0
    },
    provenance: sharedProvenance,
    warnings: ["Shared validation warning"],
    confidenceScore: 80,
    confidenceBreakdown: {
      baseScore: 100,
      score: 80,
      penalties: [{ reason: "members-skipped", points: 20 }]
    },
    quickSummary: "0 error(s), 0 uncertain, 1 warning(s). 0 validated, 1 member(s) skipped, 0 member(s) missing."
  });

  const result = await service.validateMixin({
    input: {
      mode: "paths",
      paths: ["PlayerMixin.java", "WorldMixin.java"]
    },
    version: "1.21",
    mapping: "mojang",
    reportMode: "summary-first"
  });

  assert.equal(result.summary.total, 2);
  assert.equal(result.provenance?.version, "1.21");
  assert.equal(result.provenance?.resolutionTrace?.length, 1);
  assert.equal(result.incompleteReasons?.length, 1);
  assert.ok(result.incompleteReasons?.[0]?.includes("validation-incomplete"));
  assert.deepEqual(result.warnings, ["Shared validation warning"]);
  assert.equal(result.results[0]?.result?.provenance, undefined);
  assert.equal(result.results[0]?.result?.warnings.length, 0);
  assert.equal(result.results[0]?.result?.confidenceBreakdown, undefined);
});

test("SourceService validateMixin summary-first preserves per-result provenance when batch provenance differs", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-summary-first-mixed-"));
  const service = new SourceService(buildTestConfig(root));

  (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) => {
    const isWorld = sourcePath?.includes("World");
    return {
      className: isWorld ? "WorldMixin" : "PlayerMixin",
      targets: ["net.minecraft.server.Main"],
      valid: true,
      validationStatus: "partial",
      issues: [
        {
          severity: "warning",
          kind: "validation-incomplete",
          annotation: "@Mixin",
          target: "net.minecraft.server.Main",
          message: "Target metadata could not be loaded completely; member validation was skipped.",
          confidence: "uncertain",
          category: "resolution",
          resolutionPath: "source-signature-unavailable",
          issueOrigin: "tool_issue",
          falsePositiveRisk: "high"
        }
      ],
      summary: {
        injections: 1,
        shadows: 0,
        accessors: 0,
        total: 1,
        membersValidated: 0,
        membersSkipped: 1,
        membersMissing: 0,
        errors: 0,
        warnings: 1,
        definiteErrors: 0,
        uncertainErrors: 0,
        resolutionErrors: 1,
        parseWarnings: 0
      },
      provenance: {
        version: "1.21",
        jarPath: join(root, "client.jar"),
        requestedMapping: "mojang" as const,
        mappingApplied: "mojang" as const,
        requestedScope: "vanilla" as const,
        appliedScope: "vanilla" as const,
        requestedSourcePriority: "loom-first" as const,
        appliedSourcePriority: isWorld ? "maven-first" as const : "loom-first" as const
      },
      warnings: [isWorld ? "World validation warning" : "Player validation warning"],
      confidenceScore: 80,
      quickSummary: "0 error(s), 0 uncertain, 1 warning(s). 0 validated, 1 member(s) skipped, 0 member(s) missing."
    };
  };

  const result = await service.validateMixin({
    input: {
      mode: "paths",
      paths: ["PlayerMixin.java", "WorldMixin.java"]
    },
    version: "1.21",
    mapping: "mojang",
    reportMode: "summary-first"
  });

  assert.equal(result.provenance, undefined);
  assert.equal(result.results[0]?.result?.provenance?.appliedSourcePriority, "loom-first");
  assert.equal(result.results[1]?.result?.provenance?.appliedSourcePriority, "maven-first");
  assert.deepEqual(result.results[0]?.result?.warnings, ["Player validation warning"]);
  assert.deepEqual(result.results[1]?.result?.warnings, ["World validation warning"]);
});

test("SourceService validateMixin can omit per-result issues while preserving summaries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-no-issues-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const service = new SourceService(buildTestConfig(root));
  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "net.minecraft.server.Main",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "inline",
      source: [
        "import net.minecraft.server.Main;",
        "import org.spongepowered.asm.mixin.Mixin;",
        "import org.spongepowered.asm.mixin.gen.Accessor;",
        "",
        "@Mixin(Main.class)",
        "public interface BadAccessorMixin {",
        "  @Accessor",
        "  int notAMethod;",
        "}"
      ].join("\n")
    },
    version: "1.21",
    mapping: "obfuscated",
    includeIssues: false
  } as never);

  const single = result.results[0]?.result;
  assert.equal(single?.issues.length, 0);
  assert.equal(single?.summary.warnings, 1);
  assert.equal(result.issueSummary?.[0]?.count, 1);
});

test("SourceService validateMixin mixinConfigPath auto-detect finds multiple module source roots", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-config-roots-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const commonJavaRoot = join(root, "common", "src", "main", "java", "com", "example");
  const neoJavaRoot = join(root, "neoforge", "src", "main", "java", "com", "example");
  const mixinConfigPath = join(root, "neoforge", "src", "main", "resources", "example.mixins.json");

  await mkdir(commonJavaRoot, { recursive: true });
  await mkdir(neoJavaRoot, { recursive: true });
  await mkdir(join(root, "neoforge", "src", "main", "resources"), { recursive: true });

  const mixinSource = [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    "@Mixin(Main.class)",
    "public abstract class __CLASS__ {}"
  ].join("\n");

  await writeFile(
    join(commonJavaRoot, "CommonMixin.java"),
    mixinSource.replace("__CLASS__", "CommonMixin"),
    "utf8"
  );
  await writeFile(
    join(neoJavaRoot, "NeoMixin.java"),
    mixinSource.replace("__CLASS__", "NeoMixin"),
    "utf8"
  );
  await writeFile(
    mixinConfigPath,
    JSON.stringify({ package: "com.example", mixins: ["CommonMixin", "NeoMixin"] }, null, 2),
    "utf8"
  );

  const service = new SourceService(buildTestConfig(root));
  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "net.minecraft.server.Main",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
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
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "config",
      configPaths: [mixinConfigPath]
    },
    projectPath: root,
    version: "1.21",
    mapping: "obfuscated"
  } as never);

  assert.equal(result.mode, "config");
  assert.equal(result.summary.total, 2);
  assert.equal("errors" in result.summary, false);
  assert.equal(result.summary.processingErrors, 0);
  assert.equal(result.summary.valid, 2);
  assert.equal(result.summary.invalid, 0);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.filter((r) => r.error != null).length, 0);
  assert.equal(result.results.filter((r) => r.result?.valid === true).length, 2);
  assert.equal(result.results.every((r) => r.source.kind === "config"), true);
  assert.equal(result.results.every((r) => r.source.configPath === mixinConfigPath), true);
});

test("SourceService validateMixin mixinConfigPath auto-detect finds client source root (split source sets)", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-client-root-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const clientJavaRoot = join(root, "src", "client", "java", "com", "example", "mixin", "client");
  const mixinConfigPath = join(root, "src", "client", "resources", "modid.client.mixins.json");

  await mkdir(clientJavaRoot, { recursive: true });
  await mkdir(join(root, "src", "client", "resources"), { recursive: true });

  await writeFile(
    join(clientJavaRoot, "ExampleClientMixin.java"),
    [
      "package com.example.mixin.client;",
      "",
      "import net.minecraft.client.Minecraft;",
      "import org.spongepowered.asm.mixin.Mixin;",
      "",
      "@Mixin(Minecraft.class)",
      "public class ExampleClientMixin {}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    mixinConfigPath,
    JSON.stringify({
      required: true,
      package: "com.example.mixin.client",
      client: ["ExampleClientMixin"]
    }, null, 2),
    "utf8"
  );

  const service = new SourceService(buildTestConfig(root));
  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "net.minecraft.client.Minecraft",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
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
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "config",
      configPaths: [mixinConfigPath]
    },
    projectPath: root,
    version: "1.21",
    mapping: "obfuscated"
  });

  assert.equal(result.mode, "config");
  assert.equal(result.summary.total, 1);
  assert.equal("errors" in result.summary, false);
  assert.equal(result.summary.processingErrors, 0);
  assert.equal(result.summary.valid, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].result?.valid, true);
});

test("SourceService validateMixin mixinConfigPath finds mixins in both main and client source roots", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-mixed-roots-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const mainJavaRoot = join(root, "src", "main", "java", "com", "example", "mixin");
  const clientJavaRoot = join(root, "src", "client", "java", "com", "example", "mixin", "client");
  const mixinConfigDir = join(root, "src", "main", "resources");

  await mkdir(mainJavaRoot, { recursive: true });
  await mkdir(clientJavaRoot, { recursive: true });
  await mkdir(mixinConfigDir, { recursive: true });

  const mixinSource = [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    "@Mixin(Main.class)",
    "public abstract class __CLASS__ {}"
  ].join("\n");

  await writeFile(
    join(mainJavaRoot, "ServerMixin.java"),
    mixinSource.replace("__CLASS__", "ServerMixin"),
    "utf8"
  );
  await writeFile(
    join(clientJavaRoot, "ClientMixin.java"),
    mixinSource.replace("__CLASS__", "ClientMixin"),
    "utf8"
  );

  const mixinConfigPath = join(mixinConfigDir, "modid.mixins.json");
  await writeFile(
    mixinConfigPath,
    JSON.stringify({
      package: "com.example.mixin",
      mixins: ["ServerMixin"],
      client: ["client.ClientMixin"]
    }, null, 2),
    "utf8"
  );

  const service = new SourceService(buildTestConfig(root));
  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "net.minecraft.server.Main",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
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
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "config",
      configPaths: [mixinConfigPath]
    },
    projectPath: root,
    version: "1.21",
    mapping: "obfuscated"
  });

  assert.equal(result.mode, "config");
  assert.equal(result.summary.total, 2);
  assert.equal("errors" in result.summary, false);
  assert.equal(result.summary.processingErrors, 0);
  assert.equal(result.summary.valid, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.filter((r) => r.result?.valid === true).length, 2);
});

test("SourceService validateMixin project mode auto-discovers mixin configs across modules", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-mixin-project-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});

  const commonJavaRoot = join(root, "common", "src", "main", "java", "com", "example");
  const neoJavaRoot = join(root, "neoforge", "src", "main", "java", "com", "example");
  const commonConfigPath = join(root, "common", "src", "main", "resources", "example.mixins.json");
  const neoConfigPath = join(root, "neoforge", "src", "main", "resources", "example.neoforge.mixins.json");

  await mkdir(commonJavaRoot, { recursive: true });
  await mkdir(neoJavaRoot, { recursive: true });
  await mkdir(join(root, "common", "src", "main", "resources"), { recursive: true });
  await mkdir(join(root, "neoforge", "src", "main", "resources"), { recursive: true });

  const mixinSource = [
    "import net.minecraft.server.Main;",
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    "@Mixin(Main.class)",
    "public abstract class __CLASS__ {}"
  ].join("\n");

  await writeFile(
    join(commonJavaRoot, "CommonMixin.java"),
    mixinSource.replace("__CLASS__", "CommonMixin"),
    "utf8"
  );
  await writeFile(
    join(neoJavaRoot, "NeoMixin.java"),
    mixinSource.replace("__CLASS__", "NeoMixin"),
    "utf8"
  );
  await writeFile(
    commonConfigPath,
    JSON.stringify({ package: "com.example", mixins: ["CommonMixin"] }, null, 2),
    "utf8"
  );
  await writeFile(
    neoConfigPath,
    JSON.stringify({ package: "com.example", mixins: ["NeoMixin"] }, null, 2),
    "utf8"
  );

  const service = new SourceService(buildTestConfig(root));
  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).explorerService = {
    async getSignature() {
      return {
        className: "net.minecraft.server.Main",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
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
    }
  };

  const result = await service.validateMixin({
    input: {
      mode: "project",
      path: root
    },
    version: "1.21",
    mapping: "obfuscated"
  } as never);

  assert.equal(result.mode, "project");
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.processingErrors, 0);
  assert.equal(result.summary.valid, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.filter((entry) => entry.source.configPath === commonConfigPath).length, 1);
  assert.equal(result.results.filter((entry) => entry.source.configPath === neoConfigPath).length, 1);
  assert.equal(result.results.every((entry) => entry.result?.valid === true), true);
});

// ---------------------------------------------------------------------------
// F-01: strictVersion rejects version-approximated results
// ---------------------------------------------------------------------------
test("F-01: resolveArtifact with strictVersion=true throws on version mismatch", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f01-strict-"));
  const projectPath = join(root, "workspace");

  // Create Loom cache with a jar named for version 1.21.10 (not 1.21.11)
  const loomCache = join(projectPath, ".gradle", "loom-cache");
  await mkdir(loomCache, { recursive: true });
  const loomSourceJarPath = join(loomCache, "minecraft-1.21.10-merged-sources.jar");
  await createJar(loomSourceJarPath, {
    "net/minecraft/world/level/block/Blocks.java":
      "package net.minecraft.world.level.block;\npublic class Blocks {}"
  });

  const remoteJarPath = join(root, "remote-1.21.11.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.11" },
          versions: [
            { id: "1.21.11", type: "release", url: "https://example.test/versions/1.21.11.json" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/versions/1.21.11.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.11",
          downloads: { client: { url: "https://example.test/downloads/client-1.21.11.jar" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/downloads/client-1.21.11.jar") {
      return new Response(remoteJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
    await assert.rejects(
      () => service.resolveArtifact({
        target: { kind: "version", value: "1.21.11" },
        mapping: "mojang",
        projectPath,
        strictVersion: true
      } as any),
      (error: any) => {
        assert.equal(error.code, ERROR_CODES.VERSION_NOT_FOUND);
        assert.ok(error.message.includes("Strict version match failed"));
        assert.equal(error.details.requestedVersion, "1.21.11");
        assert.ok(error.details.suggestedCall);
        assert.equal(error.details.suggestedCall.tool, "resolve-artifact");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

test("F-01: resolveArtifact with strictVersion=false still returns version-approximated flag", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f01-lax-"));
  const projectPath = join(root, "workspace");

  const loomCache = join(projectPath, ".gradle", "loom-cache");
  await mkdir(loomCache, { recursive: true });
  const loomSourceJarPath = join(loomCache, "minecraft-1.21.10-merged-sources.jar");
  await createJar(loomSourceJarPath, {
    "net/minecraft/world/level/block/Blocks.java":
      "package net.minecraft.world.level.block;\npublic class Blocks {}"
  });

  const remoteJarPath = join(root, "remote-1.21.11.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
  process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/version_manifest_v2.json") {
      return new Response(
        JSON.stringify({
          latest: { release: "1.21.11" },
          versions: [
            { id: "1.21.11", type: "release", url: "https://example.test/versions/1.21.11.json" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/versions/1.21.11.json") {
      return new Response(
        JSON.stringify({
          id: "1.21.11",
          downloads: { client: { url: "https://example.test/downloads/client-1.21.11.jar" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://example.test/downloads/client-1.21.11.jar") {
      return new Response(remoteJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(buildTestConfig(root));
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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalManifestUrl === undefined) {
      delete process.env.MCP_VERSION_MANIFEST_URL;
    } else {
      process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
    }
  }
});

// ---------------------------------------------------------------------------
// F-03: queryMode search fallback for separator-containing queries
// ---------------------------------------------------------------------------
test("F-03: search-class-source queryMode=auto keeps separator queries on the indexed path", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f03-auto-"));
  const service = new SourceService(buildTestConfig(root));

  // Create a jar with a file containing "dispatcher.register"
  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/commands/CommandDispatcher.java":
      "package net.minecraft.commands;\npublic class CommandDispatcher {\n  public void register() {\n    dispatcher.register(literal(\"test\"));\n  }\n}"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: jarPath }
  } as any);

  const beforePathMetrics = readSearchPathMetrics(service);
  const beforeModeMetrics = readSearchModeMetrics(service);

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
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
});

test("F-03: search-class-source queryMode=token resolves separator query through normalized indexed lookup", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f03-token-"));
  const service = new SourceService(buildTestConfig(root));

  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/commands/CommandDispatcher.java":
      "package net.minecraft.commands;\npublic class CommandDispatcher {\n  public void register() {\n    dispatcher.register(literal(\"test\"));\n  }\n}"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: jarPath }
  } as any);

  const beforePathMetrics = readSearchPathMetrics(service);
  const beforeModeMetrics = readSearchModeMetrics(service);

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
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
});

test("F-03: search-class-source queryMode=token does not fallback when indexed search is disabled", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f03-token-no-index-"));
  const service = new SourceService(buildTestConfig(root, { indexedSearchEnabled: false }));

  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/commands/CommandDispatcher.java":
      "package net.minecraft.commands;\npublic class CommandDispatcher {\n  public void register() {\n    dispatcher.register(literal(\"test\"));\n  }\n}"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: jarPath }
  } as any);

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "dispatcher.register",
    intent: "text",
    match: "contains",
    queryMode: "token"
  });
  assert.equal(result.hits.length, 0, "token mode should not fallback to literal scan when indexed search is disabled");
});

test("F-03: search-class-source queryMode=literal forces substring scan", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-f03-literal-"));
  const service = new SourceService(buildTestConfig(root));

  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/commands/CommandDispatcher.java":
      "package net.minecraft.commands;\npublic class CommandDispatcher {\n  public void register() {\n    dispatcher.register(literal(\"test\"));\n  }\n}"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: jarPath }
  } as any);

  const beforePathMetrics = readSearchPathMetrics(service);
  const beforeModeMetrics = readSearchModeMetrics(service);

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
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
});

test("resolveArtifact maps missing target.kind=jar paths to ERR_JAR_NOT_FOUND", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-missing-jar-resolve-"));
  const service = new SourceService(buildTestConfig(root));
  const missingJarPath = join(root, "missing.jar");

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: missingJarPath }
      } as any),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.JAR_NOT_FOUND);
      assert.match(String((error as { message?: string }).message), /missing\.jar/);
      return true;
    }
  );
});

test("getClassSource preserves ERR_JAR_NOT_FOUND for missing target.kind=jar paths", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-missing-jar-source-"));
  const service = new SourceService(buildTestConfig(root));
  const missingJarPath = join(root, "missing.jar");

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "net.minecraft.world.level.block.Block",
        target: { kind: "jar", value: missingJarPath }
      } as any),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.JAR_NOT_FOUND);
      assert.match(String((error as { message?: string }).message), /missing\.jar/);
      return true;
    }
  );
});
