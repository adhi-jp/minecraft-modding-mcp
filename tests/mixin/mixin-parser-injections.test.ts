import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { INJECTION_CASES } from "./mixin-parser-fixtures.ts";

test("parseMixinSource parses injection annotations and method arrays", () => {
  for (const testCase of INJECTION_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.injections.length, testCase.methods.length, `${testCase.name}: injection count`);
    assert.deepEqual(
      result.injections.map((entry) => entry.annotation),
      testCase.methods.map(() => testCase.annotation),
      `${testCase.name}: annotations`
    );
    assert.deepEqual(
      result.injections.map((entry) => entry.method),
      testCase.methods,
      `${testCase.name}: methods`
    );
    if (testCase.lines !== undefined) {
      assert.deepEqual(
        result.injections.map((entry) => entry.line),
        testCase.lines,
        `${testCase.name}: lines`
      );
    }
    if (testCase.warningCount !== undefined) {
      assert.equal(result.parseWarnings.length, testCase.warningCount, `${testCase.name}: warnings`);
    }
  }
});

test("parseMixinSource reads method arrays whose selectors contain braces", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = {"tick{2}", "jump"}, at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}

  @Inject(
      method = {"a}b", "render{1,3}"},
      at = @At("TAIL")
  )
  private void onRender(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.parseWarnings, []);
  assert.deepEqual(
    result.injections.map((entry) => ({ method: entry.method, line: entry.line })),
    [
      { method: "tick{2}", line: 4 },
      { method: "jump", line: 4 },
      { method: "a}b", line: 7 },
      { method: "render{1,3}", line: 7 }
    ]
  );
});

test("parseMixinSource reads only plain string literals as method selectors", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = SomeClass.NAME + "Tail", at = @At("HEAD"))
  private void onA(CallbackInfo ci) {}

  @Inject(method = "a" + "b", at = @At("HEAD"))
  private void onB(CallbackInfo ci) {}

  @Inject(method = {CONST, "b"}, at = @At("HEAD"))
  private void onC(CallbackInfo ci) {}

  @Inject(method = { "c", /* note */ "d", }, at = @At("HEAD"))
  private void onD(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.injections.map((entry) => ({ method: entry.method, line: entry.line })),
    [
      { method: "b", line: 10 },
      { method: "c", line: 13 },
      { method: "d", line: 13 }
    ]
  );
  assert.equal(result.parseWarnings.length, 3, JSON.stringify(result.parseWarnings));
  assert.match(result.parseWarnings[0], /^Line 4: .*could not parse method attribute/);
  assert.match(result.parseWarnings[1], /^Line 7: .*could not parse method attribute/);
  assert.match(result.parseWarnings[2], /^Line 10: .*could not parse method array element/);
});

test("parseMixinSource collects a wrapped injection annotation past a parenthesis inside a string", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(at = @At(value = "CONSTANT", args = "stringValue=)"),
      method = "tick")
  private void onTick(CallbackInfo ci) {}

  @Inject(method = "jump", at = @At("HEAD"))
  private void onJump(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.parseWarnings, []);
  assert.deepEqual(
    result.injections.map((entry) => ({ method: entry.method, line: entry.line })),
    [
      { method: "tick", line: 4 },
      { method: "jump", line: 8 }
    ]
  );
});
