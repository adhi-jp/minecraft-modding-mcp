import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { SHADOW_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses @Shadow declarations across field and method forms", () => {
  for (const testCase of SHADOW_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.deepEqual(
      result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
      testCase.entries,
      `${testCase.name}: shadow entries`
    );
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});

test("parseMixinSource treats a Java text block body as inert string content", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  private static final String DOC = """
      @Shadow private int ghost;
      he said "hi
      /* not a comment
      """;
  @Shadow private int health;
  private static final String ESCAPED = """
      a \\""" is not the end
      @Shadow private int ghost2;
      """;
  @Shadow private int hunger;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, line: entry.line })),
    [
      { name: "health", line: 9 },
      { name: "hunger", line: 14 }
    ]
  );
});

test("parseMixinSource does not let a quote char literal hide a block comment", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  private static final char QUOTE = '"';
  private static final char ESCAPED = '\\'';
  /*
  @Shadow private int ghost;
  */
  @Shadow private int health;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.shadows.map((entry) => entry.name), ["health"]);
});

test("parseMixinSource reads @Shadow attributes that wrap onto later lines", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(
      prefix = "field_",
      aliases = {"hp", "life"}
  )
  private int field_health;

  @Shadow(
      prefix = "m_"
  ) @Final public abstract int m_hunger();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.parseWarnings, []);
  assert.deepEqual(
    result.shadows.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      targetName: entry.targetName,
      aliases: entry.aliases,
      line: entry.line
    })),
    [
      { kind: "field", name: "field_health", targetName: "field_health", aliases: ["hp", "life"], line: 4 },
      { kind: "method", name: "m_hunger", targetName: "hunger", aliases: undefined, line: 10 }
    ]
  );
});

test("parseMixinSource ends a wrapped @Shadow span at its real closing parenthesis, not one inside a string", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(
      prefix = "p_", aliases = {"a(b"}
  )
  public abstract int p_a();
  @Shadow private int b;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.parseWarnings, []);
  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName, aliases: entry.aliases })),
    [
      { name: "p_a", targetName: "a", aliases: ["a(b"] },
      { name: "b", targetName: "b", aliases: undefined }
    ]
  );
});

test("parseMixinSource reads @Shadow prefix and aliases past a parenthesis inside a string", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(aliases = {"old)"}, prefix = "p_") public abstract int p_health();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName, aliases: entry.aliases })),
    [{ name: "p_health", targetName: "health", aliases: ["old)"] }]
  );
});
