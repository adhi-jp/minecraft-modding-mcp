# @adhisang/minecraft-modding-mcp

[![npm](https://img.shields.io/npm/v/@adhisang/minecraft-modding-mcp)](https://www.npmjs.com/package/@adhisang/minecraft-modding-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adhi-jp/minecraft-modding-mcp/actions/workflows/ci.yml)

**English** | [日本語](docs/README-ja.md)

> **Note**: This project is entirely vibe-coded — built with AI-assisted development without formal specs.

---

`@adhisang/minecraft-modding-mcp` is an MCP server for AI-assisted Minecraft modding workflows, built on the [Model Context Protocol](https://modelcontextprotocol.io/). Use it when an agent needs to inspect Minecraft source, resolve mappings, compare versions, analyze mod JARs, validate Mixin, Access Widener, or Access Transformer files, or work with NBT and registry data from an MCP client.

It runs over stdio and works with Claude Desktop, Claude Code, VS Code, Codex CLI, Gemini CLI, and other MCP-capable clients.

**29 catalog tools** + **41 deprecated 8.x tools** | **9 resources** | **4 namespace mappings** | **SQLite-backed cache**

## Features

- **Source exploration**: browse, list, and search decompiled Minecraft source with line-level context
- **Mapping-aware symbol work**: convert class, field, and method names between `obfuscated`, `mojang`, `intermediary`, and `yarn`
- **Version comparison**: compare class signatures, registry entries, and migration-oriented summaries across Minecraft versions
- **Mod JAR analysis**: read Fabric, Forge, and NeoForge metadata, entrypoints, Mixin configs, dependencies, source, and remap previews
- **Project validation**: validate Mixin source, `.accesswidener` files, and Forge/NeoForge Access Transformer files against the target version
- **NBT, registry, cache, and diagnostics**: patch NBT payloads, inspect generated registry data, and manage cache/runtime state
- **MCP resources**: expose versions, class source, artifact metadata, and mappings through URI-based resources

## Protocol Support

The server implements MCP protocol revision `2026-07-28` and keeps the legacy initialize-based protocol (`2025-11-25` back through `2024-10-07`) fully supported in the same binary — no configuration needed:

- **Legacy clients** initialize as before and get the same tools and response envelopes as modern clients; the legacy wire stays byte-compatible with the SDK v1 server except for a short list of recorded deviations (see the legacy-exceptions list in [docs/tool-reference.md → MCP Protocol Support](docs/tool-reference.md#mcp-protocol-support)).
- **Modern clients** (2026-07-28) skip `initialize`, probe with `server/discover`, and send per-request `io.modelcontextprotocol/*` `_meta`. Modern results carry `resultType` and the server identity echo; the cacheable methods additionally carry cache metadata (`ttlMs` / `cacheScope`).
- One stdio process serves one era, selected by the client's first signal; the selection persists across the server's internal worker restarts.
- Both eras receive the same short primer for AI agents as MCP `instructions` (in the `initialize` and `server/discover` results): how the catalog tools, `target`, `mapping` and the `{ result, meta }` replies work, and, while the 8.x tools are served, that they are deprecated aliases. See [docs/tool-reference.md → Tool catalog](docs/tool-reference.md#tool-catalog).

Wire-level details — era selection, the rejection and version-negotiation tables, cache values, and framing — are in [docs/tool-reference.md → MCP Protocol Support](docs/tool-reference.md#mcp-protocol-support).

## Quick Start

### Package Users

Requirements:

- Node.js 22.13.0+
- Java 17+ on `PATH` for decompile and remap flows: reading Minecraft source for a version that has no Loom sources jar, decompiling mod JARs, and `mod-remap` (8.x: `remap-mod-jar`). The default Vineflower needs Java 17; the server checks only that `java` runs, not its version. `registry-read` and registry comparisons in `version-compare` (with the 8.x tools, `get-registry-data` and registry diffs in `compare-versions` and `compare-minecraft`) run the Minecraft server's data generator, so they need the Java version that Minecraft release requires (Java 21 for 1.21.x).

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

When a build used a non-default Gradle User Home, pass `gradleUserHome` to `artifact-resolve` and reuse the returned `artifactId` (the deprecated 8.x tools take it on their cache-backed calls). The server treats it as a per-call Gradle User Home and searches `<gradleUserHome>/loom-cache` and `<gradleUserHome>/caches/fabric-loom` instead of the MCP process's Gradle User Home; project-local roots under `projectPath` still apply. It does not accept arbitrary Loom cache directories.

## Start Here

Start with the catalog tools. Each answers one kind of question, all of them share one request vocabulary (`target`, `mapping`, `detail`), and every reply is `{ result, meta }` or `{ error, meta }`, with follow-up calls in `meta.nextActions` and warnings in `meta.warnings`. Pick the tool from the table, then use the examples and reference docs for exact payloads; [Tool Surface](#tool-surface) lists every tool.

| Tool | Start here for |
| --- | --- |
| `artifact-resolve` | resolving a version, JAR, coordinate, workspace, or dependency once and reusing its `artifactId` |
| `source-read` | the source of up to 50 classes from Minecraft, dependency, or mod JARs |
| `member-list` | constructors, fields, and methods from bytecode |
| `source-search` | declarations, text, or file paths in an artifact's source |
| `symbol-check` | whether classes, fields, or methods exist in a Minecraft version |
| `symbol-map` | names of classes, fields, and methods in another namespace |
| `version-compare` | the classes, registry entries, and libraries that changed between two versions |
| `mod-inspect` | a mod JAR's loader, metadata, entrypoints, and mixin configs |
| `project-validate` | a workspace's mixin configs and access wideners, file by file |
| `cache-manage` | cache inventory, verification, and preview/apply cleanup |

### Workflow Notes

These notes cover high-frequency decisions during onboarding. For the full pitfall list, exact contracts, migration notes, and environment variables, see [docs/tool-reference.md](docs/tool-reference.md).

- Resolve once with `artifact-resolve` and pass `result.artifact.artifactId` as `target: { kind: "artifact", artifactId }` to the other tools. The resolution options (`sourcePriority`, `gradleUserHome`, `preferProjectVersion`, `strictVersion`) are inputs of `artifact-resolve` only. `allowDecompile` also belongs to `source-read` and `source-export` (default `true`): set it to `false` on each call to decline source decompilation during resolution and fallback, even when reusing an `artifactId`. Options are per call and are not stored on artifacts.
- The symbol tools, `class-diff`, `access-validate`, and `mixin-verify-target` require `mapping`, the namespace your names are written in; the namespace is never assumed.
- A `meta.nextActions` entry without `template: true` can be sent as is; a `template: true` entry has `<placeholder>` values to fill in first.
- `validate-project`, `project-validate`, and `mixin-validate` have a supervisor-owned end-to-end deadline of 120 seconds, including queue time, and each such call runs alone: later calls wait until it finishes. Set `MCP_VALIDATE_PROJECT_TIMEOUT_MS` to an ASCII-decimal value from `10000` through `600000` to override it. A timeout returns `ERR_TOOL_TIMEOUT`; a running timeout restarts the isolated worker before queued calls resume, while a queue timeout leaves the current worker untouched.
- Artifact downloads are capped at 512 MiB (`536870912` bytes) each. Set `MCP_MAX_DOWNLOAD_BYTES` to an ASCII-decimal byte count to override it; values below 1 MiB are raised to 1 MiB, and anything else — non-numeric, malformed, or too large to be an exact integer — falls back to the default. The cap is checked twice: against `Content-Length` before any body is read (a header that is not a plain byte count is treated as absent rather than as a breach), and against the bytes actually received, so a chunked or mis-declared response is caught too. A download that exceeds it fails with `ERR_LIMIT_EXCEEDED` and is not retried; the partial file is deleted on a best-effort basis, so a file the server cannot remove may survive the refusal. A cached copy is never served in its place — a cap is a configuration verdict, not a passing outage, and standing a stale artifact in for it would hide the ceiling instead of reporting it. When every repository trips the cap, the terminal `ERR_REPO_FETCH_FAILED` reports it where a caller can actually read it: `hints` carries the sentence naming `MCP_MAX_DOWNLOAD_BYTES` and the byte count to clear, and `context.repoFailureCode` is `ERR_LIMIT_EXCEEDED`.
- Nested (Jar-in-Jar) entries are capped at 64 MiB (`67108864` bytes) of uncompressed data each. Set `MCP_MAX_NESTED_JAR_ENTRY_BYTES` to override it, on the same rules as the download cap: ASCII decimal digits, values below 1 MiB raised to 1 MiB, anything else falling back to the default. The size is checked against the entry's declared uncompressed size before the read starts and again against the bytes actually streamed. A breach fails that one inner jar with `ERR_LIMIT_EXCEEDED`; the shell jar's other inner jars still resolve.
- Queued calls resume only after the replacement worker completes initialization replay. If replacement startup or replay fails, queued tool calls terminate with `ERR_WORKER_RESTART` instead of waiting indefinitely. If unresolved process-tree cleanup fills the supervisor's two live-generation slots, new requests fail with the existing restart envelope and unavailable notifications are warning-dropped until cleanup or reconnect. On POSIX, an already-gone process group counts as cleaned up rather than leaving a stale cleanup token.
- If a workspace was built with `GRADLE_USER_HOME=/tmp/...` or another isolated Gradle home, pass that path as `gradleUserHome` to `artifact-resolve` and reuse the returned `artifactId`, so source and member lookups use the same Loom cache instead of stale caches under the MCP process home.

### Read Minecraft source from a version

```json
{
  "tool": "source-read",
  "arguments": {
    "target": { "kind": "version", "version": "1.21.10" },
    "classes": ["net.minecraft.server.Main"],
    "mode": "snippet"
  }
}
```

### Map a symbol to another namespace

```json
{
  "tool": "symbol-map",
  "arguments": {
    "target": { "kind": "version", "version": "1.21.10" },
    "mapping": "mojang",
    "toMapping": "intermediary",
    "symbols": [
      { "kind": "method", "className": "net.minecraft.server.MinecraftServer", "memberName": "tickServer" }
    ],
    "signatureMode": "name-only"
  }
}
```

### Summarize a mod JAR

```json
{
  "tool": "mod-inspect",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar"
  }
}
```

### Validate a workspace

```json
{
  "tool": "project-validate",
  "arguments": {
    "projectPath": "/workspace/modid",
    "discover": ["mixins", "access-wideners", "access-transformers"]
  }
}
```

`project-validate` discovers mixin configs and access wideners by default. Add `"access-transformers"` to `discover` when you want Access Transformer files validated too.

## Documentation

- [Detailed example requests](docs/examples.md) for copyable payloads and common workflows
- [Tool and configuration reference](docs/tool-reference.md) for exact inputs, outputs, resource behavior, environment variables, and migration notes. Start with the [Tool catalog](docs/tool-reference.md#tool-catalog) when you are not sure which tool to call; [Migration from 8.x](docs/tool-reference.md#migration-from-8x) names the catalog tools that replace each 8.x tool.
- [日本語 README](docs/README-ja.md) for a Japanese onboarding overview

## Tool Surface

### Catalog Tools

The catalog is a flat set of focused tools listed ahead of the 8.x tools. Each catalog tool answers one kind of question, and all of them share one request vocabulary: a `target` object says where to look (`artifact`, `version`, `jar`, `coordinate`, `workspace`, or `dependency`), `mapping` names the namespace, and `detail` shortens a reply where it can. Replies keep the answer in `result` and put warnings, next actions, paging, and truncation in `meta`; a tool that resolves its `target` to an artifact returns `result.artifact`, whose `artifactId` you can reuse as `target: { kind: "artifact", artifactId }`. An unknown or misplaced key fails with `ERR_INVALID_INPUT` instead of being ignored. The source and member tools take 1–50 `classes` per call and report each class as its own `result.items` entry. They only read, except `source-export`, which writes `.java` files under `outputDir`. `source-search` searches one artifact's indexed source for declarations by name, text inside files, or file paths, page by page; its `mapping` is the namespace of the query, so a Mojang class name finds the class in an obfuscated artifact, and `status: "unavailable"` marks a search without hits whose query could not be translated. The symbol tools (`symbol-check`, `symbol-map`, `class-mappings`, `symbol-trace`) read a Minecraft version's mappings and require `mapping`, the namespace your names are written in: the namespace is never assumed, so a Mojang name is not looked up as an obfuscated one and reported missing; `symbol-check` and `symbol-map` take 1–50 `symbols` per call. The comparison tools work between versions or on one version's generated data: `version-compare` answers with counts unless `detail` asks for the names, `class-diff` requires `mapping` like the symbol tools, and `registry-read` returns registry names and entry counts unless `withData` is set. The mod tools take the mod jar as `jarPath`: `mod-inspect` returns its metadata, `mod-search` searches its source, and `mod-remap` remaps a Fabric or Quilt jar, writing the output only with `apply: true`; read a mod's classes with `source-read` and `member-list` through `target: { kind: "jar", jarPath }`. The validation tools check a Loom project against Minecraft bytecode: `mixin-validate` takes exactly one of `source`, `paths`, `configPaths`, or `discover: true` and reports each mixin class, and `project-validate` finds and validates a workspace's mixin configs and access wideners and reports each file. Both read an omitted `version` and `mapping` from the project only when `projectPath` is given, never assume the mixins' namespace, and return `status: "blocked"` with a template next action when one cannot be read. `access-validate` checks one access widener or access transformer, given as `content` or `path`, entry by entry, and `mixin-verify-target` checks one method or field a mixin targets and advises `@Shadow`, `@Accessor` or `@Invoker`; both require `mapping`, the namespace of the names they check, and `mixin-verify-target` translates those names into the jar's namespace unless `autoRemap: false`. The NBT tools convert Java Edition NBT: `nbt-decode` turns base64 NBT bytes into a typed JSON document, `nbt-patch` applies RFC 6902 operations to that document, and `nbt-encode` writes it back as base64 NBT. `cache-manage` reports, lists, verifies and deletes the server's cache entries; `delete` needs a `selector` and only previews unless `apply: true` is set, and every action returns its entries or counts at every call. `server-metrics` returns the server's runtime counters, including how often each tool was called. See [docs/tool-reference.md → Tool catalog](docs/tool-reference.md#tool-catalog) for inputs, results, and the mapping from the 8.x tools, which stay callable as deprecated aliases.

<!-- BEGIN GENERATED TOOL TABLE: catalog -->
| Tool | Purpose | Replaces (8.x) |
| --- | --- | --- |
| `version-list` | List Minecraft versions from Mojang metadata and mark the locally cached ones | `list-versions`, `inspect-minecraft` (`versions`) |
| `artifact-resolve` | Resolve a version, JAR, coordinate, workspace, or dependency target to a reusable artifact | `resolve-artifact`, `inspect-minecraft` (`artifact`) |
| `artifact-index` | Rebuild the cached file and symbol index of an artifact | `index-artifact` |
| `file-list` | List file paths inside an artifact with cursor pagination | `list-artifact-files`, `inspect-minecraft` (`list-files`) |
| `file-read` | Read one file inside an artifact with a byte limit | `get-artifact-file`, `inspect-minecraft` (`file`) |
| `class-find` | Find fully qualified class names from a simple or qualified name, including nested JARs | `find-class`, `inspect-minecraft` (`class-overview`) |
| `source-read` | Read the source of 1-50 classes (outline, line window, or full file) from Minecraft, dependency, or mod JARs | `batch-class-source`, `get-class-source`, `decompile-mod-jar`, `get-mod-class-source`, `inspect-minecraft` (`class-source`), `analyze-mod` (`class-source`) |
| `source-export` | Write the source of 1-50 classes as `.java` files under an output directory | `batch-class-source`, `get-class-source`, `get-mod-class-source` |
| `member-list` | List the bytecode constructors, fields, and methods of 1-50 classes with paging | `batch-class-members`, `get-class-members`, `inspect-minecraft` (`class-members`), `analyze-mod` (`members`) |
| `source-search` | Search an artifact's indexed source for declarations by name, text inside files, or file paths, with paging | `search-class-source`, `inspect-minecraft` (`search`) |
| `symbol-check` | Check whether 1-50 classes, fields, or methods exist in a Minecraft version's mappings | `batch-symbol-exists`, `check-symbol-exists`, `analyze-symbol` (`exists`) |
| `symbol-map` | Map 1-50 class, field, or method names between namespaces, strictly by descriptor, or to a workspace's compile names | `batch-mappings`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, `analyze-symbol` (`map`, `exact-map`, `workspace`) |
| `class-mappings` | List one class and its members with their names in all four namespaces, with paging | `get-class-api-matrix`, `analyze-symbol` (`api-overview`) |
| `symbol-trace` | Find the Minecraft versions in which a method exists | `trace-symbol-lifecycle`, `analyze-symbol` (`lifecycle`) |
| `version-compare` | Count, and on request list, the classes, registry entries, and libraries added or removed between two Minecraft versions | `compare-versions`, `compare-minecraft` (`versions`, `registry-diff`, `migration-overview`) |
| `class-diff` | Diff one class's constructors, methods, and fields between two Minecraft versions | `diff-class-signatures`, `compare-minecraft` (`class-diff`) |
| `registry-read` | Read a version's generated registries: names and entry counts, and the entries on request | `get-registry-data` |
| `mod-inspect` | Read a mod JAR's loader, metadata, entrypoints, mixin configs, dependencies, and nested JARs, and on request its class names | `analyze-mod-jar`, `decompile-mod-jar`, `analyze-mod` (`summary`, `decompile`) |
| `mod-search` | Search a mod JAR's Java source for class names, method and field declarations, or text | `search-mod-source`, `analyze-mod` (`search`) |
| `mod-remap` | Remap a Fabric or Quilt mod JAR to Yarn or Mojang names (preview unless `apply` is set) | `remap-mod-jar`, `analyze-mod` (`remap`) |
| `project-validate` | Find and validate a Loom workspace's mixin configs, access wideners, and on request access transformers, with each file's status | `validate-project` (`project-summary`) |
| `mixin-validate` | Validate Mixin source, files, configs, or a project's discovered configs against a Minecraft version's bytecode | `validate-mixin`, `validate-project` (`mixin`) |
| `access-validate` | Validate one access widener or access transformer, given as text or a file, entry by entry against a Minecraft version's bytecode | `validate-access-widener`, `validate-access-transformer`, `validate-project` (`access-widener`, `access-transformer`) |
| `mixin-verify-target` | Check that a mixin's target method or field exists in a JAR and get @Shadow, @Accessor, or @Invoker advice | `verify-mixin-target` |
| `nbt-decode` | Decode Java Edition NBT bytes (base64, gzip or uncompressed) into a typed JSON document | `nbt-to-json` |
| `nbt-encode` | Encode a typed NBT JSON document into Java Edition NBT bytes as base64, optionally gzip-compressed | `json-to-nbt` |
| `nbt-patch` | Apply RFC 6902 add, remove, replace, and test operations to a typed NBT JSON document | `nbt-apply-json-patch` |
| `cache-manage` | Summarize, list, verify, and delete the server's cache entries (delete previews unless `apply` is set) | `manage-cache` |
| `server-metrics` | Read the server's runtime counters, including per-tool call counts and durations | `get-runtime-metrics` |
<!-- END GENERATED TOOL TABLE: catalog -->

### Names on 26.1+ Versions

For unobfuscated releases such as `26.1+`, the runtime jar's names as shipped, the `obfuscated` namespace, are already Mojang names. `mapping` accepts both `obfuscated` and `mojang`, and both read the same names: `source-read`, `member-list` and the other tools that resolve a `target` to an artifact report `result.artifact.mappingApplied: "mojang"` for either, and for an omitted `mapping`, and `artifact-resolve` with `detail: "full"` shows `provenance.unobfuscatedRuntime: true`. `artifact-resolve` does not relabel `requestedMapping`, so `requestedMapping: "obfuscated"` next to `mappingApplied: "mojang"` is an identity, not a fallback. `mapping: "mojang"` takes the runtime/decompile path directly and skips Loom source-jar discovery. A target resolved with `intermediary` or `yarn` falls back to the runtime names with a warning and reports `mojang`; `symbol-trace` keeps reporting the requested namespace. This applies to version targets, Minecraft runtime coordinates, and `jar` targets whose own contents (a top-level `version.json` with a 26.1+ `id`, `net/minecraft/SharedConstants.class`, and no `.java` sources) prove a 26.1+ Minecraft runtime jar; see [docs/tool-reference.md → Lookup Rules](docs/tool-reference.md#lookup-rules). Dependency jars whose own version only looks like `26.x` keep `obfuscated`. `cache-manage` shows the label each entry was stored with, without relabelling it, and `access-validate` reports the vanilla jar it checked against as `obfuscated` in its `provenance`; see [docs/tool-reference.md → Namespace Definitions](docs/tool-reference.md#namespace-definitions).

### Deprecated 8.x Tools

The 8.x tools below are deprecated aliases that still accept their 8.x inputs and are removed in 10.0.0 at the earliest; `MCP_DEPRECATED_TOOLS=off` leaves them out, and [docs/tool-reference.md → Deprecated 8.x tools](docs/tool-reference.md#deprecated-8x-tools) documents them.

<!-- BEGIN GENERATED TOOL TABLE: aliases -->
| 8.x tool | Replaced by |
| --- | --- |
| `list-versions` | `version-list` |
| `inspect-minecraft` | `versions` → `version-list`, `artifact` → `artifact-resolve`, `class-overview` → `class-find`, `class-source` → `source-read`, `class-members` → `member-list`, `search` → `source-search`, `file` → `file-read`, `list-files` → `file-list` |
| `analyze-symbol` | `exists` → `symbol-check`, `map` → `symbol-map`, `exact-map` → `symbol-map`, `lifecycle` → `symbol-trace`, `workspace` → `symbol-map`, `api-overview` → `class-mappings` |
| `compare-minecraft` | `versions` → `version-compare`, `class-diff` → `class-diff`, `registry-diff` → `version-compare`, `migration-overview` → `version-compare` |
| `analyze-mod` | `summary` → `mod-inspect`, `decompile` → `mod-inspect`, `search` → `mod-search`, `class-source` → `source-read`, `members` → `member-list`, `remap` → `mod-remap` |
| `validate-project` | `project-summary` → `project-validate`, `mixin` → `mixin-validate`, `access-widener` → `access-validate`, `access-transformer` → `access-validate` |
| `manage-cache` | `cache-manage` |
| `verify-mixin-target` | `mixin-verify-target` |
| `batch-class-source` | `source-read`, `source-export` |
| `batch-class-members` | `member-list` |
| `batch-symbol-exists` | `symbol-check` |
| `batch-mappings` | `symbol-map` |
| `resolve-artifact` | `artifact-resolve` |
| `find-class` | `class-find` |
| `get-class-source` | `source-read`, `source-export` |
| `get-class-members` | `member-list` |
| `search-class-source` | `source-search` |
| `get-artifact-file` | `file-read` |
| `list-artifact-files` | `file-list` |
| `trace-symbol-lifecycle` | `symbol-trace` |
| `diff-class-signatures` | `class-diff` |
| `find-mapping` | `symbol-map` |
| `resolve-method-mapping-exact` | `symbol-map` |
| `get-class-api-matrix` | `class-mappings` |
| `resolve-workspace-symbol` | `symbol-map` |
| `check-symbol-exists` | `symbol-check` |
| `nbt-to-json` | `nbt-decode` |
| `nbt-apply-json-patch` | `nbt-patch` |
| `json-to-nbt` | `nbt-encode` |
| `index-artifact` | `artifact-index` |
| `get-runtime-metrics` | `server-metrics` |
| `validate-mixin` | `mixin-validate` |
| `validate-access-widener` | `access-validate` |
| `validate-access-transformer` | `access-validate` |
| `analyze-mod-jar` | `mod-inspect` |
| `get-registry-data` | `registry-read` |
| `compare-versions` | `version-compare` |
| `decompile-mod-jar` | `mod-inspect`, `source-read` |
| `get-mod-class-source` | `source-read`, `source-export` |
| `search-mod-source` | `mod-search` |
| `remap-mod-jar` | `mod-remap` |
<!-- END GENERATED TOOL TABLE: aliases -->

Detailed parameter constraints, migration notes, resource behavior, and the full environment-variable matrix live in [docs/tool-reference.md](docs/tool-reference.md).

## Development

Repository requirements:

- Node.js 22.13.0+
- `pnpm`
- Java 17+ when running remap or decompile flows locally

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

- `pnpm test:file <path...>` for focused ordinary suites
- `pnpm test:grep <name-pattern>` for recursive ordinary suites filtered by test name
- `pnpm test:manual:stdio-smoke` for MCP transport, registration, or manual workflow changes
- `pnpm test:manual:package-smoke` when checking packaged install and distribution behavior
- `pnpm test:perf` for search, index, or performance-sensitive changes
- `pnpm test:coverage` or `pnpm test:coverage:lcov` for coverage checks (`lines=80`, `branches=70`, `functions=80`)
- `pnpm validate` for the full local validation suite

Ordinary `.test.ts` files live in domain directories under `tests/` (for example `source-service/`, `entry-tools/`, `mapping/`, `mixin/`, `tools/`, `aliases/`, `contracts/`, and `utils/`). Keep helper-only modules in `tests/helpers`; manual smoke, performance, and resource files remain in their existing special directories.

## Acknowledgements

- The `enclosingSymbol` field on content search hits was inspired by the design of [zvec-grep](https://github.com/zvec-ai/zvec-grep). This project shares no code with zvec-grep and does not depend on it.

## License

[MIT](LICENSE)
