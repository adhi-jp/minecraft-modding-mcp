import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "./helpers/inspect-deps.ts";

test("inspectMinecraftSchema applies defaults while keeping non-version includeSnapshots validation precise", () => {
  const parsedArtifact = inspectMinecraftSchema.parse({
    task: "artifact",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  });
  assert.equal(parsedArtifact.includeSnapshots, false);

  const parsedSearch = inspectMinecraftSchema.parse({
    task: "search",
    subject: {
      kind: "search",
      query: "tickServer"
    }
  });
  if (parsedSearch.subject?.kind !== "search") {
    throw new Error("Expected search subject");
  }
  assert.equal(parsedSearch.subject.queryMode, "auto");

  const parsedWorkspaceSearch = inspectMinecraftSchema.parse({
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      focus: {
        kind: "search",
        query: "tickServer"
      }
    }
  });
  if (parsedWorkspaceSearch.subject?.kind !== "workspace" || parsedWorkspaceSearch.subject.focus?.kind !== "search") {
    throw new Error("Expected workspace search focus");
  }
  assert.equal(parsedWorkspaceSearch.subject.focus.queryMode, "auto");

  assert.throws(
    () => inspectMinecraftSchema.parse({
      task: "artifact",
      includeSnapshots: true,
      subject: {
        kind: "version",
        version: "1.21.10"
      }
    }),
    /includeSnapshots is only supported for task=versions/
  );
});

test("InspectMinecraftService preserves gradleUserHome through schema parsing and artifact resolution", async () => {
  let seenGradleUserHome: string | undefined;
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input: { gradleUserHome?: string }) => {
      seenGradleUserHome = input.gradleUserHome;
      return {
        artifactId: "minecraft-1.21.10",
        artifactAlias: "minecraft-1.21.10",
        origin: "local-jar",
        isDecompiled: false,
        version: "1.21.10",
        requestedMapping: "mojang",
        mappingApplied: "mojang",
        provenance: {
          target: { kind: "version", value: "1.21.10" },
          resolvedAt: new Date().toISOString(),
          resolvedFrom: { origin: "local-jar", version: "1.21.10" },
          transformChain: []
        },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["java"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      } as any;
    }
  }));

  const parsed = inspectMinecraftSchema.parse({
    task: "artifact",
    subject: {
      kind: "version",
      version: "1.21.10",
      mapping: "mojang",
      scope: "merged",
      gradleUserHome: "/tmp/explicit-gradle-home"
    }
  });

  await service.execute(parsed as any);

  assert.equal(seenGradleUserHome, "/tmp/explicit-gradle-home");
});

test("InspectMinecraftService task=versions surfaces the listVersions clamp warning", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    listVersions: async () => ({
      latest: { release: "1.21.10" },
      releases: [{ id: "1.21.10", unobfuscated: true }],
      cached: [],
      totalAvailable: 1,
      warnings: ["limit was clamped to 200 from 100000."]
    })
  }));

  const result = (await service.execute({
    task: "versions",
    detail: "summary",
    limit: 100000
  } as any)) as { warnings?: string[] };

  assert.ok(
    (result.warnings ?? []).some((w) => /limit was clamped to 200 from 100000\./.test(w)),
    "inspect-minecraft task=versions must surface the listVersions clamp warning"
  );
});

test("InspectMinecraftService returns ambiguous class overview with follow-up candidates", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async () => ({
      artifactId: "artifact-1",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      provenance: { requestedTarget: { kind: "jar", value: "/tmp/test.jar" } },
      qualityFlags: [],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["sources"],
        resourcesIncluded: false,
        sourceCoverage: "full"
      },
      warnings: []
    }),
    findClass: async () => ({
      total: 2,
      warnings: [],
      matches: [
        {
          qualifiedName: "net.minecraft.Blocks",
          filePath: "net/minecraft/Blocks.java",
          line: 1,
          symbolKind: "class"
        },
        {
          qualifiedName: "com.example.Blocks",
          filePath: "com/example/Blocks.java",
          line: 1,
          symbolKind: "class"
        }
      ]
    }),
    detectProjectMinecraftVersion: async () => undefined
  }));

  const result = await service.execute({
    task: "class-overview",
    detail: "summary",
    include: ["candidates"],
    subject: {
      kind: "class",
      className: "Blocks",
      artifact: {
        type: "resolved-id",
        artifactId: "artifact-1"
      }
    }
  });

  assert.equal(result.summary.status, "ambiguous");
  assert.equal(result.summary.counts?.matches, 2);
  assert.equal(result.candidates?.length, 2);
});

