import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource, selectNestedMixin } from "../../src/mixin-parser.ts";
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
    { className: "OuterMixin", targets: [{ className: "TargetA" }], startLine: 4, endLine: 26, classPath: ["OuterMixin"] },
    {
      className: "InnerMixin",
      targets: [{ className: "TargetB" }],
      startLine: 8,
      endLine: 15,
      classPath: ["OuterMixin", "InnerMixin"]
    }
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
    { className: "AMixin", targets: [{ className: "TargetA" }], startLine: 2, endLine: 5, classPath: ["AMixin"] },
    {
      className: "BMixin",
      targets: [{ className: "TargetB" }, { className: "example.TargetC" }],
      startLine: 7,
      endLine: 11,
      classPath: ["BMixin"]
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
      endLine: 9,
      classPath: ["PlayerMixin"]
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
    { className: "First", targets: [{ className: "TargetA" }], startLine: 2, endLine: 5, classPath: ["First"] },
    { className: "Second", targets: [{ className: "TargetB" }], startLine: 7, endLine: 10, classPath: ["Second"] }
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
    { className: "First", targets: [{ className: "TargetA" }], startLine: 2, endLine: 6, classPath: ["First"] },
    { className: "Second", targets: [{ className: "TargetB" }], startLine: 6, endLine: 8, classPath: ["Second"] }
  ]);
  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, mixinIndex: entry.mixinIndex })),
    [
      { name: "aField", mixinIndex: 0 },
      { name: "bField", mixinIndex: 1 }
    ]
  );
});

test("parseMixinSource records every @Mixin class on a line that starts with @Mixin", () => {
  const source = `
@Mixin(TargetA.class) abstract class A { @Shadow private int aField; } @Mixin(TargetB.class) abstract class B {}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.targets.map((entry) => entry.className), ["TargetA", "TargetB"]);
  assert.deepEqual(result.mixins, [
    { className: "A", targets: [{ className: "TargetA" }], startLine: 2, endLine: 2, classPath: ["A"] },
    { className: "B", targets: [{ className: "TargetB" }], startLine: 2, endLine: 2, classPath: ["B"] }
  ]);
});

test("parseMixinSource ends a line-start @Mixin span at its real closing parenthesis, not one inside a string", () => {
  const source = `
@Mixin(value = TargetA.class, targets = "pkg.Odd(") abstract class A {
  @Shadow private int aField;
}
@Mixin(TargetB.class)
abstract class B {
  @Shadow private int bField;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.targets.map((entry) => entry.className), ["TargetA", "pkg.Odd(", "TargetB"]);
  assert.deepEqual(result.mixins, [
    {
      className: "A",
      targets: [{ className: "TargetA" }, { className: "pkg.Odd(" }],
      startLine: 2,
      endLine: 4,
      classPath: ["A"]
    },
    { className: "B", targets: [{ className: "TargetB" }], startLine: 5, endLine: 8, classPath: ["B"] }
  ]);
  assert.deepEqual(result.shadows.map((entry) => entry.mixinIndex), [0, 1]);
});

test("selectNestedMixin picks the nested class at the exact path when same-named classes close on one line", () => {
  const source = `
public class Outer {
  static class Left { @Mixin(TargetL.class) static class Dup {
    @Shadow private int l;
  } } static class Right { @Mixin(TargetR.class) static class Dup {} }
}
`;
  const parsed = parseMixinSource(source);

  const left = selectNestedMixin(parsed, ["Outer", "Left", "Dup"]);
  const right = selectNestedMixin(parsed, ["Outer", "Right", "Dup"]);

  assert.deepEqual(left?.targets.map((entry) => entry.className), ["TargetL"]);
  assert.deepEqual(left?.shadows.map((entry) => entry.name), ["l"]);
  assert.deepEqual(right?.targets.map((entry) => entry.className), ["TargetR"]);
  assert.deepEqual(right?.shadows, []);
});

test("selectNestedMixin does not address a local class declared inside a method body", () => {
  const source = `
public class Outer {
  void register() {
    @Mixin(TargetA.class)
    abstract class Inner {
      @Shadow private int a;
    }
  }
  static { new Object() { @Mixin(TargetB.class) abstract class Anon {} }; }
}
`;
  const parsed = parseMixinSource(source);

  assert.equal(selectNestedMixin(parsed, ["Outer", "Inner"]), undefined);
  assert.equal(selectNestedMixin(parsed, ["Outer", "Anon"]), undefined);
});

test("selectNestedMixin reports the nested class's own @Mixin priority", () => {
  const source = `
@Mixin(value = TargetA.class, priority = 100)
public abstract class Outer {
  @Mixin(value = TargetB.class, priority = 200)
  abstract static class Inner {}
  @Mixin(value = TargetC.class, priority = 300)
  abstract static class Sibling {}
  @Mixin(TargetD.class)
  abstract static class Plain {}
}
`;
  const parsed = parseMixinSource(source);

  assert.equal(selectNestedMixin(parsed, ["Outer", "Inner"])?.priority, 200);
  assert.equal(selectNestedMixin(parsed, ["Outer", "Sibling"])?.priority, 300);
  assert.equal(selectNestedMixin(parsed, ["Outer", "Plain"])?.priority, undefined);
});

test("selectNestedMixin addresses a mixin class nested in an annotation type", () => {
  const source = `
public @interface Outer {
  @Mixin(TargetA.class)
  abstract class Inner {
    @Shadow private int a;
  }
}
`;
  const parsed = parseMixinSource(source);

  const inner = selectNestedMixin(parsed, ["Outer", "Inner"]);
  assert.deepEqual(inner?.targets.map((entry) => entry.className), ["TargetA"]);
  assert.deepEqual(inner?.shadows.map((entry) => entry.name), ["a"]);
});

test("parseMixinSource reads no class literal from inside a string target", () => {
  const targetsOf = (annotation: string): string[] =>
    parseMixinSource(`${annotation}\npublic abstract class SomeMixin {}\n`).targets.map((entry) => entry.className);

  assert.deepEqual(
    targetsOf('@Mixin(targets = "net.minecraft.class_1234$class_5678")'),
    ["net.minecraft.class_1234$class_5678"]
  );
  assert.deepEqual(targetsOf('@Mixin(targets = "com.foo.classes.Bar")'), ["com.foo.classes.Bar"]);
  assert.deepEqual(
    targetsOf('@Mixin(targets = {"a.class_1", "b.classes.C"})'),
    ["a.class_1", "b.classes.C"]
  );
  assert.deepEqual(targetsOf('@Mixin(value = Foo.class, targets = "pkg.Bar")'), ["Foo", "pkg.Bar"]);
  assert.deepEqual(targetsOf("@Mixin({A.class, B.class})"), ["A", "B"]);
});
