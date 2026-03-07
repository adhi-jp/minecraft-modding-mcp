# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**[日本語](docs/README-ja.md)** | English

---

`@adhisang/minecraft-modding-mcp` is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants deep access to Minecraft's source code, mappings, and mod tooling.

It lets you explore decompiled Minecraft source, convert symbol names across four naming namespaces (`obfuscated`, `mojang`, `intermediary`, `yarn`), analyze and decompile Fabric/Forge/NeoForge mod JARs, validate Mixin and Access Widener files, read and patch NBT data, and query generated registry snapshots — all through a structured tool and resource interface designed for Claude Desktop, VS Code, and other MCP-capable clients.

**29 tools** | **7 resources** | **4 namespace mappings** | **SQLite-backed cache**

## Features

- **Source Exploration** — Browse and search decompiled Minecraft source code with line-level precision and cursor-paginated file listing
- **Multi-Mapping Conversion** — Translate class, field, and method names between `obfuscated`, `mojang`, `intermediary`, and `yarn` namespaces
- **Symbol Lifecycle Tracking** — Trace when a method or field first appeared, disappeared, or changed across Minecraft versions
- **Mod JAR Analysis** — Extract metadata, dependencies, entrypoints, and Mixin configs from Fabric/Forge/NeoForge mod JARs
- **Mixin & Access Widener Validation** — Parse and validate Mixin source and `.accesswidener` files against a target Minecraft version
- **NBT Round-Trip** — Decode NBT binary to typed JSON, apply RFC 6902 patches, and re-encode back to NBT
- **Registry Data** — Query generated registry snapshots (blocks, items, entities, etc.) for any Minecraft version
- **Version Comparison** — Diff class signatures and registry entries between two Minecraft versions
- **JAR Remapping** — Remap Fabric mod JARs from `intermediary` to `yarn` or `mojang` namespaces
- **MCP Resources** — Access version lists, class source, artifact metadata, and mappings through URI-based resources

## Quick Start

### Prerequisites
- Node.js 22+
- pnpm

### For Users (Installed Package)
```bash
npx @adhisang/minecraft-modding-mcp
```

### CLI Agent Tools

#### Claude Code

```bash
claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
claude mcp list
```

#### OpenAI Codex CLI

```bash
codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
codex mcp list
```

The stdio transport auto-detects both newline-delimited and `Content-Length` framing, so Codex and newline-based MCP clients can use the same server command.

The server now lazily initializes heavyweight source/index services on first MCP request, reducing initial process startup latency for clients that only perform handshake/tool discovery.
To preserve handshake reliability across clients, startup does not eagerly pre-initialize `SourceService` before tool discovery.

#### Gemini CLI

Add the following to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

Then run this command in Gemini CLI:

```text
/mcp list
```

### For Developers (Repository)
```bash
pnpm install
```

### Run (development)
```bash
pnpm dev
```

### Build + Run (distribution shape)
```bash
pnpm build
pnpm start
```

### Validate
```bash
pnpm check
pnpm test
pnpm test:coverage
```

### Coverage
```bash
pnpm test:coverage
```

Coverage thresholds: `lines=80`, `branches=70`, `functions=80`.

Generate LCOV output for Codecov upload:

```bash
pnpm test:coverage:lcov
```

GitHub Actions upload workflow: `.github/workflows/codecov.yml` (temporarily disabled; when enabled, it runs on `v*` tags and manual dispatch).

### MCP Client Configuration

#### Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

#### VS Code

