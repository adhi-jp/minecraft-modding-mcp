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
// compactResponse — table-driven input/expected cases
// ---------------------------------------------------------------------------

const COMPACT_RESPONSE_CASES = [
  {
    name: "strips null values",
    input: { a: 1, b: null, c: "hello" },
    expected: { a: 1, c: "hello" }
  },
  {
    name: "strips undefined values",
    input: { a: 1, b: undefined, c: "hello" },
    expected: { a: 1, c: "hello" }
  },
  {
    name: "strips empty arrays",
    input: { candidates: [], resolved: true, warnings: [] },
    expected: { resolved: true }
  },
  {
    name: "strips empty objects",
    input: { data: {}, name: "test" },
    expected: { name: "test" }
  },
  {
    name: "preserves non-empty arrays",
    input: { candidates: [{ name: "foo" }], warnings: [] },
    expected: { candidates: [{ name: "foo" }] }
  },
  {
    name: "preserves non-empty objects",
    input: { data: { key: "value" }, empty: {} },
    expected: { data: { key: "value" } }
  },
  {
    name: "preserves zero, false, and empty string",
    input: { count: 0, flag: false, label: "" },
    expected: { count: 0, flag: false, label: "" }
  },
  {
    name: "is shallow — nested empty structures stay",
    input: { outer: { inner: [], nested: null } },
    expected: { outer: { inner: [], nested: null } }
  },
  {
    name: "returns empty object when all values stripped",
    input: { a: null, b: [], c: {} },
    expected: {}
  }
] as const;

for (const { name, input, expected } of COMPACT_RESPONSE_CASES) {
  test(`compactResponse ${name}`, () => {
    assert.deepEqual(compactResponse(input), expected);
  });
}

test("compactResponse returns empty object for null or undefined input", () => {
  assert.deepEqual(compactResponse(null as unknown as Record<string, unknown>), {});
  assert.deepEqual(compactResponse(undefined as unknown as Record<string, unknown>), {});
});

test("compactResponse preserves Date values and class instances (non-plain objects)", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const dateResult = compactResponse({ generatedAt: date, empty: {} });
  assert.equal(dateResult.generatedAt, date);
  assert.equal("empty" in dateResult, false);

  class Custom { getValue() { return 42; } }
  const inst = new Custom();
  const classResult = compactResponse({ custom: inst as unknown, plainEmpty: {} });
  assert.equal(classResult.custom, inst);
  assert.equal("plainEmpty" in classResult, false);
});

// ---------------------------------------------------------------------------
// isCompactEnabled — double gate
// ---------------------------------------------------------------------------

test("isCompactEnabled respects allowlist and compact flag", () => {
  // Allowlisted tool with compact:true → true
  for (const tool of COMPACT_ENABLED_TOOL_NAMES) {
    assert.equal(isCompactEnabled(tool, { compact: true }), true, tool);
    assert.equal(isCompactEnabled(tool, { compact: false }), false, tool);
  }
  // Allowlisted tool with no compact field → false
  assert.equal(isCompactEnabled("resolve-artifact", { version: "1.20.1" }), false);
  // Non-allowlisted tool even with compact:true → false
  assert.equal(isCompactEnabled("get-class-source", { compact: true }), false);
  assert.equal(isCompactEnabled("list-versions", { compact: true }), false);
  assert.equal(isCompactEnabled("get-runtime-metrics", { compact: true }), false);
});

test("isCompactEnabled handles null/undefined/array parsedInput safely", () => {
  assert.equal(isCompactEnabled("resolve-artifact", null), false);
  assert.equal(isCompactEnabled("resolve-artifact", undefined), false);
  assert.equal(isCompactEnabled("resolve-artifact", [1, 2]), false);
});

test("isCompactEnabled default path: compact omitted or explicit false returns false", () => {
  assert.equal(isCompactEnabled("find-mapping", {}), false);
  assert.equal(isCompactEnabled("resolve-artifact", {}), false);
  assert.equal(isCompactEnabled("check-symbol-exists", { kind: "class", name: "Foo" }), false);
  assert.equal(isCompactEnabled("find-mapping", { compact: false }), false);
  assert.equal(isCompactEnabled("resolve-artifact", { compact: false }), false);
});

