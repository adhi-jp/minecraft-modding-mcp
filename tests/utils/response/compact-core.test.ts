import assert from "node:assert/strict";
import test from "node:test";

import {
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  DETAIL_ENABLED_TOOL_NAMES,
  COMPACT_MAPPING_TOOL_NAMES,
  COMPACT_LIGHT_TOOL_NAMES
} from "../../../src/response-utils.ts";

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

test("COMPACT_MAPPING_TOOL_NAMES is a subset of COMPACT_ENABLED_TOOL_NAMES", () => {
  for (const tool of COMPACT_MAPPING_TOOL_NAMES) {
    assert.equal(DETAIL_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in DETAIL_ENABLED`);
  }
});

test("COMPACT_LIGHT tool name set is a subset of DETAIL_ENABLED", () => {
  for (const tool of COMPACT_LIGHT_TOOL_NAMES) {
    assert.equal(DETAIL_ENABLED_TOOL_NAMES.has(tool), true, `${tool} should be in DETAIL_ENABLED`);
  }
});

test("projection tool name sets are pairwise disjoint", () => {
  const groups = [
    ["mapping", COMPACT_MAPPING_TOOL_NAMES],
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
  assert.equal(DETAIL_ENABLED_TOOL_NAMES.has("resolve-artifact"), true);
  assert.equal(COMPACT_MAPPING_TOOL_NAMES.has("resolve-artifact"), false);
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
