import assert from "node:assert/strict";
import test from "node:test";

import {
  scanBraceRange,
  computeLineBraceDepths
} from "../../src/source/class-source-helpers.ts";

test("scanBraceRange ignores braces inside char literals", () => {
  const lines = [
    "public class Foo {",
    "  char open = '{';",
    "  void m() {}",
    "}",
    "// trailing"
  ];
  const range = scanBraceRange(lines, 1);
  assert.equal(range.endLine, 4, "the '{' char literal must not inflate brace depth");
});

test("scanBraceRange ignores braces inside multi-line block comments", () => {
  const lines = [
    "public class Foo {",
    "  /* this } is",
    "     a } comment { */",
    "  void m() {}",
    "}"
  ];
  const range = scanBraceRange(lines, 1);
  assert.equal(range.endLine, 5, "braces inside the block comment must be ignored");
});

test("computeLineBraceDepths ignores braces in char literals and block comments", () => {
  const lines = [
    "class Foo {",       // depth before: 0
    "  char c = '}';",   // depth before: 1 (the '}' must not decrement)
    "  /* { { */",       // depth before: 1
    "  int x = 1;",      // depth before: 1
    "}"                  // depth before: 1
  ];
  const depths = computeLineBraceDepths(lines);
  assert.deepEqual(depths, [0, 1, 1, 1, 1]);
});