Add the following to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"]
    }
  }
}
```

#### Custom Environment

Pass environment variables to override defaults:

```json
{
  "mcpServers": {
    "minecraft-modding": {
      "command": "npx",
      "args": ["-y", "@adhisang/minecraft-modding-mcp"],
      "env": {
        "MCP_CACHE_DIR": "/path/to/custom/cache",
        "MCP_MAPPING_SOURCE_PRIORITY": "maven-first"
      }
    }
  }
}
```

## Tool Surface

### Source Exploration

Tools for browsing Minecraft versions, resolving source artifacts, and reading/searching decompiled source code.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `list-versions` | List available Minecraft versions from Mojang manifest + local cache | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |
| `resolve-artifact` | Resolve source artifact from `version` / `jar` / `coordinate` | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |
| `find-class` | Resolve simple or fully-qualified class names inside an artifact | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |
| `get-class-source` | Get class source by artifact target or resolve target on demand (`mode=metadata` by default) | `className`, `target`, `mode?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, mapping/provenance metadata |
| `get-class-members` | Get class fields/methods/constructors from bytecode | `className`, `target`, `mapping?`, `access?`, `includeInherited?`, `maxMembers?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |
| `search-class-source` | Search indexed class source for symbols/text/path | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `get-artifact-file` | Read full source file with byte guard | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `list-artifact-files` | List indexed source file paths with cursor pagination | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |
| `index-artifact` | Rebuild index metadata for an existing artifact | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |

### Version Comparison & Symbol Tracking

Tools for comparing class/registry changes across Minecraft versions and tracing symbol existence over time.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `trace-symbol-lifecycle` | Trace when `Class.method` exists across Minecraft versions | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |
| `diff-class-signatures` | Compare one class between two versions and return member deltas | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `summary`, `warnings[]` |
| `compare-versions` | Compare class/registry changes between two versions | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |

### Mapping & Symbols

Tools for converting symbol names between namespaces and checking symbol existence.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `find-mapping` | Find mapping candidates for class/field/method symbols between namespaces | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |
| `resolve-method-mapping-exact` | Resolve one method mapping with strict owner+name+descriptor matching | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `provenance?`, `meta.warnings[]` |
| `get-class-api-matrix` | Show one class API as a mapping matrix (`obfuscated/mojang/intermediary/yarn`) | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?` | `classIdentity`, `rows[]`, `ambiguousRowCount?`, `meta.warnings[]` |
| `resolve-workspace-symbol` | Resolve compile-visible symbol names for a Gradle workspace (`build.gradle/.kts`) | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `workspaceDetection`, `meta.warnings[]` |
| `check-symbol-exists` | Strict symbol presence check for class/field/method | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `meta.warnings[]` |

### NBT Utilities

Tools for decoding, patching, and encoding Java Edition NBT binary data using a typed JSON representation.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `nbt-to-json` | Decode Java Edition NBT binary (`base64`) to typed JSON | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |
| `nbt-apply-json-patch` | Apply RFC 6902 patch (`add/remove/replace/test`) to typed NBT JSON | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |
| `json-to-nbt` | Encode typed JSON back to Java Edition NBT binary (`base64`) | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |

### Mod Analysis

Tools for extracting metadata from mod JARs, decompiling mod source, searching mod code, and remapping mod namespaces.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `analyze-mod-jar` | Extract mod metadata/dependencies/entrypoints from mod JAR | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, class stats |
| `decompile-mod-jar` | Decompile mod JAR and optionally return one class source | `jarPath`, `className?` | `outputDir`, `fileCount`, `files?`, `source?`, `warnings[]` |
| `get-mod-class-source` | Read one class source from decompiled mod cache | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |
| `search-mod-source` | Search decompiled mod source by class/method/field/content | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |
| `remap-mod-jar` | Remap a Fabric mod JAR from intermediary to yarn/mojang names | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |

### Validation

