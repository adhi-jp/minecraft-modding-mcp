import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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
    mapping: "official"
  });

  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.requestedMapping, "official");
  assert.equal(resolved.mappingApplied, "official");
  assert.equal(resolved.provenance.target.kind, "jar");
  assert.equal(resolved.provenance.target.value, binaryJarPath);

  const searched = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tickServer",
    intent: "symbol",
    match: "exact",
    include: {
      snippetLines: 6,
      includeDefinition: true,
      includeOneHop: true
    },
    limit: 5
  });
  assert.ok(searched.hits.length >= 1);
  assert.equal(searched.hits[0]?.symbol?.symbolName, "tickServer");
  assert.match(searched.hits[0]?.snippet ?? "", /tickServer/);
  assert.ok((searched.hits[0]?.startLine ?? 0) >= 1);
  assert.ok((searched.hits[0]?.endLine ?? 0) >= (searched.hits[0]?.startLine ?? 0));
  assert.ok((searched.relations?.length ?? 0) >= 1);
  assert.equal(searched.mappingApplied, "official");

  const textRegexSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "tick[A-Za-z]+",
    intent: "text",
    match: "regex",
    include: { snippetLines: 6 },
    limit: 5
  });
  assert.ok(textRegexSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/Main.java"));
  assert.equal(textRegexSearch.mappingApplied, "official");

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "net/minecraft/server/Main.java"
  });
  assert.match(file.content, /class Main/);
  assert.equal(file.mappingApplied, "official");

  const classSource = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "net.minecraft.server.Main"
  });
  assert.equal(classSource.mode, "metadata");
  assert.equal(classSource.mappingApplied, "official");
  assert.match(classSource.sourceText, /tickServer/);
  assert.equal(classSource.provenance.target.kind, "jar");
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

