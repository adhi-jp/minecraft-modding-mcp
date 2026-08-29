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
import {
  type SourceServiceFixture,
  withVersionApproximationFixture
} from "../helpers/source-service-fixtures.ts";

test("SourceService resolveArtifact returns sampleEntries for source JAR", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
    includeSampleEntries: true
  });

  assert.ok(resolved.sampleEntries);
  assert.ok(resolved.sampleEntries.length >= 2);
  assert.ok(resolved.sampleEntries.some((entry: string) => entry.endsWith(".java")));
});

test("SourceService resolveArtifact returns undefined sampleEntries for decompile-only", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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

test("resolveArtifact preserves representative suggestedCall hint variants", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

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

test("resolveArtifact flags representative version-approximated mismatches", { concurrency: false }, async (t) => {
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

test("resolveArtifact handles strictVersion for approximated version results", { concurrency: false }, async (t) => {
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

test("target.kind=jar preserves ERR_JAR_NOT_FOUND across representative entry points", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

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

test("resolveArtifact does not warn that a dependency mapping is unenforced when a source-backed jar satisfies it", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-dependency-source-backed-"));
  const sourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "depdemo",
    "2.0.0",
    "depdemo-2.0.0-sources.jar"
  );
  await createJar(sourceJarPath, {
    "com/example/Depdemo.java": ["package com.example;", "public class Depdemo {}"].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "dependency", group: "com.example", name: "depdemo", version: "2.0.0" },
    mapping: "mojang"
  } as any);

  assert.equal(resolved.requestedMapping, "mojang");
  assert.equal(resolved.mappingApplied, "mojang");
  assert.ok(
    resolved.qualityFlags.includes("source-backed"),
    `Expected source-backed flag, got: ${JSON.stringify(resolved.qualityFlags)}`
  );
  assert.ok(!resolved.qualityFlags.includes("dependency-mapping-unverified"));
  assert.ok(
    resolved.warnings.every((w: string) => !w.includes("is not enforced")),
    `Did not expect an unenforced-mapping warning, got: ${JSON.stringify(resolved.warnings)}`
  );
});

test("resolveArtifact warns and reports obfuscated mapping when a dependency has no source-backed jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-dependency-binary-only-"));
  const binaryJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "depbinary",
    "3.0.0",
    "depbinary-3.0.0.jar"
  );
  await createJar(binaryJarPath, {
    "com/example/DepBinary.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  // This branch resolves to an undecompiled binary-only artifact (mapping falls
  // back to "obfuscated" before ingestion), so real decompiling is never needed
  // for the assertions below; stub it out the same way coordinate-mapping.test.ts
  // does for its decompile-adjacent case, to keep this test hermetic.
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};
  const resolved = await service.resolveArtifact({
    target: { kind: "dependency", group: "com.example", name: "depbinary", version: "3.0.0" },
    mapping: "mojang"
  } as any);

  assert.equal(resolved.requestedMapping, "mojang");
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.ok(
    resolved.qualityFlags.includes("dependency-mapping-unverified"),
    `Expected dependency-mapping-unverified flag, got: ${JSON.stringify(resolved.qualityFlags)}`
  );
  assert.ok(
    resolved.warnings.some(
      (w: string) => w.includes("is not enforced") && w.includes("dependency-mapping-unverified")
    ),
    `Expected an unenforced-mapping warning, got: ${JSON.stringify(resolved.warnings)}`
  );
});

test("resolveArtifact does not read a dependency's own coordinate version as an unobfuscated Minecraft runtime", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-dependency-unobf-version-"));
  // 26.0.2 parses as a modern (unobfuscated) Minecraft version, but it is this
  // library's own release number and says nothing about Minecraft's namespace.
  // Reading it as one used to short-circuit the mapping pipeline into reporting
  // mappingApplied="mojang" with no remap, no verification and no warning.
  const binaryJarPath = join(
    root,
    "m2",
    "org",
    "jetbrains",
    "annotations",
    "26.0.2",
    "annotations-26.0.2.jar"
  );
  await createJar(binaryJarPath, {
    "org/jetbrains/annotations/NotNull.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};
  const resolved = await service.resolveArtifact({
    target: { kind: "dependency", group: "org.jetbrains", name: "annotations", version: "26.0.2" },
    mapping: "mojang"
  } as any);

  assert.equal(resolved.requestedMapping, "mojang");
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.ok(
    resolved.qualityFlags.includes("dependency-mapping-unverified"),
    `Expected dependency-mapping-unverified flag, got: ${JSON.stringify(resolved.qualityFlags)}`
  );
  assert.ok(
    resolved.warnings.some(
      (w: string) => w.includes("is not enforced") && w.includes("dependency-mapping-unverified")
    ),
    `Expected an unenforced-mapping warning, got: ${JSON.stringify(resolved.warnings)}`
  );
  assert.ok(
    resolved.warnings.every((w: string) => !w.includes("is unobfuscated")),
    `A dependency version must never be described as an unobfuscated Minecraft version, got: ${JSON.stringify(resolved.warnings)}`
  );
});

test("resolveArtifact does not read a direct coordinate's own version as an unobfuscated Minecraft runtime", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-coordinate-unobf-version-"));
  const binaryJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "libunobf",
    "26.0.2",
    "libunobf-26.0.2.jar"
  );
  await createJar(binaryJarPath, {
    "com/example/LibUnobf.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};

  // A coordinate reached directly (not via the kind="dependency" sugar) gets the
  // same treatment: a binary-only artifact cannot guarantee mojang, so this must
  // fail loudly rather than pass through on a version that merely looks like a
  // modern Minecraft release. Identical to how a sub-26 coordinate already behaves.
  await assert.rejects(
    service.resolveArtifact({
      target: { kind: "coordinate", value: "com.example:libunobf:26.0.2" },
      mapping: "mojang"
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.MAPPING_NOT_APPLIED);
      return true;
    }
  );
});

test("resolveArtifact still reads a net.minecraft coordinate's version as a real Minecraft version", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-coordinate-minecraft-group-"));
  const binaryJarPath = join(root, "m2", "net", "minecraft", "client", "26.1", "client-26.1.jar");
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};

  // The counterexample to the two tests above: net.minecraft:client:26.1 really is
  // the Minecraft runtime artifact, so its version segment really is a Minecraft
  // version and the unobfuscated-runtime pass-through still applies.
  const resolved = await service.resolveArtifact({
    target: { kind: "coordinate", value: "net.minecraft:client:26.1" },
    mapping: "mojang"
  });

  assert.equal(resolved.requestedMapping, "mojang");
  assert.equal(resolved.mappingApplied, "mojang");
  assert.ok(
    !resolved.qualityFlags.includes("dependency-mapping-unverified"),
    `Expected no dependency-mapping-unverified flag, got: ${JSON.stringify(resolved.qualityFlags)}`
  );
});

