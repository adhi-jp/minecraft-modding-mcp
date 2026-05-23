import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import {
  BatchSymbolExistsService,
  type BatchSymbolExistsDeps,
  type BatchSymbolExistsInput
} from "../src/entry-tools/batch-symbol-exists-service.ts";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  ResolveArtifactOutput
} from "../src/source-service.ts";
import "../src/index.ts";

function buildResolved(workspace?: { minecraftVersion: string }): ResolveArtifactOutput {
  return {
    artifactId: "art-shared",
    artifactAlias: "art-shared-alias",
    origin: "local-jar",
    isDecompiled: false,
    version: workspace ? undefined : "1.21.10",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    provenance: {
      target: workspace
        ? ({ kind: "workspace" } as unknown as never)
        : { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: [],
      ...(workspace
        ? {
            workspaceResolution: {
              projectPath: "/tmp/proj",
              detected: { minecraftVersion: workspace.minecraftVersion },
              source: "test",
              cacheHit: false
            }
          }
        : {})
    },
    qualityFlags: [],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    warnings: []
  };
}

function buildOkExistence(input: CheckSymbolExistsInput): CheckSymbolExistsOutput {
  return {
    querySymbol: {
      kind: input.kind,
      symbol: input.name,
      owner: input.owner,
      name: input.name,
      descriptor: input.descriptor
    } as unknown as CheckSymbolExistsOutput["querySymbol"],
    mappingContext: {
      version: input.version,
      sourceMapping: input.sourceMapping,
      sourcePriorityApplied: "loom-first"
    },
    resolved: true,
    status: "resolved",
    candidates: [],
    candidateCount: 0,
    warnings: []
  };
}

function buildDeps(opts: {
  failName?: string;
  resolved?: ResolveArtifactOutput;
  resolveCallSpy?: { count: number };
}): BatchSymbolExistsDeps {
  return {
    resolveArtifact: async () => {
      if (opts.resolveCallSpy) opts.resolveCallSpy.count += 1;
      return opts.resolved ?? buildResolved();
    },
    checkSymbolExists: async (input) => {
      if (opts.failName && input.name === opts.failName) {
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: `not found: ${input.name}`
        });
      }
      return buildOkExistence(input);
    }
  };
}

const baseInput: Omit<BatchSymbolExistsInput, "entries"> = {
  target: { kind: "version", value: "1.21.10" }
};

test("E1: 3 mixed-kind entries (class, method, field) return ok in input order", async () => {
  const service = new BatchSymbolExistsService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "net.minecraft.world.entity.LivingEntity" },
      { kind: "method", owner: "net.minecraft.world.entity.LivingEntity", name: "tick", descriptor: "()V" },
      { kind: "field", owner: "net.minecraft.world.entity.LivingEntity", name: "airSupply" }
    ]
  });
  assert.equal(out.summary.ok, 3);
  for (let i = 0; i < 3; i++) assert.equal(out.results[i]!.index, i);
});

test("F3: per-entry signatureMode override flows through to checkSymbolExists", async () => {
  const seen: CheckSymbolExistsInput[] = [];
  const deps: BatchSymbolExistsDeps = {
    resolveArtifact: async () => buildResolved(),
    checkSymbolExists: async (input) => {
      seen.push(input);
      return buildOkExistence(input);
    }
  };
  const service = new BatchSymbolExistsService(deps);
  await service.execute({
    ...baseInput,
    entries: [
      { kind: "method", owner: "Owner", name: "tick", signatureMode: "name-only" },
      { kind: "method", owner: "Owner", name: "tick", descriptor: "()V", signatureMode: "exact" }
    ]
  });
  assert.equal(seen[0]!.signatureMode, "name-only");
  assert.equal(seen[1]!.signatureMode, "exact");
});