test("SourceService uses lightweight search defaults for snippet and one-hop expansion", async () => {
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
    mapping: "official"
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
  assert.equal(tickServerHit.endLine - tickServerHit.startLine + 1, 8);
  assert.equal(searched.relations, undefined);
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
    mapping: "official"
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

test("SourceService uses indexed search path for contains text/path queries without scope", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-indexed-contains-"));
  const binaryJarPath = join(root, "server-indexed.jar");
  const sourcesJarPath = join(root, "server-indexed-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
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
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "official"
  });

  const textSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needleValueToken",
    intent: "text",
    match: "contains",
    include: {
      includeDefinition: true,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(textSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/Main.java"));

  const pathSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "NeedlePath",
    intent: "path",
    match: "contains",
    include: {
      includeDefinition: true,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(pathSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/NeedlePath.java"));

  const metrics = readSearchPathMetrics(service);
  assert.equal(metrics.indexedHits, 2);
  assert.equal(metrics.fallbackHits, 0);
});

test("SourceService uses indexed search path for exact and prefix path queries without scope", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-indexed-exact-prefix-"));
  const binaryJarPath = join(root, "server-indexed-mixed.jar");
  const sourcesJarPath = join(root, "server-indexed-mixed-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
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
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "official"
  });

  const pathExactSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "net/minecraft/server/NeedlePath.java",
    intent: "path",
    match: "exact",
    include: {
      includeDefinition: true,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(pathExactSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/NeedlePath.java"));

  const pathPrefixSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "net/minecraft/server/Needle",
    intent: "path",
    match: "prefix",
    include: {
      includeDefinition: true,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(pathPrefixSearch.hits.some((hit) => hit.filePath === "net/minecraft/server/NeedlePath.java"));

  const metrics = readSearchPathMetrics(service);
  assert.equal(metrics.indexedHits, 2);
  assert.equal(metrics.fallbackHits, 0);
});

test("SourceService records search db I/O metrics for indexed searches", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-indexed-io-metrics-"));
  const binaryJarPath = join(root, "server-indexed-io.jar");
  const sourcesJarPath = join(root, "server-indexed-io-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    String token = \"indexedMetricsToken\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "official"
  });

  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "indexedMetricsToken",
    intent: "text",
    match: "contains",
    include: {
      includeDefinition: true,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(result.hits.length > 0);

  const ioMetrics = readSearchIoMetrics(service);
  assert.ok(ioMetrics.dbRoundtrips > 0);
  assert.ok(ioMetrics.rowsScanned > 0);
  assert.ok(ioMetrics.rowsReturned > 0);
});

test("SourceService can disable indexed path via config flag", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-indexed-disabled-"));
  const binaryJarPath = join(root, "server-indexed-disabled.jar");
  const sourcesJarPath = join(root, "server-indexed-disabled-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    String indexedNeedle = \"needleValueToken\";",
      "  }",
      "}"
    ].join("\n")
  });

  const config = buildTestConfig(root) as Config & Record<string, unknown>;
  config.indexedSearchEnabled = false;
  const service = new SourceService(config);
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const search = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needleValueToken",
    intent: "text",
    match: "contains",
    include: {
      includeDefinition: false,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(search.hits.length > 0);

  const metrics = readSearchPathMetrics(service);
  assert.equal(metrics.indexedHits, 0);
  assert.equal(metrics.fallbackHits, 1);
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
    mapping: "official"
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

test("SourceService falls back to scan path for regex and non-indexable scoped queries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-indexed-fallback-"));
  const binaryJarPath = join(root, "server-fallback.jar");
  const sourcesJarPath = join(root, "server-fallback-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void tickServer() {",
      "    String fallbackNeedle = \"needleValueToken\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const regexSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "needleValue[A-Za-z]+",
    intent: "text",
    match: "regex",
    include: {
      includeDefinition: false,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(regexSearch.hits.length > 0);

  const scopedSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "Main.java",
    intent: "path",
    match: "contains",
    scope: {
      symbolKind: "class"
    },
    include: {
      includeDefinition: false,
      includeOneHop: false
    },
    limit: 10
  });
  assert.ok(scopedSearch.hits.length > 0);

  const metrics = readSearchPathMetrics(service);
  // regex always falls back to scan; scoped queries (symbolKind) now use indexed path
  assert.equal(metrics.indexedHits, 1);
  assert.equal(metrics.fallbackHits, 1);
});

test("SourceService applies symbolKind scope filters to text and path intents", async () => {
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
    mapping: "official"
  });

  const textSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "FIELD_TOKEN",
    intent: "text",
    match: "contains",
    scope: {
      symbolKind: "method"
    },
    include: {
      includeDefinition: false,
      includeOneHop: false
    },
    limit: 10
  });
  assert.equal(textSearch.hits.length, 0);

  const pathSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "OnlyField.java",
    intent: "path",
    match: "contains",
    scope: {
      symbolKind: "method"
    },
    include: {
      includeDefinition: false,
      includeOneHop: false
    },
    limit: 10
  });
  assert.equal(pathSearch.hits.length, 0);
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
    mapping: "official"
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

test("SourceService exposes artifact-level byte accounting in runtime metrics", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-cache-accounting-"));
  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "cache-one.jar");
  const src1 = join(root, "cache-one-sources.jar");
  const jar2 = join(root, "cache-two.jar");
  const src2 = join(root, "cache-two-sources.jar");

  const fileOne = "package a;\npublic class CacheOne { String token = \"one\"; }\n";
  const fileTwo = "package b;\npublic class CacheTwo { String token = \"two\"; }\n";
  const expectedBytesOne = Buffer.byteLength(fileOne, "utf8");
  const expectedBytesTwo = Buffer.byteLength(fileTwo, "utf8");

  await createJar(jar1, { "a/CacheOne.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/CacheOne.java": fileOne });
  await createJar(jar2, { "b/CacheTwo.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/CacheTwo.java": fileTwo });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  const metrics = readCacheAccountingMetrics(service);
  assert.equal(metrics.cacheEntries, 2);
  assert.equal(metrics.totalContentBytes, expectedBytesOne + expectedBytesTwo);
  assert.equal(metrics.lru.length, 2);

  const firstRow = metrics.lru.find((entry) => entry.artifactId === first.artifactId);
  const secondRow = metrics.lru.find((entry) => entry.artifactId === second.artifactId);
  assert.equal(firstRow?.contentBytes, expectedBytesOne);
  assert.equal(secondRow?.contentBytes, expectedBytesTwo);
});

