import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, "..", "docs", "tool-reference.md");

let cachedDoc: string | undefined;
async function loadDoc(): Promise<string> {
  if (!cachedDoc) {
    cachedDoc = await readFile(docPath, "utf8");
  }
  return cachedDoc;
}

test("tool-reference.md documents validate-mixin partial-success fields", async () => {
  const doc = await loadDoc();
  for (const field of [
    "targetOutcomes",
    "targetsDeferredBudget",
    "degradedReason"
  ]) {
    assert.ok(
      doc.includes(field),
      `tool-reference.md must mention validate-mixin field "${field}"`
    );
  }
});

test("tool-reference.md documents the new error codes", async () => {
  const doc = await loadDoc();
  for (const code of [
    "ERR_WORKER_RESTART",
    "ERR_MIXIN_PARSE_FAILED",
    "ERR_STAGE_BUDGET_PRE_PARSE",
    "ERR_WORKSPACE_VERSION_UNRESOLVED",
    "ERR_DEPENDENCY_VERSION_UNRESOLVED"
  ]) {
    assert.ok(doc.includes(code), `tool-reference.md must mention error code "${code}"`);
  }
});

test("tool-reference.md documents the workspace and dependency target shapes", async () => {
  const doc = await loadDoc();
  for (const token of [
    'kind: "workspace"',
    'kind: "dependency"',
    "provenance.workspaceResolution",
    "provenance.dependencyResolution"
  ]) {
    assert.ok(doc.includes(token), `tool-reference.md must mention "${token}"`);
  }
});

test("tool-reference.md documents meta.restart and meta.stageBudgetExhausted", async () => {
  const doc = await loadDoc();
  assert.ok(doc.includes("meta.restart"), "tool-reference.md must mention meta.restart");
  assert.ok(
    doc.includes("meta.stageBudgetExhausted"),
    "tool-reference.md must mention meta.stageBudgetExhausted"
  );
});

test("tool-reference.md documents the operational env toggles", async () => {
  const doc = await loadDoc();
  for (const toggle of [
    "MIXIN_STAGE_BUDGETS_OFF",
    "SUPERVISOR_STRUCTURED_RESTART_OFF",
    "MIXIN_STAGE_PROGRESS_OFF",
    "WORKSPACE_TARGET_OFF",
    "DEPENDENCY_TARGET_OFF",
    "WORKSPACE_FALLBACK_LEGACY",
    "VALIDATE_PROJECT_TASKS_OFF",
    "SUGGESTED_CALL_VALIDATE_OFF",
    "BATCH_TOOLS_OFF"
  ]) {
    assert.ok(doc.includes(toggle), `tool-reference.md must mention env toggle "${toggle}"`);
  }
});

test("tool-reference.md documents the batch lookup contract and 4 batch tools", async () => {
  const doc = await loadDoc();
  for (const token of [
    "Batch lookup contract",
    "## batch-class-source",
    "## batch-class-members",
    "## batch-symbol-exists",
    "## batch-mappings",
    "ERR_BATCH_ABORTED",
    "failFast",
    "sharedArtifactId"
  ]) {
    assert.ok(doc.includes(token), `tool-reference.md must mention batch-contract token "${token}"`);
  }
});

test("tool-reference.md documents the suggestedCall schema gate and exampleCalls fallback", async () => {
  const doc = await loadDoc();
  for (const token of [
    "schema validation gate",
    "exampleCalls",
    "suggested call payload failed schema validation; using fallback examples",
    "byte-identical"
  ]) {
    assert.ok(doc.includes(token), `tool-reference.md must mention suggestedCall gate token "${token}"`);
  }
});

test("tool-reference.md documents the validate-project per-task probe keys", async () => {
  const doc = await loadDoc();
  for (const probe of [
    "tasks",
    "workspace.detected",
    "gradle.readable",
    "loom.cache.found",
    "minecraft.artifact.resolved",
    "mixins.validated",
    "accessWideners.validated",
    "accessTransformers.validated"
  ]) {
    assert.ok(doc.includes(probe), `tool-reference.md must mention validate-project tasks key "${probe}"`);
  }
});

test("tool-reference.md documents the get-class-members status enum", async () => {
  const doc = await loadDoc();
  for (const value of ["\"ok\"", "\"members_unavailable\"", "\"partial\"", "unavailableReason", "MEMBERS_STATUS_LEGACY"]) {
    assert.ok(doc.includes(value), `tool-reference.md must mention get-class-members status token "${value}"`);
  }
});

test("tool-reference.md uses the real compare-minecraft class-diff task name", async () => {
  const doc = await loadDoc();
  // The schema enum is class-diff, not class.
  assert.ok(doc.includes('task="class-diff"'), 'tool-reference.md must reference task="class-diff"');
  assert.doesNotMatch(
    doc,
    /task="class"/,
    'tool-reference.md must not present the invalid task="class" (the enum value is "class-diff")'
  );
});

test("tool-reference.md batch-class-members status mirrors the real enum, not available/unavailable", async () => {
  const doc = await loadDoc();
  // Batch members mirror get-class-members status: ok | members_unavailable | partial.
  assert.doesNotMatch(
    doc,
    /"available"\s*\/\s*"unavailable"/,
    'batch-class-members must not claim "available"/"unavailable" status values'
  );
});

test("tool-reference.md tells callers to inspect analyze-mod metadata via detail=\"standard\"", async () => {
  const doc = await loadDoc();
  // The metadata block is surfaced by detail="standard", not include:["metadata"].
  assert.doesNotMatch(
    doc,
    /include:\s*\[\s*"metadata"\s*\]/,
    'analyze-mod metadata is not an include group; use detail="standard"'
  );
});

test("tool-reference.md documents the verify-mixin-target tool and accessorAdvice", async () => {
  const doc = await loadDoc();
  for (const token of [
    "verify-mixin-target",
    "accessorAdvice",
    "@Inject-only",
    "@Accessor",
    "@Invoker",
    "VERIFY_MIXIN_TARGET_OFF"
  ]) {
    assert.ok(doc.includes(token), `tool-reference.md must mention verify-mixin-target token "${token}"`);
  }
});

test("tool-reference.md preserves migration guidance for removed legacy tokens", async () => {
  const doc = await loadDoc();
  // Anchor on the removal context, not on the bare substring. If `official`
  // or `targetKind` is ever re-introduced as an active token (without the
  // removal phrase nearby), this test fails.
  assert.match(
    doc,
    /(removed|rejects?|fail|deprecated|legacy)[^\n]{0,120}`?official`?|`?official`?[^\n]{0,120}(removed|rejected?|fail|deprecat|legacy)/i,
    "tool-reference.md must keep the `official` migration note tied to a removal phrase"
  );
  assert.match(
    doc,
    /(removed|replace|migrat|deprecat|rename)[^\n]{0,120}`?targetKind`?|`?targetKind`?[^\n]{0,120}(removed|replace|migrat|deprecat|rename)/i,
    "tool-reference.md must keep the `targetKind` migration note tied to a removal/rename phrase"
  );
});
