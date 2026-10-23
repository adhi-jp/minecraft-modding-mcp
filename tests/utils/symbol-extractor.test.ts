import assert from "node:assert/strict";
import test from "node:test";

import { extractSymbolsFromSource } from "../../src/symbols/symbol-extractor.ts";

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

test("extractSymbolsFromSource indexes sealed and non-sealed types without phantom fields", () => {
  const sealedSource = [
    "public sealed class Foo permits A, B {",
    "}"
  ].join("\n");
  const sealedSymbols = extractSymbolsFromSource("net/minecraft/Foo.java", sealedSource);
  assert.deepEqual(
    sealedSymbols.map((s) => ({ symbolKind: s.symbolKind, symbolName: s.symbolName })),
    [{ symbolKind: "class", symbolName: "Foo" }]
  );

  const nonSealedSource = [
    "public non-sealed class Bar extends Foo {",
    "}"
  ].join("\n");
  const nonSealedSymbols = extractSymbolsFromSource("net/minecraft/Bar.java", nonSealedSource);
  assert.deepEqual(
    nonSealedSymbols.map((s) => ({ symbolKind: s.symbolKind, symbolName: s.symbolName })),
    [{ symbolKind: "class", symbolName: "Bar" }]
  );

  const sealedInterfaceSource = [
    "public sealed interface Baz permits Qux {",
    "}"
  ].join("\n");
  const interfaceSymbols = extractSymbolsFromSource("net/minecraft/Baz.java", sealedInterfaceSource);
  assert.deepEqual(
    interfaceSymbols.map((s) => ({ symbolKind: s.symbolKind, symbolName: s.symbolName })),
    [{ symbolKind: "interface", symbolName: "Baz" }]
  );
});

test("extractSymbolsFromSource recognizes declarations led by an annotation with arguments", () => {
  const source = [
    "package a.b;",
    "@SuppressWarnings(\"unused\") public class Outer {",
    "  public static class Inner {",
    "    @SuppressWarnings(\"unchecked\") public void run() {}",
    "  }",
    "}"
  ].join("\n");

  const symbols = extractSymbolsFromSource("a/b/Outer.java", source);

  assert.deepEqual(
    symbols.map((s) => ({ symbolKind: s.symbolKind, symbolName: s.symbolName, line: s.line })),
    [
      { symbolKind: "class", symbolName: "Outer", line: 2 },
      { symbolKind: "class", symbolName: "Inner", line: 3 },
      { symbolKind: "method", symbolName: "run", line: 4 }
    ]
  );
});

function symbolRows(source: string): string[] {
  return extractSymbolsFromSource("Demo.java", source)
    .map((s) => `${s.symbolKind} ${s.symbolName} ${s.line}`);
}

test("extractSymbolsFromSource emits wrapped constructors, methods and abstract methods at their first line", () => {
  const source = [
    "public abstract class Demo {",
    "  public Demo(",
    "    int seed,",
    "    String name",
    "  ) {",
    "  }",
    "  protected static <T> List<T> collect(",
    "    Stream<T> stream, int limit) {",
    "    return null;",
    "  }",
    "  abstract void load(Path path)",
    "    throws IOException,",
    "    InterruptedException;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method Demo 2",
    "method collect 7",
    "method load 11"
  ]);
});

test("extractSymbolsFromSource does not emit wrapped parameters as fields", () => {
  const source = [
    "class Demo {",
    "  void run(",
    "    int first,",
    "    final String second",
    "  ) {",
    "  }",
    "  void walk(int a,",
    "    @Nullable Entity entity) {}",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method run 2",
    "method walk 7"
  ]);
});

test("extractSymbolsFromSource does not emit locals of methods, lambdas and initializers", () => {
  const source = [
    "class Demo {",
    "  static {",
    "    int fromStatic = 1;",
    "  }",
    "  {",
    "    int fromInstance = 2;",
    "  }",
    "  void run() {",
    "    int local = 3;",
    "    Runnable task = () -> {",
    "      int inLambda = 4;",
    "    };",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method run 8"
  ]);
});

