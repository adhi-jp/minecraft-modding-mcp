# NeoForge Reference

## Table of Contents

1. [Project Structure](#project-structure)
2. [Registration with DeferredRegister](#registration-with-deferredregister)
3. [Event Bus System](#event-bus-system)
4. [Capabilities](#capabilities)
5. [Data Generation](#data-generation)
6. [Networking](#networking)
7. [Sided Access](#sided-access)
8. [Common Pitfalls](#common-pitfalls)

---

These examples assume a current NeoForge workspace targeting Minecraft `1.21.x` on Java `21` unless a section says otherwise. For `1.20.1`-era projects, verify builder, codec, and `ResourceLocation` helper differences with MCP before copying code.

## Project Structure

A typical NeoForge mod layout:

```
src/main/
├── java/com/example/mymod/
│   ├── MyMod.java              # Main mod class with @Mod annotation
│   ├── block/                   # Block classes
│   ├── item/                    # Item classes
│   ├── entity/                  # Entity classes
│   ├── network/                 # Packet definitions
│   ├── client/                  # Client-only code (renderers, screens)
│   └── datagen/                 # Data generation providers
├── resources/
│   ├── META-INF/
│   │   └── neoforge.mods.toml  # Mod metadata (replaces mods.toml)
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

Key config file: `neoforge.mods.toml` in `META-INF/`. This replaced the older `mods.toml` format. It defines mod ID, name, version, dependencies, and display info.

## Registration with DeferredRegister

NeoForge uses `DeferredRegister` to register all game objects. This ensures correct ordering and lifecycle management.

```java
public class ModBlocks {
    public static final DeferredRegister.Blocks BLOCKS =
        DeferredRegister.createBlocks("mymod");

    public static final DeferredBlock<Block> MY_BLOCK =
        BLOCKS.registerSimpleBlock("my_block",
            BlockBehaviour.Properties.of().strength(3.0f));

    // Block with custom class
    public static final DeferredBlock<MyMachineBlock> MACHINE =
        BLOCKS.register("machine",
            () -> new MyMachineBlock(BlockBehaviour.Properties.of().strength(4.0f)));

    // Auto-register BlockItem
    public static final DeferredItem<BlockItem> MY_BLOCK_ITEM =
        ModItems.ITEMS.registerSimpleBlockItem(MY_BLOCK);
}
```

```java
public class ModItems {
    public static final DeferredRegister.Items ITEMS =
        DeferredRegister.createItems("mymod");

    public static final DeferredItem<Item> MY_ITEM =
        ITEMS.registerSimpleItem("my_item",
            new Item.Properties().stacksTo(16));
}
```

In the main mod class, register all `DeferredRegister` instances from the injected mod event bus:
```java
@Mod("mymod")
public class MyMod {
    public MyMod(IEventBus modEventBus) {
        ModBlocks.BLOCKS.register(modEventBus);
        ModItems.ITEMS.register(modEventBus);
        ModEntities.ENTITIES.register(modEventBus);
    }
}
```

For current `1.21.x` projects, prefer constructor injection of `IEventBus` over an empty no-arg constructor. If a template still uses a no-arg constructor, update it before copying this pattern so the registration flow stays consistent.

### Entity Registration

```java
public class ModEntities {
    public static final DeferredRegister<EntityType<?>> ENTITIES =
        DeferredRegister.create(Registries.ENTITY_TYPE, "mymod");

    public static final DeferredHolder<EntityType<?>, EntityType<MyEntity>> MY_ENTITY =
        ENTITIES.register("my_entity",
            () -> EntityType.Builder.of(MyEntity::new, MobCategory.CREATURE)
                .sized(0.6f, 1.8f)
                .build("my_entity"));
}
```

Attribute registration happens via `EntityAttributeCreationEvent`:
```java
@SubscribeEvent
public static void registerAttributes(EntityAttributeCreationEvent event) {
    event.put(ModEntities.MY_ENTITY.get(), MyEntity.createAttributes().build());
}
```

### Creative Tab Registration

```java
public static final DeferredRegister<CreativeModeTab> TABS =
    DeferredRegister.create(Registries.CREATIVE_MODE_TAB, "mymod");

public static final DeferredHolder<CreativeModeTab, CreativeModeTab> MY_TAB =
    TABS.register("my_tab", () -> CreativeModeTab.builder()
        .title(Component.translatable("itemGroup.mymod"))
        .icon(() -> ModItems.MY_ITEM.get().getDefaultInstance())
        .displayItems((params, output) -> {
            output.accept(ModItems.MY_ITEM.get());
            output.accept(ModBlocks.MY_BLOCK_ITEM.get());
        })
        .build());
```

## Event Bus System

NeoForge has two event buses:

- **Mod Event Bus** (`IEventBus` from constructor) — Lifecycle events: registration, datagen, client setup.
- **Game Event Bus** (`NeoForge.EVENT_BUS`) — Runtime events: player interaction, world tick, entity spawn.

```java
// Mod bus (via @Mod constructor parameter or @EventBusSubscriber)
@EventBusSubscriber(modid = "mymod", bus = EventBusSubscriber.Bus.MOD)
public class ModEvents {
    @SubscribeEvent
    public static void onClientSetup(FMLClientSetupEvent event) {
        // Register renderers, screens, etc.
    }
}

// Game bus
@EventBusSubscriber(modid = "mymod", bus = EventBusSubscriber.Bus.GAME)
public class GameEvents {
    @SubscribeEvent
    public static void onRightClickBlock(PlayerInteractEvent.RightClickBlock event) {
        // Handle interaction
    }
}
```

Frequent mistake: using `Bus.GAME` for registration events or `Bus.MOD` for gameplay events. Registration events fire on the mod bus during startup; gameplay events fire on the game bus during runtime.

## Capabilities

NeoForge capabilities provide a standardized way to expose block/entity/item features:

```java
// Registering a capability on a block entity
@SubscribeEvent
public static void registerCapabilities(RegisterCapabilitiesEvent event) {
    event.registerBlockEntity(
        Capabilities.ItemHandler.BLOCK,
        ModBlockEntities.MY_MACHINE.get(),
        (blockEntity, direction) -> blockEntity.getItemHandler(direction)
    );
}
```

Built-in capability types: `ItemHandler`, `FluidHandler`, `EnergyStorage`. Custom capabilities can be created for mod-specific features.

## Data Generation

NeoForge datagen setup in `build.gradle`:
```groovy
runs {
    data {
        data()
        programArguments.addAll(
            '--mod', 'mymod',
            '--all',
            '--output', file('src/generated/resources/').absolutePath,
            '--existing', file('src/main/resources/').absolutePath
        )
    }
}
```

Provider examples:

```java
// Block state and model provider
public class ModBlockStateProvider extends BlockStateProvider {
    public ModBlockStateProvider(PackOutput output, ExistingFileHelper efh) {
        super(output, "mymod", efh);
    }

    @Override
    protected void registerStatesAndModels() {
        simpleBlock(ModBlocks.MY_BLOCK.get());
        // For blocks with properties:
        getVariantBuilder(ModBlocks.MACHINE.get())
            .partialState().with(MyMachineBlock.ACTIVE, false)
                .modelForState().modelFile(models().cubeAll("machine_off", modLoc("block/machine_off"))).addModel()
            .partialState().with(MyMachineBlock.ACTIVE, true)
                .modelForState().modelFile(models().cubeAll("machine_on", modLoc("block/machine_on"))).addModel();
    }
}

// Loot table provider
public class ModLootTableProvider extends BlockLootSubProvider {
    protected ModLootTableProvider(HolderLookup.Provider lookupProvider) {
        super(Set.of(), FeatureFlags.DEFAULT_FLAGS, lookupProvider);
    }

    @Override
    protected void generate() {
        dropSelf(ModBlocks.MY_BLOCK.get());
    }
}

// Recipe provider
public class ModRecipeProvider extends RecipeProvider {
    public ModRecipeProvider(PackOutput output, CompletableFuture<HolderLookup.Provider> lookupProvider) {
        super(output, lookupProvider);
    }

    @Override
    protected void buildRecipes(RecipeOutput output) {
        ShapedRecipeBuilder.shaped(RecipeCategory.BUILDING_BLOCKS, ModBlocks.MY_BLOCK.get())
            .pattern("###")
            .pattern("# #")
            .pattern("###")
            .define('#', Items.IRON_INGOT)
            .unlockedBy("has_iron", has(Items.IRON_INGOT))
            .save(output);
    }
}
```

Register all providers in a `GatherDataEvent` handler.

## Networking

NeoForge uses `CustomPacketPayload` for network packets:

```java
public record MyPayload(BlockPos pos, int value) implements CustomPacketPayload {
    public static final Type<MyPayload> TYPE =
        new Type<>(ResourceLocation.fromNamespaceAndPath("mymod", "my_payload"));

    public static final StreamCodec<FriendlyByteBuf, MyPayload> STREAM_CODEC =
        StreamCodec.composite(
            BlockPos.STREAM_CODEC, MyPayload::pos,
            ByteBufCodecs.INT, MyPayload::value,
            MyPayload::new
        );

    @Override
    public Type<? extends CustomPacketPayload> type() { return TYPE; }
}
```

Registration:
```java
@SubscribeEvent
public static void registerPayloads(RegisterPayloadHandlersEvent event) {
    PayloadRegistrar registrar = event.registrar("mymod");
    registrar.playToServer(MyPayload.TYPE, MyPayload.STREAM_CODEC, MyPayload::handleOnServer);
}
```

Handle on the correct thread — `handleOnServer` runs on the network thread, so schedule game state changes:
```java
public void handleOnServer(IPayloadContext context) {
    context.enqueueWork(() -> {
        // Safe to modify game state here
    });
}
```

## Sided Access

Use `@EventBusSubscriber(value = Dist.CLIENT)` for client-only event handlers. For code that must run on both sides but behave differently, use `DistExecutor` or separate client/server proxy classes.

Renderer registration (client-only):
```java
@EventBusSubscriber(modid = "mymod", bus = Bus.MOD, value = Dist.CLIENT)
public class ClientSetup {
    @SubscribeEvent
    public static void onClientSetup(FMLClientSetupEvent event) {
        MenuScreens.register(ModMenus.MY_MENU.get(), MyScreen::new);
    }

    @SubscribeEvent
    public static void registerRenderers(EntityRenderersEvent.RegisterRenderers event) {
        event.registerEntityRenderer(ModEntities.MY_ENTITY.get(), MyEntityRenderer::new);
    }
}
```

## Common Pitfalls

- **Using `Registry.register()` directly** — Always use `DeferredRegister`. Direct registry access can cause ordering bugs.
- **Accessing client classes on server** — Causes `NoClassDefFoundError` on dedicated servers. Keep client code in `@OnlyIn(Dist.CLIENT)` classes or separate packages.
- **Wrong event bus** — `RegisterCapabilitiesEvent`, `EntityAttributeCreationEvent`, `FMLClientSetupEvent` are on the MOD bus. `LivingDeathEvent`, `BlockEvent.BreakEvent` are on the GAME bus.
- **Missing `neoforge.mods.toml`** — The mod won't load without it. Make sure `modId` in the TOML matches `@Mod("modid")`.
- **Datagen output not in sourceSets** — Add `sourceSets.main.resources.srcDir("src/generated/resources")` to `build.gradle` so generated files are included in the build.
