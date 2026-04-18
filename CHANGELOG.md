# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `resolve-artifact` with `mapping="mojang"` on a still-obfuscated Minecraft version now transparently tiny-remaps the binary jar (`obfuscated -> mojang`) and decompiles the result instead of failing with `ERR_MAPPING_NOT_APPLIED`, when tiny-remapper, the version's Mojang tiny mapping file, and `MappingService.checkMappingHealth` all report ready. The remapped jar is cached under `<cacheDir>/remapped/<artifactId>.jar` and the new `qualityFlags` entries `"binary-remapped"` and `"decompiled"` plus `provenance.transformChain` `"binary-remap:obf->mojang"`, `"decompile:vineflower"` mark the path. Source-backed and obfuscated paths keep their existing `artifactId` hashes; only the new mojang-remapped variant occupies a fresh cache slot (`MappingVariant = "mojang-remapped"`).
- `validate-mixin` top-level errors now expose `failedStage` on the public `ProblemDetails` envelope alongside `code`, `hints`, and `suggestedCall`. Every `AppError` raised from the single-input pipeline is tagged with exactly one of `"input-validation" | "resolve" | "mapping-health" | "parse" | "target-lookup"`, and `mapErrorToProblem` promotes that tag from `AppError.details.failedStage` to a top-level `failedStage` field on the serialized error so MCP callers can branch on the failure category without parsing `message`. Nested errors that already carry a `failedStage` (e.g. a version-manifest resolver that sets its own stage) are preserved; the outer pipeline only annotates untagged errors.
- `validate-mixin` `quickSummary` now appends a short note when `provenance.scopeFallback` fires (`Scope fell back from "<requested>" to "<applied>" (<reason>).`) and when `toolHealth.overallHealthy === false` (`Mapping health degraded: <degradations>.`), so fallback and mapping-infrastructure degradations are visible in the one-line summary alongside the existing error/warning counts.
- `find-mapping` `signatureMode` is now a first-class input: `"exact"` preserves the strict `owner + name + descriptor` match, `"name-only"` matches by `owner + name` only and ranks the top overloads by confidence. `resolve-method-mapping-exact` is unchanged for callers that need exact-triple semantics.
- `docs/tool-reference.md` gained a "Which Tool for Which Question" decision table, and `README.md` links to it from the Documentation section.
- Ambiguous mapping responses in `find-mapping`, `resolve-method-mapping-exact`, and `check-symbol-exists` now include recovery guidance in `warnings`:
  - `find-mapping` method ambiguities: retry with `signatureMode="exact"` plus a JVM descriptor, pass `disambiguation.descriptorHint`, or raise `maxCandidates` up to `200`.
  - `find-mapping` class/field ambiguities: pass `disambiguation.ownerHint`, or raise `maxCandidates` up to `200`.
  - `resolve-method-mapping-exact` truncated candidate lists: raise `maxCandidates` up to `200`, or fall back to `find-mapping` disambiguation hints.
  - `check-symbol-exists` name-only method ambiguities: retry with `signatureMode="exact"` plus a JVM descriptor.
  - `check-symbol-exists` short-class ambiguities: provide a fully-qualified class name.
  - Any truncated candidate list: raise `maxCandidates` up to `200` (the max cap).
