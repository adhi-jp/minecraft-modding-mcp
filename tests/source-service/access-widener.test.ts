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

test("SourceService validateAccessWidener chooses the expected mapping namespace", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

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
    },
    {
      name: "treats the official header namespace as obfuscated, not intermediary",
      rootPrefix: "service-validate-aw-official-",
      run: async ({ mappingCalls, service }) => {
        const result = await (
          service as unknown as {
            validateAccessWidener: (input: {
              content: string;
              version: string;
            }) => Promise<{ valid: boolean; warnings: string[] }>;
          }
        ).validateAccessWidener({
          content: [
            "accessWidener v2 official",
            "accessible class net/minecraft/server/MinecraftServer"
          ].join("\n"),
          version: "1.21.10"
        });

        assert.equal(result.valid, true);
        // "official" == obfuscated == the runtime lookup namespace, so no
        // cross-namespace mapping call is made (vs. the buggy intermediary default).
        assert.deepEqual(mappingCalls, []);
        assert.ok(
          !result.warnings.some((w) => /assuming intermediary|unsupported/i.test(w)),
          `official must not be treated as unsupported, got ${JSON.stringify(result.warnings)}`
        );
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
  const source = await readFile("src/source/artifact-resolver.ts", "utf8");

  assert.doesNotMatch(source, /\(input\.requestedScope === "loader" \? 1_000 : 0\)/);
  assert.doesNotMatch(source, /fastGlob\.sync\("\*\*\/\*\.jar"/);
});

test("SourceService version/runtime discovery blocks avoid sync glob scans on hot paths", async () => {
  const source = await readFile("src/source/artifact-resolver.ts", "utf8");
  const versionSourceBlock =
    source.match(/export async function discoverVersionSourceJar\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";
  const accessWidenerBlock =
    source.match(/export async function discoverAccessWidenerRuntimeCandidates\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";
  const accessTransformerBlock =
    source.match(/export async function discoverAccessTransformerRuntimeCandidates\([\s\S]*?return \{\s*searchedPaths,/m)?.[0] ?? "";

  assert.doesNotMatch(versionSourceBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessWidenerBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessTransformerBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(accessTransformerBlock, /existsSync\(root\)/);
});

test("SourceService validateMixin project/config discovery avoids sync glob and existence probes in discovery blocks", async () => {
  const source = await readFile("src/source/validate-mixin.ts", "utf8");
  const projectBlock =
    source.match(/(?:async )?function createProjectValidateMixinConfigInput\([\s\S]*?return \{\s*\.\.\.input,/m)?.[0] ?? "";
  const configBlock =
    source.match(/async function resolveMixinConfigSources\([\s\S]*?return \{\s*sources: results,/m)?.[0] ?? "";

  assert.doesNotMatch(projectBlock, /fastGlob\.sync\(/);
  assert.doesNotMatch(configBlock, /existsSync\(/);
});

test("SourceService validateAccessWidener resolves merged runtime artifacts and surfaces runtime access evidence", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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

test("SourceService validateAccessWidener remaps class references inside method descriptors", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { detectFabricLikeInputNamespace } = await import("../../src/source-jar-reader.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
  const { SourceService } = await import("../../src/source-service.ts");
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