test("InspectMinecraftService auto routes workspace search focus through project-aware artifact resolution", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  let searchCalls = 0;
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-search",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    searchClassSource: async (input) => {
      searchCalls += 1;
      assert.equal(input.artifactId, "artifact-search");
      assert.equal(input.query, "tickServer");
      assert.equal(input.queryMode, "auto");
      return {
        artifactId: input.artifactId,
        query: input.query,
        hits: [{ filePath: "net/minecraft/server/MinecraftServer.java", score: 120, matchedIn: "content", preview: "tickServer" }],
        nextCursor: "cursor-next-1",
        cursorIgnored: true,
        mappingApplied: "mojang",
        returnedNamespace: "mojang",
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
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

  assert.equal(result.task, "search");
  assert.equal(result.summary.status, "ok");
  assert.equal(searchCalls, 1);
  // Summary mode omits the `search` block, so continuation state must surface in
  // meta.pagination or the caller would stop after the first page.
  assert.equal((result as { search?: unknown }).search, undefined);
  const pagination = (result as { meta?: { pagination?: Record<string, unknown> } }).meta?.pagination;
  assert.equal(pagination?.nextCursor, "cursor-next-1");
  assert.equal(pagination?.hasMore, true);
  assert.equal(pagination?.returnedCount, 1);
  assert.equal(pagination?.cursorIgnored, true);
  assert.deepEqual(result.summary.subject, {
    task: "search",
    query: "tickServer",
    artifactId: "artifact-search"
  });
  // The raw requested subject survives exactly once, in the always-on subject block.
  assert.deepEqual((result as { subject?: { requested?: unknown } }).subject?.requested, {
    kind: "workspace",
    projectPath: "/workspace/demo-mod",
    mapping: "mojang",
    scope: "merged",
    preferProjectVersion: true,
    focus: {
      kind: "search",
      query: "tickServer"
    }
  });
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

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
      version: input.target.value,
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
      version: input.target.value,
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
      version: input.target.value,
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
      version: input.target.value,
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
      version: input.target.value,
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
      version: input.target.value,
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

test("InspectMinecraftService omits includeSnapshots=false from versions summary subject", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    listVersions: async () => ({
      latest: {
        release: "1.21.10",
        snapshot: "25w10a"
      },
      releases: [{ id: "1.21.10", unobfuscated: true }],
      snapshots: [],
      cached: ["1.21.10"],
      totalAvailable: 1
    })
  }));

  const result = await service.execute({
    task: "versions",
    detail: "summary"
  });

  assert.deepEqual(result.summary.subject, {
    task: "versions",
    kind: "versions"
  });
});