- `check-symbol-exists` now projects the caller's JVM descriptor to the obfuscated namespace before filtering method overloads, so `signatureMode="exact"` retries work correctly when the descriptor references remapped Minecraft classes (e.g. `(Lnet/minecraft/world/item/ItemStack;)V`). Partial projections — where some class references resolve and unmapped JDK / external classes (e.g. `Ljava/lang/String;`) pass through unchanged — are accepted, so mixed descriptors like `(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V` resolve correctly instead of falling back to the unprojected source descriptor.
- `find-mapping` with `signatureMode="exact"` and `kind="method"` now filters resolved candidates by the (projected) requested descriptor, mirroring `resolve-method-mapping-exact`'s strict behavior. Descriptorless fallback candidates are no longer promoted to `resolved`, so a caller who supplied `foo(Z)V` cannot be told that `foo(I)V` is the exact mapping. Mixed descriptors like `(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V` that include both a remapped Minecraft class and a pass-through JDK class still resolve correctly — the strict filter uses the partial projection whenever class references are present rather than rejecting incomplete projections outright.
- `MappingService.findMapping` service-layer default for `signatureMode` now matches the public tool schema default (`"name-only"`). Internal callers that require strict descriptor filtering pass `signatureMode: "exact"` explicitly; `source-service` callers (`resolve-workspace-symbol`, access-widener / access-transformer remap paths, and the obfuscated-name lookup helper) have been updated accordingly. The resolution cache key now encodes the resolved effective mode so cache entries do not collide across modes.
- `source-service`'s obfuscated-name lookup helper now falls back to `findMapping(signatureMode: "exact")` when `resolveMethodMappingExact` returns `not_found` / `mapping_unavailable`. This recovers mixed MC + JDK descriptor lookups that `resolveMethodMappingExact` still rejects for incomplete class-ref projections, so access-widener remap, signature-member remap, and trace-symbol-lifecycle can resolve real methods instead of silently dropping them.
- Compact mode slim candidate projection now retains `kind` and `symbol` alongside `owner`, `name`, `descriptor`, `confidence`, and `matchKind`. Clients that key candidates by `symbol` or branch on `kind` are no longer silently broken by the default compact response shape.
- `normalizeMethodDescriptor` in the mapping service now enforces the JVM §4.3.2 array-dimension limit (255). Descriptors with more than 255 leading `[` are rejected as `ERR_INVALID_INPUT` instead of being accepted and pushed into cache-key construction.
- `get-class-source`, `get-class-members`, `search-class-source`, and `list-artifact-files` accept a new optional `compact` parameter (default `false`, opt-in). When `true`, `get-class-source` strips `provenance`, `artifactContents`, and `qualityFlags`; `get-class-members` strips the same three plus `context` while preserving `decompiledFallback` and `decompiledMemberCounts`; `search-class-source` and `list-artifact-files` strip only `artifactContents`. Primary payload fields (`sourceText`, `members`/`counts`, `hits`, `items`) are always preserved — `compactResponse` now accepts a `preserveKeys` set so empty `hits: []` / `items: []` from a successful zero-result response survive the generic empty-array strip.
- `manage-cache` now exposes the Mojang binary-remap output (`<cacheDir>/remapped/<artifactId>.jar`) as the new `binary-remap` public cache kind, with `selector.artifactId` filtering. The owning artifact's LRU eviction also unlinks the matching remapped jar so `maxCacheBytes` accounting and `manage-cache` cleanup do not silently leak the remap output.

