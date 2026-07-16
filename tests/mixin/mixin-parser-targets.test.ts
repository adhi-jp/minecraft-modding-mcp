import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { TARGET_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses @Mixin targets across supported annotation forms", () => {
  for (const testCase of TARGET_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.deepEqual(
      result.targets.map((entry) => entry.className),
      testCase.targets,
      `${testCase.name}: targets`
    );
    assert.equal(result.priority, testCase.priority, `${testCase.name}: priority`);
    if (testCase.className !== undefined) {
      assert.equal(result.className, testCase.className, `${testCase.name}: className`);
    }
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});

test("parseMixinSource captures class name from interface declaration", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  int getHealth();
}
`;
  const result = parseMixinSource(source);

  assert.equal(result.className, "PlayerAccessor");
});
