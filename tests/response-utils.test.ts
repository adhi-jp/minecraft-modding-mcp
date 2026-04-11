import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  isCompactEnabled,
  COMPACT_ENABLED_TOOL_NAMES,
  COMPACT_MAPPING_TOOL_NAMES
} from "../src/response-utils.ts";

// ---------------------------------------------------------------------------
// compactResponse
// ---------------------------------------------------------------------------

test("compactResponse strips null values", () => {
  const input = { a: 1, b: null, c: "hello" };
  assert.deepEqual(compactResponse(input), { a: 1, c: "hello" });
});

test("compactResponse strips undefined values", () => {
  const input = { a: 1, b: undefined, c: "hello" };
  assert.deepEqual(compactResponse(input), { a: 1, c: "hello" });
});

test("compactResponse strips empty arrays", () => {
  const input = { candidates: [], resolved: true, warnings: [] };
  assert.deepEqual(compactResponse(input), { resolved: true });
});

test("compactResponse strips empty objects", () => {
  const input = { data: {}, name: "test" };
  assert.deepEqual(compactResponse(input), { name: "test" });
});

test("compactResponse preserves non-empty arrays", () => {
  const input = { candidates: [{ name: "foo" }], warnings: [] };
  assert.deepEqual(compactResponse(input), { candidates: [{ name: "foo" }] });
});

test("compactResponse preserves non-empty objects", () => {
  const input = { data: { key: "value" }, empty: {} };
  assert.deepEqual(compactResponse(input), { data: { key: "value" } });
});

test("compactResponse preserves zero, false, and empty string", () => {
  const input = { count: 0, flag: false, label: "" };
  assert.deepEqual(compactResponse(input), { count: 0, flag: false, label: "" });
});

test("compactResponse is shallow — nested empty structures stay", () => {
  const input = { outer: { inner: [], nested: null } };
  const result = compactResponse(input);
  assert.deepEqual(result, { outer: { inner: [], nested: null } });
});

test("compactResponse returns empty object when all values stripped", () => {
  const input = { a: null, b: [], c: {} };
  assert.deepEqual(compactResponse(input), {});
});

test("compactResponse returns empty object for null input", () => {
  assert.deepEqual(compactResponse(null as unknown as Record<string, unknown>), {});
});

test("compactResponse returns empty object for undefined input", () => {
  assert.deepEqual(compactResponse(undefined as unknown as Record<string, unknown>), {});
});

test("compactResponse preserves Date values (non-plain object)", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const input = { generatedAt: date, empty: {} };
  const result = compactResponse(input);
  assert.equal(result.generatedAt, date);
  assert.equal("empty" in result, false);
});

test("compactResponse preserves class instances with no enumerable keys", () => {
  class Custom { getValue() { return 42; } }
  const inst = new Custom();
  const input = { custom: inst as unknown, plainEmpty: {} };
  const result = compactResponse(input);
  assert.equal(result.custom, inst);
  assert.equal("plainEmpty" in result, false);
});

// ---------------------------------------------------------------------------
// isCompactEnabled — double gate
// ---------------------------------------------------------------------------

test("isCompactEnabled returns true for allowlisted tool with compact:true", () => {
  for (const tool of COMPACT_ENABLED_TOOL_NAMES) {
    assert.equal(isCompactEnabled(tool, { compact: true }), true, tool);
  }
});

test("isCompactEnabled returns false for allowlisted tool with compact:false", () => {
  for (const tool of COMPACT_ENABLED_TOOL_NAMES) {
    assert.equal(isCompactEnabled(tool, { compact: false }), false, tool);
  }
});

test("isCompactEnabled returns false for allowlisted tool with no compact field", () => {
  assert.equal(isCompactEnabled("resolve-artifact", { version: "1.20.1" }), false);
});

test("isCompactEnabled returns false for non-allowlisted tool even with compact:true", () => {
  assert.equal(isCompactEnabled("get-class-source", { compact: true }), false);
  assert.equal(isCompactEnabled("list-versions", { compact: true }), false);
  assert.equal(isCompactEnabled("get-runtime-metrics", { compact: true }), false);
});

test("isCompactEnabled handles null/undefined/array parsedInput safely", () => {
  assert.equal(isCompactEnabled("resolve-artifact", null), false);
  assert.equal(isCompactEnabled("resolve-artifact", undefined), false);
  assert.equal(isCompactEnabled("resolve-artifact", [1, 2]), false);
});

