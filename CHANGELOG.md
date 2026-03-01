# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
