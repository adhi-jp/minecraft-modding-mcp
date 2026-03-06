# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Breaking change: the public mapping namespace `official` was removed and replaced with `obfuscated` across tool inputs, outputs, API matrix keys, diagnostics, and examples. Requests that still send `official` now fail with `ERR_INVALID_INPUT` and should be updated to `obfuscated`.

### Fixed
- `resolve-artifact`: `targetKind=coordinate` now reuses the local Gradle `modules-2` cache in addition to the local Maven repository and configured source repos, so cached third-party libraries such as Architectury can resolve without manual cache spelunking.
- `resolve-artifact`: `mapping=mojang` + Loom merged source discovery now flags partial source coverage with `qualityFlags=["partial-source-no-net-minecraft"]` and a warning when the selected source jar does not actually contain `net.minecraft` entries.
- `get-class-source` / `get-class-members`: when an artifact is resolved from a `*-sources.jar`, the server now keeps the sibling binary jar and automatically falls back to it when source coverage is incomplete instead of treating the source jar as bytecode.
- `find-class`: zero-hit lookups against `mapping=obfuscated` now warn when the query looks like a deobfuscated Mojang class name.
- Tool input parsing: positive integer parameters now accept numeric strings such as `"10"` instead of failing validation immediately.

### Performance
- `search-class-source`: reduce `intent=path` heap growth on large source files by loading bounded top-of-file snippets during indexed path search and falling back to full content only when needed to preserve exact snippet output.

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
