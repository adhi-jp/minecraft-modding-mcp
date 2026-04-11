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
// compactArtifactResponse (P2)
// ---------------------------------------------------------------------------

const ARTIFACT_FIXTURE: Record<string, unknown> = {
  artifactId: "artifact-1.21.10-mojang",
  origin: "remote-repo",
  isDecompiled: false,
  version: "1.21.10",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  qualityFlags: ["source-jar"],
  resolvedSourceJarPath: "/cache/sources/1.21.10-mojang-sources.jar",
  adjacentSourceCandidates: ["/cache/alt-sources.jar"],
  binaryJarPath: "/cache/1.21.10-client.jar",
  coordinate: "net.minecraft:client:1.21.10:sources",
  repoUrl: "https://libraries.minecraft.net",
  provenance: { source: "mojang-manifest", mappingArtifact: "mojmap.tiny", version: "1.21.10", priority: "loom-first" },
  artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
  sampleEntries: ["net/minecraft/world/level/Level.java", "net/minecraft/server/MinecraftServer.java"]
};

const ARTIFACT_KEPT_KEYS = [
  "artifactId", "origin", "isDecompiled", "version",
  "requestedMapping", "mappingApplied", "qualityFlags"
];

const ARTIFACT_OMITTED_KEYS = [
  "provenance", "artifactContents", "sampleEntries",
  "adjacentSourceCandidates", "binaryJarPath", "coordinate",
  "repoUrl", "resolvedSourceJarPath"
];

test("compactArtifactResponse omits diagnostic/debug fields", () => {
  const result = compactArtifactResponse(ARTIFACT_FIXTURE);
  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
});

test("compactArtifactResponse preserves essential fields", () => {
  const result = compactArtifactResponse(ARTIFACT_FIXTURE);
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in result, `${key} should be preserved`);
    assert.deepEqual(result[key], ARTIFACT_FIXTURE[key]);
  }
});

test("compactArtifactResponse preserves fields not in the omit set", () => {
  const input = { ...ARTIFACT_FIXTURE, customField: "extra" };
  const result = compactArtifactResponse(input);
  assert.equal(result.customField, "extra");
});

test("compactArtifactResponse handles missing optional fields gracefully", () => {
  const minimal: Record<string, unknown> = {
    artifactId: "artifact-1.21.10",
    origin: "decompiled",
    isDecompiled: true,
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: [],
    provenance: { source: "decompiled" },
    artifactContents: { sourceKind: "decompiled-binary", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "partial" }
  };
  const result = compactArtifactResponse(minimal);
  assert.equal(result.artifactId, "artifact-1.21.10");
  assert.equal("provenance" in result, false);
  assert.equal("artifactContents" in result, false);
  // version is absent in input, so absent in output — no crash
  assert.equal("version" in result, false);
});

test("compactArtifactResponse + compactResponse pipeline on resolve-artifact shape", () => {
  // Simulates runTool: splitWarnings → compactArtifactResponse → compactResponse
  const withWarnings = { ...ARTIFACT_FIXTURE, warnings: ["version approximated"] };
  const afterSplit = { ...withWarnings };
  delete afterSplit.warnings; // splitWarnings moves this to meta

  const afterArtifactProjection = compactArtifactResponse(afterSplit);
  const afterCompact = compactResponse(afterArtifactProjection);

  // Omitted fields must be gone
  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in afterCompact, false, `${key} should be omitted after pipeline`);
  }
  // Essential fields must survive
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in afterCompact, `${key} should survive pipeline`);
  }
});

// ---------------------------------------------------------------------------
// compactMappingResponse (P4)
// ---------------------------------------------------------------------------

const RESOLVED_EXACT_CANDIDATE = {
  kind: "class", name: "Level", symbol: "net.minecraft.world.level.Level",
  matchKind: "exact", confidence: 1
};

const MAPPING_BASE: Record<string, unknown> = {
  querySymbol: { kind: "class", name: "Level", symbol: "net.minecraft.world.level.Level" },
  mappingContext: { version: "1.21.10", sourceMapping: "mojang", targetMapping: "intermediary", sourcePriorityApplied: "loom-first" },
  resolved: true,
  status: "resolved",
  resolvedSymbol: { kind: "class", name: "Level", symbol: "net.minecraft.world.level.Level" },
  candidates: [RESOLVED_EXACT_CANDIDATE],
  candidateCount: 1
};