Tools for validating Mixin source and Access Widener files against a target Minecraft version.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `validate-mixin` | Parse/validate Mixin source against target Minecraft version | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?` | `mode`, `results[]`, `summary`, `issueSummary?`, `toolHealth?`, `confidenceScore?` |
| `validate-access-widener` | Parse/validate Access Widener content against target version | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |

### Registry & Diagnostics

Tools for querying generated registry data and inspecting server runtime state.

| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `get-registry-data` | Get generated registry snapshots (blocks/items/entities etc.) | `version`, `registry?` | `registries` (all or selected), `warnings[]` |
| `get-runtime-metrics` | Inspect runtime counters and latency snapshots | none | `result.*` runtime metrics, `meta` envelope |

### Tool Constraints

`resolve-artifact` now takes `target: { kind, value }`.
`get-class-source` requires `target`, where `target.type="artifact"` selects a previously resolved `artifactId` and `target.type="resolve"` supplies `{ kind, value }` directly.
`get-class-members` requires the same `target` object shape and still needs a binary jar (`binaryJarPath`) to read `.class` entries.
`get-class-members` returns `ERR_INVALID_INPUT` when a classfile contains malformed field or method descriptors instead of emitting malformed Java signature text from corrupted bytecode.
Error `suggestedCall` payloads now use the same `target` object schema instead of legacy `targetKind` / `targetValue` fields.
Positive integer tool parameters accept numeric strings such as `"10"` in addition to JSON numbers.
This numeric-string coercion only applies to documented top-level tool arguments; nested `typedJson` payloads and JSON Patch `value` objects are preserved verbatim.
`resolve-artifact`, `get-class-source`, `get-class-members`, `search-class-source`, `get-artifact-file`, and `list-artifact-files` include `artifactContents` so clients can see whether the backing artifact is `source-jar` or `decompiled-binary`, whether resources are indexed (`resourcesIncluded=false` today), and whether source coverage is always `full` or `partial`.
`get-class-source`, `get-class-members`, `search-class-source`, and `get-artifact-file` include `returnedNamespace`; compare it with `mappingApplied` when a tool returns remapped symbols instead of raw indexed source text.
`list-artifact-files` warns when you probe `assets/` or `data/` prefixes because the current index stores Java source only, not non-Java resources.
`get-class-source` and `get-class-members` can infer a missing artifact version from `projectPath` when `preferProjectVersion=true` and artifact metadata does not already contain a version.
Heavy analysis tools (`trace-symbol-lifecycle`, `diff-class-signatures`, `compare-versions`, `find-mapping`, `resolve-method-mapping-exact`, `get-class-api-matrix`, `get-registry-data`) are serialized inside the server to protect stdio transport stability; when the queue is full they fail fast with `ERR_LIMIT_EXCEEDED`.
The CLI stdio entrypoint now runs a supervised worker process. If the worker exits unexpectedly, the wrapper restarts it, replays MCP initialization for the current session, and keeps the same stdio connection usable; any request that was already in flight fails with a retryable JSON-RPC internal error instead of tearing down the whole transport.
`validate-mixin` requires `input.mode` to be exactly one of `inline`, `path`, `paths`, or `config`. `input.path`/`input.paths[]` are normalized for host/WSL path formats before file reads. `input.configPaths[]` reads mixin config JSON files and auto-discovers source files for batch validation (`sourceRoots[]` override lookup roots; otherwise common roots like `src/main/java`, `src/client/java`, `common/src/{main,client}/java`, `fabric/src/{main,client}/java`, `neoforge/src/{main,client}/java`, `forge/src/{main,client}/java`, and `quilt/src/{main,client}/java` are auto-detected from configured mixin classes).
`validate-mixin` always returns `mode`, `results[]`, and `summary`; single-input modes still use a one-element `results[]` array.
`validate-mixin` per-result responses include `provenance.resolutionNotes?` when mapping fallback occurs.
`validate-mixin` validates `@Invoker` targets against methods only and `@Accessor` targets against fields only.
`validate-mixin` parser supports both `.class` literal targets and `targets = "..."` / `targets = {"a", "b"}` string forms.
`validate-mixin` parser handles multi-line annotations between `@Shadow`/`@Accessor` and declarations, and strips inline annotations from declaration lines.
`validate-mixin` distinguishes `target-mapping-failed` (warning, uncertain) from `target-not-found` (error) when class mapping fails.
`validate-mixin` issues and `structuredWarnings` include `category` (`mapping`, `configuration`, `validation`, `resolution`, or `parse`) to distinguish setup/tooling/parser limits from real validation errors.
`validate-mixin` supports post-filtering with `minSeverity`, `hideUncertain`, and `warningCategoryFilter`; `treatInfoAsWarning=false` suppresses info-level entries in `structuredWarnings`.
`validate-mixin` per-result responses include `resolvedMembers?` tracking each member's resolution status (`resolved` or `not-found`).
`validate-mixin` with `explain=true` enriches each issue with `explanation` and `suggestedCall` (tool + params) for agent-driven recovery.
`validate-mixin` summary uses `processingErrors`, `totalValidationErrors`, and `totalValidationWarnings`; the deprecated `summary.errors` field was removed.
`resolve-artifact` with `target.kind=version` uses Loom cache discovery from `projectPath` only when `mapping=mojang`; mapping failures include `searchedPaths`, `candidateArtifacts`, and `recommendedCommand` in error details.
`resolve-artifact` supports `scope` (`vanilla`/`merged`/`loader`) and optional `preferProjectVersion=true` to override `target.value` from `gradle.properties` (`minecraft_version`, `mc_version`, `minecraftVersion`) when `target.kind=version`.
`resolve-artifact` with `target.kind=coordinate` searches the local Maven repository, the local Gradle `modules-2` cache, and configured `MCP_SOURCE_REPOS` before reporting `ERR_SOURCE_NOT_FOUND`.
`resolve-artifact`, `get-class-source`, and `get-class-members` now preserve `ERR_JAR_NOT_FOUND` for missing or inaccessible `target.kind=jar` paths instead of surfacing raw filesystem exceptions.
`resolve-artifact` includes `sampleEntries` only when a source JAR is resolved; decompile-only paths leave it unset.
`resolve-artifact` adds `qualityFlags=["partial-source-no-net-minecraft"]` and a warning when a merged Loom source candidate does not contain `net.minecraft` sources; only candidates that still look like Minecraft source artifacts are auto-selected, while version-matching mod/library source jars remain diagnostics only. `get-class-source` now bypasses that sibling `*-sources.jar` during binary fallback so the fallback can actually reach the binary artifact.
`find-class` returns type symbols (`class`/`interface`/`enum`/`record`) only; fully-qualified lookups are filtered by exact FQCN/file path to avoid false negatives when many classes share the same simple name.
`find-class` returns an explanatory warning when an `obfuscated` artifact is queried with names that look like deobfuscated Mojang classes.
`find-class` suppresses non-vanilla matches for vanilla-looking queries on artifacts flagged with `partial-source-no-net-minecraft`; in that situation it returns a warning instead of unrelated modded classes.
`search-class-source` uses `limit: 20` by default.
`search-class-source` `queryMode` controls text search strategy: `auto` (default) uses indexed token search with literal fallback for separator queries, `token` keeps indexed token behavior only, and `literal` uses substring scan only.
`search-class-source` with `match=regex` enforces `query.length <= 200` and a strict result cap of `100`.
`search-class-source` now returns compact file hits without snippets, line windows, relation expansion, or `totalApprox`.
Use `get-artifact-file` or `get-class-source` to inspect returned files after search.
`search-class-source` `symbolKind` is only supported when `intent=symbol`.
`get-artifact-file` byte truncation now preserves UTF-8 character boundaries, preventing replacement-character (`�`) corruption when `maxBytes` cuts through multibyte text.
`search-class-source` `fileGlob` supports `*`, `**`, and `?`; recursive patterns such as `net/minecraft/**/*.java` are supported.
`get-class-source` fallback matching enforces package compatibility and returns `ERR_CLASS_NOT_FOUND` when only name-colliding classes from other packages exist.
`get-class-source` now falls back to the sibling binary artifact when a source-backed artifact is only partial (for example, merged Loom sources without `net.minecraft` entries); if that fallback still cannot produce source, the error now carries the partial-source context and suggests `get-class-api-matrix` instead of `find-class`.
`get-class-source` warns when fallback source text is returned in a different namespace than the requested mapping; the source text itself is not remapped.
`get-class-source` mode defaults to `metadata` (symbol outline only); `mode=snippet` auto-sets `maxLines=200` when no line range/max is provided; `mode=full` returns the entire source. `outputFile` writes the selected text and returns the file path in `outputFile`.
Decompile fallback for `resolve-artifact`/`get-class-source` now invokes Vineflower with flags before positional `<input-jar> <output-dir>` arguments to avoid false `ERR_DECOMPILER_FAILED` outcomes on valid jars.
`resolve-artifact` with `target.kind=jar` only auto-adopts the exact sibling `"<jar-basename>-sources.jar"`. Other adjacent `*-sources.jar` files are returned as `adjacentSourceCandidates` info only and are never auto-selected.
When a resolved artifact comes from a `*-sources.jar`, `get-class-members` now keeps the sibling binary jar (for example `minecraft-merged-<version>.jar`) instead of treating the source jar as bytecode, and it now looks up the class in the resolved artifact namespace before remapping member names back to the requested mapping.
For `target.kind=coordinate` with a classifier (`group:artifact:version:classifier`), local Maven source lookup checks `<artifact>-<version>-<classifier>-sources.jar` first and then `<artifact>-<version>-sources.jar`.
Mod tool `jarPath` inputs are normalized to a canonical local `.jar` file path before existence checks, cache keying, and processing.
`search-mod-source` enforces `query.length <= 200` and `limit <= 200`.
`search-mod-source` detects source-only jars and searches `.java` entries directly without decompilation.
`get-mod-class-source` supports `maxLines`, `maxChars`, and `outputFile` with truncation behavior aligned to `get-class-source`; when `outputFile` is set, the written file reflects applied truncation.
`find-mapping` returns `ambiguityReasons` when `status=ambiguous` to explain why candidates could not be uniquely resolved.
`get-class-api-matrix` returns `ambiguousRowCount` when one or more rows required ambiguity fallback.
`check-symbol-exists` defaults to strict FQCN class inputs; set `nameMode=auto` to allow short class names (ambiguous matches return `status=ambiguous`).
`check-symbol-exists` supports `signatureMode=name-only` to match methods by owner+name without requiring a descriptor. Single match returns `resolved`; multiple overloads return `ambiguous` with all candidates.
`check-symbol-exists` always validates input shape first and returns `ERR_INVALID_INPUT` for invalid symbol combinations, even when mapping data is unavailable.
`get-registry-data` now discards corrupt cached `registries.json` files, regenerates them when possible, and returns `ERR_REGISTRY_GENERATION_FAILED` if the regenerated snapshot is still unreadable.
Migration notes:
- Replace `resolve-artifact` `targetKind` + `targetValue` with `target: { kind, value }`.
- Replace `get-class-source` / `get-class-members` top-level `artifactId` / `targetKind` / `targetValue` with `target: { type: "artifact", artifactId }` or `target: { type: "resolve", kind, value }`.
- `resolve-method-mapping-exact` is method-only and no longer accepts `kind`.
- Replace `validate-mixin` `source` / `sourcePath` / `sourcePaths` / `mixinConfigPath` / `sourceRoot` with `input.mode` plus `input.source` / `input.path` / `input.paths[]` / `input.configPaths[]` and `sourceRoots[]`. Use `summary.processingErrors` instead of `summary.errors`.
- `search-class-source` removed `snippetLines`, `includeDefinition`, and `includeOneHop`; responses now contain compact `hits[]` plus `nextCursor?` only, and `symbolKind` may only be used with `intent=symbol`.
`remap-mod-jar` requires Java to be installed and only supports Fabric/Quilt mods.

## Resources

MCP resources provide URI-based access to Minecraft data, usable by any MCP client that supports the resource protocol.

### Fixed Resources

| Resource | URI | Description |
| --- | --- | --- |
| `versions-list` | `mc://versions/list` | List all available Minecraft versions with their metadata |
| `runtime-metrics` | `mc://metrics` | Runtime metrics and performance counters for the MCP server |

