import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { withGradleUserHome } from "./helpers/env.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "./helpers/source-service-metrics.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

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

async function withVersionApproximationFixture(
  input: {
    rootPrefix: string;
    requestedVersion: string;
    loomSourceVersion: string;
  },
  run: (args: { service: SourceServiceFixture; projectPath: string }) => Promise<void>
): Promise<void> {
  const { SourceService } = await import("../src/source-service.ts");
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

test("SourceService targetKind=jar handles representative sibling sources-jar adoption rules", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type JarSiblingFixture = {
    binaryJarPath: string;
    root: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createJarSiblingFixture(input: {
    rootPrefix: string;
    extraSourcesJars: Array<{ fileName: string; entries: Record<string, string> }>;
  }): Promise<JarSiblingFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, "a.jar");
    await createJar(binaryJarPath, {
      "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });

    for (const sourceJar of input.extraSourcesJars) {
      await createJar(join(root, sourceJar.fileName), sourceJar.entries);
    }

    return {
      binaryJarPath,
      root,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<JarSiblingFixture>;
    run: (fixture: JarSiblingFixture) => Promise<void>;
  }> = [
    {
      name: "does not adopt unrelated *-sources.jar files",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-unrelated-sources-",
          extraSourcesJars: [
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, service }) => {
        await assert.rejects(
          () =>
            service.resolveArtifact({
              target: { kind: "jar", value: binaryJarPath },
              allowDecompile: false
            }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
        );
      }
    },
    {
      name: "only adopts <basename>-sources.jar",
      createFixture: () =>
        createJarSiblingFixture({
          rootPrefix: "service-jar-exact-sources-",
          extraSourcesJars: [
            {
              fileName: "a-sources.jar",
              entries: {
                "com/example/A.java": [
                  "package com.example;",
                  "public class A {}"
                ].join("\n")
              }
            },
            {
              fileName: "b-sources.jar",
              entries: {
                "com/example/B.java": [
                  "package com.example;",
                  "public class B {}"
                ].join("\n")
              }
            }
          ]
        }),
      run: async ({ binaryJarPath, root, service }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "jar", value: binaryJarPath }
        });

        assert.equal(resolved.origin, "local-jar");
        assert.equal(resolved.isDecompiled, false);
        assert.equal(resolved.resolvedSourceJarPath, join(root, "a-sources.jar"));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
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

test("SourceService getClassSource rejects representative invalid input combinations", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

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
  const { SourceService } = await import("../src/source-service.ts");

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

test("SourceService accepts unobfuscated mojang mapping for decompiled coordinate artifacts", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-coordinate-unobfuscated-mojang-"));
  const coordinate = "net.minecraft:client:26.1";
  const remoteJarPath = join(root, "client-26.1.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/net/minecraft/client/26.1/client-26.1-sources.jar")) {
      return new Response("not found", { status: 404 });
    }
    if (url.endsWith("/net/minecraft/client/26.1/client-26.1.jar")) {
      return new Response(remoteJarBytes, {
        status: 200,
        headers: {
          "content-length": String(remoteJarBytes.byteLength),
          etag: "coordinate-26.1"
        }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(
      buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
    );
    (service as unknown as {
      ingestIfNeeded: (resolved: unknown) => Promise<void>;
    }).ingestIfNeeded = async () => {};

    const resolved = await service.resolveArtifact({
      target: {
        kind: "coordinate",
        value: coordinate
      },
      mapping: "mojang"
    });

    assert.equal(resolved.version, "26.1");
    assert.equal(resolved.requestedMapping, "mojang");
    assert.equal(resolved.mappingApplied, "mojang");
    assert.equal(resolved.origin, "decompiled");
    assert.equal(resolved.resolvedSourceJarPath, undefined);
    assert.equal(resolved.coordinate, coordinate);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("SourceService resolveWorkspaceSymbol handles representative compile-visible symbol flows", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type WorkspaceSymbolFixture = {
    root: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createWorkspaceSymbolFixture(rootPrefix: string): Promise<WorkspaceSymbolFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    return {
      root,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<WorkspaceSymbolFixture>;
    run: (fixture: WorkspaceSymbolFixture) => Promise<void>;
  }> = [
    {
      name: "rejects owner for class input",
      createFixture: () =>
        createWorkspaceSymbolFixture("service-workspace-symbol-class-invalid-owner-"),
      run: async ({ root, service }) => {
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
      }
    },
    {
      name: "applies workspace mapping and returns compile-visible method symbol",
      createFixture: () => createWorkspaceSymbolFixture("service-workspace-symbol-"),
      run: async ({ root, service }) => {
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
      }
    },
    {
      name: "resolves class via class identity mapping",
      createFixture: () => createWorkspaceSymbolFixture("service-workspace-symbol-class-"),
      run: async ({ root, service }) => {
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
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await testCase.createFixture());
    });
  }
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

test("SourceService supports mojang mapping on unobfuscated version targets without source jars", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  async function createFixture(rootPrefix: string): Promise<{
    binaryJarPath: string;
    gradleUserHome: string;
    root: string;
    service: SourceServiceFixture;
  }> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const binaryJarPath = join(root, "client-26.1.jar");
    const gradleUserHome = join(root, "gradle-home");

    await createJar(binaryJarPath, {
      "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
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
    (service as unknown as {
      ingestIfNeeded: (resolved: unknown) => Promise<void>;
    }).ingestIfNeeded = async () => {};

    return { binaryJarPath, gradleUserHome, root, service };
  }

  await t.test("resolveArtifact ignores mismatched Loom sources for unobfuscated versions", async () => {
    const { gradleUserHome, service } = await createFixture("service-unobfuscated-mojang-resolve-");
    const foreignSourceJar = join(
      gradleUserHome,
      "caches",
      "fabric-loom",
      "minecraftMaven",
      "net",
      "minecraft",
      "minecraft-merged",
      "1.21.10",
      "minecraft-merged-1.21.10-sources.jar"
    );

    await createJar(foreignSourceJar, {
      "net/minecraft/world/item/Item.java": [
        "package net.minecraft.world.item;",
        "public class Item {}"
      ].join("\n")
    });

    await withGradleUserHome(gradleUserHome, async () => {
      const result = await service.resolveArtifact({
        target: { kind: "version", value: "26.1" },
        mapping: "mojang"
      });

      assert.equal(result.requestedMapping, "mojang");
      assert.equal(result.mappingApplied, "mojang");
      assert.equal(result.origin, "decompiled");
      assert.equal(result.resolvedSourceJarPath, undefined);
      assert.ok(
        !result.warnings.some((warning) => warning.includes("Resolved source-backed artifact from Loom cache candidate")),
        "Expected unobfuscated 26.1 resolution to skip mismatched Loom source jars."
      );
    });
  });

  await t.test("getClassMembers reads unobfuscated runtime names without remap fallback", async () => {
    const { binaryJarPath, gradleUserHome, service } = await createFixture("service-unobfuscated-mojang-members-");

    (service as unknown as { explorerService: unknown }).explorerService = {
      async getSignature(input: { fqn: string; jarPath: string }) {
        assert.equal(input.fqn, "net.minecraft.world.item.Item");
        assert.equal(input.jarPath, binaryJarPath);
        return {
          constructors: [],
          fields: [
            {
              ownerFqn: "net.minecraft.world.item.Item",
              name: "MAX_STACK_SIZE",
              javaSignature: "public static final int MAX_STACK_SIZE",
              jvmDescriptor: "I",
              accessFlags: 0x0019,
              isSynthetic: false
            }
          ],
          methods: [
            {
              ownerFqn: "net.minecraft.world.item.Item",
              name: "use",
              javaSignature:
                "public net.minecraft.world.InteractionResult use(net.minecraft.world.item.ItemStack)",
              jvmDescriptor: "(Lnet/minecraft/world/item/ItemStack;)Lnet/minecraft/world/InteractionResult;",
              accessFlags: 0x0001,
              isSynthetic: false
            }
          ],
          warnings: [],
          context: {
            minecraftVersion: "26.1",
            mappingType: "mojang",
            mappingNamespace: "mojang",
            jarHash: "hash",
            generatedAt: new Date().toISOString()
          }
        };
      }
    };

    await withGradleUserHome(gradleUserHome, async () => {
      const result = await service.getClassMembers({
        className: "net.minecraft.world.item.Item",
        target: { kind: "version", value: "26.1" },
        mapping: "mojang"
      });

      assert.equal(result.mappingApplied, "mojang");
      assert.equal(result.className, "net.minecraft.world.item.Item");
      assert.equal(result.members.fields[0]?.name, "MAX_STACK_SIZE");
      assert.equal(result.members.methods[0]?.name, "use");
      assert.ok(
        !result.warnings.some((warning) => warning.includes("Could not map class")),
        "Expected unobfuscated 26.1 lookups to avoid remap fallback warnings."
      );
    });
  });
});

test("SourceService checkSymbolExists falls back to unobfuscated runtime bytecode for mojang class queries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-unobfuscated-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "net.minecraft.client.Minecraft",
          symbol: "net.minecraft.client.Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, "client-26.1.jar"),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, "net.minecraft.client.Minecraft");
      return {
        constructors: [],
        methods: [],
        fields: [],
        warnings: [],
        context: {
          minecraftVersion: "26.1",
          mappingType: "mojang",
          mappingNamespace: "mojang",
          jarHash: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "net.minecraft.client.Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedSymbol?.name, "net.minecraft.client.Minecraft");
  assert.ok(result.warnings.some((warning) => warning.includes("runtime bytecode")));
});

test("SourceService checkSymbolExists keeps mapping_unavailable when unobfuscated runtime jar resolution fails", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-jar-failure-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "net.minecraft.client.Minecraft",
          symbol: "net.minecraft.client.Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      throw new Error("jar missing");
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "net.minecraft.client.Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]?.includes("mapping graph is empty"));
});

test("SourceService checkSymbolExists reports short unobfuscated class names when nameMode is omitted", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-check-symbol-exists-short-name-"));
  const service = new SourceService(buildTestConfig(root));

  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkSymbolExists() {
      return {
        querySymbol: {
          kind: "class",
          name: "Minecraft",
          symbol: "Minecraft"
        },
        mappingContext: {
          version: "26.1",
          sourceMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: ["Version 26.1 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names."]
      };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      assert.fail("short class names should return a targeted warning before jar resolution");
    }
  };

  const result = await service.checkSymbolExists({
    version: "26.1",
    kind: "class",
    name: "Minecraft",
    sourceMapping: "mojang"
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, "mapping_unavailable");
  assert.ok(result.warnings.some((warning) => warning.includes("short class name")));
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

test("SourceService traceSymbolLifecycle ignores inline signature suffix when parsing symbol", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-inline-signature-"));
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

  let requestedClassName: string | undefined;
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      requestedClassName = input.fqn;
      assert.equal(input.fqn, "net.minecraft.server.Main");
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "tickServer",
            javaSignature: "public void tickServer(java.lang.String)",
            jvmDescriptor: "(Ljava/lang/String;)V",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
    }) => Promise<{
      query: { className: string; methodName: string };
      presence: { existsNow: boolean };
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer(java.lang.String)"
  });

  assert.equal(requestedClassName, "net.minecraft.server.Main");
  assert.equal(result.query.className, "net.minecraft.server.Main");
  assert.equal(result.query.methodName, "tickServer");
  assert.equal(result.presence.existsNow, true);
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

test("SourceService traceSymbolLifecycle rejects obvious class-like symbols before consulting mapping state or scanning jars", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-classlike-"));
  const service = new SourceService(buildTestConfig(root));

  let resolveVersionJarCalls = 0;
  let getSignatureCalls = 0;
  let checkSymbolExistsCalls = 0;

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return ["1.21.1", "1.21"];
    },
    async resolveVersionJar(version: string) {
      resolveVersionJarCalls += 1;
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
      getSignatureCalls += 1;
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
    async checkSymbolExists(input: {
      kind: string;
      name: string;
      sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      version: string;
    }) {
      checkSymbolExistsCalls += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      assert.equal(input.sourceMapping, "mojang");
      assert.equal(input.version, "1.21.1");
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.world.item.Item",
          symbol: "net.minecraft.world.item.Item"
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    async findMapping() {
      throw new Error("findMapping should not be reached for class-like input");
    }
  };

  await assert.rejects(
    () =>
      (service as unknown as {
        traceSymbolLifecycle: (input: {
          symbol: string;
          mapping: "mojang";
          maxVersions: number;
        }) => Promise<unknown>;
      }).traceSymbolLifecycle({
        symbol: "net.minecraft.world.item.Item",
        mapping: "mojang",
        maxVersions: 5
      }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.equal(error !== null && "code" in error ? (error as { code?: string }).code : undefined, ERROR_CODES.INVALID_INPUT);
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Class\.method/
      );
      return true;
    }
  );

  assert.equal(checkSymbolExistsCalls, 0);
  assert.equal(resolveVersionJarCalls, 0);
  assert.equal(getSignatureCalls, 0);
});

test("SourceService traceSymbolLifecycle keeps mapping pressure bounded across versions when cache release is available", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-pressure-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.2", "1.0.1", "1.0.0"];
  const activeGraphVersions = new Set<string>();
  const releasedVersions: string[] = [];

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
      await new Promise((resolve) => setTimeout(resolve, 10));
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

  const acquireGraph = (version: string) => {
    activeGraphVersions.add(version);
    if (activeGraphVersions.size > 3) {
      throw new Error(`simulated mapping graph pressure on ${version}`);
    }
  };

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: {
      version: string;
      kind: "class" | "method";
      name: string;
      owner?: string;
      descriptor?: string;
    }) {
      acquireGraph(input.version);
      if (input.kind === "class") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: {
            kind: "class",
            name: input.name,
            symbol: input.name
          },
          candidates: [],
          candidateCount: 1,
          warnings: []
        };
      }
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: input.owner,
          name: input.name,
          descriptor: input.descriptor,
          symbol: `${input.owner}.${input.name}${input.descriptor ?? ""}`
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    async resolveMethodMappingExact(input: {
      version: string;
      owner: string;
      name: string;
      descriptor: string;
    }) {
      acquireGraph(input.version);
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: input.owner,
          name: input.name,
          descriptor: input.descriptor,
          symbol: `${input.owner}.${input.name}${input.descriptor}`
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    releaseGraphCacheEntry(version: string) {
      activeGraphVersions.delete(version);
      releasedVersions.push(version);
    }
  };

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      mapping: "mojang";
      descriptor: string;
      fromVersion: string;
      toVersion: string;
      includeTimeline: boolean;
    }) => Promise<{
      timeline?: Array<{ version: string; exists: boolean; reason?: string }>;
      warnings: string[];
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    mapping: "mojang",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.2",
    includeTimeline: true
  });

  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists, reason: entry.reason })),
    [
      { version: "1.0.0", exists: true, reason: undefined },
      { version: "1.0.1", exists: true, reason: undefined },
      { version: "1.0.2", exists: true, reason: undefined }
    ]
  );
  assert.deepEqual(releasedVersions.sort(), ["1.0.0", "1.0.1", "1.0.2"]);
  assert.deepEqual(activeGraphVersions.size, 0);
  assert.ok(
    result.warnings.every((warning) => !warning.includes("simulated mapping graph pressure")),
    "expected mapping graph pressure to stay bounded"
  );
});

