import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fastGlob from "fast-glob";

import { ERROR_CODES } from "../src/errors.ts";
import type { Config, SourceMapping } from "../src/types.ts";
import { createJar } from "./helpers/zip.ts";

function buildTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
    sourceRepos: ["https://maven.fabricmc.net"],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    ...overrides
  };
}

async function withCwd<T>(nextCwd: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(nextCwd);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

const TEST_MOJANG_CLIENT_MAPPINGS = [
  "com.mojang.NamedClass -> a.b.C:",
  "    int namedField -> d",
  "    void namedMethod(int) -> e",
  "    4:4:void overloaded(int) -> f",
  "    8:8:void overloaded(java.lang.String) -> f"
].join("\n");

const TEST_TINY = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

type SymbolQueryInput = {
  kind: "class" | "field" | "method";
  name: string;
  owner?: string;
  descriptor?: string;
};

function queryFromSymbol(symbol: string): SymbolQueryInput {
  const trimmed = symbol.trim();
  const normalized = trimmed.replace(/\//g, ".");
  const descriptorStart = normalized.indexOf("(");
  if (descriptorStart >= 0) {
    const ownerAndName = normalized.slice(0, descriptorStart);
    const dotIndex = ownerAndName.lastIndexOf(".");
    return {
      kind: "method",
      owner: ownerAndName.slice(0, dotIndex),
      name: ownerAndName.slice(dotIndex + 1),
      descriptor: normalized.slice(descriptorStart)
    };
  }

  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) {
    return {
      kind: "class",
      name: normalized
    };
  }
  const owner = normalized.slice(0, dotIndex);
  const name = normalized.slice(dotIndex + 1);
  if (/^[A-Z$]/.test(name)) {
    return {
      kind: "class",
      name: normalized
    };
  }
  return {
    kind: "field",
    owner,
    name
  };
}

test("MappingService maps official -> mojang and caches repeated lookups", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-mojang-"));
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
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(first.candidates[0]?.symbol, "com.mojang.NamedClass");
  assert.equal(first.mappingContext.sourceMapping, "official");
  assert.equal(first.mappingContext.targetMapping, "mojang");

  const second = await service.findMapping({
    version: "1.21.10",
    ...queryFromSymbol("a.b.C"),
    sourceMapping: "official",
    targetMapping: "mojang"
  });
  assert.equal(second.candidates[0]?.symbol, "com.mojang.NamedClass");
  assert.equal(fetchCalls.filter((url) => url === "https://example.test/mappings/client.txt").length, 1);
});

test("MappingService maps official -> yarn from Loom tiny cache", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-loom-"));
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
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "official",
      targetMapping: "yarn"
    })
  );

  assert.equal(result.candidates[0]?.symbol, "yarn.pkg.NamedClass");
  assert.equal(result.provenance?.source, "loom-cache");
});

test("MappingService falls back to Maven tiny when Loom cache is unavailable", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-maven-fallback-"));
  const config = buildTestConfig(root);

  const tinyJarPath = join(root, "tiny.jar");
  await createJar(tinyJarPath, {
    "mappings/mappings.tiny": `${TEST_TINY}\n`
  });
  const tinyJarBuffer = await readFile(tinyJarPath);

  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
      return new Response(
        [
          "<metadata>",
          "<versioning>",
          "<versions>",
          "<version>1.21.10+build.1</version>",
          "</versions>",
          "</versioning>",
          "</metadata>"
        ].join(""),
        { status: 200 }
      );
    }
    if (url.endsWith(".jar")) {
      return new Response(tinyJarBuffer, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

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

  const service = new MappingService(config, versionServiceStub, fetchStub);
  const result = await withCwd(root, () =>
    service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );

  assert.equal(result.candidates[0]?.symbol, "intermediary.pkg.InterClass");
  assert.equal(result.provenance?.source, "maven");
});

