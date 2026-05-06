import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import {
  BatchClassSourceService,
  type BatchClassSourceDeps,
  type BatchClassSourceInput
} from "../src/entry-tools/batch-class-source-service.ts";
import type {
  GetClassSourceInput,
  GetClassSourceOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../src/source-service.ts";
import "../src/index.ts";

type ResolveSpy = {
  callCount: number;
  lastInput?: ResolveArtifactInput;
};

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

function buildOkSource(className: string): GetClassSourceOutput {
  return {
    className,
    mode: "metadata",
    sourceText: `class ${className} {}`,
    totalLines: 1,
    returnedRange: { start: 1, end: 1 },
    truncated: false,
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
    qualityFlags: ["ok"],
    artifactContents: {
      sourceKind: "source-jar",
      indexedContentKinds: ["source"],
      resourcesIncluded: false,
      sourceCoverage: "full"
    },
    warnings: ["fixture-warning"]
  };
}

function buildDeps(opts: {
  failClass?: string;
  resolveError?: Error;
}): { deps: BatchClassSourceDeps; spy: ResolveSpy } {
  const spy: ResolveSpy = { callCount: 0 };
  const deps: BatchClassSourceDeps = {
    resolveArtifact: async (input) => {
      spy.callCount += 1;
      spy.lastInput = input;
      if (opts.resolveError) throw opts.resolveError;
      return buildResolved();
    },
    getClassSource: async (input: GetClassSourceInput) => {
      if (opts.failClass && input.className === opts.failClass) {
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: `class not found: ${input.className}`
        });
      }
      return buildOkSource(input.className);
    }
  };
  return { deps, spy };
}

const baseInput: Omit<BatchClassSourceInput, "entries"> = {
  target: { kind: "version", value: "1.21.10" }
};

test("E1: 3 valid entries return 3 ok results in input order", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [
      { className: "a.A" },
      { className: "b.B" },
      { className: "c.C" }
    ]
  });
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.ok, 3);
  assert.equal(out.summary.error, 0);
  for (let i = 0; i < 3; i++) {
    assert.equal(out.results[i]!.index, i);
    assert.equal(out.results[i]!.status, "ok");
  }
  assert.match(
    (out.results[0] as { result: { sourceText: string } }).result.sourceText,
    /a\.A/
  );
});

test("E2: failFast=false (default) returns mixed ok/error with code passthrough", async () => {
  const { deps } = buildDeps({ failClass: "b.B" });
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [
      { className: "a.A" },
      { className: "b.B" },
      { className: "c.C" }
    ]
  });
  assert.equal(out.summary.ok, 2);
  assert.equal(out.summary.error, 1);
  assert.equal(out.results[1]!.status, "error");
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
});

test("E3: failFast=true halts dispatch; un-started entries become ERR_BATCH_ABORTED", async () => {
  // concurrency=1 makes the test deterministic: no later entry can start until
  // entry 0 returns its (failed) result, so all subsequent entries are
  // guaranteed un-started when the abort flag flips.
  const { deps } = buildDeps({ failClass: "fail.A" });
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    concurrency: 1,
    failFast: true,
    entries: [
      { className: "fail.A" },
      { className: "ok.B" },
      { className: "ok.C" }
    ]
  });
  assert.equal(out.results[0]!.status, "error");
  assert.equal((out.results[0] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.equal(out.results[1]!.status, "error");
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal(out.results[2]!.status, "error");
  assert.equal((out.results[2] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
});

test("E4: shared artifact resolution runs exactly once and summary carries sharedArtifactId", async () => {
  const { deps, spy } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [
      { className: "a.A" },
      { className: "b.B" },
      { className: "c.C" }
    ]
  });
  assert.equal(spy.callCount, 1);
  assert.equal(out.summary.sharedArtifactId, "art-shared");
});

test("E7: per-entry error.suggestedCall proposes get-class-source with shared artifactId", async () => {
  const { deps } = buildDeps({ failClass: "boom" });
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "boom" }]
  });
  assert.equal(out.results[0]!.status, "error");
  const error = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error;
  assert.ok(error.suggestedCall, "expected suggestedCall on per-entry error");
  assert.equal(error.suggestedCall!.tool, "get-class-source");
  const target = error.suggestedCall!.params.target as { type: string; artifactId: string };
  assert.equal(target.type, "artifact");
  assert.equal(target.artifactId, "art-shared");
  assert.equal(error.suggestedCall!.params.className, "boom");
});

test("E8: compact:true strips provenance/artifactContents/qualityFlags from per-entry result", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    compact: true,
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok(!("provenance" in result), "provenance should be stripped under compact");
  assert.ok(!("artifactContents" in result), "artifactContents should be stripped under compact");
  assert.ok(!("qualityFlags" in result), "qualityFlags should be stripped under compact");
});

test("E8: compact:false preserves all single-tool fields", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    compact: false,
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok("provenance" in result);
  assert.ok("artifactContents" in result);
  assert.ok("qualityFlags" in result);
});

test("E1/E8: warnings flow into per-entry envelope (not inline in result)", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }]
  });
  const entry = out.results[0] as { warnings: string[]; result: Record<string, unknown> };
  assert.deepEqual(entry.warnings, ["fixture-warning"]);
  assert.ok(!("warnings" in entry.result), "warnings must be lifted out of result.");
});

test("F1: duplicate className entries each produce a result (no de-duplication)", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "x.X" }, { className: "x.X" }]
  });
  assert.equal(out.summary.total, 2);
  assert.equal(out.summary.ok, 2);
});

test("schema gate: per-entry suggestedCall validates against get-class-source schema", async () => {
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const { deps } = buildDeps({ failClass: "fail.X" });
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "fail.X" }]
  });
  const suggested = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error.suggestedCall;
  assert.ok(suggested);
  const result = validateToolParams(suggested!.tool, suggested!.params);
  assert.equal(result.valid, true, "per-entry suggestedCall must validate against the registered schema");
});

test("top-level resolution failure surfaces as a thrown error (no results array)", async () => {
  const { deps } = buildDeps({
    resolveError: createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: "no such version"
    })
  });
  const service = new BatchClassSourceService(deps);
  await assert.rejects(
    service.execute({
      target: { kind: "version", value: "9.99.99" },
      entries: [{ className: "a.A" }]
    }),
    (err: unknown) => (err as { code?: string }).code === ERROR_CODES.VERSION_NOT_FOUND
  );
});