### Template Resources

| Resource | URI Template | Description |
| --- | --- | --- |
| `class-source` | `mc://source/{artifactId}/{className}` | Java source code for a class within a resolved artifact |
| `artifact-file` | `mc://artifact/{artifactId}/files/{filePath}` | Raw content of a file within a resolved artifact |
| `find-mapping` | `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}` | Look up a mapping between two naming namespaces |
| `class-members` | `mc://artifact/{artifactId}/members/{className}` | List constructors, methods, and fields for a class |
| `artifact-metadata` | `mc://artifact/{artifactId}` | Metadata for a previously resolved artifact |

`versions-list`, `runtime-metrics`, `find-mapping`, `class-members`, and `artifact-metadata` return structured JSON envelopes on success (`{ result, meta }`) and failure (`{ error, meta }`).
`class-source` and `artifact-file` keep raw text responses on success, but still return structured JSON errors on failure.

## Response Envelope

All tools return exactly one of:

- Success: `{ result: { ... }, meta: { requestId, tool, durationMs, warnings[] } }`
- Failure: `{ error: { type, title, detail, status, code, instance, fieldErrors?, hints? }, meta: { requestId, tool, durationMs, warnings[] } }`

JSON resources follow the same `result/error/meta` pattern. Text resources return plain text on success.
The same JSON envelope is mirrored in MCP `structuredContent` for SDK-aware clients, and failures also set `isError=true`.

