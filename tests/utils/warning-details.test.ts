import assert from "node:assert/strict";
import test from "node:test";

import {
  SUMMARY_WARNING_DETAIL_CAP,
  capWarningDetailsForSummary,
  classifyWarnings
} from "../../src/warning-details.ts";

test("classifyWarnings maps each high-value family to a code/category/severity", () => {
  const [truncated, clamped, resource, namespace, coverage, general] = classifyWarnings([
    "Member list was truncated to 2 entries (from 9).",
    "maxMembers was clamped to 5000 from 9000.",
    "Indexed artifacts currently include Java source only; non-Java resources are not indexed.",
    "queryNamespace=mojang could not be applied because the artifact has no version recorded; namespace translation requires a version.",
    'Scope "merged" resolution failed; falling back to vanilla. Loom cache unavailable.',
    "Something entirely unrecognised happened."
  ]);

  assert.deepEqual(
    { code: truncated!.code, category: truncated!.category, severity: truncated!.severity },
    { code: "result_truncated", category: "pagination", severity: "info" }
  );
  assert.equal(clamped!.code, "input_clamped");
  assert.equal(clamped!.category, "validation");
  assert.equal(resource!.code, "resource_not_indexed");
  assert.equal(resource!.category, "coverage");
  assert.equal(namespace!.code, "namespace_fallback");
  assert.equal(namespace!.category, "mapping");
  assert.equal(namespace!.severity, "warning");
  assert.equal(coverage!.code, "partial_coverage");
  assert.equal(coverage!.category, "coverage");
  assert.equal(general!.code, "general");
  assert.equal(general!.category, "general");
});

test("classifyWarnings references each warning by index and omits the message text", () => {
  const warnings = ["Member list was truncated to 2 entries (from 9).", "plain note"];
  const details = classifyWarnings(warnings);
  assert.equal(details.length, warnings.length);
  // Text is not duplicated; each entry references meta.warnings[index] by position.
  assert.equal(details[0]!.index, 0);
  assert.equal(details[1]!.index, 1);
  assert.equal(warnings[details[0]!.index], warnings[0]);
  assert.equal(warnings[details[1]!.index], warnings[1]);
  assert.ok(!("message" in details[0]!));
  assert.ok(!("message" in details[1]!));
  // The truncation family advertises the fields a caller can tune.
  assert.ok(details[0]!.affectedFields?.includes("cursor"));
});

test("classifyWarnings classifies remap and mapping-lookup failures as mapping/warning", () => {
  const [remap, remapFailed, lookupFailed] = classifyWarnings([
    'Could not remap method "foo" from yarn to obfuscated.',
    'Remap failed for field "bar" from yarn to obfuscated.',
    'Mapping lookup failed for class "x" while preparing source lookup in obfuscated.'
  ]);
  for (const detail of [remap, remapFailed, lookupFailed]) {
    assert.equal(detail!.category, "mapping");
    assert.equal(detail!.severity, "warning");
    assert.notEqual(detail!.code, "general");
  }
});

test("classifyWarnings returns an empty array for no warnings", () => {
  assert.deepEqual(classifyWarnings([]), []);
});

test("classifyWarnings classifies the AGGREGATED remap warning as namespace_fallback", () => {
  // mapping-helpers now collapses N per-member remap failures into a single line;
  // the aggregated format must still classify as a mapping warning (not "general").
  const [aggRemap, aggFailed] = classifyWarnings([
    "Could not remap 12 methods from obfuscated to mojang (foo, bar, baz, +9 more).",
    "Remap failed for 3 fields from obfuscated to mojang (a, b, c)."
  ]);
  assert.equal(aggRemap!.code, "namespace_fallback");
  assert.equal(aggRemap!.category, "mapping");
  assert.equal(aggFailed!.code, "namespace_fallback");
  assert.equal(aggFailed!.category, "mapping");
});

test("capWarningDetailsForSummary caps the structured companion only at summary detail", () => {
  const many = classifyWarnings(
    Array.from({ length: SUMMARY_WARNING_DETAIL_CAP + 4 }, (_, i) => `plain note ${i}`)
  );

  // summary: capped to SUMMARY_WARNING_DETAIL_CAP, preserving leading entries + their indices.
  const summary = capWarningDetailsForSummary(many, true);
  assert.equal(summary.length, SUMMARY_WARNING_DETAIL_CAP);
  assert.equal(summary[0]!.index, 0);
  assert.equal(summary.at(-1)!.index, SUMMARY_WARNING_DETAIL_CAP - 1);

  // standard/full (isSummary=false): untouched, same array reference.
  assert.equal(capWarningDetailsForSummary(many, false), many);

  // At or below the cap: returned unchanged even at summary.
  const few = classifyWarnings(["a", "b"]);
  assert.equal(capWarningDetailsForSummary(few, true), few);
});
