import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { TARGET_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses @Mixin targets across supported annotation forms", () => {
  for (const testCase of TARGET_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.deepEqual(
      result.targets.map((entry) => entry.className),
      testCase.targets,
      `${testCase.name}: targets`
    );
    assert.equal(result.priority, testCase.priority, `${testCase.name}: priority`);
    if (testCase.className !== undefined) {
      assert.equal(result.className, testCase.className, `${testCase.name}: className`);
    }
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});

test("parseMixinSource captures class name from interface declaration", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  int getHealth();
}
`;
  const result = parseMixinSource(source);

  assert.equal(result.className, "PlayerAccessor");
});

const NESTED_MIXINS_SOURCE = `
package example;

@Mixin(TargetA.class)
public abstract class OuterMixin {
  @Shadow private int aField;

  @Mixin(TargetB.class)
  public abstract static class InnerMixin {
    @Shadow private int bField;
    @Inject(method = "bTick", at = @At("HEAD"))
    private void onB(CallbackInfo ci) {
      String brace = "}"; // }
    }
  }

  @Inject(method = "aTick", at = @At("HEAD"))
  private void onA(CallbackInfo ci) {
    char brace = '}';
  }

  private static class Helper {
    @Inject(method = "aHelper", at = @At("HEAD"))
    private void onHelper(CallbackInfo ci) {}
  }
}
`;

test("parseMixinSource records each nested @Mixin class and tags members with their owner", () => {
  const result = parseMixinSource(NESTED_MIXINS_SOURCE);

  assert.deepEqual(result.targets.map((entry) => entry.className), ["TargetA", "TargetB"]);
  assert.equal(result.className, "OuterMixin");
  assert.deepEqual(result.mixins, [
    { className: "OuterMixin", targets: [{ className: "TargetA" }], startLine: 4, endLine: 26 },
    { className: "InnerMixin", targets: [{ className: "TargetB" }], startLine: 8, endLine: 15 }
  ]);
  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, mixinIndex: entry.mixinIndex })),
    [
      { name: "aField", mixinIndex: 0 },
      { name: "bField", mixinIndex: 1 }
    ]
  );
  // A member of a nested non-mixin class belongs to the nearest enclosing @Mixin class.
  assert.deepEqual(
    result.injections.map((entry) => ({ method: entry.method, mixinIndex: entry.mixinIndex })),
    [
      { method: "bTick", mixinIndex: 1 },
      { method: "aTick", mixinIndex: 0 },
      { method: "aHelper", mixinIndex: 0 }
    ]
  );
});

test("parseMixinSource records two top-level @Mixin classes in one file separately", () => {
  const source = `
@Mixin(TargetA.class)
abstract class AMixin {
  @Shadow private int aField;
}

@Mixin(value = {TargetB.class}, targets = "example.TargetC")
abstract class BMixin {
  @Accessor("bValue")
  int getB();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.targets.map((entry) => entry.className),
    ["TargetA", "TargetB", "example.TargetC"]
  );
  assert.equal(result.className, "AMixin");
  assert.deepEqual(result.mixins, [
    { className: "AMixin", targets: [{ className: "TargetA" }], startLine: 2, endLine: 5 },
    {
      className: "BMixin",
      targets: [{ className: "TargetB" }, { className: "example.TargetC" }],
      startLine: 7,
      endLine: 11
    }
  ]);
  assert.deepEqual(result.shadows.map((entry) => entry.mixinIndex), [0]);
  assert.deepEqual(result.accessors.map((entry) => entry.mixinIndex), [1]);
});

test("parseMixinSource assigns every member of a single-@Mixin file to that mixin", () => {
  const source = `
@Mixin({LivingEntity.class, PlayerEntity.class})
public abstract class PlayerMixin {
  @Shadow private int health;
  @Inject(method = "tick", at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
  @Invoker("jump")
  abstract void callJump();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.mixins, [
    {
      className: "PlayerMixin",
      targets: [{ className: "LivingEntity" }, { className: "PlayerEntity" }],
      startLine: 2,
      endLine: 9
    }
  ]);
  assert.deepEqual(
    [...result.shadows, ...result.injections, ...result.accessors].map((entry) => entry.mixinIndex),
    [0, 0, 0]
  );
});

test("parseMixinSource opens a mixin body only at the brace after the whole class header", () => {
  const source = `
@Mixin(TargetA.class)
abstract class First extends @Mark({1,2}) Base {
  @Shadow private int aField;
}

@Mixin(TargetB.class)
abstract class Second<T extends Comparable<T>> implements @Ann(values = {"x"}) Iface {
  @Shadow private int bField;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.mixins, [
    { className: "First", targets: [{ className: "TargetA" }], startLine: 2, endLine: 5 },
    { className: "Second", targets: [{ className: "TargetB" }], startLine: 7, endLine: 10 }
  ]);
  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, mixinIndex: entry.mixinIndex })),
    [
      { name: "aField", mixinIndex: 0 },
      { name: "bField", mixinIndex: 1 }
    ]
  );
});

test("parseMixinSource recognizes a @Mixin annotation that follows code on the same line", () => {
  const source = `
@Mixin(TargetA.class)
abstract class First {
  @Shadow private int aField;
  String text = "@Mixin(Ignored.class)"; // @Mixin(AlsoIgnored.class)
} @Mixin(TargetB.class) abstract class Second {
  @Shadow private int bField;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.targets.map((entry) => entry.className), ["TargetA", "TargetB"]);
  assert.deepEqual(result.mixins, [
    { className: "First", targets: [{ className: "TargetA" }], startLine: 2, endLine: 6 },
    { className: "Second", targets: [{ className: "TargetB" }], startLine: 6, endLine: 8 }
  ]);
  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, mixinIndex: entry.mixinIndex })),
    [
      { name: "aField", mixinIndex: 0 },
      { name: "bField", mixinIndex: 1 }
    ]
  );
});