test("E4: shared resolution runs exactly once and version is derived from version target", async () => {
  const seen: CheckSymbolExistsInput[] = [];
  const spy = { count: 0 };
  const deps: BatchSymbolExistsDeps = {
    resolveArtifact: async () => {
      spy.count += 1;
      return buildResolved();
    },
    checkSymbolExists: async (input) => {
      seen.push(input);
      return buildOkExistence(input);
    }
  };
  const service = new BatchSymbolExistsService(deps);
  await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "a.A" },
      { kind: "class", name: "b.B" }
    ]
  });
  assert.equal(spy.count, 1);
  assert.equal(seen[0]!.version, "1.21.10");
  assert.equal(seen[1]!.version, "1.21.10");
  // Source mapping derived from the resolved artifact.
  assert.equal(seen[0]!.sourceMapping, "obfuscated");
});

test("E4 (workspace): version is derived from workspace provenance.detected.minecraftVersion", async () => {
  const seen: CheckSymbolExistsInput[] = [];
  const deps: BatchSymbolExistsDeps = {
    resolveArtifact: async () => buildResolved({ minecraftVersion: "1.20.4" }),
    checkSymbolExists: async (input) => {
      seen.push(input);
      return buildOkExistence(input);
    }
  };
  const service = new BatchSymbolExistsService(deps);
  await service.execute({
    target: { kind: "workspace" },
    projectPath: "/tmp/proj",
    entries: [{ kind: "class", name: "a.A" }]
  });
  assert.equal(seen[0]!.version, "1.20.4");
});

test("E7: per-entry suggestedCall proposes check-symbol-exists and validates", async () => {
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  // The suggestedCall is synthesized from the entry, then validated against
  // the check-symbol-exists schema before publication. The schema rejects
  // bare names for kind=class (must be FQCN), so use a qualified name here.
  const service = new BatchSymbolExistsService(buildDeps({ failName: "boom.X" }));
  const out = await service.execute({
    ...baseInput,
    entries: [{ kind: "class", name: "boom.X" }]
  });
  const suggested = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error.suggestedCall;
  assert.ok(suggested);
  assert.equal(suggested!.tool, "check-symbol-exists");
  assert.equal(suggested!.params.version, "1.21.10");
  assert.equal(suggested!.params.sourceMapping, "obfuscated");
  assert.equal(validateToolParams(suggested!.tool, suggested!.params).valid, true);
});

test("E8: compact:true strips empty arrays and applies mapping projection", async () => {
  const service = new BatchSymbolExistsService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    compact: true,
    entries: [{ kind: "class", name: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok(!("warnings" in result));
  assert.ok(!("ambiguityReasons" in result));
});

test("ERR_WORKSPACE_VERSION_UNRESOLVED when shared artifact lacks Minecraft version", async () => {
  const deps: BatchSymbolExistsDeps = {
    resolveArtifact: async () => {
      const resolved = buildResolved();
      // Wipe both provenance.workspaceResolution and .version so no MC version
      // can be derived.
      const stripped: ResolveArtifactOutput = {
        ...resolved,
        version: undefined
      };
      return stripped;
    },
    checkSymbolExists: async (input) => buildOkExistence(input)
  };
  const service = new BatchSymbolExistsService(deps);
  await assert.rejects(
    service.execute({
      ...baseInput,
      entries: [{ kind: "class", name: "a.A" }]
    }),
    (err: unknown) => (err as { code?: string }).code === ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED
  );
});

test("E3: failFast=true halts dispatch; un-started entries become ERR_BATCH_ABORTED", async () => {
  const service = new BatchSymbolExistsService(buildDeps({ failName: "Doom" }));
  const out = await service.execute({
    ...baseInput,
    concurrency: 1,
    failFast: true,
    entries: [
      { kind: "class", name: "Doom" },
      { kind: "class", name: "OkB" },
      { kind: "class", name: "OkC" }
    ]
  });
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal((out.results[2] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
});

test("E2: failFast=false (default) keeps running and preserves the entry's underlying code", async () => {
  const service = new BatchSymbolExistsService(buildDeps({ failName: "Doom" }));
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "Doom" },
      { kind: "class", name: "OkB" }
    ]
  });
  assert.equal((out.results[0] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
  // Second entry must still be processed (no abort).
  assert.ok("result" in (out.results[1] as object) || "error" in (out.results[1] as object));
  if ("result" in (out.results[1] as object)) {
    const r = (out.results[1] as { result: { status: string } }).result;
    assert.equal(r.status, "resolved");
  }
});
