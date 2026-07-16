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

test("SourceService listArtifactFiles explains that indexed artifacts do not include resources", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
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
