import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedSearchFixture,
  type SearchClassSourceCaseInput,
  type SearchFixture
} from "../helpers/source-service-search-fixtures.ts";

// Each shapes/ file holds the marker "probeMarker" exactly once, so its single content hit
// lands on that line. Expected ranges, head lines and closing lines are read off the
// numbered fixture text by hand.
const SHAPE_SOURCES: Record<string, string[]> = {
  "shapes/WrappedParams.java": [
    "package shapes;", //                    1
    "class WrappedParams {", //              2
    "  int add(", //                         3
    "      int first, // probeMarker", //    4
    "      int second) {", //                5
    "    return first + second;", //         6
    "  }", //                                7
    "}" //                                   8
  ],
  "shapes/NestedType.java": [
    "package shapes;", //            1
    "class NestedType {", //         2
    "  static class Inner {", //     3
    "    int b;", //                 4
    "    // probeMarker", //         5
    "    int c;", //                 6
    "  }", //                        7
    "}" //                           8
  ],
  "shapes/LambdaBody.java": [
    "package shapes;", //                            1
    "class LambdaBody {", //                         2
    "  void run() {", //                             3
    "    Runnable r = () -> {", //                   4
    "      System.out.println(\"probeMarker\");", // 5
    "    };", //                                     6
    "  }", //                                        7
    "}" //                                           8
  ],
  "shapes/AnonymousMethod.java": [
    "package shapes;", //                    1
    "class AnonymousMethod {", //            2
    "  Object o = new Object() {", //        3
    "    public String toString() {", //     4
    "      return \"probeMarker\";", //      5
    "    }", //                              6
    "  };", //                               7
    "}" //                                   8
  ],
  "shapes/AnonymousGap.java": [
    "package shapes;", //                1
    "class AnonymousGap {", //           2
    "  Object o = new Object() {", //    3
    "    int inner = 1;", //             4
    "    // probeMarker", //             5
    "  };", //                           6
    "}" //                               7
  ],
  "shapes/RecordHeader.java": [
    "package shapes;", //                    1
    "public record RecordHeader(", //        2
    "    int x, // probeMarker", //          3
    "    String y", //                       4
    ") {", //                                5
    "  static int Z = 1;", //                6
    "}" //                                   7
  ],
  "shapes/RecordBodyField.java": [
    "package shapes;", //                    1
    "public record RecordBodyField(", //     2
    "    int x", //                          3
    ") {", //                                4
    "  static int probeMarker = 1;", //      5
    "}" //                                   6
  ],
  "shapes/EnumConstantBody.java": [
    "package shapes;", //                    1
    "enum EnumConstantBody {", //            2
    "  A(1) {", //                           3
    "    void m() {", //                     4
    "      work(\"probeMarker\");", //       5
    "    }", //                              6
    "  },", //                               7
    "  B(2);", //                            8
    "  EnumConstantBody(int v) {", //        9
    "  }", //                                10
    "}" //                                   11
  ],
  "shapes/EnumConstantLine.java": [
    "package shapes;", //                    1
    "enum EnumConstantLine {", //            2
    "  A(1), // probeMarker", //             3
    "  B(2);", //                            4
    "  EnumConstantLine(int v) {", //        5
    "  }", //                                6
    "}" //                                   7
  ],
  "shapes/FieldInitializer.java": [
    "package shapes;", //                                1
    "class FieldInitializer {", //                       2
    "  static final Runnable TASK = () -> {", //         3
    "    System.out.println(\"probeMarker\");", //       4
    "  };", //                                           5
    "}" //                                               6
  ],
  "shapes/TextBlock.java": [
    "package shapes;", //            1
    "class TextBlock {", //          2
    "  String text() {", //          3
    "    return \"\"\"", //          4
    "        }", //                  5
    "        }", //                  6
    "        probeMarker", //        7
    "        \"\"\";", //            8
    "  }", //                        9
    "}" //                           10
  ],
  "shapes/AnnotatedParam.java": [
    "package shapes;", //                                1
    "class AnnotatedParam {", //                         2
    "  void handle(@Tags({1, 2}) int value) {", //       3
    "    use(value); // probeMarker", //                 4
    "  }", //                                            5
    "}" //                                               6
  ],
  "shapes/AfterBodyless.java": [
    "package shapes;", //                    1
    "abstract class AfterBodyless {", //     2
    "  abstract void first();", //           3
    "  // probeMarker", //                   4
    "  void second() {", //                  5
    "  }", //                                6
    "}" //                                   7
  ],
  "shapes/InitializerBlock.java": [
    "package shapes;", //                1
    "class InitializerBlock {", //       2
    "  static int x;", //                3
    "  static {", //                     4
    "    x = 1; // probeMarker", //      5
    "  }", //                            6
    "}" //                               7
  ],
  "shapes/CompactConstructor.java": [
    "package shapes;", //                        1
    "record CompactConstructor(int x) {", //     2
    "  CompactConstructor {", //                 3
    "    check(x); // probeMarker", //           4
    "  }", //                                    5
    "}" //                                       6
  ],
  "shapes/LocalClassHeader.java": [
    "package shapes;", //                        1
    "class LocalClassHeader {", //               2
    "  void run() {", //                         3
    "    class Local { // probeMarker", //       4
    "      int f;", //                           5
    "    }", //                                  6
    "  }", //                                    7
    "}" //                                       8
  ],
  "shapes/LocalClassGap.java": [
    "package shapes;", //                1
    "class LocalClassGap {", //          2
    "  void run() {", //                 3
    "    class Local {", //              4
    "      int f;", //                   5
    "      // probeMarker", //           6
    "      void g() {", //               7
    "      }", //                        8
    "    }", //                          9
    "  }", //                            10
    "}" //                               11
  ],
  "shapes/SharedLine.java": [
    "package shapes;", //                        1
    "class SharedLine {", //                     2
    "  int a = 1; int probeMarker = 2;", //      3
    "}" //                                       4
  ],
  "shapes/AnnotationLine.java": [
    "package shapes;", //                    1
    "class AnnotationLine {", //             2
    "  @Deprecated // probeMarker", //       3
    "  void old() {", //                     4
    "  }", //                                5
    "}" //                                   6
  ],
  "shapes/Ctor.java": [
    "package shapes;", //                1
    "class Ctor {", //                   2
    "  Ctor() {", //                     3
    "    init(); // probeMarker", //     4
    "  }", //                            5
    "}" //                               6
  ],
  "shapes/AnnotationElement.java": [
    "package shapes;", //                                  1
    "@Target({ElementType.TYPE})", //                      2
    "public @interface AnnotationElement {", //            3
    "  int maxTicks() default 100; // probeMarker", //     4
    "  String name();", //                                 5
    "}" //                                                 6
  ],
  "shapes/AnnotationBody.java": [
    "package shapes;", //                          1
    "public @interface AnnotationBody {", //       2
    "  int maxTicks() default 100;", //            3
    "  // probeMarker", //                         4
    "  String[] tags() default {};", //            5
    "}" //                                         6
  ]
};

