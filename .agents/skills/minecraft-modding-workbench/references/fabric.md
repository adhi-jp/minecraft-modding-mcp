# Fabric Reference

## Table of Contents

1. [Version Target](#version-target)
2. [Project Structure](#project-structure)
3. [Registration](#registration)
4. [Fabric API Modules](#fabric-api-modules)
5. [Mixins](#mixins)
6. [Data Generation](#data-generation)
7. [Networking](#networking)
8. [Entrypoints](#entrypoints)
9. [Common Pitfalls](#common-pitfalls)

---

## Version Target

Treat the examples in this file as Fabric defaults for Minecraft `1.21.1` on Java `21`.

- Use these snippets as pattern guidance, not blind copy-paste.
- If the workspace is on `1.20.x`, downgrade the Mixin compatibility level to `JAVA_17` and align the dependency versions with the project.
- If the workspace is on `1.19.x` or older, verify API differences with MCP before copying. Common breakpoints are `Identifier.of(...)`, `Registries.*`, and the `CustomPayload` / `PacketCodec` networking flow.

## Project Structure

A typical Fabric mod layout:

```
src/main/
├── java/com/example/mymod/
│   ├── MyMod.java              # Main entrypoint (implements ModInitializer)
│   ├── MyModClient.java        # Client entrypoint (implements ClientModInitializer)
│   ├── block/
│   ├── item/
│   ├── entity/
│   ├── network/
│   ├── client/
│   ├── datagen/
│   └── mixin/                  # Mixin classes
├── resources/
│   ├── fabric.mod.json         # Mod metadata
│   ├── mymod.mixins.json       # Mixin config
│   ├── assets/<modid>/
│   │   ├── blockstates/
│   │   ├── lang/
│   │   ├── models/
│   │   └── textures/
│   └── data/<modid>/
│       ├── loot_tables/
│       ├── recipes/
│       └── tags/
```

Key config file: `fabric.mod.json`. Defines mod ID, entrypoints, mixins, dependencies.

```json
{
  "schemaVersion": 1,
  "id": "mymod",
  "version": "${version}",
  "name": "My Mod",
  "entrypoints": {
    "main": ["com.example.mymod.MyMod"],
    "client": ["com.example.mymod.MyModClient"]
  },
  "mixins": ["mymod.mixins.json"],
  "depends": {
    "fabricloader": ">=0.16.0",
    "minecraft": "~1.21.1",
    "fabric-api": "*"
  }
}
```

## Registration

Fabric uses Minecraft's vanilla `Registry` system directly, with helpers from Fabric API:

```java
public class ModBlocks {
    public static final Block MY_BLOCK = Registry.register(
        Registries.BLOCK,
        Identifier.of("mymod", "my_block"),
        new Block(AbstractBlock.Settings.create().strength(3.0f))
    );

    // Block with custom class
    public static final MyMachineBlock MACHINE = Registry.register(
        Registries.BLOCK,
        Identifier.of("mymod", "machine"),
        new MyMachineBlock(AbstractBlock.Settings.create().strength(4.0f))
    );

    // BlockItem must be registered separately
    public static final BlockItem MY_BLOCK_ITEM = Registry.register(
        Registries.ITEM,
        Identifier.of("mymod", "my_block"),
        new BlockItem(MY_BLOCK, new Item.Settings())
    );

    // Call this from ModInitializer to force class loading
    public static void initialize() {}
}
```

```java
public class ModItems {
    public static final Item MY_ITEM = Registry.register(
        Registries.ITEM,
        Identifier.of("mymod", "my_item"),
        new Item(new Item.Settings().maxCount(16))
    );

    public static void initialize() {}
}
```

In the main mod class:
```java
public class MyMod implements ModInitializer {
    @Override
    public void onInitialize() {
        ModBlocks.initialize();
        ModItems.initialize();
        ModEntities.initialize();
    }
}
```

The `initialize()` pattern forces static initializers to run, which triggers registration. Without calling these, the classes may never load.

### Entity Registration

```java
public class ModEntities {
    public static final EntityType<MyEntity> MY_ENTITY = Registry.register(
        Registries.ENTITY_TYPE,
        Identifier.of("mymod", "my_entity"),
        EntityType.Builder.create(MyEntity::new, SpawnGroup.CREATURE)
            .dimensions(0.6f, 1.8f)
            .build()
    );

    public static void initialize() {
        FabricDefaultAttributeRegistry.register(MY_ENTITY, MyEntity.createAttributes());
    }
}
```

### Creative Tab (Item Group)

```java
public static final ItemGroup MY_GROUP = FabricItemGroup.builder()
    .icon(() -> new ItemStack(ModItems.MY_ITEM))
    .displayName(Text.translatable("itemGroup.mymod"))
    .entries((context, entries) -> {
        entries.add(ModItems.MY_ITEM);
        entries.add(ModBlocks.MY_BLOCK_ITEM);
    })
    .build();

// Register the group
Registry.register(Registries.ITEM_GROUP, Identifier.of("mymod", "my_group"), MY_GROUP);
```

## Fabric API Modules

Fabric API provides modular extensions. Key modules:

| Module | Purpose |
|--------|---------|
| `fabric-api-base` | Core utilities |
| `fabric-events-interaction-v0` | Player interaction events |
| `fabric-events-lifecycle-v1` | Server/world tick, load/unload events |
| `fabric-item-group-api-v1` | Creative tab management |
| `fabric-biome-api-v1` | Biome modifications |
| `fabric-rendering-v1` | Custom rendering hooks |
| `fabric-networking-api-v1` | Packet system |
| `fabric-resource-loader-v0` | Resource/data pack utilities |
| `fabric-loot-api-v2` | Loot table modification |
| `fabric-object-builder-api-v1` | Block/entity settings extensions |

Use events from these modules instead of Mixins whenever possible — they're more compatible with other mods and less fragile across versions.

```java
// Lifecycle event example
ServerTickEvents.END_SERVER_TICK.register(server -> {
    // Runs every server tick
});

// Player interaction
UseBlockCallback.EVENT.register((player, world, hand, hitResult) -> {
    // Handle right-click on block
    return ActionResult.PASS;
});

// Biome modification
BiomeModifications.addFeature(
    BiomeSelectors.foundInOverworld(),
    GenerationStep.Feature.UNDERGROUND_ORES,
    myOrePlacedFeatureKey
);
```

## Mixins

Mixins allow modifying vanilla (or other mod) code at the bytecode level. Fabric mods rely on them heavily since Fabric has no event for everything.

### Mixin Config (`mymod.mixins.json`)

```json
{
  "required": true,
  "package": "com.example.mymod.mixin",
  "compatibilityLevel": "JAVA_21",
  "mixins": [
    "ServerPlayerMixin"
  ],
  "client": [
    "ClientWorldMixin"
  ],
  "injectors": {
    "defaultRequire": 1
  }
}
```

`"mixins"` for both-sides, `"client"` for client-only, `"server"` for server-only.

### Common Mixin Types

**@Inject** — Insert code at a point in the target method:
```java
@Mixin(LivingEntity.class)
public abstract class LivingEntityMixin {
    @Inject(method = "heal", at = @At("HEAD"))
    private void onHeal(float amount, CallbackInfo ci) {
        // Runs before healing is applied
    }

    @Inject(method = "heal", at = @At("RETURN"))
    private void afterHeal(float amount, CallbackInfo ci) {
        // Runs after healing is applied
    }
}
```

**@Redirect** — Replace a single method call within the target:
```java
@Redirect(method = "heal",
    at = @At(value = "INVOKE", target = "Lnet/minecraft/entity/LivingEntity;setHealth(F)V"))
private void redirectSetHealth(LivingEntity entity, float health) {
    entity.setHealth(health + 2.0F); // Add a small bonus
}
```

**@ModifyVariable** — Change a local variable:
```java
@ModifyVariable(method = "heal", at = @At("HEAD"), argsOnly = true, ordinal = 0)
private float modifyHealAmount(float amount) {
    return amount * 0.5f; // Halve incoming healing
}
```

Treat these as pattern examples, not copy-paste targets. Verify the exact owner, method, and descriptor for your Minecraft version with MCP before writing the real Mixin.

**@Accessor / @Invoker** — Safe access to private members:
```java
@Mixin(LivingEntity.class)
public interface LivingEntityAccessor {
    @Accessor("lastHurtByMob")
    LivingEntity getLastAttacker();

    @Invoker("actuallyHurt")
    void invokeActuallyHurt(DamageSource source, float amount);
}
```

### Mixin Best Practices

- **Prefer Fabric events over Mixins** — Mixins are powerful but fragile. If Fabric API has an event for what you need, use it.
- **Keep Mixins minimal** — Inject a hook that calls into your own code, rather than putting complex logic inside the Mixin.
- **Use `@Unique` for added fields/methods** — Prevents naming conflicts with other mods.
- **Test with other mods** — Mixin conflicts are a top source of mod incompatibility.

## Data Generation

Fabric datagen uses the `DataGeneratorEntrypoint` interface with `FabricDataGenerator`:

```java
public class MyModDataGenerator implements DataGeneratorEntrypoint {
    @Override
    public void onInitializeDataGenerator(FabricDataGenerator generator) {
        FabricDataGenerator.Pack pack = generator.createPack();
        pack.addProvider(ModModelProvider::new);
        pack.addProvider(ModBlockLootTableProvider::new);
        pack.addProvider(ModRecipeProvider::new);
    }
}
```

Register in `fabric.mod.json`:
```json
"entrypoints": {
    "fabric-datagen": ["com.example.mymod.datagen.MyModDataGenerator"]
}
```

Run with: `./gradlew runDatagen`

Provider examples:

```java
public class ModModelProvider extends FabricModelProvider {
    public ModModelProvider(FabricDataOutput output) {
        super(output);
    }

    @Override
    public void generateBlockStateModels(BlockStateModelGenerator generator) {
        generator.registerSimpleCubeAll(ModBlocks.MY_BLOCK);
    }

    @Override
    public void generateItemModels(ItemModelGenerator generator) {
        generator.register(ModItems.MY_ITEM, Models.GENERATED);
    }
}

public class ModBlockLootTableProvider extends FabricBlockLootTableProvider {
    protected ModBlockLootTableProvider(FabricDataOutput output, CompletableFuture<RegistryWrapper.WrapperLookup> lookup) {
        super(output, lookup);
    }

    @Override
    public void generate() {
        addDrop(ModBlocks.MY_BLOCK);
    }
}
```

## Networking

Fabric uses `PayloadTypeRegistry` with `ServerPlayNetworking` / `ClientPlayNetworking`:

```java
// Define payload
public record MyPayload(BlockPos pos, int value) implements CustomPayload {
    public static final Id<MyPayload> ID =
        new Id<>(Identifier.of("mymod", "my_payload"));

    public static final PacketCodec<PacketByteBuf, MyPayload> CODEC =
        PacketCodec.tuple(
            BlockPos.PACKET_CODEC, MyPayload::pos,
            PacketCodecs.INTEGER, MyPayload::value,
            MyPayload::new
        );

    @Override
    public Id<? extends CustomPayload> getId() { return ID; }
}
```

Registration and handling:
```java
// In ModInitializer
PayloadTypeRegistry.playC2S().register(MyPayload.ID, MyPayload.CODEC);

ServerPlayNetworking.registerGlobalReceiver(MyPayload.ID, (payload, context) -> {
    context.player().server.execute(() -> {
        // Safe to modify game state
    });
});

// Sending from client
ClientPlayNetworking.send(new MyPayload(pos, 42));
```

## Entrypoints

Fabric supports multiple entrypoint types:

| Entrypoint | Interface | When it runs |
|-----------|-----------|-------------|
| `main` | `ModInitializer` | Both sides, during startup |
| `client` | `ClientModInitializer` | Client only |
| `server` | `DedicatedServerModInitializer` | Dedicated server only |
| `fabric-datagen` | `DataGeneratorEntrypoint` | During data generation |

Keep client-only code (renderers, screens, key bindings) in the `client` entrypoint. Referencing client classes from `main` causes crashes on dedicated servers.

```java
public class MyModClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        EntityRendererRegistry.register(ModEntities.MY_ENTITY, MyEntityRenderer::new);
        BlockRenderLayerMap.INSTANCE.putBlock(ModBlocks.MY_BLOCK, RenderLayer.getCutout());
        HandledScreens.register(ModScreenHandlers.MY_HANDLER, MyScreen::new);
    }
}
```

## Common Pitfalls

- **Forgetting `initialize()` calls** — Static registration only happens when the class is loaded. If you don't call something in the class from your entrypoint, nothing gets registered.
- **Client imports in `main` entrypoint** — `import net.minecraft.client.*` in server-reachable code crashes dedicated servers. Use separate client entrypoint.
- **Mixin refmap issues** — If you rename packages or classes, regenerate the refmap (`./gradlew clean` then rebuild). Stale refmaps cause silent Mixin failures.
- **Missing Fabric API dependency** — If you use Fabric API modules, declare the dependency in `fabric.mod.json`. Missing it causes confusing errors on mod loaders that don't bundle Fabric API.
- **Wrong `compatibilityLevel` in Mixin config** — These examples target MC 1.21.1, so use `JAVA_21` here. For MC 1.20.x, drop back to `JAVA_17`.
- **Not separating client/common Mixins** — Put client-targeting Mixins in the `"client"` array, not `"mixins"`. Server-side class loading of client Mixins crashes.
