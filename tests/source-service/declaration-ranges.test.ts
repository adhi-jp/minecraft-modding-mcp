import assert from "node:assert/strict";
import test from "node:test";

import { findEnclosingSymbol } from "../../src/source/declaration-ranges.ts";

// Every expected start and end line below is read off the numbered fixture text by hand.

function enclosingAt(lines: string[], line: number) {
  return findEnclosingSymbol("p/Fixture.java", lines.join("\n"), line);
}

test("a hit in a wrapped parameter list or body belongs to the method; its range runs from its name line to its closing brace", () => {
  const source = [
    "package p;", //               1
    "class Calc {", //             2
    "  int add(", //               3
    "      int first,", //         4
    "      int second) {", //      5
    "    return first + second;", // 6
    "  }", //                      7
    "}" //                         8
  ];
  const add = { symbolKind: "method", symbolName: "add", startLine: 3, endLine: 7 };
  assert.deepEqual(enclosingAt(source, 4), add);
  assert.deepEqual(enclosingAt(source, 6), add);
  assert.deepEqual(enclosingAt(source, 7), add);
  assert.deepEqual(enclosingAt(source, 2), { symbolKind: "class", symbolName: "Calc", startLine: 2, endLine: 8 });
});

test("a hit between the members of a nested class belongs to the nested class, and a field ends at its semicolon", () => {
  const source = [
    "package p;", //               1
    "class Outer {", //            2
    "  int a;", //                 3
    "  static class Inner {", //   4
    "    int b;", //               5
    "", //                         6
    "  }", //                      7
    "  int c;", //                 8
    "}" //                         9
  ];
  const inner = { symbolKind: "class", symbolName: "Inner", startLine: 4, endLine: 7 };
  assert.deepEqual(enclosingAt(source, 4), inner);
  assert.deepEqual(enclosingAt(source, 6), inner);
  assert.deepEqual(enclosingAt(source, 7), inner);
  assert.deepEqual(enclosingAt(source, 5), { symbolKind: "field", symbolName: "b", startLine: 5, endLine: 5 });
  assert.deepEqual(enclosingAt(source, 8), { symbolKind: "field", symbolName: "c", startLine: 8, endLine: 8 });
  assert.deepEqual(enclosingAt(source, 9), { symbolKind: "class", symbolName: "Outer", startLine: 2, endLine: 9 });
});

test("a hit inside a lambda belongs to the method the lambda is written in", () => {
  const source = [
    "package p;", //                     1
    "class L {", //                      2
    "  void run() {", //                 3
    "    Runnable r = () -> {", //       4
    "      System.out.println(1);", //   5
    "    };", //                         6
    "    r.run();", //                   7
    "  }", //                            8
    "}" //                               9
  ];
  const run = { symbolKind: "method", symbolName: "run", startLine: 3, endLine: 8 };
  assert.deepEqual(enclosingAt(source, 5), run);
  assert.deepEqual(enclosingAt(source, 7), run);
});

test("inside an anonymous class a hit belongs to its method, its field, or else to the member whose initializer holds it", () => {
  const source = [
    "package p;", //                         1
    "class N {", //                          2
    "  Object o = new Object() {", //        3
    "    int inner = 1;", //                 4
    "", //                                   5
    "    public String toString() {", //     6
    "      return \"x\";", //                7
    "    }", //                              8
    "  };", //                               9
    "  int after;", //                       10
    "}" //                                   11
  ];
  const o = { symbolKind: "field", symbolName: "o", startLine: 3, endLine: 9 };
  assert.deepEqual(enclosingAt(source, 7), { symbolKind: "method", symbolName: "toString", startLine: 6, endLine: 8 });
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "field", symbolName: "inner", startLine: 4, endLine: 4 });
  assert.deepEqual(enclosingAt(source, 3), o);
  assert.deepEqual(enclosingAt(source, 5), o);
  assert.deepEqual(enclosingAt(source, 9), o);
  assert.deepEqual(enclosingAt(source, 10), { symbolKind: "field", symbolName: "after", startLine: 10, endLine: 10 });
});

test("a hit on any line of a wrapped record header belongs to the record, while a field in the record body stays a candidate", () => {
  const source = [
    "package p;", //               1
    "public record R(", //         2
    "    int x,", //               3
    "    String y", //             4
    ") {", //                      5
    "  static int Z = 1;", //      6
    "", //                         7
    "}" //                         8
  ];
  const record = { symbolKind: "record", symbolName: "R", startLine: 2, endLine: 8 };
  for (const line of [2, 3, 4, 5, 7, 8]) {
    assert.deepEqual(enclosingAt(source, line), record, `line ${line}`);
  }
  assert.deepEqual(enclosingAt(source, 6), { symbolKind: "field", symbolName: "Z", startLine: 6, endLine: 6 });
});

