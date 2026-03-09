import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { AnalyzeModService } from "../src/analyze-mod-service.ts";
import { AnalyzeSymbolService } from "../src/analyze-symbol-service.ts";
import { CompareMinecraftService } from "../src/compare-minecraft-service.ts";
import { InspectMinecraftService } from "../src/inspect-minecraft-service.ts";
import { ManageCacheService } from "../src/manage-cache-service.ts";
import { ValidateProjectService } from "../src/validate-project-service.ts";

test("InspectMinecraftService returns ambiguous class overview with follow-up candidates", async () => {
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    getClassSource: async () => {
      throw new Error("not used");
    },
    getClassMembers: async () => {
      throw new Error("not used");
    },
    searchClassSource: async () => {
      throw new Error("not used");
    },
    getArtifactFile: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => undefined
  });

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
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    findClass: async () => {
      throw new Error("not used");
    },
    getClassSource: async () => {
      throw new Error("not used");
    },
    getClassMembers: async () => {
      throw new Error("not used");
    },
    searchClassSource: async (input) => {
      searchCalls += 1;
      assert.equal(input.artifactId, "artifact-search");
      assert.equal(input.query, "tickServer");
      return {
        artifactId: input.artifactId,
        query: input.query,
        hits: [{ filePath: "net/minecraft/server/MinecraftServer.java", score: 120, matchedIn: "content", preview: "tickServer" }],
        nextCursor: undefined,
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
    getArtifactFile: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  });

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

test("InspectMinecraftService preserves workspace context for file focus without explicit artifact input", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    findClass: async () => {
      throw new Error("not used");
    },
    getClassSource: async () => {
      throw new Error("not used");
    },
    getClassMembers: async () => {
      throw new Error("not used");
    },
    searchClassSource: async () => {
      throw new Error("not used");
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
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => "1.21.11"
  });

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
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    getClassMembers: async () => {
      throw new Error("not used");
    },
    searchClassSource: async () => {
      throw new Error("not used");
    },
    getArtifactFile: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  });

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
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    findClass: async () => {
      throw new Error("not used");
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
    getClassMembers: async () => {
      throw new Error("not used");
    },
    searchClassSource: async () => {
      throw new Error("not used");
    },
    getArtifactFile: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  });

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
  const service = new InspectMinecraftService({
    listVersions: async () => {
      throw new Error("not used");
    },
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
    findClass: async () => {
      throw new Error("not used");
    },
    getClassSource: async () => {
      throw new Error("not used");
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
    searchClassSource: async () => {
      throw new Error("not used");
    },
    getArtifactFile: async () => {
      throw new Error("not used");
    },
    listArtifactFiles: async () => {
      throw new Error("not used");
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  });

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

test("AnalyzeSymbolService returns matrix rows only when include=matrix is requested", async () => {
  const service = new AnalyzeSymbolService({
    checkSymbolExists: async () => {
      throw new Error("not used");
    },
    findMapping: async () => {
      throw new Error("not used");
    },
    resolveMethodMappingExact: async () => {
      throw new Error("not used");
    },
    traceSymbolLifecycle: async () => {
      throw new Error("not used");
    },
    resolveWorkspaceSymbol: async () => {
      throw new Error("not used");
    },
    getClassApiMatrix: async () => ({
      version: "1.21.10",
      className: "net.minecraft.world.level.block.Blocks",
      classNameMapping: "mojang",
      classIdentity: { mojang: "net.minecraft.world.level.block.Blocks" },
      rowCount: 2,
      rowsTruncated: false,
      ambiguousRowCount: 0,
      warnings: [],
      rows: [
        {
          kind: "field",
          mojang: {
            symbol: "net.minecraft.world.level.block.Blocks.AIR",
            owner: "net.minecraft.world.level.block.Blocks",
            name: "AIR"
          }
        }
      ]
    })
  });

  const summaryOnly = await service.execute({
    task: "api-overview",
    detail: "summary",
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks"
    },
    version: "1.21.10",
    classNameMapping: "mojang"
  });
  assert.equal(summaryOnly.summary.status, "ok");
  assert.equal("matrix" in summaryOnly, false);

  const withMatrix = await service.execute({
    task: "api-overview",
    detail: "standard",
    include: ["matrix"],
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks"
    },
    version: "1.21.10",
    classNameMapping: "mojang"
  });
  assert.equal(withMatrix.matrix?.rowCount, 2);
  assert.equal(withMatrix.matrix?.rows?.length, 1);
});