### Changed
- BREAKING: `resolve-artifact` with `mapping="mojang"` against a still-obfuscated version no longer rejects binary-only artifacts with `ERR_MAPPING_NOT_APPLIED` when tiny-remapper, the Mojang tiny mapping file, and the version's Mojang mappings are all available. The call now succeeds and returns a remapped + decompiled artifact tagged with `qualityFlags: ["binary-remapped", "decompiled"]`. Callers that branched on the old failure path must now also handle the new success shape; `MAPPING_NOT_APPLIED` is still raised when any of the three prerequisites is missing.
- BREAKING: `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, `check-symbol-exists`, and `analyze-symbol` now default `maxCandidates` to `5` (previously `200`; `200` remains the enforced upper bound). Callers that implicitly relied on the old default to receive every ranked candidate must now pass `maxCandidates` explicitly.
- BREAKING: `find-mapping` now defaults `signatureMode` to `"name-only"` (previously the effective default was `"exact"`). `kind="method"` lookups without a `descriptor` no longer fail with `ERR_INVALID_INPUT`. Callers that depended on the old strict refinement must pass `signatureMode: "exact"` explicitly. Malformed descriptors still surface as `ERR_INVALID_INPUT` in both modes when a descriptor is supplied.
- BREAKING: `resolve-artifact`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, and `check-symbol-exists` now default `compact` to `true` (previously `false` as introduced in 3.2.0). Callers that depended on full diagnostic responses — `provenance`, `artifactContents`, `sampleEntries`, `adjacentSourceCandidates`, `binaryJarPath`, `coordinate`, `repoUrl`, `resolvedSourceJarPath` for `resolve-artifact`, and the redundant `candidates` array for mapping tools — must now pass `compact: false` explicitly.
- `find-mapping` and `check-symbol-exists` `descriptor` fields now accept empty strings as equivalent to omitting the field, so name-only lookups can be made with either `descriptor: ""` or no `descriptor` at all.
- `normalizeMethodDescriptor` in the mapping service now rejects malformed JVM descriptors such as `()`, `(I)`, and `(L;)V` with `ERR_INVALID_INPUT` instead of silently accepting them.
- Compact mode (`compact: true`) on mapping tools now keeps only the top three unresolved candidates with full metadata and slims the tail to `{kind, symbol, owner, name, descriptor, confidence, matchKind}`. A new `candidateDetailsTruncated: true` flag signals this metadata slim. `candidatesTruncated` continues to mean "more candidates exist upstream than this response returned" (set by the service when `maxCandidates` clipped the list); the two signals are orthogonal and can both appear.

## [3.2.0] - 2026-04-12

### Added
- `resolve-artifact`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, and `check-symbol-exists` now accept an optional `compact` parameter (default `false`). When `true`, empty arrays, null values, and empty objects are stripped from the top-level response. For `resolve-artifact`, compact mode additionally omits `provenance`, `artifactContents`, `sampleEntries`, `adjacentSourceCandidates`, `binaryJarPath`, `coordinate`, `repoUrl`, and `resolvedSourceJarPath`. For mapping tools, compact mode omits the redundant `candidates` array when the result is a single full-confidence exact-match resolution.
- `validate-access-widener` now accepts `projectPath`, `scope`, and `preferProjectVersion` for runtime-aware validation against Loom runtime jars, and reports additive `provenance`, `resolvedInRuntime`, and `resolvedRuntimeAccess` evidence for matched class, method, and field entries.
- Added `validate-access-transformer` for Forge / NeoForge Access Transformer validation, including `atNamespace` support, workspace-driven namespace inference, runtime artifact provenance, and per-entry runtime access evidence.
- `analyze-mod-jar` now surfaces packaged Access Transformer paths alongside mod metadata.

### Fixed
- `validate-access-widener` and `validate-access-transformer` runtime-aware method validation now preserves remapped JVM descriptors through exact and fallback member remaps, eliminating false-negative `method not found` results for entries whose descriptors reference remapped Minecraft classes such as `Level#setBlock(BlockPos, BlockState, int)`.
- `validate-access-widener` runtime-aware `scope: "merged"` now prefers explicit `*merged-intermediary*` / `*merged-mojang*` runtime jars over ambiguous `minecraft-merged.jar` candidates, and Loom tiny lookup now scans workspace and Gradle user-home caches so runtime validation can resolve descriptor remaps in normal Loom setups.
- `validate-project` now forwards workspace runtime context to discovered Access Widener validation so project-summary runs can use the same runtime-aware behavior as direct `validate-access-widener` calls.
- `validate-project` now discovers Access Transformer files, supports `task="access-transformer"`, and can include those validations in workspace summaries when `discover` requests them.
- `resolve-artifact`, `get-class-source`, `get-class-members`, and `inspect-minecraft` source/class-member flows now treat unobfuscated releases such as `26.1+` as native `mojang` runtime namespaces for both version and versioned-coordinate targets, avoiding false `ERR_MAPPING_NOT_APPLIED` failures and wrong-version Loom source-jar approximations when no exact source jar is present.
- `validate-mixin` tool-health diagnostics now treat unobfuscated `mojang` runtime names as available, while still flagging `intermediary`/`yarn` as unavailable on `26.1+`.
- `validate-project task="project-summary"` now pre-resolves `preferProjectVersion=true` consistently across discovered Access Widener and workspace Mixin checks, and returns a blocked summary with version-agnostic recovery guidance when discovered validators need a version but neither the request nor `gradle.properties` can supply one.
- `check-symbol-exists` and `analyze-symbol task="exists"` now fall back to unobfuscated runtime bytecode for `mojang`/runtime-name existence checks on `26.1+`, preserve the original `mapping_unavailable` result when the runtime JAR cannot be resolved, and return a targeted warning when callers provide only a short class name.
- Loom tiny mapping discovery no longer performs unbounded directory traversal when the version-specific cache directory is absent, preventing excessive memory consumption on systems with large Gradle caches.
- Mapping graph cache eviction after lifecycle scans now correctly releases all cached entries for a version instead of silently skipping them.

### Performance
- `resolve-artifact` source-jar detection and mapping tiny-jar loading now reuse a single ZIP walk per jar probe instead of reopening and fully enumerating matching archives on each helper call.
- `search-mod-source`, `decompile-mod-jar`, `get-mod-class-source`, `validate-project` workspace discovery, and workspace mapping detection now avoid synchronous hot-path file/glob reads and use bounded concurrent text reads where safe, reducing event-loop stalls on larger decompiled outputs and multi-module workspaces.

## [3.1.1] - 2026-03-21