// ---------------------------------------------------------------------------
// Zod strip defense: z.object() strips unknown keys
// ---------------------------------------------------------------------------

test("Zod z.object() strips compact from schemas that do not define it", () => {
  const schema = z.object({ name: z.string() });
  const parsed = schema.parse({ name: "test", compact: true });
  assert.equal("compact" in parsed, false);
});

// ---------------------------------------------------------------------------
// Passthrough defense: allowlist rejects even when parsedInput has compact
// ---------------------------------------------------------------------------

test("passthrough schema lets compact survive but allowlist blocks it", () => {
  const passthroughSchema = z.object({}).passthrough();
  const parsed = passthroughSchema.parse({ compact: true });
  assert.equal((parsed as Record<string, unknown>).compact, true, "compact survives passthrough");
  assert.equal(isCompactEnabled("get-runtime-metrics", parsed), false, "allowlist blocks it");
});

// ---------------------------------------------------------------------------
// Stub functions (P2/P4) are identity
// ---------------------------------------------------------------------------

test("compactArtifactResponse is identity (P2 stub)", () => {
  const input = { jarPath: "/some/path", candidates: [] };
  assert.deepEqual(compactArtifactResponse(input), input);
});

test("compactMappingResponse is identity (P4 stub)", () => {
  const input = { mapped: { name: "foo" }, candidates: [] };
  assert.deepEqual(compactMappingResponse(input), input);
});

// ---------------------------------------------------------------------------
// Pipeline simulation: splitWarnings → compact → objectResult
// ---------------------------------------------------------------------------

test("compact pipeline strips empty candidates from a not_found SymbolResolutionOutput shape", () => {
  // Simulates what runTool does: splitWarnings extracts warnings, then compactResponse strips empties
  const serviceOutput: Record<string, unknown> = {
    querySymbol: { kind: "class", name: "com.example.Foo", symbol: "com.example.Foo" },
    mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", sourcePriorityApplied: "loom-first" },
    resolved: false,
    status: "not_found",
    candidates: [],
    candidateCount: 0,
    warnings: []
  };

  // Step 1: splitWarnings moves warnings out (simulated)
  const afterSplit = { ...serviceOutput };
  delete afterSplit.warnings;

  // Step 2: compactResponse strips empty values
  const compacted = compactResponse(afterSplit);

  assert.equal("candidates" in compacted, false, "empty candidates[] must be stripped");
  assert.equal(compacted.candidateCount, 0, "zero number must survive");
  assert.equal(compacted.status, "not_found");
  assert.ok(compacted.querySymbol);
  assert.ok(compacted.mappingContext);
});

test("compact pipeline preserves all fields in a resolved SymbolResolutionOutput shape", () => {
  const serviceOutput: Record<string, unknown> = {
    querySymbol: { kind: "class", name: "dhl", symbol: "dhl" },
    mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", targetMapping: "obfuscated", sourcePriorityApplied: "loom-first" },
    resolved: true,
    status: "resolved",
    resolvedSymbol: { kind: "class", name: "dhl", symbol: "dhl" },
    candidates: [{ kind: "class", name: "dhl", symbol: "dhl", matchKind: "exact", confidence: 1 }],
    candidateCount: 1
  };

  const compacted = compactResponse(serviceOutput);

  // No fields should be stripped — all are non-empty
  assert.deepEqual(Object.keys(compacted).sort(), Object.keys(serviceOutput).sort());
  assert.deepEqual(compacted, serviceOutput);
});

// ---------------------------------------------------------------------------
// Set membership
// ---------------------------------------------------------------------------

test("COMPACT_MAPPING_TOOL_NAMES is a subset of COMPACT_ENABLED_TOOL_NAMES", () => {
  for (const tool of COMPACT_MAPPING_TOOL_NAMES) {
    assert.equal(COMPACT_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in COMPACT_ENABLED`);
  }
});

test("resolve-artifact is in COMPACT_ENABLED but not in COMPACT_MAPPING", () => {
  assert.equal(COMPACT_ENABLED_TOOL_NAMES.has("resolve-artifact"), true);
  assert.equal(COMPACT_MAPPING_TOOL_NAMES.has("resolve-artifact"), false);
});