test("MappingService supports sourcePriority override over config default", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-priority-"));
  const config = buildTestConfig(root, {
    mappingSourcePriority: "loom-first"
  });

  const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  await writeFile(
    loomTinyPath,
    [
      "tiny\t2\t0\tofficial\tintermediary",
      "c\ta/b/C\tloom/pkg/InterClass"
    ].join("\n"),
    "utf8"
  );

  const mavenTinyJar = join(root, "maven-tiny.jar");
  await createJar(mavenTinyJar, {
    "mappings/mappings.tiny": [
      "tiny\t2\t0\tofficial\tintermediary",
      "c\ta/b/C\tmaven/pkg/InterClass"
    ].join("\n")
  });
  const tinyJarBuffer = await readFile(mavenTinyJar);

  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(".jar")) {
      return new Response(tinyJarBuffer, { status: 200 });
    }
    if (url.endsWith("/net/fabricmc/yarn/maven-metadata.xml")) {
      return new Response("<metadata><versioning><versions></versions></versioning></metadata>", {
        status: 200
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

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

  const service = new MappingService(config, versionServiceStub, fetchStub);
  const result = await withCwd(root, () =>
    service.findMapping({
      version: "1.21.10",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "official",
      targetMapping: "intermediary",
      sourcePriority: "maven-first"
    })
  );

  assert.equal(result.candidates[0]?.symbol, "maven.pkg.InterClass");
  assert.equal(result.provenance?.source, "maven");
});

test("MappingService maps field symbols and returns structured candidate metadata", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-field-"));
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
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedField");
  assert.equal(result.candidates[0]?.kind, "field");
  assert.equal(result.candidates[0]?.owner, "com.mojang.NamedClass");
  assert.equal(result.candidates[0]?.name, "namedField");
  assert.equal(result.candidates[0]?.descriptor, undefined);
});

test("MappingService maps descriptor-qualified methods through tiny mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-tiny-"));
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
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );

  assert.equal(result.warnings.length, 0);
  assert.equal(result.candidates[0]?.symbol, "intermediary.pkg.InterClass.interMethod(I)V");
  assert.equal(result.candidates[0]?.kind, "method");
  assert.equal(result.candidates[0]?.owner, "intermediary.pkg.InterClass");
  assert.equal(result.candidates[0]?.name, "interMethod");
  assert.equal(result.candidates[0]?.descriptor, "(I)V");
});

test("MappingService falls back from descriptor to name for mojang client mappings with warning", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-mojang-fallback-"));
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
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(result.candidates[0]?.symbol, "com.mojang.NamedClass.namedMethod");
  assert.equal(result.candidates[0]?.kind, "method");
  assert.ok(result.warnings.some((warning) => warning.includes("descriptor")));
});

test("MappingService returns identity candidate when source/target mapping are equal", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-identity-"));
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
});

test("MappingService resolves exact method mapping when descriptor path is preserved", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-"));
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
    (
      service as unknown as {
        resolveMethodMappingExact: (input: {
          version: string;
          kind: "method";
          owner: string;
          name: string;
          descriptor: string;
          sourceMapping: SourceMapping;
          targetMapping: SourceMapping;
          sourcePriority?: "loom-first" | "maven-first";
        }) => Promise<{
          resolved: boolean;
          status: string;
          resolvedSymbol?: {
            name: string;
            owner?: string;
            descriptor?: string;
          };
          warnings: string[];
        }>;
      }
    ).resolveMethodMappingExact({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "e",
      descriptor: "(I)V",
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedSymbol?.name, "interMethod");
  assert.equal(result.resolvedSymbol?.owner, "intermediary.pkg.InterClass");
  assert.equal(result.resolvedSymbol?.descriptor, "(I)V");
  assert.equal(result.warnings.length, 0);
});

test("MappingService returns explicit not_found for exact method lookup misses", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-miss-"));
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
    (
      service as unknown as {
        resolveMethodMappingExact: (input: {
          version: string;
          kind: "method";
          owner: string;
          name: string;
          descriptor: string;
          sourceMapping: SourceMapping;
          targetMapping: SourceMapping;
        }) => Promise<{
          resolved: boolean;
          status: string;
          candidates: unknown[];
        }>;
      }
    ).resolveMethodMappingExact({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "missing",
      descriptor: "(I)V",
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );

  assert.equal(result.resolved, false);
  assert.equal(result.status, "not_found");
  assert.equal(result.candidates.length, 0);
});

