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

test("SourceService validateMixin reuses class mapping lookups across batch entries", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
