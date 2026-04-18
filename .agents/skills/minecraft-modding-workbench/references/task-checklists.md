# Common Task Checklists

Start with the matching high-level recipe in `references/mcp-recipes.md`, then use the checklist below to make sure the delivered slice is actually complete.

## Table of Contents

1. [Simple Block or Item](#simple-block-or-item)
2. [Container Block or Block Entity](#container-block-or-block-entity)
3. [Entity or Mob](#entity-or-mob)
4. [Mixin or Access Widener](#mixin-or-access-widener)
5. [Worldgen or Data-Driven Content](#worldgen-or-data-driven-content)
6. [Porting or Compatibility Fixes](#porting-or-compatibility-fixes)
7. [Mod JAR Analysis](#mod-jar-analysis)

## Simple Block or Item

Deliverables:

- Register the block or item.
- Register the `BlockItem` separately unless the project helper already does it.
- Add the creative tab entry if the project uses one.
- Add `blockstates`, models, loot tables, and lang keys as needed.
- Update datagen providers instead of hand-writing JSON if the project already uses datagen.
- Add tags, recipes, or advancements when the request implies them.
- In Architectury, keep the slice in `common` only when the workspace already uses loader-agnostic registry helpers there.

Vanilla anchors:

- A simple solid block or simple consumable item of the same category.
- The matching vanilla JSON layout for blockstates, item models, and loot tables.

Common misses:

- Missing `BlockItem`
- Missing loot table
- Wrong asset path or casing
- Registration performed in the wrong lifecycle phase

## Container Block or Block Entity

Deliverables:

- Block registration
- Block entity type and implementation
- Menu or container type
- Screen and screen registration when the UI is visible
- Data sync or menu slots needed for interaction
- Save and load logic for persistent state
- Blockstate, models, loot table, and lang entries

Vanilla anchors:

- `ChestBlock`, `ChestBlockEntity`, `ChestMenu`, `ChestScreen`
- `BarrelBlock` for a simpler container pattern
- `FurnaceBlock` when progress bars or recipes are involved

Common misses:

- Screen registered on the wrong side
- Missing block entity ticker or sync path
- Menu type not registered
- Interaction opening the UI on the client instead of the server

## Entity or Mob

Deliverables:

- `EntityType` registration
- Entity class
- Attributes
- Renderer
- Model or render layer definition
- Client-side registration
- Spawn egg if the request wants one
- AI goals or brain setup
- Lang entries and placeholder texture paths if art is missing
- Spawn rules or spawn placement when relevant

Vanilla anchors:

- The nearest vanilla mob, renderer, and model pipeline
- Vanilla attribute and goal setup for the same behavior style

Common misses:

- Attributes not registered
- Renderer registered on the wrong side
- Spawn egg created without a registered entity type
- Goals added but navigation or target selectors left unconfigured

## Mixin or Access Widener

Recipe:

- Start with `validate-project`.
- Drop to `validate-mixin` or `validate-access-widener` only when you need exact issue detail.

Checklist:

- Prefer a loader event or API hook over a Mixin when one exists.
- Prefer accessor or invoker Mixins when field or method access is the only goal.
- Record the exact owner, method name, descriptor, and mapping namespace before writing the change.
- Update the mixin config or access widener file together with the code change.
- Read the target class source to confirm the injection point or member still exists in this Minecraft version.

Common misses:

- Wrong mapping namespace
- Wrong descriptor
- Injection point moved in the target version
- Client-only targets referenced from common code

## Worldgen or Data-Driven Content

Deliverables:

- Configured feature, placed feature, biome modifier, or loader-specific hook
- Registry keys and registration
- Data JSON or datagen providers for worldgen assets
- Tags, loot tables, lang keys, or recipes if the feature introduces new content

Vanilla anchors:

- The nearest vanilla ore, structure, biome modifier, or placed feature path
- The relevant registry entries and vanilla JSON layout

Common misses:

- Wrong registry key namespace
- Data files in the wrong folder
- Feature registered but never injected into biome generation
- Old worldgen API copied into a newer Minecraft version

## Porting or Compatibility Fixes

Recipe:

- Start with `compare-minecraft` or `analyze-symbol`.
- Use lower-level diffs only for the class or symbol that actually broke.

Checklist:

- Update mappings before changing logic that might already be correct.
- Check loader lifecycle changes across the source and target versions.
- Revalidate Mixins, access wideners, registry names, and resource paths after the port.
- If the failure is a removed symbol, say so explicitly and name the verified replacement or closest alternative.

Common misses:

- Old method names copied into a new mapping namespace
- Loader lifecycle changes across versions
- Registry bootstrap moved or renamed
- Vanilla method signatures changed without obvious compile errors

## Mod JAR Analysis

Recipe:

- Start with `analyze-mod` summary.
- Use search, decompile, class source, or remap preview only after metadata confirms the JAR is the right target.

Checklist:

- Confirm loader, modid, version, dependencies, and mixin configs first.
- Check that the JAR matches the same Minecraft version and loader family as the user's workspace.
- Prefer remap preview before any mutating remap action.
- Cross-check suspicious targets against vanilla source and the user's current version.

Common misses:

- Looking at the wrong loader build of the same mod
- Comparing against a different Minecraft version
- Assuming a dependency is optional when the metadata marks it required