## Examples

### Source Exploration

#### Resolve from Minecraft version
```json
{
  "tool": "resolve-artifact",
  "arguments": {
    "target": {
      "kind": "version",
      "value": "1.21.10"
    },
    "mapping": "obfuscated",
    "allowDecompile": true,
    "projectPath": "/path/to/mod/workspace"
  }
}
```

#### Get class source with line window
```json
{
  "tool": "get-class-source",
  "arguments": {
    "target": {
      "type": "artifact",
      "artifactId": "<artifact-id>"
    },
    "className": "net.minecraft.server.Main",
    "startLine": 50,
    "endLine": 180,
    "maxLines": 80
  }
}
```

#### Search by method symbol
```json
{
  "tool": "search-class-source",
  "arguments": {
    "artifactId": "<artifact-id>",
    "query": "tickServer",
    "intent": "symbol",
    "match": "exact"
  }
}
```

#### Get class member list
```json
{
  "tool": "get-class-members",
  "arguments": {
    "artifactId": "<artifact-id>",
    "className": "net.minecraft.server.Main",
    "mapping": "obfuscated",
    "access": "all",
    "includeInherited": true,
    "maxMembers": 300
  }
}
```

#### List artifact files with prefix filter

List source files under a specific package to understand project structure:

```json
{
  "tool": "list-artifact-files",
  "arguments": {
    "artifactId": "<artifact-id>",
    "prefix": "net/minecraft/world/level/",
    "limit": 50
  }
}
```

### Version Comparison & Symbol Tracking

