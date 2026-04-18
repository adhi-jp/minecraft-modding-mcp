# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**English** | [日本語](docs/README-ja.md)

> **Note**: This project is entirely vibe-coded — built with AI-assisted development without formal specs.

---

`@adhisang/minecraft-modding-mcp` is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants structured access to Minecraft source code, mappings, mod JARs, registry data, and validation workflows. It works with Claude Desktop, Claude Code, VS Code, Codex CLI, Gemini CLI, and other MCP-capable clients.

**36 tools** (6 entry + 30 expert) | **7 resources** | **4 namespace mappings** | **SQLite-backed cache**

## Features

- **Source Exploration**: browse and search decompiled Minecraft source code with line-level precision and cursor-paginated file listing
- **Multi-Mapping Conversion**: translate class, field, and method names between `obfuscated`, `mojang`, `intermediary`, and `yarn`
- **Version Comparison**: diff class signatures and registry entries between Minecraft versions
- **Mod JAR Analysis**: extract metadata, dependencies, entrypoints, Mixin configs, and packaged Access Transformer paths from Fabric, Forge, and NeoForge mod JARs
- **Mixin, Access Widener, and Access Transformer Validation**: validate source, `.accesswidener`, and Forge/NeoForge access transformer files against a target Minecraft version
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

Claude Code:

```bash
claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

OpenAI Codex CLI:

```bash
codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

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

All six return `result.summary` first, and can include `summary.nextActions` when there is a clear follow-up step. Use the table for tool selection, then use the examples and reference docs for exact payloads.

| Tool | Start here for |
| --- | --- |
| `inspect-minecraft` | versions, artifacts, classes, files, and source search |
| `analyze-symbol` | symbol existence checks, mapping conversion, lifecycle tracing, and workspace symbol resolution |
| `compare-minecraft` | version-pair diffs, class diffs, registry diffs, and migration-oriented overviews |
| `analyze-mod` | mod metadata, decompile/search flows, class source, and safe remap preview/apply |
| `validate-project` | workspace summaries plus direct Mixin, Access Widener, and Access Transformer validation |
| `manage-cache` | cache inventory, verification, and preview/apply cleanup workflows |

### Workflow Notes

Keep only the high-frequency notes here. For the full pitfall list, exact contract details, migration notes, and environment variables, see [docs/tool-reference.md](docs/tool-reference.md).