test("extractSymbolsFromSource does not emit the package line", () => {
  const source = [
    "package a;",
    "public class Demo {",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), ["class Demo 2"]);
});

test("extractSymbolsFromSource keeps members of anonymous and local classes", () => {
  const source = [
    "class Demo {",
    "  void run() {",
    "    Runnable task = new Runnable() {",
    "      private int calls;",
    "      @Override",
    "      public void run() {",
    "      }",
    "    };",
    "    class Helper {",
    "      int depth;",
    "      void help() {}",
    "    }",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method run 2",
    "field calls 4",
    "method run 6",
    "class Helper 9",
    "field depth 10",
    "method help 11"
  ]);
});

test("extractSymbolsFromSource treats an enum constant with a body as a constant, not a method", () => {
  const source = [
    "enum Mode {",
    "  FOO(\"x\") {",
    "    @Override",
    "    int weight() {",
    "      return 1;",
    "    }",
    "  },",
    "  BAR(\"y\");",
    "  private final String label;",
    "  Mode(String label) {",
    "    this.label = label;",
    "  }",
    "  int weight() {",
    "    return 0;",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "enum Mode 1",
    "method weight 4",
    "field label 9",
    "method Mode 10",
    "method weight 13"
  ]);
});

test("extractSymbolsFromSource ignores braces and parentheses inside literals and comments", () => {
  const source = [
    "class Demo {",
    "  String open = \"{(\";",
    "  char brace = '{';",
    "  String block = \"\"\"",
    "      } {",
    "      \"\"\";",
    "  /* } */",
    "  int after;",
    "  void run() {",
    "    String s = \"}\";",
    "    int local = 1;",
    "  }",
    "  int last;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field open 2",
    "field brace 3",
    "field block 4",
    "field after 8",
    "method run 9",
    "field last 13"
  ]);
});

test("extractSymbolsFromSource does not emit commented-out declarations", () => {
  const source = [
    "class Demo {",
    "  // public void disabled() {}",
    "  /*",
    "  private int hidden;",
    "  */",
    "  int kept;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field kept 6"
  ]);
});

test("extractSymbolsFromSource emits record components on one header line, without the compact constructor", () => {
  const source = [
    "public record Point(int x, int y) {",
    "  public Point {",
    "    if (x < 0) throw new IllegalArgumentException();",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "record Point 1",
    "field x 1",
    "field y 1"
  ]);
});

test("extractSymbolsFromSource emits wrapped record components at their own lines", () => {
  const source = [
    "record Box(",
    "  @Named(\"w\") int width,",
    "  List<Map<String, Integer>> rows",
    ") implements Shape {",
    "  static int count;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "record Box 1",
    "field width 2",
    "field rows 3",
    "field count 5"
  ]);
});

test("extractSymbolsFromSource emits each component of a nested wrapped record once", () => {
  const source = [
    "class Outer {",
    "  record Inner(",
    "    int a,",
    "    int b",
    "  ) {}",
    "  int after;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Outer 1",
    "record Inner 2",
    "field a 3",
    "field b 4",
    "field after 6"
  ]);
});

test("extractSymbolsFromSource emits components of a record whose name contains '$'", () => {
  const source = [
    "@Deprecated(since = \"1\") record Box$1(int width) {",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "record Box$1 1",
    "field width 1"
  ]);
});

test("extractSymbolsFromSource keeps annotation type elements as methods", () => {
  const source = [
    "public @interface Marker {",
    "  int count();",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), ["method count 2"]);
});

test("extractSymbolsFromSource emits methods with type-use annotations and nested type parameters", () => {
  const source = [
    "class Demo {",
    "  Outer.@Nullable Inner foo() {",
    "    return null;",
    "  }",
    "  public static <T extends Comparable<T>> T max(",
    "    T a, T b) {",
    "    return a;",
    "  }",
    "  <K, V extends Map<K, List<V>>> V pick(K key) {",
    "    return null;",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method foo 2",
    "method max 5",
    "method pick 9"
  ]);
});

