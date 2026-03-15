# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `search-class-source` `queryMode="auto" | "token"` now keeps separator queries such as `foo.bar`, `foo_bar`, and `foo$bar` on the indexed path instead of silently retrying a full substring scan; `queryMode="literal"` remains the explicit opt-in scan mode.
- The top-level workflow tools now include `result.summary.subject` consistently, and high-confidence follow-up flows such as migration overviews, remap previews, cache previews, and search misses from those tools now surface `summary.nextActions`.
- `tools/list` now exposes JSON Schema `default` values for fixed MCP tool parameters such as `list-versions.includeSnapshots=false`, `search-class-source.queryMode="auto"`, `inspect-minecraft.includeSnapshots=false`, `analyze-mod.searchType="all"` / `includeFiles=true` / `limit=50`, `validate-mixin.reportMode="full"`, and selected controls on the top-level workflow tools like `manage-cache.executionMode="preview"` / `limit=50`, so clients can rely on schema metadata instead of parsing prose descriptions.

### Fixed
- Error recovery payloads (`suggestedCall`) now omit parameters when the supplied value matches the tool's default behavior, keeping retryable calls smaller without changing their semantics.

### Performance
- Explicit text/path scan fallbacks no longer materialize the full scoped file-path list before scanning, reducing heap growth and keeping full-scan cost more predictable on large artifacts.
- Runtime metrics now keep cache LRU byte-accounting rows by reference and only materialize `cache_artifact_bytes_lru` during snapshot reads, removing per-publish array copies from the cache hit path.

### Documentation
- README tool tables are now validated from a shared contract manifest in code, correcting the documented `compare-minecraft` class-only `subject.kind="class".sourcePriority` input and aligning the published `inspect-minecraft` / `validate-project` output summaries with the implementation.
- Clarified the updated `search-class-source` `queryMode` behavior and the summary-first follow-up contract for the top-level workflow tools in both READMEs.
- Documented that safe fixed defaults now appear in `tools/list` schema output and that `suggestedCall` omits default-valued parameters.
- Reorganized the English README around package-user quick start, start-here examples, and linked reference docs so setup guidance is easier to scan without losing detailed contract notes.
- Synchronized the Japanese README with the current English README structure, examples, quick-start guidance, and tool-surface summary.

## [3.0.0] - 2026-03-09

