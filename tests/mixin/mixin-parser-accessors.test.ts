import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { ACCESSOR_CASES, INVOKER_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses @Accessor declarations across target inference variants", () => {
  for (const testCase of ACCESSOR_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.accessors.length, 1, `${testCase.name}: accessor count`);
    assert.deepEqual(
      {
        annotation: result.accessors[0].annotation,
        name: result.accessors[0].name,
        targetName: result.accessors[0].targetName
      },
      testCase.entry,
      `${testCase.name}: accessor entry`
    );
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});

test("parseMixinSource parses @Invoker declarations across explicit and inferred targets", () => {
  for (const testCase of INVOKER_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.accessors.length, 1, `${testCase.name}: invoker count`);
    assert.deepEqual(
      {
        annotation: result.accessors[0].annotation,
        name: result.accessors[0].name,
        targetName: result.accessors[0].targetName
      },
      testCase.entry,
      `${testCase.name}: invoker entry`
    );
  }
});

test("parseMixinSource parses consecutive same-line accessor declarations and following members", () => {
  const accessorResult = parseMixinSource(`
@Mixin(Minecraft.class)
public interface MinecraftAccessor {
  @Accessor("pausePartialTick") float getPausePartialTick();
  @Accessor("fps") int getFps();
}
`);
  assert.deepEqual(
    accessorResult.accessors.map((a) => ({ name: a.name, targetName: a.targetName })),
    [
      { name: "getPausePartialTick", targetName: "pausePartialTick" },
      { name: "getFps", targetName: "fps" }
    ]
  );
  assert.equal(accessorResult.parseWarnings.length, 0);

  const invokerResult = parseMixinSource(`
@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
  @Invoker("dropItem") void callDropItem(boolean all);
  @Shadow int fps;
}
`);
  assert.deepEqual(
    invokerResult.accessors.map((a) => ({ name: a.name, targetName: a.targetName })),
    [{ name: "callDropItem", targetName: "dropItem" }]
  );
  assert.deepEqual(
    invokerResult.shadows.map((s) => ({ kind: s.kind, name: s.name })),
    [{ kind: "field", name: "fps" }]
  );
  assert.equal(invokerResult.parseWarnings.length, 0);
});