test("SourceService keeps byte accounting consistent after maxCacheBytes eviction", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-evict-bytes-"));

  const fileOne = "package a;\npublic class A { String payload = \"alpha-alpha-alpha\"; }\n";
  const fileTwo = "package b;\npublic class B { String payload = \"beta-beta-beta\"; }\n";
  const expectedBytesOne = Buffer.byteLength(fileOne, "utf8");
  const expectedBytesTwo = Buffer.byteLength(fileTwo, "utf8");

  const config = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: expectedBytesOne + 1
  });
  const service = new SourceService(config);

  const jar1 = join(root, "bytes-one.jar");
  const src1 = join(root, "bytes-one-sources.jar");
  const jar2 = join(root, "bytes-two.jar");
  const src2 = join(root, "bytes-two-sources.jar");

  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": fileOne });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": fileTwo });

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

  const metrics = readCacheAccountingMetrics(service);
  assert.equal(metrics.cacheEntries, 1);
  assert.equal(metrics.totalContentBytes, expectedBytesTwo);
  assert.equal(metrics.lru.length, 1);
  assert.equal(metrics.lru[0]?.artifactId, second.artifactId);
  assert.equal(metrics.lru[0]?.contentBytes, expectedBytesTwo);
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
    mapping: "official"
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

test("SourceService getClassMembers rejects non-official mapping without version", async () => {
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

  // Artifact from jar has no version, so non-official mapping should fail with MAPPING_NOT_APPLIED
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
          mappingNamespace: "official",
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
      mapping: "official"
    });

    assert.equal(resolved.version, "1.21.10");
    assert.equal(resolved.requestedMapping, "official");
    assert.equal(resolved.mappingApplied, "official");
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

test("SourceService ignores projectPath Loom source discovery for official mapping", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-official-project-path-"));
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
      mapping: "official",
      projectPath
    } as any);

    assert.equal(resolved.mappingApplied, "official");
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

test("SourceService exposes searchedPaths diagnostics when mojang mapping cannot be applied for version target", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-version-mojang-diagnostics-"));
  const projectPath = join(root, "workspace");
  await mkdir(projectPath, { recursive: true });

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
    await assert.rejects(
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
          typeof details.recommendedCommand === "string"
        );
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
      sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
      targetMapping: "official" | "mojang" | "intermediary" | "yarn";
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
          details.nextAction.includes("targetKind=version")
        );
      }
    );
  }
  assert.equal(called, false);
});

