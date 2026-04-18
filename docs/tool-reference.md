# Tool and Configuration Reference

Use [README.md](../README.md) for quick start and client setup. Use [docs/examples.md](examples.md) for concrete request payloads.

Use this document when you need the exact input conventions, outputs, resource URIs, mapping rules, migration notes, operational pitfalls, or the full environment-variable matrix.

## Which Tool for Which Question

Start here when you are not sure which tool to reach for. In every row, the left column is the question as a user would phrase it; the right column is the tool that answers it most directly. Class lookups always take a fully-qualified class name as `name`; field and method lookups split the class into `owner` and the simple member into `name`.

| Question | Tool |
| --- | --- |
| "Does class `X` exist on MC `1.21.10`?" | `check-symbol-exists` (`kind="class"`, `nameMode="auto"` if you only have a short name). |
| "What is the obfuscated name of `net.minecraft.world.entity.player.Player` in MC `1.21.10`?" | `find-mapping` (`kind="class"`, `name="net.minecraft.world.entity.player.Player"`, `sourceMapping="mojang"`, `targetMapping="obfuscated"`). |
| "What is the descriptor of `Player.addAdditionalSaveData`?" | `check-symbol-exists` (`kind="method"`, `owner="net.minecraft.world.entity.player.Player"`, `name="addAdditionalSaveData"`, `sourceMapping="mojang"`, `signatureMode="name-only"`). `find-mapping` with `signatureMode="name-only"` also works when you additionally want the target-namespace name. |
| "Does this exact obf `owner + name + descriptor` triple resolve to one mapping?" | `resolve-method-mapping-exact` (always requires the full triple). |
| "I know a Mojang method like `ItemStack.copy` — which workspace mapping does it use?" | Discover the descriptor first with `check-symbol-exists` (`signatureMode="name-only"`), then call `resolve-workspace-symbol` (`kind="method"`, `owner="net.minecraft.world.item.ItemStack"`, `name="copy"`, `descriptor="()Lnet/minecraft/world/item/ItemStack;"`, `projectPath`). |
| "Summarize a symbol across mapping/existence/lifecycle in one call." | `analyze-symbol` (higher-level wrapper around `find-mapping` / `check-symbol-exists` / `trace-symbol-lifecycle`). |
| "Give me the source of one class I already know the FQCN of." | `get-class-source` (`mode="metadata"` to skim, `mode="snippet"` for line ranges, `mode="full"` for the whole file). |
| "Give me the fields/methods/constructors of one class without reading the source." | `get-class-members`. |
| "Find every class or member that matches `save` in one artifact." | `search-class-source`. |
| "I only know the simple class name `PlayerList` and want the FQCN." | `find-class`. |
| "Does this Mixin target the right class and descriptor?" | `validate-mixin` (works standalone with `version=1.21.10`; provide inline source, a path, or a mixin config). |
| "Validate every Mixin / Access Widener / Access Transformer in a workspace." | `validate-project` (`task="project-summary"` discovers everything; `task="mixin"|"access-widener"|"access-transformer"` validates a single subject). |
| "Inspect the Minecraft workspace or an artifact without picking a lower-level tool." | `inspect-minecraft` — use this when you want the server to resolve the artifact and pick the right sub-tool. |
| "Trace when a symbol was added, renamed, or removed across versions." | `trace-symbol-lifecycle` (or `analyze-symbol task="lifecycle"` for the summarized 5-version window). |
| "Compare two MC versions or two class versions." | `compare-minecraft` (`task="class"` for a single class diff; `task="versions"` for a full summary). |
| "Inspect or remap an existing `.jar` file." | `analyze-mod` / `analyze-mod-jar` / `remap-mod-jar`. |

## Essential Conventions

