// Fixtures and helpers factored out of tests/source-service.test.ts when that
// large suite was split into per-feature test files. These build SourceService
// instances over temp-dir jars, accounting-repo instrumentation, and a
// version-approximation fixture that overrides globalThis.fetch. Search-specific
// fixtures live in source-service-search-fixtures.ts.
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/types.ts";
import { withEnv, withGlobalFetch } from "./env.ts";
import { buildTestConfig } from "./test-config.ts";
import { createJar } from "./zip.ts";

export type SourceServiceFixture = InstanceType<
  (typeof import("../../src/source-service.ts"))["SourceService"]
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

/**
 * Replace the service's VersionService with a stub that lists `versions` and
 * resolves each one to `<root>/<version>.jar` as if it had just been downloaded.
 */
export function stubVersionService(service: object, root: string, versions: string[]): void {
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
}

/**
 * Serve a one-release Mojang-style version manifest, its version json and the
 * client jar from `https://example.test`, and point MCP_VERSION_MANIFEST_URL at
 * it for the duration of `body`. fetch and the env var are restored afterwards.
 */
export async function withVersionManifestStub<T>(
  input: {
    version: string;
    clientJarBytes: Buffer;
    jarHeaders?: Record<string, string>;
  },
  body: () => Promise<T>
): Promise<T> {
  const manifestUrl = "https://example.test/version_manifest_v2.json";
  const versionJsonUrl = `https://example.test/versions/${input.version}.json`;
  const clientJarUrl = `https://example.test/downloads/client-${input.version}.jar`;
  const stub = (async (requestInput: string | URL | Request) => {
    const url =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url;
    if (url === manifestUrl) {
      return new Response(
        JSON.stringify({
          latest: { release: input.version },
          versions: [{ id: input.version, type: "release", url: versionJsonUrl }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === versionJsonUrl) {
      return new Response(
        JSON.stringify({
          id: input.version,
          downloads: { client: { url: clientJarUrl } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === clientJarUrl) {
      return new Response(input.clientJarBytes, {
        status: 200,
        ...(input.jarHeaders === undefined ? {} : { headers: input.jarHeaders })
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return withEnv({ MCP_VERSION_MANIFEST_URL: manifestUrl }, () => withGlobalFetch(stub, body));
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

  await withVersionManifestStub(
    { version: input.requestedVersion, clientJarBytes: remoteJarBytes },
    async () => {
      const service = new SourceService(buildTestConfig(root));
      await run({ service, projectPath });
    }
  );
}
