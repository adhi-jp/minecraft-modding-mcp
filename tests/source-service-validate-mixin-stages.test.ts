import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { withGradleUserHome } from "./helpers/env.ts";
import { seedIndexedArtifact } from "./helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "./helpers/source-service-metrics.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

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

test("SourceService validateMixin tags failedStage='input-validation' across malformed-input triggers", async (t) => {
  const { SourceService } = await import("../src/source-service.ts");

  type ValidateMixinArgs = Parameters<InstanceType<typeof SourceService>["validateMixin"]>[0];
  const cases: Array<{
    name: string;
    messageMatch?: RegExp;
    prepare: (root: string) => Promise<ValidateMixinArgs>;
  }> = [
    {
      name: "version is empty",
      prepare: async () => ({
        input: { mode: "inline", source: "@Mixin(Main.class) public class X {}" },
        version: "   ",
        mapping: "obfuscated"
      })
    },
    {
      name: "source is empty",
      prepare: async () => ({
        input: { mode: "inline", source: "   " },
        version: "1.21",
        mapping: "obfuscated"
      })
    },
    {
      name: "project mode finds no mixin configs",
      prepare: async (root) => ({
        input: { mode: "project", path: root },
        version: "1.21",
        mapping: "obfuscated"
      })
    },
    {
      name: "project mode cannot detect a version",
      messageMatch: /could not detect a minecraft version/i,
      prepare: async (root) => ({
        input: { mode: "project", path: root },
        mapping: "obfuscated"
      })
    },
    {
      name: "a mixin config JSON is malformed",
      prepare: async (root) => {
        const configPath = join(root, "broken.mixins.json");
        await writeFile(configPath, "{ this is not json", "utf8");
        return {
          input: { mode: "config", configPaths: [configPath] },
          version: "1.21",
          mapping: "obfuscated"
        };
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "validate-mixin-stage-input-"));
      const service = new SourceService(buildTestConfig(root));
      const args = await testCase.prepare(root);
      await assert.rejects(
        () => service.validateMixin(args),
        (err: unknown) => {
          const appError = err as { code?: string; message?: string; details?: Record<string, unknown> };
          assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
          assert.equal(appError.details?.failedStage, "input-validation");
          if (testCase.messageMatch) {
            assert.match(appError.message ?? "", testCase.messageMatch);
          }
          return true;
        }
      );
    });
  }
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
    mapping: "obfuscated",
    reportMode: "full"
  });

  const single = result.results[0]?.result;
  assert.ok(single?.toolHealth);
  assert.equal(single!.toolHealth!.overallHealthy, false);
  assert.ok(single!.toolHealth!.degradations.some((d) => d.includes("Mapping health probe failed")));
  assert.ok(single?.quickSummary);
  assert.match(single!.quickSummary!, /Mapping health degraded/);
  assert.match(single!.quickSummary!, /mapping graph download timed out/);
});

test("SourceService validateMixin detects the version from gradle.properties in project mode without an explicit version", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-detect-gradle-"));
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21\n", "utf8");
  const service = new SourceService(buildTestConfig(root));

  // With a detectable version, the dispatcher gets past version resolution and
  // fails later on the absent mixin configs — not on a missing version.
  await assert.rejects(
    () => service.validateMixin({
      input: { mode: "project", path: root },
      mapping: "obfuscated"
    }),
    (err: unknown) => {
      const appError = err as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(appError.details?.failedStage, "input-validation");
      assert.match(appError.message ?? "", /no mixin config json files/i);
      assert.doesNotMatch(appError.message ?? "", /could not detect a minecraft version/i);
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

test("SourceService validateMixin reportMode='compact' keeps resolutionTrace when explain=true", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-compact-explain-trace-"));
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
    reportMode: "compact",
    explain: true
  });

  const single = result.results[0]?.result;
  // compact strips the heavy arrays...
  assert.equal(single?.resolvedMembers, undefined);
  assert.equal(single?.toolHealth, undefined);
  // ...but explain=true keeps the resolutionTrace so the diagnostic opt-in still works.
  assert.ok((single?.provenance?.resolutionTrace?.length ?? 0) >= 1, "explain must preserve resolutionTrace under compact");
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
