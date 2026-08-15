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
