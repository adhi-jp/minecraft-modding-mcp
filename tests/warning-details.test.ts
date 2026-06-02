import assert from "node:assert/strict";
import test from "node:test";

import { classifyWarnings } from "../src/warning-details.ts";

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

test("classifyWarnings preserves the original message and is 1:1 with the input", () => {
  const warnings = ["Member list was truncated to 2 entries (from 9).", "plain note"];
  const details = classifyWarnings(warnings);
  assert.equal(details.length, warnings.length);
  assert.equal(details[0]!.message, warnings[0]);
  assert.equal(details[1]!.message, warnings[1]);
  // The truncation family advertises the fields a caller can tune.
  assert.ok(details[0]!.affectedFields?.includes("cursor"));
});

test("classifyWarnings returns an empty array for no warnings", () => {
  assert.deepEqual(classifyWarnings([]), []);
});
