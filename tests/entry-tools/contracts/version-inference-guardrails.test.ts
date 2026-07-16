import assert from "node:assert/strict";
import test from "node:test";

import { AnalyzeSymbolService, analyzeSymbolSchema } from "../../../src/entry-tools/analyze-symbol-service.ts";
import { resolveArtifactReference } from "../../../src/entry-tools/inspect-minecraft/internal.ts";

function unusedDep(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called`);
  };
}

function makeAnalyzeSymbolService(overrides: {
  detectProjectMinecraftVersion?: (projectPath: string) => Promise<string | undefined>;
  checkSymbolExists?: (input: Record<string, unknown>) => Promise<unknown>;
}): AnalyzeSymbolService {
  return new AnalyzeSymbolService({
    detectProjectMinecraftVersion:
      overrides.detectProjectMinecraftVersion ?? (async () => undefined),
    checkSymbolExists:
      (overrides.checkSymbolExists as never) ??
      (unusedDep("checkSymbolExists") as never),
    findMapping: unusedDep("findMapping") as never,
    resolveMethodMappingExact: unusedDep("resolveMethodMappingExact") as never,
    traceSymbolLifecycle: unusedDep("traceSymbolLifecycle") as never,
    resolveWorkspaceSymbol: unusedDep("resolveWorkspaceSymbol") as never,
    getClassApiMatrix: unusedDep("getClassApiMatrix") as never
  } as never);
}

test("analyze-symbol infers an omitted version from projectPath with mandatory provenance", async () => {
  let versionSeen: string | undefined;
  const service = makeAnalyzeSymbolService({
    detectProjectMinecraftVersion: async () => "26.2",
    checkSymbolExists: async (input) => {
      versionSeen = input.version as string;
      return {
        querySymbol: { kind: "class", name: "net.minecraft.world.item.ItemStack", symbol: "x" },
        mappingContext: { version: input.version, sourceMapping: "mojang", sourcePriorityApplied: "loom-first" },
        resolved: true,
        status: "resolved",
        candidates: [],
        candidateCount: 0,
        warnings: []
      };
    }
  });

  const parsed = analyzeSymbolSchema.parse({
    task: "exists",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" },
    sourceMapping: "mojang"
  });
  const result = (await service.execute(parsed)) as {
    versionInference?: { version: string; source: string };
    warnings?: string[];
  };

  assert.equal(versionSeen, "26.2");
  assert.equal(result.versionInference?.version, "26.2");
  assert.match(result.versionInference?.source ?? "", /projectPath/);
  assert.ok(result.warnings?.some((warning) => warning.includes("inferred from the workspace")));
});

test("analyze-symbol keeps an explicit version even when projectPath is supplied", async () => {
  let versionSeen: string | undefined;
  const service = makeAnalyzeSymbolService({
    detectProjectMinecraftVersion: async () => {
      throw new Error("must not detect when version is explicit");
    },
    checkSymbolExists: async (input) => {
      versionSeen = input.version as string;
      return {
        querySymbol: { kind: "class", name: "x", symbol: "x" },
        mappingContext: { version: input.version, sourceMapping: "mojang", sourcePriorityApplied: "loom-first" },
        resolved: true,
        status: "resolved",
        candidates: [],
        candidateCount: 0,
        warnings: []
      };
    }
  });

  const parsed = analyzeSymbolSchema.parse({
    task: "exists",
    version: "1.21.10",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" },
    sourceMapping: "mojang"
  });
  const result = (await service.execute(parsed)) as { versionInference?: unknown };

  assert.equal(versionSeen, "1.21.10");
  assert.equal(result.versionInference, undefined);
});

test("analyze-symbol fails with a clear error when inference finds no version", async () => {
  const service = makeAnalyzeSymbolService({
    detectProjectMinecraftVersion: async () => undefined
  });

  const parsed = analyzeSymbolSchema.parse({
    task: "exists",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" },
    sourceMapping: "mojang"
  });
  await assert.rejects(
    () => service.execute(parsed),
    (error: Error & { code?: string }) => error.code === "ERR_WORKSPACE_VERSION_UNRESOLVED"
  );
});

type MinimalDeps = Parameters<typeof resolveArtifactReference>[0];

function makeInspectDeps(overrides: Partial<MinimalDeps>): MinimalDeps {
  return {
    listVersions: unusedDep("listVersions"),
    resolveArtifact: unusedDep("resolveArtifact"),
    findClass: unusedDep("findClass"),
    checkSymbolExists: unusedDep("checkSymbolExists"),
    getClassSource: unusedDep("getClassSource"),
    getClassMembers: unusedDep("getClassMembers"),
    searchClassSource: unusedDep("searchClassSource"),
    getArtifactFile: unusedDep("getArtifactFile"),
    listArtifactFiles: unusedDep("listArtifactFiles"),
    detectProjectMinecraftVersion: async () => undefined,
    listWorkspaceContexts: () => [],
    ...overrides
  } as MinimalDeps;
}

test("a direct class subject auto-resolves through the unique known workspace with a provenance warning", async () => {
  const deps = makeInspectDeps({
    listWorkspaceContexts: () => [{ projectPath: "/workspace/demo-mod", minecraftVersion: "26.2" }],
    resolveArtifact: (async (input: { target: { kind: string; value: string } }) => {
      assert.deepEqual(input.target, { kind: "version", value: "26.2" });
      return { artifactId: "resolved-artifact", warnings: [] };
    }) as never
  });

  const context = await resolveArtifactReference(deps, {
    kind: "class",
    className: "net.minecraft.world.item.ItemStack"
  } as never);

  assert.equal(context.artifactId, "resolved-artifact");
  assert.ok(
    context.warnings.some((warning) => warning.includes("auto-resolved through the unique known workspace")),
    `expected provenance warning, got: ${JSON.stringify(context.warnings)}`
  );
});

test("a direct class subject with several known workspaces refuses to pick and lists candidates", async () => {
  const deps = makeInspectDeps({
    listWorkspaceContexts: () => [
      { projectPath: "/workspace/mod-a", minecraftVersion: "26.2" },
      { projectPath: "/workspace/mod-b", minecraftVersion: "1.21.10" }
    ]
  });

  await assert.rejects(
    () =>
      resolveArtifactReference(deps, {
        kind: "class",
        className: "net.minecraft.world.item.ItemStack"
      } as never),
    (error: Error & { code?: string; details?: { workspaceCandidates?: string[] } }) => {
      assert.equal(error.code, "ERR_INVALID_INPUT");
      assert.deepEqual(error.details?.workspaceCandidates, [
        "/workspace/mod-a",
        "/workspace/mod-b"
      ]);
      return true;
    }
  );
});

test("an explicit subject.artifact is never overridden by workspace auto-resolution", async () => {
  let workspaceListed = false;
  const deps = makeInspectDeps({
    listWorkspaceContexts: () => {
      workspaceListed = true;
      return [{ projectPath: "/workspace/demo-mod", minecraftVersion: "26.2" }];
    },
  });

  const context = await resolveArtifactReference(deps, {
    kind: "class",
    className: "net.minecraft.world.item.ItemStack",
    artifact: { type: "resolved-id", artifactId: "explicit-artifact" }
  } as never);

  assert.equal(context.artifactId, "explicit-artifact");
  assert.equal(workspaceListed, false);
});

test("task=workspace execution receives the inferred version", async () => {
  let versionSeen: string | undefined;
  const service = new AnalyzeSymbolService({
    detectProjectMinecraftVersion: async () => "26.2",
    checkSymbolExists: unusedDep("checkSymbolExists") as never,
    findMapping: unusedDep("findMapping") as never,
    resolveMethodMappingExact: unusedDep("resolveMethodMappingExact") as never,
    traceSymbolLifecycle: unusedDep("traceSymbolLifecycle") as never,
    resolveWorkspaceSymbol: (async (input: { version: string }) => {
      versionSeen = input.version;
      return {
        querySymbol: { kind: "class", name: "x", symbol: "x" },
        mappingContext: { version: input.version, sourceMapping: "mojang", sourcePriorityApplied: "loom-first" },
        resolved: true,
        status: "resolved",
        candidates: [],
        candidateCount: 0,
        warnings: [],
        workspaceDetection: { resolved: true, mappingApplied: "mojang", evidence: [], warnings: [] }
      };
    }) as never,
    getClassApiMatrix: unusedDep("getClassApiMatrix") as never
  } as never);

  const parsed = analyzeSymbolSchema.parse({
    task: "workspace",
    projectPath: "/workspace/demo-mod",
    subject: { kind: "class", name: "net.minecraft.world.item.ItemStack" },
    sourceMapping: "mojang"
  });
  const result = (await service.execute(parsed)) as {
    versionInference?: { version: string };
  };

  assert.equal(versionSeen, "26.2");
  assert.equal(result.versionInference?.version, "26.2");
});

test("the unique-workspace auto-resolve falls back to on-demand version detection", async () => {
  const deps = makeInspectDeps({
    listWorkspaceContexts: () => [{ projectPath: "/workspace/demo-mod" }],
    detectProjectMinecraftVersion: async (projectPath: string) => {
      assert.equal(projectPath, "/workspace/demo-mod");
      return "1.21.10";
    },
    resolveArtifact: (async (input: { target: { kind: string; value: string } }) => {
      assert.deepEqual(input.target, { kind: "version", value: "1.21.10" });
      return { artifactId: "detected-artifact", warnings: [] };
    }) as never
  });

  const context = await resolveArtifactReference(deps, {
    kind: "class",
    className: "net.minecraft.world.item.ItemStack"
  } as never);
  assert.equal(context.artifactId, "detected-artifact");
});

test("a unique workspace with no detectable version keeps the requires-artifact error", async () => {
  const deps = makeInspectDeps({
    listWorkspaceContexts: () => [{ projectPath: "/workspace/demo-mod" }],
    detectProjectMinecraftVersion: async () => undefined,
    findClass: (async () => ({ matches: [], total: 0, warnings: [] })) as never
  });

  await assert.rejects(
    () =>
      resolveArtifactReference(deps, {
        kind: "class",
        className: "net.minecraft.world.item.ItemStack"
      } as never),
    (error: Error & { code?: string }) => error.code === "ERR_INVALID_INPUT"
  );
});
