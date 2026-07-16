export type TargetCase = {
  name: string;
  source: string;
  targets: string[];
  priority?: number;
  className?: string;
  warningCount?: number;
};

export type InjectionCase = {
  name: string;
  source: string;
  annotation: string;
  methods: string[];
  lines?: number[];
  warningCount?: number;
};

export type ShadowCase = {
  name: string;
  source: string;
  entries: Array<{ kind: "field" | "method"; name: string }>;
  warningCount?: number;
};

export type AccessorCase = {
  name: string;
  source: string;
  entry: {
    annotation: "Accessor" | "Invoker";
    name: string;
    targetName: string;
  };
  warningCount?: number;
};

export type ImportCase = {
  name: string;
  source: string;
  entries: Record<string, string>;
};

export type WarningCase = {
  name: string;
  source: string;
  expectedTargets: number;
  warningFragment: string;
  expectedInjections?: number;
};

export const TARGET_CASES: TargetCase[] = [
  {
    name: "single target class",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerEntityMixin {
}
`,
    targets: ["PlayerEntity"],
    className: "PlayerEntityMixin",
    warningCount: 0
  },
  {
    name: "multiple target classes",
    source: `
@Mixin({LivingEntity.class, PlayerEntity.class})
public abstract class MultiTargetMixin {
}
`,
    targets: ["LivingEntity", "PlayerEntity"]
  },
  {
    name: "@Mixin with value attribute and priority",
    source: `
@Mixin(value = ServerPlayerEntity.class, priority = 900)
public abstract class PriorityMixin {
}
`,
    targets: ["ServerPlayerEntity"],
    priority: 900
  },
  {
    name: "fully-qualified target class names",
    source: `
@Mixin(net.minecraft.entity.player.PlayerEntity.class)
public abstract class PlayerMixin {
}
`,
    targets: ["net.minecraft.entity.player.PlayerEntity"]
  },
  {
    name: "target class name containing a dollar sign",
    source: `
@Mixin(My$GeneratedClass.class)
public abstract class DollarMixin {
}
`,
    targets: ["My$GeneratedClass"]
  },
  {
    name: "multi-line @Mixin with value array",
    source: `
@Mixin(
  value = {LivingEntity.class, PlayerEntity.class},
  priority = 1100
)
public abstract class MultiMixin {
}
`,
    targets: ["LivingEntity", "PlayerEntity"],
    priority: 1100
  },
  {
    name: "single string target",
    source: `
@Mixin(targets = "net.minecraft.server.MinecraftServer")
public abstract class ServerMixin {
}
`,
    targets: ["net.minecraft.server.MinecraftServer"],
    warningCount: 0
  },
  {
    name: "array string targets",
    source: `
@Mixin(targets = {"net.minecraft.server.MinecraftServer", "net.minecraft.client.Minecraft"})
public abstract class MultiMixin {
}
`,
    targets: ["net.minecraft.server.MinecraftServer", "net.minecraft.client.Minecraft"]
  },
  {
    name: "string targets with priority",
    source: `
@Mixin(targets = "net.minecraft.server.MinecraftServer", priority = 900)
public abstract class PriorityMixin {
}
`,
    targets: ["net.minecraft.server.MinecraftServer"],
    priority: 900
  },
  {
    name: "multi-line string targets",
    source: `
@Mixin(
  targets = {
    "net.minecraft.server.MinecraftServer",
    "net.minecraft.client.Minecraft"
  },
  priority = 1000
)
public abstract class MultiLineMixin {
}
`,
    targets: ["net.minecraft.server.MinecraftServer", "net.minecraft.client.Minecraft"],
    priority: 1000
  },
  {
    name: "prefers .class format over string targets",
    source: `
@Mixin(value = PlayerEntity.class, targets = "net.minecraft.Foo")
public abstract class PreferClassMixin {
}
`,
    targets: ["PlayerEntity"]
  }
];

export const INJECTION_CASES: InjectionCase[] = [
  {
    name: "@Inject with method attribute",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = "tick", at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`,
    annotation: "Inject",
    methods: ["tick"],
    lines: [4]
  },
  {
    name: "@Redirect annotation",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Redirect(method = "attack", at = @At(value = "INVOKE", target = "Foo"))
  private void redirectAttack() {}
}
`,
    annotation: "Redirect",
    methods: ["attack"]
  },
  {
    name: "multi-line @Inject annotation",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(
    method = "tick",
    at = @At("HEAD"),
    cancellable = true
  )
  private void onTick(CallbackInfo ci) {}
}
`,
    annotation: "Inject",
    methods: ["tick"]
  },
  {
    name: "@Inject with array method attribute",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = {"tick", "attack"}, at = @At("HEAD"))
  private void onTickOrAttack(CallbackInfo ci) {}
}
`,
    annotation: "Inject",
    methods: ["tick", "attack"],
    warningCount: 0
  },
  {
    name: "multi-line array method attribute",
    source: `
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
`,
    annotation: "Inject",
    methods: ["tick", "attack"]
  },
  {
    name: "array method with descriptors",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(method = {"playerTouch(Lnet/minecraft/world/entity/player/Player;)V", "tick()V"}, at = @At("HEAD"))
  private void hook(CallbackInfo ci) {}
}
`,
    annotation: "Inject",
    methods: ["playerTouch(Lnet/minecraft/world/entity/player/Player;)V", "tick()V"]
  },
  {
    name: "@WrapOperation as injection",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @WrapOperation(method = "tick", at = @At(value = "INVOKE", target = "Lfoo;bar()V"))
  private void wrapTick(Operation<Void> op) {}
}
`,
    annotation: "WrapOperation",
    methods: ["tick"]
  },
  {
    name: "@ModifyReturnValue as injection",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @ModifyReturnValue(method = "getValue", at = @At("RETURN"))
  private int modifyGetValue(int original) { return original; }
}
`,
    annotation: "ModifyReturnValue",
    methods: ["getValue"]
  },
  {
    name: "@WrapWithCondition as injection",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @WrapWithCondition(method = "attack", at = @At(value = "INVOKE", target = "Lfoo;bar()V"))
  private boolean shouldAttack() { return true; }
}
`,
    annotation: "WrapWithCondition",
    methods: ["attack"]
  }
];

export const SHADOW_CASES: ShadowCase[] = [
  {
    name: "simple field",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  private int health;
}
`,
    entries: [{ kind: "field", name: "health" }]
  },
  {
    name: "simple method",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  public abstract void doSomething();
}
`,
    entries: [{ kind: "method", name: "doSomething" }]
  },
  {
    name: "@Shadow @Final field",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @Final
  private int maxHealth;
}
`,
    entries: [{ kind: "field", name: "maxHealth" }],
    warningCount: 0
  },
  {
    name: "@Shadow with a comment line before the declaration",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  // shadowed from the target
  private int health;
}
`,
    entries: [{ kind: "field", name: "health" }],
    warningCount: 0
  },
  {
    name: "@Shadow with a blank line before the declaration",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow

  private int health;
}
`,
    entries: [{ kind: "field", name: "health" }],
    warningCount: 0
  },
  {
    name: "@Shadow with multi-line annotation in between",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @Unique(value = "test"
  )
  private int health;
}
`,
    entries: [{ kind: "field", name: "health" }],
    warningCount: 0
  },
  {
    name: "inline annotation on field declaration",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @Final
  @Nullable private int health;
}
`,
    entries: [{ kind: "field", name: "health" }]
  },
  {
    name: "FQN annotation on separate line",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @org.jetbrains.annotations.Nullable
  private int health;
}
`,
    entries: [{ kind: "field", name: "health" }]
  },
  {
    name: "FQN inline annotation with parens",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @org.example.Nullable() private int health;
}
`,
    entries: [{ kind: "field", name: "health" }]
  },
  {
    name: "inline annotation on method declaration",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  @Deprecated public abstract void doWork();
}
`,
    entries: [{ kind: "method", name: "doWork" }]
  },
  {
    name: "synchronized method",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  public synchronized void doWork() {}
}
`,
    entries: [{ kind: "method", name: "doWork" }]
  },
  {
    name: "field with array type",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  private int[][] matrix;
}
`,
    entries: [{ kind: "field", name: "matrix" }],
    warningCount: 0
  },
  {
    name: "field with FQN type and generics",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  private java.util.Map<ResourceKey<Level>, ServerLevel> levels;
}
`,
    entries: [{ kind: "field", name: "levels" }],
    warningCount: 0
  },
  {
    name: "method with FQN return type",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  public abstract net.minecraft.world.item.ItemStack getMainHandItem();
}
`,
    entries: [{ kind: "method", name: "getMainHandItem" }],
    warningCount: 0
  },
  {
    name: "method with type parameter prefix",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  public abstract <T extends Entity> List<T> getEntities();
}
`,
    entries: [{ kind: "method", name: "getEntities" }],
    warningCount: 0
  },
  {
    name: "field with $ in name",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow
  private int some$field;
}
`,
    entries: [{ kind: "field", name: "some$field" }],
    warningCount: 0
  },
  {
    name: "@Shadow @Final same-line field declaration",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow @Final private static Component TOO_EXPENSIVE_TEXT;
}
`,
    entries: [{ kind: "field", name: "TOO_EXPENSIVE_TEXT" }],
    warningCount: 0
  },
  {
    name: "@Shadow same-line field without extra annotations",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow private int health;
}
`,
    entries: [{ kind: "field", name: "health" }],
    warningCount: 0
  },
  {
    name: "multiple consecutive same-line @Shadow declarations",
    source: `