### Fixed
- `analyze-symbol task="api-overview"` now inherits `sourceMapping` as the default `classNameMapping`, avoiding unintended fallback to `obfuscated` when callers omit `classNameMapping`.
- `get-class-api-matrix` now builds rows from the explicitly requested `classNameMapping` instead of silently pivoting to `obfuscated` when both identities are available.
- `find-mapping` now accepts short obfuscated class ids such as `dhl` when `sourceMapping="obfuscated"` instead of rejecting them at input validation.
- `find-mapping` now restores `mojang -> intermediary`, `mojang -> yarn`, and `intermediary -> mojang` conversions on mappings builds where those paths previously failed.
- `trace-symbol-lifecycle` now strips an accidental inline signature suffix from `symbol` before splitting `Class.method`, preventing misparsed lifecycle lookups while keeping the separate `descriptor` field as the exact-match path.
- `trace-symbol-lifecycle` now rejects class-like `symbol` inputs such as `net.minecraft.world.item.Item` with `ERR_INVALID_INPUT` instead of scanning versions until lookup work fails elsewhere.
- `analyze-symbol task="lifecycle"` now applies its required `version` as the lifecycle scan upper bound instead of ignoring that input and always scanning the default full range, and the high-level helper now keeps that scan to a recent 5-version window for predictable runtime.
- `trace-symbol-lifecycle` now completes broad lifecycle scans more reliably without long stalls.
- `analyze-mod` and `validate-project` now return retryable `suggestedCall` guidance when older string-subject or domain-include payloads fail with `ERR_INVALID_INPUT`.
- `validate-mixin` and `validate-project task="project-summary"` now treat empty mixin configs as warning-only discovery results with zero validated classes instead of `ERR_INVALID_INPUT`.
- `inspect-minecraft` now keeps workspace `class-overview`, class-like `search`, and `list-files` usable when source coverage is partial, with partial-status guidance where needed.
- `inspect-minecraft` invalid task/subject combinations now return retryable `suggestedCall` guidance instead of dead-end `ERR_INVALID_INPUT` messages, preserving the requested task when artifact context is the only missing input and otherwise pointing to the subject-compatible retry path.
- Path-based environment overrides now treat blank values and the literal strings `undefined` and `null` as unset, preventing accidental `./undefined` and `./null` cache roots and invalid JAR override paths when clients serialize missing values incorrectly.

### Performance
- `trace-symbol-lifecycle`, `check-symbol-exists`, and `find-mapping` now respond faster on Mojang/obfuscated-only workflows, especially on cold lookups.

### Documentation
- Shortened the English and Japanese READMEs so onboarding guidance, workflow notes, and detailed reference material no longer repeat the same content across multiple sections.
- Simplified the generated tool-surface tables in both READMEs to compact purpose-only summaries and pointed exact input/output details to `docs/tool-reference.md`.
- Rewrote the Japanese workflow guidance in more natural Japanese and clarified that the detailed examples and full reference remain English-first for now.

## [3.1.0] - 2026-03-15

### Changed
- `search-class-source` `queryMode="auto" | "token"` now keeps separator queries such as `foo.bar`, `foo_bar`, and `foo$bar` on the indexed path instead of silently retrying a full substring scan; `queryMode="literal"` remains the explicit opt-in scan mode.
- The top-level workflow tools now include `result.summary.subject` consistently, and high-confidence follow-up flows such as migration overviews, remap previews, cache previews, and search misses from those tools now surface `summary.nextActions`.
- `tools/list` now exposes JSON Schema `default` values for fixed MCP tool parameters such as `list-versions.includeSnapshots=false`, `search-class-source.queryMode="auto"`, `inspect-minecraft.includeSnapshots=false`, `analyze-mod.searchType="all"` / `includeFiles=true` / `limit=50`, `validate-mixin.reportMode="full"`, and selected controls on the top-level workflow tools like `manage-cache.executionMode="preview"` / `limit=50`, so clients can rely on schema metadata instead of parsing prose descriptions.

### Fixed
- Error recovery payloads (`suggestedCall`) now omit parameters when the supplied value matches the tool's default behavior, keeping retryable calls smaller without changing their semantics.

### Performance
- Explicit text and path scan fallbacks in `search-class-source` now use less memory and stay more predictable on large artifacts.

### Documentation
- Corrected the published `compare-minecraft` class-only `subject.kind="class".sourcePriority` input and aligned the documented `inspect-minecraft` / `validate-project` outputs with current behavior.
- Documented that safe fixed defaults now appear in `tools/list` schema output and that `suggestedCall` omits default-valued parameters.

