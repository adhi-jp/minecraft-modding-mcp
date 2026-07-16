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

test("SourceService getClassSource remaps partial-source binary fallback lookups to the fallback artifact namespace", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-partial-fallback-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");
  const provenance = {
    target: { kind: "version", value: "1.21.10" },
    resolvedAt: new Date().toISOString(),
    resolvedFrom: {
      origin: "local-jar",
      sourceJarPath,
      binaryJarPath,
      version: "1.21.10"
    },
    transformChain: ["mapping:mojang-source-backed"]
  };

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance,
    files: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        content: [
          "package net.neoforged.neoforge.capabilities;",
          "public class Capabilities {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        symbolKind: "class",
        symbolName: "Capabilities",
        qualifiedName: "net.neoforged.neoforge.capabilities.Capabilities",
        line: 2
      }
    ]
  });

  seedIndexedArtifact(service, {
    artifactId: "binary-fallback",
    origin: "decompiled",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    qualityFlags: ["decompiled", "binary-fallback"],
    version: "1.21.10",
    binaryJarPath,
    provenance,
    isDecompiled: true,
    files: [
      {
        filePath: "dhl.java",
        content: [
          "public class dhl {",
          "  void use() {}",
          "}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "dhl.java",
        symbolKind: "class",
        symbolName: "dhl",
        qualifiedName: "dhl",
        line: 1
      }
    ]
  });

  (service as unknown as { resolveBinaryFallbackArtifact: unknown }).resolveBinaryFallbackArtifact = async () => ({
    artifactId: "binary-fallback",
    artifactSignature: "binary-fallback-sig",
    origin: "decompiled" as const,
    binaryJarPath,
    version: "1.21.10",
    requestedMapping: "mojang" as const,
    mappingApplied: "obfuscated" as const,
    provenance,
    qualityFlags: ["decompiled", "binary-fallback"],
    isDecompiled: true,
    resolvedAt: new Date().toISOString()
  });

  const mappingCalls: Array<Record<string, unknown>> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async findMapping(input: Record<string, unknown>) {
      mappingCalls.push(input);
      if (
        input.kind === "class" &&
        input.name === "net.minecraft.world.item.Item" &&
        input.sourceMapping === "mojang" &&
        input.targetMapping === "obfuscated"
      ) {
        return {
          resolved: true,
          status: "resolved",
          resolvedSymbol: { name: "dhl" },
          candidates: [],
          warnings: []
        };
      }
      return { resolved: false, status: "not_found", candidates: [], warnings: [] };
    }
  };

  const result = await service.getClassSource({
    artifactId: "partial-source",
    className: "net.minecraft.world.item.Item"
  });

  assert.equal(result.artifactId, "binary-fallback");
  assert.match(result.sourceText, /class dhl/);
  assert.ok(result.qualityFlags.includes("binary-fallback"));
  assert.ok(result.warnings.some((warning) => warning.includes("Falling back to binary artifact")));
  assert.ok(mappingCalls.some((call) => call.name === "net.minecraft.world.item.Item"));
});

test("SourceService getClassSource reports partial-source fallback failures without redirecting to find-class", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-class-source-partial-failure-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");
  const provenance = {
    target: { kind: "version", value: "1.21.10" },
    resolvedAt: new Date().toISOString(),
    resolvedFrom: {
      origin: "local-jar",
      sourceJarPath,
      binaryJarPath,
      version: "1.21.10"
    },
    transformChain: ["mapping:mojang-source-backed"]
  };

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance,
    files: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        content: [
          "package net.neoforged.neoforge.capabilities;",
          "public class Capabilities {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/capabilities/Capabilities.java",
        symbolKind: "class",
        symbolName: "Capabilities",
        qualifiedName: "net.neoforged.neoforge.capabilities.Capabilities",
        line: 2
      }
    ]
  });

  (service as unknown as { resolveBinaryFallbackArtifact: unknown }).resolveBinaryFallbackArtifact = async () => undefined;

  await assert.rejects(
    service.getClassSource({
      artifactId: "partial-source",
      className: "net.minecraft.world.item.Item"
    }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.equal(error !== null && "code" in error ? (error as { code: string }).code : undefined, ERROR_CODES.CLASS_NOT_FOUND);
      const details = error && typeof error === "object" && "details" in error
        ? (error as { details?: Record<string, unknown> }).details
        : undefined;
      assert.equal(details?.suggestedCall && typeof details.suggestedCall === "object"
        ? (details.suggestedCall as { tool?: string }).tool
        : undefined, "get-class-api-matrix");
      assert.match(String(details?.nextAction ?? ""), /binary fallback/i);
      assert.ok(Array.isArray(details?.qualityFlags));
      assert.ok((details?.qualityFlags as unknown[]).includes("partial-source-no-net-minecraft"));
      return true;
    }
  );
});

test("SourceService findClass suppresses misleading non-vanilla matches for partial-source vanilla lookups", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-findclass-partial-vanilla-"));
  const service = new SourceService(buildTestConfig(root));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  seedIndexedArtifact(service, {
    artifactId: "partial-source",
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
    version: "1.21.10",
    sourceJarPath,
    binaryJarPath,
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: {
        origin: "local-jar",
        sourceJarPath,
        binaryJarPath,
        version: "1.21.10"
      },
      transformChain: ["mapping:mojang-source-backed"]
    },
    files: [
      {
        filePath: "net/neoforged/neoforge/items/Item.java",
        content: [
          "package net.neoforged.neoforge.items;",
          "public class Item {}"
        ].join("\n")
      }
    ],
    symbols: [
      {
        filePath: "net/neoforged/neoforge/items/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: "net.neoforged.neoforge.items.Item",
        line: 2
      }
    ]
  });

  const result = service.findClass({
    artifactId: "partial-source",
    className: "Item",
    limit: 10
  });

  assert.equal(result.total, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("partial") && warning.includes("net.minecraft")));
});