type Expected = {
  enclosingSymbol: { symbolKind: string; symbolName: string; startLine: number; endLine: number };
  head: string;
  close: string;
};

const EXPECTED: Record<string, Expected> = {
  "shapes/WrappedParams.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "add", startLine: 3, endLine: 7 },
    head: "  int add(",
    close: "  }"
  },
  "shapes/NestedType.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "Inner", startLine: 3, endLine: 7 },
    head: "  static class Inner {",
    close: "  }"
  },
  "shapes/LambdaBody.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "run", startLine: 3, endLine: 7 },
    head: "  void run() {",
    close: "  }"
  },
  "shapes/AnonymousMethod.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "toString", startLine: 4, endLine: 6 },
    head: "    public String toString() {",
    close: "    }"
  },
  "shapes/AnonymousGap.java": {
    enclosingSymbol: { symbolKind: "field", symbolName: "o", startLine: 3, endLine: 6 },
    head: "  Object o = new Object() {",
    close: "  };"
  },
  "shapes/RecordHeader.java": {
    enclosingSymbol: { symbolKind: "record", symbolName: "RecordHeader", startLine: 2, endLine: 7 },
    head: "public record RecordHeader(",
    close: "}"
  },
  "shapes/RecordBodyField.java": {
    enclosingSymbol: { symbolKind: "field", symbolName: "probeMarker", startLine: 5, endLine: 5 },
    head: "  static int probeMarker = 1;",
    close: "  static int probeMarker = 1;"
  },
  "shapes/EnumConstantBody.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "m", startLine: 4, endLine: 6 },
    head: "    void m() {",
    close: "    }"
  },
  "shapes/EnumConstantLine.java": {
    enclosingSymbol: { symbolKind: "enum", symbolName: "EnumConstantLine", startLine: 2, endLine: 7 },
    head: "enum EnumConstantLine {",
    close: "}"
  },
  "shapes/FieldInitializer.java": {
    enclosingSymbol: { symbolKind: "field", symbolName: "TASK", startLine: 3, endLine: 5 },
    head: "  static final Runnable TASK = () -> {",
    close: "  };"
  },
  "shapes/TextBlock.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "text", startLine: 3, endLine: 9 },
    head: "  String text() {",
    close: "  }"
  },
  "shapes/AnnotatedParam.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "handle", startLine: 3, endLine: 5 },
    head: "  void handle(@Tags({1, 2}) int value) {",
    close: "  }"
  },
  "shapes/AfterBodyless.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "AfterBodyless", startLine: 2, endLine: 7 },
    head: "abstract class AfterBodyless {",
    close: "}"
  },
  "shapes/InitializerBlock.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "InitializerBlock", startLine: 2, endLine: 7 },
    head: "class InitializerBlock {",
    close: "}"
  },
  "shapes/CompactConstructor.java": {
    enclosingSymbol: { symbolKind: "record", symbolName: "CompactConstructor", startLine: 2, endLine: 6 },
    head: "record CompactConstructor(int x) {",
    close: "}"
  },
  "shapes/LocalClassHeader.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "Local", startLine: 4, endLine: 6 },
    head: "    class Local { // probeMarker",
    close: "    }"
  },
  "shapes/LocalClassGap.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "Local", startLine: 4, endLine: 9 },
    head: "    class Local {",
    close: "    }"
  },
  "shapes/SharedLine.java": {
    enclosingSymbol: { symbolKind: "field", symbolName: "a", startLine: 3, endLine: 3 },
    head: "  int a = 1; int probeMarker = 2;",
    close: "  int a = 1; int probeMarker = 2;"
  },
  "shapes/AnnotationLine.java": {
    enclosingSymbol: { symbolKind: "class", symbolName: "AnnotationLine", startLine: 2, endLine: 6 },
    head: "class AnnotationLine {",
    close: "}"
  },
  "shapes/Ctor.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "Ctor", startLine: 3, endLine: 5 },
    head: "  Ctor() {",
    close: "  }"
  },
  "shapes/AnnotationElement.java": {
    enclosingSymbol: { symbolKind: "method", symbolName: "maxTicks", startLine: 4, endLine: 4 },
    head: "  int maxTicks() default 100; // probeMarker",
    close: "  int maxTicks() default 100; // probeMarker"
  },
  "shapes/AnnotationBody.java": {
    enclosingSymbol: { symbolKind: "interface", symbolName: "AnnotationBody", startLine: 2, endLine: 6 },
    head: "public @interface AnnotationBody {",
    close: "}"
  }
};

