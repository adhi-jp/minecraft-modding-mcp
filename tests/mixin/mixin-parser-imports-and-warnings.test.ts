import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { IMPORT_CASES, WARNING_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource extracts imports and ignores wildcard imports", () => {
  for (const testCase of IMPORT_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.imports.size, Object.keys(testCase.entries).length, `${testCase.name}: import count`);
    assert.deepEqual(
      Object.fromEntries(result.imports.entries()),
      testCase.entries,
      `${testCase.name}: imports`
    );
  }
});

test("parseMixinSource reports parse warnings for missing required annotations", () => {
  for (const testCase of WARNING_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.targets.length, testCase.expectedTargets, `${testCase.name}: target count`);
    if (testCase.expectedInjections !== undefined) {
      assert.equal(result.injections.length, testCase.expectedInjections, `${testCase.name}: injection count`);
    }
    assert.ok(
      result.parseWarnings.some((warning) => warning.includes(testCase.warningFragment)),
      `${testCase.name}: warning`
    );
  }
});
