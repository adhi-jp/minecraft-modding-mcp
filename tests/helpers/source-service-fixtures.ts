// Fixtures and helpers factored out of tests/source-service.test.ts when that
// large suite was split into per-feature test files. These build SourceService
// instances over temp-dir jars, accounting-repo instrumentation, and a
// version-approximation fixture that overrides globalThis.fetch.
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/types.ts";
import { buildTestConfig } from "./test-config.ts";
import { createJar } from "./zip.ts";

export async function createResolvedSearchFixture(input: {
  rootPrefix: string;
  jarBaseName: string;
  sourceEntries: Record<string, string>;
  binaryEntries?: Record<string, Buffer>;
  configOverrides?: Partial<Config>;
  mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
}): Promise<{
  service: InstanceType<(typeof import("../../src/source-service.ts"))["SourceService"]>;
  resolved: Awaited<ReturnType<InstanceType<(typeof import("../../src/source-service.ts"))["SourceService"]>["resolveArtifact"]>>;
}> {
  const { SourceService } = await import("../../src/source-service.ts");
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

export type SearchFixture = Awaited<ReturnType<typeof createResolvedSearchFixture>>;
export type SourceServiceFixture = InstanceType<
  (typeof import("../../src/source-service.ts"))["SourceService"]
>;
export type SearchClassSourceCaseInput = Omit<
  Parameters<SearchFixture["service"]["searchClassSource"]>[0],
  "artifactId"
>;
export type SearchClassSourceCaseResult = Awaited<
  ReturnType<SearchFixture["service"]["searchClassSource"]>
>;

export type CacheFixtureArtifactInput = {
  jarBaseName: string;
  sourceEntries: Record<string, string>;
  binaryEntries?: Record<string, Buffer>;
};

export type CacheFixtureArtifact = {
  jarPath: string;
  expectedContentBytes: number;
  sourceEntries: Record<string, string>;
};

export type CacheAccountingRepo = {
  countArtifacts: () => number;
  totalContentBytes: () => number;
  listArtifactsByLruWithContentBytes: (
    limit: number
  ) => Array<{ artifactId: string; totalContentBytes: number; updatedAt: string }>;
};

export function computeSourceEntriesBytes(sourceEntries: Record<string, string>): number {
  return Object.values(sourceEntries).reduce(
    (total, content) => total + Buffer.byteLength(content, "utf8"),
    0
  );
}

export function defaultBinaryEntriesFor(sourceEntries: Record<string, string>): Record<string, Buffer> {
  const [firstSourcePath] = Object.keys(sourceEntries);
  const defaultClassPath =
    firstSourcePath?.replace(/\.java$/, ".class") ?? "net/minecraft/server/Main.class";
  return {
    [defaultClassPath]: Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  };
}

export async function createCacheAccountingFixture(input: {
  rootPrefix: string;
  configOverrides?: Partial<Config>;
  artifacts: CacheFixtureArtifactInput[];
}): Promise<{
  service: SourceServiceFixture;
  artifacts: CacheFixtureArtifact[];
}> {
  const { SourceService } = await import("../../src/source-service.ts");
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

export function instrumentCacheAccountingRepo(service: SourceServiceFixture): {
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

export async function withVersionApproximationFixture(
  input: {
    rootPrefix: string;
    requestedVersion: string;
    loomSourceVersion: string;
  },
  run: (args: { service: SourceServiceFixture; projectPath: string }) => Promise<void>
): Promise<void> {
  const { SourceService } = await import("../../src/source-service.ts");
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
