import assert from "node:assert/strict";
import test from "node:test";

import {
  compactResponse,
  compactMappingResponse
} from "../../../src/response-utils.ts";

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
  },
  {
    // resolve-method-mapping-exact is owner-strict, so a query whose owner declares the
    // method exactly once now RESOLVES and reports the single candidate the verdict was
    // computed from. That shape reaches this omit branch, where `candidates` is dropped
    // as provably redundant with `resolvedSymbol` — the caller keeps the answer and
    // `candidateCount: 1`, and loses only the duplicate.
    name: "an owner-strict method resolution reports its single verdict candidate",
    overrides: {
      querySymbol: { kind: "method", owner: "a.b.C", name: "e", descriptor: "(I)V" },
      resolvedSymbol: {
        kind: "method", owner: "inter.pkg.InterClass", name: "interMethod", descriptor: "(I)V"
      },
      candidates: [
        {
          kind: "method", owner: "inter.pkg.InterClass", name: "interMethod",
          symbol: "inter.pkg.InterClass.interMethod(I)V", descriptor: "(I)V",
          matchKind: "exact", confidence: 1
        }
      ],
      candidatesTruncated: undefined
    }
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
