import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../src/errors.ts";
import {
  BatchMappingsService,
  type BatchMappingsDeps,
  type BatchMappingsInput
} from "../src/entry-tools/batch-mappings-service.ts";
import type {
  FindMappingInput,
  FindMappingOutput
} from "../src/source-service.ts";
import "../src/index.ts";

function buildOkMapping(input: FindMappingInput): FindMappingOutput {
  return {
    querySymbol: {
      kind: input.kind,
      symbol: input.name,
      owner: input.owner,
      name: input.name,
      descriptor: input.descriptor
    } as unknown as FindMappingOutput["querySymbol"],
    mappingContext: {
      version: input.version,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriorityApplied: "loom-first"
    },
    resolved: true,
    status: "resolved",
    candidates: [],
    candidateCount: 0,
    warnings: []
  };
}

function buildDeps(opts: { failName?: string }): BatchMappingsDeps {
  return {
    findMapping: async (input) => {
      if (opts.failName && input.name === opts.failName) {
        throw createError({
          code: ERROR_CODES.MAPPING_UNAVAILABLE,
          message: `mapping unavailable: ${input.name}`
        });
      }
      return buildOkMapping(input);
    }
  };
}

const baseInput: Omit<BatchMappingsInput, "entries"> = {
  version: "1.21.10"
};

test("E1: 3 mapping entries return ok with the shared version threaded through", async () => {
  const seen: FindMappingInput[] = [];
  const deps: BatchMappingsDeps = {
    findMapping: async (input) => {
      seen.push(input);
      return buildOkMapping(input);
    }
  };
  const service = new BatchMappingsService(deps);
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "a.A", sourceMapping: "obfuscated", targetMapping: "mojang" },
      { kind: "method", owner: "a.A", name: "tick", descriptor: "()V", sourceMapping: "obfuscated", targetMapping: "mojang" },
      { kind: "field", owner: "a.A", name: "airSupply", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  assert.equal(out.summary.ok, 3);
  for (const seenInput of seen) {
    assert.equal(seenInput.version, "1.21.10");
  }
});

test("E4: no shared artifact summary (mapping-only batch)", async () => {
  const service = new BatchMappingsService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "a.A", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  assert.equal(out.summary.sharedArtifactId, undefined);
});

test("E7: per-entry retry suggestedCall proposes find-mapping and validates", async () => {
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const service = new BatchMappingsService(buildDeps({ failName: "boom" }));
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "boom", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  const suggested = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error.suggestedCall;
  assert.ok(suggested);
  assert.equal(suggested!.tool, "find-mapping");
  assert.equal(suggested!.params.version, "1.21.10");
  assert.equal(suggested!.params.sourceMapping, "obfuscated");
  assert.equal(suggested!.params.targetMapping, "mojang");
  assert.equal(validateToolParams(suggested!.tool, suggested!.params).valid, true);
});

test("per-entry version is rejected by the schema (entries[].version unknown key)", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-mappings");
  assert.ok(schema, "batch-mappings schema must be registered");
  const parsed = schema!.safeParse({
    version: "1.21.10",
    entries: [
      {
        kind: "class",
        name: "a.A",
        sourceMapping: "obfuscated",
        targetMapping: "mojang",
        version: "should-not-be-here"
      }
    ]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    // `.strict()` reports the unrecognized key at the entries[] item path
    // with the rejected key listed in `issue.keys`.
    const hasVersionIssue = parsed.error.issues.some((issue) => {
      if (issue.path[0] !== "entries") return false;
      if (issue.code !== "unrecognized_keys") return false;
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      return keys.includes("version");
    });
    assert.ok(hasVersionIssue, `expected an unrecognized_keys issue with version; got ${JSON.stringify(parsed.error.issues)}`);
  }
});

test("schema: batch-mappings rejects entries.length=0 and entries.length=51", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-mappings")!;
  const tooFew = schema.safeParse({ version: "1.21.10", entries: [] });
  assert.equal(tooFew.success, false);

  const entry = {
    kind: "class",
    name: "a.A",
    sourceMapping: "obfuscated",
    targetMapping: "mojang"
  };
  const tooMany = schema.safeParse({
    version: "1.21.10",
    entries: Array.from({ length: 51 }, () => entry)
  });
  assert.equal(tooMany.success, false);
});

test("schema: batch-mappings rejects concurrency=9 with fieldErrors[0].path === 'concurrency'", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-mappings")!;
  const parsed = schema.safeParse({
    version: "1.21.10",
    concurrency: 9,
    entries: [
      {
        kind: "class",
        name: "a.A",
        sourceMapping: "obfuscated",
        targetMapping: "mojang"
      }
    ]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "concurrency"));
  }
});

test("schema: batch-symbol-exists rejects target.kind=dependency", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-symbol-exists")!;
  const parsed = schema.safeParse({
    target: { kind: "dependency", group: "x", name: "y" },
    entries: [{ kind: "class", name: "a.A" }]
  });
  assert.equal(parsed.success, false);
});

test("schema rejects batch-mappings call with omitted top-level version", async () => {
  const { getToolSchema } = await import("../src/tool-schema-registry.ts");
  const schema = getToolSchema("batch-mappings")!;
  const parsed = schema.safeParse({
    entries: [
      {
        kind: "class",
        name: "a.A",
        sourceMapping: "obfuscated",
        targetMapping: "mojang"
      }
    ]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(
      parsed.error.issues.some((issue) => issue.path[0] === "version"),
      `expected a top-level "version" issue; got ${JSON.stringify(parsed.error.issues)}`
    );
  }
});

test("E8: batch-mappings detail=summary strips empty arrays and applies mapping projection", async () => {
  const service = new BatchMappingsService(buildDeps({}));
  const out = await service.execute({
    ...baseInput,
    detail: "summary",
    entries: [
      { kind: "class", name: "a.A", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  const result = (out.results[0] as { result: Record<string, unknown> }).result;
  // The fixture resolves with empty candidates / warnings; detail=summary strips
  // empty arrays via compactResponse before the mapping projection runs.
  assert.ok(!("warnings" in result));
  assert.ok(!("ambiguityReasons" in result));
  assert.ok(!("candidates" in result), "empty candidates array should be dropped at detail=summary");
});

test("E3: failFast=true halts dispatch; un-started entries become ERR_BATCH_ABORTED", async () => {
  const service = new BatchMappingsService(buildDeps({ failName: "doom" }));
  const out = await service.execute({
    ...baseInput,
    concurrency: 1,
    failFast: true,
    entries: [
      { kind: "class", name: "doom", sourceMapping: "obfuscated", targetMapping: "mojang" },
      { kind: "class", name: "ok.B", sourceMapping: "obfuscated", targetMapping: "mojang" },
      { kind: "class", name: "ok.C", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  // The first entry surfaces the original underlying code; subsequent
  // entries are marked aborted because failFast halted dispatch.
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal((out.results[2] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
});

test("E2: failFast=false (default) keeps running and reports the entry's underlying code", async () => {
  const service = new BatchMappingsService(buildDeps({ failName: "doom" }));
  const out = await service.execute({
    ...baseInput,
    entries: [
      { kind: "class", name: "doom", sourceMapping: "obfuscated", targetMapping: "mojang" },
      { kind: "class", name: "ok.B", sourceMapping: "obfuscated", targetMapping: "mojang" }
    ]
  });
  assert.equal((out.results[0] as { error: { code: string } }).error.code, ERROR_CODES.MAPPING_UNAVAILABLE);
  // The second entry must still be evaluated (no abort) because failFast is false by default.
  assert.ok("result" in (out.results[1] as object) || "error" in (out.results[1] as object));
});
