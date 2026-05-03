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
    "ERR_STAGE_BUDGET_PRE_PARSE"
  ]) {
    assert.ok(doc.includes(code), `tool-reference.md must mention error code "${code}"`);
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
    "MIXIN_STAGE_PROGRESS_OFF"
  ]) {
    assert.ok(doc.includes(toggle), `tool-reference.md must mention env toggle "${toggle}"`);
  }
});