test("SourceService traceSymbolLifecycle evaluates versions with bounded parallelism while preserving timeline order", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-lifecycle-parallel-"));
  const service = new SourceService(buildTestConfig(root));

  const versions = ["1.0.7", "1.0.6", "1.0.5", "1.0.4", "1.0.3", "1.0.2", "1.0.1", "1.0.0"];
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

  let activeCalls = 0;
  let maxActiveCalls = 0;
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { jarPath: string }) {
      const version = versionByJarPath.get(input.jarPath);
      if (!version) {
        throw new Error("unknown jar");
      }
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCalls -= 1;
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

  const result = await (service as unknown as {
    traceSymbolLifecycle: (input: {
      symbol: string;
      descriptor: string;
      fromVersion: string;
      toVersion: string;
      includeTimeline: boolean;
    }) => Promise<{
      timeline?: Array<{ version: string; exists: boolean }>;
    }>;
  }).traceSymbolLifecycle({
    symbol: "net.minecraft.server.Main.tickServer",
    descriptor: "()V",
    fromVersion: "1.0.0",
    toVersion: "1.0.7",
    includeTimeline: true
  });

  assert.ok(maxActiveCalls > 1);
  assert.ok(maxActiveCalls <= 4);
  assert.deepEqual(
    result.timeline?.map((entry) => ({ version: entry.version, exists: entry.exists })),
    [
      { version: "1.0.0", exists: true },
      { version: "1.0.1", exists: true },
      { version: "1.0.2", exists: true },
      { version: "1.0.3", exists: true },
      { version: "1.0.4", exists: true },
      { version: "1.0.5", exists: true },
      { version: "1.0.6", exists: true },
      { version: "1.0.7", exists: true }
    ]
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

test("SourceService validateAccessWidener chooses the expected mapping namespace", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateAccessWidenerFixture = {
    mappingCalls: string[];
    service: InstanceType<typeof SourceService>;
  };

  async function createValidateAccessWidenerFixture(
    rootPrefix: string
  ): Promise<ValidateAccessWidenerFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
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

    return { mappingCalls, service };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    run: (fixture: ValidateAccessWidenerFixture) => Promise<void>;
  }> = [
    {
      name: "normalizes named namespace to yarn",
      rootPrefix: "service-validate-aw-named-",
      run: async ({ mappingCalls, service }) => {
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
      }
    },
    {
      name: "prefers explicit mapping override over header namespace",
      rootPrefix: "service-validate-aw-override-",
      run: async ({ mappingCalls, service }) => {
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
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run(await createValidateAccessWidenerFixture(testCase.rootPrefix));
    });
  }
});

