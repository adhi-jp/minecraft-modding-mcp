# Tool and Configuration Reference

This document complements [README.md](../README.md). Use it when you need the exact input conventions, resource URIs, mapping rules, or the full environment-variable matrix.

## Essential Conventions

- Start with the top-level workflow tools when possible. `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `analyze-mod`, `validate-project`, and `manage-cache` cover the common workflows and return summary-first results with follow-up hints.
- `resolve-artifact` uses `target: { kind, value }`.
- `get-class-source` and `get-class-members` use `target: { type: "artifact", artifactId }` or `target: { type: "resolve", kind, value }`.
- `validate-mixin` and `validate-project task="mixin"` use `input.mode="inline" | "path" | "paths" | "config" | "project"`.
- Positive integer tool arguments accept numeric strings such as `"10"` for documented top-level parameters.
- When a parameter has a fixed safe default, `tools/list` exposes it through the JSON Schema `default` field so clients can rely on schema metadata instead of prose notes.
- Source-oriented tools expose `artifactContents` so callers can tell whether the backing artifact is a `source-jar` or a `decompiled-binary`. `get-class-source`, `get-class-members`, `search-class-source`, and `get-artifact-file` also expose `returnedNamespace`.
- Windows and WSL path forms are normalized for `jarPath`, `projectPath`, and environment-variable path overrides.
- Heavy analysis tools are serialized in-process to protect stdio stability. Queue overflow returns `ERR_LIMIT_EXCEEDED`.
- All tools and JSON resources use the standard `{ result?, error?, meta }` envelope. `class-source` and `artifact-file` resources return raw text on success and structured JSON on failure.

## Common Pitfalls

- `mapping="mojang"` requires source-backed artifacts. Decompile-only paths return `ERR_MAPPING_NOT_APPLIED`.
- `list-artifact-files` indexes Java source paths only. Probing `assets/` or `data/` prefixes will not return non-Java resources.
- `search-class-source` defaults to `queryMode="auto"`. Use `queryMode="literal"` for explicit substring scans. `match="regex"` enforces `query.length <= 200` and caps results at `100`.
- `search-class-source` returns compact hits only. Use `get-artifact-file` or `get-class-source` to inspect returned files.
- `find-class` and `get-class-source` on `mapping="obfuscated"` expect Mojang obfuscated names. Deobfuscated queries warn and usually need `mapping="mojang"` or a `find-mapping` step first.
- `check-symbol-exists` defaults to strict FQCN class lookup. Use `nameMode="auto"` for short class names.
- `check-symbol-exists` can use `signatureMode="name-only"` for overload discovery, but exact `descriptor` matching is still the most reliable path.
- `find-mapping` accepts short class ids such as `dhl` only when `sourceMapping="obfuscated"`. Other class lookup paths still validate class names as fully-qualified.
- `get-class-api-matrix` now uses the explicit `classNameMapping` as its base namespace even when an obfuscated identity is also available.
- `scope="loader"` currently resolves through the same lookup path as `scope="merged"`.
- `remap-mod-jar` requires Java and supports Fabric/Quilt inputs. Mojang-mapped inputs can only be copied through `targetMapping="mojang"`.
- `search-mod-source` enforces `query.length <= 200` and `limit <= 200`.
- `get-registry-data` can return names and counts only with `includeData=false`, or clip detailed payloads with `maxEntriesPerRegistry`.
- `validate-mixin` summary-first workflows should combine `includeIssues=false`, `reportMode="compact"`, and `warningMode="aggregated"`.
- Empty Mixin configs are treated as warning-only discovery results with `summary.total=0` instead of invalid input; malformed JSON still returns `ERR_INVALID_INPUT`.

## Migration Notes

- Start with `inspect-minecraft` for version, artifact, class, file, and search workflows before dropping to `list-versions`, `resolve-artifact`, `get-class-source`, `get-class-members`, `search-class-source`, `get-artifact-file`, or `list-artifact-files`.
- Start with `analyze-symbol` for symbol mapping, existence, lifecycle, workspace, and API overview workflows before using `find-mapping`, `resolve-method-mapping-exact`, `check-symbol-exists`, `trace-symbol-lifecycle`, `resolve-workspace-symbol`, or `get-class-api-matrix` directly.
- Start with `compare-minecraft` for version-pair, class diff, registry diff, and migration-summary flows before using `compare-versions`, `diff-class-signatures`, or `get-registry-data` directly.
- Start with `analyze-mod` for metadata-first mod inspection and safe remap preview/apply flows before using `analyze-mod-jar`, `decompile-mod-jar`, `get-mod-class-source`, `search-mod-source`, or `remap-mod-jar` directly.
- Start with `validate-project` for workspace summaries and direct Mixin or Access Widener validation before using `validate-mixin` or `validate-access-widener` directly.
- Start with `manage-cache` for cache inventory and safe cleanup. Use `executionMode="preview"` before `executionMode="apply"`.
- Replace `resolve-artifact` `targetKind` and `targetValue` with `target: { kind, value }`.
- Replace `get-class-source` and `get-class-members` top-level `artifactId`, `targetKind`, and `targetValue` with `target: { type: "artifact", artifactId }` or `target: { type: "resolve", kind, value }`.
- `resolve-method-mapping-exact` is method-only and no longer accepts `kind`.
- Replace `validate-mixin` `source`, `sourcePath`, `sourcePaths`, `mixinConfigPath`, and `sourceRoot` with `input.mode` plus `input.source`, `input.path`, `input.paths[]`, `input.configPaths[]`, and `sourceRoots[]`.
- `search-class-source` removed snippet, definition, and relation expansion. Responses now contain compact `hits[]` plus `nextCursor?`, and `symbolKind` is only valid with `intent="symbol"`.

## Resources

MCP resources provide URI-based access to Minecraft data for clients that support the resource protocol.

### Fixed Resources

| Resource | URI | Description |
| --- | --- | --- |
| `versions-list` | `mc://versions/list` | List all available Minecraft versions with metadata |
| `runtime-metrics` | `mc://metrics` | Runtime metrics and performance counters |

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