- Start with the top-level workflow tools when possible. `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `analyze-mod`, `validate-project`, and `manage-cache` cover the common workflows and return summary-first results with follow-up hints.
- `resolve-artifact` uses `target: { kind, value }`.
- `get-class-source` and `get-class-members` use `target: { type: "artifact", artifactId }` or `target: { type: "resolve", kind, value }`.
- `validate-mixin` and `validate-project task="mixin"` use `input.mode="inline" | "path" | "paths" | "config" | "project"`.
- Positive integer tool arguments accept numeric strings such as `"10"` for documented top-level parameters.
- When a parameter has a fixed safe default, `tools/list` exposes it through the JSON Schema `default` field so clients can rely on schema metadata instead of prose notes.
- Retryable `suggestedCall` payloads omit parameters when the supplied value already matches the tool default, keeping recovery calls smaller without changing behavior.
- Source-oriented tools expose `artifactContents` so callers can tell whether the backing artifact is a `source-jar` or a `decompiled-binary`. `get-class-source`, `get-class-members`, `search-class-source`, and `get-artifact-file` also expose `returnedNamespace`.
- `get-class-members` returns `decompiledFallback` (with `constructors`, `fields`, `methods`, each entry is `{ name, line, kind }`) and `decompiledMemberCounts` whenever bytecode enumeration yields zero but the decompiled source for the class is already indexed. The bytecode-derived `members` / `counts` are preserved as-is; the fallback is additive and carries no descriptor or access modifier. `qualityFlags` gains `"members-from-decompiled-source"` in that case. Use `get-class-source` for descriptors and full context.
- `search-class-source` accepts `queryNamespace`. When set and the artifact's `mappingApplied` differs, `intent="symbol"` queries for fully-qualified class names are translated through `find-mapping` (source=`queryNamespace`, target=artifact namespace) before the indexed search runs; the response carries a `translatedQuery` block describing the rewrite. `intent="text"` / `intent="path"` do not translate — text search is a literal match against the artifact namespace; the response surfaces a `warnings` array instead. `sourcePriority` is only consulted during translation.
- `resolve-artifact`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, and `check-symbol-exists` accept `compact: true` to strip empty arrays, null values, and empty objects from the response. For `resolve-artifact`, compact mode also omits `provenance`, `artifactContents`, `sampleEntries`, `adjacentSourceCandidates`, `binaryJarPath`, `coordinate`, `repoUrl`, and `resolvedSourceJarPath`. For mapping tools, compact mode has two projections: (1) the redundant `candidates` array is omitted entirely when the result is a single full-confidence exact-match resolution; (2) when the result is unresolved with more than three candidates, the top three keep full metadata while the tail is slimmed to `{kind, symbol, owner, name, descriptor, confidence, matchKind}` and the response surfaces `candidateDetailsTruncated: true`. `candidatesTruncated` retains its pre-compact meaning ("more candidates exist upstream than this response returned") and is set independently by the service when `maxCandidates` clipped the list — the two signals can both appear.
- `get-class-source`, `get-class-members`, `search-class-source`, and `list-artifact-files` accept `compact: true` (opt-in, default `false`) to strip debug/diagnostic metadata and empty fields. `get-class-source` omits `provenance`, `artifactContents`, and `qualityFlags`. `get-class-members` omits `provenance`, `artifactContents`, `qualityFlags`, and `context`; `decompiledFallback` and `decompiledMemberCounts` are preserved. `search-class-source` and `list-artifact-files` omit `artifactContents` only — the primary `hits` / `items` payload is always preserved.
- Windows and WSL path forms are normalized for `jarPath`, `projectPath`, and environment-variable path overrides.
- Heavy analysis tools are serialized in-process to protect stdio stability. Queue overflow returns `ERR_LIMIT_EXCEEDED`.
- All tools and JSON resources use the standard `{ result?, error?, meta }` envelope. `class-source` and `artifact-file` resources return raw text on success and structured JSON on failure.

## Common Pitfalls

- `mapping="mojang"` requires source-backed artifacts on legacy obfuscated versions. For unobfuscated releases such as `26.1+`, the runtime/decompile path is accepted directly for version and versioned-coordinate targets. When source jars are not available but the version's Mojang tiny mappings, the tiny-remapper jar, and `MappingService.checkMappingHealth` are all healthy, `resolve-artifact` will transparently tiny-remap the binary jar (`obfuscated -> mojang`) and decompile the result; the response carries `qualityFlags` `"binary-remapped"` and `"decompiled"` plus `provenance.transformChain` `"binary-remap:obf->mojang"` and `"decompile:vineflower"`. Source-backed and obfuscated artifacts keep their existing `artifactId` hashes — only the new mojang-remapped variant lives in a separate cache slot.
- `list-artifact-files` indexes Java source paths only. Probing `assets/` or `data/` prefixes will not return non-Java resources.
- `search-class-source` defaults to `queryMode="auto"`. Use `queryMode="literal"` for explicit substring scans. `match="regex"` enforces `query.length <= 200` and caps results at `100`.
- `search-class-source` returns compact hits only. Use `get-artifact-file` or `get-class-source` to inspect returned files.
- `find-class` and `get-class-source` on `mapping="obfuscated"` expect Mojang obfuscated names. Deobfuscated queries warn and usually need `mapping="mojang"` or a `find-mapping` step first.
- `check-symbol-exists` defaults to strict FQCN class lookup. Use `nameMode="auto"` for short class names.
- `check-symbol-exists` can use `signatureMode="name-only"` for overload discovery, but exact `descriptor` matching is still the most reliable path.
- `analyze-symbol task="api-overview"` inherits `sourceMapping` as the default `classNameMapping`; it falls back to `obfuscated` only when neither value is provided.
- `find-mapping` accepts short class ids such as `dhl` only when `sourceMapping="obfuscated"`. Other class lookup paths still validate class names as fully-qualified.
- `find-mapping` still rejects the public namespace name `official`, but upstream Tiny files that use `official` internally are now bridged to the supported `obfuscated` graph automatically.
- `get-class-api-matrix` now uses the explicit `classNameMapping` as its base namespace even when an obfuscated identity is also available.
- `inspect-minecraft task="class-overview" | "search" | "class-source" | "class-members"` needs artifact context for plain `subject.kind="search" | "class" | "file"` inputs. Use `subject.kind="workspace"` when you want the tool to resolve the artifact for you. Invalid combinations return `ERR_INVALID_INPUT` with a retryable `suggestedCall`; when artifact context is the only missing piece, the suggested retry preserves the requested task.
- Workspace `inspect-minecraft` flows now treat `partial-source-no-net-minecraft` as a recoverable condition: `task="class-overview"` and class-like workspace `task="search"` can confirm vanilla classes through binary-backed symbol lookup, while workspace `task="list-files"` marks the response as partial and includes follow-up guidance.
- `analyze-mod` and `validate-project` keep their structured `subject` contracts; stale string-subject or domain-include payloads now fail with `ERR_INVALID_INPUT` plus a retryable `suggestedCall` instead of a dead-end schema error.
- `scope="loader"` now means runtime artifact discovery. Fabric/Quilt flows may still fall back to merged Loom artifacts, while Forge/NeoForge validation can resolve transformed loader runtime jars.
- `remap-mod-jar` requires Java and supports Fabric/Quilt inputs. Mojang-mapped inputs can only be copied through `targetMapping="mojang"`.
- `search-mod-source` enforces `query.length <= 200` and `limit <= 200`.
- `get-registry-data` can return names and counts only with `includeData=false`, or clip detailed payloads with `maxEntriesPerRegistry`.
- `validate-mixin` summary-first workflows should combine `includeIssues=false`, `reportMode="compact"`, and `warningMode="aggregated"`.
- `validate-mixin` top-level failures expose `failedStage` as a first-class field on the serialized `error` envelope (alongside `code`, `hints`, `suggestedCall`) — one of `"input-validation" | "resolve" | "mapping-health" | "parse" | "target-lookup"`. Branch on that before inspecting `message` to recover automatically (e.g. retry `resolve` failures with `scope="vanilla"`, retry `target-lookup` failures with a different `mapping`). Nested errors that already carry a `failedStage` are preserved so upstream tags (e.g. from `resolve-artifact`) surface unchanged.
- `validate-mixin` per-result `quickSummary` appends `Scope fell back from "<requested>" to "<applied>" (<reason>).` when `provenance.scopeFallback` is set and `Mapping health degraded: <degradations>.` when `toolHealth.overallHealthy === false`. Clean validations keep the original one-line summary; the extra notes only attach when the pipeline actually fell back or detected a degraded mapping.
- Empty Mixin configs are treated as warning-only discovery results with `summary.total=0` instead of invalid input; malformed JSON still returns `ERR_INVALID_INPUT`.

## Migration Notes

- Start with `inspect-minecraft` for version, artifact, class, file, and search workflows before dropping to `list-versions`, `resolve-artifact`, `get-class-source`, `get-class-members`, `search-class-source`, `get-artifact-file`, or `list-artifact-files`.
- Start with `analyze-symbol` for symbol mapping, existence, lifecycle, workspace, and API overview workflows before using `find-mapping`, `resolve-method-mapping-exact`, `check-symbol-exists`, `trace-symbol-lifecycle`, `resolve-workspace-symbol`, or `get-class-api-matrix` directly.
- `analyze-symbol task="lifecycle"` treats its required `version` as the upper bound for the lifecycle scan and intentionally limits the high-level helper to a recent 5-version window. Use `trace-symbol-lifecycle` directly when you need explicit `fromVersion` / `toVersion` control or a wider history.
- Start with `compare-minecraft` for version-pair, class diff, registry diff, and migration-summary flows before using `compare-versions`, `diff-class-signatures`, or `get-registry-data` directly.
- Start with `analyze-mod` for metadata-first mod inspection and safe remap preview/apply flows before using `analyze-mod-jar`, `decompile-mod-jar`, `get-mod-class-source`, `search-mod-source`, or `remap-mod-jar` directly.
- Start with `validate-project` for workspace summaries and direct Mixin, Access Widener, or Access Transformer validation before using `validate-mixin`, `validate-access-widener`, or `validate-access-transformer` directly.
- `validate-project task="project-summary"` discovers mixins and access wideners by default. Add `discover: ["access-transformers"]` when you also want Access Transformer files included in the workspace summary.
- `validate-access-widener` keeps vanilla validation when `projectPath`, `scope`, and `preferProjectVersion` are omitted. Supplying Loom workspace context switches it into runtime-aware mode, which returns `provenance` and per-entry runtime access evidence without changing the existing summary shape.
- `validate-access-transformer` accepts `atNamespace="srg" | "mojang" | "obfuscated"`. When `projectPath` points at a Forge or NeoForge workspace, the tool can infer that namespace automatically and validate against loader/runtime artifacts for `scope="loader"`.
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

`mapping="mojang"` requires a source-backed artifact on legacy obfuscated versions. On unobfuscated releases such as `26.1+`, decompile-only/runtime paths are accepted directly for version and versioned-coordinate targets.

`resolve-artifact`, `get-class-members`, `trace-symbol-lifecycle`, and `diff-class-signatures` accept `obfuscated | mojang | intermediary | yarn` with these constraints:

- `intermediary` and `yarn` require a resolvable Minecraft version context such as `target.kind="version"` or a versioned Maven coordinate.
- For unobfuscated versions such as `26.1+`, requesting `intermediary` or `yarn` falls back to `obfuscated` with a warning.
- On legacy obfuscated versions, `mojang` requires source-backed artifacts and decompile-only paths are rejected with `ERR_MAPPING_NOT_APPLIED`.
- On unobfuscated versions such as `26.1+`, `mojang` uses the runtime/decompile path directly for version and versioned-coordinate targets and skips Loom source-jar approximation.

When `trace-symbol-lifecycle` omits `descriptor`, the server resolves methods by owner and name and warns if overload ambiguity prevents a unique answer.

If callers accidentally append an inline signature suffix to `trace-symbol-lifecycle.symbol`, the server strips that suffix before splitting `Class.method`. Use the separate `descriptor` field when the workflow needs exact overload matching.

`trace-symbol-lifecycle` rejects class-like `symbol` inputs such as `net.minecraft.world.item.Item` with `ERR_INVALID_INPUT`. Pass `Class.method` and keep exact overload matching in the separate `descriptor` field.

`trace-symbol-lifecycle` evaluates per-version bytecode checks with bounded parallelism. If you only need a narrower historical window, still prefer explicit `fromVersion` / `toVersion` bounds to reduce work further.

`trace-symbol-lifecycle`, `check-symbol-exists`, and `find-mapping` skip intermediary/yarn Tiny graph loading when the request only needs Mojang/obfuscated names, so cold `mojang <-> obfuscated` lifecycle and existence lookups no longer pay the full named-namespace graph cost.

For decompile-only `ERR_MAPPING_NOT_APPLIED` failures, error details include `artifactOrigin`, `nextAction`, and `suggestedCall` so clients can recover without guessing.

If `find-class` or `get-class-source` returns no hit on an `obfuscated` artifact for names like `net.minecraft.world.item.Item`, the tool warns that `obfuscated` means Mojang's runtime names and recommends retrying with `mapping="mojang"` or translating via `find-mapping`.

Method descriptor precision is best on Tiny-backed paths (`intermediary` and `yarn`). For `obfuscated <-> mojang`, Mojang `client_mappings` do not carry JVM descriptors, so descriptor queries may fall back to name matching and emit a warning.

Use `resolve-method-mapping-exact` when candidate ranking is not enough and the workflow needs strict `owner + name + descriptor` certainty.

Use `find-mapping` `disambiguation.ownerHint` and `disambiguation.descriptorHint` to narrow ambiguous candidate sets.

Use `resolve-workspace-symbol` when you need compile-visible names from actual Gradle Loom mappings in a workspace.

## Environment Variables

Path-based overrides treat blank values and the literal strings `undefined` and `null` as unset, so accidental client serialization does not create `./undefined` or `./null` cache roots or broken JAR override paths.

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