test("SourceService runtime-aware access widener candidate scan avoids loader-constant scoring and broad jar globs", async () => {
  const source = await readFile("src/source-service.ts", "utf8");

  assert.doesNotMatch(source, /\(input\.requestedScope === "loader" \? 1_000 : 0\)/);
  assert.doesNotMatch(source, /fastGlob\.sync\("\*\*\/\*\.jar"/);
});

test("SourceService version/runtime discovery blocks avoid sync glob scans on hot paths", async () => {
  const source = await readFile("src/source-service.ts", "utf8");
  const versionSourceBlock =
    source.match(/private async discoverVersionSourceJar\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";
  const accessWidenerBlock =
    source.match(/private (?:async )?discoverAccessWidenerRuntimeCandidates\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";
  const accessTransformerBlock =
    source.match(/private (?:async )?discoverAccessTransformerRuntimeCandidates\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";

  assert.doesNotMatch(versionSourceBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessWidenerBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessTransformerBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessTransformerBlock, /existsSync\(root\)/);
});

test("SourceService validateMixin project/config discovery avoids sync glob and existence probes in discovery blocks", async () => {
  const source = await readFile("src/source-service.ts", "utf8");
  const projectBlock =
    source.match(/private (?:async )?createProjectValidateMixinConfigInput\([\s\S]*?return \{\s*\.\.\.input,/m)?.[0] ?? "";
  const configBlock =
    source.match(/private async resolveMixinConfigSources\([\s\S]*?return \{\s*sources: results,/m)?.[0] ?? "";

  assert.doesNotMatch(projectBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(configBlock, /existsSync\(/);
});

test("SourceService reuses the shared concurrency helper instead of defining a local variant", async () => {
  const source = await readFile("src/source-service.ts", "utf8");

  assert.match(source, /import\s+\{\s*mapWithConcurrencyLimit\s*\}\s+from "\.\/concurrency\.js"/);
  assert.doesNotMatch(source, /async function mapWithConcurrencyLimit</);
});

test("SourceService validateAccessWidener resolves merged runtime artifacts and surfaces runtime access evidence", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-aw-runtime-aware-"));
  const gradleUserHome = join(root, "gradle-home");
  const loomCacheDir = join(gradleUserHome, "loom-cache", "runtime");
  const binaryJarPath = join(loomCacheDir, "minecraft-merged-1.21.10.jar");
  const sourceJarPath = join(loomCacheDir, "minecraft-merged-1.21.10-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": buildClassFile({
      internalName: "net/minecraft/server/Main",
      accessFlags: 0x0001,
      fields: [
        { name: "field_1234", descriptor: "I", accessFlags: 0x0002 }
      ],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "method_1234", descriptor: "()V", accessFlags: 0x0001 }
      ]
    }),
    // Additional intermediary-style classes so namespace detection scores intermediary > mojang
    "net/minecraft/class_1937.class": buildClassFile({
      internalName: "net/minecraft/class_1937",
      accessFlags: 0x0001,
      fields: [{ name: "field_2000", descriptor: "Z", accessFlags: 0x0004 }],
      methods: [{ name: "method_2000", descriptor: "()V", accessFlags: 0x0001 }]
    }),
    "net/minecraft/class_1938.class": buildClassFile({
      internalName: "net/minecraft/class_1938",
      accessFlags: 0x0001,
      methods: [{ name: "method_2001", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });
  await createJar(sourceJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server; public class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: {
      kind: string;
      name: string;
      owner?: string;
      sourceMapping: string;
      targetMapping: string;
    }) {
      if (
        input.kind === "class" &&
        input.name === "net.minecraft.server.MinecraftServer" &&
        input.sourceMapping === "yarn" &&
        input.targetMapping === "intermediary"
      ) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "net.minecraft.server.Main" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (
        input.kind === "class" &&
        input.name === "net.minecraft.server.Main" &&
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "yarn"
      ) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "net.minecraft.server.MinecraftServer" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (
        input.kind === "method" &&
        input.name === "method_1234" &&
        input.owner === "net.minecraft.server.Main" &&
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "yarn"
      ) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "tickServer", owner: "net.minecraft.server.MinecraftServer", descriptor: "()V" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (
        input.kind === "field" &&
        input.name === "field_1234" &&
        input.owner === "net.minecraft.server.Main" &&
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "yarn"
      ) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "serverPort", owner: "net.minecraft.server.MinecraftServer", descriptor: "I" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      return { resolved: false, status: "not_found", candidates: [], candidateCount: 0, warnings: [] };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      assert.fail("runtime-aware access widener validation should use the merged runtime artifact");
    }
  };

  await withGradleUserHome(gradleUserHome, async () => {
    const result = await (
      service as unknown as {
        validateAccessWidener: (input: Record<string, unknown>) => Promise<Record<string, any>>;
      }
    ).validateAccessWidener({
      content: [
        "accessWidener v2 named",
        "accessible class net/minecraft/server/MinecraftServer",
        "accessible method net/minecraft/server/MinecraftServer tickServer ()V",
        "mutable field net/minecraft/server/MinecraftServer serverPort I"
      ].join("\n"),
      version: "1.21.10",
      projectPath: root,
      scope: "merged"
    });

    assert.equal(result.valid, true);
    assert.equal(result.provenance?.version, "1.21.10");
    assert.equal(result.provenance?.jarPath, binaryJarPath);
    assert.equal(result.provenance?.origin, "loom-cache");
    assert.equal(result.provenance?.requestedScope, "merged");
    assert.equal(result.provenance?.appliedScope, "merged");
    assert.equal(result.provenance?.requestedMapping, "yarn");
    assert.equal(result.provenance?.mappingApplied, "intermediary");

    const classEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "class");
    const methodEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "method");
    const fieldEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "field");
    assert.equal(classEntry?.resolvedInRuntime, true);
    assert.equal(classEntry?.resolvedRuntimeAccess, "public");
    assert.equal(methodEntry?.resolvedInRuntime, true);
    assert.equal(methodEntry?.resolvedRuntimeAccess, "public");
    assert.equal(methodEntry?.resolvedRuntimeJvmDescriptor, "()V");
    assert.match(methodEntry?.resolvedRuntimeJavaSignature ?? "", /tickServer/);
    assert.equal(fieldEntry?.resolvedInRuntime, true);
    assert.equal(fieldEntry?.resolvedRuntimeAccess, "private");
    assert.equal(fieldEntry?.resolvedRuntimeJvmDescriptor, "I");
    assert.match(fieldEntry?.resolvedRuntimeJavaSignature ?? "", /serverPort/);
  });
});

test("SourceService validateAccessWidener prefers explicit mapped merged jars over ambiguous merged jars", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-aw-explicit-merged-"));
  const gradleUserHome = join(root, "gradle-home");
  const fabricLoomDir = join(gradleUserHome, "caches", "fabric-loom", "1.21.10");
  const ambiguousJarPath = join(fabricLoomDir, "minecraft-merged-1.21.10.jar");
  const explicitJarPath = join(fabricLoomDir, "minecraft-merged-intermediary-v2-1.21.10.jar");
  await mkdir(fabricLoomDir, { recursive: true });
  await createJar(ambiguousJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n"
  });
  await createJar(explicitJarPath, {
    "net/minecraft/class_1937.class": buildClassFile({
      internalName: "net/minecraft/class_1937",
      accessFlags: 0x0001,
      methods: [{ name: "method_1725", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const service = new SourceService(buildTestConfig(root));

  await withGradleUserHome(gradleUserHome, async () => {
    const discovery = await (
      service as unknown as {
        discoverAccessWidenerRuntimeCandidates: (input: {
          version: string;
          projectPath?: string;
          requestedScope: "merged";
        }) => Promise<{ candidateArtifacts: string[]; selected?: { jarPath: string } }>;
      }
    ).discoverAccessWidenerRuntimeCandidates({
      version: "1.21.10",
      projectPath: root,
      requestedScope: "merged"
    });

    assert.equal(discovery.selected?.jarPath, explicitJarPath);
    assert.ok(discovery.candidateArtifacts.includes(explicitJarPath));
    assert.ok(discovery.candidateArtifacts.includes(ambiguousJarPath));
    assert.ok(discovery.candidateArtifacts.every((candidate) => !candidate.includes("#namespace=")));

    const provenance = await (
      service as unknown as {
        resolveAccessWidenerRuntimeArtifact: (input: {
          version: string;
          awNamespace: "yarn";
          projectPath?: string;
          scope: "merged";
        }) => Promise<{ jarPath: string; mappingApplied: string; resolutionNotes?: string[] }>;
      }
    ).resolveAccessWidenerRuntimeArtifact({
      version: "1.21.10",
      awNamespace: "yarn",
      projectPath: root,
      scope: "merged"
    });

    assert.equal(provenance.jarPath, explicitJarPath);
    assert.equal(provenance.mappingApplied, "intermediary");
  });
});

test("SourceService validateAccessWidener runtime-aware mode fails when no runtime jar can be resolved", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-aw-runtime-missing-"));
  const gradleUserHome = join(root, "gradle-home");
  const service = new SourceService(buildTestConfig(root));

  await withGradleUserHome(gradleUserHome, async () => {
    await assert.rejects(
      async () => (
        service as unknown as {
          validateAccessWidener: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
        }
      ).validateAccessWidener({
        content: "accessWidener v2 named\naccessible class net/minecraft/server/MinecraftServer",
        version: "1.21.10",
        projectPath: root,
        scope: "merged"
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.CONTEXT_UNRESOLVED
    );
  });
});

test("SourceService validateAccessTransformer infers srg namespace from Forge workspace loader scope", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-at-forge-"));
  const runtimeJarPath = join(
    root,
    ".gradle",
    "forge-userdev",
    "1.20.1",
    "minecraft-patched-srg.jar"
  );
  await mkdir(join(root, ".gradle", "forge-userdev", "1.20.1"), { recursive: true });
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'net.minecraftforge.gradle' version '[6.0,6.2)'",
      "}",
      "minecraft {",
      "  accessTransformer = file('src/main/resources/META-INF/accesstransformer.cfg')",
      "}"
    ].join("\n"),
    "utf8"
  );
  await createJar(runtimeJarPath, {
    "net/minecraft/server/MinecraftServer.class": buildClassFile({
      internalName: "net/minecraft/server/MinecraftServer",
      accessFlags: 0x0001,
      fields: [{ name: "field_1234", descriptor: "I", accessFlags: 0x0004 }],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "func_1234_a", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));

  const result = await (
    service as unknown as {
      validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>>;
    }
  ).validateAccessTransformer({
    content: [
      "public-f net.minecraft.server.MinecraftServer",
      "protected net.minecraft.server.MinecraftServer field_1234",
      "public net.minecraft.server.MinecraftServer func_1234_a()V"
    ].join("\n"),
    version: "1.20.1",
    projectPath: root,
    scope: "loader"
  });

  assert.equal(result.valid, true);
  assert.equal(result.provenance?.requestedScope, "loader");
  assert.equal(result.provenance?.appliedScope, "loader");
  assert.equal(result.provenance?.requestedMapping, "srg");
  assert.equal(result.provenance?.mappingApplied, "srg");
  assert.equal(result.provenance?.jarPath, runtimeJarPath);

  const classEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "class");
  const fieldEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "field");
  const methodEntry = result.entries.find((entry: Record<string, unknown>) => entry.targetKind === "method");
  assert.equal(classEntry?.resolvedInRuntime, true);
  assert.equal(classEntry?.resolvedRuntimeAccess, "public");
  assert.equal(fieldEntry?.resolvedRuntimeAccess, "protected");
  assert.equal(methodEntry?.resolvedRuntimeAccess, "public");
  assert.equal(methodEntry?.resolvedRuntimeJvmDescriptor, "()V");
});

test("SourceService validateAccessTransformer infers mojang namespace from NeoForge workspace loader scope", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-at-neoforge-"));
  const runtimeJarPath = join(
    root,
    "build",
    "moddev",
    "runtime",
    "minecraft-client-extra-1.21.10.jar"
  );
  await mkdir(join(root, "build", "moddev", "runtime"), { recursive: true });
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'net.neoforged.moddev' version '2.0.140'",
      "}",
      "neoForge {",
      "  accessTransformers.from(file('src/main/resources/META-INF/accesstransformer.cfg'))",
      "}"
    ].join("\n"),
    "utf8"
  );
  await createJar(runtimeJarPath, {
    "net/minecraft/server/MinecraftServer.class": buildClassFile({
      internalName: "net/minecraft/server/MinecraftServer",
      accessFlags: 0x0001,
      fields: [{ name: "serverPort", descriptor: "I", accessFlags: 0x0001 }],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "tickServer", descriptor: "()V", accessFlags: 0x0004 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));

  const result = await (
    service as unknown as {
      validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>>;
    }
  ).validateAccessTransformer({
    content: [
      "public net.minecraft.server.MinecraftServer",
      "public net.minecraft.server.MinecraftServer serverPort",
      "protected net.minecraft.server.MinecraftServer tickServer()V"
    ].join("\n"),
    version: "1.21.10",
    projectPath: root,
    scope: "loader"
  });

  assert.equal(result.valid, true);
  assert.equal(result.provenance?.requestedMapping, "mojang");
  assert.equal(result.provenance?.mappingApplied, "mojang");
  assert.equal(result.provenance?.appliedScope, "loader");
  assert.equal(result.provenance?.jarPath, runtimeJarPath);
});

test("SourceService validateAccessTransformer requires explicit atNamespace without workspace context", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-validate-at-namespace-"));
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    async () => (
      service as unknown as {
        validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).validateAccessTransformer({
      content: "public net.minecraft.server.MinecraftServer",
      version: "1.21.10"
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
  );
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
    compact: false
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
// B2/B3: resolveArtifact suggestedCall preserves representative scope/mapping hints
// ---------------------------------------------------------------------------
test("B2/B3: resolveArtifact preserves representative suggestedCall hint variants", async (t) => {
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

// ---------------------------------------------------------------------------
// B1: CLASS_NOT_FOUND includes scope, target context, and retry hints
// ---------------------------------------------------------------------------
test("B1: getClassSource CLASS_NOT_FOUND preserves representative context details", async (t) => {
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

// ---------------------------------------------------------------------------
// B4: version-approximated flag when source jar doesn't contain exact version
// ---------------------------------------------------------------------------
test("B4: resolveArtifact flags representative version-approximated mismatches", { concurrency: false }, async (t) => {
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

test("SourceService validateMixin handles representative report-shaping flows", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateMixinReportShapingContext = {
    root: string;
    jarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  function buildValidationIncompleteIssue() {
    return {
      severity: "warning" as const,
      kind: "validation-incomplete",
      annotation: "@Mixin",
      target: "net.minecraft.server.Main",
      message: "Target metadata could not be loaded completely; member validation was skipped.",
      confidence: "uncertain" as const,
      category: "resolution" as const,
      resolutionPath: "source-signature-unavailable",
      issueOrigin: "tool_issue" as const,
      falsePositiveRisk: "high" as const
    };
  }

  function buildPartialSummary() {
    return {
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
    };
  }

  function buildSummaryFirstSingleResult(
    root: string,
    sourcePath: string | undefined,
    options: {
      warning: string;
      appliedSourcePriority?: "loom-first" | "maven-first";
      includeResolutionTrace?: boolean;
      includeConfidenceBreakdown?: boolean;
    }
  ) {
    return {
      className: sourcePath?.includes("World") ? "WorldMixin" : "PlayerMixin",
      targets: ["net.minecraft.server.Main"],
      valid: true,
      validationStatus: "partial" as const,
      issues: [buildValidationIncompleteIssue()],
      summary: buildPartialSummary(),
      provenance: {
        version: "1.21",
        jarPath: join(root, "client.jar"),
        requestedMapping: "mojang" as const,
        mappingApplied: "mojang" as const,
        requestedScope: "vanilla" as const,
        appliedScope: "vanilla" as const,
        requestedSourcePriority: "loom-first" as const,
        appliedSourcePriority: options.appliedSourcePriority ?? "loom-first",
        ...(options.includeResolutionTrace === false
          ? {}
          : {
              resolutionTrace: [
                {
                  target: "net.minecraft.server.Main",
                  step: "signature" as const,
                  input: "net.minecraft.server.Main",
                  output: "missing metadata",
                  success: false
                }
              ]
            })
      },
      warnings: [options.warning],
      confidenceScore: 80,
      ...(options.includeConfidenceBreakdown === false
        ? {}
        : {
            confidenceBreakdown: {
              baseScore: 100,
              score: 80,
              penalties: [{ reason: "members-skipped", points: 20 }]
            }
          }),
      quickSummary:
        "0 error(s), 0 uncertain, 1 warning(s). 0 validated, 1 member(s) skipped, 0 member(s) missing."
    };
  }

  async function createValidateMixinReportShapingContext(
    rootPrefix: string
  ): Promise<ValidateMixinReportShapingContext> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const jarPath = join(root, "client.jar");
    await createJar(jarPath, {});
    return {
      root,
      jarPath,
      service: new SourceService(buildTestConfig(root))
    };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    run: (ctx: ValidateMixinReportShapingContext) => Promise<void>;
  }> = [
    {
      name: "summary-first hoists shared provenance and incomplete reasons",
      rootPrefix: "service-validate-mixin-summary-first-",
      run: async ({ root, service }) => {
        (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) =>
          buildSummaryFirstSingleResult(root, sourcePath, {
            warning: "Shared validation warning"
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
      }
    },
    {
      name: "summary-first preserves per-result provenance when batch provenance differs",
      rootPrefix: "service-validate-mixin-summary-first-mixed-",
      run: async ({ root, service }) => {
        (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) => {
          const isWorld = sourcePath?.includes("World");
          return buildSummaryFirstSingleResult(root, sourcePath, {
            warning: isWorld ? "World validation warning" : "Player validation warning",
            appliedSourcePriority: isWorld ? "maven-first" : "loom-first",
            includeResolutionTrace: false,
            includeConfidenceBreakdown: false
          });
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
      }
    },
    {
      name: "can omit per-result issues while preserving summaries",
      rootPrefix: "service-validate-mixin-no-issues-",
      run: async ({ jarPath, service }) => {
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
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const ctx = await createValidateMixinReportShapingContext(testCase.rootPrefix);
      await testCase.run(ctx);
    });
  }
});

test("SourceService validateMixin discovers representative config and project layouts", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateMixinDiscoveryContext = {
    root: string;
    jarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  function buildServerMixinSource() {
    return [
      "import net.minecraft.server.Main;",
      "import org.spongepowered.asm.mixin.Mixin;",
      "",
      "@Mixin(Main.class)",
      "public abstract class __CLASS__ {}"
    ].join("\n");
  }

  async function createValidateMixinDiscoveryContext(
    rootPrefix: string,
    signatureClassName = "net.minecraft.server.Main"
  ): Promise<ValidateMixinDiscoveryContext> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
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
          className: signatureClassName,
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

    return { root, jarPath, service };
  }

  const cases: Array<{
    name: string;
    signatureClassName?: string;
    run: (ctx: ValidateMixinDiscoveryContext) => Promise<void>;
  }> = [
    {
      name: "mixinConfigPath auto-detect finds multiple module source roots",
      run: async ({ root, service }) => {
        const commonJavaRoot = join(root, "common", "src", "main", "java", "com", "example");
        const neoJavaRoot = join(root, "neoforge", "src", "main", "java", "com", "example");
        const mixinConfigPath = join(root, "neoforge", "src", "main", "resources", "example.mixins.json");

        await mkdir(commonJavaRoot, { recursive: true });
        await mkdir(neoJavaRoot, { recursive: true });
        await mkdir(join(root, "neoforge", "src", "main", "resources"), { recursive: true });

        const mixinSource = buildServerMixinSource();
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
      }
    },
    {
      name: "mixinConfigPath auto-detect finds client source root (split source sets)",
      signatureClassName: "net.minecraft.client.Minecraft",
      run: async ({ root, service }) => {
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
          JSON.stringify(
            {
              required: true,
              package: "com.example.mixin.client",
              client: ["ExampleClientMixin"]
            },
            null,
            2
          ),
          "utf8"
        );

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
      }
    },
    {
      name: "mixinConfigPath finds mixins in both main and client source roots",
      run: async ({ root, service }) => {
        const mainJavaRoot = join(root, "src", "main", "java", "com", "example", "mixin");
        const clientJavaRoot = join(root, "src", "client", "java", "com", "example", "mixin", "client");
        const mixinConfigDir = join(root, "src", "main", "resources");

        await mkdir(mainJavaRoot, { recursive: true });
        await mkdir(clientJavaRoot, { recursive: true });
        await mkdir(mixinConfigDir, { recursive: true });

        const mixinSource = buildServerMixinSource();
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
          JSON.stringify(
            {
              package: "com.example.mixin",
              mixins: ["ServerMixin"],
              client: ["client.ClientMixin"]
            },
            null,
            2
          ),
          "utf8"
        );

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
      }
    },
    {
      name: "config mode reports empty mixin configs as warnings instead of invalid input",
      run: async ({ root, service }) => {
        const mixinConfigDir = join(root, "src", "main", "resources");
        const mixinConfigPath = join(mixinConfigDir, "empty.mixins.json");

        await mkdir(mixinConfigDir, { recursive: true });
        await writeFile(
          mixinConfigPath,
          JSON.stringify({ package: "com.example", mixins: [] }, null, 2),
          "utf8"
        );

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
        assert.equal(result.summary.total, 0);
        assert.equal(result.summary.processingErrors, 0);
        assert.equal(result.summary.valid, 0);
        assert.equal(result.summary.invalid, 0);
        assert.equal(result.results.length, 0);
        assert.ok(result.warnings.some((warning) => warning.includes("contains no mixin class entries")));
      }
    },
    {
      name: "project mode auto-discovers mixin configs across modules",
      run: async ({ root, service }) => {
        const commonJavaRoot = join(root, "common", "src", "main", "java", "com", "example");
        const neoJavaRoot = join(root, "neoforge", "src", "main", "java", "com", "example");
        const commonConfigPath = join(root, "common", "src", "main", "resources", "example.mixins.json");
        const neoConfigPath = join(root, "neoforge", "src", "main", "resources", "example.neoforge.mixins.json");

        await mkdir(commonJavaRoot, { recursive: true });
        await mkdir(neoJavaRoot, { recursive: true });
        await mkdir(join(root, "common", "src", "main", "resources"), { recursive: true });
        await mkdir(join(root, "neoforge", "src", "main", "resources"), { recursive: true });

        const mixinSource = buildServerMixinSource();
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
      }
    },
    {
      name: "project mode reports empty discovered mixin configs as warnings",
      run: async ({ root, service }) => {
        const resourcesRoot = join(root, "src", "main", "resources");
        const mixinConfigPath = join(resourcesRoot, "empty.mixins.json");

        await mkdir(resourcesRoot, { recursive: true });
        await writeFile(
          mixinConfigPath,
          JSON.stringify({ package: "com.example", client: [], server: [] }, null, 2),
          "utf8"
        );

        const result = await service.validateMixin({
          input: {
            mode: "project",
            path: root
          },
          version: "1.21",
          mapping: "obfuscated"
        } as never);

        assert.equal(result.mode, "project");
        assert.equal(result.summary.total, 0);
        assert.equal(result.summary.processingErrors, 0);
        assert.equal(result.summary.valid, 0);
        assert.equal(result.summary.invalid, 0);
        assert.equal(result.results.length, 0);
        assert.ok(result.warnings.some((warning) => warning.includes("contains no mixin class entries")));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const ctx = await createValidateMixinDiscoveryContext(
        `service-validate-mixin-${testCase.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-`,
        testCase.signatureClassName
      );
      await testCase.run(ctx);
    });
  }
});

// ---------------------------------------------------------------------------
// F-01: strictVersion rejects version-approximated results
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// F-03: queryMode search fallback for separator-containing queries
// ---------------------------------------------------------------------------
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

// ── descriptor remap regression tests ──────────────────────────────────────

test("SourceService validateAccessWidener remaps class references inside method descriptors", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "aw-descriptor-remap-"));
  const gradleUserHome = join(root, "gradle-home");
  const loomCacheDir = join(gradleUserHome, "loom-cache", "runtime");
  const binaryJarPath = join(loomCacheDir, "minecraft-merged-1.21.10.jar");
  const sourceJarPath = join(loomCacheDir, "minecraft-merged-1.21.10-sources.jar");

  // Binary jar: class uses intermediary names with class-referencing descriptors
  await createJar(binaryJarPath, {
    "net/minecraft/class_1937.class": buildClassFile({
      internalName: "net/minecraft/class_1937",
      accessFlags: 0x0421,
      fields: [{ name: "field_9236", descriptor: "Z", accessFlags: 0x0004 }],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0004 },
        { name: "method_1725", descriptor: "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z", accessFlags: 0x0001 }
      ]
    }),
    "net/minecraft/class_2338.class": buildClassFile({
      internalName: "net/minecraft/class_2338",
      accessFlags: 0x0001,
      methods: [{ name: "method_100", descriptor: "()V", accessFlags: 0x0001 }]
    }),
    "net/minecraft/class_2680.class": buildClassFile({
      internalName: "net/minecraft/class_2680",
      accessFlags: 0x0001,
      methods: [{ name: "method_200", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });
  await createJar(sourceJarPath, {
    "net/minecraft/class_1937.java": "package net.minecraft; public abstract class class_1937 {}"
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; owner?: string; sourceMapping: string; targetMapping: string }) {
      // intermediary → yarn class mappings
      const classMappings: Record<string, string> = {
        "net.minecraft.class_1937": "net.minecraft.world.level.Level",
        "net.minecraft.class_2338": "net.minecraft.core.BlockPos",
        "net.minecraft.class_2680": "net.minecraft.world.level.block.state.BlockState"
      };
      const reverseClassMappings: Record<string, string> = {
        "net.minecraft.world.level.Level": "net.minecraft.class_1937",
        "net.minecraft.core.BlockPos": "net.minecraft.class_2338",
        "net.minecraft.world.level.block.state.BlockState": "net.minecraft.class_2680"
      };
      if (input.kind === "class") {
        if (input.sourceMapping === "yarn" && input.targetMapping === "intermediary" && reverseClassMappings[input.name]) {
          return { resolved: true, status: "resolved", resolvedSymbol: { name: reverseClassMappings[input.name] }, candidates: [], candidateCount: 1, warnings: [] };
        }
        if (input.sourceMapping === "intermediary" && input.targetMapping === "yarn" && classMappings[input.name]) {
          return { resolved: true, status: "resolved", resolvedSymbol: { name: classMappings[input.name] }, candidates: [], candidateCount: 1, warnings: [] };
        }
      }
      if (input.kind === "field" && input.name === "field_9236" && input.sourceMapping === "intermediary" && input.targetMapping === "yarn") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "isClientSide", descriptor: "Z" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      return { resolved: false, status: "not_found", candidates: [], candidateCount: 0, warnings: [] };
    },
    async resolveMethodMappingExact(input: { owner: string; name: string; descriptor: string; sourceMapping: string; targetMapping: string }) {
      if (
        input.owner === "net.minecraft.class_1937" &&
        input.name === "method_1725" &&
        input.descriptor === "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z" &&
        input.sourceMapping === "intermediary" &&
        input.targetMapping === "yarn"
      ) {
        return {
          resolved: true, status: "resolved",
          resolvedSymbol: { name: "setBlock", descriptor: "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z" },
          querySymbol: {}, mappingContext: {}, candidates: [], candidateCount: 1, warnings: []
        };
      }
      return { resolved: false, status: "not_found", querySymbol: {}, mappingContext: {}, candidates: [], candidateCount: 0, warnings: [] };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      assert.fail("should use runtime artifact");
    }
  };

  await withGradleUserHome(gradleUserHome, async () => {
    const result = await (service as unknown as { validateAccessWidener: (input: Record<string, unknown>) => Promise<Record<string, any>> }).validateAccessWidener({
      content: [
        "accessWidener v2 named",
        "accessible class net/minecraft/world/level/Level",
        "accessible method net/minecraft/world/level/Level setBlock (Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z",
        "accessible field net/minecraft/world/level/Level isClientSide Z"
      ].join("\n"),
      version: "1.21.10",
      projectPath: root,
      scope: "merged"
    });

    assert.equal(result.valid, true, `expected valid=true but got entries: ${JSON.stringify(result.entries)}`);
    assert.equal(result.entries.length, 3);

    const classEntry = result.entries.find((e: any) => e.targetKind === "class");
    const methodEntry = result.entries.find((e: any) => e.targetKind === "method");
    const fieldEntry = result.entries.find((e: any) => e.targetKind === "field");
    assert.equal(classEntry?.valid, true);
    assert.equal(methodEntry?.valid, true, `method entry: ${JSON.stringify(methodEntry)}`);
    assert.equal(fieldEntry?.valid, true);

    // Verify remapped descriptor is returned in runtime evidence
    assert.equal(methodEntry?.resolvedRuntimeJvmDescriptor, "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z");
    assert.match(methodEntry?.resolvedRuntimeJavaSignature ?? "", /setBlock/);
  });
});

test("SourceService validateAccessTransformer remaps class references inside method descriptors", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "at-descriptor-remap-"));
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true });

  // Use a version jar directly (non-runtime-aware path)
  const vanillaJarPath = join(cacheDir, "1.21.10.jar");
  await createJar(vanillaJarPath, {
    "a/b.class": buildClassFile({
      internalName: "a/b",
      accessFlags: 0x0421,
      fields: [{ name: "c", descriptor: "Z", accessFlags: 0x0004 }],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0004 },
        { name: "d", descriptor: "(La/e;La/f;I)Z", accessFlags: 0x0001 }
      ]
    }),
    "a/e.class": buildClassFile({ internalName: "a/e", accessFlags: 0x0001 }),
    "a/f.class": buildClassFile({ internalName: "a/f", accessFlags: 0x0001 })
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      const classMappings: Record<string, string> = {
        "net.minecraft.world.level.Level": "a.b",
        "net.minecraft.core.BlockPos": "a.e",
        "net.minecraft.world.level.block.state.BlockState": "a.f"
      };
      const reverseClassMappings: Record<string, string> = {
        "a.b": "net.minecraft.world.level.Level",
        "a.e": "net.minecraft.core.BlockPos",
        "a.f": "net.minecraft.world.level.block.state.BlockState"
      };
      if (input.kind === "class" && input.sourceMapping === "mojang" && input.targetMapping === "obfuscated" && classMappings[input.name]) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: classMappings[input.name] }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (input.kind === "class" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang" && reverseClassMappings[input.name]) {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: reverseClassMappings[input.name] }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (input.kind === "field" && input.name === "c" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "isClientSide", descriptor: "Z" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      return { resolved: false, status: "not_found", candidates: [], candidateCount: 0, warnings: [] };
    },
    async resolveMethodMappingExact(input: { owner: string; name: string; descriptor: string; sourceMapping: string; targetMapping: string }) {
      if (input.owner === "a.b" && input.name === "d" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang") {
        return {
          resolved: true, status: "resolved",
          resolvedSymbol: { name: "setBlock", descriptor: "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z" },
          querySymbol: {}, mappingContext: {}, candidates: [], candidateCount: 1, warnings: []
        };
      }
      return { resolved: false, status: "not_found", querySymbol: {}, mappingContext: {}, candidates: [], candidateCount: 0, warnings: [] };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      return { jarPath: vanillaJarPath };
    }
  };

  const result = await (service as unknown as { validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>> }).validateAccessTransformer({
    content: [
      "public net.minecraft.world.level.Level isClientSide",
      "public net.minecraft.world.level.Level setBlock(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z"
    ].join("\n"),
    version: "1.21.10",
    atNamespace: "mojang"
  });

  assert.equal(result.valid, true, `expected valid=true but got entries: ${JSON.stringify(result.entries)}`);
  const fieldEntry = result.entries.find((e: any) => e.targetKind === "field");
  const methodEntry = result.entries.find((e: any) => e.targetKind === "method");
  assert.equal(fieldEntry?.valid, true);
  assert.equal(methodEntry?.valid, true, `method entry: ${JSON.stringify(methodEntry)}`);
});

test("SourceService detectFabricLikeInputNamespace detects intermediary vs mojang jars", async () => {
  const { detectFabricLikeInputNamespace } = await import("../src/source-jar-reader.ts");
  const root = await mkdtemp(join(tmpdir(), "ns-detect-"));

  // intermediary jar
  const intermediaryJar = join(root, "intermediary.jar");
  await createJar(intermediaryJar, {
    "net/minecraft/class_1937.class": buildClassFile({
      internalName: "net/minecraft/class_1937",
      accessFlags: 0x0001,
      methods: [{ name: "method_1234", descriptor: "()V", accessFlags: 0x0001 }],
      fields: [{ name: "field_1234", descriptor: "I", accessFlags: 0x0002 }]
    }),
    "net/minecraft/class_2338.class": buildClassFile({
      internalName: "net/minecraft/class_2338",
      accessFlags: 0x0001,
      methods: [{ name: "method_5678", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });
  const intermediaryResult = await detectFabricLikeInputNamespace(intermediaryJar);
  assert.equal(intermediaryResult.fromNamespace, "intermediary");

  // mojang jar
  const mojangJar = join(root, "mojang.jar");
  await createJar(mojangJar, {
    "net/minecraft/world/level/Level.class": buildClassFile({
      internalName: "net/minecraft/world/level/Level",
      accessFlags: 0x0421,
      methods: [{ name: "setBlock", descriptor: "()V", accessFlags: 0x0001 }],
      fields: [{ name: "isClientSide", descriptor: "Z", accessFlags: 0x0004 }]
    }),
    "net/minecraft/core/BlockPos.class": buildClassFile({
      internalName: "net/minecraft/core/BlockPos",
      accessFlags: 0x0001
    })
  });
  const mojangResult = await detectFabricLikeInputNamespace(mojangJar);
  assert.equal(mojangResult.fromNamespace, "mojang");
});

test("SourceService remapSignatureMembers logs warning when resolveMethodMappingExact throws", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "exact-resolver-warn-"));
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true });

  const vanillaJarPath = join(cacheDir, "1.21.10.jar");
  await createJar(vanillaJarPath, {
    "a/b.class": buildClassFile({
      internalName: "a/b",
      accessFlags: 0x0421,
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0004 },
        { name: "d", descriptor: "(La/e;I)Z", accessFlags: 0x0001 }
      ]
    }),
    "a/e.class": buildClassFile({ internalName: "a/e", accessFlags: 0x0001 })
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.world.level.Level" && input.sourceMapping === "mojang" && input.targetMapping === "obfuscated") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "a.b" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (input.kind === "class" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang") {
        const map: Record<string, string> = { "a.b": "net.minecraft.world.level.Level", "a.e": "net.minecraft.core.BlockPos" };
        if (map[input.name]) return { resolved: true, status: "resolved", resolvedSymbol: { name: map[input.name] }, candidates: [], candidateCount: 1, warnings: [] };
      }
      // findMapping fallback for methods — returns name-only
      if (input.kind === "method" && input.name === "d" && input.sourceMapping === "obfuscated" && input.targetMapping === "mojang") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "setBlock", descriptor: "(Lnet/minecraft/core/BlockPos;I)Z" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      return { resolved: false, status: "not_found", candidates: [], candidateCount: 0, warnings: [] };
    },
    async resolveMethodMappingExact() {
      throw new Error("mapping graph unavailable for test");
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() { return { jarPath: vanillaJarPath }; }
  };

  const result = await (service as unknown as { validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>> }).validateAccessTransformer({
    content: "public net.minecraft.world.level.Level setBlock(Lnet/minecraft/core/BlockPos;I)Z",
    version: "1.21.10",
    atNamespace: "mojang"
  });

  // Method should still resolve via findMapping fallback
  const methodEntry = result.entries.find((e: any) => e.targetKind === "method");
  assert.equal(methodEntry?.valid, true, `method should resolve via fallback: ${JSON.stringify(methodEntry)}`);

  // The exact resolver failure should surface as a warning
  const warnings: string[] = result.warnings ?? [];
  assert.ok(
    warnings.some((w: string) => w.includes("Exact method resolution failed") && w.includes("mapping graph unavailable for test")),
    `warnings should contain exact resolver failure message, got: ${JSON.stringify(warnings)}`
  );
});

test("SourceService validateAccessWidener runtime-aware namespace detection warnings appear in provenance.resolutionNotes", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "ns-detect-notes-"));
  const gradleUserHome = join(root, "gradle-home");
  const loomCacheDir = join(gradleUserHome, "loom-cache", "runtime");
  const binaryJarPath = join(loomCacheDir, "minecraft-merged-1.21.10.jar");
  const sourceJarPath = join(loomCacheDir, "minecraft-merged-1.21.10-sources.jar");

  // Create a jar with NO class entries at all — namespace detection will warn and fallback
  await createJar(binaryJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n"
  });
  await createJar(sourceJarPath, {
    "net/minecraft/server/Main.java": "package net.minecraft.server; public class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: { kind: string; name: string; sourceMapping: string; targetMapping: string }) {
      if (input.kind === "class" && input.name === "net.minecraft.server.Main" && input.sourceMapping === "intermediary" && input.targetMapping === "yarn") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "net.minecraft.server.MinecraftServer" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      if (input.kind === "class" && input.name === "net.minecraft.server.MinecraftServer" && input.sourceMapping === "yarn" && input.targetMapping === "intermediary") {
        return { resolved: true, status: "resolved", resolvedSymbol: { name: "net.minecraft.server.Main" }, candidates: [], candidateCount: 1, warnings: [] };
      }
      return { resolved: false, status: "not_found", candidates: [], candidateCount: 0, warnings: [] };
    }
  };
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar() {
      assert.fail("should use runtime artifact");
    }
  };

  await withGradleUserHome(gradleUserHome, async () => {
    const result = await (service as unknown as { validateAccessWidener: (input: Record<string, unknown>) => Promise<Record<string, any>> }).validateAccessWidener({
      content: "accessWidener v2 named\naccessible class net/minecraft/server/MinecraftServer\n",
      version: "1.21.10",
      projectPath: root,
      scope: "merged"
    });

    // Namespace detection should have warned about empty jar and fallen back to intermediary
    assert.ok(result.provenance, "provenance should be present");
    assert.equal(result.provenance.mappingApplied, "intermediary");
    assert.ok(result.provenance.resolutionNotes, "resolutionNotes should be present");
    const notes = result.provenance.resolutionNotes as string[];
    assert.ok(
      notes.some((n: string) => n.includes("Could not inspect class entries")),
      `resolutionNotes should contain namespace detection warning, got: ${JSON.stringify(notes)}`
    );
  });
});