## [3.0.0] - 2026-03-09

### Added
- v3 entry tools: `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `analyze-mod`, `validate-project`, and `manage-cache` now provide summary-first starting points for the main Minecraft, symbol, mod, validation, and cache workflows while keeping expert tools available for follow-up work.
- The new v3 entry tools share `detail` / `include` response shaping and always return `result.summary` inside the standard `{ result?, error?, meta }` envelope, reducing default payload size and making next actions explicit.
- `analyze-mod` now exposes `executionMode="preview" | "apply"` for safe remap planning and execution, and `manage-cache` now exposes the same preview/apply model for cache deletion, pruning, and rebuild workflows.

### Fixed
- `inspect-minecraft` now routes `subject.kind="workspace"` requests with `focus.kind="class" | "file" | "search"` through the matching task for `task=auto`, while preserving workspace-aware artifact resolution for focused file and search follow-up flows.
- `inspect-minecraft task=class-overview | class-source | class-members` now accepts `subject.kind="workspace"` with `focus.kind="class"` even when the focus omits an explicit artifact reference, reusing workspace version detection to resolve artifact context first.
- `validate-project task=project-summary` now keeps per-config Mixin validation failures inside the summary result as warnings and invalid counts instead of aborting the whole workspace run on the first bad config.
- `compare-minecraft` now accepts `sourcePriority` for class-diff requests, and `registry-diff` degrades to `summary.status="partial"` with recovery actions when only one side of detailed registry data can be loaded.
- `compare-minecraft task=versions` now sets `meta.truncated` with recovery actions when summary-mode class or registry samples are clipped, including mixed `include=["classes"]` / `["registry"]` requests where the other summary-side group was truncated.
- `manage-cache` now applies `selector.olderThan`, `mapping`, `scope`, `projectPath`, and normalized `jarPath` matching, exposes real cache health states (`stale`, `orphaned`, `corrupt`, `in_use`), and advances `list` pagination through `meta.pagination.nextCursor`.

## [2.1.0] - 2026-03-08

### Added
- Source inspection tools now expose `artifactContents` so clients can tell whether a result came from a `source-jar` or `decompiled-binary`, whether non-Java resources are indexed, and whether source coverage is `full` or `partial`.
- `get-class-source`, `get-class-members`, `search-class-source`, and `get-artifact-file` now expose `returnedNamespace` to distinguish the namespace of returned content from the underlying artifact namespace (`mappingApplied`).
- Token-efficient response shaping options: `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, and `check-symbol-exists` now accept `maxCandidates`; `get-class-api-matrix` accepts `maxRows`; `diff-class-signatures` accepts `includeFullDiff`; `decompile-mod-jar` accepts `includeFiles` / `maxFiles`; `get-registry-data` accepts `includeData` / `maxEntriesPerRegistry`; `validate-mixin` accepts `includeIssues`.
- `validate-mixin` now reports per-result `validationStatus` (`full` / `partial` / `invalid`), member coverage counters (`summary.membersValidated` / `membersSkipped` / `membersMissing`), batch `summary.partial`, and scope/source-priority provenance fields (`requestedScope` / `appliedScope`, `requestedSourcePriority` / `appliedSourcePriority`) so partial validation is explicit.
- `validate-mixin` now supports `input.mode="project"` to recursively discover `*.mixins.json` under a workspace root and validate every referenced Mixin in one call.
- `validate-mixin` now adds `confidenceBreakdown` and `reportMode="summary-first"` so callers can see why confidence dropped and consume batch-oriented output without repeated per-result provenance/warning payloads.