test("extractSymbolsFromSource handles braces on their own line", () => {
  const source = [
    "class Demo",
    "{",
    "  void run()",
    "  {",
    "    int local = 1;",
    "  }",
    "  int count;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "method run 3",
    "field count 7"
  ]);
});

test("extractSymbolsFromSource keeps interface constants as fields", () => {
  const source = [
    "interface Limits {",
    "  int MAX = 10;",
    "  String NAME = \"x\", OTHER = \"y\";",
    "  void apply();",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "interface Limits 1",
    "field MAX 2",
    "field NAME 3",
    "method apply 4"
  ]);
});

test("extractSymbolsFromSource keeps a field whose initializer spans several lines", () => {
  const source = [
    "class Demo {",
    "  private static final Map<String, Integer> TABLE = Map.of(",
    "    \"a\", 1,",
    "    \"b\", 2);",
    "  int[] values = {",
    "    1,",
    "    2",
    "  };",
    "  int after;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field TABLE 2",
    "field values 5",
    "field after 9"
  ]);
});

test("extractSymbolsFromSource keeps members of an anonymous class whose type name contains 'new'", () => {
  const source = [
    "class Renewal {}",
    "class Demo {",
    "  Object value = new Renewal() {",
    "    int count;",
    "    void tick() {}",
    "  };",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Renewal 1",
    "class Demo 2",
    "field value 3",
    "field count 4",
    "method tick 5"
  ]);
});

test("extractSymbolsFromSource keeps members of an anonymous class whose type arguments wrap", () => {
  const source = [
    "class Demo {",
    "  Object value = new java.util.HashMap<",
    "      String,",
    "      Integer>() {",
    "    int count;",
    "    void tick() {}",
    "  };",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field value 2",
    "field count 5",
    "method tick 6"
  ]);
});

test("extractSymbolsFromSource keeps members of an anonymous class created with an annotated type", () => {
  const source = [
    "class Demo {",
    "  Object value = new @Mark(1) Object() {",
    "    int count;",
    "    void tick() {}",
    "  };",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field value 2",
    "field count 3",
    "method tick 4"
  ]);
});

test("extractSymbolsFromSource keeps members of a class whose header shares a line with its outer class", () => {
  const source = [
    "class Outer { static class Inner {",
    "  int count;",
    "  void tick() {}",
    "}}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Outer 1",
    "field count 2",
    "method tick 3"
  ]);
});

test("extractSymbolsFromSource keeps members of a class whose header splits before its name", () => {
  const source = [
    "class Outer {",
    "  public class",
    "      Inner {",
    "    int count;",
    "  }",
    "  Object type = Inner.class;",
    "  int after;",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Outer 1",
    "field count 4",
    "field type 6",
    "field after 7"
  ]);
});

test("extractSymbolsFromSource does not read record type parameters as components", () => {
  const source = "record Box<@Tag(id = 1) T>(T value) {}";

  assert.deepEqual(symbolRows(source), [
    "record Box 1",
    "field value 1"
  ]);
});

test("extractSymbolsFromSource does not read a 'record instanceof' expression as a type header", () => {
  const source = [
    "class Demo {",
    "  Object record;",
    "  Runnable task = record instanceof String ? () -> {",
    "    int lambdaLocal = 1;",
    "  } : () -> {};",
    "  void check() {",
    "    boolean ok = flag ||",
    "        record instanceof String;",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field record 2",
    "field task 3",
    "method check 6"
  ]);
});

test("extractSymbolsFromSource does not read an identifier ending in 'new' as an instance creation", () => {
  const source = [
    "class $new {}",
    "class Demo {",
    "  $new renew() {",
    "    int local = 0;",
    "    return null;",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class $new 1",
    "class Demo 2",
    "method renew 3"
  ]);
});

test("extractSymbolsFromSource keeps an instance creation whose parenthesis follows blank lines", () => {
  const source = [
    "class Demo {",
    "  Object value = new Object",
    ...new Array<string>(600).fill(""),
    "  () {",
    "    int member;",
    "  };",
    "}"
  ].join("\n");

  assert.deepEqual(symbolRows(source), [
    "class Demo 1",
    "field value 2",
    "field member 604"
  ]);
});
