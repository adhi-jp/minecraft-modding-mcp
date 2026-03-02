# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### chore(ci): temporarily disable Codecov workflow

#### Changed
- `.github/workflows/codecov.yml` now gates the `test-and-coverage` job with `if: ${{ false }}` to pause uploads temporarily.
- README coverage notes (English/Japanese) now document that the Codecov upload workflow is currently disabled.

### fix(mixin): resolve false-positive bugs and improve validate-mixin

#### Fixed
- `validate-mixin`: method references with JVM descriptors (e.g. `playerTouch(Lnet/minecraft/world/entity/player/Player;)V`) are now correctly stripped before comparison, eliminating false-positive `method-not-found` errors.
- `validate-mixin`: array-form `method = {"m1", "m2"}` attributes are now parsed correctly (previously only single-value `method = "m"` was supported).
- `validate-mixin`: `@Accessor(value = "name")` syntax is now recognized alongside `@Accessor("name")`.
- `validate-mixin`: `@Accessor`/`@Invoker` parse failures are escalated to `issues[]` with `severity: "warning"` instead of being silently added to `warnings[]`.
- `validate-mixin`: `@Invoker` validation now checks method members only (not fields), preventing false negatives when a same-named field exists without a matching method.

#### Added
- `validate-mixin`: `sourcePaths` parameter for batch validation of multiple Mixin files in a single call.
- `validate-mixin`: `structuredWarnings` field in results classifies warnings by severity (`"info"` or `"warning"`).
- `validate-mixin`: `resolutionNotes` in provenance records mapping fallback reasons.
- `extractMethodName()` and `extractMethodDescriptor()` utility functions for JVM method reference parsing.

### feat(mcp): strengthen mapping and source resolution workflows

#### Added
- `resolve-artifact` and `get-class-source` now accept optional `projectPath`; for `targetKind=version`, Loom source discovery is used for `mapping=mojang`.
- `find-mapping` now accepts optional `disambiguation` hints (`ownerHint`, `descriptorHint`) to narrow ambiguous candidates.
- `check-symbol-exists` now accepts optional `nameMode` (`fqcn` default, `auto` for short class names).
- `analyze-mod-jar` now returns `jarKind` (`binary`, `source`, `mixed`).

#### Fixed
- `search-mod-source` now detects source-only jars and searches `.java` entries directly without forcing decompilation.
- `resolve-artifact` mapping failures for version targets now include actionable diagnostics (`searchedPaths`, `candidateArtifacts`, `recommendedCommand`).
- `check-symbol-exists` now returns `ERR_INVALID_INPUT` for invalid symbol combinations before evaluating mapping availability.

### feat(mcp): add decompiler retry, sampleEntries, ambiguityReasons, and api-matrix diagnostics

#### Added
- `resolve-artifact` now returns optional `sampleEntries` when a source JAR is resolved.
- `find-mapping` now returns optional `ambiguityReasons` for `status=ambiguous`.
- `get-class-api-matrix` now returns optional `ambiguousRowCount` when ambiguity fallback is applied.

#### Fixed
- Vineflower decompilation now retries with fallback flag profiles and includes attempted profiles in terminal `ERR_DECOMPILER_FAILED` details.
- `get-class-api-matrix.ambiguousRowCount` now counts ambiguous rows (not per-mapping ambiguity hits).

### fix(config): default cache dir to home when unset

#### Fixed
- Server startup no longer depends on the current working directory for default cache paths; when `MCP_CACHE_DIR` is unset, cache/SQLite now default to `~/.cache/minecraft-modding-mcp`.

### feat(mcp): add source mode, find-class tool, scope/version overrides, and structured error recovery

#### Added
- New `find-class` tool to resolve simple or fully-qualified class names to concrete source paths inside an indexed artifact.
- `resolve-artifact` and `get-class-source` now accept optional `scope` (`vanilla`/`merged`/`loader`) and `preferProjectVersion` for workspace-driven version resolution.
- `get-class-source` now accepts `mode` (`full`/`snippet`/`metadata`), `maxChars`, and `outputFile`.
- `get-class-source` and `resolve-artifact` errors now include structured `suggestedCall` recovery details.

#### Fixed
- `find-class` fully-qualified lookups now avoid early-limit false negatives when many packages share the same simple class name.

### fix(decompiler): pass Vineflower flags before positional args

#### Fixed
- Decompile fallback now passes Vineflower flags before positional `<input-jar> <output-dir>` arguments, fixing false `ERR_DECOMPILER_FAILED` errors on valid Minecraft client jars.

### fix(mcp): improve error recovery context and fix version-approximation detection

#### Fixed
- `CLASS_NOT_FOUND` errors now include `scope`, `targetKind`, `targetValue`, `mapping`, and improved retry guidance.
- `MAPPING_NOT_APPLIED` recovery `suggestedCall` now preserves `scope`, and vanilla+mojang failures now provide context-aware next actions.
- Version approximation detection now avoids prefix false positives (for example, `1.21.1` vs `1.21.10`) and reports mismatched source-jar versions more reliably.
- Post-filtered empty first pages now return `totalApprox=0` instead of stale approximated totals.

### fix(mixin): resolve false-positive bugs and add sourcePath/provenance to validate-mixin

#### Added
- `validate-mixin` now accepts `sourcePath` as an alternative to inline `source`, plus optional `projectPath`/`scope`/`preferProjectVersion`, and returns `provenance` (`version`, `jarPath`, `requestedMapping`, `mappingApplied`).

#### Fixed
- `validate-mixin` now normalizes `sourcePath` with host/WSL path conversion before reading source files.
- `validate-mixin` now resolves simple `@Mixin` class names via imports so validation targets the correct FQCN.
- `validate-mixin` now remaps bytecode signature members to the requested mapping before member validation.
- `validate-mixin` parsing now supports `default`/`synchronized` modifiers and `interface` declarations in accessor workflows.

### perf(mcp): reduce startup latency with lazy SourceService initialization

#### Changed
- `src/index.ts` now defers `SourceService` construction until the first tool/resource access via a lazy proxy, reducing cold-start overhead during MCP handshake and tool discovery.
- Added integration coverage to ensure lazy initialization wiring remains in place.

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