### Added
- v3 entry tools: `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `analyze-mod`, `validate-project`, and `manage-cache` now provide summary-first starting points for the main Minecraft, symbol, mod, validation, and cache workflows while keeping expert tools available for follow-up work.
- The new v3 entry tools share `detail` / `include` response shaping and always return `result.summary` inside the standard `{ result?, error?, meta }` envelope, reducing default payload size and making next actions explicit.
- `analyze-mod` now exposes `executionMode="preview" | "apply"` for safe remap planning and execution, and `manage-cache` now exposes the same preview/apply model for cache deletion, pruning, and rebuild workflows.

### Documentation
- Added v3 entry-tool usage guidance, shared response-shaping notes, and entry-tool-first migration guidance to both READMEs.

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
- Heavy analysis tools are now serialized behind a bounded in-process queue, and queue overflow fails fast with `ERR_LIMIT_EXCEEDED` instead of amplifying concurrent load across the whole MCP transport.
- The stdio CLI entrypoint now supervises an internal worker process, automatically restarts it after an unexpected exit, replays MCP initialization for the live session, and turns in-flight crashes into retryable JSON-RPC request failures instead of a full transport disconnect.
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
- `validate-mixin` now retries with `sourcePriority="maven-first"` after a partial `loom-first` validation caused by mapping/signature resolution limits, reducing false warnings from Loom-only resolution paths.
- `validate-mixin` no longer emits schema-invalid `check-symbol-exists` recovery payloads in `suggestedCall`; unsupported parameters such as `scope` and `projectPath` are omitted from those calls.
- `validate-mixin` now lowers confidence for skipped member validation and exposes requested-vs-applied scope/source-priority details instead of making partial results look fully verified.
- `validate-mixin` now follows the resolved artifact namespace during bytecode lookup for non-vanilla scopes, so `scope="merged"` on Mojang-mapped Loom workspaces validates against merged class names instead of falling back to false partial results and retry-driven timeouts.
- Invalid `validate-mixin` requests now return the standard `ERR_INVALID_INPUT` envelope with `fieldErrors`, `hints`, and a mode-correct `suggestedCall` instead of the SDK's generic pre-validation text error.
- Bare string `target` inputs for `resolve-artifact`, `get-class-source`, and `get-class-members` now return `ERR_INVALID_INPUT` with schema-correct wrapper suggestions instead of generic object-schema failures.
- `validate-mixin` now classifies signature-loading/tool-limited target failures as `validation-incomplete` warnings instead of reporting them as missing classes.
- `check-symbol-exists` no longer repeats raw Loom tiny-cache miss warnings when Maven tiny mappings successfully satisfy the lookup; successful fallback now emits concise fallback context instead.

### Documentation
- Corrected the `compare-versions` README contract to document registry results under `result.registry`.
- Documented the new compact-response options, `summary-first` validate-mixin mode, bare-string `target` recovery guidance, and updated token-efficient examples in both READMEs.

### Performance
- `resolve-artifact`, `index-artifact`, and `get-runtime-metrics` now keep cache entry/byte accounting incrementally during ingest, reindex, cache hits, and eviction, avoiding repeated full-cache rescans after each artifact load.
- `find-mapping`, `get-class-api-matrix`, `resolve-workspace-symbol`, `check-symbol-exists`, and `validate-mixin` now reuse hot-path mapping graph paths, class remaps, and normalization work, reducing latency for repeated namespace lookups and large Mixin validation batches.
- Warm-cache source and mod workflows now avoid extra regex recompilation, statement-cache churn, and FIFO cache evictions across search, signature lookup, source resolution, and decompile paths.

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
- `resolve-artifact`: `mapping=mojang` + Loom merged source discovery now flags partial source coverage with `qualityFlags=["partial-source-no-net-minecraft"]` and a warning when the selected source jar does not actually contain `net.minecraft` entries.
- `get-class-source` / `get-class-members`: when an artifact is resolved from a `*-sources.jar`, the server now keeps the sibling binary jar and automatically falls back to it when source coverage is incomplete instead of treating the source jar as bytecode.
- `get-class-source`: partial-source binary fallback now bypasses the same sibling `*-sources.jar` that triggered the miss, and fallback failures for vanilla classes point to `get-class-api-matrix` instead of misleading `find-class` recovery.
- `get-class-members`: bytecode lookup now follows the resolved artifact namespace (`mappingApplied`) before remapping members back to the requested namespace, fixing merged Mojang artifacts that were incorrectly forced through obfuscated class names.
- `find-class`: zero-hit lookups against `mapping=obfuscated` now warn when the query looks like a deobfuscated Mojang class name.
- `find-class`: partial-source artifacts now suppress non-vanilla matches for vanilla-looking queries (for example `Item`) and return a warning instead of misleading modded classes.
- Tool input parsing: positive integer parameters now accept numeric strings such as `"10"` instead of failing validation immediately.
- Tool input parsing now leaves nested `typedJson` and JSON Patch `value` payload fields untouched, even when their keys happen to match top-level numeric option names such as `limit` or `maxLines`.

### Performance
- `search-class-source`: reduce search latency, heap growth, and DB round-trips by returning compact hits only and skipping snippet hydration, relation expansion, and `totalApprox` count queries.
- Tool input preprocessing now stays shallow, avoiding recursive scans through large nested payloads such as NBT typed JSON and patch bodies.

## [1.2.1] - 2026-03-05

### Fixed
- MCP startup regression: removed eager `SourceService` pre-initialization during server startup so `tools/list` handshakes are not blocked by SQLite initialization on slower environments.
- Decompiler: skip Java/Vineflower availability checks when decompiled source is already cached, avoiding unnecessary startup errors on systems without Java.

### Documentation
- Clarified startup behavior in README (`SourceService` remains lazy and is not pre-initialized before tool discovery).

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
- Lazy `SourceService` initialization — deferred until first tool/resource access, reducing cold-start latency during MCP handshake.
- Eagerly init `SourceService` during MCP handshake idle time for faster first-request response.

### Performance
- Avoid duplicate UTF-8 decode during truncation.
- Eager `SourceService` init during handshake idle time.

## [1.1.1] - 2026-03-02

### Fixed
- `search-class-source` now safely supports recursive `fileGlob` patterns such as `**` without regex construction failures.
- `get-class-source` now rejects package-incompatible fallback matches and preserves canonical inner-class (`Outer.Inner`) lookup support.

## [1.1.0] - 2026-03-01

### Changed
- Migrate stdio transport from mcp-use to @modelcontextprotocol/sdk.

### Fixed
- Restore Codex startup handshake compatibility by accepting both newline-delimited and `Content-Length` stdio framing.

### Documentation
- Add Quick Start setup for Claude Code, OpenAI Codex CLI, and Gemini CLI.

## [1.0.0] - 2026-03-01

### Added
- Initial release.
