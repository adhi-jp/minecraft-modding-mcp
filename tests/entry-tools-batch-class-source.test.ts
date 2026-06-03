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

test("shared resolution warnings flow into summary.sharedArtifactWarnings (not lost)", async () => {
  // Per-entry calls dispatch by `artifactId` and never re-run resolution,
  // so the shared `resolveArtifact` warnings reach the caller only via
  // `summary.sharedArtifactWarnings`.
  const deps: BatchClassSourceDeps = {
    resolveArtifact: async () => ({
      ...buildResolved(),
      warnings: [
        "version approximated: 1.21 → 1.21.10",
        "loom-cache miss; fell back to maven coordinate"
      ]
    }),
    getClassSource: async (input) => buildOkSource(input.className)
  };
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }, { className: "b.B" }]
  });
  assert.deepEqual(out.summary.sharedArtifactWarnings, [
    "version approximated: 1.21 → 1.21.10",
    "loom-cache miss; fell back to maven coordinate"
  ]);
});

test("shared resolution with no warnings omits sharedArtifactWarnings (no empty array leak)", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [{ className: "a.A" }]
  });
  assert.equal(out.summary.sharedArtifactWarnings, undefined);
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
  const target = error.suggestedCall!.params.target as { kind: string; artifactId: string };
  assert.equal(target.kind, "artifact");
  assert.equal(target.artifactId, "art-shared");
  assert.equal(error.suggestedCall!.params.className, "boom");
});

test("E8: detail=summary strips provenance/artifactContents/qualityFlags from per-entry result", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    detail: "summary",
    entries: [{ className: "a.A" }]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  assert.ok(!("provenance" in result), "provenance should be stripped at detail=summary");
  assert.ok(!("artifactContents" in result), "artifactContents should be stripped at detail=summary");
  assert.ok(!("qualityFlags" in result), "qualityFlags should be stripped at detail=summary");
});

test("E8: detail=full preserves all single-tool fields", async () => {
  const { deps } = buildDeps({});
  const service = new BatchClassSourceService(deps);
  const out = await service.execute({
    ...baseInput,
    detail: "full",
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

test("F1: per-entry mode / startLine / endLine / maxLines / maxChars forward to getClassSource", async () => {
  const seen: GetClassSourceInput[] = [];
  const deps: BatchClassSourceDeps = {
    resolveArtifact: async () => buildResolved(),
    getClassSource: async (input) => {
      seen.push(input);
      return buildOkSource(input.className);
    }
  };
  const service = new BatchClassSourceService(deps);
  await service.execute({
    ...baseInput,
    entries: [
      { className: "a.A", mode: "metadata" },
      { className: "b.B", mode: "snippet", startLine: 10, endLine: 25, maxLines: 30 },
      { className: "c.C", mode: "full", maxChars: 4096 }
    ]
  });
  assert.equal(seen[0]!.mode, "metadata");
  assert.equal(seen[1]!.mode, "snippet");
  assert.equal(seen[1]!.startLine, 10);
  assert.equal(seen[1]!.endLine, 25);
  assert.equal(seen[1]!.maxLines, 30);
  assert.equal(seen[2]!.mode, "full");
  assert.equal(seen[2]!.maxChars, 4096);
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

test("schema rejects duplicate entries[].outputFile (concurrent-write race guard)", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-class-source")!;
  const parsed = schema.safeParse({
    target: { kind: "version", value: "1.21.10" },
    entries: [
      { className: "a.A", outputFile: "/tmp/out.java" },
      { className: "b.B", outputFile: "/tmp/out.java" }
    ]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) =>
      i.path.length === 3 &&
      i.path[0] === "entries" &&
      i.path[1] === 1 &&
      i.path[2] === "outputFile"
    );
    assert.ok(issue, `expected an entries.1.outputFile duplicate issue; got ${JSON.stringify(parsed.error.issues)}`);
    assert.match((issue as { message: string }).message, /Duplicate outputFile/);
  }
});

test("schema accepts unique outputFile per entry", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-class-source")!;
  const parsed = schema.safeParse({
    target: { kind: "version", value: "1.21.10" },
    entries: [
      { className: "a.A", outputFile: "/tmp/a.java" },
      { className: "b.B", outputFile: "/tmp/b.java" },
      { className: "c.C" }
    ]
  });
  assert.equal(parsed.success, true);
});

test("schema rejects relative-path aliases that resolve to the same canonical outputFile", async () => {
  // Writer-side normalization (`path.resolve`) and the schema guard must
  // share semantics so relative aliases collide instead of slipping past
  // trim()-only equality.
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-class-source")!;
  const parsed = schema.safeParse({
    target: { kind: "version", value: "1.21.10" },
    entries: [
      { className: "a.A", outputFile: "out.java" },
      { className: "b.B", outputFile: "./out.java" },
      { className: "c.C", outputFile: "dir/../out.java" }
    ]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    // Both alias entries (1, 2) collide with entry 0; expect at least one of
    // them to surface a duplicate-outputFile issue.
    const aliasIssues = parsed.error.issues.filter((i) =>
      i.path.length === 3 &&
      i.path[0] === "entries" &&
      typeof i.path[1] === "number" &&
      i.path[1] >= 1 &&
      i.path[2] === "outputFile"
    );
    assert.ok(
      aliasIssues.length >= 2,
      `expected ≥2 alias issues across entries 1 and 2; got ${JSON.stringify(parsed.error.issues)}`
    );
    for (const issue of aliasIssues) {
      assert.match(
        (issue as { message: string }).message,
        /Duplicate outputFile \(resolves to/,
        "alias rejection should cite the canonical resolved path so the user sees what collided"
      );
    }
  }
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

test("BATCH_TOOLS_OFF env constant is exported (env-driven kill switch wiring)", async () => {
  // `src/index.ts` gates the four batch-tool registrations on this value, so
  // it must stay boolean even if the env-reading logic is refactored.
  const mod = await import("../src/entry-tools/batch-runner.ts");
  assert.equal(typeof mod.BATCH_TOOLS_OFF, "boolean");
});