test("MappingService returns mapping_unavailable when exact lookup crosses mojang descriptorless mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-mojang-"));
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
  const result = await (
    service as unknown as {
      resolveMethodMappingExact: (input: {
        version: string;
        kind: "method";
        owner: string;
        name: string;
        descriptor: string;
        sourceMapping: SourceMapping;
        targetMapping: SourceMapping;
      }) => Promise<{
        resolved: boolean;
        status: string;
        warnings: string[];
      }>;
    }
  ).resolveMethodMappingExact({
    version: "1.21.10",
    kind: "method",
    owner: "a.b.C",
    name: "f",
    descriptor: "(I)V",
    sourceMapping: "official",
    targetMapping: "mojang"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");
  assert.ok(result.warnings.some((warning) => warning.includes("descriptor")));
});

test("MappingService returns ambiguous for exact method lookup when tiny data has duplicate target names", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-method-exact-ambiguous-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
  const ambiguousTiny = [
    "tiny\t2\t0\tofficial\tintermediary\tnamed",
    "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
    "\tm\t(I)V\te\tinterMethod\tnamedMethod",
    "\tm\t(I)V\te\tinterMethodAlt\tnamedMethod"
  ].join("\n");
  const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  await writeFile(loomTinyPath, `${ambiguousTiny}\n`, "utf8");

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
    (
      service as unknown as {
        resolveMethodMappingExact: (input: {
          version: string;
          kind: "method";
          owner: string;
          name: string;
          descriptor: string;
          sourceMapping: SourceMapping;
          targetMapping: SourceMapping;
        }) => Promise<{
          resolved: boolean;
          status: string;
          candidates: Array<{ name: string }>;
        }>;
      }
    ).resolveMethodMappingExact({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "e",
      descriptor: "(I)V",
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );

  assert.equal(result.resolved, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("MappingService builds class API matrix across mappings", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-matrix-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
  const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

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
  const result = await withCwd(root, () =>
    (
      service as unknown as {
        getClassApiMatrix: (input: {
          version: string;
          className: string;
          classNameMapping: SourceMapping;
        }) => Promise<{
          classIdentity: Record<string, string | undefined>;
          rows: Array<{
            kind: string;
            descriptor?: string;
            official?: { name: string };
            intermediary?: { name: string };
            yarn?: { name: string };
            mojang?: { name: string };
          }>;
        }>;
      }
    ).getClassApiMatrix({
      version: "1.21.10",
      className: "a.b.C",
      classNameMapping: "official"
    })
  );

  assert.equal(result.classIdentity.official, "a.b.C");
  assert.equal(result.classIdentity.intermediary, "intermediary.pkg.InterClass");
  assert.equal(result.classIdentity.yarn, "yarn.pkg.NamedClass");
  assert.equal(result.classIdentity.mojang, "com.mojang.NamedClass");

  const row = result.rows.find(
    (entry) => entry.kind === "method" && entry.descriptor === "(I)V" && entry.official?.name === "e"
  );
  assert.ok(row);
  assert.equal(row?.intermediary?.name, "interMethod");
  assert.equal(row?.yarn?.name, "namedMethod");
});

test("MappingService checks symbol existence across class/field/method kinds", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-"));
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
  const classExists = await withCwd(root, () =>
    (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          name: string;
          owner?: string;
          sourceMapping: SourceMapping;
          descriptor?: string;
        }) => Promise<{ resolved: boolean; status: string }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "class",
      name: "a.b.C",
      sourceMapping: "official"
    })
  );
  assert.equal(classExists.resolved, true);
  assert.equal(classExists.status, "resolved");

  await assert.rejects(
    () =>
      withCwd(root, () =>
        (
          service as unknown as {
            checkSymbolExists: (input: {
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              sourceMapping: SourceMapping;
              descriptor?: string;
            }) => Promise<{ resolved: boolean; status: string }>;
          }
        ).checkSymbolExists({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "f",
          sourceMapping: "official"
        })
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );

  const methodExists = await withCwd(root, () =>
    (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          owner?: string;
          name: string;
          sourceMapping: SourceMapping;
          descriptor?: string;
        }) => Promise<{ resolved: boolean; status: string }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "method",
      owner: "a.b.C",
      name: "f",
      descriptor: "(I)V",
      sourceMapping: "official"
    })
  );
  assert.equal(methodExists.resolved, true);
  assert.equal(methodExists.status, "resolved");
});

