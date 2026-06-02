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

test("extractSymbolsFromSource captures fields with modifiers and spaced generics", () => {
  const source = [
    "public class Demo {",
    "  public int health;",
    "  private static final long SEED = 0L;",
    "  protected Map<String, Integer> counts = new HashMap<>();",
    "  private List<? extends Entity> targets;",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("Demo.java", source);
  const fields = symbols.filter((s) => s.symbolKind === "field").map((s) => s.symbolName);

  assert.ok(fields.includes("health"), `expected field 'health', got ${fields.join(", ")}`);
  assert.ok(fields.includes("SEED"), `expected field 'SEED', got ${fields.join(", ")}`);
  assert.ok(fields.includes("counts"), `expected field 'counts', got ${fields.join(", ")}`);
  assert.ok(fields.includes("targets"), `expected field 'targets', got ${fields.join(", ")}`);
});

test("extractSymbolsFromSource does not record call statements as methods", () => {
  const source = [
    "public class Demo {",
    "  public void run() {",
    "    int x = compute(1);",
    "    return helper();",
    "    doThing();",
    "  }",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("Demo.java", source);
  const methods = symbols.filter((s) => s.symbolKind === "method").map((s) => s.symbolName);

  assert.ok(methods.includes("run"), `expected real method 'run', got ${methods.join(", ")}`);
  assert.ok(!methods.includes("compute"), "must not treat 'compute(1)' call as a method");
  assert.ok(!methods.includes("helper"), "must not treat 'return helper()' as a method");
  assert.ok(!methods.includes("doThing"), "must not treat bare call 'doThing()' as a method");
});

test("extractSymbolsFromSource keeps the field when its initializer is a call", () => {
  const source = [
    "public class Demo {",
    "  private final Logger log = makeLogger();",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("Demo.java", source);
  const fields = symbols.filter((s) => s.symbolKind === "field").map((s) => s.symbolName);
  const methods = symbols.filter((s) => s.symbolKind === "method").map((s) => s.symbolName);

  assert.ok(fields.includes("log"), `expected field 'log', got ${fields.join(", ")}`);
  assert.ok(!methods.includes("makeLogger"), "initializer call must not become a method");
});

test("extractSymbolsFromSource captures constructors and abstract method declarations", () => {
  const source = [
    "public class Demo {",
    "  public Demo(int seed) {}",
    "}",
    "interface Ticker {",
    "  void onTick();",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("Demo.java", source);
  const methods = symbols.filter((s) => s.symbolKind === "method").map((s) => s.symbolName);

  assert.ok(methods.includes("Demo"), `expected constructor 'Demo', got ${methods.join(", ")}`);
  assert.ok(methods.includes("onTick"), `expected abstract method 'onTick', got ${methods.join(", ")}`);
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