@Mixin(SomeClass.class)
public abstract class SomeMixin {
  @Shadow @Final private static Component TOO_EXPENSIVE_TEXT;
  @Shadow private int repairItemCountCost;
  @Shadow private String itemName;
}
`,
    entries: [
      { kind: "field", name: "TOO_EXPENSIVE_TEXT" },
      { kind: "field", name: "repairItemCountCost" },
      { kind: "field", name: "itemName" }
    ],
    warningCount: 0
  }
];

export const ACCESSOR_CASES: AccessorCase[] = [
  {
    name: "explicit target",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" }
  },
  {
    name: "same-line declaration",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health") int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "getter naming convention",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  int getMaxHealth();
}
`,
    entry: { annotation: "Accessor", name: "getMaxHealth", targetName: "maxHealth" }
  },
  {
    name: "boolean is-getter",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  boolean isDead();
}
`,
    entry: { annotation: "Accessor", name: "isDead", targetName: "dead" }
  },
  {
    name: "acronym getter keeps leading caps (getURL -> URL)",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  String getURL();
}
`,
    entry: { annotation: "Accessor", name: "getURL", targetName: "URL" }
  },
  {
    name: "single-cap-then-lower getter decapitalizes (getId -> id)",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  int getId();
}
`,
    entry: { annotation: "Accessor", name: "getId", targetName: "id" }
  },
  {
    name: "is-getter with acronym keeps leading caps (isXRayEnabled -> XRayEnabled)",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  boolean isXRayEnabled();
}
`,
    entry: { annotation: "Accessor", name: "isXRayEnabled", targetName: "XRayEnabled" }
  },
  {
    name: "after multi-line annotation",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  @Unique(
    value = "test"
  )
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "FQN annotation",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health")
  @org.jetbrains.annotations.Nullable
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" }
  },
  {
    name: "default method modifier",
    source: `
import net.minecraft.world.entity.player.Player;

@Mixin(Player.class)
public interface PlayerAccessor {
  @Accessor("health")
  default int getHealth() { throw new AssertionError(); }
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "value attribute",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor(value = "health")
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "remap=false",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor(value = "health", remap = false)
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "trailing comment",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor("health") // access health field
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" },
    warningCount: 0
  },
  {
    name: "empty parentheses",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor()
  int getHealth();
}
`,
    entry: { annotation: "Accessor", name: "getHealth", targetName: "health" }
  },
  {
    name: "bare annotation without parentheses",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerAccessor {
  @Accessor
  int getMaxHealth();
}
`,
    entry: { annotation: "Accessor", name: "getMaxHealth", targetName: "maxHealth" }
  },
  {
    name: "array return type",
    source: `
@Mixin(SomeClass.class)
public interface SomeAccessor {
  @Accessor
  Slot[] getSlots();
}
`,
    entry: { annotation: "Accessor", name: "getSlots", targetName: "slots" },
    warningCount: 0
  },
  {
    name: "wildcard return type",
    source: `
@Mixin(SomeClass.class)
public interface SomeAccessor {
  @Accessor
  List<?> getItems();
}
`,
    entry: { annotation: "Accessor", name: "getItems", targetName: "items" },
    warningCount: 0
  },
  {
    name: "bounded wildcard return type",
    source: `
@Mixin(SomeClass.class)
public interface SomeAccessor {
  @Accessor
  List<? extends Item> getItems();
}
`,
    entry: { annotation: "Accessor", name: "getItems", targetName: "items" },
    warningCount: 0
  },
  {
    name: "no-modifier return type",
    source: `
@Mixin(SomeClass.class)
public interface SomeAccessor {
  @Accessor
  ServerTickRateManager tickRateManager();
}
`,
    entry: { annotation: "Accessor", name: "tickRateManager", targetName: "tickRateManager" },
    warningCount: 0
  },
  {
    name: "$ in method name",
    source: `
@Mixin(SomeClass.class)
public interface SomeAccessor {
  @Accessor
  Player metaStorage$getPlayer();
}
`,
    entry: { annotation: "Accessor", name: "metaStorage$getPlayer", targetName: "metaStorage$getPlayer" },
    warningCount: 0
  }
];

export const INVOKER_CASES: AccessorCase[] = [
  {
    name: "naming convention",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerInvoker {
  @Invoker
  void invokeDamage();
}
`,
    entry: { annotation: "Invoker", name: "invokeDamage", targetName: "damage" }
  },
  {
    name: "value attribute",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerInvoker {
  @Invoker(value = "damage")
  void invokeDamage();
}
`,
    entry: { annotation: "Invoker", name: "invokeDamage", targetName: "damage" }
  },
  {
    name: "empty parentheses",
    source: `
@Mixin(PlayerEntity.class)
public interface PlayerInvoker {
  @Invoker()
  void invokeDamage();
}
`,
    entry: { annotation: "Invoker", name: "invokeDamage", targetName: "damage" }
  }
];

export const IMPORT_CASES: ImportCase[] = [
  {
    name: "single import",
    source: `
import net.minecraft.world.entity.item.ItemEntity;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`,
    entries: {
      ItemEntity: "net.minecraft.world.entity.item.ItemEntity"
    }
  },
  {
    name: "multiple imports",
    source: `
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`,
    entries: {
      ItemEntity: "net.minecraft.world.entity.item.ItemEntity",
      Player: "net.minecraft.world.entity.player.Player",
      Mixin: "org.spongepowered.asm.mixin.Mixin"
    }
  },
  {
    name: "wildcard imports are ignored",
    source: `
import java.util.*;
import net.minecraft.world.entity.item.ItemEntity;

@Mixin(ItemEntity.class)
public abstract class ItemEntityMixin {
}
`,
    entries: {
      ItemEntity: "net.minecraft.world.entity.item.ItemEntity"
    }
  },
  {
    name: "no imports",
    source: `
@Mixin(net.minecraft.world.entity.item.ItemEntity.class)
public abstract class ItemEntityMixin {
}
`,
    entries: {}
  }
];

export const WARNING_CASES: WarningCase[] = [
  {
    name: "@Mixin target is missing",
    source: `
public abstract class BadMixin {
  @Shadow
  private int field;
}
`,
    expectedTargets: 0,
    warningFragment: "No @Mixin annotation target"
  },
  {
    name: "@Inject method attribute is missing",
    source: `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Inject(at = @At("HEAD"))
  private void onTick(CallbackInfo ci) {}
}
`,
    expectedTargets: 1,
    expectedInjections: 0,
    warningFragment: "missing method attribute"
  }
];
