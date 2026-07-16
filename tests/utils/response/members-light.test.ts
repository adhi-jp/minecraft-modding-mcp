import assert from "node:assert/strict";
import test from "node:test";

import {
  compactResponse,
  compactMembersResponse,
  compactLightResponse,
  stripMembersDiagnostics,
  TOOL_PRESERVE_PAYLOAD_KEYS
} from "../../../src/response-utils.ts";

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