// ---------------------------------------------------------------------------
// Zod schema interaction with the `compact` flag
// ---------------------------------------------------------------------------

test("Zod z.object() strips compact from schemas that do not define it", () => {
  const schema = z.object({ name: z.string() });
  const parsed = schema.parse({ name: "test", compact: true });
  assert.equal("compact" in parsed, false);
});

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

test("compactArtifactResponse projects fields: omits diagnostic, keeps essential, passes through unknown", () => {
  const input = { ...ARTIFACT_FIXTURE, customField: "extra" };
  const result = compactArtifactResponse(input);
  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in result, `${key} should be preserved`);
    assert.deepEqual(result[key], ARTIFACT_FIXTURE[key]);
  }
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
  assert.equal("version" in result, false);
});

test("compactArtifactResponse + compactResponse pipeline on resolve-artifact shape", () => {
  const withWarnings = { ...ARTIFACT_FIXTURE, warnings: ["version approximated"] };
  const afterSplit = { ...withWarnings };
  delete afterSplit.warnings;

  const afterArtifactProjection = compactArtifactResponse(afterSplit);
  const afterCompact = compactResponse(afterArtifactProjection);

  for (const key of ARTIFACT_OMITTED_KEYS) {
    assert.equal(key in afterCompact, false, `${key} should be omitted after pipeline`);
  }
  for (const key of ARTIFACT_KEPT_KEYS) {
    assert.ok(key in afterCompact, `${key} should survive pipeline`);
  }
});

// ---------------------------------------------------------------------------
// compactMappingResponse (P4) — table-driven
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

const MAPPING_OMIT_CASES = [
  {
    name: "resolved + count=1 + exact + confidence=1",
    overrides: {}
  },
  {
    name: "confidence is undefined (defaults to exact)",
    overrides: { candidates: [{ ...RESOLVED_EXACT_CANDIDATE, confidence: undefined }] }
  }
] as const;

const MAPPING_PRESERVE_CASES = [
  {
    name: "matchKind is not exact",
    overrides: { candidates: [{ ...RESOLVED_EXACT_CANDIDATE, matchKind: "simple-name" }] }
  },
  {
    name: "confidence < 1",
    overrides: { candidates: [{ ...RESOLVED_EXACT_CANDIDATE, confidence: 0.8 }] }
  },
  {
    name: "candidateCount > 1",
    overrides: {
      candidates: [RESOLVED_EXACT_CANDIDATE, { ...RESOLVED_EXACT_CANDIDATE, name: "Level2" }],
      candidateCount: 2
    }
  },
  {
    name: "candidatesTruncated is true",
    overrides: { candidatesTruncated: true }
  },
  {
    name: "count/length mismatch",
    overrides: { candidateCount: 5 }
  },
  {
    name: "ambiguous status",
    overrides: {
      resolved: false,
      status: "ambiguous",
      resolvedSymbol: undefined,
      candidates: [RESOLVED_EXACT_CANDIDATE, { ...RESOLVED_EXACT_CANDIDATE, name: "OtherLevel" }],
      candidateCount: 2
    }
  },
  {
    name: "candidates is not an array",
    overrides: { candidates: "not-an-array" }
  },
  {
    name: "candidates[0] is null",
    overrides: { candidates: [null] }
  }
] as const;

for (const { name, overrides } of MAPPING_OMIT_CASES) {
  test(`compactMappingResponse omits candidates when ${name}`, () => {
    const result = compactMappingResponse({ ...MAPPING_BASE, ...overrides });
    assert.equal("candidates" in result, false, "candidates should be omitted");
    assert.equal(result.candidateCount, 1, "candidateCount must survive");
    assert.ok(result.resolvedSymbol, "resolvedSymbol must survive");
  });
}

