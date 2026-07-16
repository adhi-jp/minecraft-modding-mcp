import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { SHADOW_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses @Shadow declarations across field and method forms", () => {
  for (const testCase of SHADOW_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.deepEqual(
      result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
      testCase.entries,
      `${testCase.name}: shadow entries`
    );
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});
