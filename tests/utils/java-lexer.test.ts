import assert from "node:assert/strict";
import test from "node:test";

import { stripJavaNoise } from "../../src/symbols/java-lexer.ts";

test("stripJavaNoise returns lines without quotes or slashes unchanged", () => {
  const lines = ["\tpublic void run() {  ", "", "  int x = a * b;"];
  assert.deepEqual(stripJavaNoise(lines), lines);
});

test("stripJavaNoise replaces string and char literals with an empty string literal", () => {
  assert.deepEqual(
    stripJavaNoise([
      "String s = \"a{\\\"b(\";",
      "char c = '\\'';",
      "char q = '\"'; int y;",
      "String t = \"\\\\\"; int z;"
    ]),
    [
      "String s = \"\";",
      "char c = \"\";",
      "char q = \"\"; int y;",
      "String t = \"\"; int z;"
    ]
  );
});

test("stripJavaNoise replaces each comment with one space", () => {
  assert.deepEqual(
    stripJavaNoise([
      "int a = 1; // note {",
      "int b/* } */= 2;",
      "String url = \"http://x\"; int c;"
    ]),
    [
      "int a = 1;  ",
      "int b = 2;",
      "String url = \"\"; int c;"
    ]
  );
});

test("stripJavaNoise keeps a division operator", () => {
  assert.deepEqual(stripJavaNoise(["int x = a / b;"]), ["int x = a / b;"]);
});

test("stripJavaNoise blanks block comments that span lines, including lines without quotes or slashes", () => {
  assert.deepEqual(
    stripJavaNoise([
      "int a; /* start {",
      "  private int hidden;",
      "end } */ int b;",
      "int c; /*",
      "*/"
    ]),
    [
      "int a;  ",
      "",
      " int b;",
      "int c;  ",
      ""
    ]
  );
});

test("stripJavaNoise replaces a text block with one empty string literal on its first line", () => {
  assert.deepEqual(
    stripJavaNoise([
      "String t = \"\"\"",
      "    { ( \\\"\"\" still inside",
      "    \"\"\";",
      "int after;"
    ]),
    [
      "String t = \"\"",
      "",
      ";",
      "int after;"
    ]
  );
});
