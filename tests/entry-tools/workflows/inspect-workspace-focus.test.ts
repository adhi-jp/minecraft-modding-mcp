import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

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
