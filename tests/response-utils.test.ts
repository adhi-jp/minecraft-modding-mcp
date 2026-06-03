import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  compactSourceResponse,
  compactMembersResponse,
  compactLightResponse,
  stripSourceDiagnostics,
  stripMembersDiagnostics,
  isCompactEnabled,
  COMPACT_ENABLED_TOOL_NAMES,
  COMPACT_MAPPING_TOOL_NAMES,
  COMPACT_SOURCE_TOOL_NAMES,
  COMPACT_MEMBERS_TOOL_NAMES,
  COMPACT_LIGHT_TOOL_NAMES,
  TOOL_PRESERVE_PAYLOAD_KEYS,
  projectByDetail,
  DEFAULT_DETAIL_BY_TOOL
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
  assert.equal(isCompactEnabled("list-versions", { compact: true }), false);
  assert.equal(isCompactEnabled("get-runtime-metrics", { compact: true }), false);
  assert.equal(isCompactEnabled("get-artifact-file", { compact: true }), false);
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

test("compactMappingResponse slims unresolved candidates beyond the top-3 and flags candidateDetailsTruncated", () => {
  const makeCandidate = (name: string, extras: Record<string, unknown>): Record<string, unknown> => ({
    kind: "method",
    symbol: `net.minecraft.server.Main#${name}`,
    owner: "net.minecraft.server.Main",
    name,
    descriptor: "()V",
    matchKind: "owner-name",
    confidence: 0.6,
    // Heavy metadata that should NOT survive for tail entries
    provenance: { source: "tiny-v2", file: "mappings.tiny", line: 1234 },
    context: { owningClass: "Main", classAccessFlags: 1 },
    ...extras
  });
  const candidates = [
    makeCandidate("tick1", {}),
    makeCandidate("tick2", {}),
    makeCandidate("tick3", {}),
    makeCandidate("tick4", {}),
    makeCandidate("tick5", {})
  ];
  const input: Record<string, unknown> = {
    querySymbol: { kind: "method", name: "tick" },
    mappingContext: { version: "1.21.10" },
    resolved: false,
    status: "ambiguous",
    candidates,
    candidateCount: 5
  };

  const result = compactMappingResponse(input);
  assert.ok(Array.isArray(result.candidates));
  const projected = result.candidates as Array<Record<string, unknown>>;
  assert.equal(projected.length, 5);
  // Top 3 preserve full metadata.
  for (let i = 0; i < 3; i += 1) {
    assert.equal("provenance" in projected[i], true, `candidate ${i} should retain provenance`);
    assert.equal("context" in projected[i], true);
  }
  // Tail candidates are slim. The retained shape MUST stay aligned with the
  // `{kind, symbol, owner, name, descriptor, confidence, matchKind}` contract
  // documented in CHANGELOG.md, README.md, and docs/tool-reference.md.
  for (let i = 3; i < 5; i += 1) {
    assert.equal("provenance" in projected[i], false, `candidate ${i} should have provenance stripped`);
    assert.equal("context" in projected[i], false);
    for (const key of ["kind", "symbol", "owner", "name", "descriptor", "confidence", "matchKind"]) {
      assert.ok(key in projected[i], `tail candidate ${i} should retain \`${key}\``);
    }
  }
  // Tail slimming must not reuse `candidatesTruncated` (which means "more candidates exist
  // than are returned"). It sets `candidateDetailsTruncated` instead, and leaves
  // `candidatesTruncated` untouched so list-level truncation keeps its original meaning.
  assert.equal(result.candidateDetailsTruncated, true);
  assert.equal(result.candidatesTruncated, undefined);
});