- `search-class-source` defaults to `queryMode="auto"` and keeps separator queries such as `foo.bar`, `foo_bar`, and `foo$bar` on the indexed path. Use `queryMode="literal"` for an explicit full substring scan.
- If you do not already have an artifact, prefer `subject.kind="workspace"` for `inspect-minecraft` instead of guessing artifact details. When artifact context is the only missing input, a retryable `suggestedCall` preserves the requested task.
- `trace-symbol-lifecycle` expects `Class.method` in `symbol`. Keep exact overload matching in the separate `descriptor` field.
- For unobfuscated releases such as `26.1+`, `check-symbol-exists` and `analyze-symbol task="exists"` validate `mojang` lookups against runtime bytecode when no mapping graph exists, and return `mapping_unavailable` when the runtime JAR itself is unreachable.
- `analyze-mod` and `validate-project` require structured `subject` objects and canonical `include` groups; stale string-subject or domain-include payloads return `ERR_INVALID_INPUT` with a retryable `suggestedCall`.
- `validate-project task="project-summary"` propagates `preferProjectVersion=true` across discovered Mixin, Access Widener, and Access Transformer checks. When no version can be resolved from the request or `gradle.properties`, the summary blocks with version-agnostic recovery guidance.

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
      "discover": ["mixins", "access-wideners", "access-transformers"]
    },
    "preferProjectVersion": true,
    "preferProjectMapping": true
  }
}
```

Workspace summaries still default to discovering mixins and access wideners. Add `"access-transformers"` to `subject.discover` when you want Access Transformer files included in the summary run.

## Documentation

- [Detailed example requests](docs/examples.md) for copyable payloads and common workflows
- [Tool and configuration reference](docs/tool-reference.md) for exact inputs, outputs, resource behavior, environment variables, and migration notes — start with the [Which Tool for Which Question](docs/tool-reference.md#which-tool-for-which-question) decision table when you are not sure which tool to call
- [日本語 README](docs/README-ja.md) for a Japanese onboarding overview

## Tool Surface

Start with these top-level workflow tools unless you already know the exact specialized operation you want. The lower-level tools remain available for narrow follow-up work and automation.

### Top-Level Workflow Tools

<!-- BEGIN GENERATED TOOL TABLE: v3-entry-tools -->
| Tool | Purpose |
| --- | --- |
| `inspect-minecraft` | Inspect versions, artifacts, classes, files, source text, and workspace-aware lookup flows |
| `analyze-symbol` | Handle symbol existence checks, namespace mapping, lifecycle tracing, workspace symbol resolution, and API overviews |
| `compare-minecraft` | Compare version pairs, class diffs, registry diffs, and migration-oriented summaries |
| `analyze-mod` | Summarize mod metadata, decompile and search mod code, inspect class source, and preview or apply remaps |
| `validate-project` | Summarize workspaces and run direct Mixin, Access Widener, or Access Transformer validation |
| `manage-cache` | List, verify, and preview or apply cache cleanup and rebuild operations |
<!-- END GENERATED TOOL TABLE: v3-entry-tools -->

### Source Exploration

Tools for browsing Minecraft versions, resolving source artifacts, and reading or searching decompiled source code.

<!-- BEGIN GENERATED TOOL TABLE: source-exploration -->
| Tool | Purpose |
| --- | --- |
| `list-versions` | List available Minecraft versions from Mojang metadata and local cache |
| `resolve-artifact` | Resolve source artifacts from versions, JAR paths, or Maven coordinates |
| `find-class` | Find simple or fully-qualified class names inside an artifact |
| `get-class-source` | Read class source from an artifact or resolve the backing artifact on demand |
| `get-class-members` | List constructors, fields, and methods from bytecode |
| `search-class-source` | Search indexed class source by symbol, text, or path |
| `get-artifact-file` | Read a full source file with a byte limit |
| `list-artifact-files` | List indexed source file paths with cursor pagination |
| `index-artifact` | Rebuild indexed metadata for an existing artifact |
<!-- END GENERATED TOOL TABLE: source-exploration -->

For unobfuscated releases such as `26.1+`, `mapping="mojang"` uses the runtime/decompile path directly and skips Loom source-jar discovery, while `intermediary` and `yarn` fall back to `obfuscated` with a warning.

### Version Comparison & Symbol Tracking

Tools for comparing class and registry changes across Minecraft versions and tracing symbol existence over time.

<!-- BEGIN GENERATED TOOL TABLE: version-comparison-symbol-tracking -->
| Tool | Purpose |
| --- | --- |
| `trace-symbol-lifecycle` | Trace when `Class.method` exists across Minecraft versions |
| `diff-class-signatures` | Compare one class across two versions and return member deltas |
| `compare-versions` | Compare class and registry changes between two versions |
<!-- END GENERATED TOOL TABLE: version-comparison-symbol-tracking -->

### Mapping & Symbols

Tools for converting symbol names between namespaces and checking symbol existence.

<!-- BEGIN GENERATED TOOL TABLE: mapping-symbols -->
| Tool | Purpose |
| --- | --- |
| `find-mapping` | Look up mapping candidates for class, field, or method symbols |
| `resolve-method-mapping-exact` | Resolve one method mapping with strict owner, name, and descriptor matching |
| `get-class-api-matrix` | Show one class API across `obfuscated`, `mojang`, `intermediary`, and `yarn` |
| `resolve-workspace-symbol` | Resolve compile-visible symbol names from a Gradle workspace |
| `check-symbol-exists` | Check whether a class, field, or method exists in a namespace |
<!-- END GENERATED TOOL TABLE: mapping-symbols -->

`resolve-artifact`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, and `check-symbol-exists` default `compact` to `true`: empty fields are stripped, `resolve-artifact` omits diagnostic fields (`provenance`, `artifactContents`, etc.), and mapping tools omit the redundant `candidates` array on full-confidence exact matches and slim the tail to `{kind, symbol, owner, name, descriptor, confidence, matchKind}` (signalled by `candidateDetailsTruncated`) for unresolved results with more than three candidates. Pass `compact: false` for the full diagnostic shape.

`get-class-source`, `get-class-members`, `search-class-source`, and `list-artifact-files` accept the same `compact` parameter as opt-in (default `false`). When enabled it strips `provenance`, `artifactContents`, `qualityFlags`, and (for `get-class-members`) `context`, while preserving primary payloads (`sourceText`, `members`/`counts`, `hits`, `items`). See [docs/tool-reference.md](docs/tool-reference.md) for the full per-tool field list.

### NBT Utilities

Tools for decoding, patching, and encoding Java Edition NBT binary data using a typed JSON representation.

<!-- BEGIN GENERATED TOOL TABLE: nbt-utilities -->
| Tool | Purpose |
| --- | --- |
| `nbt-to-json` | Decode Java Edition NBT binary payloads into typed JSON |
| `nbt-apply-json-patch` | Apply RFC 6902 patches to typed NBT JSON |
| `json-to-nbt` | Encode typed JSON back to Java Edition NBT binary |
<!-- END GENERATED TOOL TABLE: nbt-utilities -->

### Mod Analysis

Tools for extracting metadata from mod JARs, decompiling mod source, searching mod code, and remapping mod namespaces.

<!-- BEGIN GENERATED TOOL TABLE: mod-analysis -->
| Tool | Purpose |
| --- | --- |
| `analyze-mod-jar` | Extract mod metadata, dependencies, entrypoints, mixin config info, and packaged access transformer paths from a JAR |
| `decompile-mod-jar` | Decompile a mod JAR and optionally return one class source |
| `get-mod-class-source` | Read one class source from the decompiled mod cache |
| `search-mod-source` | Search decompiled mod source by class, method, field, or content |
| `remap-mod-jar` | Remap a Fabric or Quilt mod JAR to `yarn` or `mojang` names |
<!-- END GENERATED TOOL TABLE: mod-analysis -->

### Validation

Tools for validating Mixin source, Access Widener files, and Forge/NeoForge Access Transformer files against a target Minecraft version. `validate-access-widener` defaults to vanilla bytecode validation; pass `projectPath`, `scope`, and `preferProjectVersion` for runtime-aware mode, which returns runtime `provenance` plus per-entry `resolvedRuntimeAccess` evidence. `validate-access-transformer` infers `atNamespace` from Forge/NeoForge workspace context when `projectPath` is provided and uses loader runtime artifacts for `scope="loader"`.

<!-- BEGIN GENERATED TOOL TABLE: validation -->
| Tool | Purpose |
| --- | --- |
| `validate-mixin` | Validate Mixin source against a target Minecraft version |
| `validate-access-widener` | Validate Access Widener content against a target Minecraft version, optionally using runtime-aware Loom artifacts |
| `validate-access-transformer` | Validate Access Transformer content against a target Minecraft version, optionally using Forge/NeoForge runtime artifacts |
<!-- END GENERATED TOOL TABLE: validation -->

### Registry & Diagnostics

Tools for querying generated registry data and inspecting server runtime state.

<!-- BEGIN GENERATED TOOL TABLE: registry-diagnostics -->
| Tool | Purpose |
| --- | --- |
| `get-registry-data` | Read generated registry snapshots and optionally include entry data |
| `get-runtime-metrics` | Inspect runtime metrics and latency snapshots |
<!-- END GENERATED TOOL TABLE: registry-diagnostics -->

Detailed parameter constraints, migration notes, resource behavior, and the full environment-variable matrix live in [docs/tool-reference.md](docs/tool-reference.md).

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
