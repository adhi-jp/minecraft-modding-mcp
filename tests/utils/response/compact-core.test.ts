import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  isCompactEnabled,
  COMPACT_ENABLED_TOOL_NAMES,
  COMPACT_MAPPING_TOOL_NAMES,
  COMPACT_SOURCE_TOOL_NAMES,
  COMPACT_MEMBERS_TOOL_NAMES,
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
