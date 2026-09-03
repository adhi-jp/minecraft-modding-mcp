import assert from "node:assert/strict";
import test from "node:test";

import type { DirectionIndex, PairKey } from "../../src/mapping/internal-types.ts";
import { parseTinyMappings } from "../../src/mapping/parsers/tiny.ts";

/**
 * A partially-named tiny rendering: `b` has an intermediary name but NO `named`
 * column, which is what a yarn file that has not yet named a class looks like.
 * Loom ships such files, so this is not a synthetic shape.
 */
const PARTIALLY_NAMED_TINY = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta\tclass_1\tAlpha",
  "\tm\t()V\tfoo\tmethod_1\tfooNamed",
  "c\tb\tclass_2",
  "\tm\t()V\tbar\tmethod_2\tbarNamed"
].join("\n");

function exactTargets(pairs: Map<PairKey, DirectionIndex>, pair: PairKey, key: string): string[] {
  return [...(pairs.get(pair)?.exact.get(key) ?? new Set<string>())].sort();
}

test("parseTinyMappings drops a namespace for the rest of a class whose column is empty", () => {
  const pairs = parseTinyMappings(PARTIALLY_NAMED_TINY);

  // `b` has no named column, so nothing about `b.bar()V` can be expressed in yarn.
  // Pre-fix the parser kept the PREVIOUS class's yarn name and registered
  // `method|Alpha|barNamed|()V` at confidence 1 — a member Alpha does not have.
  assert.deepEqual(
    exactTargets(pairs, "obfuscated->yarn", "b.bar()V"),
    [],
    "an unnamed class must not inherit the previous class's yarn name"
  );
  assert.deepEqual(exactTargets(pairs, "obfuscated->yarn", "b.bar"), []);
  assert.deepEqual(exactTargets(pairs, "intermediary->yarn", "class_2.method_2()V"), []);
  // The reverse direction invented a yarn member on Alpha too.
  assert.deepEqual(exactTargets(pairs, "yarn->obfuscated", "Alpha.barNamed()V"), []);

  // Alpha's own records are untouched.
  assert.deepEqual(exactTargets(pairs, "obfuscated->yarn", "a"), ["class||Alpha|"]);
  assert.deepEqual(exactTargets(pairs, "obfuscated->yarn", "a.foo()V"), ["method|Alpha|fooNamed|()V"]);
  assert.deepEqual(exactTargets(pairs, "yarn->obfuscated", "Alpha.fooNamed()V"), ["method|a|foo|()V"]);

  // Namespaces `b` DOES declare keep the correct owner.
  assert.deepEqual(exactTargets(pairs, "obfuscated->intermediary", "b.bar()V"), [
    "method|class_2|method_2|()V"
  ]);
  assert.deepEqual(exactTargets(pairs, "intermediary->obfuscated", "class_2.method_2()V"), [
    "method|b|bar|()V"
  ]);
});