test("CompareMinecraftService summarizes changed versions without full class lists by default", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B"],
        removed: ["c.C"],
        addedCount: 2,
        removedCount: 1,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 1,
          totalAdded: 1,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "versions",
    detail: "summary",
    subject: {
      kind: "version-pair",
      fromVersion: "1.20.4",
      toVersion: "1.21"
    }
  });

  assert.equal(result.summary.status, "changed");
  assert.equal(result.summary.counts?.addedClasses, 2);
  assert.equal(result.summary.counts?.changedRegistries, 1);
  assert.equal(Array.isArray(result.classes?.added), false);
});

test("CompareMinecraftService emits truncation metadata when summary samples are clipped", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    subject
  });

  assert.equal(result.summary.status, "changed");
  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["classes", "registry"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("CompareMinecraftService keeps truncation metadata for clipped summary classes when registry is included", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    include: ["registry"],
    subject
  });

  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["classes"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("CompareMinecraftService keeps truncation metadata for clipped summary registry data when classes are included", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    include: ["classes"],
    subject
  });

  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["registry"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("AnalyzeModService validates remap preview without mutating", async () => {
  let remapCalls = 0;
  const service = new AnalyzeModService({
    analyzeModJar: async () => ({
      loader: "fabric",
      jarKind: "binary",
      modId: "example",
      modName: "Example",
      modVersion: "1.0.0",
      classCount: 1,
      dependencies: [{ modId: "minecraft", versionRange: "1.21.10", kind: "required" }]
    }),
    decompileModJar: async () => {
      throw new Error("not used");
    },
    getModClassSource: async () => {
      throw new Error("not used");
    },
    searchModSource: async () => {
      throw new Error("not used");
    },
    remapModJar: async () => {
      remapCalls += 1;
      return {
        outputJar: "/tmp/example-mojang.jar",
        mcVersion: "1.21.10",
        fromMapping: "intermediary",
        targetMapping: "mojang",
        resolvedTargetNamespace: "mojang",
        durationMs: 25,
        warnings: []
      };
    }
  });

  const result = await service.execute({
    task: "remap",
    detail: "summary",
    subject: {
      kind: "jar",
      jarPath: "/tmp/example.jar"
    },
    executionMode: "preview",
    targetMapping: "mojang"
  });

  assert.equal(remapCalls, 0);
  assert.equal(result.summary.status, "unchanged");
  assert.equal(result.operation?.executionMode, "preview");
});

test("ValidateProjectService validates direct access widener inline input", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "access-widener",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "access-widener",
      input: {
        mode: "inline",
        content: "accessWidener v2 named\naccessible class net/minecraft/world/item/Item"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
});

test("ValidateProjectService project-summary continues when one discovered mixin config fails validation", async () => {
  const service = new ValidateProjectService({
    validateMixin: async (input) => {
      const configPath = input.input.mode === "config" ? input.input.configPaths[0] : "";
      if (configPath?.endsWith("empty.mixins.json")) {
        throw new Error("Mixin config(s) contain no mixin class entries.");
      }
      return {
        summary: {
          valid: 1,
          partial: 0,
          invalid: 0
        },
        warnings: ["validated mixin config"]
      };
    },
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    discoverMixins: async () => [
      "/workspace/demo-mod/src/main/resources/empty.mixins.json",
      "/workspace/demo-mod/src/main/resources/demo.mixins.json"
    ],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod"
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(result.project?.summary?.valid, 1);
  assert.equal(result.project?.summary?.invalid, 1);
  assert.ok(result.warnings?.some((warning) => warning.includes("empty.mixins.json")));
  assert.ok(result.warnings?.some((warning) => warning.includes("validated mixin config")));
});

test("CompareMinecraftService forwards sourcePriority for class diffs", async () => {
  const seenInputs: Array<{
    className: string;
    fromVersion: string;
    toVersion: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    includeFullDiff?: boolean;
  }> = [];
  const service = new CompareMinecraftService({
    compareVersions: async () => {
      throw new Error("not used");
    },
    diffClassSignatures: async (input) => {
      seenInputs.push(input);
      return {
        query: { className: input.className, mapping: input.mapping },
        range: { fromVersion: input.fromVersion, toVersion: input.toVersion },
        classChange: "modified",
        summary: {
          total: {
            added: 0,
            removed: 0,
            modified: 1
          }
        },
        constructors: { added: [], removed: [], modified: [] },
        methods: { added: [], removed: [], modified: [] },
        fields: { added: [], removed: [], modified: [] },
        warnings: []
      };
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "class-diff",
    detail: "summary",
    subject: {
      kind: "class",
      className: "net.minecraft.server.MinecraftServer",
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      mapping: "mojang",
      sourcePriority: "maven-first"
    }
  });

  assert.equal(result.summary.status, "changed");
  assert.deepEqual(seenInputs, [
    {
      className: "net.minecraft.server.MinecraftServer",
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      mapping: "mojang",
      sourcePriority: "maven-first",
      includeFullDiff: undefined
    }
  ]);
});

test("CompareMinecraftService returns partial registry-diff results when one side detail fetch fails", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      warnings: [],
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 1,
          totalAdded: 1,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async ({ version }) => {
      if (version === "1.21.3") {
        throw new Error('Failed to read registries.json for version "1.21.3".');
      }
      return {
        version,
        registries: {
          "minecraft:item": {
            entries: {
              "minecraft:test": {}
            }
          }
        },
        registryEntryCounts: {
          "minecraft:item": 1
        },
        returnedEntryCount: 1,
        dataTruncated: false,
        warnings: []
      };
    }
  });

  const result = await service.execute({
    task: "registry-diff",
    detail: "full",
    include: ["registry"],
    subject: {
      kind: "registry",
      registry: "minecraft:item",
      fromVersion: "1.21.3",
      toVersion: "1.21.4"
    }
  });

  assert.equal(result.summary.status, "partial");
  assert.equal(result.registry?.entries?.from, undefined);
  assert.equal(result.registry?.entries?.to?.version, "1.21.4");
  assert.ok(result.warnings?.some((warning) => warning.includes('1.21.3')));
});

test("ManageCacheService normalizes read-only actions to preview mode and blocks broad delete apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "manage-cache-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  await writeFile(join(root, "downloads", "client.jar"), "jar");

  const service = new ManageCacheService({
    registry: {
      summarize: async () => ({
        kinds: {
          downloads: {
            cacheKind: "downloads",
            entryCount: 1,
            totalBytes: 3,
            status: "healthy"
          }
        }
      }),
      listEntries: async () => ({ entries: [], nextCursor: undefined }),
      inspectEntries: async () => [],
      deleteEntries: async () => ({ deletedEntries: 0, deletedBytes: 0, warnings: [] }),
      pruneEntries: async () => ({ deletedEntries: 0, deletedBytes: 0, warnings: [] }),
      rebuildEntries: async () => ({ rebuiltEntries: 0, warnings: [] }),
      verifyEntries: async () => ({ checkedEntries: 1, unhealthyEntries: 0, warnings: [] })
    }
  });

  const summary = await service.execute({
    action: "summary",
    executionMode: "apply",
    cacheKinds: ["downloads"]
  });
  assert.equal(summary.operation?.executionMode, "preview");

  await assert.rejects(
    () =>
      service.execute({
        action: "delete",
        executionMode: "apply",
        cacheKinds: ["downloads"]
      }),
    (error: any) => error.code === ERROR_CODES.INVALID_INPUT
  );
});