test(
  "resolveArtifact still treats a genuine unobfuscated Minecraft version target as unobfuscated",
  { concurrency: false },
  async () => {
    const { SourceService } = await import("../../src/source-service.ts");
    const root = await mkdtemp(join(tmpdir(), "service-version-unobfuscated-"));
    const remoteJarPath = join(root, "remote-client.jar");
    // A .java entry keeps this hermetic: the artifact resolves source-backed, so
    // no decompiler download is needed for the assertions below.
    await createJar(remoteJarPath, {
      "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
    });
    const remoteJarBytes = await readFile(remoteJarPath);

    const originalFetch = globalThis.fetch;
    const originalManifestUrl = process.env.MCP_VERSION_MANIFEST_URL;
    process.env.MCP_VERSION_MANIFEST_URL = "https://example.test/version_manifest_v2.json";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/version_manifest_v2.json") {
        return new Response(
          JSON.stringify({
            latest: { release: "26.1" },
            versions: [
              { id: "26.1", type: "release", url: "https://example.test/versions/26.1.json" }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://example.test/versions/26.1.json") {
        return new Response(
          JSON.stringify({
            id: "26.1",
            downloads: { client: { url: "https://example.test/downloads/client-26.1.jar" } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://example.test/downloads/client-26.1.jar") {
        return new Response(remoteJarBytes, {
          status: 200,
          headers: { "content-length": String(remoteJarBytes.byteLength), etag: "mc-26-1" }
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const service = new SourceService(buildTestConfig(root));
      const resolved = await service.resolveArtifact({
        target: { kind: "version", value: "26.1" },
        mapping: "yarn"
      });

      // yarn is relabelled to the obfuscated namespace only when the runtime is
      // known to ship unobfuscated names, so this pins runtimeNamesUnobfuscated
      // still being true for a real Minecraft version target.
      assert.equal(resolved.mappingApplied, "obfuscated");
      assert.ok(
        resolved.warnings.some(
          (w: string) =>
            w.includes("Version 26.1 is unobfuscated") &&
            w.includes("yarn mappings are not applicable")
        ),
        `Expected the unobfuscated-runtime downgrade warning, got: ${JSON.stringify(resolved.warnings)}`
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalManifestUrl === undefined) {
        delete process.env.MCP_VERSION_MANIFEST_URL;
      } else {
        process.env.MCP_VERSION_MANIFEST_URL = originalManifestUrl;
      }
    }
  }
);
