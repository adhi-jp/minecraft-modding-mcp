import assert from "node:assert/strict";
import test from "node:test";

import {
  scanBraceRange,
  computeLineBraceDepths,
  extractClassMetadata
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

test("extractClassMetadata folds the import block into one line with the count and 1-based range", () => {
  const source = [
    "package a;",
    "",
    "import java.util.List;",
    "import java.util.Map;",
    "// grouped below",
    "",
    "import static java.lang.Math.max;",
    "",
    "public class Demo {",
    "  private int count;",
    "}"
  ].join("\n");

  const outline = extractClassMetadata("a/Demo.java", source);
  assert.equal(
    outline,
    [
      "package a;",
      "",
      "// import lines omitted: 3 (lines 3-7)",
      "",
      "",
      "// [class] line 9",
      "public class Demo {",
      "// [field] line 10",
      "  private int count;"
    ].join("\n")
  );
  assert.equal(/^\s*import /m.test(outline), false, "no import statement is printed");
});

test("extractClassMetadata ignores import-looking comment lines and counts an import with a tab after the keyword", () => {
  const source = [
    "package a;",
    "/*",
    "import not.a.Real;",
    "*/",
    "import java.util.List;",
    "import\tjava.util.Map;",
    "",
    "public class Demo {",
    "}"
  ].join("\n");

  const outline = extractClassMetadata("a/Demo.java", source);
  assert.match(outline, /^\/\/ import lines omitted: 2 \(lines 5-6\)$/m);
  assert.equal(outline.includes("not.a.Real"), false);
  assert.equal(/^\s*import\s/m.test(outline), false);
});

test("extractClassMetadata prints no import fold line for a file without imports", () => {
  const source = ["package a;", "", "public class Demo {", "  int x;", "}"].join("\n");

  const outline = extractClassMetadata("a/Demo.java", source);
  assert.equal(outline.includes("import"), false);
  assert.equal(
    outline,
    ["package a;", "", "", "// [class] line 3", "public class Demo {", "// [field] line 4", "  int x;"].join("\n")
  );
});

test("extractClassMetadata keeps the package line in the header and lists only class members", () => {
  const source = [
    "package a;",
    "",
    "import java.util.List;",
    "",
    "public class Demo {",
    "  private int count;",
    "  public Demo(",
    "      int seed,",
    "      String name) {",
    "    int local = seed;",
    "  }",
    "  void run() {}",
    "}"
  ].join("\n");

  assert.equal(
    extractClassMetadata("a/Demo.java", source),
    [
      "package a;",
      "",
      "// import lines omitted: 1 (lines 3-3)",
      "",
      "",
      "// [class] line 5",
      "public class Demo {",
      "// [field] line 6",
      "  private int count;",
      "// [method] line 7",
      "  public Demo(int seed, String name) {",
      "// [method] line 12",
      "  void run() {}"
    ].join("\n")
  );
});

test("extractClassMetadata prints a record header once and joins a head whose brace is on the next line", () => {
  const source = [
    "public record Point(int x, int y) {",
    "  int sum()",
    "  {",
    "    return x + y;",
    "  }",
    "  abstract void load(Path path)",
    "      throws IOException;",
    "}"
  ].join("\n");

  assert.equal(
    extractClassMetadata("Point.java", source),
    [
      "",
      "// [record] line 1",
      "public record Point(int x, int y) {",
      "// [method] line 2",
      "  int sum() {",
      "// [method] line 6",
      "  abstract void load(Path path) throws IOException;"
    ].join("\n")
  );
});

test("extractClassMetadata ignores parentheses inside comments when finding a method head", () => {
  const source = [
    "class Demo {",
    "  void run(/* ( */ int x) {",
    "    // )",
    "    work();",
    "  }",
    "  void work() {}",
    "}"
  ].join("\n");

  assert.equal(
    extractClassMetadata("Demo.java", source),
    [
      "",
      "// [class] line 1",
      "class Demo {",
      "// [method] line 2",
      "  void run(/* ( */ int x) {",
      "// [method] line 6",
      "  void work() {}"
    ].join("\n")
  );
});

test("extractClassMetadata drops a line comment from a joined method head", () => {
  const source = [
    "class Demo {",
    "  void run(",
    "      int a, // first",
    "      int b) {",
    "  }",
    "}"
  ].join("\n");

  assert.equal(
    extractClassMetadata("Demo.java", source),
    [
      "",
      "// [class] line 1",
      "class Demo {",
      "// [method] line 2",
      "  void run(int a, int b) {"
    ].join("\n")
  );
});