test("InspectMinecraftService preserves workspace context for file focus without explicit artifact input", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-file",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    getArtifactFile: async (input) => ({
      artifactId: input.artifactId,
      filePath: input.filePath,
      content: "class Demo {}",
      contentBytes: 13,
      truncated: false,
      mappingApplied: "mojang",
      returnedNamespace: "mojang",
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["sources"],
        resourcesIncluded: false,
        sourceCoverage: "full"
      },
      warnings: []
    }),
    detectProjectMinecraftVersion: async () => "1.21.11"
  }));

  const result = await service.execute({
    task: "file",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "file",
        filePath: "net/minecraft/server/MinecraftServer.java"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "version", value: "1.21.11" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService preserves workspace context for class overview without explicit artifact input", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-class-overview",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    findClass: async (input) => {
      assert.equal(input.artifactId, "artifact-class-overview");
      assert.equal(input.className, "net.minecraft.server.MinecraftServer");
      return {
        total: 1,
        warnings: [],
        matches: [
          {
            qualifiedName: "net.minecraft.server.MinecraftServer",
            filePath: "net/minecraft/server/MinecraftServer.java",
            line: 1,
            symbolKind: "class"
          }
        ]
      };
    },
    getClassSource: async (input) => {
      assert.equal(input.artifactId, "artifact-class-overview");
      assert.equal(input.className, "net.minecraft.server.MinecraftServer");
      assert.equal(input.mode, "metadata");
      return {
        className: input.className,
        artifactId: input.artifactId ?? "artifact-class-overview",
        mode: "metadata",
        totalLines: 400,
        returnedNamespace: "mojang",
        warnings: []
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
        className: "net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService preserves workspace context for class source without explicit artifact input", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-class-source",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    getClassSource: async (input) => {
      assert.equal(input.artifactId, "artifact-class-source");
      assert.equal(input.className, "net.minecraft.server.MinecraftServer");
      assert.equal(input.mode, "metadata");
      return {
        className: input.className,
        artifactId: input.artifactId ?? "artifact-class-source",
        mode: "metadata",
        totalLines: 410,
        returnedRange: undefined,
        returnedNamespace: "mojang",
        warnings: []
      };
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "class-source",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "class",
        className: "net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  // summary.subject is a compact resolved identity: no echoed `requested` block.
  assert.equal((result.summary.subject as Record<string, unknown>).requested, undefined);
  assert.deepEqual(result.summary.subject, {
    task: "class-source",
    className: "net.minecraft.server.MinecraftServer",
    artifactId: "artifact-class-source"
  });
  // The raw requested subject still survives once, in the always-on subject block.
  assert.deepEqual((result as { subject?: { requested?: unknown } }).subject?.requested, {
    kind: "workspace",
    projectPath: "/workspace/demo-mod",
    mapping: "mojang",
    scope: "merged",
    preferProjectVersion: true,
    focus: {
      kind: "class",
      className: "net.minecraft.server.MinecraftServer"
    }
  });
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService accepts workspace class focus for class-members", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-class-members",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    getClassMembers: async (input) => {
      assert.equal(input.artifactId, "artifact-class-members");
      assert.equal(input.className, "net.minecraft.server.MinecraftServer");
      return {
        className: input.className,
        artifactId: input.artifactId ?? "artifact-class-members",
        counts: {
          total: 1,
          constructors: 0,
          methods: 1,
          fields: 0
        },
        truncated: false,
        members: [
          {
            kind: "method",
            signature: "tickServer()V",
            display: "void tickServer()"
          }
        ],
        returnedNamespace: "mojang",
        warnings: []
      };
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    task: "class-members",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "class",
        className: "net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService forwards include:[\"descriptors\"] to getClassMembers as includeDescriptors", async () => {
  const seen: Array<{ includeDescriptors?: boolean }> = [];
  const makeDeps = () => buildInspectDeps({
    resolveArtifact: async () => ({
      artifactId: "artifact-desc",
      origin: "local-jar" as const,
      isDecompiled: false,
      mappingApplied: "obfuscated" as const,
      version: "1.21.10",
      provenance: {},
      qualityFlags: [],
      artifactContents: { sourceKind: "source-jar" as const, indexedContentKinds: ["sources"], resourcesIncluded: false, sourceCoverage: "full" as const },
      warnings: []
    }),
    getClassMembers: async (input: { includeDescriptors?: boolean }) => {
      seen.push({ includeDescriptors: input.includeDescriptors });
      return {
        className: "com.example.Widget",
        artifactId: "artifact-desc",
        counts: { total: 0, constructors: 0, methods: 0, fields: 0 },
        truncated: false,
        members: { constructors: [], fields: [], methods: [] },
        returnedNamespace: "obfuscated",
        warnings: []
      };
    }
  });

  const subject = { kind: "class" as const, className: "com.example.Widget", artifact: { type: "resolved-id" as const, artifactId: "artifact-desc" } };

  await new InspectMinecraftService(makeDeps()).execute({ task: "class-members", detail: "full", subject });
  await new InspectMinecraftService(makeDeps()).execute({ task: "class-members", detail: "full", include: ["descriptors"], subject });

  assert.equal(seen[0]!.includeDescriptors, false, "default omits field descriptors");
  assert.equal(seen[1]!.includeDescriptors, true, "include:[descriptors] opts field descriptors back in");
});