## Mapping Policy

### Namespace Definitions

| Namespace | Description |
| --- | --- |
| `obfuscated` | Mojang obfuscated names such as `a`, `b`, `c` |
| `mojang` | Mojang deobfuscated names from `client_mappings.txt` such as `net.minecraft.server.Main` |
| `intermediary` | Fabric stable intermediary names such as `net.minecraft.class_1234` and `method_5678` |
| `yarn` | Fabric community human-readable names such as `net.minecraft.server.MinecraftServer` and `tick` |

The legacy public namespace name `official` was removed. Requests that still send `official` now fail validation and should be updated to `obfuscated`.

### Lookup Rules

`find-mapping` supports lookup across `obfuscated`, `mojang`, `intermediary`, and `yarn`.

Symbol query inputs use `kind` plus `name` plus optional `owner` and `descriptor`:

- class: `kind="class"`, `name="a.b.C"` by default. `find-mapping` also accepts short obfuscated runtime ids such as `dhl` when `sourceMapping="obfuscated"`. For existence checks only, `nameMode="auto"` allows short names such as `Blocks`.
- field: `kind="field"`, `owner="a.b.C"`, `name="fieldName"`
- method: `kind="method"`, `owner="a.b.C"`, `name="methodName"`, `descriptor="(I)V"`

`mapping="mojang"` requires a source-backed artifact. If only a decompile path is available, the server returns `ERR_MAPPING_NOT_APPLIED`.

`resolve-artifact`, `get-class-members`, `trace-symbol-lifecycle`, and `diff-class-signatures` accept `obfuscated | mojang | intermediary | yarn` with these constraints:

- `intermediary` and `yarn` require a resolvable Minecraft version context such as `target.kind="version"` or a versioned Maven coordinate.
- For unobfuscated versions such as `26.1+`, requesting `intermediary` or `yarn` falls back to `obfuscated` with a warning.
- `mojang` requires source-backed artifacts. Decompile-only paths are rejected with `ERR_MAPPING_NOT_APPLIED`.

When `trace-symbol-lifecycle` omits `descriptor`, the server resolves methods by owner and name and warns if overload ambiguity prevents a unique answer.

If callers accidentally append an inline signature suffix to `trace-symbol-lifecycle.symbol`, the server strips that suffix before splitting `Class.method`. Use the separate `descriptor` field when the workflow needs exact overload matching.

For decompile-only `ERR_MAPPING_NOT_APPLIED` failures, error details include `artifactOrigin`, `nextAction`, and `suggestedCall` so clients can recover without guessing.

If `find-class` or `get-class-source` returns no hit on an `obfuscated` artifact for names like `net.minecraft.world.item.Item`, the tool warns that `obfuscated` means Mojang's runtime names and recommends retrying with `mapping="mojang"` or translating via `find-mapping`.