test("in an enum, a hit in a constant body's method belongs to that method and a hit on a constant line belongs to the enum", () => {
  const source = [
    "package p;", //             1
    "enum E {", //               2
    "  A(1) {", //               3
    "    void m() {", //         4
    "      work();", //          5
    "    }", //                  6
    "  },", //                   7
    "  B(2);", //                8
    "", //                       9
    "  E(int v) {", //           10
    "  }", //                    11
    "}" //                       12
  ];
  const enumE = { symbolKind: "enum", symbolName: "E", startLine: 2, endLine: 12 };
  assert.deepEqual(enclosingAt(source, 5), { symbolKind: "method", symbolName: "m", startLine: 4, endLine: 6 });
  assert.deepEqual(enclosingAt(source, 3), enumE);
  assert.deepEqual(enclosingAt(source, 7), enumE);
  assert.deepEqual(enclosingAt(source, 8), enumE);
  assert.deepEqual(enclosingAt(source, 11), { symbolKind: "method", symbolName: "E", startLine: 10, endLine: 11 });
});

test("a multi-line field initializer, including a lambda body and a wrapped expression, is inside the field's range", () => {
  const source = [
    "package p;", //                                 1
    "class F {", //                                  2
    "  static final Runnable TASK = () -> {", //     3
    "    System.out.println(\"tick\");", //          4
    "  };", //                                       5
    "  static final int SUM = 1", //                 6
    "      + 2;", //                                 7
    "  int next;", //                                8
    "}" //                                           9
  ];
  const task = { symbolKind: "field", symbolName: "TASK", startLine: 3, endLine: 5 };
  assert.deepEqual(enclosingAt(source, 4), task);
  assert.deepEqual(enclosingAt(source, 5), task);
  assert.deepEqual(enclosingAt(source, 7), { symbolKind: "field", symbolName: "SUM", startLine: 6, endLine: 7 });
  assert.deepEqual(enclosingAt(source, 8), { symbolKind: "field", symbolName: "next", startLine: 8, endLine: 8 });
});

test("braces inside a text block do not end the method or the class early", () => {
  const source = [
    "package p;", //               1
    "class T {", //                2
    "  String text() {", //        3
    "    return \"\"\"", //        4
    "        }", //                5
    "        }", //                6
    "        \"\"\";", //          7
    "  }", //                      8
    "  void after() {", //         9
    "  }", //                      10
    "}" //                         11
  ];
  const text = { symbolKind: "method", symbolName: "text", startLine: 3, endLine: 8 };
  assert.deepEqual(enclosingAt(source, 6), text);
  assert.deepEqual(enclosingAt(source, 7), text);
  assert.deepEqual(enclosingAt(source, 10), { symbolKind: "method", symbolName: "after", startLine: 9, endLine: 10 });
  assert.equal(enclosingAt(source, 11)?.endLine, 11);
});

test("braces in a parameter annotation's array argument do not open the method body", () => {
  const source = [
    "package p;", //                                 1
    "class A {", //                                  2
    "  void handle(@Tags({1, 2}) int value) {", //   3
    "    use(value);", //                            4
    "  }", //                                        5
    "  int after;", //                               6
    "}" //                                           7
  ];
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "method", symbolName: "handle", startLine: 3, endLine: 5 });
  assert.deepEqual(enclosingAt(source, 6), { symbolKind: "field", symbolName: "after", startLine: 6, endLine: 6 });
});

test("a body-less method ends at its semicolon, so the next line belongs to the enclosing type or the following member", () => {
  const source = [
    "package p;", //                     1
    "abstract class B {", //             2
    "  abstract void first();", //       3
    "", //                               4
    "  void second() {", //              5
    "  }", //                            6
    "}" //                               7
  ];
  assert.deepEqual(enclosingAt(source, 3), { symbolKind: "method", symbolName: "first", startLine: 3, endLine: 3 });
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "class", symbolName: "B", startLine: 2, endLine: 7 });
  assert.deepEqual(enclosingAt(source, 5), { symbolKind: "method", symbolName: "second", startLine: 5, endLine: 6 });
});

test("a hit in a static or instance initializer block belongs to the enclosing type", () => {
  const source = [
    "package p;", //         1
    "class I {", //          2
    "  static int x;", //    3
    "  static {", //         4
    "    x = 1;", //         5
    "  }", //                6
    "  {", //                7
    "    x = 2;", //         8
    "  }", //                9
    "}" //                   10
  ];
  const type = { symbolKind: "class", symbolName: "I", startLine: 2, endLine: 10 };
  assert.deepEqual(enclosingAt(source, 5), type);
  assert.deepEqual(enclosingAt(source, 8), type);
});