// Matches outside every declaration, each found by its own query, plus a positive control.
const OUTSIDE_PATH = "outsidepkg/Outside.java";
const OUTSIDE_SOURCE = [
  "/* Licensed under headerOnlyMark terms. */", //   1
  "package outsidepkg;", //                          2
  "", //                                             3
  "import java.util.ImportOnlyMark;", //             4
  "", //                                             5
  "public class Outside {", //                       6
  "  int controlMark = 1;", //                       7
  "}" //                                             8
];

let fixturePromise: Promise<SearchFixture> | undefined;
function fixture(): Promise<SearchFixture> {
  fixturePromise ??= createResolvedSearchFixture({
    rootPrefix: "search-enclosing-symbol-",
    jarBaseName: "enclosing-symbol",
    sourceEntries: Object.fromEntries([
      ...Object.entries(SHAPE_SOURCES).map(([path, lines]) => [path, lines.join("\n")]),
      [OUTSIDE_PATH, OUTSIDE_SOURCE.join("\n")]
    ])
  });
  return fixturePromise;
}

async function search(input: SearchClassSourceCaseInput) {
  const { service, resolved } = await fixture();
  return service.searchClassSource({ artifactId: resolved.artifactId, limit: 50, ...input });
}

const EXPECTED_ENCLOSING = Object.fromEntries(
  Object.entries(EXPECTED).map(([path, expected]) => [path, expected.enclosingSymbol])
);

