import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";

test("parseMixinSource parses @Shadow preceded by another annotation on the same line", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Final @Shadow private int foo;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
    [{ kind: "field", name: "foo" }]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource parses @Shadow after another annotation on an annotation-only line", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Final @Shadow
  private int foo;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
    [{ kind: "field", name: "foo" }]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource parses an injection preceded by an annotation with arguments", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Environment(EnvType.CLIENT) @Inject(method = "tick", at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.injections.map((entry) => ({ annotation: entry.annotation, method: entry.method })),
    [{ annotation: "Inject", method: "tick" }]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource parses a multi-line injection preceded by another annotation", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Environment(EnvType.CLIENT) @Inject(
    method = "attack",
    at = @At("HEAD")
  )
  private void onAttack(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.injections.map((entry) => ({ annotation: entry.annotation, method: entry.method })),
    [{ annotation: "Inject", method: "attack" }]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource parses @Accessor preceded by another annotation on the same line", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Environment(EnvType.CLIENT) @Accessor("health")
  int getHealth();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.accessors.map((entry) => ({
      annotation: entry.annotation,
      name: entry.name,
      targetName: entry.targetName
    })),
    [{ annotation: "Accessor", name: "getHealth", targetName: "health" }]
  );
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource ignores annotation names that appear inside string literals", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  private static final String DOC = "@Shadow @Accessor(\\"health\\")";
  private static final String HINT = "use @Inject(method = \\"tick\\") here";
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(result.shadows, []);
  assert.deepEqual(result.accessors, []);
  assert.deepEqual(result.injections, []);
  assert.deepEqual(result.parseWarnings, []);
});

test("parseMixinSource reads the explicit target from the accessor's own arguments", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @SuppressWarnings("unchecked") @Accessor(
    value = "health"
  )
  int getHealth();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.accessors.map((entry) => entry.targetName),
    ["health"]
  );
});

test("parseMixinSource ignores an annotation name inside a preceding annotation's argument string", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @SuppressWarnings(") @Shadow private int ghost;")
  private int real;

  @Shadow private int health;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
    [{ kind: "field", name: "health" }]
  );
});

test("parseMixinSource parses @Shadow after an annotation with nested parentheses", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Meta(@Nested("x")) @Shadow private int foo;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name })),
    [{ kind: "field", name: "foo" }]
  );
});

test("parseMixinSource reads the injected method from the injection's own arguments", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Meta(method = "other") @Inject(method = "tick", at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.injections.map((entry) => ({ annotation: entry.annotation, method: entry.method })),
    [{ annotation: "Inject", method: "tick" }]
  );
});
