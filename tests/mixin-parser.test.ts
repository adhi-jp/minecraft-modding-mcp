import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../src/mixin-parser.ts";

type TargetCase = {
  name: string;
  source: string;
  targets: string[];
  priority?: number;
  className?: string;
  warningCount?: number;
};

type InjectionCase = {
  name: string;
  source: string;
  annotation: string;
  methods: string[];
  lines?: number[];
  warningCount?: number;
};

type ShadowCase = {
  name: string;
  source: string;
  entries: Array<{ kind: "field" | "method"; name: string }>;
  warningCount?: number;
};

type AccessorCase = {
  name: string;
  source: string;
  entry: {
    annotation: "Accessor" | "Invoker";
    name: string;
    targetName: string;
  };
  warningCount?: number;
};

type ImportCase = {
  name: string;
  source: string;
  entries: Record<string, string>;
};

type WarningCase = {
  name: string;
  source: string;
  expectedTargets: number;
  warningFragment: string;
  expectedInjections?: number;
};

const TARGET_CASES: TargetCase[] = [
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

const INJECTION_CASES: InjectionCase[] = [
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

const SHADOW_CASES: ShadowCase[] = [
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

const ACCESSOR_CASES: AccessorCase[] = [
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

const INVOKER_CASES: AccessorCase[] = [
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

const IMPORT_CASES: ImportCase[] = [
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

const WARNING_CASES: WarningCase[] = [
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

test("parseMixinSource extracts imports and ignores wildcard imports", () => {
  for (const testCase of IMPORT_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.imports.size, Object.keys(testCase.entries).length, `${testCase.name}: import count`);
    assert.deepEqual(
      Object.fromEntries(result.imports.entries()),
      testCase.entries,
      `${testCase.name}: imports`
    );
  }
});

test("parseMixinSource reports parse warnings for missing required annotations", () => {
  for (const testCase of WARNING_CASES) {
    const result = parseMixinSource(testCase.source);

    assert.equal(result.targets.length, testCase.expectedTargets, `${testCase.name}: target count`);
    if (testCase.expectedInjections !== undefined) {
      assert.equal(result.injections.length, testCase.expectedInjections, `${testCase.name}: injection count`);
    }
    assert.ok(
      result.parseWarnings.some((warning) => warning.includes(testCase.warningFragment)),
      `${testCase.name}: warning`
    );
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