test("compactMappingResponse preserves upstream candidatesTruncated when tail slimming also fires", () => {
  // If the server truncated the list upstream (maxCandidates clipped it) AND the returned
  // slice still exceeds the top-3 detail limit, the response must keep both signals: the
  // caller learns that more matches exist (candidatesTruncated) and that tail entries were
  // slimmed (candidateDetailsTruncated).
  const makeCandidate = (name: string): Record<string, unknown> => ({
    kind: "method",
    owner: "net.minecraft.server.Main",
    name,
    descriptor: "()V",
    matchKind: "owner-name",
    confidence: 0.6,
    provenance: { source: "tiny-v2" }
  });
  const input: Record<string, unknown> = {
    querySymbol: { kind: "method", name: "tick" },
    mappingContext: { version: "1.21.10" },
    resolved: false,
    status: "ambiguous",
    candidates: [
      makeCandidate("tick1"),
      makeCandidate("tick2"),
      makeCandidate("tick3"),
      makeCandidate("tick4"),
      makeCandidate("tick5")
    ],
    candidateCount: 20,
    candidatesTruncated: true
  };
  const result = compactMappingResponse(input);
  assert.equal(result.candidatesTruncated, true, "upstream list truncation is preserved verbatim");
  assert.equal(result.candidateDetailsTruncated, true, "tail slimming is reported independently");
  assert.equal(result.candidateCount, 20);
});

