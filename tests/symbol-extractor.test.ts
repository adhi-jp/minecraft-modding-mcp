import assert from "node:assert/strict";
import test from "node:test";

import { extractSymbolsFromSource } from "../src/symbols/symbol-extractor.ts";

test("extractSymbolsFromSource extracts class/method/field with line numbers", () => {
  const source = [
    "package a.b;",
    "public class Demo {",
    "  int count = 1;",
    "  public void tick() {}",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("a/b/Demo.java", source);
  const kinds = symbols.map((item) => item.symbolKind);
  const names = symbols.map((item) => item.symbolName);

  assert.ok(kinds.includes("class"));
  assert.ok(kinds.includes("field"));
  assert.ok(kinds.includes("method"));
  assert.ok(names.includes("Demo"));
  assert.ok(names.includes("count"));
  assert.ok(names.includes("tick"));

  const demo = symbols.find((item) => item.symbolName === "Demo");
  assert.equal(demo?.line, 2);
});