test("SourceService findMapping delegates to MappingService and returns lookup payload", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-find-mapping-"));
  const service = new SourceService(buildTestConfig(root));

  const mappingStub = {
    async findMapping(input: {
      version: string;
      kind: "class" | "field" | "method";
      name: string;
      owner?: string;
      descriptor?: string;
      sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
      targetMapping: "official" | "mojang" | "intermediary" | "yarn";
      sourcePriority?: "loom-first" | "maven-first";
    }) {
      return {
        querySymbol: {
          kind: input.kind,
          name: input.name,
          owner: input.owner,
          descriptor: input.descriptor,
          symbol: input.kind === "class" ? input.name : `${input.owner}.${input.name}${input.descriptor ?? ""}`
        },
        mappingContext: {
          version: input.version,
          sourceMapping: input.sourceMapping,
          targetMapping: input.targetMapping
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.server.Main",
          owner: undefined,
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
      };
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = mappingStub;
  const result = await (
    service as unknown as {
      findMapping: (input: {
        version: string;
        kind: "class" | "field" | "method";
        name: string;
        owner?: string;
        descriptor?: string;
        sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
        targetMapping: "official" | "mojang" | "intermediary" | "yarn";
        sourcePriority?: "loom-first" | "maven-first";
      }) => Promise<{ candidates: Array<{ symbol: string }> }>;
    }
  ).findMapping({
    version: "1.21.10",
    kind: "class",
    name: "a.b.C",
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(result.candidates[0]?.symbol, "net.minecraft.server.Main");
});

test("SourceService resolveMethodMappingExact delegates to MappingService", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-method-exact-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async resolveMethodMappingExact() {
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
          sourceMapping: "official",
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
      resolveMethodMappingExact: (input: {
        version: string;
        kind: "class" | "field" | "method";
        name: string;
        owner: string;
        descriptor: string;
        sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
        targetMapping: "official" | "mojang" | "intermediary" | "yarn";
      }) => Promise<{ resolved: boolean; resolvedSymbol?: { name: string } }>;
    }
  ).resolveMethodMappingExact({
    version: "1.21.10",
    kind: "method",
    owner: "a.b.C",
    name: "f",
    descriptor: "(Ljava/lang/String;)V",
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.resolvedSymbol?.name, "remove");
});

test("SourceService getClassApiMatrix delegates to MappingService", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-matrix-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async getClassApiMatrix() {
      return {
        classIdentity: {
          official: "a.b.C",
          mojang: "com.example.ValueOutput",
          intermediary: "intermediary/pkg/ValueOutput",
          yarn: "net/minecraft/nbt/visitors/StringNbtWriter$ValueOutput"
        },
        rows: [],
        warnings: []
      };
    }
  };

  const result = await (
    service as unknown as {
      getClassApiMatrix: (input: {
        version: string;
        className: string;
        classNameMapping: "official" | "mojang" | "intermediary" | "yarn";
      }) => Promise<{ classIdentity: Record<string, string | undefined> }>;
    }
  ).getClassApiMatrix({
    version: "1.21.10",
    className: "a.b.C",
    classNameMapping: "official"
  });

  assert.equal(result.classIdentity.mojang, "com.example.ValueOutput");
});

test("SourceService checkSymbolExists delegates to MappingService", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-symbol-exists-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        resolved: true,
        status: "resolved",
        warnings: []
      };
    }
  };

  const result = await (
    service as unknown as {
      checkSymbolExists: (input: {
        version: string;
        kind: "class" | "field" | "method";
        owner: string;
        name: string;
        descriptor?: string;
        sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
      }) => Promise<{ resolved: boolean; status: string }>;
    }
  ).checkSymbolExists({
    version: "1.21.10",
    kind: "method",
    owner: "a.b.C",
    name: "f",
    descriptor: "(I)V",
    sourceMapping: "official"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
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
            sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
          }) => Promise<unknown>;
        }
      ).resolveWorkspaceSymbol({
        projectPath: root,
        version: "1.21.10",
        kind: "class",
        owner: "a.b",
        name: "a.b.C",
        sourceMapping: "official"
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
      targetMapping: "official" | "mojang" | "intermediary" | "yarn";
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
          sourceMapping: "official",
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
        sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
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
    sourceMapping: "official"
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
      classNameMapping: "official" | "mojang" | "intermediary" | "yarn";
      sourcePriority?: "loom-first" | "maven-first";
    }) {
      assert.equal(input.className, "a.b.c");
      assert.equal(input.classNameMapping, "official");
      assert.equal(input.sourcePriority, "loom-first");
      return {
        classIdentity: {
          official: "a.b.c",
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
        sourceMapping: "official" | "mojang" | "intermediary" | "yarn";
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
    sourceMapping: "official",
    sourcePriority: "loom-first"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.mappingContext.targetMapping, "mojang");
  assert.equal(result.resolvedSymbol?.name, "com.example.valueoutput");
  assert.deepEqual(result.warnings, ["workspace warning", "matrix warning"]);
});

test("SourceService resolveArtifact falls back to official mapping for unobfuscated version with yarn", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-unobfuscated-yarn-"));

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

  const result = await service.resolveArtifact({
    target: { kind: "version", value: "26.1" },
    mapping: "yarn"
  });

  assert.equal(result.requestedMapping, "official");
  assert.equal(result.mappingApplied, "official");
  assert.ok(result.warnings.some((w) => w.includes("unobfuscated") && w.includes("yarn")));
});