test("a hit in a compact record constructor belongs to the record", () => {
  const source = [
    "package p;", //             1
    "record P(int x) {", //      2
    "  P {", //                  3
    "    check(x);", //          4
    "  }", //                    5
    "}" //                       6
  ];
  const record = { symbolKind: "record", symbolName: "P", startLine: 2, endLine: 6 };
  assert.deepEqual(enclosingAt(source, 2), record);
  assert.deepEqual(enclosingAt(source, 4), record);
});

test("a hit on the header or between the members of a local class belongs to the local class", () => {
  const source = [
    "package p;", //             1
    "class M {", //              2
    "  void run() {", //         3
    "    class Local {", //      4
    "      int f;", //           5
    "", //                       6
    "      void g() {", //       7
    "      }", //                8
    "    }", //                  9
    "    new Local();", //       10
    "  }", //                    11
    "}" //                       12
  ];
  const local = { symbolKind: "class", symbolName: "Local", startLine: 4, endLine: 9 };
  assert.deepEqual(enclosingAt(source, 4), local);
  assert.deepEqual(enclosingAt(source, 6), local);
  assert.deepEqual(enclosingAt(source, 8), { symbolKind: "method", symbolName: "g", startLine: 7, endLine: 8 });
  assert.deepEqual(enclosingAt(source, 10), { symbolKind: "method", symbolName: "run", startLine: 3, endLine: 11 });
});

test("a hit on a line holding two field declarations belongs to the first one", () => {
  const source = [
    "package p;", //                 1
    "class D {", //                  2
    "  int a = 1; int b = 2;", //    3
    "}" //                           4
  ];
  assert.deepEqual(enclosingAt(source, 3), { symbolKind: "field", symbolName: "a", startLine: 3, endLine: 3 });
});

test("an annotation-only line above a method is outside the method's range", () => {
  const source = [
    "package p;", //                     1
    "class Ann {", //                    2
    "  @Override", //                    3
    "  public String toString() {", //   4
    "    return \"\";", //               5
    "  }", //                            6
    "}" //                               7
  ];
  assert.deepEqual(enclosingAt(source, 3), { symbolKind: "class", symbolName: "Ann", startLine: 2, endLine: 7 });
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "method", symbolName: "toString", startLine: 4, endLine: 6 });
});

test("lines outside every declaration have no enclosing symbol", () => {
  const source = [
    "/* header comment */", //   1
    "package p;", //             2
    "", //                       3
    "import java.util.List;", // 4
    "", //                       5
    "class Top {", //            6
    "}" //                       7
  ];
  for (const line of [1, 2, 3, 4, 5]) {
    assert.equal(enclosingAt(source, line), undefined, `line ${line}`);
  }
  assert.deepEqual(enclosingAt(source, 6), { symbolKind: "class", symbolName: "Top", startLine: 6, endLine: 7 });
});

test("a body that never closes runs to the last line of the file", () => {
  const source = [
    "package p;", //         1
    "class U {", //          2
    "  void open() {", //    3
    "    work();", //        4
    "" //                    5
  ];
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "method", symbolName: "open", startLine: 3, endLine: 5 });
});

test("inside an annotation type a hit belongs to the element on its line, otherwise to the annotation type", () => {
  const source = [
    "package p;", //                                    1
    "@Target({ElementType.TYPE})", //                   2
    "public @interface GameTest {", //                  3
    "  int maxTicks() default 100;", //                 4
    "", //                                              5
    "  String[] tags() default {};", //                 6
    "  Nested nested() default @Nested(\"x\");", //     7
    "  String name();", //                              8
    "  @interface Nested {", //                         9
    "    String value();", //                           10
    "  }", //                                           11
    "}" //                                              12
  ];
  const gameTest = { symbolKind: "interface", symbolName: "GameTest", startLine: 3, endLine: 12 };
  assert.deepEqual(enclosingAt(source, 3), gameTest);
  assert.deepEqual(enclosingAt(source, 5), gameTest);
  assert.deepEqual(enclosingAt(source, 12), gameTest);
  assert.deepEqual(enclosingAt(source, 4), { symbolKind: "method", symbolName: "maxTicks", startLine: 4, endLine: 4 });
  assert.deepEqual(enclosingAt(source, 6), { symbolKind: "method", symbolName: "tags", startLine: 6, endLine: 6 });
  assert.deepEqual(enclosingAt(source, 7), { symbolKind: "method", symbolName: "nested", startLine: 7, endLine: 7 });
  assert.deepEqual(enclosingAt(source, 8), { symbolKind: "method", symbolName: "name", startLine: 8, endLine: 8 });
  assert.deepEqual(enclosingAt(source, 11), { symbolKind: "interface", symbolName: "Nested", startLine: 9, endLine: 11 });
  // The annotation above the declaration is outside the type's range, as for any declaration.
  assert.equal(enclosingAt(source, 2), undefined);
});