test("MappingService supports short class name checks when nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-"));
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
    (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          name: string;
          sourceMapping: SourceMapping;
          nameMode?: "fqcn" | "auto";
        }) => Promise<{ resolved: boolean; status: string; resolvedSymbol?: { symbol: string } }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "class",
      name: "C",
      sourceMapping: "official",
      nameMode: "auto"
    })
  );

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedSymbol?.symbol, "a.b.C");
});

test("MappingService returns ambiguous for short class names when multiple FQCNs match nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-ambiguous-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
  const tiny = [
    "tiny\t2\t0\tofficial\tintermediary\tnamed",
    "c\ta/b/C\tinter/one/C\tyarn/one/C",
    "c\tx/y/C\tinter/two/C\tyarn/two/C"
  ].join("\n");
  const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

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
    (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          name: string;
          sourceMapping: SourceMapping;
          nameMode?: "fqcn" | "auto";
        }) => Promise<{ resolved: boolean; status: string; candidates: Array<{ symbol: string }>; warnings: string[] }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "class",
      name: "C",
      sourceMapping: "official",
      nameMode: "auto"
    })
  );

  assert.equal(result.resolved, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("fully-qualified class name")));
});

test("MappingService findMapping adds ambiguity reason and supports disambiguation hints", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-find-disambiguation-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
  const tiny = [
    "tiny\t2\t0\tofficial\tintermediary\tnamed",
    "c\ta/b/C\tinter/one/C\tyarn/one/C",
    "c\ta/b/C\tinter/two/C\tyarn/two/C"
  ].join("\n");
  const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

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

  const ambiguous = await withCwd(root, () =>
    service.findMapping({
      version: "1.21.10",
      kind: "class",
      name: "a.b.C",
      sourceMapping: "official",
      targetMapping: "intermediary"
    })
  );
  assert.equal(ambiguous.status, "ambiguous");
  assert.ok(ambiguous.warnings.some((warning) => warning.includes("Ambiguous mapping")));

  const disambiguated = await withCwd(root, () =>
    (
      service as unknown as {
        findMapping: (input: {
          version: string;
          kind: "class" | "field" | "method";
          name: string;
          sourceMapping: SourceMapping;
          targetMapping: SourceMapping;
          disambiguation?: { ownerHint?: string; descriptorHint?: string };
        }) => Promise<{ status: string; resolvedSymbol?: { symbol: string } }>;
      }
    ).findMapping({
      version: "1.21.10",
      kind: "class",
      name: "a.b.C",
      sourceMapping: "official",
      targetMapping: "intermediary",
      disambiguation: { ownerHint: "inter.two" }
    })
  );
  assert.equal(disambiguated.status, "resolved");
  assert.equal(disambiguated.resolvedSymbol?.symbol, "inter.two.C");
});