#### Trace `Class.method` lifecycle
```json
{
  "tool": "trace-symbol-lifecycle",
  "arguments": {
    "symbol": "net.minecraft.server.Main.tickServer",
    "descriptor": "()V",
    "fromVersion": "1.20.1",
    "toVersion": "1.21.10",
    "includeTimeline": true
  }
}
```

#### Diff one class across two versions
```json
{
  "tool": "diff-class-signatures",
  "arguments": {
    "className": "net.minecraft.server.Main",
    "fromVersion": "1.20.1",
    "toVersion": "1.21.10",
    "mapping": "obfuscated"
  }
}
```

#### Compare two Minecraft versions

Get a high-level summary of what changed between two releases, including class additions/removals and registry diffs:

```json
{
  "tool": "compare-versions",
  "arguments": {
    "fromVersion": "1.20.4",
    "toVersion": "1.21.10",
    "category": "all",
    "packageFilter": "net.minecraft.world",
    "maxClassResults": 100
  }
}
```

Registry deltas are returned under `result.registry` (not `registryDiff`).
When `packageFilter` is provided, `result.classes.addedCount`, `removedCount`, and `unchanged`
are all scoped to that filtered package set.

### Mapping & Symbols

#### Lookup mapping candidates
```json
{
  "tool": "find-mapping",
  "arguments": {
    "version": "1.21.10",
    "kind": "class",
    "name": "a.b.C",
    "sourceMapping": "obfuscated",
    "targetMapping": "mojang",
    "sourcePriority": "loom-first",
    "disambiguation": {
      "ownerHint": "net.minecraft"
    }
  }
}
```

#### Lookup method mapping with descriptor
```json
{
  "tool": "find-mapping",
  "arguments": {
    "version": "1.21.10",
    "kind": "method",
    "name": "tick",
    "owner": "a.b.C",
    "descriptor": "(I)V",
    "sourceMapping": "obfuscated",
    "targetMapping": "intermediary"
  }
}
```

#### Resolve exact method mapping
```json
{
  "tool": "resolve-method-mapping-exact",
  "arguments": {
    "version": "1.21.10",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(Ljava/lang/String;)V",
    "sourceMapping": "obfuscated",
    "targetMapping": "mojang"
  }
}
```

#### Show class API mapping matrix
```json
{
  "tool": "get-class-api-matrix",
  "arguments": {
    "version": "1.21.10",
    "className": "a.b.C",
    "classNameMapping": "obfuscated",
    "includeKinds": "class,field,method"
  }
}
```

#### Resolve workspace compile-visible symbol
```json
{
  "tool": "resolve-workspace-symbol",
  "arguments": {
    "projectPath": "/path/to/mod/workspace",
    "version": "1.21.10",
    "kind": "method",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(Ljava/lang/String;)V",
    "sourceMapping": "obfuscated"
  }
}
```

#### Check symbol existence
```json
{
  "tool": "check-symbol-exists",
  "arguments": {
    "version": "1.21.10",
    "kind": "method",
    "name": "f",
    "owner": "a.b.C",
    "descriptor": "(I)V",
    "sourceMapping": "obfuscated"
  }
}
```

#### Check class existence by short name (`nameMode=auto`)
```json
{
  "tool": "check-symbol-exists",
  "arguments": {
    "version": "1.21.10",
    "kind": "class",
    "name": "Blocks",
    "nameMode": "auto",
    "sourceMapping": "mojang"
  }
}
```

### NBT Utilities

#### Decode Java NBT base64 to typed JSON
```json
{
  "tool": "nbt-to-json",
  "arguments": {
    "nbtBase64": "<base64-nbt>",
    "compression": "auto"
  }
}
```

#### Patch typed NBT JSON
```json
{
  "tool": "nbt-apply-json-patch",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": { "type": "compound", "value": {} }
    },
    "patch": [
      { "op": "add", "path": "/root/value/name", "value": { "type": "string", "value": "Alex" } }
    ]
  }
}
```

#### Encode typed JSON back to NBT base64
```json
{
  "tool": "json-to-nbt",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": { "type": "compound", "value": {} }
    },
    "compression": "gzip"
  }
}
```

### Mod Analysis Workflow

A typical mod analysis workflow progresses through metadata extraction, decompilation, source reading, and search:

#### 1. Analyze mod metadata

Extract loader type, mod ID, dependencies, and Mixin configurations from a mod JAR:

```json
{
  "tool": "analyze-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeClasses": true
  }
}
```

#### 2. Decompile the mod JAR

Decompile all classes and optionally retrieve a specific class inline:

