# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**English** | [日本語](docs/README-ja.md)

> **Note**: This project is entirely vibe-coded — built with AI-assisted development without formal specs.

---

`@adhisang/minecraft-modding-mcp` is an MCP server for AI-assisted Minecraft modding workflows, built on the [Model Context Protocol](https://modelcontextprotocol.io/). Use it when an agent needs to inspect Minecraft source, resolve mappings, compare versions, analyze mod JARs, validate Mixin, Access Widener, or Access Transformer files, or work with NBT and registry data from an MCP client.

It runs over stdio and works with Claude Desktop, Claude Code, VS Code, Codex CLI, Gemini CLI, and other MCP-capable clients.

**41 tools** (6 entry + 35 expert) | **9 resources** | **4 namespace mappings** | **SQLite-backed cache**

## Features

- **Source exploration**: browse, list, and search decompiled Minecraft source with line-level context
- **Mapping-aware symbol work**: convert class, field, and method names between `obfuscated`, `mojang`, `intermediary`, and `yarn`
- **Version comparison**: compare class signatures, registry entries, and migration-oriented summaries across Minecraft versions
- **Mod JAR analysis**: read Fabric, Forge, and NeoForge metadata, entrypoints, Mixin configs, dependencies, source, and remap previews
- **Project validation**: validate Mixin source, `.accesswidener` files, and Forge/NeoForge Access Transformer files against the target version
- **NBT, registry, cache, and diagnostics**: patch NBT payloads, inspect generated registry data, and manage cache/runtime state
- **MCP resources**: expose versions, class source, artifact metadata, and mappings through URI-based resources

## Quick Start

### Package Users

Requirements:

- Node.js 22+
- Java is only required for `remap-mod-jar` and decompile or remap flows that need Vineflower or tiny-remapper

Start the server locally:

```bash
npx -y @adhisang/minecraft-modding-mcp
```

Use this same command in MCP client configs. If automatic JAR downloads are blocked in your environment, set `MCP_VINEFLOWER_JAR_PATH` and `MCP_TINY_REMAPPER_JAR_PATH` there.

### Client Setup

CLI clients can register the package command directly.

Claude Code:

```bash
claude mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

OpenAI Codex CLI:

```bash
codex mcp add minecraft-modding -- npx -y @adhisang/minecraft-modding-mcp
```

Run `claude mcp list` or `codex mcp list` after registration to verify the server is available.

The stdio transport auto-detects newline-delimited and `Content-Length` framing, so the same server command works across Codex and standard MCP clients.

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

When a build used a non-default Gradle User Home, pass `gradleUserHome` on cache-backed source, mapping, validation, and workflow calls. The server treats it as a per-call Gradle User Home and searches `<gradleUserHome>/loom-cache` and `<gradleUserHome>/caches/fabric-loom` before the MCP process default. It does not accept arbitrary Loom cache directories.

## Start Here

These six top-level workflow tools cover the common paths and return summary-first results. They are the best default starting points for agents and MCP clients.

All six return `result.summary` first and can include `summary.nextActions` when there is a clear follow-up step. Pick the tool from the table, then use the examples and reference docs for exact payloads.

| Tool | Start here for |
| --- | --- |
| `inspect-minecraft` | versions, artifacts, classes, files, and source search |
| `analyze-symbol` | symbol existence checks, mapping conversion, lifecycle tracing, and workspace symbol resolution |
| `compare-minecraft` | version-pair diffs, class diffs, registry diffs, and migration-oriented overviews |
| `analyze-mod` | mod metadata, decompile/search flows, class source, bytecode member queries, and safe remap preview/apply |
| `validate-project` | workspace summaries plus direct Mixin, Access Widener, and Access Transformer validation |
| `manage-cache` | cache inventory, verification, and preview/apply cleanup workflows |

### Workflow Notes

These notes cover high-frequency decisions during onboarding. For the full pitfall list, exact contracts, migration notes, and environment variables, see [docs/tool-reference.md](docs/tool-reference.md).

- `search-class-source` defaults to `queryMode="auto"` and keeps separator queries such as `foo.bar`, `foo_bar`, and `foo$bar` on the indexed path. Use `queryMode="literal"` for an explicit full substring scan.
- If you do not already have an artifact, prefer `subject.kind="workspace"` for `inspect-minecraft` instead of guessing artifact details. `subject.focus` is an object, not a string: use `{ "kind": "class", "className": "..." }`, `{ "kind": "search", "query": "..." }`, or `{ "kind": "file", "filePath": "..." }`. `task="auto"` dispatches only from `subject.kind` and `focus.kind`; it is not a natural-language planner. Invalid string focus returns class/search/file `exampleCalls`, while missing artifact context keeps the requested task in a retryable `suggestedCall`.
- `trace-symbol-lifecycle` expects `Class.method` in `symbol`. Keep exact overload matching in the separate `descriptor` field.
- For unobfuscated releases such as `26.1+`, `check-symbol-exists` and `analyze-symbol task="exists"` validate `mojang` lookups against runtime bytecode when no mapping graph exists, and return `mapping_unavailable` when the runtime JAR itself is unreachable.
- `analyze-mod` and `validate-project` require structured `subject` objects and canonical `include` groups; stale string-subject or domain-include payloads return `ERR_INVALID_INPUT` with a retryable `suggestedCall`.
- `validate-project task="project-summary"` propagates `preferProjectVersion=true` across discovered Mixin, Access Widener, and Access Transformer checks. If no version can be resolved from the request or `gradle.properties`, the summary returns recovery guidance instead of guessing.
- `validate-mixin` and `validate-project` keep `mapping-health` lightweight for `obfuscated` and `mojang` validation, avoiding full Tiny mapping graph loads unless `intermediary` or `yarn` namespaces are requested.
- `validate-project task="project-summary"` uses a lightweight artifact probe for `tasks["minecraft.artifact.resolved"]`; it does not decompile Minecraft or rebuild the source index just to report per-probe status. Set `VALIDATE_PROJECT_TASKS_OFF=1` to omit the additive `tasks` field.
- `validate-project` has a supervisor-owned end-to-end deadline of 120 seconds, including queue time. Set `MCP_VALIDATE_PROJECT_TIMEOUT_MS` to an ASCII-decimal value from `10000` through `600000` to override it. A timeout returns `ERR_TOOL_TIMEOUT`; a running timeout restarts the isolated worker before queued calls resume, while a queue timeout leaves the current worker untouched.
- Queued calls resume only after the replacement worker completes initialization replay. If replacement startup or replay fails, queued tool calls terminate with `ERR_WORKER_RESTART` instead of waiting indefinitely. If unresolved process-tree cleanup fills the supervisor's two live-generation slots, new requests fail with the existing restart envelope and unavailable notifications are warning-dropped until cleanup or reconnect. On POSIX, an already-gone process group counts as cleaned up rather than leaving a stale cleanup token.
- If a workspace was built with `GRADLE_USER_HOME=/tmp/...` or another isolated Gradle home, pass that path as `gradleUserHome` so source, mapping, runtime, and project validation lookups use the same Loom cache instead of stale caches under the MCP process home.
- `manage-cache` reports corrupt Mojang binary-remap cache directories under `cacheKinds: ["binary-remap"]` with `status: "corrupt"`, and can delete them by `selector.artifactId` in preview/apply workflows.

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
    "signatureMode": "name-only",
    "detail": "standard"
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
- [Tool and configuration reference](docs/tool-reference.md) for exact inputs, outputs, resource behavior, environment variables, and migration notes. Start with the [Which Tool for Which Question](docs/tool-reference.md#which-tool-for-which-question) decision table when you are not sure which tool to call.
- [日本語 README](docs/README-ja.md) for a Japanese onboarding overview

## Tool Surface

Start with these top-level workflow tools unless you already know the exact specialized operation you want. The lower-level tools remain available for narrow follow-up work and automation.

### Top-Level Workflow Tools

<!-- BEGIN GENERATED TOOL TABLE: top-level-workflow-tools -->
| Tool | Purpose |
| --- | --- |
| `inspect-minecraft` | Inspect versions, artifacts, classes, files, source text, and workspace-aware lookup flows |
| `analyze-symbol` | Handle symbol existence checks, namespace mapping, lifecycle tracing, workspace symbol resolution, and API overviews |
| `compare-minecraft` | Compare version pairs, class diffs, registry diffs, and migration-oriented summaries |
| `analyze-mod` | Summarize mod metadata, decompile and search mod code, inspect class source, read class members from bytecode, and preview or apply remaps |
| `validate-project` | Summarize workspaces and run direct Mixin, Access Widener, or Access Transformer validation |
| `manage-cache` | List, verify, and preview or apply cache cleanup and rebuild operations |
<!-- END GENERATED TOOL TABLE: top-level-workflow-tools -->

### Source Exploration

Tools for browsing Minecraft versions, resolving source artifacts, and reading or searching decompiled source code.

<!-- BEGIN GENERATED TOOL TABLE: source-exploration -->
| Tool | Purpose |
| --- | --- |
| `list-versions` | List available Minecraft versions from Mojang metadata and local cache |
| `resolve-artifact` | Resolve source artifacts from versions, JAR paths, or Maven coordinates |
| `find-class` | Find simple or fully-qualified class names, including classes bundled in nested JARs |
| `get-class-source` | Read class source from an artifact or resolve the backing artifact on demand |
| `get-class-members` | List constructors, fields, and methods from bytecode |
| `search-class-source` | Search indexed class source by symbol, text, or path |
| `get-artifact-file` | Read a full source file with a byte limit |
| `list-artifact-files` | List indexed source file paths with cursor pagination |
| `index-artifact` | Rebuild indexed metadata for an existing artifact |
<!-- END GENERATED TOOL TABLE: source-exploration -->

`find-class` accepts either an `artifactId` or the shared object `target` shape. For a workspace-relative dependency, pass `target: { kind: "dependency", group, name, versionFromProject: true }` with top-level `projectPath`. Fabric-style umbrella JARs are searched through their nested `.class` inventories; a top-level class match can then be passed to `get-class-source` or `get-class-members`, which resolve the containing nested JAR. Dotted inner-class matches are also readable through `get-class-source`. An empty result still means that the requested class name is absent from the resolved dependency version.

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
| `resolve-method-mapping-exact` | Strict shortcut for `find-mapping` (kind=method, signatureMode=exact); requires the full owner+name+descriptor triple |
| `get-class-api-matrix` | Show one class API across `obfuscated`, `mojang`, `intermediary`, and `yarn` |
| `resolve-workspace-symbol` | Resolve compile-visible symbol names from a Gradle workspace |
| `check-symbol-exists` | Check whether a class, field, or method exists in a namespace |
<!-- END GENERATED TOOL TABLE: mapping-symbols -->

Expert and batch tools share the `detail` (`summary` | `standard` | `full`) + `include[]` response contract for shorter responses (replacing the old per-tool `compact` flag). See [docs/tool-reference.md](docs/tool-reference.md) for per-tool defaults and the full field list.

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

Tools for validating Mixin source, Access Widener files, and Forge/NeoForge Access Transformer files against a target Minecraft version. Workspace options let validation use loader/runtime context when a project path is available.

<!-- BEGIN GENERATED TOOL TABLE: validation -->
| Tool | Purpose |
| --- | --- |
| `validate-mixin` | Validate Mixin source against a target Minecraft version (returns `validationStatus: "partial"` with `targetOutcomes` when a stage budget defers work) |
| `validate-access-widener` | Validate Access Widener content against a target Minecraft version, optionally using runtime-aware Loom artifacts |
| `validate-access-transformer` | Validate Access Transformer content against a target Minecraft version, optionally using Forge/NeoForge runtime artifacts |
| `verify-mixin-target` | Single-call probe for owner / member existence with `@Shadow` / `@Accessor` / `@Invoker` advice |
<!-- END GENERATED TOOL TABLE: validation -->

### Registry & Diagnostics

Tools for querying generated registry data and inspecting server runtime state.

<!-- BEGIN GENERATED TOOL TABLE: registry-diagnostics -->
| Tool | Purpose |
| --- | --- |
| `get-registry-data` | Read generated registry snapshots and optionally include entry data |
| `get-runtime-metrics` | Inspect runtime metrics and latency snapshots |
<!-- END GENERATED TOOL TABLE: registry-diagnostics -->

### Batch Lookup

Tools that share one resolved artifact or Minecraft version across a fixed shortlist. Results include one status per item plus an aggregate `summary`. See [Batch lookup contract](docs/tool-reference.md#batch-lookup-contract) for failure handling and retry mapping.

Within one MCP server process, batch class lookups that need the same binary fallback share one in-flight source indexing/decompile rebuild for that artifact.

<!-- BEGIN GENERATED TOOL TABLE: batch-lookup -->
| Tool | Purpose |
| --- | --- |
| `batch-class-source` | Read source for many classes against one shared resolved artifact (1..50 entries per call) |
| `batch-class-members` | List members for many classes against one shared resolved artifact (1..50 entries per call) |
| `batch-symbol-exists` | Probe symbol existence for many entries against one shared Minecraft-version artifact (workspace / version targets only) |
| `batch-mappings` | Translate many symbols across mapping namespaces with one shared Minecraft version (no shared artifact) |
<!-- END GENERATED TOOL TABLE: batch-lookup -->

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
