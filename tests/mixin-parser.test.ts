import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../src/mixin-parser.ts";

test("parseMixinSource parses single target class", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerEntityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "PlayerEntity");
  assert.equal(result.className, "PlayerEntityMixin");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses multiple target classes", () => {
  const source = `
@Mixin({LivingEntity.class, PlayerEntity.class})
public abstract class MultiTargetMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0].className, "LivingEntity");
  assert.equal(result.targets[1].className, "PlayerEntity");
});

test("parseMixinSource parses @Mixin with value attribute and priority", () => {
  const source = `
@Mixin(value = ServerPlayerEntity.class, priority = 900)
public abstract class PriorityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "ServerPlayerEntity");
  assert.equal(result.priority, 900);
});

test("parseMixinSource parses @Inject with method attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = "tick", at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].annotation, "Inject");
  assert.equal(result.injections[0].method, "tick");
  assert.equal(result.injections[0].line, 4);
});

test("parseMixinSource parses @Redirect annotation", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Redirect(method = "attack", at = @At(value = "INVOKE", target = "Foo"))
  private void redirectAttack() {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].annotation, "Redirect");
  assert.equal(result.injections[0].method, "attack");
});

test("parseMixinSource parses @Shadow field", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  private int health;
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.shadows.length, 1);
  assert.equal(result.shadows[0].kind, "field");
  assert.equal(result.shadows[0].name, "health");
});

test("parseMixinSource parses @Shadow method", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  public abstract void doSomething();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.shadows.length, 1);
  assert.equal(result.shadows[0].kind, "method");
  assert.equal(result.shadows[0].name, "doSomething");
});

test("parseMixinSource parses @Accessor with explicit target", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  int getHealth();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].annotation, "Accessor");
  assert.equal(result.accessors[0].name, "getHealth");
  assert.equal(result.accessors[0].targetName, "health");
});

test("parseMixinSource infers @Accessor target from getter naming convention", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  int getMaxHealth();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].targetName, "maxHealth");
});

test("parseMixinSource infers @Accessor target from boolean is-getter", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  boolean isDead();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].targetName, "dead");
});

test("parseMixinSource infers @Invoker target from naming convention", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerInvoker {
  @Invoker
  void invokeDamage();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].annotation, "Invoker");
  assert.equal(result.accessors[0].targetName, "damage");
});

test("parseMixinSource handles multi-line @Inject annotation", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(
    method = "tick",
    at = @At("HEAD"),
    cancellable = true
  )
  private void onTick(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].method, "tick");
});

test("parseMixinSource warns when @Mixin target is missing", () => {
  const source = `
public abstract class BadMixin {
  @Shadow
  private int field;
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes("No @Mixin annotation target")));
});

test("parseMixinSource warns when @Inject missing method attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes("missing method attribute")));
});

test("parseMixinSource parses fully-qualified target class names", () => {
  const source = `
@Mixin(net.minecraft.entity.player.PlayerEntity.class)
public abstract class PlayerMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "net.minecraft.entity.player.PlayerEntity");
});

test("parseMixinSource handles multi-line @Mixin with value array", () => {
  const source = `
@Mixin(
  value = {LivingEntity.class, PlayerEntity.class},
  priority = 1100
)
public abstract class MultiMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 2);
  assert.equal(result.priority, 1100);
});