test("compactMappingResponse leaves small unresolved candidate arrays untouched", () => {
  const input: Record<string, unknown> = {
    querySymbol: { kind: "method", name: "tick" },
    mappingContext: { version: "1.21.10" },
    resolved: false,
    status: "ambiguous",
    candidates: [
      { name: "tick1", provenance: { source: "tiny" } },
      { name: "tick2", provenance: { source: "tiny" } }
    ],
    candidateCount: 2
  };
  const before = JSON.stringify(input);
  const result = compactMappingResponse(input);
  // Small lists (<=3) keep full shape and do not mark either truncation signal.
  assert.equal(result.candidatesTruncated, undefined);
  assert.equal(result.candidateDetailsTruncated, undefined);
  assert.equal(JSON.stringify(result), before);
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

test("COMPACT_SOURCE / MEMBERS / LIGHT tool name sets are subsets of COMPACT_ENABLED", () => {
  for (const tool of COMPACT_SOURCE_TOOL_NAMES) {
    assert.equal(COMPACT_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in COMPACT_ENABLED`);
  }
  for (const tool of COMPACT_MEMBERS_TOOL_NAMES) {
    assert.equal(COMPACT_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in COMPACT_ENABLED`);
  }
  for (const tool of COMPACT_LIGHT_TOOL_NAMES) {
    assert.equal(COMPACT_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in COMPACT_ENABLED`);
  }
});

test("projection tool name sets are pairwise disjoint", () => {
  const groups = [
    ["mapping", COMPACT_MAPPING_TOOL_NAMES],
    ["source", COMPACT_SOURCE_TOOL_NAMES],
    ["members", COMPACT_MEMBERS_TOOL_NAMES],
    ["light", COMPACT_LIGHT_TOOL_NAMES]
  ] as const;
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      for (const tool of groups[i][1]) {
        assert.equal(
          groups[j][1].has(tool),
          false,
          `${tool} must not appear in both ${groups[i][0]} and ${groups[j][0]}`
        );
      }
    }
  }
});

test("resolve-artifact is in COMPACT_ENABLED but not in COMPACT_MAPPING", () => {
  assert.equal(COMPACT_ENABLED_TOOL_NAMES.has("resolve-artifact"), true);
  assert.equal(COMPACT_MAPPING_TOOL_NAMES.has("resolve-artifact"), false);
});

// ---------------------------------------------------------------------------
// compactSourceResponse (get-class-source)
// ---------------------------------------------------------------------------

const SOURCE_FIXTURE: Record<string, unknown> = {
  className: "net.minecraft.world.entity.player.Player",
  mode: "snippet",
  sourceText: "public class Player {}",
  totalLines: 10,
  returnedRange: { start: 1, end: 10 },
  truncated: false,
  origin: "remote-repo",
  artifactId: "artifact-1.21.10-mojang",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  returnedNamespace: "mojang",
  provenance: { target: { kind: "version", value: "1.21.10" }, resolvedAt: "2026-04-18T00:00:00Z", resolvedFrom: { origin: "remote-repo" }, transformChain: ["mapping:mojang-source-backed"] },
  qualityFlags: ["source-jar"],
  artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" }
};

test("compactSourceResponse omits provenance / artifactContents / qualityFlags and preserves payload", () => {
  const result = compactSourceResponse(SOURCE_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags"]) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
  for (const key of [
    "className", "mode", "sourceText", "totalLines", "returnedRange", "truncated",
    "origin", "artifactId", "requestedMapping", "mappingApplied", "returnedNamespace"
  ]) {
    assert.ok(key in result, `${key} should survive compact`);
  }
  assert.equal(result.sourceText, SOURCE_FIXTURE.sourceText);
});

test("compactSourceResponse is idempotent and passes through unknown keys", () => {
  const input = { ...SOURCE_FIXTURE, customField: "extra" };
  const once = compactSourceResponse(input);
  assert.deepEqual(once, compactSourceResponse(once));
  assert.equal(once.customField, "extra");
});

test("stripSourceDiagnostics omits the 3 diagnostics by default while keeping source payload", () => {
  const result = stripSourceDiagnostics(SOURCE_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags"]) {
    assert.equal(key in result, false, `${key} should be omitted by default`);
  }
  for (const key of ["className", "sourceText", "origin", "artifactId"]) {
    assert.ok(key in result, `${key} should survive the default strip`);
  }
  // Idempotent w.r.t. a later compact pass.
  assert.deepEqual(stripSourceDiagnostics(result), result);
});

// ---------------------------------------------------------------------------
// compactMembersResponse (get-class-members)
// ---------------------------------------------------------------------------

const MEMBERS_FIXTURE: Record<string, unknown> = {
  className: "net.minecraft.world.entity.player.Player",
  members: { constructors: [], fields: [], methods: [{ name: "tick", javaSignature: "tick()V" }] },
  counts: { constructors: 0, fields: 0, methods: 1, total: 1 },
  truncated: false,
  context: { minecraftVersion: "1.21.10", mappingType: "mojang", mappingNamespace: "mojang", jarHash: "deadbeef", generatedAt: "2026-04-18T00:00:00Z" },
  origin: "remote-repo",
  artifactId: "artifact-1.21.10-mojang",
  requestedMapping: "mojang",
  mappingApplied: "mojang",
  returnedNamespace: "mojang",
  provenance: { target: { kind: "version", value: "1.21.10" }, resolvedAt: "2026-04-18T00:00:00Z", resolvedFrom: { origin: "remote-repo" }, transformChain: ["mapping:mojang-source-backed"] },
  qualityFlags: ["source-jar"],
  artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" }
};

test("compactMembersResponse omits context + metadata and preserves members/counts", () => {
  const result = compactMembersResponse(MEMBERS_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags", "context"]) {
    assert.equal(key in result, false, `${key} should be omitted`);
  }
  for (const key of [
    "className", "members", "counts", "truncated",
    "origin", "artifactId", "requestedMapping", "mappingApplied", "returnedNamespace"
  ]) {
    assert.ok(key in result, `${key} should survive compact`);
  }
  assert.deepEqual(result.counts, MEMBERS_FIXTURE.counts);
});

test("stripMembersDiagnostics omits the 3 diagnostics by default but KEEPS context", () => {
  const result = stripMembersDiagnostics(MEMBERS_FIXTURE);
  for (const key of ["provenance", "artifactContents", "qualityFlags"]) {
    assert.equal(key in result, false, `${key} should be omitted by default`);
  }
  // Unlike compactMembersResponse, the default strip retains members `context`.
  assert.ok("context" in result, "context must survive the default (non-compact) strip");
  for (const key of ["className", "members", "counts"]) {
    assert.ok(key in result, `${key} should survive the default strip`);
  }
});

test("compactMembersResponse preserves decompiledFallback and decompiledMemberCounts", () => {
  const withFallback = {
    ...MEMBERS_FIXTURE,
    decompiledFallback: { constructors: [], fields: [], methods: [{ name: "tick", line: 10, kind: "method" }], origin: "source-extracted" },
    decompiledMemberCounts: { constructors: 0, fields: 0, methods: 1, total: 1 }
  };
  const result = compactMembersResponse(withFallback);
  assert.ok("decompiledFallback" in result);
  assert.ok("decompiledMemberCounts" in result);
});

// ---------------------------------------------------------------------------
// compactLightResponse (search-class-source / list-artifact-files)
// ---------------------------------------------------------------------------

test("compactLightResponse drops artifactContents only", () => {
  const input: Record<string, unknown> = {
    hits: [{ filePath: "a.java", score: 1, matchedIn: "symbol", reasonCodes: [] }],
    nextCursor: "cursor-1",
    mappingApplied: "mojang",
    returnedNamespace: "mojang",
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const result = compactLightResponse(input);
  assert.equal("artifactContents" in result, false);
  for (const key of ["hits", "nextCursor", "mappingApplied", "returnedNamespace", "warnings"]) {
    assert.ok(key in result, `${key} should survive compact`);
  }
});

test("compactLightResponse on list-artifact-files shape", () => {
  const input: Record<string, unknown> = {
    items: ["net/minecraft/Example.java"],
    mappingApplied: "mojang",
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const result = compactLightResponse(input);
  assert.equal("artifactContents" in result, false);
  assert.deepEqual(result.items, ["net/minecraft/Example.java"]);
});

// ---------------------------------------------------------------------------
// Pipeline: projection + compactResponse drops empty warnings / nextCursor
// ---------------------------------------------------------------------------

test("compactSourceResponse + compactResponse pipeline strips empty warnings", () => {
  const input: Record<string, unknown> = {
    ...SOURCE_FIXTURE,
    warnings: []
  };
  const projected = compactSourceResponse(input);
  const compacted = compactResponse(projected);
  assert.equal("warnings" in compacted, false, "empty warnings should be stripped by compactResponse");
  assert.equal("provenance" in compacted, false);
  assert.equal("sourceText" in compacted, true);
});

test("compactLightResponse + compactResponse pipeline strips absent nextCursor and empty warnings", () => {
  const input: Record<string, unknown> = {
    hits: [{ filePath: "a.java", score: 1, matchedIn: "symbol", reasonCodes: [] }],
    nextCursor: undefined,
    mappingApplied: "mojang",
    returnedNamespace: "mojang",
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: ["class"], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const compacted = compactResponse(compactLightResponse(input));
  assert.equal("artifactContents" in compacted, false);
  assert.equal("warnings" in compacted, false);
  assert.equal("nextCursor" in compacted, false);
  assert.ok("hits" in compacted);
});

// ---------------------------------------------------------------------------
// preserveKeys regression — empty primary payload must not be stripped
// ---------------------------------------------------------------------------

test("compactResponse preserveKeys keeps empty arrays/objects listed in the set", () => {
  const result = compactResponse(
    { hits: [], warnings: [], mappingApplied: "mojang" },
    new Set(["hits"])
  );
  assert.ok("hits" in result, "hits must survive even when empty");
  assert.deepEqual(result.hits, []);
  assert.equal("warnings" in result, false, "warnings still stripped");
  assert.equal(result.mappingApplied, "mojang");
});

test("compactResponse preserveKeys still drops null/undefined values", () => {
  // Optional payload fields that are absent must not leak through as explicit null.
  const result = compactResponse(
    { hits: null, items: undefined, warnings: [] },
    new Set(["hits", "items"])
  );
  assert.equal("hits" in result, false, "null preserved-key still stripped");
  assert.equal("items" in result, false, "undefined preserved-key still stripped");
});

test("TOOL_PRESERVE_PAYLOAD_KEYS covers zero-result primary-payload tools", () => {
  assert.ok(TOOL_PRESERVE_PAYLOAD_KEYS["search-class-source"]?.has("hits"));
  assert.ok(TOOL_PRESERVE_PAYLOAD_KEYS["list-artifact-files"]?.has("items"));
  assert.ok(TOOL_PRESERVE_PAYLOAD_KEYS["get-class-members"]?.has("members"));
  assert.ok(TOOL_PRESERVE_PAYLOAD_KEYS["get-class-members"]?.has("counts"));
});

test("compactLightResponse + compactResponse preserves empty hits for search-class-source", () => {
  const input: Record<string, unknown> = {
    hits: [],
    mappingApplied: "mojang",
    returnedNamespace: "mojang",
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const projected = compactLightResponse(input);
  const compacted = compactResponse(projected, TOOL_PRESERVE_PAYLOAD_KEYS["search-class-source"]);
  assert.ok("hits" in compacted, "empty hits must survive full pipeline");
  assert.deepEqual(compacted.hits, []);
  assert.equal("artifactContents" in compacted, false);
  assert.equal("warnings" in compacted, false);
});

test("compactLightResponse + compactResponse preserves empty items for list-artifact-files", () => {
  const input: Record<string, unknown> = {
    items: [],
    mappingApplied: "mojang",
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const projected = compactLightResponse(input);
  const compacted = compactResponse(projected, TOOL_PRESERVE_PAYLOAD_KEYS["list-artifact-files"]);
  assert.ok("items" in compacted);
  assert.deepEqual(compacted.items, []);
});

test("compactMembersResponse + compactResponse preserves empty member buckets", () => {
  // Defensive coverage: service currently returns { constructors, fields, methods }
  // (non-empty object, not subject to compact stripping), but if a future refactor
  // returned `members: {}` for a class with zero members, the preserveKeys guard
  // keeps the field in place.
  const input: Record<string, unknown> = {
    className: "net.minecraft.Empty",
    members: {},
    counts: { constructors: 0, fields: 0, methods: 0, total: 0 },
    artifactContents: { sourceKind: "source-jar", indexedContentKinds: [], resourcesIncluded: false, sourceCoverage: "full" },
    warnings: []
  };
  const projected = compactMembersResponse(input);
  const compacted = compactResponse(projected, TOOL_PRESERVE_PAYLOAD_KEYS["get-class-members"]);
  assert.ok("members" in compacted, "empty members object must survive");
  assert.ok("counts" in compacted);
  assert.equal("artifactContents" in compacted, false);
});

test("compactSourceResponse reduces serialized size vs full response", () => {
  const compact = compactSourceResponse(SOURCE_FIXTURE);
  const fullBytes = Buffer.byteLength(JSON.stringify(SOURCE_FIXTURE), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  assert.ok(
    compactBytes < fullBytes,
    `compact (${compactBytes}B) should be smaller than full (${fullBytes}B)`
  );
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

// ---------------------------------------------------------------------------
// projectByDetail — detail/include projection replacing the compact boolean
// ---------------------------------------------------------------------------

test("projectByDetail get-class-source: summary strips diagnostics + empties; standard strips diagnostics only; full keeps all", () => {
  const base = () => ({
    sourceText: "class A {}",
    provenance: { a: 1 },
    artifactContents: { b: 2 },
    qualityFlags: ["x"],
    emptyArr: [] as unknown[]
  });
  const empty = new Set<string>();

  const summary = projectByDetail("get-class-source", base(), "summary", empty);
  assert.equal("provenance" in summary, false);
  assert.equal("artifactContents" in summary, false);
  assert.equal("qualityFlags" in summary, false);
  assert.equal("emptyArr" in summary, false, "summary strips empty arrays");
  assert.equal(summary.sourceText, "class A {}");

  const standard = projectByDetail("get-class-source", base(), "standard", empty);
  assert.equal("provenance" in standard, false, "standard still drops diagnostics (Phase-4 default)");
  assert.equal("emptyArr" in standard, true, "standard keeps empty arrays (no empty-strip)");

  const full = projectByDetail("get-class-source", base(), "full", empty);
  assert.equal(full.provenance !== undefined, true, "full keeps diagnostics");
  assert.equal(full.artifactContents !== undefined, true);
  assert.equal(full.qualityFlags !== undefined, true);

  // include:["provenance"] re-adds diagnostics even at standard.
  const withProv = projectByDetail("get-class-source", base(), "standard", new Set(["provenance"]));
  assert.equal(withProv.provenance !== undefined, true);
});

test("projectByDetail get-class-members: summary drops context too; standard keeps context", () => {
  const base = () => ({
    members: [{ name: "x" }],
    context: { c: 1 },
    provenance: { p: 1 }
  });
  const summary = projectByDetail("get-class-members", base(), "summary", new Set());
  assert.equal("context" in summary, false, "summary drops members context");
  assert.equal("provenance" in summary, false);
  const standard = projectByDetail("get-class-members", base(), "standard", new Set());
  assert.equal("context" in standard, true, "standard keeps context");
  assert.equal("provenance" in standard, false);
});

test("projectByDetail mapping tools: summary slims/omits candidates; standard keeps full candidates", () => {
  const resolved = () => ({
    resolved: true,
    resolvedSymbol: { kind: "class", name: "b.B" },
    candidateCount: 1,
    candidates: [{ kind: "class", symbol: { kind: "class", name: "b.B" }, name: "b.B", matchKind: "exact", confidence: 1 }]
  });
  const summary = projectByDetail("find-mapping", resolved(), "summary", new Set());
  assert.equal("candidates" in summary, false, "summary omits the redundant lone exact candidate");
  const standard = projectByDetail("find-mapping", resolved(), "standard", new Set());
  assert.ok(Array.isArray(standard.candidates), "standard keeps full candidates");
  // include:["candidates"] keeps them even at summary.
  const withCands = projectByDetail("find-mapping", resolved(), "summary", new Set(["candidates"]));
  assert.ok(Array.isArray(withCands.candidates));
});

test("projectByDetail resolve-artifact: summary omits diagnostics; include re-adds protected fields", () => {
  const base = () => ({
    artifactId: "a",
    provenance: { x: 1 },
    artifactContents: { y: 2 },
    coordinate: "g:a:1",
    binaryJarPath: "/tmp/a.jar"
  });
  const summary = projectByDetail("resolve-artifact", base(), "summary", new Set());
  assert.equal("provenance" in summary, false);
  assert.equal("coordinate" in summary, false);
  const withPaths = projectByDetail("resolve-artifact", base(), "summary", new Set(["paths"]));
  assert.equal(withPaths.coordinate, "g:a:1", "include:[paths] re-adds coordinate/binaryJarPath");
  assert.equal(withPaths.binaryJarPath, "/tmp/a.jar");
  assert.equal("provenance" in withPaths, false, "paths does not re-add provenance");
});

test("DEFAULT_DETAIL_BY_TOOL: resolution/mapping default summary, source/file default standard", () => {
  assert.equal(DEFAULT_DETAIL_BY_TOOL["resolve-artifact"], "summary");
  assert.equal(DEFAULT_DETAIL_BY_TOOL["check-symbol-exists"], "summary");
  assert.equal(DEFAULT_DETAIL_BY_TOOL["get-class-source"], "standard");
  assert.equal(DEFAULT_DETAIL_BY_TOOL["get-class-members"], "standard");
  assert.equal(DEFAULT_DETAIL_BY_TOOL["search-class-source"], "standard");
});
