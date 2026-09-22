import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";

test("parseMixinSource collects class literal and string targets from one @Mixin", () => {
  const source = `
@Mixin(value = PlayerEntity.class, targets = "net.minecraft.Foo")
public abstract class CombinedTargetsMixin {
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.targets.map((entry) => entry.className),
    ["PlayerEntity", "net.minecraft.Foo"]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource keeps class literals first and drops duplicate targets", () => {
  const source = `
@Mixin(
  value = {LivingEntity.class, PlayerEntity.class},
  targets = {"net.minecraft.Foo", "PlayerEntity"}
)
public abstract class MultiTargetMixin {
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.targets.map((entry) => entry.className),
    ["LivingEntity", "PlayerEntity", "net.minecraft.Foo"]
  );
});
