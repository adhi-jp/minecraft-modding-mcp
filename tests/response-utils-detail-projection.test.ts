import assert from "node:assert/strict";
import test from "node:test";

import {
  projectByDetail,
  DEFAULT_DETAIL_BY_TOOL
} from "../src/response-utils.ts";

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