test("SourceService resolveArtifact with official mapping on unobfuscated version has no fallback warning", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-unobfuscated-official-"));

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

  const result = await service.resolveArtifact({
    target: { kind: "version", value: "26.1" },
    mapping: "official"
  });

  assert.equal(result.mappingApplied, "official");
  assert.ok(!result.warnings.some((w) => w.includes("unobfuscated")));
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
          mappingType: "official",
          mappingNamespace: "official",
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

test("SourceService traceSymbolLifecycle with non-official mapping resolves symbol to official", async () => {
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
      // Simulate mapping: yarn name -> official name
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
  // Method should be found because it was resolved to official name
  assert.equal(result.presence.existsNow, true);
  // Verify mapping was called for both class and method
  assert.ok(mappingCalls.some((c) => c.name === "net.minecraft.server.YarnMain" && c.targetMapping === "official"));
  assert.ok(mappingCalls.some((c) => c.name === "yarnTick" && c.targetMapping === "official"));
});

test("SourceService traceSymbolLifecycle remaps non-official symbol per scanned version", async () => {
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

test("SourceService traceSymbolLifecycle with non-official mapping remaps descriptor before matching", async () => {
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
            mappingNamespace: "official",
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
          mappingNamespace: "official",
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
          mappingNamespace: "official",
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
      // Should receive official name after mapping
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
      // Class mapping: mojang -> official
      if (input.kind === "class" && input.name === "net.minecraft.server.MojangMain" && input.targetMapping === "official") {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.Main" }, warnings: [] };
      }
      // Field mapping: official -> mojang
      if (input.kind === "field" && input.name === "f_1234" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "serverPort" }, warnings: [] };
      }
      // Method mapping: official -> mojang
      if (input.kind === "method" && input.name === "m_5678" && input.targetMapping === "mojang") {
        return { resolved: true, resolvedSymbol: { name: "tickServer" }, warnings: [] };
      }
      // Owner class mapping: official -> mojang
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
      mappingApplied: "official" as const,
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
  assert.equal(result.mappingApplied, "official");
  // Member names should be remapped to mojang
  assert.equal(result.members.fields[0].name, "serverPort");
  assert.equal(result.members.fields[0].ownerFqn, "net.minecraft.server.MojangMain");
  assert.equal(result.members.methods[0].name, "tickServer");
  assert.equal(result.members.methods[0].ownerFqn, "net.minecraft.server.MojangMain");
});

test("SourceService getClassMembers with non-official mapping applies memberPattern post-remap", async () => {
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
      // memberPattern should NOT be passed for non-official mapping
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
    mappingApplied: "official" as const,
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

test("SourceService diffClassSignatures with non-official mapping remaps member deltas", async () => {
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
      // Should receive official name
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
      if (input.kind === "class" && input.name === "net.minecraft.server.IntermediaryMain" && input.targetMapping === "official") {
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

test("SourceService diffClassSignatures remaps non-official class per endpoint version", async () => {
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
        input.targetMapping === "official" &&
        input.name === "net.minecraft.server.InterMain" &&
        input.version === "1.0.0"
      ) {
        return { resolved: true, resolvedSymbol: { name: "net.minecraft.server.OldMain" }, warnings: [] };
      }
      if (
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "official" &&
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
        call.targetMapping === "official" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
  assert.ok(
    mappingCalls.some(
      (call) =>
        call.version === "1.0.1" &&
        call.sourceMapping === "intermediary" &&
        call.targetMapping === "official" &&
        call.name === "net.minecraft.server.InterMain"
    )
  );
});

test("SourceService getClassMembers with official mapping is unchanged (regression)", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-official-regression-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; memberPattern?: string }) {
      // For official mapping, memberPattern should be passed through
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
    artifactId: "test-official",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: join(root, "1.21.4.jar"),
    version: "1.21.4",
    requestedMapping: "official" as const,
    mappingApplied: "official" as const,
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
  assert.equal(result.mappingApplied, "official");
  assert.equal(result.members.methods.length, 1);
  assert.equal(result.members.methods[0].name, "tick");
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
    mappingApplied: "official" as const,
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
    mapping: "official"
  });

  // exact match with correct case → hit
  const exactHit = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "UniqueTestMarker",
    intent: "text",
    match: "exact",
    include: { includeDefinition: true, includeOneHop: false },
    limit: 10
  });
  assert.ok(exactHit.hits.some((h) => h.filePath === "net/minecraft/server/Main.java"));

  // exact match with wrong case → no hit (case-sensitive)
  const exactMiss = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "uniquetestmarker",
    intent: "text",
    match: "exact",
    include: { includeDefinition: true, includeOneHop: false },
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
    include: { includeDefinition: true, includeOneHop: false },
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
    mapping: "official"
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
    mapping: "official"
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
    mapping: "official"
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
    mapping: "official"
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
    mapping: "official"
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
