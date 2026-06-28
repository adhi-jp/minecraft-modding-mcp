import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SourceMapping } from "../src/types.ts";
import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  withCwd,
  createVersionServiceStub,
  queryFromSymbol,
  createLoomService,
  TEST_TINY,
  TEST_SHARED_CLASS_REF_TINY,
  TEST_MOJANG_CLIENT_MAPPINGS
} from "./helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

test("MappingService releaseGraphCacheEntry evicts all mode/projectPath variants for a version", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-release-cache-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const service = new MappingService(
      config,
      createVersionServiceStub("https://example.test/mappings/client.txt"),
      fetchStub
    );

    // Populate the graph cache with a lookup
    await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    const graphCache = (service as any).graphCache as Map<string, unknown>;
    const keysBefore = [...graphCache.keys()].filter((k: string) => k.startsWith("1.21.10|"));
    assert.ok(keysBefore.length > 0, "Graph cache should have entries for 1.21.10");

    // Evict
    service.releaseGraphCacheEntry("1.21.10");

    const keysAfter = [...graphCache.keys()].filter((k: string) => k.startsWith("1.21.10|"));
    assert.equal(keysAfter.length, 0, "All 1.21.10 entries should be evicted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService shares class-descriptor projections across members on one graph", async () => {
  const { root, service } = await createLoomService(
    "mapping-service-shared-projection-",
    TEST_SHARED_CLASS_REF_TINY
  );
  try {
    const resolveMethod = (name: string) =>
      withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.Owner",
          name,
          descriptor: "(La/b/Shared;)V",
          sourceMapping: "obfuscated",
          targetMapping: "yarn",
          signatureMode: "exact"
        })
      );

    // Warm the graph-scoped projection cache with the first member.
    const first = await resolveMethod("m1");
    assert.equal(first.resolved, true);

    // Distinct members sharing the same parameter class projection must reuse the
    // cached result, so resolving them triggers ZERO new class-projection computes.
    const before = service.classProjectionStats.computes;
    const second = await resolveMethod("m2");
    const third = await resolveMethod("m3");
    const after = service.classProjectionStats.computes;

    assert.equal(second.resolved, true);
    assert.equal(third.resolved, true);
    assert.equal(
      after - before,
      0,
      `members sharing a class ref must reuse the cached projection; saw ${after - before} new computes`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps obfuscated -> mojang and caches repeated lookups", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-mojang-"));
  try {
    const config = buildTestConfig(root);

    const fetchCalls: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const first = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(first.candidates[0]?.symbol, "com.mojang.NamedClass");
    assert.equal(first.mappingContext.sourceMapping, "obfuscated");
    assert.equal(first.mappingContext.targetMapping, "mojang");

    const second = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });
    assert.equal(second.candidates[0]?.symbol, "com.mojang.NamedClass");
    assert.equal(fetchCalls.filter((url) => url === "https://example.test/mappings/client.txt").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService skips tiny namespace loading for mojang <-> obfuscated lookups", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-mojang-obf-only-"));
  try {
    const config = buildTestConfig(root);

    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const service = new MappingService(config, createVersionServiceStub("https://example.test/mappings/client.txt"), fetchStub);

    let loomTinyLoads = 0;
    let mavenTinyLoads = 0;
    (service as unknown as {
      loadTinyPairsFromLoom: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
    }).loadTinyPairsFromLoom = async () => {
      loomTinyLoads += 1;
      return {
        pairs: new Map(),
        warnings: [],
        mappingArtifact: "loom-cache:none"
      };
    };
    (service as unknown as {
      loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
    }).loadTinyPairsFromMaven = async () => {
      mavenTinyLoads += 1;
      return {
        pairs: new Map(),
        warnings: [],
        mappingArtifact: "maven:none"
      };
    };

    const classResult = await service.findMapping({
      version: "1.21.10",
      kind: "class",
      name: "com.mojang.NamedClass",
      sourceMapping: "mojang",
      targetMapping: "obfuscated"
    });
    const methodResult = await service.resolveMethodMappingExact({
      version: "1.21.10",
      owner: "com.mojang.NamedClass",
      name: "namedMethod",
      descriptor: "(I)V",
      sourceMapping: "mojang",
      targetMapping: "obfuscated"
    });

    assert.equal(classResult.status, "resolved");
    assert.equal(classResult.resolvedSymbol?.symbol, "a.b.C");
    assert.equal(methodResult.status, "resolved");
    assert.equal(methodResult.resolvedSymbol?.symbol, "a.b.C.e(I)V");
    assert.equal(loomTinyLoads, 0);
    assert.equal(mavenTinyLoads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService limits returned candidates while preserving ambiguity metadata", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-max-candidates-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "f",
      descriptor: "(I)V",
      sourceMapping: "obfuscated",
      targetMapping: "mojang",
      maxCandidates: 1
    } as never);

    assert.equal(result.resolved, false);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidateCount, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidatesTruncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps field symbols and returns structured candidate metadata", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-field-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C.d"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(result.warnings.length, 0);
    assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedField");
    assert.equal(result.candidates[0]?.kind, "field");
    assert.equal(result.candidates[0]?.owner, "com.mojang.NamedClass");
    assert.equal(result.candidates[0]?.name, "namedField");
    assert.equal(result.candidates[0]?.descriptor, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService maps descriptor-qualified methods through tiny mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-tiny-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        ...queryFromSymbol("a.b.C.e(I)V"),
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    assert.equal(result.warnings.length, 0);
    assert.equal(result.candidates[0]?.symbol, "intermediary.pkg.InterClass.interMethod(I)V");
    assert.equal(result.candidates[0]?.kind, "method");
    assert.equal(result.candidates[0]?.owner, "intermediary.pkg.InterClass");
    assert.equal(result.candidates[0]?.name, "interMethod");
    assert.equal(result.candidates[0]?.descriptor, "(I)V");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolves exact method descriptor through mojang client mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-mojang-fallback-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: "https://example.test/mappings/client.txt"
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C.e(I)V"),
      sourceMapping: "obfuscated",
      targetMapping: "mojang"
    });

    assert.equal(result.resolved, true);
    assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedMethod(I)V");
    assert.equal(result.candidates[0]?.kind, "method");
    assert.equal(result.candidates[0]?.descriptor, "(I)V");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns identity candidate when source/target mapping are equal", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-identity-"));
  try {
    const config = buildTestConfig(root);
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const sourceMapping: SourceMapping = "yarn";
    const result = await service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("net.minecraft.server.MinecraftServer"),
      sourceMapping,
      targetMapping: sourceMapping
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.symbol, "net.minecraft.server.MinecraftServer");
    assert.equal(result.candidates[0]?.confidence, 1);
    assert.equal(result.candidates[0]?.kind, "class");
    assert.equal(result.candidates[0]?.name, "net.minecraft.server.MinecraftServer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