### Fixed
- `compare-versions` now applies `packageFilter` consistently to `classes.addedCount`, `removedCount`, and `unchanged`, so class summary counts reflect the same filtered package scope as the returned class lists.
- Heavy analysis tools now fail fast with `ERR_LIMIT_EXCEEDED` when too many expensive requests arrive at once, instead of letting the whole MCP session degrade under load.
- The stdio CLI now recovers more cleanly from unexpected internal exits, reducing full-session disconnects during live use.
- `trace-symbol-lifecycle` now uses strict method remapping when a descriptor is provided, falls back to name-only lookup when it is omitted, and surfaces real mapping input failures in warnings instead of collapsing them into generic lookup errors.
- `get-class-source` / `get-class-members` now infer a missing artifact version from `projectPath` when `preferProjectVersion=true`, making project-aware lookups more consistent for previously resolved artifacts.
- Error recovery payloads (`suggestedCall`) now use the current `target` object schema instead of deprecated `targetKind` / `targetValue` fields.
- `list-artifact-files` now warns when callers probe `assets/` or `data/` prefixes against the Java-source index, instead of silently returning an unexplained empty result.
- `artifactContents.sourceCoverage` now strictly reports `full` or `partial`, matching the documented contract instead of carrying an unreachable `unknown` branch in the exported type.
- `get-class-members` now rejects malformed field and method descriptors from corrupted bytecode with `ERR_INVALID_INPUT` instead of returning malformed Java signatures, and invalid `void` method arguments now report as method descriptor errors instead of misleading field descriptor errors.
- `resolve-artifact` now searches project-local and Gradle user-home Loom caches without auto-selecting unrelated mod/library source jars just because their filenames contain the requested Minecraft version.
- `resolve-artifact` and related version-target mapping failures now preserve `ERR_MAPPING_NOT_APPLIED` while adding `artifactOrigin` plus actionable recovery details for decompile-only artifacts.
- `remap-mod-jar` now detects Mojang-mapped Fabric/Quilt inputs, returns a copied output for `targetMapping="mojang"`, and fails fast with contextual diagnostics for unsupported Mojang-input `targetMapping="yarn"` requests.
- `resolve-workspace-symbol` now recognizes NeoForge ModDevGradle workspaces as `mojang` compile mappings instead of returning `mapping_unavailable`.
- `resolve-artifact`, `get-class-source`, and `get-class-members` now preserve `ERR_JAR_NOT_FOUND` for missing `target.kind=jar` paths instead of leaking raw filesystem `ENOENT` failures through the public contract.
- `get-registry-data` now invalidates corrupt cached `registries.json` snapshots, regenerates them on demand, and reports `ERR_REGISTRY_GENERATION_FAILED` when the regenerated snapshot is still unreadable.
- `validate-mixin` now retries with Maven mapping data after Loom-only partial results when that can complete validation, reducing false warnings.
- `validate-mixin` no longer emits schema-invalid `check-symbol-exists` recovery payloads in `suggestedCall`; unsupported parameters such as `scope` and `projectPath` are omitted from those calls.
- `validate-mixin` now lowers confidence for skipped member validation and exposes requested-vs-applied scope/source-priority details instead of making partial results look fully verified.
- `validate-mixin` now follows the resolved artifact namespace during bytecode lookup for non-vanilla scopes, so `scope="merged"` on Mojang-mapped Loom workspaces validates against merged class names instead of falling back to false partial results and retry-driven timeouts.
- Invalid `validate-mixin` requests now return the standard `ERR_INVALID_INPUT` envelope with `fieldErrors`, `hints`, and a mode-correct `suggestedCall` instead of the SDK's generic pre-validation text error.
- Bare string `target` inputs for `resolve-artifact`, `get-class-source`, and `get-class-members` now return `ERR_INVALID_INPUT` with schema-correct wrapper suggestions instead of generic object-schema failures.
- `validate-mixin` now classifies signature-loading/tool-limited target failures as `validation-incomplete` warnings instead of reporting them as missing classes.
- `check-symbol-exists` no longer repeats raw Loom tiny-cache miss warnings when Maven tiny mappings successfully satisfy the lookup; successful fallback now emits concise fallback context instead.

### Documentation
- Corrected the published `compare-versions` response docs to show registry results under `result.registry`.

### Performance
- Cache-heavy artifact loading and runtime metric reads now stay faster after repeated operations instead of rescanning cache state each time.
- `find-mapping`, `get-class-api-matrix`, `resolve-workspace-symbol`, `check-symbol-exists`, and `validate-mixin` now respond faster on repeated mapping-heavy workflows.

## [2.0.0] - 2026-03-07

