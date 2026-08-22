import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../../../src/errors.ts";
import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService preserves workspace context for file focus without explicit artifact input", async () => {
  const resolveArtifactCalls: Array<{
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
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
        version: input.target.kind === "workspace" ? "1.21.11" : input.target.value,
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
      target: { kind: "workspace" },
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
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
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
        version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
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
      target: { kind: "workspace" },
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
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
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
        version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
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
      target: { kind: "workspace" },
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
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
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
        version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
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
      target: { kind: "workspace" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService forwards a workspace target when subject mapping and scope are omitted", async () => {
  const resolveArtifactCalls: Array<{
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
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
        artifactId: "artifact-workspace-target",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: "mojang",
        mappingApplied: "mojang",
        version: "1.21.10",
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
      assert.equal(input.artifactId, "artifact-workspace-target");
      return {
        className: input.className,
        artifactId: input.artifactId ?? "artifact-workspace-target",
        counts: { total: 1, constructors: 0, methods: 1, fields: 0 },
        truncated: false,
        members: [{ kind: "method", signature: "tickServer()V", display: "void tickServer()" }],
        returnedNamespace: "mojang",
        warnings: []
      };
    }
  }));

  const result = await service.execute({
    task: "class-members",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      focus: {
        kind: "class",
        className: "net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  // resolve-artifact resolves the same directory through target.kind="workspace",
  // which reads the workspace compile mapping and loader scope. Re-deriving a
  // {kind:"version"} target here would silently resolve a different artifact.
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "workspace" },
      mapping: undefined,
      scope: undefined,
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

test("InspectMinecraftService propagates ERR_WORKSPACE_VERSION_UNRESOLVED for workspace class focus", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async () => {
      throw createError({
        code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
        message: 'Could not detect a Minecraft version for projectPath "/workspace/demo-mod".',
        details: {
          projectPath: "/workspace/demo-mod",
          nextAction: "Set minecraft_version in gradle.properties or pass target.kind=\"version\"."
        }
      });
    },
    detectProjectMinecraftVersion: async () => undefined
  }));

  await assert.rejects(
    service.execute({
      task: "class-members",
      detail: "summary",
      subject: {
        kind: "workspace",
        projectPath: "/workspace/demo-mod",
        focus: {
          kind: "class",
          className: "net.minecraft.server.MinecraftServer"
        }
      }
    }),
    (error: unknown) => {
      // Degrading to artifactId:"" produced a misleading
      // ERR_INVALID_INPUT ("Either artifactId or target must be provided.").
      assert.equal(
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code: string }).code
          : undefined,
        ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED
      );
      return true;
    }
  );
});

test("InspectMinecraftService keeps the pre-workspace-target routing under WORKSPACE_TARGET_OFF", async () => {
  process.env.WORKSPACE_TARGET_OFF = "1";
  try {
    const resolveArtifactCalls: Array<{
      target:
        | { kind: "version" | "jar" | "coordinate"; value: string }
        | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
      projectPath?: string;
    }> = [];
    const service = new InspectMinecraftService(buildInspectDeps({
      resolveArtifact: async (input) => {
        resolveArtifactCalls.push(input);
        return {
          artifactId: "artifact-kill-switch",
          origin: "local-jar",
          isDecompiled: false,
          requestedMapping: "obfuscated",
          mappingApplied: "obfuscated",
          version: "1.21.10",
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
      getClassMembers: async (input) => ({
        className: input.className,
        artifactId: input.artifactId ?? "artifact-kill-switch",
        counts: { total: 0, constructors: 0, methods: 0, fields: 0 },
        truncated: false,
        members: [],
        returnedNamespace: "obfuscated",
        warnings: []
      }),
      detectProjectMinecraftVersion: async () => "1.21.10"
    }));

    const result = await service.execute({
      task: "class-members",
      detail: "summary",
      subject: {
        kind: "workspace",
        projectPath: "/workspace/demo-mod",
        focus: {
          kind: "class",
          className: "net.minecraft.server.MinecraftServer"
        }
      }
    });

    assert.equal(result.summary.status, "ok");
    // resolve-artifact rejects target.kind="workspace" while the toggle is set,
    // so the tool must fall back rather than turn the switch into a hard failure.
    assert.deepEqual(resolveArtifactCalls[0]?.target, { kind: "version", value: "1.21.10" });
  } finally {
    delete process.env.WORKSPACE_TARGET_OFF;
  }
});