```json
{
  "tool": "decompile-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "className": "com.example.mymod.MyMod"
  }
}
```

#### 3. Read a specific class from decompiled source

After decompilation, read any class without re-decompiling:

```json
{
  "tool": "get-mod-class-source",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "className": "com.example.mymod.mixin.PlayerMixin"
  }
}
```

#### 4. Search across decompiled mod source

Find method references, field usages, or text patterns across the entire decompiled mod:

```json
{
  "tool": "search-mod-source",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "query": "onPlayerTick",
    "searchType": "method",
    "limit": 50
  }
}
```

#### 5. Remap mod JAR to readable names

Remap a Fabric mod from `intermediary` to `yarn` names for easier reading:

```json
{
  "tool": "remap-mod-jar",
  "arguments": {
    "inputJar": "/path/to/mymod-1.0.0.jar",
    "targetMapping": "yarn",
    "mcVersion": "1.21.10"
  }
}
```

### Validation

#### Validate Mixin source

Check a Mixin class source for correctness against a target Minecraft version:

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "inline",
      "source": "@Mixin(PlayerEntity.class)\npublic abstract class PlayerMixin {\n  @Inject(method = \"tick\", at = @At(\"HEAD\"))\n  private void onTick(CallbackInfo ci) {}\n}"
    },
    "version": "1.21.10",
    "mapping": "yarn"
  }
}
```

#### Validate multiple Mixin files (batch)

Run the same validation settings against multiple Mixin source files:

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "paths",
      "paths": [
        "/path/to/PlayerMixin.java",
        "/path/to/WorldMixin.java"
      ]
    },
    "version": "1.21.10",
    "mapping": "yarn"
  }
}
```

#### Validate Access Widener

Check an Access Widener file for valid entries against the target version:

```json
{
  "tool": "validate-access-widener",
  "arguments": {
    "content": "accessWidener v2 named\naccessible class net/minecraft/server/Main\naccessible method net/minecraft/server/Main tick ()V",
    "version": "1.21.10",
    "mapping": "yarn"
  }
}
```

### Registry & Diagnostics

#### Get all registries for a version

Retrieve the full set of generated registries (blocks, items, entities, etc.) for a Minecraft version:

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10"
  }
}
```

#### Get a single registry

Fetch only a specific registry type:

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10",
    "registry": "minecraft:block"
  }
}
```

#### Force reindex an artifact

Rebuild the search index for an artifact after cache or tooling changes:

```json
{
  "tool": "index-artifact",
  "arguments": {
    "artifactId": "<artifact-id>",
    "force": true
  }
}
```

#### Inspect runtime metrics

Check server performance counters, cache sizes, and latency snapshots:

```json
{
  "tool": "get-runtime-metrics",
  "arguments": {}
}
```

## Mapping Policy

### Namespace Definitions

| Namespace | Description |
| --- | --- |
| `obfuscated` | Mojang obfuscated names (e.g. `a`, `b`, `c`) |
| `mojang` | Mojang deobfuscated names from `client_mappings.txt` (e.g. `net.minecraft.server.Main`) |
| `intermediary` | Fabric stable intermediary names (e.g. `net.minecraft.class_1234`, `method_5678`) |
| `yarn` | Fabric community human-readable names (e.g. `net.minecraft.server.MinecraftServer`, `tick`) |

The legacy public namespace name `official` was removed. Requests that still send `official` now fail validation and should be updated to `obfuscated`.

### Lookup Rules

`find-mapping` supports lookup across `obfuscated`, `mojang`, `intermediary`, and `yarn`.

Symbol query inputs use `kind` + `name` + optional `owner`/`descriptor`:
- class: `kind=class`, `name=a.b.C` (default FQCN). For existence checks only, `nameMode=auto` allows short names like `C`.
- field: `kind=field`, `owner=a.b.C`, `name=fieldName`
- method: `kind=method`, `owner=a.b.C`, `name=methodName`, `descriptor=(I)V`

`mapping: "mojang"` requires a source-backed artifact. If only decompile path is available, the server returns `ERR_MAPPING_NOT_APPLIED`.

`resolve-artifact`, `get-class-members`, `trace-symbol-lifecycle`, and `diff-class-signatures` accept `obfuscated | mojang | intermediary | yarn` with constraints:
- `intermediary` / `yarn` require a resolvable Minecraft version context (for example `target.kind=version` or a versioned coordinate).
- for unobfuscated versions (for example 26.1+), requesting `intermediary` / `yarn` falls back to `obfuscated` with a warning.
- `mojang` requires source-backed artifacts; decompile-only paths are rejected with `ERR_MAPPING_NOT_APPLIED`.