### Changed
- Breaking change: the public mapping namespace `official` was removed and replaced with `obfuscated` across tool inputs, outputs, API matrix keys, diagnostics, and examples. Requests that still send `official` now fail with `ERR_INVALID_INPUT` and should be updated to `obfuscated`.
- Breaking change: `resolve-artifact` now accepts `target: { kind, value }` instead of top-level `targetKind` / `targetValue`. `get-class-source` and `get-class-members` now require `target: { type: "artifact", artifactId }` or `target: { type: "resolve", kind, value }` instead of top-level `artifactId` / `targetKind` / `targetValue`.
- Breaking change: `resolve-method-mapping-exact` is now method-only and no longer accepts `kind`; callers must send `owner` and `descriptor`.
- Breaking change: `validate-mixin` replaced the mutually exclusive top-level source selector fields (`source`, `sourcePath`, `sourcePaths`, `mixinConfigPath`, `sourceRoot`) with `input.mode` plus `input.source` / `input.path` / `input.paths[]` / `input.configPaths[]` and `sourceRoots[]`.
- Breaking change: `validate-mixin` now always returns normalized batch-style output with `mode`, `results[]`, and `summary`. The deprecated `summary.errors` field was removed; use `summary.processingErrors` instead.
- Breaking change: `search-class-source` now returns compact hits only. The removed `snippetLines`, `includeDefinition`, and `includeOneHop` inputs no longer trigger snippet/definition/relation expansion, `totalApprox` was removed from responses, and `symbolKind` is only valid with `intent=symbol`.
- MCP tool responses now mirror the `{ result?, error?, meta }` envelope in `structuredContent`, and failures also set `isError=true` for SDK-aware clients.
- MCP resources: JSON resources now return structured `{ result, meta }` success envelopes and `{ error, meta }` failures. Text resources (`class-source`, `artifact-file`) still return raw text on success, but now also use structured JSON errors on failure.

### Fixed
- `resolve-artifact`: `targetKind=coordinate` now reuses the local Gradle `modules-2` cache in addition to the local Maven repository and configured source repos, so cached third-party libraries such as Architectury can resolve without manual cache spelunking.
- `resolve-artifact`: `mapping=mojang` + Loom merged source discovery now warns when the selected source jar only provides partial Minecraft source coverage.
- `get-class-source` / `get-class-members`: when an artifact is resolved from a `*-sources.jar`, the server now keeps the sibling binary jar and automatically falls back to it when source coverage is incomplete instead of treating the source jar as bytecode.
- `get-class-source`: partial-source binary fallback now bypasses the same sibling `*-sources.jar` that triggered the miss, and fallback failures for vanilla classes point to `get-class-api-matrix` instead of misleading `find-class` recovery.
- `get-class-members`: bytecode lookup now follows the resolved artifact namespace (`mappingApplied`) before remapping members back to the requested namespace, fixing merged Mojang artifacts that were incorrectly forced through obfuscated class names.
- `find-class`: zero-hit lookups against `mapping=obfuscated` now warn when the query looks like a deobfuscated Mojang class name.
- `find-class`: partial-source artifacts now suppress non-vanilla matches for vanilla-looking queries (for example `Item`) and return a warning instead of misleading modded classes.
- Tool input parsing: positive integer parameters now accept numeric strings such as `"10"` instead of failing validation immediately.
- Tool input parsing now leaves nested `typedJson` and JSON Patch `value` payload fields untouched, even when their keys happen to match top-level numeric option names such as `limit` or `maxLines`.

### Performance
- `search-class-source` now returns compact hits more efficiently, reducing latency and memory use on larger artifacts.

## [1.2.1] - 2026-03-05

### Fixed
- MCP startup regression: `tools/list` handshakes no longer stall on SQLite initialization in slower environments.
- Decompiler: skip Java/Vineflower availability checks when decompiled source is already cached, avoiding unnecessary startup errors on systems without Java.

## [1.2.0] - 2026-03-05

### Added
- New `find-class` tool to resolve simple or fully-qualified class names to concrete source paths inside an indexed artifact.
- `resolve-artifact` / `get-class-source`: `scope` (`vanilla`/`merged`/`loader`), `preferProjectVersion`, `strictVersion`, `projectPath` parameters for workspace-driven resolution.
- `get-class-source`: `mode` (`metadata`/`snippet`/`full`), `maxChars`, `outputFile` parameters for token-efficient source retrieval.
- `search-class-source`: `queryMode` (`auto`/`token`/`literal`) controls FTS5 vs substring scan behavior.
- `get-mod-class-source`: `maxLines`, `maxChars`, `outputFile` truncation parameters matching `get-class-source` behavior.
- `find-mapping`: `disambiguation` hints (`ownerHint`, `descriptorHint`) to narrow ambiguous candidates; `ambiguityReasons` in `status=ambiguous` responses.
- `get-class-api-matrix`: `ambiguousRowCount` when ambiguity fallback is applied.
- `check-symbol-exists`: `nameMode` (`fqcn`/`auto`) and `signatureMode` (`exact`/`name-only`) parameters.
- `analyze-mod-jar`: `jarKind` (`binary`/`source`/`mixed`) in response.
- `resolve-artifact`: `sampleEntries` when a source JAR is resolved.
- `validate-mixin`: major enhancements — `sourcePath`, `sourcePaths`, `mixinConfigPath` (with `sourceRoot`/`sourceRoots[]` for batch auto-discovery), `explain` mode with `explanation`/`suggestedCall` on issues, `resolvedMembers` tracking, `category`/`issueOrigin` classification, `structuredWarnings` with severity, `warningCategoryFilter`, `treatInfoAsWarning`, `reportMode`, `preferProjectMapping`, `provenance` with `resolutionNotes`, `toolHealth`, `confidenceScore`, batch `processingErrors`/`totalValidationErrors`/`totalValidationWarnings`.
- Error details: structured `suggestedCall` (`{ tool, params }`) for agent-driven recovery on `get-class-source` and `resolve-artifact` errors.