test("SourceService getClassMembers populates decompiledFallback when bytecode enumeration returns zero but decompiled source is indexed", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-fallback",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "  int experienceLevel = 0;",
          "  public Player() {}",
          "  public void addAdditionalSaveData() {}",
          "  public int getHealth() { return 20; }",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

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

  const result = await service.getClassMembers({
    artifactId: "artifact-decompiled-fallback",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang"
  });

  assert.equal(result.counts.total, 0);
  assert.ok(result.decompiledFallback, "decompiledFallback should be populated");
  assert.equal(result.decompiledFallback?.origin, "source-extracted");
  assert.ok(
    result.decompiledFallback!.constructors.some((m) => m.name === "<init>"),
    "constructors should include <init> entry"
  );
  assert.ok(
    result.decompiledFallback!.methods.some((m) => m.name === "addAdditionalSaveData"),
    "methods should include addAdditionalSaveData"
  );
  assert.ok(
    result.decompiledFallback!.fields.some((m) => m.name === "experienceLevel"),
    "fields should include experienceLevel"
  );
  assert.ok(result.qualityFlags.includes("members-from-decompiled-source"));
  assert.ok(result.decompiledMemberCounts, "decompiledMemberCounts should be populated");
  assert.ok(result.decompiledMemberCounts!.total > 0);
  assert.ok(
    result.warnings.some((warning) => warning.includes("decompiledFallback")),
    "should include a warning about decompiledFallback"
  );
});