test("MappingService returns mapping_unavailable for symbol existence when mapping graph is absent", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-unavailable-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
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
  const result = await (
    service as unknown as {
      checkSymbolExists: (input: {
        version: string;
        kind: "class" | "field" | "method";
        owner?: string;
        name: string;
        sourceMapping: SourceMapping;
      }) => Promise<{ resolved: boolean; status: string }>;
    }
  ).checkSymbolExists({
    version: "1.21.10",
    kind: "class",
    name: "intermediary.pkg.InterClass",
    sourceMapping: "intermediary"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");

  await assert.rejects(
    () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            descriptor?: string;
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        sourceMapping: "official"
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );

  await assert.rejects(
    () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        owner: "a.b.C",
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

test("MappingService returns empty graph for unobfuscated version (26.1)", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-unobfuscated-"));
  const config = buildTestConfig(root, { sourceRepos: [] });

  const fetchCalls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push(url);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: `https://example.test/versions/${version}.json`,
        mappingsUrl: undefined
      };
    }
  };

  const service = new MappingService(config, versionServiceStub, fetchStub);
  const result = await service.findMapping({
    version: "26.1",
    kind: "class",
    name: "a.b.C",
    sourceMapping: "official",
    targetMapping: "yarn"
  });

  assert.equal(result.status, "mapping_unavailable");
  assert.ok(
    result.warnings.some((w) => w.includes("No mapping path")),
    "Expected a warning about missing mapping path"
  );
  assert.equal(fetchCalls.length, 0, "No network requests should be made for unobfuscated versions");
});

const TEST_TINY_V1 = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tv1/pkg/VersionOneClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

test("MappingService Loom cache version filter does not match version prefix collisions", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-version-collision-"));
  const config = buildTestConfig(root, { sourceRepos: [] });

  // Create two Loom cache directories whose version strings share a prefix
  const loomDir121_1 = join(root, ".gradle", "loom-cache", "1.21.1");
  const loomDir121_10 = join(root, ".gradle", "loom-cache", "1.21.10");
  await mkdir(loomDir121_1, { recursive: true });
  await mkdir(loomDir121_10, { recursive: true });

  // 1.21.1 gets the V1 tiny with distinct named class
  await writeFile(join(loomDir121_1, "mappings.tiny"), `${TEST_TINY_V1}\n`, "utf8");
  // 1.21.10 gets the original TEST_TINY
  await writeFile(join(loomDir121_10, "mappings.tiny"), `${TEST_TINY}\n`, "utf8");

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: `https://example.test/versions/${version}.json`,
        mappingsUrl: undefined
      };
    }
  };

  const service = new MappingService(config, versionServiceStub, globalThis.fetch);

  // Query version 1.21.1 — should only see V1 data, not 1.21.10 data
  const result = await withCwd(root, () =>
    service.findMapping({
      version: "1.21.1",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "official",
      targetMapping: "yarn"
    })
  );

  assert.equal(result.candidates[0]?.symbol, "v1.pkg.VersionOneClass");
  assert.equal(result.provenance?.source, "loom-cache");
});

test("MappingService Loom cache version filter handles backslash separated candidate paths", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-backslash-path-"));
  const config = buildTestConfig(root, { sourceRepos: [] });

  const pseudoWindowsPath121_1 = join(root, ".gradle", "loom-cache\\1.21.1\\mappings.tiny");
  const pseudoWindowsPath121_10 = join(root, ".gradle", "loom-cache\\1.21.10\\mappings.tiny");
  await mkdir(join(root, ".gradle"), { recursive: true });
  await writeFile(pseudoWindowsPath121_1, `${TEST_TINY_V1}\n`, "utf8");
  await writeFile(pseudoWindowsPath121_10, `${TEST_TINY}\n`, "utf8");

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: `https://example.test/versions/${version}.json`,
        mappingsUrl: undefined
      };
    }
  };

  const originalSync = fastGlob.sync;
  fastGlob.sync = () => [pseudoWindowsPath121_1, pseudoWindowsPath121_10];
  try {
    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await service.findMapping({
      version: "1.21.1",
      ...queryFromSymbol("a.b.C"),
      sourceMapping: "official",
      targetMapping: "yarn"
    });

    assert.equal(result.candidates[0]?.symbol, "v1.pkg.VersionOneClass");
    assert.equal(result.provenance?.source, "loom-cache");
  } finally {
    fastGlob.sync = originalSync;
  }
});

test("MappingService rejects class queries that include owner", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-owner-invalid-"));
  const config = buildTestConfig(root, { sourceRepos: [] });
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
  await assert.rejects(
    () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        owner: "a.b",
        sourceMapping: "official",
        targetMapping: "mojang"
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );
});
