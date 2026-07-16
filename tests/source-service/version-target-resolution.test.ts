import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("SourceService resolves version target through manifest and downloads client jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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

test("SourceService prefers explicit gradleUserHome over stale process GRADLE_USER_HOME source jars", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-explicit-gradle-home-source-"));
  const defaultGradleUserHome = join(root, "default-gradle-home");
  const explicitGradleUserHome = join(root, "explicit-gradle-home");
  const defaultLoomDir = join(defaultGradleUserHome, "caches", "fabric-loom", "1.21.10");
  const explicitLoomDir = join(explicitGradleUserHome, "caches", "fabric-loom", "1.21.10");
  const staleSourceJarPath = join(defaultLoomDir, "minecraft-merged-1.21.10-sources.jar");
  const exactSourceJarPath = join(explicitLoomDir, "minecraft-merged-1.21.10-sources.jar");
  const versionJarPath = join(root, "client-1.21.10.jar");

  await mkdir(defaultLoomDir, { recursive: true });
  await mkdir(explicitLoomDir, { recursive: true });
  await createJar(staleSourceJarPath, {
    "net/minecraft/world/level/block/Blocks.java": [
      "package net.minecraft.world.level.block;",
      "public class Blocks { public static final String SOURCE = \"stale\"; }"
    ].join("\n")
  });
  await createJar(exactSourceJarPath, {
    "net/minecraft/world/level/block/Blocks.java": [
      "package net.minecraft.world.level.block;",
      "public class Blocks { public static final String SOURCE = \"explicit\"; }"
    ].join("\n")
  });
  await createJar(versionJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
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

  const resolved = await withGradleUserHome(defaultGradleUserHome, () =>
    service.resolveArtifact({
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      gradleUserHome: explicitGradleUserHome
    } as any)
  );

  assert.equal(resolved.resolvedSourceJarPath, exactSourceJarPath);
  assert.ok(
    resolved.warnings.some((warning) => warning.includes(exactSourceJarPath)),
    `Expected warning to mention explicit source jar, got ${JSON.stringify(resolved.warnings)}`
  );
});

test("SourceService resolveArtifact marks merged mojang sources without net.minecraft coverage as partial", { concurrency: false }, async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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

test("SourceService ignores projectPath Loom source discovery for obfuscated mapping", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  // Disable the mojang binary-remap gate so the test still exercises the
  // candidate-artifact MAPPING_NOT_APPLIED path. Without this stub the gate
  // would proceed to tiny-remap the fake version jar and fail with REMAP_FAILED.
  const existingMappingService = (service as unknown as { mappingService: Record<string, unknown> }).mappingService;
  (service as unknown as { mappingService: Record<string, unknown> }).mappingService = {
    ...existingMappingService,
    async checkMappingHealth() {
      return {
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        degradations: ["test stub: mojang mappings disabled"]
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
  const { SourceService } = await import("../../src/source-service.ts");
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

test("SourceService rejects mojang binary-remap on jar inputs because the gate is restricted to target.kind=\"version\"", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-jar-mojang-gate-"));
  // A bare binary-only jar at an arbitrary path — the resolver cannot prove this
  // is the vanilla Minecraft client jar. The resolver must refuse to apply Minecraft
  // mappings to non-version artifacts even when the requested mapping is mojang.
  const localBinaryJarPath = join(root, "somelib-1.21.10.jar");
  await createJar(localBinaryJarPath, {
    "com/example/Lib.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  // Force checkMappingHealth to report mojang available so the gate failure is
  // proven to come from the target.kind restriction, not from an unrelated
  // mapping-health probe.
  const existingMappingService = (service as unknown as { mappingService: Record<string, unknown> }).mappingService;
  (service as unknown as { mappingService: Record<string, unknown> }).mappingService = {
    ...existingMappingService,
    async checkMappingHealth() {
      return {
        mojangMappingsAvailable: true,
        tinyMappingsAvailable: true,
        memberRemapAvailable: true,
        degradations: []
      };
    }
  };

  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: {
          kind: "jar",
          value: localBinaryJarPath
        },
        mapping: "mojang",
        allowDecompile: true
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