test("SourceService getClassMembers applies memberPattern to decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-pattern-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-fallback-pattern",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "net/minecraft/world/entity/player/Player.java",
        content: [
          "package net.minecraft.world.entity.player;",
          "public class Player {",
          "    public void addAdditionalSaveData() {}",
          "    public void readAdditionalSaveData() {}",
          "    public void tick() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

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

  const result = await service.getClassMembers({
    artifactId: "artifact-decompiled-fallback-pattern",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    memberPattern: "SaveData"
  });

  assert.ok(result.decompiledFallback, "decompiledFallback should be populated");
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  assert.deepEqual(
    methodNames.sort(),
    ["addAdditionalSaveData", "readAdditionalSaveData"].sort()
  );
  assert.equal(
    result.decompiledFallback!.methods.some((m) => m.name === "tick"),
    false,
    "pattern-mismatched methods should be filtered out"
  );
});

test("SourceService getClassMembers scopes decompiledFallback to the requested class body, excluding nested types", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-inner-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-inner",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "com/example/Outer.java",
        content: [
          "package com.example;",
          "public class Outer {",
          "  int outerField = 0;",
          "  public void outerMethod() {}",
          "  public static class Inner {",
          "    int innerField = 1;",
          "    public void innerMethod() {}",
          "  }",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

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

  const result = await service.getClassMembers({
    artifactId: "artifact-decompiled-inner",
    className: "com.example.Outer",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback, "decompiledFallback should be populated for outer class");
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("outerMethod"), "should include outerMethod");
  assert.equal(
    methodNames.includes("innerMethod"),
    false,
    `innerMethod must not leak into outer class's fallback; got methods=${JSON.stringify(methodNames)}`
  );
  assert.ok(fieldNames.includes("outerField"), "should include outerField");
  assert.equal(
    fieldNames.includes("innerField"),
    false,
    `innerField must not leak into outer class's fallback; got fields=${JSON.stringify(fieldNames)}`
  );
});

