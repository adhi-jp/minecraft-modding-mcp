import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { INJECTION_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses injection annotations and method arrays", () => {
  for (const testCase of INJECTION_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.injections.length, testCase.methods.length, `${testCase.name}: injection count`);
    assert.deepEqual(
      result.injections.map((entry) => entry.annotation),
      testCase.methods.map(() => testCase.annotation),
      `${testCase.name}: annotations`
    );
    assert.deepEqual(
      result.injections.map((entry) => entry.method),
      testCase.methods,
      `${testCase.name}: methods`
    );
    if (testCase.lines !== undefined) {
      assert.deepEqual(
        result.injections.map((entry) => entry.line),
        testCase.lines,
        `${testCase.name}: lines`
      );
    }
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});