test("compactMappingResponse omits candidates when resolved + count=1 + exact + confidence=1", () => {
  const result = compactMappingResponse({ ...MAPPING_BASE });
  assert.equal("candidates" in result, false, "candidates should be omitted");
  assert.equal(result.candidateCount, 1, "candidateCount must survive");
  assert.ok(result.resolvedSymbol, "resolvedSymbol must survive");
});

test("compactMappingResponse omits candidates when confidence is undefined (defaults to exact)", () => {
  const candidate = { ...RESOLVED_EXACT_CANDIDATE, confidence: undefined };
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: [candidate]
  });
  assert.equal("candidates" in result, false);
});

test("compactMappingResponse preserves candidates when matchKind is not exact", () => {
  const candidate = { ...RESOLVED_EXACT_CANDIDATE, matchKind: "simple-name" };
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: [candidate]
  });
  assert.ok("candidates" in result, "candidates must be preserved for non-exact matchKind");
  assert.equal((result.candidates as unknown[]).length, 1);
});

test("compactMappingResponse preserves candidates when confidence < 1", () => {
  const candidate = { ...RESOLVED_EXACT_CANDIDATE, confidence: 0.8 };
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: [candidate]
  });
  assert.ok("candidates" in result, "candidates must be preserved for low confidence");
});

test("compactMappingResponse preserves candidates when candidateCount > 1", () => {
  const second = { ...RESOLVED_EXACT_CANDIDATE, name: "Level2" };
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: [RESOLVED_EXACT_CANDIDATE, second],
    candidateCount: 2
  });
  assert.ok("candidates" in result, "candidates must be preserved when count > 1");
  assert.equal((result.candidates as unknown[]).length, 2);
});

test("compactMappingResponse preserves candidates when candidatesTruncated is true", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidatesTruncated: true
  });
  assert.ok("candidates" in result, "candidates must be preserved when truncated");
});

test("compactMappingResponse preserves candidates when count/length mismatch", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidateCount: 5  // length=1 but count=5 — mismatch
  });
  assert.ok("candidates" in result, "candidates must be preserved on count/length mismatch");
});

test("compactMappingResponse preserves candidates for ambiguous status", () => {
  const second = { ...RESOLVED_EXACT_CANDIDATE, name: "OtherLevel" };
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    resolved: false,
    status: "ambiguous",
    resolvedSymbol: undefined,
    candidates: [RESOLVED_EXACT_CANDIDATE, second],
    candidateCount: 2
  });
  assert.ok("candidates" in result, "candidates must be preserved for ambiguous");
  assert.equal((result.candidates as unknown[]).length, 2);
});

test("compactMappingResponse preserves candidates for not_found status (empty array for P1 to strip)", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    resolved: false,
    status: "not_found",
    resolvedSymbol: undefined,
    candidates: [],
    candidateCount: 0
  });
  // not_found has candidates:[] — compactMappingResponse should leave it;
  // P1's compactResponse will strip the empty array later
  assert.ok("candidates" in result);
  assert.deepEqual(result.candidates, []);
});

test("compactMappingResponse preserves candidates when candidates is not an array", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: "not-an-array"
  });
  assert.equal(result.candidates, "not-an-array");
});

test("compactMappingResponse preserves candidates when candidates[0] is null", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    candidates: [null]
  });
  assert.ok("candidates" in result);
});

test("compactMappingResponse preserves candidates when candidateCount is absent", () => {
  const input = { ...MAPPING_BASE };
  delete input.candidateCount;
  const result = compactMappingResponse(input);
  assert.ok("candidates" in result);
});

test("compactMappingResponse + compactResponse pipeline strips candidates for resolved exact", () => {
  const afterMapping = compactMappingResponse({ ...MAPPING_BASE });
  const afterCompact = compactResponse(afterMapping);
  assert.equal("candidates" in afterCompact, false);
  assert.equal(afterCompact.candidateCount, 1);
  assert.ok(afterCompact.resolvedSymbol);
});

test("compactMappingResponse + compactResponse pipeline strips empty candidates for not_found", () => {
  const notFound = {
    ...MAPPING_BASE,
    resolved: false, status: "not_found",
    resolvedSymbol: undefined, candidates: [], candidateCount: 0
  };
  const afterMapping = compactMappingResponse(notFound);
  const afterCompact = compactResponse(afterMapping);
  assert.equal("candidates" in afterCompact, false, "empty candidates stripped by compactResponse");
  assert.equal(afterCompact.candidateCount, 0);
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
