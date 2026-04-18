---
version: 1.0.0
name: minecraft-modding-workbench
description: >
  Build, debug, port, or inspect Minecraft Java Edition mods for Fabric,
  NeoForge, and Architectury with the `minecraft-modding` MCP server. Use for
  Minecraft mod work involving supported loader workspaces, Mixins, access
  wideners, Yarn/intermediary/Mojang mappings, common-vs-platform module
  splits, version migration, registry or resource debugging, and mod JAR
  inspection or remapping.
---

# Minecraft Modding Workbench

Support fast, version-aware Minecraft modding. Treat the `minecraft-modding`
MCP server as the primary source of truth, then turn verified findings into
working code and assets.

## Scope

- Supports Fabric, NeoForge, and Architectury.
- Requires the `minecraft-modding` MCP server from `@adhisang/minecraft-modding-mcp`.
- Prefer project-aware MCP calls when a workspace exists. Reuse the repository root as `projectPath`.
- Use the high-level v3 entry tools first: `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `validate-project`, `analyze-mod`, and `manage-cache`.

## Default Behavior

- Produce runnable feature slices, not generic advice.
- Infer loader, version, mappings, modid, package, Java version, and project conventions from the workspace before asking questions.
- Ask only the minimum blocking question when the workspace is absent or contradictory.
- Prefer explicit TODOs or placeholder assets over stalling on art or balance details.
- When the user clearly requests implementation rather than explanation, default to delivering code.
- Respond in the user's language when practical, but keep the workflow and trigger logic language-agnostic.

## First Pass

1. Detect the project shape.
   - Read `gradle.properties`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `fabric.mod.json`, `neoforge.mods.toml`, mixin configs, and nearby registration classes.
   - Infer loader, Minecraft version, mappings, Java version, modid, base package, whether the project already uses datagen, and whether the workspace is single-loader or Architectury multi-module.
   - Record the workspace root you will pass as `projectPath` to MCP tools.
2. Read the existing code before writing new code.
   - Match the project's naming, package layout, registration helpers, and client/server split.
   - Reuse existing registries, tabs, packet patterns, and datagen providers when present.
   - Prefer workspace-aware MCP resolution before manual version or mapping selection.
3. Load only the relevant references.
   - Read `references/fabric.md` for Fabric projects.
   - Read `references/neoforge.md` for NeoForge projects.
   - Read `references/architectury.md` for Architectury multi-module projects.
   - Read `references/bootstrap-from-template.md` when the workspace is a sparse template.
   - Read `references/task-checklists.md` for the requested feature slice.
   - Read `references/mcp-recipes.md` when payload shape, recovery, or sequencing is unclear.
4. Find the closest vanilla example before implementing behavior.
   - Start with `inspect-minecraft` or `analyze-symbol`.
   - Drop to low-level tools only when the high-level answer still leaves the implementation ambiguous.

If no project exists yet, ask only for loader, Minecraft version, modid, and package name.
If the task depends on an external generator or template that is not present, say so explicitly instead of fabricating generated files.

## MCP Guardrails

- Start with the highest-level read-only MCP call that can answer the question.
  - `inspect-minecraft`: versions, artifacts, vanilla classes, source search, raw files.
  - `analyze-symbol`: existence, mappings, lifecycle, workspace compile-time names.
  - `compare-minecraft`: migration and registry/class diffs.
  - `validate-project`: workspace, Mixin, and access widener validation.
  - `analyze-mod`: mod JAR summary, search, decompile, remap preview/apply.
  - `manage-cache`: stale cache or index diagnosis.
- Drop to low-level tools only for exact code, exact descriptors, raw registry bodies, detailed validator output, or direct JAR/remap control.
- Keep version and mapping discipline.
  - Pass `projectPath`, `preferProjectVersion=true`, and `preferProjectMapping=true` when supported.
  - Still pass explicit `version` to tools that require it, such as `validate-mixin`, `validate-access-widener`, and `resolve-workspace-symbol`.
  - Treat artifact-backed lookup as a two-step flow: `resolve-artifact` first, then `find-class`, `search-class-source`, `get-artifact-file`, or `list-artifact-files`.
- Parallelize only independent read-only discovery calls once `projectPath`, loader, version, and mapping are known.
  - Keep dependent chains sequential.
  - Do not run `manage-cache`, `index-artifact`, or remap/mutating flows in parallel with calls that depend on the same cache or JAR.
- If payload shape is unclear or an entry tool errors, read `references/mcp-recipes.md` before inventing fields or dropping to a lower-level tool.

## Unsupported or Risky Requests

- Do not silently treat Quilt or legacy Forge as Fabric, NeoForge, or Architectury.
- For legacy Forge-only or other unsupported loaders, limit help to verified workspace facts, logs, and migration boundaries. Say that full guidance is outside this skill.
- If MCP is unavailable, misconfigured, or stale, say so immediately, fall back to workspace and log inspection, and keep any fix narrow.
- If workspace files contradict the prompt, call out the contradiction and resolve it from checked files before coding.
- If the request depends on a symbol, event, registry entry, or vanilla hook you cannot verify, say that it is unverified or unsupported instead of inventing it. Offer the closest verified alternative.

## Core Workflow

1. Inspect vanilla or existing mod code that already solves the same problem.
2. Translate that pattern into the user's loader, module boundary, and mapping namespace.
3. If the template is too empty, bootstrap the missing project skeleton first.
   - Add only the minimum entrypoints, registration classes, client hooks, and datagen wiring needed for the requested feature.
   - Do not create every possible system up front.
4. Implement the whole slice in one pass.
   - Include registrations.
   - Include client wiring when needed.
   - Include required JSON resources or datagen hooks.
   - Include lang keys, loot tables, blockstates, models, tags, recipes, or screen wiring when the feature needs them.
   - In Architectury workspaces, keep shared gameplay logic in `common` and loader-specific wiring in platform modules unless the workspace already uses another verified pattern.
5. Run the verification loop before calling the task done.
6. Report assumptions, placeholders, and follow-up tasks briefly.

## Delivery Rules

- Match the current project style before introducing a new abstraction.
- Do not invent mapping names, event names, registration order, or descriptors. Verify them.
- Prefer stable loader APIs or events over Mixins when the loader already exposes a clean hook.
- When the project is template-only, create the smallest working scaffold that can compile and host the requested feature.
- In Architectury projects, keep code in `common` by default and move only loader-bound code to `fabric` or `neoforge`.
- In Architectury templates that already route both loaders through a shared init method, do not add no-op platform edits just to mirror a shared content change.
- Use `@ExpectPlatform`, Architectury abstractions, or a plain Java interface/service split only when the code truly needs platform-specific behavior.
- Keep side separation correct. Put renderer, screen, and other client-only code behind the proper client entrypoint or event.
- Prefer datagen when the request creates repeated JSON or more than a couple of content entries.
- Preserve existing helper classes, registries, and package structure instead of replacing them wholesale.
- Keep fixes narrow during debugging. Identify the concrete failure first, then patch the cause.

## Verification Loop

Run verification as part of the default workflow, not as an optional extra.

1. Run `./gradlew build` after structural code changes.
2. Run the loader's datagen task when datagen was added or updated, or when generated resources are the project's normal asset path.
   - Fabric: `./gradlew runDatagen`
   - NeoForge: run the project's configured datagen task or run configuration.
   - Architectury: run the root build and the relevant platform datagen task when the workspace defines one.
3. Run a client launch when the change touches rendering, menus, screens, entity models, or runtime-only behavior and the environment allows it.
   - Use the project's existing `runClient` task or equivalent.
   - In Architectury workspaces, prefer the platform-specific client run task that exercises the changed module.
4. Run or extend automated tests when the project already has them or when the new logic is isolated enough to justify them.
   - Prefer existing GameTests, loader test harnesses, or integration tests for gameplay behavior.
   - Add focused unit tests for pure Java helpers, codecs, serializers, or data transforms.
5. If a command cannot run in the current environment, say so explicitly and still perform static validation with MCP tools and code inspection.
   - In sandboxed environments, retry Gradle with a writable `GRADLE_USER_HOME` before treating home-directory lock or cache failures as project issues.

At minimum, aim to leave the project in a state that passes `build` or has a concrete, localized reason why it cannot.

## Fast Debugging Order

- Mixin crash: start with `validate-project`, then `validate-mixin` if you need exact issue detail. Confirm the owner, method name, descriptor, and mapping namespace before patching code.
- Access widener failure: start with `validate-project`, then `validate-access-widener` with an explicit `version`. Confirm that the header namespace matches the entry names.
- Registry or missing-content issue: inspect the existing registration flow, confirm registry IDs, then check required resource files.
- Texture or model issue: verify resource location casing, JSON paths, generated assets, and item-block model linkage.
- Side-only crash: inspect client init, renderer registration, and `level.isClientSide()` or equivalent boundaries.
- Porting failure: start with `compare-minecraft`, then diff the affected class signatures, then update mappings and loader-specific APIs.

When one of these categories matches, read the corresponding section in `references/task-checklists.md` and the loader-specific `Common Pitfalls` section before broad rewrites.

## References

- Fabric patterns: `references/fabric.md`
- NeoForge patterns: `references/neoforge.md`
- Architectury patterns: `references/architectury.md`
- Template bootstrap patterns: `references/bootstrap-from-template.md`
- Delivery checklists by task shape: `references/task-checklists.md`
- MCP payload and recovery recipes: `references/mcp-recipes.md`
- For current upstream migration guidance, consult the official Fabric, NeoForge, and Architectury docs or release notes that match the target loader and Minecraft version instead of relying on hardcoded URLs.
