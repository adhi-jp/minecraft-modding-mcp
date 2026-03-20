# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**[日本語](docs/README-ja.md)** | English

---

`@adhisang/minecraft-modding-mcp` is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants structured access to Minecraft source code, mappings, mod JARs, registry data, and validation workflows.

[MCP](https://modelcontextprotocol.io/) is an open protocol that lets AI assistants call external tools through a structured interface. This server works with Claude Desktop, Claude Code, VS Code, Codex CLI, Gemini CLI, and other MCP-capable clients.

**35 tools** (6 entry + 29 expert) | **7 resources** | **4 namespace mappings** | **SQLite-backed cache**

## Features

- **Source Exploration**: browse and search decompiled Minecraft source code with line-level precision and cursor-paginated file listing
- **Multi-Mapping Conversion**: translate class, field, and method names between `obfuscated`, `mojang`, `intermediary`, and `yarn`
- **Version Comparison**: diff class signatures and registry entries between Minecraft versions
- **Mod JAR Analysis**: extract metadata, dependencies, entrypoints, and Mixin configs from Fabric, Forge, and NeoForge mod JARs
- **Mixin and Access Widener Validation**: validate source and `.accesswidener` files against a target Minecraft version
- **NBT Round-Trip**: decode NBT binary to typed JSON, apply RFC 6902 patches, and encode it back to NBT
- **Registry Data and Runtime Metrics**: query generated registry snapshots and inspect cache and latency counters
- **MCP Resources**: expose versions, class source, artifact metadata, and mappings through URI-based resources

## Quick Start

### Package Users

Requirements:

- Node.js 22+
- Java is only required for `remap-mod-jar` and decompile or remap flows that need Vineflower or tiny-remapper

Start the server locally:

```bash
npx -y @adhisang/minecraft-modding-mcp
```

If automatic JAR downloads are blocked in your environment, set `MCP_VINEFLOWER_JAR_PATH` and `MCP_TINY_REMAPPER_JAR_PATH` in the client configuration.

### Client Setup

CLI clients:

- `Claude Code`: `claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp`
- `OpenAI Codex CLI`: `codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp`

Run `claude mcp list` or `codex mcp list` after registration to verify the server is available.

The stdio transport auto-detects both newline-delimited and `Content-Length` framing, so the same server command works across Codex and standard MCP clients.

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

Then run:

```text
/mcp list
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

## Start Here

These six top-level workflow tools cover the common workflows and return summary-first results, so they are the best default starting points for agents and MCP clients.

| Tool | Start here for |
| --- | --- |
| `inspect-minecraft` | versions, artifacts, classes, files, and source search |
| `analyze-symbol` | symbol existence checks, mapping conversion, lifecycle tracing, and workspace symbol resolution |
| `compare-minecraft` | version-pair diffs, class diffs, registry diffs, and migration-oriented overviews |
| `analyze-mod` | mod metadata, decompile/search flows, class source, and safe remap preview/apply |
| `validate-project` | workspace summaries plus direct Mixin and Access Widener validation |
| `manage-cache` | cache inventory, verification, and preview/apply cleanup workflows |

### Workflow Notes

- These top-level workflow tools return `result.summary` first and include `summary.nextActions` when there is a clear follow-up step.
- `analyze-symbol task="api-overview"` inherits `sourceMapping` as the default `classNameMapping`; it only falls back to `obfuscated` when neither value is provided.
- `get-class-api-matrix` now anchors rows to the explicitly requested `classNameMapping` instead of silently switching back to `obfuscated` when both namespaces are available.
- `find-mapping` accepts short obfuscated class ids such as `dhl` when `sourceMapping="obfuscated"`. Other class-mapping lookups still expect fully-qualified names.
- `trace-symbol-lifecycle` still prefers the separate `descriptor` field for exact lookups, but it now strips an accidental inline signature suffix from `symbol` before splitting `Class.method`.
- `analyze-mod` and `validate-project` still require structured `subject` objects and canonical `include` groups, but stale string-subject or domain-include payloads now return `ERR_INVALID_INPUT` with a retryable `suggestedCall`.
- `validate-mixin` and `validate-project task="project-summary"` now treat empty mixin configs as warning-only discovery results with zero validated classes instead of `ERR_INVALID_INPUT`.
- `search-class-source` defaults to `queryMode="auto"` and keeps separator queries such as `foo.bar`, `foo_bar`, and `foo$bar` on the indexed path. Use `queryMode="literal"` for an explicit full substring scan.
- When a public parameter has a fixed safe default, `tools/list` exposes it through the JSON Schema `default` field.
- Error recovery `suggestedCall` payloads omit parameters when the supplied value already matches the tool default, keeping retry calls smaller without changing behavior.

### Inspect Minecraft source from a version

```json
{
  "tool": "inspect-minecraft",
  "arguments": {
    "task": "class-source",
    "subject": {
      "kind": "class",
      "className": "net.minecraft.server.Main",
      "artifact": {
        "type": "resolve-target",
        "target": {
          "kind": "version",
          "value": "1.21.10"
        }
      }
    }
  }
}
```

### Map or check a symbol

```json
{
  "tool": "analyze-symbol",
  "arguments": {
    "task": "map",
    "subject": {
      "kind": "method",
      "owner": "net.minecraft.server.Main",
      "name": "tickServer"
    },
    "version": "1.21.10",
    "sourceMapping": "mojang",
    "targetMapping": "intermediary",
    "signatureMode": "name-only"
  }
}
```

### Summarize a mod JAR

```json
{
  "tool": "analyze-mod",
  "arguments": {
    "task": "summary",
    "subject": {
      "kind": "jar",
      "jarPath": "/path/to/mymod-1.0.0.jar"
    }
  }
}
```

### Validate a workspace

```json
{
  "tool": "validate-project",
  "arguments": {
    "task": "project-summary",
    "subject": {
      "kind": "workspace",
      "projectPath": "/workspace/modid",
      "discover": ["mixins", "access-wideners"]
    },
    "preferProjectVersion": true,
    "preferProjectMapping": true
  }
}
```

## Documentation

- [Detailed example requests](docs/examples.md)
- [Tool and configuration reference](docs/tool-reference.md)
- [日本語 README](docs/README-ja.md)

## Tool Surface

Start with these top-level workflow tools unless you already know the exact specialized operation you want. The lower-level tools remain available for narrow follow-up work and automation.

### Top-Level Workflow Tools

<!-- BEGIN GENERATED TOOL TABLE: v3-entry-tools -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `inspect-minecraft` | Start from a version, artifact, class, file, search query, or workspace and route to the most relevant Minecraft inspection flow | `task?`, `subject?`, `detail?`, `include?`, `limit?`, `cursor?`, `includeSnapshots?` | `result.summary`, `versions?`, `subject`, `artifact?`, `class?`, `source?`, `members?`, `search?`, `file?`, `files?` |
| `analyze-symbol` | One entry point for symbol existence checks, namespace mapping, lifecycle tracing, workspace symbol analysis, and API overview | `task`, `subject`, `version?`, `sourceMapping?`, `targetMapping?`, `projectPath?`, `classNameMapping?`, `signatureMode?`, `nameMode?`, `includeKinds?`, `maxRows?`, `maxCandidates?`, `detail?`, `include?` | `result.summary`, `match?`, `candidates?`, `ambiguity?`, `matrix?`, `workspace?` |
| `compare-minecraft` | Compare version pairs, class signatures, registries, or produce a migration-oriented overview | `task?`, `subject`, `detail?`, `include?`, `subject.kind="class".sourcePriority?`, `maxClassResults?`, `maxEntriesPerRegistry?`, `includeFullDiff?`, `limit?` | `result.summary`, `comparison`, `classes?`, `classDiff?`, `registry?`, `migration?` |
| `analyze-mod` | Metadata-first entry point for mod summary, decompile/search flows, class source, and safe remap previews/applies | `task`, `subject`, `query?`, `searchType?`, `targetMapping?`, `outputJar?`, `executionMode?`, `includeFiles?`, `maxFiles?`, `maxLines?`, `maxChars?`, `limit?`, `detail?`, `include?` | `result.summary`, `metadata?`, `decompile?`, `hits?`, `source?`, `operation?` |
| `validate-project` | Project-level validation entry for workspace summaries plus direct Mixin and Access Widener validation | `task`, `subject`, `version?`, `mapping?`, `sourcePriority?`, `scope?`, `preferProjectVersion?`, `preferProjectMapping?`, `sourceRoots?`, `configPaths?`, `minSeverity?`, `hideUncertain?`, `explain?`, `warningMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `includeIssues?`, `detail?`, `include?` | `result.summary`, `project`, `workspace?`, `issues?` |
| `manage-cache` | User-facing cache summary, listing, verification, previewed deletion/pruning/rebuild, and explicit apply operations | `action`, `cacheKinds?`, `selector?`, `executionMode?`, `detail?`, `include?`, `limit?`, `cursor?` | `result.summary`, `stats?`, `cacheEntries?`, `operation?`, `meta.pagination.nextCursor?` |
<!-- END GENERATED TOOL TABLE: v3-entry-tools -->

### Source Exploration

Tools for browsing Minecraft versions, resolving source artifacts, and reading or searching decompiled source code.

<!-- BEGIN GENERATED TOOL TABLE: source-exploration -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `list-versions` | List available Minecraft versions from Mojang manifest + local cache | `includeSnapshots?`, `limit?` | `result.latest`, `result.releases[]`, `meta.warnings[]` |
| `resolve-artifact` | Resolve source artifact from `version` / `jar` / `coordinate` | `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `artifactId`, `origin`, `mappingApplied`, `qualityFlags[]`, `artifactContents`, `adjacentSourceCandidates?`, `sampleEntries?`, `warnings[]` |
| `find-class` | Resolve simple or fully-qualified class names inside an artifact | `className`, `artifactId`, `limit?` | `matches[]`, `total`, `warnings[]` |
| `get-class-source` | Get class source by artifact target or resolve target on demand (`mode=metadata` by default) | `className`, `target`, `mode?`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?`, `startLine?`, `endLine?`, `maxLines?`, `maxChars?`, `outputFile?` | `mode`, `sourceText`, `returnedRange`, `truncated`, `charsTruncated?`, `outputFile?`, `artifactId`, `returnedNamespace`, `artifactContents`, mapping/provenance metadata |
| `get-class-members` | Get class fields/methods/constructors from bytecode | `className`, `target`, `mapping?`, `sourcePriority?`, `allowDecompile?`, `access?`, `includeSynthetic?`, `includeInherited?`, `memberPattern?`, `maxMembers?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `strictVersion?` | `members.{constructors,fields,methods}`, `counts`, `truncated`, `context`, `returnedNamespace`, `artifactContents`, `warnings[]` |
| `search-class-source` | Search indexed class source for symbols/text/path | `artifactId`, `query`, `intent?`, `match?`, `packagePrefix?`, `fileGlob?`, `symbolKind?`, `queryMode?`, `limit?`, `cursor?` | `hits[]`, `nextCursor?`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `get-artifact-file` | Read full source file with byte guard | `artifactId`, `filePath`, `maxBytes?` | `content`, `contentBytes`, `truncated`, `mappingApplied`, `returnedNamespace`, `artifactContents` |
| `list-artifact-files` | List indexed source file paths with cursor pagination | `artifactId`, `prefix?`, `limit?`, `cursor?` | `items[]`, `nextCursor?`, `mappingApplied`, `artifactContents`, `warnings[]` |
| `index-artifact` | Rebuild index metadata for an existing artifact | `artifactId`, `force?` | `reindexed`, `reason`, `counts`, `indexedAt`, `durationMs` |
<!-- END GENERATED TOOL TABLE: source-exploration -->

### Version Comparison & Symbol Tracking

Tools for comparing class and registry changes across Minecraft versions and tracing symbol existence over time.

<!-- BEGIN GENERATED TOOL TABLE: version-comparison-symbol-tracking -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `trace-symbol-lifecycle` | Trace when `Class.method` exists across Minecraft versions (`descriptor` omitted = name-only lookup) | `symbol`, `descriptor?`, `fromVersion?`, `toVersion?`, `mapping?`, `sourcePriority?`, `includeSnapshots?`, `maxVersions?`, `includeTimeline?` | `presence.firstSeen`, `presence.lastSeen`, `presence.missingBetween[]`, `presence.existsNow`, `timeline?`, `warnings[]` |
| `diff-class-signatures` | Compare one class between two versions and return member deltas | `className`, `fromVersion`, `toVersion`, `mapping?`, `sourcePriority?`, `includeFullDiff?` | `classChange`, `constructors/methods/fields.{added,removed,modified}`, `modified`, `modified[].{key,changed,from?,to?}`, `summary`, `warnings[]` |
| `compare-versions` | Compare class/registry changes between two versions | `fromVersion`, `toVersion`, `category?`, `packageFilter?`, `maxClassResults?` | `classes`, `registry`, `summary`, `warnings[]` |
<!-- END GENERATED TOOL TABLE: version-comparison-symbol-tracking -->

### Mapping & Symbols

Tools for converting symbol names between namespaces and checking symbol existence.

<!-- BEGIN GENERATED TOOL TABLE: mapping-symbols -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `find-mapping` | Find mapping candidates for class/field/method symbols between namespaces | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `disambiguation?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `ambiguityReasons?`, `provenance?`, `meta.warnings[]` |
| `resolve-method-mapping-exact` | Resolve one method mapping with strict owner+name+descriptor matching | `version`, `name`, `owner`, `descriptor`, `sourceMapping`, `targetMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `provenance?`, `meta.warnings[]` |
| `get-class-api-matrix` | Show one class API as a mapping matrix (`obfuscated/mojang/intermediary/yarn`) | `version`, `className`, `classNameMapping`, `includeKinds?`, `sourcePriority?`, `maxRows?` | `classIdentity`, `rows[]`, `rowCount`, `rowsTruncated?`, `ambiguousRowCount?`, `meta.warnings[]` |
| `resolve-workspace-symbol` | Resolve compile-visible symbol names for a Gradle workspace (`build.gradle/.kts`) | `projectPath`, `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `workspaceDetection`, `meta.warnings[]` |
| `check-symbol-exists` | Strict symbol presence check for class/field/method | `version`, `kind`, `name`, `owner?`, `descriptor?`, `sourceMapping`, `sourcePriority?`, `nameMode?`, `signatureMode?`, `maxCandidates?` | `querySymbol`, `mappingContext`, `resolved`, `status`, `resolvedSymbol?`, `candidates[]`, `candidateCount`, `candidatesTruncated?`, `meta.warnings[]` |
<!-- END GENERATED TOOL TABLE: mapping-symbols -->

### NBT Utilities

Tools for decoding, patching, and encoding Java Edition NBT binary data using a typed JSON representation.

<!-- BEGIN GENERATED TOOL TABLE: nbt-utilities -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `nbt-to-json` | Decode Java Edition NBT binary (`base64`) to typed JSON | `nbtBase64`, `compression?` (`none`, `gzip`, `auto`) | `typedJson`, `meta.compressionDetected`, `meta.inputBytes` |
| `nbt-apply-json-patch` | Apply RFC 6902 patch (`add/remove/replace/test`) to typed NBT JSON | `typedJson`, `patch` | `typedJson`, `meta.appliedOps`, `meta.testOps`, `meta.changed` |
| `json-to-nbt` | Encode typed JSON back to Java Edition NBT binary (`base64`) | `typedJson`, `compression?` (`none`, `gzip`) | `nbtBase64`, `meta.outputBytes`, `meta.compressionApplied` |
<!-- END GENERATED TOOL TABLE: nbt-utilities -->

### Mod Analysis

Tools for extracting metadata from mod JARs, decompiling mod source, searching mod code, and remapping mod namespaces.

<!-- BEGIN GENERATED TOOL TABLE: mod-analysis -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `analyze-mod-jar` | Extract mod metadata/dependencies/entrypoints from mod JAR | `jarPath`, `includeClasses?` | `modId`, `loader`, `jarKind`, `dependencies`, `entrypoints`, `mixinConfigs`, class stats |
| `decompile-mod-jar` | Decompile mod JAR and optionally return one class source | `jarPath`, `className?`, `includeFiles?`, `maxFiles?` | `outputDir`, `fileCount`, `files?`, `returnedFileCount?`, `filesTruncated?`, `filesOmitted?`, `source?`, `warnings[]` |
| `get-mod-class-source` | Read one class source from decompiled mod cache | `jarPath`, `className`, `maxLines?`, `maxChars?`, `outputFile?` | `className`, `content`, `totalLines`, `truncated?`, `charsTruncated?`, `outputFilePath?`, `warnings[]` |
| `search-mod-source` | Search decompiled mod source by class/method/field/content | `jarPath`, `query`, `searchType?`, `limit?` | `hits[]`, `totalHits`, `truncated`, `warnings[]` |
| `remap-mod-jar` | Remap a Fabric/Quilt mod JAR to yarn/mojang names; Mojang-mapped inputs are copied for `targetMapping="mojang"` | `inputJar`, `targetMapping`, `mcVersion?`, `outputJar?` | `outputJar`, `mcVersion`, `fromMapping`, `targetMapping`, `resolvedTargetNamespace`, `warnings[]` |
<!-- END GENERATED TOOL TABLE: mod-analysis -->

### Validation

Tools for validating Mixin source and Access Widener files against a target Minecraft version.

<!-- BEGIN GENERATED TOOL TABLE: validation -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `validate-mixin` | Parse/validate Mixin source against target Minecraft version | `input`, `sourceRoots?`, `version`, `mapping?`, `sourcePriority?`, `projectPath?`, `scope?`, `preferProjectVersion?`, `minSeverity?`, `hideUncertain?`, `warningMode?`, `preferProjectMapping?`, `reportMode?`, `warningCategoryFilter?`, `treatInfoAsWarning?`, `explain?`, `includeIssues?` | `mode`, `results[].validationStatus`, `summary.partial`, `issueSummary?`, `provenance?`, `incompleteReasons?`, `toolHealth?`, `confidenceScore?`, `confidenceBreakdown?` |
| `validate-access-widener` | Parse/validate Access Widener content against target version | `content`, `version`, `mapping?`, `sourcePriority?` | `valid`, `issues[]`, `warnings[]`, `summary` |
<!-- END GENERATED TOOL TABLE: validation -->

### Registry & Diagnostics

Tools for querying generated registry data and inspecting server runtime state.

<!-- BEGIN GENERATED TOOL TABLE: registry-diagnostics -->
| Tool | Purpose | Key Inputs | Key Outputs |
| --- | --- | --- | --- |
| `get-registry-data` | Get generated registry snapshots (blocks/items/entities etc.) | `version`, `registry?`, `includeData?`, `maxEntriesPerRegistry?` | `registries`, `data?`, `entryCount`, `returnedEntryCount?`, `registryEntryCounts?`, `dataTruncated?`, `warnings[]` |
| `get-runtime-metrics` | Inspect runtime counters and latency snapshots | none | `result.*` runtime metrics, `meta` envelope |
<!-- END GENERATED TOOL TABLE: registry-diagnostics -->

Detailed parameter constraints, migration notes, resource behavior, and the full environment-variable matrix live in [docs/tool-reference.md](docs/tool-reference.md).

## Resources

Fixed resources:

- `mc://versions/list`
- `mc://metrics`

Template resources:

- `mc://source/{artifactId}/{className}`
- `mc://artifact/{artifactId}/files/{filePath}`
- `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}`
- `mc://artifact/{artifactId}/members/{className}`
- `mc://artifact/{artifactId}`

See [docs/tool-reference.md#resources](docs/tool-reference.md#resources) for the full resource table and response behavior.

## Response Model

Tools and JSON resources return the standard `{ result?, error?, meta }` envelope. Text resources (`class-source` and `artifact-file`) return raw text on success and structured JSON on failure.

See [docs/tool-reference.md#response-envelope](docs/tool-reference.md#response-envelope) for the exact envelope fields and error shape.

## Common Environment Variables

These are the most commonly changed settings. For the full supported list, see [docs/tool-reference.md#environment-variables](docs/tool-reference.md#environment-variables).

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | Cache root for downloads and SQLite |
| `MCP_SOURCE_REPOS` | Maven Central + Fabric + Forge + NeoForge | Comma-separated Maven repository URLs |
| `MCP_MAPPING_SOURCE_PRIORITY` | `loom-first` | Mapping source priority (`loom-first` or `maven-first`) |
| `MCP_ENABLE_INDEXED_SEARCH` | `true` | Enable indexed search for `search-class-source` |
| `MCP_VINEFLOWER_JAR_PATH` | unset | Override the Vineflower JAR path |
| `MCP_TINY_REMAPPER_JAR_PATH` | unset | Override the tiny-remapper JAR path |
| `MCP_MAX_SEARCH_HITS` | `200` | Maximum search result count |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | Maximum total cache size in bytes |

## Development

Repository requirements:

- Node.js 22+
- `pnpm`
- Java when running remap or decompile flows locally

Setup and run the repository:

```bash
pnpm install
pnpm dev
```

Build the packaged shape:

```bash
pnpm build
pnpm start
```

Always run:

```bash
pnpm check
pnpm test
```

Run these when relevant:

- `pnpm test:manual:stdio-smoke` for MCP transport, registration, or manual workflow changes
- `pnpm test:manual:package-smoke` when checking packaged install and distribution behavior
- `pnpm test:perf` for search, index, or performance-sensitive changes
- `pnpm test:coverage` or `pnpm test:coverage:lcov` for coverage checks (`lines=80`, `branches=70`, `functions=80`)
- `pnpm validate` for the full local validation suite

## License

[MIT](LICENSE)
