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
| "Trace when a symbol was added, renamed, or removed across versions." | `trace-symbol-lifecycle` (or `analyze-symbol task="lifecycle"`, which now exposes `fromVersion`/`toVersion`/`maxVersions`/`includeTimeline`). |
| "Compare two MC versions or two class versions." | `compare-minecraft` (`task="class-diff"` for a single class diff; `task="versions"` for a full summary). |
| "Inspect or remap an existing `.jar` file." | `analyze-mod` / `analyze-mod-jar` / `remap-mod-jar`. |

## Essential Conventions

- Start with the top-level workflow tools when possible. `inspect-minecraft`, `analyze-symbol`, `compare-minecraft`, `analyze-mod`, `validate-project`, and `manage-cache` cover the common workflows and return summary-first results with follow-up hints.
- `resolve-artifact` uses `target: { kind, value }`. `kind` is one of `"version"`, `"jar"`, `"coordinate"`, `"workspace"`, or `"dependency"` (see "Workspace and dependency target shapes" below).
- `get-class-source` and `get-class-members` use `target: { kind, value }` — the same `kind`-based shape as `resolve-artifact` (`"version"`, `"jar"`, `"coordinate"`, `"workspace"`, `"dependency"`), plus `target: { kind: "artifact", artifactId }` to reuse an already-resolved artifact.
- `find-class`, `search-class-source`, `get-artifact-file`, `list-artifact-files`, and `index-artifact` accept either an `artifactId` or the shared object `target` shape. `find-class` also accepts top-level `projectPath`, which supplies the workspace context required by `target.kind="workspace"` and dependency targets using `versionFromProject`. For another flat tool whose target needs workspace context, resolve the artifact first and pass its `artifactId`.
- `validate-mixin` and `validate-project task="mixin"` use `input.mode="inline" | "path" | "paths" | "config" | "project"`.
- Positive integer tool arguments accept numeric strings such as `"10"` for documented top-level parameters.
- When a parameter has a fixed safe default, `tools/list` exposes it through the JSON Schema `default` field so clients can rely on schema metadata instead of prose notes.
- Retryable `suggestedCall` payloads omit parameters when the supplied value already matches the tool default, keeping recovery calls smaller without changing behavior.
- `ERR_CLASS_NOT_FOUND` errors from the class tools carry a top-level `didYouMean` array (parallel to `suggestedCall`) with ranked near-miss candidates from the artifact's symbol index: each entry is `{ className, matchReason }` where `matchReason` is `"exact-simple-name"` (same simple name in another package — the moved-class case, ranked first), `"case-insensitive"`, or `"edit-distance:N"`. Candidates come from the symbol index of the artifact the caller REQUESTED first, followed by any the artifact the lookup ended on contributes, deduplicated by FQN. A candidate found outside the requested artifact carries an extra `artifactId` naming where it was found; an entry WITHOUT that field is always from the artifact the caller asked about. The union matters because the requested artifact is, in the partial-source fallback scenario, the one with no `net.minecraft` symbols — which is why the fallback fired — so collecting from it alone returns `[]` in exactly the case the fallback exists to serve. Candidates are hints, never assertions that the class exists at the suggested location; the array is empty when neither index has anything usable. All same-simple-name FQNs are enumerated rather than collapsed. When an internal redirect resolved a different artifact while trying to answer the call — the binary fallback, or the nested-jar redirect that follows a shell jar's bundled inner jar — the error carries `details.fallbackArtifactId` naming it, alongside `details.binaryFallbackAttempted` for the binary case. `details.artifactId`, `details.mapping` and `details.qualityFlags` all describe the REQUESTED artifact, so identity, namespace and quality never disagree about which artifact is being reported. `fallbackArtifactId` and `binaryFallbackAttempted` are internal `AppError.details` fields for diagnosis and are NOT published on the wire; the envelope reports the requested artifact as `error.context.artifactId`.
- `find-class` searches the nested `.class` inventories of Jar-in-Jar shell artifacts such as the Fabric API umbrella JAR. It accepts simple or qualified names, returns dotted names for inner classes, deduplicates a class bundled more than once, and honors `limit`. The returned source path is inferred from the outer class. For top-level matches, `get-class-source` and `get-class-members` resolve the actual containing nested JAR before reading content; dotted inner-class matches are also readable through `get-class-source`.
- Source-oriented tools expose `artifactContents` so callers can tell whether the backing artifact is a `source-jar` or a `decompiled-binary`. `get-class-source`, `get-class-members`, `search-class-source`, and `get-artifact-file` also expose `returnedNamespace`.
- When `mapping` is omitted, `get-class-source`, `get-class-members`, and `batch-class-members` all inherit the mapping the target artifact was resolved with, and report it as `returnedNamespace`. The `mapping` parameter's advertised schema description still says the default is `obfuscated`; that wording is pinned by the frozen legacy `inputSchema` bytes and is accurate only for targets that carry no resolved mapping of their own. An explicit `mapping` is never overridden.
- Cache-backed source, mapping, validation, batch, and workflow tools accept `gradleUserHome?: string` when they need Loom cache data. Use it for builds that used an isolated `GRADLE_USER_HOME`; the server searches `<gradleUserHome>/loom-cache` and `<gradleUserHome>/caches/fabric-loom` before the MCP process default. The value selects a Gradle User Home, not arbitrary Loom cache roots.
- `get-class-members` returns `decompiledFallback` (with `constructors`, `fields`, `methods`, each entry is `{ name, line, kind }`) and `decompiledMemberCounts` whenever bytecode enumeration yields zero but the decompiled source for the class is already indexed. The bytecode-derived `members` / `counts` are preserved as-is; the fallback is additive and carries no descriptor or access modifier. `qualityFlags` gains `"members-from-decompiled-source"` in that case. Use `get-class-source` for descriptors and full context.
- `get-class-members` also returns an additive `status: "ok" | "members_unavailable" | "partial"` field so callers can distinguish "really 0 members" from "extraction unavailable":

  | `status` | When | Extra fields |
  | --- | --- | --- |
  | `"ok"` | `counts.total > 0`, OR `counts.total === 0` AND binary extraction succeeded AND `decompiledFallback` did not fire (genuinely empty class). | none |
  | `"partial"` | `decompiledFallback` is populated (bytecode returned zero but the indexed decompiled source supplied member names; `qualityFlags` includes `"members-from-decompiled-source"`). | `decompiledFallback`, `decompiledMemberCounts` |
  | `"members_unavailable"` | Binary signature extraction threw a non-`ERR_CLASS_NOT_FOUND` error AND no decompiled fallback was available. | `unavailableReason: string`, `suggestedCall: { tool: "get-class-source", params: { target: { kind: "artifact", artifactId }, className, mode: "snippet", mapping } }` (the params validate against `get-class-source`'s input schema). |

  The shape is purely additive: `members` / `counts` / `decompiledFallback` / `decompiledMemberCounts` / `qualityFlags` are unchanged for callers that ignore `status`. `ERR_CLASS_NOT_FOUND` still propagates as a thrown error rather than as `members_unavailable`. Set `MEMBERS_STATUS_LEGACY=1` at process start to omit `status` / `unavailableReason` / `suggestedCall` entirely (legacy shape).
- `search-class-source` accepts `queryNamespace`. When set and the artifact's `mappingApplied` differs, `intent="symbol"` queries for fully-qualified class names are translated through `find-mapping` (source=`queryNamespace`, target=artifact namespace) before the indexed search runs; the response carries a `translatedQuery` block describing the rewrite. `intent="text"` / `intent="path"` do not translate — text search is a literal match against the artifact namespace; the response surfaces a `warnings` array instead. `sourcePriority` is only consulted during translation.
- All expert and batch tools share the entry-tool **`detail`** (`summary` | `standard` | `full`) + **`include[]`** response contract (the per-tool `compact` boolean is gone). `summary` is the terse shape (drops diagnostics/empties, slims candidates), `standard` keeps fields but drops heavy diagnostics, `full` keeps everything. Per-tool defaults are chosen so the default response is unchanged: `resolve-artifact`, `find-mapping`, `resolve-method-mapping-exact`, `resolve-workspace-symbol`, `check-symbol-exists`, and the four `batch-*` tools default **`summary`**; `get-class-source`, `get-class-members`, `search-class-source`, and `list-artifact-files` default **`standard`**. (Migration: `compact: true` → `detail: "summary"`; `compact: false` → `detail: "full"`.)
- At `detail: "summary"`, empty arrays / null / empty objects are stripped. For `resolve-artifact` it also omits `provenance`, `artifactContents`, `sampleEntries`, `adjacentSourceCandidates`, `binaryJarPath`, `coordinate`, `repoUrl`, and `resolvedSourceJarPath` — `include: ["provenance"|"artifact"|"samples"|"candidates"|"paths"]` re-adds the matching field(s). For mapping tools, `summary` (1) omits the redundant `candidates` array on a single full-confidence exact-match resolution and (2) slims the tail to `{kind, symbol, owner, name, descriptor, confidence, matchKind}` with `candidateDetailsTruncated: true` when an unresolved result has more than three candidates; `include: ["candidates"]` keeps the full candidate list. `candidatesTruncated` keeps its independent meaning ("more candidates exist upstream than returned").
- `get-class-source` and `get-class-members` omit the diagnostic fields `provenance`, `artifactContents`, and `qualityFlags` at `detail: "summary"` and `detail: "standard"` (the lean common path). Pass `include: ["provenance"]` (or the legacy alias `includeProvenance: true`) or use `detail: "full"` to include all three. `detail: "summary"` additionally strips empty fields, and for `get-class-members` also strips `context`; `decompiledFallback` and `decompiledMemberCounts` are preserved. `search-class-source` and `list-artifact-files` omit `artifactContents` at `detail: "summary"` (re-add via `include: ["artifact"]`) — the primary `hits` / `items` payload is always preserved.
- `get-class-members` returns a slim member shape: `accessFlags` is dropped (modifiers are in `javaSignature`), `ownerFqn` is hoisted to a single block-level `members.ownerFqn` when all members share one owner (per-member only when `includeInherited` surfaces multiple owners), and **field** `jvmDescriptor` is omitted by default. Method/constructor `jvmDescriptor` is always present for overload disambiguation. Pass `include: ["descriptors"]` (or the legacy alias `includeDescriptors: true`) to also emit field descriptors.
- Windows and WSL path forms are normalized for `jarPath`, `projectPath`, and environment-variable path overrides.
- Heavy analysis tools are serialized in-process to protect stdio stability. Queue overflow returns `ERR_LIMIT_EXCEEDED`.
- All tools and JSON resources use the standard `{ result?, error?, meta }` envelope. `class-source` and `artifact-file` resources return raw text on success and structured JSON on failure.

## inspect-minecraft workspace focus

Use `subject.kind="workspace"` when `inspect-minecraft` should resolve Minecraft artifact context from a project. Its `focus` is a structured object, not a string:

| Focus shape | `task="auto"` dispatch | Explicit tasks |
| --- | --- | --- |
| `focus: { kind: "class", className: "..." }` | `class-overview` | `class-overview`, `class-source`, `class-members` |
| `focus: { kind: "search", query: "..." }` | `search` | `search` |
| `focus: { kind: "file", filePath: "..." }` | `file` | `file` |

`task="auto"` is structured dispatch based on `subject.kind` and `focus.kind`; it is not a natural-language planner and does not interpret prose. A string `focus` remains invalid and returns `ERR_INVALID_INPUT` with three schema-validated class/search/file `exampleCalls`; the server never guesses which object shape the text meant.

A workspace subject resolves through `target.kind="workspace"`, the same synthesizing target `resolve-artifact` uses for a directory, so version detection, the project's compile mapping, and the loader-derived scope all apply and `inspect-minecraft` and `resolve-artifact` return the SAME artifact for the same project. Previously `inspect-minecraft` re-derived a `{ kind: "version" }` target with no mapping; because the mapping feeds the remap gate and the mapping variant is hashed into the `artifactId`, that resolved a DIFFERENT artifact — and skipped Loom source-jar discovery. An explicit `subject.mapping` / `subject.scope` still wins, and `WORKSPACE_TARGET_OFF=1` restores the previous version-target routing.

Class source from a workspace:

```json
{
  "tool": "inspect-minecraft",
  "arguments": {
    "task": "class-source",
    "subject": {
      "kind": "workspace",
      "projectPath": "/path/to/workspace",
      "focus": {
        "kind": "class",
        "className": "net.minecraft.world.item.Item"
      }
    }
  }
}
```

Source search from a workspace:

```json
{
  "tool": "inspect-minecraft",
  "arguments": {
    "task": "auto",
    "subject": {
      "kind": "workspace",
      "projectPath": "/path/to/workspace",
      "focus": {
        "kind": "search",
        "query": "CreativeModeTab"
      }
    }
  }
}
```

Artifact-relative file read from a workspace:

```json
{
  "tool": "inspect-minecraft",
  "arguments": {
    "task": "auto",
    "subject": {
      "kind": "workspace",
      "projectPath": "/path/to/workspace",
      "focus": {
        "kind": "file",
        "filePath": "net/minecraft/world/item/Item.java"
      }
    }
  }
}
```

## Workspace and dependency target shapes

`resolve-artifact`, `get-class-source`, and `get-class-members` accept two synthesizing `target.kind` values in addition to the canonical `"version"` / `"jar"` / `"coordinate"` shapes. The synthesizer rewrites the call into one of those canonical shapes before downstream resolution, so behaviour from the resolver onward is unchanged.

| target shape | When to use | Required input | Result |
|---|---|---|---|
| `{ kind: "workspace", scope?, strict? }` | When the caller already passes a `projectPath` and wants the tool to detect Minecraft version, compile mapping, and loader from `gradle.properties` and `build.gradle(.kts)`. | `projectPath` | Synthesised to `{ kind: "version", value: <detected> }`. Scope precedence is `target.scope` → top-level `scope` → loader-derived default (`"merged"` when a loader is detected, `"vanilla"` otherwise). When the version is not detected, raises `ERR_WORKSPACE_VERSION_UNRESOLVED` regardless of `strict`. Detected facts surface on `provenance.workspaceResolution`. |
| `{ kind: "dependency", group, name, version?, versionFromProject? }` | When the caller wants to resolve a Maven-coordinate dependency (e.g. `dev.architectury:architectury`) without computing the exact version themselves. | `projectPath` (unless `version` is given) | Synthesised to `{ kind: "coordinate", value: "<group>:<name>:<version>" }`. The dependency JAR is treated as non-vanilla: binary remap is suppressed. When the caller asks for a non-obfuscated mapping the resolver returns the JAR with `mappingApplied: "obfuscated"` and `qualityFlags: ["dependency-mapping-unverified"]`, plus a warning that the caller must validate symbol availability. Resolution metadata appears on `provenance.dependencyResolution`. |

### Inspecting a Fabric / loader dependency like vanilla

To read members or source of a Fabric API (or any loader/Maven dependency) class
the same way you read vanilla, pass a `dependency` target straight to
`get-class-members` / `get-class-source` — no separate lookup tool is needed:

```jsonc
// members of a Fabric API class, version taken from the workspace
{
  "tool": "get-class-members",
  "className": "net.fabricmc.fabric.api.event.player.UseEntityCallback",
  "target": { "kind": "dependency", "group": "net.fabricmc.fabric-api", "name": "fabric-api", "versionFromProject": true },
  "projectPath": "/path/to/workspace"
}
```

Use an explicit `"version"` instead of `versionFromProject` when you already
know it. Because dependency JARs are not remapped, members come back in the
dependency's own namespace with `qualityFlags: ["dependency-mapping-unverified"]`;
treat the names as the JAR's compiled names. For repeated lookups against the
same dependency, call `resolve-artifact` once and reuse the returned
`artifactId` via `target: { kind: "artifact", artifactId }`.

Workspace detection is memoised in a process-resident `WorkspaceContextCache` (16-entry LRU, 5-minute TTL). The cache is observable through `manage-cache` with `cacheKinds: ["workspace"]`, and individual entries can be invalidated via `selector.projectPath`.

`target.kind="dependency"` resolution probes up to six de-duplicated `gradle.properties` keys in order — `name_version`, `snake_case(name)_version`, `camelCaseVersion`, `lastSegment(group)_name_version`, `snake_case(lastSegment(group)_name)_version`, and `camelCase(lastSegment(group)_name)Version`. Hyphens become underscores in the snake_case forms (`fabric-api` probes `fabric_api_version`); for hyphen-less names the snake_case forms deduplicate into the raw keys, leaving four. The probe falls back to the modules-2 cache layout `~/.gradle/caches/modules-2/files-2.1/<group>/<name>/`. Version tokens that contain path separators, `..`, NUL, control characters, or any character outside `[A-Za-z0-9._+-]` are rejected; in `gradle.properties` the rejection is recorded under `attempts[]` as `gradle.properties:<key>:rejected-unsafe-version` and the next key is tried. Snapshot and dev directories are excluded by default. The modules-2 fallback resolves directly when exactly one valid entry remains. When several entries remain and the dependency is a submodule of an umbrella package (artifact name differs from the group's last segment, e.g. `net.fabricmc.fabric-api:fabric-screen-handler-api-v1`), the declared umbrella version property (`fabric_api_version` / `fabricApiVersion`) locates the cached umbrella POM and the submodule adopts the version that POM names — the resolving response records `provenance.submoduleVersionSource: "umbrella-pom"` with the POM path in `provenance.source` (workspace-context-cache hits within the TTL return the cached version with `provenance.source: "workspace-context-cache"` instead). Umbrella properties are never adopted verbatim as a submodule's version. Every remaining ambiguity raises `ERR_DEPENDENCY_VERSION_UNRESOLVED` with `candidatesSeen` so a global cache cannot supply a version the workspace did not declare.

## Common Pitfalls

- Flat-`artifactId` tools (`find-class`, `get-artifact-file`, `list-artifact-files`, `search-class-source`, `index-artifact`) also accept the shared `target` shape (`{ kind: "version" | "jar" | "coordinate" | "artifact" | "dependency", ... }`) instead of `artifactId` — exactly one of the two must be supplied. The target is resolved (and ingested if needed) before the lookup, so a fresh `resolve-artifact` round-trip is unnecessary. `{ kind: "artifact", artifactId }` passes through directly. Targets that need workspace context beyond their own fields — `kind: "workspace"`, or `kind: "dependency"` without an explicit `version` — cannot supply a `projectPath` through these tools; resolve them with `resolve-artifact` first and pass the `artifactId`.
- `analyze-symbol` infers an omitted `version` from `projectPath` (gradle.properties `minecraft_version`/`mc_version`); the response then carries `versionInference { version, source }` and a warning. An explicit `version` always wins. `inspect-minecraft` direct subjects without `subject.artifact` auto-resolve only when exactly one workspace is known to the process (provenance warning attached); several candidates are refused with `workspaceCandidates`. That unique workspace is then resolved through `target.kind="workspace"` like any other workspace subject, so it picks up the project's compile mapping and loader scope; the separately detected Minecraft version is retained only as the "is this workspace usable at all" guard.

- Loom split-source workspaces publish a version as a `minecraft-common` / `minecraft-clientOnly` sources-jar pair with no merged jar. Version-target resolution indexes both halves (the companion jar appears in `provenance.companionSourceJars`), so client-only classes are queryable under the merged scope. If a class still cannot be found, the error's `exampleCalls` carries a `scope: "vanilla"` retry — the decompiled client jar also contains client-only classes.
- `mapping="mojang"` requires source-backed artifacts on legacy obfuscated versions. For unobfuscated releases such as `26.1+`, the runtime/decompile path is accepted directly for version and versioned-coordinate targets. When source jars are not available but the version's Mojang tiny mappings, the tiny-remapper jar, and `MappingService.checkMappingHealth` are all healthy, `resolve-artifact` with `target.kind="version"` will transparently tiny-remap the binary jar (`obfuscated -> mojang`) and decompile the result, and the response carries `qualityFlags` `"binary-remapped"` and `"decompiled"` plus `provenance.transformChain` `"binary-remap:obf->mojang"` and `"decompile:vineflower"`. Coordinate and jar targets are not eligible for this fallback and still surface `ERR_MAPPING_NOT_APPLIED`. Source-backed and obfuscated artifacts keep their existing `artifactId` hashes — only the new mojang-remapped variant lives in a separate cache slot.
- Mojang binary-remap cache entries live under `<cacheDir>/remapped`. `manage-cache` lists valid files plus corrupt directories and leftover temp entries under `cacheKinds: ["binary-remap"]`; corrupt entries carry `status: "corrupt"` and `meta.artifactId`, so callers can preview or apply cleanup with `selector.artifactId`.
- Jar-in-Jar shell jars (near-zero own classes with bundled `META-INF/jars/*.jar`, e.g. the Fabric API umbrella jar) no longer dead-end in `ERR_DECOMPILER_FAILED`. `resolve-artifact` detects the shell, skips decompilation, and returns the artifact with `qualityFlags: ["shell-jar"]` and the bundled inventory in `provenance.nestedJars`; `analyze-mod-jar` reports the same inventory as `nestedJars`. `get-class-source` / `get-class-members` lookups against a shell automatically redirect to the single nested jar containing the class and mark the response with `provenance.nestedJar` (`entryName` + `shellArtifactId`); a class found in several nested jars raises `ERR_NESTED_JAR_AMBIGUOUS` with `nestedJarCandidates` and per-candidate `suggestedCall` examples instead of picking one. Class-not-found errors on a shell carry the `nestedJars` inventory. The redirect is deliberately single-level: a nested jar that is itself a shell surfaces its own inventory when resolved directly as its own artifact. Extracted nested jars are content-addressed under `<cacheDir>/nested-jars`, observable through `manage-cache` with `cacheKinds: ["nested-jar"]`.
- `list-artifact-files` indexes Java source paths only — `assets/` and `data/` prefixes list nothing. Text files under those prefixes ARE retrievable by exact path with `get-artifact-file`: when the index has no row, the tool reads the entry directly from the backing jar (`deliveryMode: "jar-read-through"` marks such responses). This works for any artifact with a backing jar — vanilla client jars and mod jars alike; for Jar-in-Jar shells it reads the shell's own entries only (resolve a nested jar as its own artifact to reach its resources). Read-through delivery is text-only with a 512 KiB per-file cap (`truncated: true` beyond it); binary entries (e.g. `.png`, `.ogg`) answer with size metadata plus `contentOmittedReason` instead of content. Traversal-shaped paths (`..`, absolute) are rejected with `ERR_INVALID_INPUT`, and a miss returns `ERR_FILE_NOT_FOUND` with `nearbyPaths` naming same-named entries elsewhere in the jar (directory layouts move between versions, e.g. `assets/minecraft/models/item/*` → `assets/minecraft/items/*`).
- `search-class-source` defaults to `queryMode="auto"`. Use `queryMode="literal"` for explicit substring scans. `match="regex"` enforces `query.length <= 200` and caps results at `100`.
- `search-class-source` returns compact hits only. Use `get-artifact-file` or `get-class-source` to inspect returned files.
- `find-class` and `get-class-source` on `mapping="obfuscated"` expect Mojang obfuscated names. Deobfuscated queries warn and usually need `mapping="mojang"` or a `find-mapping` step first.
- `get-class-members` exposes `annotationDefault` on annotation-type members (the `default` value of an `@interface` member) whenever the classfile carries it, and accepts `includeAnnotations: true` to additionally list runtime-visible member annotations such as `@java.lang.Deprecated` per member. The leaner `names`/`signatures` projections drop annotation fields. `analyze-mod` `task="members"` includes both without a flag.
- On unobfuscated versions, `find-mapping`, `resolve-method-mapping-exact`, and `check-symbol-exists` report two structured `mappingContext` flags instead of per-response warning sentences (`get-class-api-matrix` reports a top-level `unobfuscatedRuntime: true` — its non-mojang columns are empty by design there): `unobfuscatedRuntime: true` replaces "Version X is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names.", and `runtimeValidated: true` replaces "Version X is unobfuscated; validated symbol existence against runtime bytecode." Do not pattern-match the old sentences.
- `check-symbol-exists` defaults to strict FQCN class lookup. Use `nameMode="auto"` for short class names.
- On unobfuscated versions, every `not_found` and `mapping_unavailable` verdict from the mapping graph — classes and fields included, not just methods — is re-validated against runtime bytecode before being returned, so a graph that lacks a record for a real symbol (e.g. `EntityType.ITEM`) no longer produces false negatives. Genuinely-missing symbols still return `not_found` after the runtime check. Bytecode-derived response contexts report `mappingNamespace: "mojang"` on unobfuscated versions instead of a hardcoded `"obfuscated"`.
- `check-symbol-exists` can use `signatureMode="name-only"` for overload discovery, but exact `descriptor` matching is still the most reliable path.
- Inherited-member expansion (`get-class-members` with `includeInherited: true`, and the `check-symbol-exists` runtime-bytecode fallback that reuses it) suppresses super-class and interface resolution warnings for platform packages that are never inside a Minecraft jar (`java.*`, `javax.*`, `jdk.*`, `sun.*`, `com.mojang.serialization.*`). A warning about any other unresolved super type — including `com.mojang.blaze3d.*` — is a real signal.
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
- `validate-mixin` defaults `reportMode="summary-first"`: it hoists shared provenance/warnings/incomplete reasons and drops per-result `resolvedMembers`/`toolHealth`/`structuredWarnings`. Pass `reportMode="full"` (or `explain=true`) to get per-result `resolvedMembers`/`toolHealth`/`resolutionTrace` back. For the leanest output combine `includeIssues=false`, `reportMode="compact"`, and `warningMode="aggregated"`.
- `validate-mixin` top-level failures expose `failedStage` as a first-class field on the serialized `error` envelope (alongside `code`, `hints`, `suggestedCall`) — one of `"input-validation" | "resolve" | "mapping-health" | "parse" | "target-lookup"`. Branch on that before inspecting `message` to recover automatically (e.g. retry `resolve` failures with `scope="vanilla"`, retry `target-lookup` failures with a different `mapping`). Nested errors that already carry a `failedStage` are preserved so upstream tags (e.g. from `resolve-artifact`) surface unchanged.
- `validate-mixin` per-result `quickSummary` appends `Scope fell back from "<requested>" to "<applied>" (<reason>).` when `provenance.scopeFallback` is set and `Mapping health degraded: <degradations>.` when `toolHealth.overallHealthy === false`. Clean validations keep the original one-line summary; the extra notes only attach when the pipeline actually fell back or detected a degraded mapping.
- `mapping-health` stays lightweight for `obfuscated` and `mojang` requests. It avoids full Tiny mapping graph loads unless the caller requests `intermediary` or `yarn`, where Tiny namespace availability is part of the health check.
- `validate-mixin` runs each stage (`resolve` / `mapping-health` / `parse` / `target-lookup`) against an independent soft-deadline. When the `target-lookup` stage exhausts its budget mid-loop, completed targets stay in `targetOutcomes` with `status: "ok"` (and `slowTarget: true` plus `elapsedMs` when the per-target soft cap was exceeded) while remaining targets land as `status: "deferred-budget"`. The summary then carries `targetsDeferredBudget` and `degradedReason: "stage-budget"`, and `validationStatus` is promoted to `"partial"`. If the budget is exhausted before the first iteration, `targetOutcomes` stays empty, `targetsDeferredBudget` is omitted, and `degradedReason: "stage-budget-pre-target"`.
- Empty Mixin configs are treated as warning-only discovery results with `summary.total=0` instead of invalid input; malformed JSON still returns `ERR_INVALID_INPUT`.

## verify-mixin-target

Single-call probe for "does this owner / member exist, and which `@Shadow` / `@Accessor` / `@Invoker` should the mixin use?" Use it before authoring a mixin to avoid round-tripping through `find-class`, `get-class-members`, and `validate-mixin`.

Input shape:

- `owner` — fully-qualified class name (e.g. `net.minecraft.world.entity.LivingEntity`).
- `member` — discriminated by `kind`. `{"kind":"method","name":"tick","descriptor":"()V"}` or `{"kind":"field","name":"airSupply"}`. `descriptor` is optional; when omitted, the tool returns every overload (methods) or any matching name (fields).
- `mixinMemberName` (optional) — the caller-authored mixin field/method name. Drives the `accessorAdvice` rule table when the target is private (`getXxx` / `setXxx` → `@Accessor`, `invokeXxx` / `callXxx` → `@Invoker`).
- `target` — same shape as `resolve-artifact.target`: `{"kind":"version","value":"1.21.10"}`, `{"kind":"workspace"}` (uses `projectPath`), `{"kind":"dependency","group":"...","name":"..."}`, `{"kind":"coordinate","value":"..."}`, or `{"kind":"jar","value":"..."}`.
- `mapping`, `sourcePriority`, `projectPath`, `scope`, `preferProjectVersion`, `strictVersion` — same semantics as `resolve-artifact`.

Output shape:

- `exists: boolean` — true when at least one member matches by name (and descriptor when supplied).
- `resolvedOwner: { className, mapping }` — echoes the resolved namespace.
- `matches: Array<{ name, descriptor, accessFlags[], javaSignature?, sourceLine? }>` — every member matching the request.
- `candidates: Array<{ name, descriptor, reason }>` — populated when `exists=false`. Two reasons are emitted: `"name match, descriptor … differs from requested …"` (descriptor mismatch) or `"name … is similar to requested …"` (Levenshtein-near misses, sourced from the same `suggestSimilar` helper used by the Mixin validator).
- `accessorAdvice` — annotation-recommendation block. Emitted only when `matches.length === 1` (a single unique match): descriptor-mismatch / nearest-neighbor / candidate-only responses carry no advice (rule table cannot be applied against an unmatched member), and ambiguous overload responses (descriptor omitted, multiple `matches[]`) also carry no advice (a single rule cannot describe several different targets). Re-call with an explicit `descriptor` to disambiguate the overload.
- `provenance: { artifactId, mappingNamespace, workspaceResolution?, dependencyResolution? }` — the workspace / dependency resolution shape from `resolve-artifact` is preserved when `target.kind` was `workspace` or `dependency`.

`accessorAdvice` rule matrix (top-down; first match wins):

| # | `member.kind` | target visibility | `mixinMemberName` regex | `suggestedAnnotation` |
|---|---|---|---|---|
| 1 | any | `public` / `protected` | (any) | `"@Inject-only"` (target already visible to mixin) |
| 2 | `field` | `private` | `^get[A-Z]\w*$` / `^set[A-Z]\w*$` / `^is[A-Z]\w*$` | `"@Accessor"` (target field name inferred via prefix removal) |
| 3 | `field` | `private` | (anything else, including absent) | `"@Shadow"` (or `"@Shadow @Final"` when target is `final`) |
| 4 | `method` | `private` | `^invoke[A-Z]\w*$` / `^call[A-Z]\w*$` | `"@Invoker"` |
| 5 | `method` | `private` | any other non-empty value | `"@Shadow"` |
| 6 | `method` | `private` | (absent) | `null` + `candidates: [@Shadow, @Invoker]` |

`"@Inject-only"` is a pseudo-tag, NOT a real Mixin annotation. It signals "no `@Shadow` is needed because the target is already accessible to the mixin"; the caller can use `@Inject` (or a direct method call) without declaring a shadow. `accessorAdvice.exampleSnippet` is a deterministic Java fragment built from the recommendation; the tool does NOT compile-check the snippet — run a Gradle build before committing.

Errors:

- Owner not found returns `ERR_CLASS_NOT_FOUND` with `details.suggestedCall.tool === "find-class"` and `details.suggestedCall.params.artifactId` pre-filled to the resolved artifact, so the caller can immediately re-probe with the correct simple-name query.
- Workspace targets without a detectable Minecraft version still raise `ERR_WORKSPACE_VERSION_UNRESOLVED` (inherited from `resolve-artifact`).
- Namespace mismatch raises `ERR_NAMESPACE_MISMATCH` when an explicit `mapping` argument differs from the resolved artifact's `mappingApplied`. The tool does NOT yet auto-translate `owner` / `member.name` / `descriptor` between namespaces; supply them in the artifact's namespace, or omit `mapping` so the resolver picks the namespace automatically. `details` carries `requestedMapping` and `mappingApplied` so callers can branch programmatically. Auto-translation (per-member name + descriptor remap matching the `get-class-members` flow) is a planned follow-up; until then the explicit error replaces silent `ERR_CLASS_NOT_FOUND` / `exists:false` regressions when the namespaces diverge.

Set `VERIFY_MIXIN_TARGET_OFF=1` at process start to remove the tool from `tools/list` entirely and reject direct calls. Use as a rollback path while the accessor-inference rules stabilize.

## Batch lookup contract

`batch-class-source`, `batch-class-members`, `batch-symbol-exists`, and `batch-mappings` share one envelope. Each call sends a fixed shortlist (1..50 entries) and receives a per-entry result plus an aggregate summary. The batch runs `entries.length` underlying calls but resolves the shared artifact ONCE (where applicable), so the round-trip cost is `1 resolve + N per-entry` rather than `N × (resolve + per-entry)`.

Common input fields:

- `entries: Array<...>` — 1..50 per-entry payloads. Tool-specific shape (see each subsection).
- `concurrency: number` (1..8, default 4) — passed to the worker pool. Above 8 is rejected with `ERR_INVALID_INPUT` (`fieldErrors[0].path === "concurrency"`).
- `failFast: boolean` (default `false`) — when `true`, the first per-entry error sets an abort flag. Workers that have not yet picked up an entry short-circuit with `error.code === "ERR_BATCH_ABORTED"`. **In-flight workers continue to completion** — they are not cancelled (no AbortSignal wiring). Already-completed `ok` entries are still returned in `results`.
- `detail: "summary" | "standard" | "full"` (default `summary`) + `include[]` — applies the same per-tool projection the corresponding single tool applies at that detail level to each entry's `result`. `detail: "summary"` matches the old `compact: true` per-entry shape; `detail: "full"` matches the old `compact: false` (byte-identical to the single tool's full output).
- Per-tool shared inputs (`target`, `mapping`, `projectPath`, `version`, etc.) follow the same shape as the matching single tool.

Resource behavior: `concurrency` limits per-entry dispatch for one batch call. Within one MCP server process, entries or calls that need the same artifact index or decompiled fallback share the in-flight rebuild by `artifactId`. Separate MCP server processes sharing the same cache are not coordinated by this process-local guard.

Common output:

```json
{
  "results": [
    {
      "index": 0,
      "status": "ok",
      "result": { ... single-tool-result-shape ... },
      "warnings": ["..."],
      "durationMs": 12.34
    },
    {
      "index": 1,
      "status": "error",
      "error": {
        "code": "ERR_CLASS_NOT_FOUND",
        "detail": "...",
        "suggestedCall": { "tool": "get-class-source", "params": { ... } }
      },
      "warnings": [],
      "durationMs": 5.6
    }
  ],
  "summary": {
    "total": 2,
    "ok": 1,
    "error": 1,
    "sharedArtifactId": "...",
    "sharedArtifactProvenance": { ... }
  }
}
```

Per-entry retry semantics: each `error.suggestedCall` proposes the **matching single tool**, never the batch tool itself. The retry mapping is fixed:

| Batch tool | Single tool retry |
|---|---|
| `batch-class-source` | `get-class-source` (with `target: { kind: "artifact", artifactId: <shared> }`) |
| `batch-class-members` | `get-class-members` (with `target: { kind: "artifact", artifactId: <shared> }`) |
| `batch-symbol-exists` | `check-symbol-exists` (with `version` derived from the resolved artifact) |
| `batch-mappings` | `find-mapping` (with `version` carried from the top-level batch input) |

Every per-entry `suggestedCall` is validated through the same `tool-schema-registry` gate as single-tool errors (see `## Errors → suggestedCall schema validation gate`).

If the **shared resolution itself** fails (e.g. `target.kind="version"` with an unknown version), the batch returns a top-level error envelope (no `results[]`). `failFast` does not apply because no entries ran.

Rollback: `BATCH_TOOLS_OFF=1` removes all four batch tools from `tools/list`. Direct `tools/call` for any of them is answered per era: legacy clients receive a SUCCESSFUL tool-result envelope (`{ content: [{ type: "text", text: "MCP error -32602: Tool <name> not found" }], isError: true }`, no `structuredContent` key), while modern clients receive a raw JSON-RPC `-32602` error (see `## MCP Protocol Support` → Rejection and error table). Neither shape carries `ProblemDetails`, so callers cannot rely on `error.code === "ERR_*"` for disabled tools.

### batch-class-source

Read source for many classes against one shared resolved artifact. Per-entry: `{ className, mode?, startLine?, endLine?, maxLines?, maxChars?, outputFile? }`. Shared: `target`, `mapping`, `projectPath`, `scope`, `preferProjectVersion`, `strictVersion`, `allowDecompile`. Result shape per entry mirrors `get-class-source`. Duplicate `className` entries each run independently — no de-duplication.

### batch-class-members

List members for many classes against one shared resolved artifact. Per-entry: `{ className, access?, includeSynthetic?, includeInherited?, memberPattern?, maxMembers? }`. Shared inputs match `batch-class-source`. Result shape per entry mirrors `get-class-members`, including the `status` field (`"ok"` / `"partial"` / `"members_unavailable"`).

### batch-symbol-exists

Probe symbol existence for many entries against one shared Minecraft-version artifact. Per-entry: `{ kind: "class" | "field" | "method", name, owner?, descriptor?, nameMode?, signatureMode?, maxCandidates? }`. Shared: `target`, `mapping`, `projectPath`, `scope`, `preferProjectVersion`, `strictVersion`, `allowDecompile`. **`target.kind` is restricted to `"workspace"` or `"version"`** — `dependency` / `jar` / `coordinate` resolve to artifacts whose `provenance.version` is the library's own version (e.g. an Architectury or mod-loader version), NOT a Minecraft version, so querying the Minecraft mapping graph with that string would be a category error. The schema rejects the disallowed kinds with `ERR_INVALID_INPUT`. The shared Minecraft version is derived from `sharedArtifact.version` (version target) or `provenance.workspaceResolution.detected.minecraftVersion` (workspace target). When neither populates, the batch raises `ERR_WORKSPACE_VERSION_UNRESOLVED` at the resolution stage.

### batch-mappings

Translate symbols across mapping namespaces with one shared Minecraft version. Per-entry: `{ kind, name, owner?, descriptor?, sourceMapping, targetMapping, signatureMode?, disambiguation?, maxCandidates? }`. Shared: top-level `version` (required) plus `sourcePriority` / `projectPath`. Per-entry `version` is rejected with an `unrecognized_keys` zod issue; the batch shape is intentionally single-version. There is no shared artifact resolution — each entry hits the mapping graph directly — so `summary.sharedArtifactId` is omitted.

## Typed NBT document shape

`json-to-nbt` and `nbt-apply-json-patch` take a `typedJson` argument whose advertised JSON Schema is the empty object `{}`. Those bytes are pinned for legacy wire parity and cannot change, so the required shape is documented here instead — the same workaround already applied to `get-class-members.mapping`. A `typedJson` that does not match is rejected with `ERR_NBT_INVALID_TYPED_JSON`.

A document is:

```jsonc
{
  "rootName": "Level",            // string; the NBT root compound's name (may be "")
  "root": { "type": "compound", "value": { /* nodes */ } }
}
```

Every node is `{ "type": <nbt-type>, "value": <payload> }`, where `<nbt-type>` is one of `byte`, `short`, `int`, `long`, `float`, `double`, `byteArray`, `string`, `list`, `compound`, `intArray`, `longArray`. Payloads by type:

| `type` | `value` | Notes |
| --- | --- | --- |
| `byte` / `short` / `int` | number | Integer, in the JVM range for that width (`byte` is signed, −128..127). |
| `long` | **string** | Decimal digits, `-9223372036854775808`..`9223372036854775807`. Never a JSON number. |
| `float` / `double` | number, or the strings `"NaN"` / `"Infinity"` / `"-Infinity"` | A raw non-finite JSON number is rejected; use the string sentinels. |
| `string` | string | |
| `byteArray` / `intArray` | number[] | Each element must fit the element width. |
| `longArray` | string[] | Same decimal-string rule as `long`. |
| `list` | node[] | Also carries `"elementType"`: any node type, and every element's `type` must equal it. `"end"` is allowed only for an empty list. |
| `compound` | object of name → node | Keys are the NBT tag names. |

Rejections name the offending node twice: `error.fieldErrors[0].path` is the RFC6901 JSON pointer into the document (for example `/root/value/health/value`, `typedJson` when the whole document is wrong), and `error.hints` states the expected and received types plus this shape. `error.exampleCalls[0]` points at `nbt-to-json`, which produces a document this format accepts from any real NBT payload — the reliable way to obtain a valid `typedJson` to edit.

## Errors

`ProblemDetails.code` may carry the codes below in addition to the existing tool-specific values.

- `ERR_WORKER_RESTART` — Synthetic envelope produced when the worker exits during `tools/call`, replacement startup or initialization replay fails, or live process-tree cleanup leaves the supervisor unable to start a worker. The response is a `CallToolResult` with `isError: true` and `structuredContent.error.code === "ERR_WORKER_RESTART"`. `structuredContent.meta.synthetic === true` and `meta.restart` records `tool` / `durationMs` / `lastStage` / `lastStageElapsedMs` / `lastStageMeta` / `exit` / `retryRecommendation` so the caller can decide whether to retry, narrow the input, clear caches, or report a bug. Non-`tools/call` requests receive the legacy raw JSON-RPC `-32603` envelope.
- `ERR_TOOL_TIMEOUT` — Synthetic `CallToolResult` produced only for `validate-project` when its supervisor-owned end-to-end deadline expires. The default is 120,000 ms and includes supervisor queue time. `meta.timeout.phase` is `"queue"` when the call expired before dispatch and `"running"` after dispatch. A queue timeout does not restart the worker; a running timeout isolates the worker process tree, initiates replacement, and sets `meta.timeout.workerRestartInitiated: true`. Cancellation suppresses the timeout result while retaining the deadline for worker cleanup.
- `ERR_MIXIN_PARSE_FAILED` — Reserved code for `validate-mixin` parse-stage failures in single / inline mode. Today the runtime parser is permissive (no hard parse failure path), but emitting this code keeps the contract stable for future strict-parse modes.
- `ERR_STAGE_BUDGET_PRE_PARSE` — Raised when a pre-parse stage (`resolve`, `mapping-health`, or `parse` itself) exhausts its independent soft-deadline before validation can proceed. The error carries `failedStage: <stage name>`, `meta.stageBudgetExhausted: true`, and the `budgetMs` / `elapsedMs` for the offending stage. Recovery: shrink `mixinConfigPath` (e.g. validate one config file at a time) or set `MIXIN_STAGE_BUDGETS_OFF=1` to disable budgets for diagnostic reruns.
- `ERR_WORKSPACE_VERSION_UNRESOLVED` — Raised by `resolve-artifact`, `get-class-source`, `get-class-members`, and `inspect-minecraft` (workspace subject, every artifact-context task) when `target.kind="workspace"` cannot detect a Minecraft version from `gradle.properties`. Both `strict: true` and `strict: false` raise; `details.strict` records which value was supplied. The error carries `details.projectPath` and a `suggestedCall` with `target: { kind: "version", value: "<your-mc-version>" }` so the caller can fall back to an explicit version target.
- `ERR_DEPENDENCY_VERSION_UNRESOLVED` — Raised by the same three tools when `target.kind="dependency"` cannot infer a version from `gradle.properties` or `~/.gradle/caches/modules-2/files-2.1/<group>/<name>/`. Multiple non-snapshot entries in modules-2 also raise this error: the synthesizer refuses to pick without project-specific evidence, sets `details.ambiguous=true`, and lists the cached versions in `details.candidatesSeen`. The error carries `details.attempts` (the gradle.properties keys that were probed) plus a `suggestedCall` with `target: { kind: "dependency", group, name, version: "<your-version>" }`.

### `suggestedCall` schema validation gate

Every `ProblemDetails.suggestedCall` payload an agent receives is validated against the registered `zod` schema for the named tool BEFORE it leaves the process. Invalid payloads (e.g. a `target.value` that holds a JSON-stringified inner target — the bug in v3 chains where round-tripping the suggestion produced `ERR_INVALID_INPUT`) are dropped from the published envelope.

The gate drops a primary suggestion for TWO reasons, and both are reported the same way. Either the payload failed schema validation, or — the common case — the guidance handed the gate a TEMPLATE whose values are still `<...>` placeholders, which is by design and never reached the schema at all. Whenever a primary suggestion is dropped and no `suggestedCall` survives, `error.hints` gains the literal sentence `"suggested call payload failed schema validation; using fallback examples"`. Read that sentence as "no directly-replayable suggestion is being published", not as evidence that a schema check failed: it is emitted for the placeholder-template case too. It also does NOT mean the envelope is empty of guidance — it coexists with `exampleCalls[]`, and in practice every recorded tool-contract envelope that carries the sentence also carries `exampleCalls`. Branch on the presence of `suggestedCall` / `exampleCalls`, never on this text.

The wording is deliberately retained verbatim even though it is inaccurate for the placeholder case: it is frozen inside the pre-migration envelope evidence under `tests/fixtures/premigration/` (six tool-contract envelope samples and four ProblemDetails goldens), which was captured against an untouched pre-migration build and cannot be re-recorded. Rewording the sentence — or splitting the single drop marker into two — breaks those goldens with no way to regenerate them. Fix the reader, not the string.

The optional `error.exampleCalls?: Array<{ tool: string; params: Record<string, unknown>; reason: string }>` field carries one or more alternative payloads when the primary is dropped. Each entry is **schema-valid**: it names a real tool and passes that tool's registered schema, so the argument names and types are right. It is NOT necessarily replayable as-is. Examples are explicitly permitted to be TEMPLATES — the same `<...>` placeholders that cause a primary `suggestedCall` to be dropped are allowed to survive here, because an example's job is to show the shape when no fillable suggestion exists. Recorded envelopes carry such templates today (the `analyze-mod` sample publishes `subject.jarPath: "<mod-jar-path>"`, and the typed-NBT recovery example publishes `nbtBase64: "<base64-encoded-nbt-payload>"`, which the NBT pipeline would reject as invalid base64 if sent verbatim). Scan the params for `<...>` values and fill them before sending; only `suggestedCall` is guaranteed placeholder-free.

`suggestedCall.params` is published **byte-identical** to the caller-supplied object — the gate validates emit-vs-drop only and never injects schema defaults into the published payload. Internal consumers that want the schema-normalized form read `validateToolParams(name, params).data` directly from `tool-schema-registry`.

## Meta fields

- `meta.restart` (synthetic worker-restart responses only) — emitted exclusively when the supervisor returns an `ERR_WORKER_RESTART` envelope. Shape: `{ tool, durationMs, lastStage, lastStageElapsedMs, lastStageMeta, exit: { code, signal }, retryRecommendation }`. `retryRecommendation` is one of `"narrow-query" | "clear-cache" | "report-bug" | "same-request"`, decided by the supervisor from `lastStage`, `exit.signal`, and the recent restart cadence (3 restarts within 60 s of the same tool → `"report-bug"`).
- `meta.timeout` (`ERR_TOOL_TIMEOUT` only) — exact shape: `{ tool: "validate-project", phase: "queue" | "running", durationMs, deadlineMs, lastStage, lastStageElapsedMs, lastStageMeta, redactedToolArgs, redactedToolArgsModified, retryRecommendation, workerRestartInitiated }`. Stage and argument diagnostics use the supervisor's bounded redaction rules. `workerRestartInitiated` reports initiation only; it does not claim that replacement startup or initialization replay completed.
- `meta.queue` (supervisor queue overflow only) — `{ reason: "supervisor-request-queue", maxQueued: 2, queuedCount: 2 }`. The FIFO retains at most two total worker-bound requests; a queued `validate-project` barrier consumes one slot, while a running barrier is outside the FIFO. Overflowing `tools/call` receives a synthetic `ERR_LIMIT_EXCEEDED` result. An overflowing non-tool request receives raw JSON-RPC `-32000` with message `"MCP supervisor request queue is full."`; notifications do not consume slots.
- Replacement startup/replay uses a 10–30 second internal watchdog and bounded retry backoff. Successful replay releases queued work. Spawn, pre-ready, replay, or watchdog failure terminalizes queued requests with the existing worker-restart response shapes. At the two-slot live-generation cap, new worker-bound requests, including `initialize`, fail immediately instead of entering the FIFO; notifications that cannot be delivered are emitted as structured supervisor warnings and dropped. Tree-cleanup helper attempts are bounded to five seconds so recovery and shutdown cannot wait forever on `taskkill` or an equivalent platform operation. On POSIX, `ESRCH` while signaling the saved process group means the group is already gone and is treated as completed cleanup.
- `meta.stageBudgetExhausted` (`ERR_STAGE_BUDGET_PRE_PARSE` errors only) — set to `true` to flag that the failure is budget-driven rather than a genuine resolve / mapping-health / parse error. Pair with `failedStage` and `error.detail` (`"Stage <name> exhausted budget before parse completed."`) for diagnostics. The companion fields `meta.budgetMs` (the stage budget that was exceeded) and `meta.elapsedMs` (the actual stage elapsed time) are emitted alongside it on the same envelope so callers can decide between retry, input-shrink (`mixinConfigPath`), or `MIXIN_STAGE_BUDGETS_OFF=1` rollback without parsing message text.
- `validate-mixin` batch-mode entries (`results[i]`, when invoked with `input.mode = "paths" | "config" | "project"`) preserve typed error metadata when an entry fails: optional `errorCode` (e.g. `"ERR_STAGE_BUDGET_PRE_PARSE"`) and `errorDetails` (the `failedStage` / `stageBudgetExhausted` / `budgetMs` / `elapsedMs` shape from the underlying AppError) sit alongside the legacy `error` string. The shape is additive — callers that only read `error` continue to see the same human-readable message.

## Operational toggles

These environment variables are read once at worker startup and provide rollback paths to legacy behaviour. Switching them requires reconnecting the MCP server (no per-request override).

| Env | Effect | Acceptance test |
|---|---|---|
| `MIXIN_STAGE_BUDGETS_OFF=1` | Sets every `validate-mixin` stage budget (including the per-target soft cap) to `Number.POSITIVE_INFINITY`. Restores the pre-budget run-to-completion behaviour. | `tests/source-service-validate-mixin-budget.test.ts` (`MIXIN_STAGE_BUDGETS_OFF=1 disables all budgets`) |
| `SUPERVISOR_STRUCTURED_RESTART_OFF=1` | Suppresses synthetic `CallToolResult` envelopes; `tools/call` requests killed by a worker exit fall back to the legacy raw JSON-RPC `-32603` error. | `tests/stdio/stdio-supervisor.test.ts` (`buildWorkerRestartReply returns raw -32603 when structuredRestartDisabled`) |
| `MIXIN_STAGE_PROGRESS_OFF=1` | Replaces the worker stage emitter with a no-op so `$/stageUpdate` notifications are never sent. Use as a fallback when the active SDK build does not surface `extra.requestId`. | `tests/stage-emitter.test.ts` (`makeStageEmitter is a no-op when disabled option is true`) |
| `WORKSPACE_TARGET_OFF=1` | Rejects `target.kind="workspace"` on `resolve-artifact`, `get-class-source`, and `get-class-members` with `ERR_INVALID_INPUT`. Restores the pre-workspace-target behaviour where callers must always supply `target.kind="version"`/`"jar"`/`"coordinate"`. | `tests/source-service-workspace-target.test.ts` (`synthesizeWorkspaceTarget rejects target.kind=workspace when WORKSPACE_TARGET_OFF is set`) |
| `DEPENDENCY_TARGET_OFF=1` | Rejects `target.kind="dependency"` on the same three tools with `ERR_INVALID_INPUT`. | `tests/source-service-dependency-target.test.ts` (`synthesizeDependencyTarget rejects target.kind=dependency when DEPENDENCY_TARGET_OFF is set`) |
| `WORKSPACE_FALLBACK_LEGACY=1` | Forces the `ERR_MAPPING_NOT_APPLIED` `suggestedCall` back to the pre-workspace shape (`{ target, mapping: "obfuscated" }` with the legacy scope flip on `vanilla`+`mojang`). Use when an integration relies on the legacy retry payload. | `tests/source-service-mapping-not-applied-fallback.test.ts` (`buildMappingFallbackSuggestedCall returns the legacy obfuscated retry when WORKSPACE_FALLBACK_LEGACY is set`) |
| `VALIDATE_PROJECT_TASKS_OFF=1` | Omits the additive `tasks` per-probe status report from `validate-project task="project-summary"` results. The headline `result.summary.status`, `result.project`, and `result.workspace` blocks are unchanged. Use as a rollback path while the per-probe contract stabilizes. | `tests/entry-tools-validate-project-tasks.test.ts` (`validate-project tasks A5: VALIDATE_PROJECT_TASKS_OFF=1 omits the tasks field`) |
| `MEMBERS_STATUS_LEGACY=1` | Omits the additive `status` / `unavailableReason` / `suggestedCall` fields from `get-class-members` results. Restores the pre-status response shape for callers that pre-date the new enum. | `tests/source-service-get-class-members-status.test.ts` (`B7: MEMBERS_STATUS_LEGACY=1 strips the new fields`) |
| `VERIFY_MIXIN_TARGET_OFF=1` | Removes `verify-mixin-target` from `tools/list` and rejects direct invocations with `ERR_INVALID_INPUT`. Use as a rollback path while the accessor-inference rules stabilize. | `tests/entry-tools-verify-mixin-target.test.ts` (`C11: VERIFY_MIXIN_TARGET_OFF=1 hides the tool from tools/list and rejects direct calls`) |
| `SUGGESTED_CALL_VALIDATE_OFF=1` | Bypasses the `ProblemDetails.suggestedCall` schema validation gate. Raw caller-supplied payloads are emitted unchanged (matching the pre-gate behaviour); `error.hints` does not gain the fallback line. Use only as an emergency rollback if the gate causes unexpected drops in production. | `tests/build-suggested-call.test.ts` (`D11: SUGGESTED_CALL_VALIDATE_OFF=1 bypasses validation`) |
| `BATCH_TOOLS_OFF=1` | Removes the 4 batch lookup tools (`batch-class-source`, `batch-class-members`, `batch-symbol-exists`, `batch-mappings`) from `tools/list`. Direct calls answer per era: legacy gets the successful `isError: true` "Tool not found" envelope, modern gets a raw JSON-RPC `-32602` (no `ProblemDetails` in either shape; see `## MCP Protocol Support`). Use as an emergency rollback while the batch contract stabilizes. | `tests/manual/stdio-client-smoke.manual.ts` (`runBatchToolsOffProbe`); `tests/stdio/stdio-error-code-inventory.test.ts` |


## Migration Notes

- Start with `inspect-minecraft` for version, artifact, class, file, and search workflows before dropping to `list-versions`, `resolve-artifact`, `get-class-source`, `get-class-members`, `search-class-source`, `get-artifact-file`, or `list-artifact-files`.
- Start with `analyze-symbol` for symbol mapping, existence, lifecycle, workspace, and API overview workflows before using `find-mapping`, `resolve-method-mapping-exact`, `check-symbol-exists`, `trace-symbol-lifecycle`, `resolve-workspace-symbol`, or `get-class-api-matrix` directly.
- `analyze-symbol task="lifecycle"` accepts `fromVersion`/`toVersion`/`maxVersions`/`includeTimeline`/`includeSnapshots` (lifecycle-only; rejected on other tasks). The legacy `version` field is a back-compat alias for `toVersion` (range end). The default scan window is the service default of 120 versions (max 400); pass `maxVersions: 5` for the old narrow window. Use `trace-symbol-lifecycle` directly only for parity with the expert tool.
- `analyze-symbol` `subject.kind` accepts `"symbol"` to auto-detect the concrete kind from the selector (owner+descriptor ⇒ method, owner only ⇒ field, otherwise ⇒ class); the inferred kind is surfaced as a warning. For `task="api-overview"` the inferred kind is always class.
- Start with `compare-minecraft` for version-pair, class diff, registry diff, and migration-summary flows before using `compare-versions`, `diff-class-signatures`, or `get-registry-data` directly.
- Start with `analyze-mod` for metadata-first mod inspection and safe remap preview/apply flows before using `analyze-mod-jar`, `decompile-mod-jar`, `get-mod-class-source`, `search-mod-source`, or `remap-mod-jar` directly.
- `analyze-mod` `task="members"` (subject `{ kind: "class", jarPath, className }`) reads a mod class's constructors/fields/methods (all access levels, including private and protected) straight from bytecode — no decompiler runs on this path, unlike `task="class-source"` which costs a full decompile. Responses mark `extractionMethod: "bytecode-only"`; a class missing from the jar returns `ERR_CLASS_NOT_FOUND`.
- Start with `validate-project` for workspace summaries and direct Mixin, Access Widener, or Access Transformer validation before using `validate-mixin`, `validate-access-widener`, or `validate-access-transformer` directly.
- `validate-project task="project-summary"` discovers mixins and access wideners by default. Add `discover: ["access-transformers"]` when you also want Access Transformer files included in the workspace summary.
- `validate-project task="project-summary"` returns an additive `tasks` field alongside the existing aggregate `result.summary` / `result.project` blocks. The headline `result.summary.status` is unchanged; the new field reports per-probe status so a `status: "blocked"` headline still preserves which probes succeeded.

  | Probe key | What it checks | `status: "ok"` evidence | Other states |
  | --- | --- | --- | --- |
  | `workspace.detected` | A `gradle.properties`, `settings.gradle{,.kts}`, or `build.gradle{,.kts}` file exists at `subject.projectPath`. | `evidence: ["gradle.properties", ...]` lists the gradle files that were found. | `missing` when no gradle files exist; `error` when the filesystem read itself failed. |
  | `gradle.readable` | `gradle.properties` can be read and the workspace's gradle build scripts are enumerable. | `propertiesPath` and `buildScripts[]` (relative paths). | `skipped` when `workspace.detected` is not `ok`; `missing` when no gradle files at all; `error` on parse / read failure. |
  | `loom.cache.found` | A Loom (Fabric / Quilt) cache directory exists under the workspace, `gradleUserHome`, or the process `GRADLE_USER_HOME`. It is independent of `workspace.detected`, so callers can detect a global Loom cache even on non-Gradle workspaces. | `cachePath` of the first matching directory. | `missing` when none of the candidate roots exist; `error` on filesystem failure. |
  | `minecraft.artifact.resolved` | A lightweight artifact metadata probe can locate `target: { kind: "version", value: <resolvedVersion> }` against the workspace context. The probe does not decompile Minecraft or rebuild the source index. | `artifactId` and `mappingApplied`. | `skipped` when `workspace.detected` or `gradle.readable` is not `ok`; `error` when the lightweight probe cannot verify the artifact or requested mapping without full resolution (carries `error.code` and `error.detail`). |
  | `mixins.validated` | At least one `*.mixins.json` file was discovered AND every per-config validation completed without throwing. | `counts: { ok, partial, invalid }` (validation outcomes from `validate-mixin`). | `error` when any per-config validation threw (still emits `counts`); `skipped` when discovery was empty AND `workspace.detected` / `gradle.readable` blocked; `missing` when discovery returned 0 paths and upstream probes were `ok`. A failed `minecraft.artifact.resolved` does not flip executed validators to `skipped`. |
  | `accessWideners.validated` | At least one Access Widener file was discovered AND every validation completed without throwing. | `counts: { ok, invalid }`. | Same rules as `mixins.validated`. |
  | `accessTransformers.validated` | At least one Access Transformer file was discovered AND every validation completed without throwing. | `counts: { ok, invalid }`. | Same rules as `mixins.validated`. |

  Status precedence (top wins): `error` (item-level caught) > `ok` (validators ran) > `skipped` (upstream env blocked AND no items ran) > `missing` (no items, upstream `ok`).

  Output projection: with `detail: "summary"` (or when `include` does not contain `"workspace"`), each `tasks[*]` entry is slimmed to `status`, `error?`, and `warnings?` only — `evidence` / `buildScripts` / `counts` / `propertiesPath` / `cachePath` / `artifactId` / `mapping` / `durationMs` are stripped. With `detail: "full"` (or `"standard"`) AND `include` containing `"workspace"`, every sub-field is preserved. Set `VALIDATE_PROJECT_TASKS_OFF=1` at process start to omit the field entirely (legacy shape). Use `resolve-artifact` directly when a follow-up source lookup needs a fully indexed artifact.
- `validate-access-widener` keeps vanilla validation when `projectPath`, `scope`, and `preferProjectVersion` are omitted. Supplying Loom workspace context switches it into runtime-aware mode, which returns `provenance` and per-entry runtime access evidence without changing the existing summary shape.
- `validate-access-transformer` accepts `atNamespace="srg" | "mojang" | "obfuscated"`. When `projectPath` points at a Forge or NeoForge workspace, the tool can infer that namespace automatically and validate against loader/runtime artifacts for `scope="loader"`.
- Start with `manage-cache` for cache inventory and safe cleanup. Use `executionMode="preview"` before `executionMode="apply"`.
- Replace `resolve-artifact` `targetKind` and `targetValue` with `target: { kind, value }`.
- Replace `get-class-source` and `get-class-members` top-level `artifactId`, `targetKind`, and `targetValue` with `target: { kind, value }` (same shape as `resolve-artifact`) or `target: { kind: "artifact", artifactId }`. The earlier `target: { type: "artifact", artifactId }` form is gone — use `{ kind: "artifact", artifactId }`; the redundant `{ type: "resolve", ... }` wrapper is still accepted but `type` is ignored.
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
| `class-source` | `mc://source/{artifactId}/{className}` | Java source code for a class within a resolved artifact (raw text). |
| `class-source-json` | `mc://source-json/{artifactId}/{className}` | Full class source plus metadata (`artifactId`, `mappingApplied`, `totalLines`, `returnedRange`, `provenance`, `warnings`) as a structured JSON envelope — easier to cite and continue than the raw-text `class-source`. |
| `artifact-file` | `mc://artifact/{artifactId}/files/{filePath}` | Raw content of a file within a resolved artifact |
| `find-mapping` | `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}` | Look up a **class** mapping between two naming namespaces. The URI carries no `owner`, so use `find-member-mapping` (or the `find-mapping` tool) for field/method lookups. |
| `find-member-mapping` | `mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{owner}/{name}` | Look up a **field or method** mapping, including the `owner` class the member belongs to. For exact method overload resolution use the `find-mapping` tool with a `descriptor`. |
| `class-members` | `mc://artifact/{artifactId}/members/{className}` | List constructors, methods, and fields for a class |
| `artifact-metadata` | `mc://artifact/{artifactId}` | Metadata for a previously resolved artifact |

`versions-list`, `runtime-metrics`, `find-mapping`, `find-member-mapping`, `class-source-json`, `class-members`, and `artifact-metadata` return structured JSON envelopes on success (`{ result, meta }`) and failure (`{ error, meta }`).

`class-source` and `artifact-file` keep raw text responses on success, but still return structured JSON errors on failure.

## Response Envelope

All tools return exactly one of:

- Success: `{ result: { ... }, meta: { requestId, tool, durationMs, warnings[] } }`
- Failure: `{ error: { type, title, detail, status, code, instance, fieldErrors?, hints? }, meta: { requestId, tool, durationMs, warnings[] } }`

Tools may publish execution counters on `meta` alongside the fields above. The NBT tools use this: `nbt-apply-json-patch` surfaces `appliedOps`, `testOps`, and `changed`; `json-to-nbt` surfaces `outputBytes` and `compressionApplied`; `nbt-to-json` surfaces `inputBytes` and `compressionDetected`.

JSON resources follow the same `result/error/meta` pattern. Text resources return plain text on success.

The same JSON envelope is mirrored in MCP `structuredContent` for SDK-aware clients, and failures also set `isError=true`.

The application-level `meta` field above is distinct from protocol-level `_meta`. Modern-era protocol fields (`resultType`, `ttlMs`, `cacheScope`, and the `io.modelcontextprotocol/serverInfo` identity echo in result `_meta`) sit at the MCP protocol result level, outside the application envelope, and appear only for modern-era clients (see `## MCP Protocol Support`).

## MCP Protocol Support

The stdio server implements MCP protocol revision `2026-07-28` and keeps the legacy initialize-based protocol fully supported in the same process. One process serves exactly one era; the first valid era signal selects it.

### Era selection

- A process starts with no era selected.
- `initialize` selects the LEGACY era. Any `io.modelcontextprotocol/*` era-claim keys inside `initialize` `params._meta` are ignored for classification and stripped before the frame reaches the worker (other `_meta` keys pass through), so a hybrid client that attaches a modern claim to `initialize` still completes the legacy handshake.
- A request whose `params._meta` carries BOTH `io.modelcontextprotocol/protocolVersion` (string) and `io.modelcontextprotocol/clientCapabilities` (object) selects the MODERN era. Selection is shallow: the era signal is a shape check only. The version VALUE is validated by the SUPERVISOR on EVERY modern request, so an unsupported version string still locks modern and then answers `-32022` — on that request and on every later one, regardless of which method pinned the connection.
- The lock is one-way and survives internal worker restarts. There is no era-switch method; switching eras requires a fresh process (see the recovery sequence below).
- `server/discover` is era-neutral: it never selects an era. Per-state outcomes are in the rejection table.
- An ordinary request received before any era signal is rejected with `-32602` `data.kind: "missing_meta"`. A notification received before any era signal is consumed without a response and without forwarding.

### Legacy era (initialize handshake)

Supported protocol versions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. Each is echoed verbatim by `initialize`. Any other requested version negotiates down to `2025-11-25`.

The supervisor caches the completed `initialize` / `notifications/initialized` pair and replays it into a replacement worker before queued requests are released; replay failure is a startup failure (see `ERR_WORKER_RESTART` in `## Errors`).

The legacy wire contract is byte-compatible with the pre-migration (SDK v1) server, with these recorded exceptions:

- `tools/call` with `arguments` omitted reaches the application validator as `{}`. Three outcome arms: (a) input-free tools succeed (`get-runtime-metrics`); (b) required-field schemas answer per-field `ERR_INVALID_INPUT` (`analyze-mod`); (c) a `{}`-accepting schema whose handler requires input answers that tool's own handler-level ProblemDetails — `json-to-nbt` answers `ERR_NBT_INVALID_TYPED_JSON` (status 400, `isError: true`) instead of the pre-migration validation-layer `ERR_INVALID_INPUT`.
- Legacy `tools/list` entries omit the v1-only `execution: {"taskSupport":"forbidden"}` field (SDK v2 does not emit it); every other advertised field, including the `inputSchema` bytes, is identical to the pre-migration snapshots.
- An unknown or disabled tool is answered immediately at the supervisor, before queueing: the reply bytes are identical to v1, but the reply consumes no queue slot and no worker round-trip, so reply ordering and queue-overflow outcomes can differ from v1 under concurrent load.
- The unmatched-resource-URI error keeps the raw JSON-RPC `-32602` code, but its message changed from the pre-migration `MCP error -32602: Resource <uri> not found` to `Resource not found: <uri>`, and the error carries a `data.uri` field (SDK v2 wording).

### Modern era (2026-07-28, stateless)

Modern clients never send `initialize`. Every request carries `params._meta`:

| `_meta` key | Requirement | Value |
| --- | --- | --- |
| `io.modelcontextprotocol/protocolVersion` | required | `"2026-07-28"` |
| `io.modelcontextprotocol/clientCapabilities` | required | object (for example `{}`) |
| `io.modelcontextprotocol/clientInfo` | optional | `{ name, version }` |

Recommended bootstrap probe (era-neutral — it never locks an era; per-state outcomes are under the rejection table):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The discover result carries `supportedVersions: ["2026-07-28"]` (the modern per-request set — the legacy matrix is advertised through `initialize` negotiation, not through discover), `capabilities`, the server identity in `result._meta["io.modelcontextprotocol/serverInfo"]`, `resultType`, and the cache fields. `capabilities` advertises `resources: { listChanged: false }` and `tools: { listChanged: false }`, in that key order, and the legacy `initialize` result advertises the same payload — the two eras never disagree. The `false` is a deliberate suppression, not an SDK default: the SDK advertises `listChanged: true` for any registered tool or resource surface unless the server overrides it, and this server never emits `notifications/tools/list_changed` or `notifications/resources/list_changed` — the tool and resource surface is fixed at process start by environment flags — and there is no way to subscribe to those notifications either (see `subscriptions/listen` below). Treat both lists as static for the lifetime of the process; re-read them only across a restart.

Probe fallback rule for clients: fall back to the legacy `initialize` handshake on ANY unrecognized probe error or on a probe timeout — never key the fallback to one specific error code. Back-to-back pipelining is safe: a modern-claim `server/discover` immediately followed by `initialize` in one stdin chunk is admitted atomically in stdin order — the discover is answered with a DiscoverResult, the initialize negotiates, and the process ends legacy-locked. One narrow exception: when the worker is down (restarting) as that pair arrives, the replayed `initialize` pins the replacement worker first and the queued discover is answered `-32601`; the any-error fallback rule covers this case.

Every modern result — tool calls, resource reads, list methods, `server/discover`, and supervisor-synthesized results — carries `resultType: "complete"` and echoes the same server identity as discover in `result._meta["io.modelcontextprotocol/serverInfo"]`. `input_required` is never emitted. Raw JSON-RPC error responses never carry result-only fields.

Absent modern surfaces: `prompts/list` is not advertised and answers `-32601`. `ping`, `logging/setLevel`, `tasks/list`, and `tasks/get` answer `-32601` in the modern era; legacy `ping` keeps its automatic `{}` pong. `subscriptions/listen` is intentionally absent in BOTH eras: no subscription capability is advertised — which is why `listChanged` is advertised as `false` above rather than `true` — the worker runs with `maxSubscriptions: 0`, the rejection is `-32601`, and it is non-retryable: there is no live update stream to wait for, and nothing would be pushed onto one. The server never sends `notifications/message`; logging goes to stderr.

### Cache metadata (modern era only)

Both `ttlMs` and `cacheScope` are returned by exactly these cacheable methods: `tools/list`, `resources/list`, `resources/read`, `resources/templates/list`, `server/discover`, and `prompts/list` were it exposed (it is not). This is the protocol's five-method cacheable list plus `server/discover` (SDK/schema default row). Values:

| Surface | `cacheScope` | `ttlMs` |
| --- | --- | ---: |
| `tools/list` | `private` | `0` |
| `server/discover` | `private` | `0` |
| `resources/list`, `resources/templates/list` | `private` | `3600000` |
| `mc://versions/list` read | `private` | `300000` |
| `mc://metrics` read | `private` | `0` |
| class source, artifact, mapping, member, and artifact-metadata reads | `private` | `60000` |
| any successful read whose content is a ProblemDetails failure envelope | `private` | `0` |

The ProblemDetails row takes precedence over the resource-class rows; otherwise an exact-URI row beats a class row. Legacy responses carry no cache fields, no `resultType`, and no protocol `_meta` identity echo.

### Version negotiation

| Client sends | Outcome |
| --- | --- |
| `initialize` with `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, or `2024-10-07` | verbatim echo; legacy era |
| `initialize` with any other version string | negotiates down to `2025-11-25`; legacy era |
| modern `_meta` with `protocolVersion: "2026-07-28"` | served; modern era |
| modern `_meta` with any other version string | LOCKS modern, then answers `-32022` with `data: { supported: ["2026-07-28"], requested }` — retry with a version from `data.supported`; do NOT fall back to `initialize` (the process is already modern-locked and would answer `-32601` `era_conflict`) |

### Rejection and error table

`-32602` reaches clients in distinct shapes. Branch on `error.data.kind` when present; the remaining shapes are distinguished by message family (most are data-less; the resource-miss row carries `data.uri`):

| Producer | State / trigger | Method scope | Code | Discriminator |
| --- | --- | --- | --- | --- |
| supervisor | no era selected; request without a valid era signal | any non-`server/discover` request | `-32602` | `data.kind: "missing_meta"` with `data.missing[]` (plus `data.invalid[]` for wrong-typed keys); the message names both recovery paths |
| supervisor | modern-locked; claim-less request | any request, including `server/discover` | `-32602` | `data.kind: "missing_meta"`; the message names the required keys |
| worker (SDK) | modern-locked; shallow-valid claim with a deep-invalid `_meta` value | forwarded requests | `-32602` | data-less; message starts `Invalid _meta envelope for protocol revision 2026-07-28:` (pinned example: `Invalid _meta envelope for protocol revision 2026-07-28: Invalid input: expected object, received number`) |
| worker (SDK) | params-schema violation, for example non-object `tools/call` `arguments` | both eras | `-32602` | data-less; message starts `Invalid tools/call request:`; the request never reaches the application validator |
| worker (SDK) | unmatched resource URI | `resources/read`, both eras | `-32602` | message `Resource not found: <uri>` with `data.uri` (the pre-migration server answered `MCP error -32602: Resource <uri> not found` without `data` — code unchanged, message family changed) |
| worker (SDK) | unknown or disabled tool, MODERN era | `tools/call` | `-32602` | raw JSON-RPC error (sanctioned modern contract; the modern era never had a v1 contract here) |
| supervisor | unknown or disabled tool, LEGACY era | `tools/call` | none | SUCCESSFUL `CallToolResult` with `isError: true`, text `MCP error -32602: Tool <name> not found`, and NO `structuredContent` key — the missing `structuredContent` is the discriminator against a genuine tool failure |
| supervisor | `initialize` that is not a valid MCP initialize request | `initialize` | `-32602` | `data.kind: "invalid_initialize"` with `data.required[]` and `data.eraSelected: false` — the era is NOT locked, so the client may retry a well-formed `initialize` or select the modern era instead |
| supervisor | modern-locked; `initialize` arrives | `initialize` | `-32601` | `data.kind: "era_conflict"`, `selectedEra: "modern"`, `requestedEra: "legacy"`, `supported[]` = all six versions |
| supervisor | legacy-locked; modern-claim request arrives | any modern-claim request | `-32600` | `data.kind: "era_conflict"`, `selectedEra: "legacy"`, `requestedEra: "modern"` |
| supervisor / worker | `subscriptions/listen` | both eras | `-32601` | plain `Method not found` (no data). Non-legacy states reject at supervisor admission; a modern-signal listen still era-locks first, and a claim-less listen in non-legacy states fails the envelope check with `-32602` before the method rejection |
| supervisor | modern request with an unsupported `protocolVersion` value | every modern request | `-32022` | `data.supported: ["2026-07-28"]`, `data.requested` |
| supervisor | queue overflow, non-`tools/call` request | requests | `-32000` | message `MCP supervisor request queue is full.` (`tools/call` overflow receives the `ERR_LIMIT_EXCEEDED` `isError` result instead — see `## Meta fields`) |

`server/discover` per state: a valid modern-claim discover never selects or changes the era. It receives a DiscoverResult in the unselected and modern-locked states; in the legacy-locked state it is forwarded to the legacy-pinned worker, which answers `-32601` (the probe's any-error fallback rule covers this). A claim-less discover: unselected → `-32602` `missing_meta`; modern-locked → `-32602` `missing_meta`; legacy-locked → forwarded → `-32601`.

Era-conflict messages embed a launcher-neutral recovery sequence: close this transport, terminate and respawn the configured server command as a fresh stdio process, discard or re-issue any pending request ids, then perform the wanted era's opening (`initialize` + `notifications/initialized`, or a request carrying the required `io.modelcontextprotocol/*` `_meta` envelope).

Notification variants: a modern-era notification without a valid claim (for example a claim-less `notifications/cancelled`) is never forwarded to the worker; it is dropped with a logged `supervisor.notification_dropped` warning and, like every notification, receives no response. Supervisor-side bookkeeping still applies: a claim-less cancellation still cancels ANY tracked in-flight request (not only `validate-project`), releasing its pending slot, its deadline timer, and the `validate-project` barrier if it held one, and the eventual worker response is suppressed per MCP cancellation semantics via the ordinary response-finality tombstone. An `initialize` in flight is the one exception — its handshake lifecycle owns that entry.

### Synthetic terminal responses and retry semantics

Supervisor-synthesized replies (queue overflow, worker restart, `validate-project` timeout, startup failure — shapes in `## Errors` and `## Meta fields`) are FINAL for that request instance: a late worker answer for the same id is discarded, so a client sees exactly one response per id. Retrying with the SAME id after a synthetic terminal reply is legal — the retry re-forwards and clears the finality bookkeeping. Era rejections synthesize no such finality (they answer without forwarding), and dropped notifications receive no response at all. Modern-era synthetic results are decorated like ordinary modern results (`resultType: "complete"` plus the identity `_meta` echo); legacy synthetic results remain byte-compatible with the pre-migration shapes.

### Framing

Standard framing is newline-delimited JSON-RPC (the MCP stdio standard). `Content-Length` header framing is a LOCAL, NONSTANDARD compatibility extension — it is not part of MCP. The reader auto-detects both and may switch mid-stream; every response, including synthetic replies and replies released after a worker restart, uses the framing of the request it answers. `MCP_MAX_FRAME_BYTES` bounds accepted frames (see `## Environment Variables`).

### Adopted-policy note

The 2026-07-28 revision does not mandate specific mixed-era conflict rules or unselected-state behavior for one stdio process. The era-conflict codes, `missing_meta` rejections, one-way lock, and discover neutrality documented here are this server's adopted policy, pinned by the committed wire suites (`tests/stdio/stdio-supervisor-era-state.test.ts`, `tests/stdio/stdio-supervisor-era-wire.test.ts`, `tests/stdio/stdio-supervisor-era-lifecycle.test.ts`). If a future protocol revision defines normative rules for these cases, those rules supersede this policy.

Tooling note: `pnpm test:manual:stdio-smoke` runs against the production supervisor by default; its direct-worker bridge fallback mode bypasses the supervisor and therefore observes the worker-level raw `-32602` for disabled tools instead of the restored legacy `isError` envelope.

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

If `find-class` or `get-class-source` returns no hit on an obfuscated Minecraft runtime artifact for names like `net.minecraft.world.item.Item`, the tool warns that `obfuscated` means Mojang's runtime names and recommends retrying with `mapping="mojang"` or translating via `find-mapping`. `find-class` does not issue that advice for dependency-resolved or Jar-in-Jar shell artifacts, whose native names are not evidence of Minecraft obfuscation.

Method descriptor precision is best on Tiny-backed paths (`intermediary` and `yarn`). For `obfuscated <-> mojang`, Mojang `client_mappings` do not carry JVM descriptors, so descriptor queries may fall back to name matching and emit a warning.

Use `resolve-method-mapping-exact` when candidate ranking is not enough and the workflow needs strict `owner + name + descriptor` certainty. It is a strict shortcut for `find-mapping` (kind=method, signatureMode=exact) that additionally requires a **complete** descriptor projection — it returns `mapping_unavailable` when the descriptor's class references cannot all be projected to the target namespace, whereas `find-mapping`'s exact mode resolves those leniently. Prefer `find-mapping kind=method signatureMode=exact` unless you specifically need that strict-completeness guarantee.

`resolve-method-mapping-exact` is **owner-strict**: the strict set is the candidates matching the query's full advertised triple `owner + name + descriptor`. The owner is compared after projecting it along the same mapping path the candidates travelled, so it is checked in the target namespace, not as a raw string. A same-signature method on a different class is therefore rejected rather than turned into an ambiguous verdict. The cost is that a method the owner INHERITS rather than declares now returns `not_found`: the mapping formats record declarations and carry no class hierarchy. That case is never silent — the result carries a warning naming the owner, the classes that do declare the member, and `find-mapping` as the owner-agnostic lookup.

`resolve-method-mapping-exact` reports the candidate set its verdict was computed FROM, on every status. `candidates` and `candidateCount` are the strict matches — never the wider name-matched list, which previously put a `confidence: 1, matchKind: "exact"` candidate the strict filter had already rejected next to an ambiguous verdict with nothing to distinguish it. On `status: "resolved"` that set is the single match, so `candidates` duplicates `resolvedSymbol` and the default response projection omits it, leaving `resolvedSymbol` and `candidateCount: 1`. Candidates the strict filter dropped are accounted for in `warnings` as counts BY REASON (how many by owner, how many by descriptor); use `find-mapping` when you want the unfiltered list. An ambiguous verdict also carries `ambiguityReasons[]`, the same field `find-mapping` populates. The tool never picks a winner: `status: "resolved"` means exactly one strict match existed.

`resolve-workspace-symbol` delegates its `kind: "method"` lookups to `resolve-method-mapping-exact` and spreads the result, so its method responses carry the same owner-strict semantics and the same `ambiguityReasons[]` on `status: "ambiguous"`. The field is present only on that status and always holds at least one reason, so it never serializes as an empty array.

Use `find-mapping` `disambiguation.ownerHint` and `disambiguation.descriptorHint` to narrow ambiguous candidate sets.

Use `resolve-workspace-symbol` when you need compile-visible names from actual Gradle Loom mappings in a workspace.

## Environment Variables

Path-based overrides treat blank values and the literal strings `undefined` and `null` as unset, so accidental client serialization does not create `./undefined` or `./null` cache roots or broken JAR override paths.

`gradleUserHome` is a per-call path option, not an environment variable. It takes precedence over the MCP process `GRADLE_USER_HOME` for Loom source jars, Loom Tiny mappings, loader/runtime jars, and `validate-project` Loom cache probes. `projectPath` search roots still apply for workspace-local caches.

### Core and Repository Discovery

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_CACHE_DIR` | `~/.cache/minecraft-modding-mcp` | Cache root for downloads and SQLite |
| `MCP_SQLITE_PATH` | `<cacheDir>/source-cache.db` | SQLite database path |
| `MCP_SQLITE_CACHE_KB` | `8000` | SQLite page-cache size in KiB (applied as a negative `cache_size` pragma) |
| `MCP_SQLITE_MMAP_SIZE` | `268435456` | SQLite `mmap_size` in bytes; `0` disables memory-mapped I/O |
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
| `MCP_SEARCH_SCAN_MAX_BYTES` | `67108864` | Maximum bytes read by literal scan fallbacks before the scan stops |
| `MCP_LOOM_TINY_MAX_INDEX_ENTRIES` | derived from the live V8 heap limit | Hard cap on index slots one Loom `.tiny` load may accumulate before it stops and warns instead of exhausting the heap. Unset, the budget is derived from free heap (so raising `--max-old-space-size` raises it automatically) and clamped to 1,000,000–64,000,000 slots. |
| `MCP_INDEX_INSERT_CHUNK_SIZE` | `200` | Batch size for SQLite index inserts |
| `MCP_MAX_ARTIFACTS` | `200` | Maximum cached artifacts |
| `MCP_MAX_CACHE_BYTES` | `2147483648` | Maximum total cache size in bytes |
| `MCP_CACHE_GRAPH_MAX` | `16` | Mapping graph cache size |
| `MCP_CACHE_SIGNATURE_MAX` | `2000` | Signature cache size |
| `MCP_CACHE_VERSION_DETAIL_MAX` | `256` | Version detail cache size |

### Networking

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_FETCH_TIMEOUT_MS` | `15000` | HTTP request timeout in milliseconds (also bounds version-manifest fetches) |
| `MCP_FETCH_RETRIES` | `2` | HTTP request retry count |
| `MCP_MAX_FRAME_BYTES` | `67108864` | Maximum accepted JSON-RPC frame size in bytes for the stdio supervisor and worker transport (clamped to at least 1 MiB); oversized frames are rejected with a diagnostic and skipped |

### Decompilation and Remapping

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_VINEFLOWER_JAR_PATH` | unset | Override the Vineflower JAR path |
| `MCP_VINEFLOWER_VERSION` | `1.11.2` | Vineflower version to auto-download when no JAR path override is set |
| `MCP_TINY_REMAPPER_JAR_PATH` | unset | Override the tiny-remapper JAR path |
| `MCP_TINY_REMAPPER_VERSION` | `0.10.3` | tiny-remapper version to auto-download when no JAR path override is set |
| `MCP_REMAP_TIMEOUT_MS` | `600000` | Remap operation timeout in milliseconds |
| `MCP_REMAP_MAX_MEMORY_MB` | `4096` | Maximum JVM heap for remap operations |
| `MCP_DECOMPILE_MAX_MEMORY_MB` | `4096` | Maximum JVM heap for Vineflower decompile operations |

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
| `MCP_VALIDATE_PROJECT_TIMEOUT_MS` | `120000` | End-to-end `validate-project` deadline, including queue time. Accepts ASCII decimal digits only and must be from `10000` through `600000`; invalid values use the default. |

Internal worker-mode environment variables are reserved for the transport implementation and are intentionally omitted from the public reference.

## Architecture

| Component | Technology |
| --- | --- |
| Runtime | Node.js 22.13.0+ |
| Transport | stdio, MCP protocol revision `2026-07-28` plus the legacy initialize protocol (dual-era, see `## MCP Protocol Support`); newline framing standard, `Content-Length` as a local extension |
| Storage | SQLite for artifact metadata, source indexing, and cache bookkeeping |
| Decompilation | [Vineflower](https://github.com/Vineflower/vineflower) |
| Remapping | [tiny-remapper](https://github.com/FabricMC/tiny-remapper) |
| Mapping Sources | Mojang `client_mappings.txt`, Fabric Loom workspace metadata, Maven Tiny v2 |

The server runs as a long-lived stdio process. Artifacts, mappings, and generated metadata are downloaded on demand and cached locally.