If `find-class` or `get-class-source` returns no hit on an `obfuscated` artifact for names like `net.minecraft.world.item.Item`, the tool now warns that `obfuscated` means Mojang's obfuscated runtime names and recommends retrying with `mapping="mojang"` or translating via `find-mapping`.

Method descriptor precision is best on Tiny-backed paths (`intermediary`/`yarn`). For `obfuscated <-> mojang`, Mojang `client_mappings` do not carry JVM descriptors, so descriptor queries may fallback to name matching and emit a warning.

Use `resolve-method-mapping-exact` when candidate ranking is not enough and the workflow needs strict `owner+name+descriptor` certainty.
Use `find-mapping` `disambiguation.ownerHint` / `disambiguation.descriptorHint` to narrow ambiguous candidate sets.
Use `resolve-workspace-symbol` when you need compile-visible names from actual Gradle Loom mappings in a workspace.

## Environment Variables

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | Cache root for downloads and SQLite |
| `MCP_SQLITE_PATH` | `<cacheDir>/source-cache.db` | SQLite database path |
| `MCP_SOURCE_REPOS` | Maven Central + Fabric + Forge + NeoForge | Comma-separated Maven repository URLs |
| `MCP_LOCAL_M2` | `~/.m2/repository` | Local Maven repository path |
| `MCP_ENABLE_INDEXED_SEARCH` | `true` | Enable indexed query path for `search-class-source` |
| `MCP_MAPPING_SOURCE_PRIORITY` | `loom-first` | Mapping source priority (`loom-first` or `maven-first`) |
| `MCP_VERSION_MANIFEST_URL` | Mojang manifest URL | Override manifest endpoint for testing/private mirrors |

### Limits & Tuning

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_MAX_CONTENT_BYTES` | `1000000` | Maximum bytes for file read operations |
| `MCP_MAX_SEARCH_HITS` | `200` | Maximum search result count |
| `MCP_MAX_ARTIFACTS` | `200` | Maximum cached artifacts |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | Maximum total cache size in bytes |
| `MCP_FETCH_TIMEOUT_MS` | `15000` | HTTP request timeout in milliseconds |
| `MCP_FETCH_RETRIES` | `2` | HTTP request retry count |

### Decompilation & Remapping

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_VINEFLOWER_JAR_PATH` | unset | External Vineflower JAR path (auto-downloaded if unset) |
| `MCP_TINY_REMAPPER_JAR_PATH` | unset | External tiny-remapper JAR path (auto-downloaded if unset) |
| `MCP_REMAP_TIMEOUT_MS` | `600000` | Remap operation timeout in milliseconds |
| `MCP_REMAP_MAX_MEMORY_MB` | `4096` | Maximum JVM heap for remap operations |

### NBT

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_MAX_NBT_INPUT_BYTES` | `4194304` | Maximum decoded NBT input bytes accepted by `nbt-to-json` |
| `MCP_MAX_NBT_INFLATED_BYTES` | `16777216` | Maximum gzip-inflated bytes accepted by `nbt-to-json` |
| `MCP_MAX_NBT_RESPONSE_BYTES` | `8388608` | Maximum response payload bytes for NBT tools |

## Architecture

| Component | Technology |
| --- | --- |
| Runtime | Node.js 22+ (native `node:sqlite`) |
| Transport | stdio (MCP standard, auto-detects newline + `Content-Length` framing) |
| Storage | SQLite — artifact metadata, source index, mapping cache |
| Decompilation | [Vineflower](https://github.com/Vineflower/vineflower) (auto-downloaded) |
| Remapping | [tiny-remapper](https://github.com/FabricMC/tiny-remapper) (requires Java) |
| Mapping Sources | Mojang `client_mappings.txt`, Fabric Loom workspace, Maven Tiny v2 |

The server runs as a single long-lived process communicating over stdio. Artifacts (source JARs, binary JARs, mapping files) are downloaded on demand and cached in SQLite. The search index is built lazily on first query and persisted for subsequent calls.

## Development Notes

- `SourceService` is the canonical implementation for artifact resolution, ingestion, and source querying.
- `version` resolution downloads Mojang client JARs into cache and routes them through the same ingestion flow as `jar` and `coordinate` targets.
- Tool responses are always wrapped as `{ result?, error?, meta }`.
- Tool responses also mirror that envelope into MCP `structuredContent`, and failures set `isError=true`.
- `meta` includes `requestId`, `tool`, `durationMs`, and `warnings[]`.

## License

[MIT](LICENSE)