for (const { name, overrides } of MAPPING_PRESERVE_CASES) {
  test(`compactMappingResponse preserves candidates when ${name}`, () => {
    const result = compactMappingResponse({ ...MAPPING_BASE, ...overrides });
    assert.ok("candidates" in result, "candidates must be preserved");
  });
}

test("compactMappingResponse preserves candidates when candidateCount is absent", () => {
  const input = { ...MAPPING_BASE };
  delete input.candidateCount;
  const result = compactMappingResponse(input);
  assert.ok("candidates" in result);
});

test("compactMappingResponse preserves empty candidates for not_found (P1 strips later)", () => {
  const result = compactMappingResponse({
    ...MAPPING_BASE,
    resolved: false,
    status: "not_found",
    resolvedSymbol: undefined,
    candidates: [],
    candidateCount: 0
  });
  assert.ok("candidates" in result);
  assert.deepEqual(result.candidates, []);
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
  const serviceOutput: Record<string, unknown> = {
    querySymbol: { kind: "class", name: "com.example.Foo", symbol: "com.example.Foo" },
    mappingContext: { version: "1.21.10", sourceMapping: "obfuscated", sourcePriorityApplied: "loom-first" },
    resolved: false,
    status: "not_found",
    candidates: [],
    candidateCount: 0,
    warnings: []
  };

  const afterSplit = { ...serviceOutput };
  delete afterSplit.warnings;

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

// ---------------------------------------------------------------------------
// P5: Regression — size reduction threshold and idempotency
// ---------------------------------------------------------------------------

test("compactArtifactResponse reduces serialized size below 60% of full", () => {
  const full: Record<string, unknown> = {
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
  const compact = compactArtifactResponse(full);

  const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");

  assert.ok(
    compactBytes < fullBytes * 0.6,
    `compact (${compactBytes}B) should be < 60% of full (${fullBytes}B)`
  );
});

test("compactMappingResponse + compactResponse reduces serialized size for resolved result", () => {
  const full: Record<string, unknown> = {
    querySymbol: { kind: "class", name: "Level", symbol: "net.minecraft.world.level.Level" },
    mappingContext: { version: "1.21.10", sourceMapping: "mojang", targetMapping: "intermediary", sourcePriorityApplied: "loom-first" },
    resolved: true,
    status: "resolved",
    resolvedSymbol: { kind: "class", name: "class_310", symbol: "net.minecraft.class_310" },
    candidates: [{ kind: "class", name: "class_310", symbol: "net.minecraft.class_310", matchKind: "exact", confidence: 1 }],
    candidateCount: 1,
    candidatesTruncated: undefined
  };
  const compact = compactResponse(compactMappingResponse(full));

  const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");

  assert.ok(
    compactBytes < fullBytes,
    `compact (${compactBytes}B) should be smaller than full (${fullBytes}B)`
  );
});

test("compact projections are idempotent", () => {
  // compactResponse
  const compactInput = { a: 1, b: null, c: [], d: {}, e: "hello" };
  const compactOnce = compactResponse(compactInput);
  assert.deepEqual(compactOnce, compactResponse(compactOnce));

  // compactMappingResponse
  const mappingInput: Record<string, unknown> = {
    resolved: true,
    resolvedSymbol: { name: "Level", kind: "class" },
    candidates: [{ name: "Level", kind: "class", matchKind: "exact", confidence: 1 }],
    candidateCount: 1,
    querySymbol: { name: "Level" },
    mappingContext: { version: "1.21.10" }
  };
  const mappingOnce = compactMappingResponse(mappingInput);
  assert.deepEqual(mappingOnce, compactMappingResponse(mappingOnce));

  // compactArtifactResponse
  const artifactInput: Record<string, unknown> = {
    artifactId: "abc",
    origin: "remote-repo",
    isDecompiled: false,
    provenance: { source: "mojang" },
    artifactContents: { sourceKind: "source-jar" }
  };
  const artifactOnce = compactArtifactResponse(artifactInput);
  assert.deepEqual(artifactOnce, compactArtifactResponse(artifactOnce));
});
