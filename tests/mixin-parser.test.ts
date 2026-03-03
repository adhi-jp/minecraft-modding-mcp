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

/* ------------------------------------------------------------------ */
/*  String-form targets: @Mixin(targets = "...")                       */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses single string target", () => {
  const source = `
@Mixin(targets = "net.minecraft.server.MinecraftServer")
public abstract class ServerMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "net.minecraft.server.MinecraftServer");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses array string targets", () => {
  const source = `
@Mixin(targets = {"net.minecraft.server.MinecraftServer", "net.minecraft.client.Minecraft"})
public abstract class MultiMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0].className, "net.minecraft.server.MinecraftServer");
  assert.equal(result.targets[1].className, "net.minecraft.client.Minecraft");
});

test("parseMixinSource parses string targets with priority", () => {
  const source = `
@Mixin(targets = "net.minecraft.server.MinecraftServer", priority = 900)
public abstract class PriorityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "net.minecraft.server.MinecraftServer");
  assert.equal(result.priority, 900);
});

test("parseMixinSource parses multi-line string targets", () => {
  const source = `
@Mixin(
  targets = {
    "net.minecraft.server.MinecraftServer",
    "net.minecraft.client.Minecraft"
  },
  priority = 1000
)
public abstract class MultiLineMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0].className, "net.minecraft.server.MinecraftServer");
  assert.equal(result.targets[1].className, "net.minecraft.client.Minecraft");
  assert.equal(result.priority, 1000);
});

test("parseMixinSource prefers .class format over string targets", () => {
  const source = `
@Mixin(value = PlayerEntity.class, targets = "net.minecraft.Foo")
public abstract class PreferClassMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].className, "PlayerEntity");
});

/* ------------------------------------------------------------------ */
/*  Import parsing tests                                               */
/* ------------------------------------------------------------------ */

test("parseMixinSource extracts single import", () => {
  const source = `
import net.minecraft.world.entity.item.ItemEntity;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.imports.size, 1);
  assert.equal(result.imports.get("ItemEntity"), "net.minecraft.world.entity.item.ItemEntity");
});

test("parseMixinSource extracts multiple imports", () => {
  const source = `
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.imports.size, 3);
  assert.equal(result.imports.get("ItemEntity"), "net.minecraft.world.entity.item.ItemEntity");
  assert.equal(result.imports.get("Player"), "net.minecraft.world.entity.player.Player");
  assert.equal(result.imports.get("Mixin"), "org.spongepowered.asm.mixin.Mixin");
});

test("parseMixinSource ignores wildcard imports", () => {
  const source = `
import java.util.*;
import net.minecraft.world.entity.item.ItemEntity;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.imports.size, 1);
  assert.equal(result.imports.get("ItemEntity"), "net.minecraft.world.entity.item.ItemEntity");
});

test("parseMixinSource returns empty imports map when no imports", () => {
  const source = `
@Mixin(net.minecraft.world.entity.item.ItemEntity.class)
public abstract class ItemEntityMixin {
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.imports.size, 0);
});

/* ------------------------------------------------------------------ */
/*  default/synchronized modifier tests                                */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses @Accessor with default method modifier", () => {
  const source = `
import net.minecraft.world.entity.player.Player;

@Mixin(Player.class)
public interface PlayerAccessor {
  @Accessor("health")
  default int getHealth() { throw new AssertionError(); }
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].name, "getHealth");
  assert.equal(result.accessors[0].targetName, "health");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses @Shadow with synchronized method", () => {
  const source = `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  public synchronized void doWork() {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.shadows.length, 1);
  assert.equal(result.shadows[0].kind, "method");
  assert.equal(result.shadows[0].name, "doWork");
});

/* ------------------------------------------------------------------ */
/*  interface class name capture test                                   */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Phase 2: array-form method targets                                 */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses @Inject with array method attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = {"tick", "attack"}, at = @At("HEAD"))
  private void onTickOrAttack(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 2);
  assert.equal(result.injections[0].method, "tick");
  assert.equal(result.injections[1].method, "attack");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses multi-line array method attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(
    method = {
      "tick",
      "attack"
    },
    at = @At("HEAD")
  )
  private void onTickOrAttack(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 2);
  assert.equal(result.injections[0].method, "tick");
  assert.equal(result.injections[1].method, "attack");
});

test("parseMixinSource parses array method with descriptors", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = {"playerTouch(Lnet/minecraft/world/entity/player/Player;)V", "tick()V"}, at = @At("HEAD"))
  private void hook(CallbackInfo ci) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 2);
  assert.equal(result.injections[0].method, "playerTouch(Lnet/minecraft/world/entity/player/Player;)V");
  assert.equal(result.injections[1].method, "tick()V");
});

/* ------------------------------------------------------------------ */
/*  Phase 3: @Accessor with value= attribute                           */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses @Accessor with value= attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor(value = "health")
  int getHealth();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].targetName, "health");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses @Invoker with value= attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerInvoker {
  @Invoker(value = "damage")
  void invokeDamage();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].annotation, "Invoker");
  assert.equal(result.accessors[0].targetName, "damage");
});

/* ------------------------------------------------------------------ */
/*  @Accessor with remap=false and trailing comments                   */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses @Accessor with remap=false", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor(value = "health", remap = false)
  int getHealth();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].targetName, "health");
  assert.equal(result.parseWarnings.length, 0);
});

test("parseMixinSource parses @Accessor with trailing comment", () => {
  const source = `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health") // access health field
  int getHealth();
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.accessors.length, 1);
  assert.equal(result.accessors[0].targetName, "health");
  assert.equal(result.parseWarnings.length, 0);
});

/* ------------------------------------------------------------------ */
/*  MixinExtras annotations                                            */
/* ------------------------------------------------------------------ */

test("parseMixinSource parses @WrapOperation as injection", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @WrapOperation(method = "tick", at = @At(value = "INVOKE", target = "Lfoo;bar()V"))
  private void wrapTick(Operation<Void> op) {}
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].annotation, "WrapOperation");
  assert.equal(result.injections[0].method, "tick");
});

test("parseMixinSource parses @ModifyReturnValue as injection", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @ModifyReturnValue(method = "getValue", at = @At("RETURN"))
  private int modifyGetValue(int original) { return original; }
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].annotation, "ModifyReturnValue");
  assert.equal(result.injections[0].method, "getValue");
});

test("parseMixinSource parses @WrapWithCondition as injection", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @WrapWithCondition(method = "attack", at = @At(value = "INVOKE", target = "Lfoo;bar()V"))
  private boolean shouldAttack() { return true; }
}
`;
  const result = parseMixinSource(source);
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].annotation, "WrapWithCondition");
  assert.equal(result.injections[0].method, "attack");
});
