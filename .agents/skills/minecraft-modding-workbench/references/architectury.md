# Architectury Reference

## Table of Contents

1. [Project Shape](#project-shape)
2. [Code Placement Rules](#code-placement-rules)
3. [Platform-Specific APIs](#platform-specific-apis)
4. [Registration Strategy](#registration-strategy)
5. [Datagen and Assets](#datagen-and-assets)
6. [Verification](#verification)
7. [Migration Notes](#migration-notes)

Unless stated otherwise, this file assumes an Architectury workspace targeting Minecraft `1.21.x` with current Fabric and NeoForge modules. Use the actual workspace's shared init and registration helpers over these examples when they differ.

## Project Shape

Architectury is a multi-loader toolchain intended to share code across loaders through a common module and platform modules.

Typical workspace shape:

```text
root/
├── common/
├── fabric/
├── neoforge/
├── gradle.properties
├── settings.gradle
└── build.gradle
```

Look for these signals:

- `settings.gradle` includes modules such as `:common`, `:fabric`, and `:neoforge`
- root Gradle files apply Architectury plugin or Loom configuration across subprojects
- platform modules depend on the transformed or development output of `common`

When the workspace has this shape, reason in terms of module boundaries first, not file boundaries first.

## Code Placement Rules

Default placement rule:

- Put gameplay logic, shared content definitions, data objects, and vanilla-facing logic in `common`
- Put loader-bound registration glue, entrypoints, event wiring, and platform API calls in `fabric` or `neoforge`
- Put client-only platform setup in the relevant platform module unless the project already centralizes it differently

Good candidates for `common`:

- Shared block, item, entity, and menu logic
- Shared registry declarations when the project already exposes them through Architectury abstractions
- Serialization, codecs, data models, and config structures
- Shared datagen logic when the workspace already supports it
- First shared items or blocks that can be registered through Architectury helpers without loader-specific APIs

Good candidates for platform modules:

- Loader metadata files
- Fabric entrypoints and Fabric-only event hooks
- NeoForge event bus subscribers and NeoForge-only registration hooks
- Direct calls into `FabricLoader`, NeoForge APIs, or loader-only networking glue

If a requested feature only needs one loader's API, do not force the entire implementation into `common`.

## Platform-Specific APIs

Architectury provides multiple ways to bridge platform-specific behavior.

Prefer in this order:

1. Architectury abstractions already used by the workspace
2. Plain Java split through an interface or service-style pattern
3. `@ExpectPlatform` for genuinely platform-specific static hooks

Use `@ExpectPlatform` carefully:

- Declare the method in shared code
- Keep the method body as the standard placeholder that throws if not transformed
- Implement the platform method in a platform-specific package and `*Impl` class
- Remember that package naming matters for the transformation

Architectury docs note that `@ExpectPlatform` implementations are resolved from platform-specific packages such as `.fabric` and `.neoforge`, with `Impl` suffixes. The docs also note that plain Java alternatives are valid when annotation-based injection is unnecessary.

When reviewing existing code:

- Reuse the current bridge style instead of mixing multiple styles without reason
- Check whether the workspace disables or avoids injectables before adding `@ExpectPlatform`
- Be careful with target names such as `ArchitecturyTarget.getCurrentTarget()` if the workspace distinguishes `fabric` and `neoforge`

## Registration Strategy

Architectury does not remove loader registration differences by itself. Keep these rules in mind:

- Shared content definitions can live in `common`, but the actual loader wiring may still differ
- Fabric-side bootstrap often calls common initialization from the Fabric entrypoint
- NeoForge-side bootstrap often registers through deferred registers and mod-bus wiring
- Do not use vanilla registry calls in places where the loader side expects deferred registration or another established pattern

Follow the workspace's existing style first. If the workspace already uses Architectury API wrappers for registries or creative tabs, continue with those wrappers. If it uses plain Fabric and NeoForge patterns inside platform modules, keep doing that.

For a sparse template with existing loader entrypoints that already call a shared `ExampleMod.init()` or equivalent:

- A first shared item or block often only needs new `common` classes plus shared assets.
- If registration happens in `common`, use the workspace's existing loader-agnostic registry helper there.
- Acceptable common-side patterns include Architectury registry wrappers, `dev.architectury.registry.registries.DeferredRegister`, `RegistrarManager`, or another existing shared wrapper.
- Do not import NeoForge's `DeferredRegister` into `common`. That breaks Fabric compilation.
- Creative tab placement can stay in `common` when the workspace already uses Architectury helpers such as `CreativeTabRegistry`.
- Do not add placeholder Fabric or NeoForge classes unless the feature truly needs loader-specific wiring.

## Datagen and Assets

Keep generated resources and loader metadata in the correct module:

- Shared assets and data usually belong under `common/src/main/resources`
- Fabric-specific metadata belongs under `fabric/src/main/resources`
- NeoForge-specific metadata belongs under `neoforge/src/main/resources`

When adding datagen:

- Prefer the workspace's existing module placement and Gradle task structure
- Do not duplicate generated shared resources into every platform module unless the project already does that
- Verify whether the root build, platform build, or a dedicated datagen run task is the intended entrypoint

## Verification

Use the narrowest command set that still exercises the changed modules:

1. Run the root `./gradlew build` when shared code or build wiring changed
2. Run the relevant platform run task when the feature is platform-specific or client-visible
3. Run datagen only in the module or task path the workspace already uses
4. Re-run MCP validation for mixins or access changes after module wiring changes
5. If Gradle fails because the environment cannot write to the default home cache, retry with a writable `GRADLE_USER_HOME` before concluding the project setup is broken

When a bug appears only on one loader:

- Compare the common code against each platform adapter
- Check that the shared code is not importing loader-only classes
- Check `@ExpectPlatform` or service implementations for missing module-specific methods

## Migration Notes

Use Architectury docs when module topology or toolchain setup is the problem, not only when code is the problem.

Useful upstream Architectury topics:

- Getting started and project generation
- `@ExpectPlatform`
- Platform-specific APIs
- NeoForge migration

The official docs describe Architectury as a multi-loader toolchain and document:

- generated multi-project setups through the Architectury generator
- `common()` targets for shared code
- `developmentNeoForge` and `transformProductionNeoForge` style configurations in platform projects
- `platformPackage` customization for `@ExpectPlatform` when package mapping differs

Prefer the current official Architectury docs over third-party guides when build layout or platform package behavior is in question.