test("SourceService getClassMembers keeps outer members declared after a nested type", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-after-inner-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-after-inner",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "com/example/Outer.java",
        content: [
          "package com.example;",
          "public class Outer {",
          "  int before = 0;",
          "  public static class Inner {",
          "    int innerField = 1;",
          "    public void innerMethod() {}",
          "  }",
          "  int after = 2;",
          "  public void afterInner() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

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

  const result = await service.getClassMembers({
    artifactId: "artifact-after-inner",
    className: "com.example.Outer",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback);
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("afterInner"), `afterInner should be kept; got methods=${JSON.stringify(methodNames)}`);
  assert.equal(methodNames.includes("innerMethod"), false, "innerMethod must not leak");
  assert.ok(fieldNames.includes("before"), "before field should be kept");
  assert.ok(fieldNames.includes("after"), `after field should be kept; got fields=${JSON.stringify(fieldNames)}`);
  assert.equal(fieldNames.includes("innerField"), false, "innerField must not leak");
});

test("SourceService getClassMembers uses the artifact-namespace lookup name when building decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-ns-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  // Artifact is indexed in obfuscated namespace (file path uses obf name).
  seedIndexedArtifact(service, {
    artifactId: "artifact-decompiled-ns",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "czl/czl.java",
        content: [
          "package czl;",
          "public class czl {",
          "  int f = 0;",
          "  public void m() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  // Mapping service translates mojang FQCN → obf for the lookup.
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(request: { name: string; sourceMapping: string; targetMapping: string }) {
      if (request.sourceMapping === "mojang" && request.targetMapping === "obfuscated") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { kind: "class", name: "czl.czl", symbol: "czl.czl" },
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

  const result = await service.getClassMembers({
    artifactId: "artifact-decompiled-ns",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang"
  });

  assert.ok(
    result.decompiledFallback,
    `decompiledFallback should be populated when filesRepo is indexed under artifact namespace; mappingApplied=${result.mappingApplied}`
  );
  assert.ok(
    result.decompiledFallback!.methods.some((m) => m.name === "m"),
    "artifact-namespace method name should surface in fallback"
  );
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("obfuscated") && warning.includes("mojang")
    ),
    `fallback warning should disclose the namespace mismatch, got: ${JSON.stringify(result.warnings)}`
  );
});

test("SourceService getClassMembers excludes method calls and local variables from decompiledFallback", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-body-depth-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-body-depth",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "com/example/Demo.java",
        content: [
          "package com.example;",
          "public class Demo {",
          "  int realField = 0;",
          "  public void realMethod() {",
          "    int localVar = 0;",
          "    this.helperCall();",
          "  }",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

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

  const result = await service.getClassMembers({
    artifactId: "artifact-body-depth",
    className: "com.example.Demo",
    mapping: "mojang"
  });

  assert.ok(result.decompiledFallback);
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  const fieldNames = result.decompiledFallback!.fields.map((m) => m.name);
  assert.ok(methodNames.includes("realMethod"), "realMethod should be present");
  assert.equal(
    methodNames.some((name) => name === "helperCall"),
    false,
    `method-body call should not be reported as a member; got methods=${JSON.stringify(methodNames)}`
  );
  assert.ok(fieldNames.includes("realField"), "realField should be present");
  assert.equal(
    fieldNames.includes("localVar"),
    false,
    `local variables must not be reported as fields; got fields=${JSON.stringify(fieldNames)}`
  );
});

test("SourceService getClassMembers skips memberPattern on fallback when namespaces mismatch and warns", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-decompiled-fallback-pattern-ns-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-pattern-ns",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    version: "1.21.10",
    files: [
      {
        filePath: "czl/czl.java",
        content: [
          "package czl;",
          "public class czl {",
          "  public void a() {}",
          "  public void b() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(request: { name: string; sourceMapping: string; targetMapping: string }) {
      if (request.sourceMapping === "mojang" && request.targetMapping === "obfuscated") {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { kind: "class", name: "czl.czl", symbol: "czl.czl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
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

  const result = await service.getClassMembers({
    artifactId: "artifact-pattern-ns",
    className: "net.minecraft.world.entity.player.Player",
    mapping: "mojang",
    memberPattern: "SaveData"
  });

  assert.ok(
    result.decompiledFallback,
    `decompiledFallback should populate even when requested-namespace memberPattern would have filtered obf names; ${JSON.stringify(result.warnings)}`
  );
  const methodNames = result.decompiledFallback!.methods.map((m) => m.name);
  assert.ok(methodNames.includes("a") && methodNames.includes("b"), `artifact-namespace members must be present, got=${JSON.stringify(methodNames)}`);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("memberPattern=\"SaveData\"") && warning.includes("not applied")
    ),
    `should warn about pattern skip, got: ${JSON.stringify(result.warnings)}`
  );
});

test("SourceService getClassMembers does not populate decompiledFallback when bytecode enumeration already has entries", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-members-no-fallback-needed-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged.jar");

  seedIndexedArtifact(service, {
    artifactId: "artifact-no-fallback",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    binaryJarPath,
    files: [
      {
        filePath: "net/minecraft/server/Main.java",
        content: [
          "package net.minecraft.server;",
          "public class Main {",
          "    public void extraMethod() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: []
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: "net.minecraft.server.Main",
            name: "main",
            javaSignature: "public static void main(String[])",
            jvmDescriptor: "([Ljava/lang/String;)V",
            accessFlags: 0x0009,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: { classExistedInJar: true }
      };
    }
  };

  const result = await service.getClassMembers({
    artifactId: "artifact-no-fallback",
    className: "net.minecraft.server.Main",
    mapping: "obfuscated"
  });

  assert.equal(result.counts.total, 1);
  assert.equal(result.decompiledFallback, undefined);
  assert.equal(result.qualityFlags.includes("members-from-decompiled-source"), false);
});

test("SourceService validateMixin tags failedStage='resolve' when resolveVersionJar throws", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-resolve-"));
  const service = new SourceService(buildTestConfig(root));

  (service as any).versionService = {
    async resolveVersionJar() {
      throw new Error("jar download failed");
    }
  };

  await assert.rejects(
    () => service.validateMixin({
      input: {
        mode: "inline",
        source: [
          "import net.minecraft.server.Main;",
          "import org.spongepowered.asm.mixin.Mixin;",
          "",
          "@Mixin(Main.class)",
          "public abstract class MainMixin {}"
        ].join("\n")
      },
      version: "1.21",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(appError.details?.failedStage, "resolve");
      assert.match(String(appError.message), /validate-mixin failed during stage "resolve"/);
      return true;
    }
  );
});

test("SourceService validateMixin tags failedStage='input-validation' when version is empty", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-input-"));
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => service.validateMixin({
      input: {
        mode: "inline",
        source: "@Mixin(Main.class) public class X {}"
      },
      version: "   ",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(appError.details?.failedStage, "input-validation");
      return true;
    }
  );
});

test("SourceService validateMixin tags failedStage='input-validation' when source is empty", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-empty-"));
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => service.validateMixin({
      input: {
        mode: "inline",
        source: "   "
      },
      version: "1.21",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(appError.details?.failedStage, "input-validation");
      return true;
    }
  );
});

test("SourceService validateMixin preserves an existing nested failedStage rather than overwriting it", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const { createError, ERROR_CODES: Codes } = await import("../src/errors.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-preserve-"));
  const service = new SourceService(buildTestConfig(root));

  (service as any).versionService = {
    async resolveVersionJar() {
      throw createError({
        code: Codes.VERSION_NOT_FOUND,
        message: "unknown minecraft version",
        details: { failedStage: "version-manifest", mcVersion: "1.99" }
      });
    }
  };

  await assert.rejects(
    () => service.validateMixin({
      input: {
        mode: "inline",
        source: [
          "import net.minecraft.server.Main;",
          "import org.spongepowered.asm.mixin.Mixin;",
          "",
          "@Mixin(Main.class)",
          "public abstract class MainMixin {}"
        ].join("\n")
      },
      version: "1.99",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.VERSION_NOT_FOUND);
      assert.equal(appError.details?.failedStage, "version-manifest");
      assert.equal(appError.details?.mcVersion, "1.99");
      return true;
    }
  );
});

