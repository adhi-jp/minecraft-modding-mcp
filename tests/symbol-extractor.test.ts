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

test("extractSymbolsFromSource normalizes the file path once even for multiple symbols", () => {
  const source = [
    "package a.b;",
    "public class Demo {",
    "  int count = 1;",
    "  public void tick() {}",
    "}"
  ].join("\n");
  const filePath = "a/b/Demo.java";
  const filePathWithoutExtension = "a/b/Demo";

  const originalReplace = String.prototype.replace;
  const originalReplaceAll = String.prototype.replaceAll;
  let replaceCalls = 0;
  let replaceAllCalls = 0;

  String.prototype.replace = function patchedReplace(...args: Parameters<typeof originalReplace>) {
    if (String(this) === filePath) {
      replaceCalls += 1;
    }
    return originalReplace.apply(this, args);
  };
  String.prototype.replaceAll = function patchedReplaceAll(
    ...args: Parameters<typeof originalReplaceAll>
  ) {
    if (String(this) === filePathWithoutExtension) {
      replaceAllCalls += 1;
    }
    return originalReplaceAll.apply(this, args);
  };

  try {
    extractSymbolsFromSource(filePath, source);
  } finally {
    String.prototype.replace = originalReplace;
    String.prototype.replaceAll = originalReplaceAll;
  }

  assert.equal(replaceCalls, 1);
  assert.equal(replaceAllCalls, 1);
});
