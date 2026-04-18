# Bootstrap From Template

## Table of Contents

1. [When to Read This](#when-to-read-this)
2. [Detect a Sparse Template](#detect-a-sparse-template)
3. [Fabric Bootstrap](#fabric-bootstrap)
4. [NeoForge Bootstrap](#neoforge-bootstrap)
5. [Architectury Bootstrap](#architectury-bootstrap)
6. [Verification Defaults](#verification-defaults)

## When to Read This

Read this file when the project already exists but is still close to the loader template:

- Only the main mod class exists
- Registration classes do not exist yet
- There is little or no client initialization
- Datagen is absent or half-wired
- Assets and data folders are mostly empty

The goal is not to build a giant framework up front. The goal is to create the smallest skeleton that can support the requested feature cleanly.

## Detect a Sparse Template

Treat the project as sparse when most of these are true:

- Only one or two Java classes exist under the base package
- No `ModBlocks`, `ModItems`, `ModEntities`, `ModBlockEntities`, `ModMenus`, or similar registration classes exist
- The main mod entrypoint does not call registration helpers
- Client entrypoint or client event wiring is missing
- `src/generated/resources` or datagen providers do not exist
- Resource folders contain only loader metadata and no feature assets

When the template is sparse:

- Create only the subsystems needed by the requested feature.
- Keep names aligned with the project package and loader conventions.
- Prefer one registry class per content category instead of scattering registrations through the main mod class.

## Fabric Bootstrap

For a fresh Fabric template, create the minimum structure below when absent:

- `MyMod` implementing `ModInitializer`
- `MyModClient` implementing `ClientModInitializer` if the feature has renderer, screen, model layer, block render layer, or client networking
- `ModBlocks` when the feature adds blocks
- `ModItems` when the feature adds items or block items
- `ModEntities` when the feature adds entities
- `ModBlockEntities` when the feature needs block entities
- `ModScreenHandlers` when the feature opens menus or screens
- `datagen/MyModDataGenerator` when the project uses or should use datagen

Update `fabric.mod.json` to match the actual scaffold:

- Keep the `main` entrypoint pointed at the real main class.
- Add `client` only when client code exists.
- Add `fabric-datagen` only when datagen entrypoint exists.
- Add mixin config entries only when Mixins are actually present.

Prefer this bootstrap pattern:

1. Keep the main initializer thin.
2. Call `initialize()` methods on registration classes from `onInitialize()`.
3. Register client-only concerns inside `MyModClient`.
4. Put datagen providers under `datagen/` and wire them through the datagen entrypoint.

For first-feature requests, the usual minimal slice is:

- One registration class for the new content category
- One main initializer update
- One client initializer update if required
- Only the assets and data files needed for that feature

Avoid creating entity, menu, packet, or datagen infrastructure if the requested feature is a simple item or block that does not need it.

## NeoForge Bootstrap

For a fresh NeoForge template, create the minimum structure below when absent:

- Main mod class annotated with `@Mod(modid)`
- `ModBlocks` using `DeferredRegister.Blocks` when the feature adds blocks
- `ModItems` using `DeferredRegister.Items` when the feature adds items or block items
- `ModEntities` when the feature adds entities
- `ModBlockEntities` when the feature needs block entities
- `ModMenus` when the feature opens menus or screens
- Client setup class or subscriber only when the feature has renderer, screen, model layer, or client networking
- Datagen event wiring only when the project should generate assets or data

Update the main mod class to register only the needed deferred registers on the mod event bus.

Prefer this bootstrap pattern:

1. Keep the `@Mod` class focused on wiring registers and event listeners.
2. Put runtime gameplay events on the game bus and setup or registration events on the mod bus.
3. Keep client setup in a client-only subscriber.
4. Add datagen providers through the proper gather-data flow instead of hard-coding generated files into the main runtime path.

For first-feature requests, the usual minimal slice is:

- One or two deferred register classes
- One main mod wiring change
- One client subscriber if required
- Only the assets and data files needed for that feature

Avoid creating capability, packet, worldgen, or menu infrastructure until the requested feature requires it.

## Architectury Bootstrap

For a fresh Architectury template, first decide which parts belong in `common` and which belong in platform modules.

Create the minimum structure below when absent:

- `common` module for shared logic and shared resources
- `fabric` module for Fabric entrypoints and Fabric-only wiring
- `neoforge` module for NeoForge mod bootstrap and NeoForge-only wiring
- Shared initialization entry in `common` if the workspace uses one
- Platform bridge methods only when the feature truly needs loader-specific APIs

Prefer this bootstrap pattern:

1. Put the requested feature's shared model and behavior in `common`.
2. Put loader-bound startup and registration glue in `fabric` and `neoforge`.
3. Add `@ExpectPlatform` or a plain Java bridge only for the narrow platform-specific gap.
4. Keep shared assets in `common` and loader metadata in the platform module that owns it.

For first-feature requests, the usual minimal slice is:

- One shared implementation in `common`
- One Fabric bootstrap change
- One NeoForge bootstrap change
- Only the bridge code and metadata required for the feature

If the generated template already has working Fabric and NeoForge entrypoints that delegate to the shared init path:

- A first simple item or block may require only new `common` registry classes and shared resources.
- Reuse the existing platform entrypoints instead of editing both platform modules for symmetry alone.

Avoid copying the same gameplay logic into both platform modules unless the workspace already chose that style intentionally.

## Verification Defaults

After bootstrapping and implementing the first feature, run the narrowest useful verification loop:

1. Run `./gradlew build`.
2. Run datagen if you added datagen providers or the project expects generated resources.
   - Fabric: `./gradlew runDatagen`
   - NeoForge: use the project's configured datagen task or run configuration
3. Run the client when practical if the change includes rendering, screens, entity visuals, or runtime behavior that static checks cannot validate.
4. Use MCP validation tools even when Gradle tasks cannot run.
5. In sandboxed environments with an unwritable home directory, retry Gradle with a writable `GRADLE_USER_HOME` such as `/tmp/gradle-home` before treating the failure as a project problem.

If verification fails, prefer fixing the concrete error rather than redesigning the scaffold.