Method descriptor precision is best on Tiny-backed paths (`intermediary` and `yarn`). For `obfuscated <-> mojang`, Mojang `client_mappings` do not carry JVM descriptors, so descriptor queries may fall back to name matching and emit a warning.

Use `resolve-method-mapping-exact` when candidate ranking is not enough and the workflow needs strict `owner + name + descriptor` certainty.

Use `find-mapping` `disambiguation.ownerHint` and `disambiguation.descriptorHint` to narrow ambiguous candidate sets.

Use `resolve-workspace-symbol` when you need compile-visible names from actual Gradle Loom mappings in a workspace.

## Environment Variables

### Core and Repository Discovery

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | Cache root for downloads and SQLite |
| `MCP_SQLITE_PATH` | `<cacheDir>/source-cache.db` | SQLite database path |
| `MCP_SOURCE_REPOS` | Maven Central + Fabric + Forge + NeoForge | Comma-separated Maven repository URLs |
| `MCP_LOCAL_M2` | `~/.m2/repository` | Local Maven repository path |
| `MCP_ENABLE_INDEXED_SEARCH` | `true` | Enable indexed query path for `search-class-source` |
| `MCP_MAPPING_SOURCE_PRIORITY` | `loom-first` | Mapping source priority (`loom-first` or `maven-first`) |
| `MCP_VERSION_MANIFEST_URL` | Mojang manifest URL | Override the Minecraft version manifest endpoint |

### Search, Index, and Cache Tuning

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_MAX_CONTENT_BYTES` | `1000000` | Maximum bytes for file read operations |
| `MCP_MAX_SEARCH_HITS` | `200` | Maximum search result count |
| `MCP_SEARCH_SCAN_PAGE_SIZE` | `250` | Page size used by literal scan fallbacks |
| `MCP_INDEX_INSERT_CHUNK_SIZE` | `200` | Batch size for SQLite index inserts |
| `MCP_MAX_ARTIFACTS` | `200` | Maximum cached artifacts |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | Maximum total cache size in bytes |
| `MCP_CACHE_GRAPH_MAX` | `16` | Mapping graph cache size |
| `MCP_CACHE_SIGNATURE_MAX` | `2000` | Signature cache size |
| `MCP_CACHE_VERSION_DETAIL_MAX` | `256` | Version detail cache size |

### Networking

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_FETCH_TIMEOUT_MS` | `15000` | HTTP request timeout in milliseconds |
| `MCP_FETCH_RETRIES` | `2` | HTTP request retry count |

### Decompilation and Remapping

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_VINEFLOWER_JAR_PATH` | unset | Override the Vineflower JAR path |
| `MCP_VINEFLOWER_VERSION` | `1.11.2` | Vineflower version to auto-download when no JAR path override is set |
| `MCP_TINY_REMAPPER_JAR_PATH` | unset | Override the tiny-remapper JAR path |
| `MCP_TINY_REMAPPER_VERSION` | `0.10.3` | tiny-remapper version to auto-download when no JAR path override is set |
| `MCP_REMAP_TIMEOUT_MS` | `600000` | Remap operation timeout in milliseconds |
| `MCP_REMAP_MAX_MEMORY_MB` | `4096` | Maximum JVM heap for remap operations |

### NBT Limits

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_MAX_NBT_INPUT_BYTES` | `4194304` | Maximum decoded NBT input bytes accepted by `nbt-to-json` |
| `MCP_MAX_NBT_INFLATED_BYTES` | `16777216` | Maximum gzip-inflated bytes accepted by `nbt-to-json` |
| `MCP_MAX_NBT_RESPONSE_BYTES` | `8388608` | Maximum response payload bytes for NBT tools |

### Diagnostics

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_SUPERVISOR_DEBUG` | unset | Set to `1` to emit verbose stdio supervisor diagnostics |

Internal worker-mode environment variables are reserved for the transport implementation and are intentionally omitted from the public reference.

## Architecture

| Component | Technology |
| --- | --- |
| Runtime | Node.js 22+ |
| Transport | stdio with newline and `Content-Length` framing support |
| Storage | SQLite for artifact metadata, source indexing, and cache bookkeeping |
| Decompilation | [Vineflower](https://github.com/Vineflower/vineflower) |
| Remapping | [tiny-remapper](https://github.com/FabricMC/tiny-remapper) |
| Mapping Sources | Mojang `client_mappings.txt`, Fabric Loom workspace metadata, Maven Tiny v2 |

The server runs as a long-lived stdio process. Artifacts, mappings, and generated metadata are downloaded on demand and cached locally.