async function enclosingByFile(input: SearchClassSourceCaseInput) {
  const result = await search(input);
  assert.ok(result.hits.length > 0, "the search must return content hits");
  assert.ok(result.hits.every((hit) => hit.matchedIn === "content"));
  return {
    reasonCodes: result.hits.map((hit) => hit.reasonCodes),
    enclosing: Object.fromEntries(result.hits.map((hit) => [hit.filePath, hit.enclosingSymbol]))
  };
}

test("indexed text hits carry the declaration that encloses each match", async () => {
  const { reasonCodes, enclosing } = await enclosingByFile({ query: "probeMarker", intent: "text", match: "contains" });
  assert.ok(reasonCodes.every((codes) => codes.includes("indexed")));
  assert.deepEqual(enclosing, EXPECTED_ENCLOSING);
});

test("literal scan hits carry the declaration that encloses each match", async () => {
  const { reasonCodes, enclosing } = await enclosingByFile({
    query: "probeMarker",
    intent: "text",
    match: "contains",
    queryMode: "literal"
  });
  assert.ok(reasonCodes.every((codes) => !codes.includes("indexed")));
  assert.deepEqual(enclosing, EXPECTED_ENCLOSING);
});

test("regex content hits carry the declaration that encloses each match", async () => {
  const { enclosing } = await enclosingByFile({ query: "probe\\w+", intent: "text", match: "regex" });
  assert.deepEqual(enclosing, EXPECTED_ENCLOSING);
});

test("content hits in a header comment, the package line or an import have no enclosingSymbol key", async () => {
  for (const queryMode of ["auto", "literal"] as const) {
    for (const [query, line] of [["headerOnlyMark", 1], ["outsidepkg", 2], ["ImportOnlyMark", 4]] as const) {
      const result = await search({ query, intent: "text", match: "contains", queryMode });
      const hit = result.hits.find((candidate) => candidate.filePath === OUTSIDE_PATH);
      assert.ok(hit, `${queryMode} search for ${query} must hit ${OUTSIDE_PATH}`);
      assert.equal(hit.matchedIn, "content");
      assert.equal(hit.line, line);
      assert.equal("enclosingSymbol" in hit, false, `${queryMode} search for ${query}`);
    }

    const control = await search({ query: "controlMark", intent: "text", match: "contains", queryMode });
    const controlHit = control.hits.find((candidate) => candidate.filePath === OUTSIDE_PATH);
    assert.deepEqual(controlHit?.enclosingSymbol, {
      symbolKind: "field",
      symbolName: "controlMark",
      startLine: 7,
      endLine: 7
    });
  }
});

test("symbol and path hits have no enclosingSymbol key", async () => {
  for (const input of [
    { query: "WrappedParams", intent: "symbol", match: "exact" },
    { query: "WrappedParams", intent: "path", match: "contains" }
  ] as const) {
    const result = await search(input);
    assert.ok(result.hits.length > 0, `${input.intent} search must return a hit`);
    for (const hit of result.hits) {
      assert.notEqual(hit.matchedIn, "content");
      assert.equal("enclosingSymbol" in hit, false);
    }
  }
});

test("get-class-source snippet over a hit's enclosingSymbol range returns the declaration from its head line through its closing line", async () => {
  const { service, resolved } = await fixture();
  const result = await search({ query: "probeMarker", intent: "text", match: "contains" });
  assert.equal(result.hits.length, Object.keys(EXPECTED).length);
  for (const hit of result.hits) {
    const expected = EXPECTED[hit.filePath];
    assert.ok(expected && hit.enclosingSymbol, hit.filePath);
    const { startLine, endLine } = hit.enclosingSymbol;
    const snippet = await service.getClassSource({
      artifactId: resolved.artifactId,
      className: hit.filePath.replace(/\.java$/, "").replaceAll("/", "."),
      mode: "snippet",
      startLine,
      endLine
    });
    const lines = snippet.sourceText.split("\n");
    assert.equal(lines[0], expected.head, `${hit.filePath} head line`);
    assert.equal(lines.at(-1), expected.close, `${hit.filePath} closing line`);
    assert.equal(snippet.sourceText, SHAPE_SOURCES[hit.filePath]!.slice(startLine - 1, endLine).join("\n"), hit.filePath);
  }
});
