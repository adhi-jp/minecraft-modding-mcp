import assert from "node:assert/strict";
import test from "node:test";

import {
  SUGGESTED_CALL_DEFAULTS,
  copyValidateMixinSharedParams,
  buildValidateMixinSuggestedParams
} from "../src/tool-guidance.ts";

// Regression for a review finding: SUGGESTED_CALL_DEFAULTS.reportMode
// must track the summary-first default introduced for validate-mixin, otherwise the
// suggestedCall default-omission inverts (an explicit "full" is dropped and the real
// default "summary-first" is retained as noise).
test("SUGGESTED_CALL_DEFAULTS.reportMode matches the validate-mixin summary-first default", () => {
  assert.equal(SUGGESTED_CALL_DEFAULTS.reportMode, "summary-first");
});

test("validate-mixin suggestedCall keeps an explicit reportMode='full' and omits the default 'summary-first'", () => {
  const full = copyValidateMixinSharedParams({ version: "1.21.10", reportMode: "full" });
  assert.equal(full.reportMode, "full", "explicit non-default reportMode must survive in the recovery suggestedCall");

  const omitted = copyValidateMixinSharedParams({ version: "1.21.10", reportMode: "summary-first" });
  assert.equal("reportMode" in omitted, false, "the default reportMode must be omitted to keep the suggestedCall lean");

  const compact = copyValidateMixinSharedParams({ version: "1.21.10", reportMode: "compact" });
  assert.equal(compact.reportMode, "compact", "other explicit non-default reportMode values must survive too");
});

test("buildValidateMixinSuggestedParams preserves an explicit reportMode='full' end to end", () => {
  const params = buildValidateMixinSuggestedParams({
    input: { mode: "inline", source: "class M {}" },
    version: "1.21.10",
    reportMode: "full"
  });
  assert.equal(params.reportMode, "full");
});
