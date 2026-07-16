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
import { type SourceServiceFixture } from "../helpers/source-service-fixtures.ts";

test("SourceService validateMixin handles representative scope and mapping resolution flows", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

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
            mapping: "obfuscated",
            reportMode: "full"
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
          projectPath: root,
          reportMode: "full"
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
          mapping: "mojang",
          reportMode: "full"
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
          projectPath: root,
          reportMode: "full"
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
  const { SourceService } = await import("../../src/source-service.ts");

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
          projectPath: root,
          reportMode: "full"
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
          projectPath: root,
          reportMode: "full"
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
  const { SourceService } = await import("../../src/source-service.ts");

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
    },
    {
      name: "default reportMode (summary-first) strips per-result resolvedMembers/toolHealth",
      rootPrefix: "service-validate-mixin-default-strip-",
      run: async ({ root, service }) => {
        (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) => ({
          ...buildSummaryFirstSingleResult(root, sourcePath, { warning: "Shared validation warning" }),
          resolvedMembers: [{ target: "tick", annotation: "@Inject", status: "resolved", resolvedTo: "m_1", descriptor: "()V" }],
          toolHealth: { overallHealthy: true, degradations: [], tinyMappingsAvailable: true }
        });

        // No reportMode => service-level default of summary-first applies.
        const result = await service.validateMixin({
          input: { mode: "inline", source: "class M {}" },
          version: "1.21",
          mapping: "mojang"
        } as never);

        const single = result.results[0]?.result;
        assert.equal(single?.resolvedMembers, undefined);
        assert.equal(single?.toolHealth, undefined);
        // summary + issues still surface.
        assert.equal(result.summary.total, 1);
        assert.ok((single?.issues?.length ?? 0) >= 1);
      }
    },
    {
      name: "explain=true keeps per-result resolvedMembers/toolHealth under the summary-first default",
      rootPrefix: "service-validate-mixin-default-explain-",
      run: async ({ root, service }) => {
        (service as any).validateMixinSingle = async ({ sourcePath }: { sourcePath?: string }) => ({
          ...buildSummaryFirstSingleResult(root, sourcePath, { warning: "Shared validation warning" }),
          resolvedMembers: [{ target: "tick", annotation: "@Inject", status: "resolved", resolvedTo: "m_1", descriptor: "()V" }],
          toolHealth: { overallHealthy: true, degradations: [], tinyMappingsAvailable: true }
        });

        // summary-first default + explain keeps the heavy per-result detail.
        const result = await service.validateMixin({
          input: { mode: "inline", source: "class M {}" },
          version: "1.21",
          mapping: "mojang",
          explain: true
        } as never);

        const single = result.results[0]?.result;
        assert.ok(single?.resolvedMembers, "explain keeps resolvedMembers under summary-first");
        assert.ok(single?.toolHealth, "explain keeps toolHealth under summary-first");
        // The shared resolutionTrace is hoisted to the top level.
        assert.ok((result.provenance?.resolutionTrace?.length ?? 0) >= 1);
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
  const { SourceService } = await import("../../src/source-service.ts");

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
