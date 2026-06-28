import assert from "node:assert/strict";
import test from "node:test";

import {
  validateInjection,
  validateShadow,
  validateAccessor
} from "../src/mixin-validator.ts";

// validateInjection/validateShadow/validateAccessor are the per-annotation
// helpers that validateParsedMixin delegates to; their behavior is exercised in
// full by the validateParsedMixin table tests in mixin-validator.test.ts. This
// file only guards that the public re-exports stay wired up (and callable).
test("mixin-validator re-exports the per-annotation validation helpers as functions", () => {
  assert.equal(typeof validateInjection, "function");
  assert.equal(typeof validateShadow, "function");
  assert.equal(typeof validateAccessor, "function");
});