test("SourceService validateMixin tags failedStage='input-validation' when a path mode input fails host normalization", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-pathnorm-"));
  const service = new SourceService(buildTestConfig(root));

  const previousDistro = process.env.WSL_DISTRO_NAME;
  const previousInterop = process.env.WSL_INTEROP;
  process.env.WSL_DISTRO_NAME = "UnitTestDistro";
  process.env.WSL_INTEROP = "/tmp/unit-test-interop";
  try {
    // `\\wsl$\OtherDistro\...` (different distro name) triggers
    // normalizePathForHost to throw ERR_INVALID_INPUT BEFORE validateMixin
    // reaches the read try/catch. The outer validate-mixin dispatcher must
    // still tag it with failedStage="input-validation".
    await assert.rejects(
      () => service.validateMixin({
        input: {
          mode: "path",
          path: "\\\\wsl$\\OtherDistro\\home\\user\\Mixin.java"
        },
        version: "1.21",
        mapping: "obfuscated"
      } as never),
      (err: unknown) => {
        const appError = err as { code?: string; details?: Record<string, unknown> };
        assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
        assert.equal(appError.details?.failedStage, "input-validation");
        return true;
      }
    );
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
});

test("SourceService validateMixin quickSummary surfaces mapping-health probe failure as degradation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-qs-probefail-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});
  const service = new SourceService(buildTestConfig(root));

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
      throw new Error("mapping graph download timed out");
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
        "",
        "@Mixin(Main.class)",
        "public abstract class MainMixin {}"
      ].join("\n")
    },
    version: "1.21",
    mapping: "obfuscated"
  });

  const single = result.results[0]?.result;
  assert.ok(single?.toolHealth);
  assert.equal(single!.toolHealth!.overallHealthy, false);
  assert.ok(single!.toolHealth!.degradations.some((d) => d.includes("Mapping health probe failed")));
  assert.ok(single?.quickSummary);
  assert.match(single!.quickSummary!, /Mapping health degraded/);
  assert.match(single!.quickSummary!, /mapping graph download timed out/);
});