### Fixed
- `validate-mixin`: JVM descriptor false positives — method references with descriptors (e.g. `playerTouch(L...;)V`) are now stripped before comparison.
- `validate-mixin`: array-form `method = {"m1", "m2"}` parsing, `@Accessor(value = "name")` syntax, `@Accessor`/`@Invoker` parse failure escalation to `issues[]`.
- `validate-mixin`: `@Invoker` validation now checks methods only (not fields), preventing false negatives.
- `validate-mixin`: mapping fallback failures reported as `target-mapping-failed` warning (not `target-not-found` error).
- `validate-mixin`: multi-line annotation handling between `@Shadow`/`@Accessor` and declarations; inline annotations stripped from declaration lines.
- `validate-mixin`: `@Mixin(targets = "...")`/`targets = {"a", "b"}` string forms supported; simple `@Mixin` class names resolved via imports.
- `validate-mixin`: Fabric Loom split source sets and multi-module `sourceRoots` auto-discovery across common/fabric/neoforge/forge/quilt main+client paths.
- `validate-mixin`: parser supports `$` in names, FQN/generic/array/wildcard member signatures, `default`/`synchronized` modifiers, `interface` declarations.
- `validate-mixin`: `sourcePath` normalized with host/WSL path conversion; bytecode signature members remapped to requested mapping before validation.
- `validate-mixin`: `hideUncertain`/`minSeverity` filtering now recomputes `summary.parseWarnings` from filtered issues.
- Vineflower flags now passed before positional `<input-jar> <output-dir>` arguments, fixing false `ERR_DECOMPILER_FAILED` errors.
- Vineflower decompilation retries with fallback flag profiles on failure.
- `get-artifact-file`: UTF-8 boundary-safe byte truncation prevents malformed replacement characters.
- Version approximation detection avoids prefix false positives (e.g. `1.21.1` vs `1.21.10`).
- Classifier source-jar resolution correctly picks `<artifact>-<version>-<classifier>-sources.jar`.
- Default cache dir to `~/.cache/minecraft-modding-mcp` when `MCP_CACHE_DIR` unset.
- Cursor validation: invalid non-empty cursors now throw `ERR_INVALID_INPUT` instead of silently returning first page.
- `check-symbol-exists`: `ERR_INVALID_INPUT` for invalid symbol combinations before evaluating mapping availability.
- `resolve-artifact` mapping failures for version targets include actionable diagnostics (`searchedPaths`, `candidateArtifacts`, `recommendedCommand`).
- `search-mod-source` detects source-only jars and searches `.java` entries directly without decompilation.
- `CLASS_NOT_FOUND` / `MAPPING_NOT_APPLIED` errors include improved scope/context fields and recovery guidance.
- Mojang proguard mapping: JVM descriptor parsing fixes.

### Changed
- `SourceService` startup work now avoids slowing the MCP handshake while still using idle time to reduce the wait before the first source-heavy request.

## [1.1.1] - 2026-03-02

### Fixed
- `search-class-source` now safely supports recursive `fileGlob` patterns such as `**` without regex construction failures.
- `get-class-source` now rejects package-incompatible fallback matches and preserves canonical inner-class (`Outer.Inner`) lookup support.

## [1.1.0] - 2026-03-01

### Fixed
- Restore Codex startup handshake compatibility by accepting both newline-delimited and `Content-Length` stdio framing on stdio connections.

### Documentation
- Add Quick Start setup for Claude Code, OpenAI Codex CLI, and Gemini CLI.

## [1.0.0] - 2026-03-01

### Added
- Initial release.
