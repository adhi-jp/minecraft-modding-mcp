import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import {
  BatchClassMembersService,
  type BatchClassMembersDeps,
  type BatchClassMembersInput
} from "../src/entry-tools/batch-class-members-service.ts";
import type {
  GetClassMembersInput,
  GetClassMembersOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../src/source-service.ts";
import "../src/index.ts";

function buildResolved(): ResolveArtifactOutput {
  return {
    artifactId: "art-shared",
    artifactAlias: "art-shared-alias",
    origin: "local-jar",
    isDecompiled: false,
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: []
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

function buildOkMembers(className: string): GetClassMembersOutput {
  return {
    className,
    members: { constructors: [], fields: [], methods: [] },
    counts: { constructors: 0, fields: 0, methods: 0, total: 0 },
    truncated: false,
    context: {} as unknown as GetClassMembersOutput["context"],
    origin: "local-jar",
    artifactId: "art-shared",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    returnedNamespace: "obfuscated",
    provenance: {
      target: { kind: "version", value: "1.21.10" },
      resolvedAt: "2026-01-01T00:00:00Z",
      resolvedFrom: { origin: "local-jar" },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    status: "available",
    warnings: []
  };
}

function buildDeps(opts: { failClass?: string; resolveCallSpy?: { count: number } }): BatchClassMembersDeps {
  return {
    resolveArtifact: async () => {
      if (opts.resolveCallSpy) opts.resolveCallSpy.count += 1;
      return buildResolved();
    },
    getClassMembers: async (input: GetClassMembersInput) => {
      if (opts.failClass && input.className === opts.failClass) {
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: `class not found: ${input.className}`
        });
      }
      return buildOkMembers(input.className);
    }
  };
}

const baseInput: Omit<BatchClassMembersInput, "entries"> = {
  target: { kind: "version", value: "1.21.10" }
};

test("E1: 3 valid entries return ok in input order", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }, { className: "c.C" }]
  });
  assert.equal(out.summary.ok, 3);
  for (let i = 0; i < 3; i++) assert.equal(out.results[i]!.index, i);
});

test("E2: failing entry preserves underlying error code", async () => {
  const service = new BatchClassMembersService(buildDeps({ failClass: "b.B" }));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }, { className: "c.C" }]
  });
  assert.equal(out.summary.ok, 2);
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
});

test("E3: failFast=true marks subsequent un-started entries as ERR_BATCH_ABORTED", async () => {
  const service = new BatchClassMembersService(buildDeps({ failClass: "fail.A" }));
  const out = await service.execute({
    ...baseInput,
    concurrency: 1,
    failFast: true,
    entries: [{ className: "fail.A" }, { className: "ok.B" }, { className: "ok.C" }]
  });
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal((out.results[2] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
});

test("E4: shared artifact resolution runs exactly once", async () => {
  const spy = { count: 0 };
  const service = new BatchClassMembersService(buildDeps({ resolveCallSpy: spy }));
  await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }, { className: "c.C" }]
  });
  assert.equal(spy.count, 1);
});

test("E7: per-entry retry suggestedCall validates against get-class-members schema", async () => {
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const service = new BatchClassMembersService(buildDeps({ failClass: "boom" }));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "boom", memberPattern: "tick" }]
  });
  const suggested = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error.suggestedCall;
  assert.ok(suggested);
  assert.equal(suggested!.tool, "get-class-members");
  assert.equal((suggested!.params.target as { artifactId: string }).artifactId, "art-shared");
  assert.equal(suggested!.params.memberPattern, "tick");
  assert.equal(validateToolParams(suggested!.tool, suggested!.params).valid, true);
});

test("E8: detail=summary strips provenance/artifactContents/qualityFlags/context", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    detail: "summary",
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok(!("provenance" in result));
  assert.ok(!("artifactContents" in result));
  assert.ok(!("qualityFlags" in result));
  assert.ok(!("context" in result));
  // Members payload survives even when empty (TOOL_PRESERVE_PAYLOAD_KEYS).
  assert.ok("members" in result);
  assert.ok("counts" in result);
});

test("F2: per-entry status field from single-tool result is preserved", async () => {
  const service = new BatchClassMembersService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.equal(result.status, "available");
});

test("BATCH_TOOLS_OFF env constant is exported (env-driven kill switch wiring)", async () => {
  const mod = await import("../src/entry-tools/batch-runner.ts");
  assert.equal(typeof mod.BATCH_TOOLS_OFF, "boolean");
});

test("projection is threaded from batch input to each get-class-members call", async () => {
  const seen: Array<string | undefined> = [];
  const deps: BatchClassMembersDeps = {
    resolveArtifact: async () => buildResolved(),
    getClassMembers: async (input: GetClassMembersInput) => {
      seen.push(input.projection);
      return buildOkMembers(input.className);
    }
  };
  const service = new BatchClassMembersService(deps);
  await service.execute({
    ...baseInput,
    projection: "names",
    entries: [{ className: "a.A" }, { className: "b.B" }]
  });
  assert.deepEqual(seen, ["names", "names"]);
});
