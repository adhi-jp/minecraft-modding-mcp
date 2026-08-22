import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService falls back to binary-backed metadata for workspace class overview when partial sources omit vanilla classes", async () => {
  let checkSymbolExistsCalls = 0;
  let getClassSourceCalls = 0;

  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    findClass: async () => ({
      total: 0,
      warnings: [
        "Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches would be misleading."
      ],
      matches: []
    }),
    checkSymbolExists: async (input) => {
      checkSymbolExistsCalls += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "net.minecraft.world.item.Item");
      assert.equal(input.sourceMapping, "mojang");
      return {
        resolved: true,
        status: "resolved",
        querySymbol: {
          kind: "class",
          name: "net.minecraft.world.item.Item",
          symbol: "net.minecraft.world.item.Item"
        },
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.world.item.Item",
          symbol: "net.minecraft.world.item.Item"
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    getClassSource: async (input) => {
      getClassSourceCalls += 1;
      assert.equal(input.artifactId, "artifact-partial");
      assert.equal(input.className, "net.minecraft.world.item.Item");
      assert.equal(input.mode, "metadata");
      return {
        className: input.className,
        artifactId: "artifact-binary-fallback",
        mode: "metadata",
        totalLines: 240,
        returnedNamespace: "obfuscated",
        warnings: [
          "Falling back to binary artifact \"/cache/minecraft-merged-1.21.10.jar\" because source coverage was incomplete."
        ]
      };
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "class-overview",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "class",
        className: "net.minecraft.world.item.Item"
      }
    }
  });

  assert.equal(checkSymbolExistsCalls, 1);
  assert.equal(getClassSourceCalls, 1);
  assert.equal(result.summary.status, "ok");
  assert.deepEqual(result.subject?.resolved, {
    artifactId: "artifact-binary-fallback",
    className: "net.minecraft.world.item.Item"
  });
  assert.ok(
    result.warnings?.some((warning: string) => warning.includes("binary artifact")),
    "expected binary fallback warning"
  );
});

test("InspectMinecraftService returns binary-backed class hits for workspace search when partial sources omit vanilla matches", async () => {
  let checkSymbolExistsCalls = 0;

  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-search-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    checkSymbolExists: async (input) => {
      checkSymbolExistsCalls += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "CreativeModeTab");
      assert.equal(input.nameMode, "auto");
      return {
        resolved: true,
        status: "resolved",
        querySymbol: {
          kind: "class",
          name: "CreativeModeTab",
          symbol: "CreativeModeTab"
        },
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.world.item.CreativeModeTab",
          symbol: "net.minecraft.world.item.CreativeModeTab"
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    searchClassSource: async () => ({
      hits: [],
      nextCursor: undefined,
      mappingApplied: "mojang",
      returnedNamespace: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      }
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "search",
    detail: "standard",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "search",
        query: "CreativeModeTab"
      }
    }
  });

  assert.equal(checkSymbolExistsCalls, 1);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.search?.hits?.[0]?.filePath, "net/minecraft/world/item/CreativeModeTab.java");
  assert.ok(
    result.search?.hits?.[0]?.reasonCodes?.includes("binary-class-lookup"),
    "expected binary-backed search reason code"
  );
});

test("InspectMinecraftService prepends a binary-backed vanilla class hit when workspace partial-source search only finds non-vanilla matches", async () => {
  let checkSymbolExistsCalls = 0;

  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-search-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    checkSymbolExists: async (input) => {
      checkSymbolExistsCalls += 1;
      assert.equal(input.kind, "class");
      assert.equal(input.name, "CreativeModeTab");
      return {
        resolved: true,
        status: "resolved",
        querySymbol: {
          kind: "class",
          name: "CreativeModeTab",
          symbol: "CreativeModeTab"
        },
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.world.item.CreativeModeTab",
          symbol: "net.minecraft.world.item.CreativeModeTab"
        },
        candidates: [],
        candidateCount: 1,
        warnings: []
      };
    },
    searchClassSource: async () => ({
      hits: [
        {
          filePath: "net/neoforged/neoforge/common/CreativeModeTabRegistry.java",
          score: 91,
          matchedIn: "symbol",
          reasonCodes: ["symbol-exact"],
          symbol: {
            symbolKind: "class",
            symbolName: "CreativeModeTabRegistry",
            qualifiedName: "net.neoforged.neoforge.common.CreativeModeTabRegistry",
            line: 12
          }
        }
      ],
      nextCursor: undefined,
      mappingApplied: "mojang",
      returnedNamespace: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      }
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "search",
    detail: "standard",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "search",
        query: "CreativeModeTab"
      }
    }
  });

  assert.equal(checkSymbolExistsCalls, 1);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.search?.hits?.[0]?.filePath, "net/minecraft/world/item/CreativeModeTab.java");
  assert.ok(
    result.search?.hits?.[0]?.reasonCodes?.includes("binary-class-lookup"),
    "expected binary-backed search hit to be prepended"
  );
  assert.equal(
    result.search?.hits?.[1]?.filePath,
    "net/neoforged/neoforge/common/CreativeModeTabRegistry.java"
  );
});

test("InspectMinecraftService uses the outer source file path for binary-backed inner class search hits", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-search-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    checkSymbolExists: async () => ({
      resolved: true,
      status: "resolved",
      querySymbol: {
        kind: "class",
        name: "Item$Properties",
        symbol: "Item$Properties"
      },
      resolvedSymbol: {
        kind: "class",
        name: "net.minecraft.world.item.Item$Properties",
        symbol: "net.minecraft.world.item.Item$Properties"
      },
      candidates: [],
      candidateCount: 1,
      warnings: []
    }),
    searchClassSource: async () => ({
      hits: [],
      nextCursor: undefined,
      mappingApplied: "mojang",
      returnedNamespace: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      }
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "search",
    detail: "standard",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "search",
        query: "Item$Properties"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.search?.hits?.[0]?.filePath, "net/minecraft/world/item/Item.java");
});

test("InspectMinecraftService skips binary-backed class lookup for lowercase workspace search queries", async () => {
  let checkSymbolExistsCalls = 0;

  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-search-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    checkSymbolExists: async () => {
      checkSymbolExistsCalls += 1;
      throw new Error("not used");
    },
    searchClassSource: async () => ({
      hits: [],
      nextCursor: undefined,
      mappingApplied: "mojang",
      returnedNamespace: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      }
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "search",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "search",
        query: "tickServer"
      }
    }
  });

  assert.equal(checkSymbolExistsCalls, 0);
  assert.equal(result.summary.status, "not_found");
});

test("InspectMinecraftService marks workspace list-files results as partial when source coverage excludes net.minecraft", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => ({
      artifactId: "artifact-files-partial",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: input.mapping,
      mappingApplied: input.mapping ?? "obfuscated",
      version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
      binaryJarPath: "/cache/minecraft-merged-1.21.10.jar",
      provenance: { requestedTarget: input.target },
      qualityFlags: ["source-backed", "partial-source-no-net-minecraft"],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: ["Source coverage does not include net.minecraft."]
    }),
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => ({
      items: ["net/neoforged/neoforge/items/Item.java"],
      nextCursor: undefined,
      mappingApplied: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["java-source"],
        resourcesIncluded: false,
        sourceCoverage: "partial"
      },
      warnings: []
    }),
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "list-files",
    detail: "standard",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true
    }
  });

  assert.equal(result.summary.status, "partial");
  assert.equal(result.files?.coverage?.sourceCoverage, "partial");
  assert.ok(
    result.summary.nextActions?.some((action: { tool?: string }) => action.tool === "inspect-minecraft"),
    "expected follow-up action"
  );
});