test("SourceService validateMixin tags failedStage='input-validation' when project mode finds no mixin configs", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-project-"));
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => service.validateMixin({
      input: { mode: "project", path: root },
      version: "1.21",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(appError.details?.failedStage, "input-validation");
      return true;
    }
  );
});

test("SourceService validateMixin tags failedStage='input-validation' when a mixin config JSON is malformed", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-malformed-"));
  const configPath = join(root, "broken.mixins.json");
  await writeFile(configPath, "{ this is not json", "utf8");
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () => service.validateMixin({
      input: { mode: "config", configPaths: [configPath] },
      version: "1.21",
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(appError.details?.failedStage, "input-validation");
      return true;
    }
  );
});

test("SourceService validateMixin preserves mapping-health quickSummary note through the maven-first retry path under reportMode='compact'", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-qs-retry-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});
  const service = new SourceService(buildTestConfig(root, { mappingSourcePriority: "loom-first" }));

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
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        degradations: ["Mojang mappings unavailable after retry"]
      };
    },
    async findMapping(input: { sourcePriority?: string; kind?: string; sourceMapping?: string; targetMapping?: string; name?: string }) {
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
          resolvedSymbol: { name: resolvedName, descriptor: "()V" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    },
    async checkSymbolExists() {
      return { resolved: true, status: "resolved", candidates: [], warnings: [] };
    }
  };
  (service as any).explorerService = {
    async getSignature(input: { fqn: string }) {
      if (input.fqn !== "a") {
        throw new Error(`missing bytecode for ${input.fqn}`);
      }
      return {
        className: "a",
        constructors: [],
        methods: [
          { ownerFqn: "a", name: "tick", javaSignature: "void tick()", jvmDescriptor: "()V", accessFlags: 1, isSynthetic: false }
        ],
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
        "import org.spongepowered.asm.mixin.injection.Inject;",
        "import org.spongepowered.asm.mixin.injection.At;",
        "",
        "@Mixin(Main.class)",
        "public abstract class MainMixin {",
        "  @Inject(method = \"tick\", at = @At(\"HEAD\"))",
        "  private void onTick() {}",
        "}"
      ].join("\n")
    },
    version: "1.21",
    mapping: "mojang",
    reportMode: "compact"
  });

  const single = result.results[0]?.result;
  assert.ok(single?.warnings.some((w) => w.includes("Retrying validate-mixin with sourcePriority")));
  assert.equal(single?.toolHealth, undefined);
  assert.ok(single?.quickSummary);
  assert.match(single!.quickSummary!, /Mapping health degraded/);
  assert.match(single!.quickSummary!, /Mojang mappings unavailable after retry/);
});

test("SourceService validateMixin preserves mapping-health quickSummary note even when reportMode='compact' clears toolHealth", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-qs-compact-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});
  const service = new SourceService(buildTestConfig(root));

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
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        degradations: ["Mojang mappings unavailable"]
      };
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
        "",
        "@Mixin(Main.class)",
        "public abstract class MainMixin {}"
      ].join("\n")
    },
    version: "1.21",
    mapping: "obfuscated",
    reportMode: "compact"
  });

  const single = result.results[0]?.result;
  assert.equal(single?.toolHealth, undefined);
  assert.ok(single?.quickSummary);
  assert.match(single!.quickSummary!, /Mapping health degraded/);
  assert.match(single!.quickSummary!, /Mojang mappings unavailable/);
});

test("SourceService validateMixin quickSummary surfaces vanilla fallback after scope resolution failure", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-qs-fallback-"));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {});
  const service = new SourceService(buildTestConfig(root));

  (service as any).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as any).resolveArtifact = async () => {
    throw new Error("Loom cache empty");
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
        "",
        "@Mixin(Main.class)",
        "public abstract class MainMixin {}"
      ].join("\n")
    },
    version: "1.21",
    mapping: "obfuscated",
    scope: "merged",
    projectPath: root
  });

  const single = result.results[0]?.result;
  assert.ok(single?.quickSummary);
  assert.match(single!.quickSummary!, /Scope fell back from "merged" to "vanilla"/);
  assert.match(single!.quickSummary!, /Loom cache empty/);
});
