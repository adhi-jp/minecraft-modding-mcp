# Example Requests

The requests under [Catalog Tools](#catalog-tools) come first. The requests for the deprecated 8.x tools follow under [Deprecated 8.x Tools](#deprecated-8x-tools); those tools still accept them until their removal in 10.0.0 at the earliest, and [tool-reference.md → Migration from 8.x](tool-reference.md#migration-from-8x) names the catalog tools that replace each one.

## Catalog Tools

The catalog tools share one `target` object and reject unknown keys; see [tool-reference.md → Tool catalog](tool-reference.md#tool-catalog). Resolve once with `artifact-resolve`, then pass `result.artifact.artifactId` to the other tools as `target: { "kind": "artifact", "artifactId": ... }`.

### List versions

```json
{
  "tool": "version-list",
  "arguments": {
    "includeSnapshots": true,
    "limit": 5
  }
}
```

### Resolve an artifact from a version

```json
{
  "tool": "artifact-resolve",
  "arguments": {
    "target": {
      "kind": "version",
      "version": "1.21.10"
    },
    "mapping": "mojang"
  }
}
```

### Rebuild an artifact's index

```json
{
  "tool": "artifact-index",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "force": true
  }
}
```

### List files under a prefix

```json
{
  "tool": "file-list",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "prefix": "net/minecraft/world/level/",
    "limit": 50
  }
}
```

Pass `meta.pagination.nextCursor` as `cursor` for the next page, or send the `file-list` call in `meta.nextActions`.

### Read one file

```json
{
  "tool": "file-read",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "filePath": "net/minecraft/world/level/block/Blocks.java",
    "maxBytes": 65536
  }
}
```

### Find a class by simple name in a dependency

```json
{
  "tool": "class-find",
  "arguments": {
    "target": {
      "kind": "dependency",
      "group": "net.fabricmc.fabric-api",
      "name": "fabric-api",
      "projectPath": "/path/to/mod"
    },
    "className": "ItemGroupEvents"
  }
}
```

### Read the source of several classes

```json
{
  "tool": "source-read",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "classes": [
      "net.minecraft.world.item.Item",
      "net.minecraft.world.level.block.Block"
    ],
    "mode": "snippet",
    "maxLines": 80
  }
}
```

Each class is one entry of `result.items` with its own `status`; a missing class fails only its own item. When lines remain, `meta.nextActions` holds the `source-read` call that reads on from the next line.

### Read a class from a mod jar

```json
{
  "tool": "source-read",
  "arguments": {
    "target": {
      "kind": "jar",
      "jarPath": "/path/to/mods/example-mod.jar"
    },
    "classes": ["com.example.mod.ExampleMod"],
    "mode": "full"
  }
}
```

### Export class sources to files

```json
{
  "tool": "source-export",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "classes": [
      "net.minecraft.world.item.Item",
      "net.minecraft.world.item.ItemStack"
    ],
    "outputDir": "/tmp/minecraft-sources"
  }
}
```

This writes `/tmp/minecraft-sources/net/minecraft/world/item/Item.java` and `ItemStack.java`, overwriting existing files; `result.items[].path` names each file.

### List the members of a class, page by page

```json
{
  "tool": "member-list",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "classes": ["net.minecraft.world.entity.LivingEntity"],
    "access": "all",
    "memberPattern": "tick|hurt",
    "limit": 50
  }
}
```

With one class, `meta.pagination.nextCursor` and the `member-list` call in `meta.nextActions` read the next page. `detail: "summary"` lists only names and Java signatures.

### Search an artifact's source, page by page

```json
{
  "tool": "source-search",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "query": "hurt",
    "symbolKind": "method",
    "packagePrefix": "net.minecraft.world.entity",
    "limit": 50
  }
}
```

The default `intent: "symbol"` matches declaration names; `result.status` is `ok` or `not_found`. While `meta.pagination.hasMore` is `true`, the `source-search` call in `meta.nextActions` reads the next page. `detail: "summary"` drops each content hit's `context`; `detail: "full"` adds `score` and `reasonCodes`.

### Search file text, then scan it literally

```json
{
  "tool": "source-search",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "query": "BlockPos.ZERO",
    "intent": "text"
  }
}
```

Each content hit carries its `line` and `context`. The index splits text at `.`, `_` and `$`, so when such a query finds nothing, `meta.nextActions` offers the same search with `queryMode: "literal"`, which checks every file for the query as a substring (ignoring case with the default `match`).

### Search with a class name from another namespace

```json
{
  "tool": "source-search",
  "arguments": {
    "target": {
      "kind": "artifact",
      "artifactId": "<obfuscated-artifact-id>"
    },
    "query": "net.minecraft.world.entity.player.Player",
    "mapping": "mojang"
  }
}
```

`result.translatedQuery` shows the name that was searched, and the hits are in the artifact's namespace (`result.artifact.mappingApplied`). `status: "unavailable"` means the name could not be translated and nothing matched it as given; `meta.warnings` says why.

### Check that symbols exist

```json
{
  "tool": "symbol-check",
  "arguments": {
    "target": {
      "kind": "version",
      "version": "1.21.10"
    },
    "mapping": "mojang",
    "symbols": [
      { "kind": "class", "className": "net.minecraft.world.item.Item" },
      { "kind": "method", "className": "net.minecraft.world.item.Item", "memberName": "getName" },
      { "kind": "field", "className": "net.minecraft.world.entity.EntityType", "memberName": "ITEM" }
    ]
  }
}
```

`mapping` is required: it names the namespace the names are written in. Each symbol is one entry of `result.items` with its own `status` (`ok`, `not_found`, `ambiguous`, `unavailable`).

### Map symbols to another namespace

```json
{
  "tool": "symbol-map",
  "arguments": {
    "target": {
      "kind": "version",
      "version": "1.21.10"
    },
    "mapping": "mojang",
    "toMapping": "intermediary",
    "symbols": [
      { "kind": "class", "className": "net.minecraft.server.MinecraftServer" },
      { "kind": "method", "className": "net.minecraft.server.MinecraftServer", "memberName": "tickServer" }
    ]
  }
}
```

`result.items[].match` holds the mapped name in the same `{ kind, className, memberName?, descriptor? }` form.

### Map a method strictly by its descriptor

```json
{
  "tool": "symbol-map",
  "arguments": {
    "target": {
      "kind": "version",
      "version": "1.21.10"
    },
    "mapping": "intermediary",
    "toMapping": "yarn",
    "exact": true,
    "symbols": [
      {
        "kind": "method",
        "className": "net.minecraft.class_1937",
        "memberName": "method_8320",
        "descriptor": "(Lnet/minecraft/class_2338;)Lnet/minecraft/class_2680;"
      }
    ]
  }
}
```

### Map symbols to a workspace's compile names

```json
{
  "tool": "symbol-map",
  "arguments": {
    "target": {
      "kind": "workspace",
      "projectPath": "/path/to/mod"
    },
    "mapping": "mojang",
    "symbols": [
      { "kind": "class", "className": "net.minecraft.world.item.Item" }
    ]
  }
}
```

Without `toMapping`, the names are mapped to the namespace the project's Gradle build declares (`result.toMapping`), for the Minecraft version in its `gradle.properties`. Methods need a `descriptor` here.

### List a class across all four namespaces

```json
{
  "tool": "class-mappings",
  "arguments": {
    "version": "1.21.10",
    "className": "net.minecraft.world.item.Item",
    "mapping": "mojang",
    "kinds": ["method"],
    "limit": 50
  }
}
```

When rows remain, `meta.pagination.nextCursor` and the `class-mappings` call in `meta.nextActions` read the next page.

### Trace a method across versions

```json
{
  "tool": "symbol-trace",
  "arguments": {
    "symbol": {
      "kind": "method",
      "className": "net.minecraft.server.MinecraftServer",
      "memberName": "tickServer"
    },
    "mapping": "mojang",
    "fromVersion": "1.21.1",
    "toVersion": "1.21.10",
    "withTimeline": true
  }
}
```

### Compare two versions

```json
{
  "tool": "version-compare",
  "arguments": {
    "fromVersion": "1.21.1",
    "toVersion": "1.21.10",
    "packageFilter": "net.minecraft.world.item",
    "withLibraries": true
  }
}
```

The reply holds counts: classes added and removed under the package, registry entries added and removed per registry, and libraries added and removed. `meta.nextActions` holds the same call with `detail: "standard"`, which lists the class and library names; `detail: "full"` also lists the registry entries. To compare one registry, pass `"category": "registry", "registry": "block"` in place of `packageFilter`, which applies to classes only.

### Diff one class between versions

```json
{
  "tool": "class-diff",
  "arguments": {
    "className": "net.minecraft.world.item.Item",
    "fromVersion": "1.21.1",
    "toVersion": "1.21.10",
    "mapping": "mojang"
  }
}
```

`mapping` is required. The default `detail: "full"` returns each modified member before and after; `"standard"` keeps only what changed, and `"summary"` only the counts.

### Read a registry

```json
{
  "tool": "registry-read",
  "arguments": {
    "version": "1.21.10",
    "registry": "block",
    "withData": true,
    "limit": 50
  }
}
```

Without `withData`, the reply lists only registry names and entry counts. A cut at `limit` is reported in `meta.truncation`.

### Read a mod jar's metadata and class names

```json
{
  "tool": "mod-inspect",
  "arguments": {
    "jarPath": "/path/to/mod.jar",
    "withClasses": true
  }
}
```

The reply holds the loader, id, version, entrypoints, mixin configs, dependencies and nested jars, and with `withClasses` the path of every `.class` entry with `/` as `.`, inner classes included. For an ordinary class that is its class name: read it with `source-read` or `member-list` and `"target": { "kind": "jar", "jarPath": "/path/to/mod.jar" }`. `module-info`, `package-info` and `META-INF.versions.<n>.…` entries are not classes to read that way.

### Search a mod jar's source

```json
{
  "tool": "mod-search",
  "arguments": {
    "jarPath": "/path/to/mod.jar",
    "query": "Registry\\.register",
    "searchType": "content",
    "limit": 20
  }
}
```

A binary jar is decompiled once before the first search; a sources jar is searched directly. A search that stopped at `limit` is reported in `meta.truncation`.

### Remap a mod jar, preview first

```json
{
  "tool": "mod-remap",
  "arguments": {
    "jarPath": "/path/to/mod.jar",
    "toMapping": "mojang"
  }
}
```

The preview writes nothing: it reports the `outputJar` the remap would write and `outputExists`. `meta.nextActions` holds the same call with `"apply": true`, which writes `outputJar` and replaces a file already there; `result.remap.fromCache` is `true` when the remap cache already held the result (`"force": true` rebuilds it). An `outputJar` that is the input jar, under any spelling, or a directory is rejected.

### Validate a workspace's mixins and access wideners

```json
{
  "tool": "project-validate",
  "arguments": {
    "projectPath": "/path/to/project"
  }
}
```

The version comes from `gradle.properties` and the mapping from the build scripts unless you pass `version` or `mapping`. `result.project.items` names every mixin config and access widener found, each with its `status` and `errors`; when one is not `ok`, `meta.nextActions` holds the same call with `"detail": "standard"`, which adds each file's issues. When a needed version or mapping cannot be read, `status` is `"blocked"` and the next action is a template with `"<minecraft-version>"` or `"<mapping>"` to fill in. Add `"discover": ["mixins", "access-wideners", "access-transformers"]` to include access transformers. The call has the server's long-running deadline and runs alone.

### Validate mixin configs

```json
{
  "tool": "mixin-validate",
  "arguments": {
    "configPaths": ["/path/to/project/src/main/resources/example.mixins.json"],
    "projectPath": "/path/to/project",
    "detail": "standard"
  }
}
```

Pass exactly one of `source`, `paths`, `configPaths` or `"discover": true` (every `*.mixins.json` under `projectPath`). `result.validation.items` has one entry per mixin class with its `status` and `issues`; `standard` explains each issue and offers the `symbol-check` and `source-read` calls that check it in `meta.nextActions`. Without `projectPath`, pass `version` and `mapping`, for example `{ "source": "…", "version": "1.21.10", "mapping": "mojang" }`.

### Check an access widener file

```json
{
  "tool": "access-validate",
  "arguments": {
    "format": "access-widener",
    "path": "/path/to/project/src/main/resources/example.accesswidener",
    "version": "1.21.10",
    "mapping": "intermediary"
  }
}
```

`mapping` is the namespace the file's names are written in and is always required, since a header's `named` or missing namespace can mislead. `result.validation.entries` has every entry with `valid`; an invalid file lists why in `errors`. An entry not found after its class name could not be mapped (a misspelled class, one absent from that version, or mapping data that could not be loaded) is marked `"confidence": "uncertain"`; when such entries are the only failures, the file is `partial`. Pass `"content"` instead of `"path"` to check text, `"format": "access-transformer"` with `"mapping": "srg"`, `"mojang"` or `"obfuscated"` for a transformer, and `"projectPath"` to check against the workspace's runtime jar.

### Check a mixin target member

```json
{
  "tool": "mixin-verify-target",
  "arguments": {
    "target": { "kind": "version", "version": "1.21.10" },
    "className": "net.minecraft.world.entity.Entity",
    "kind": "field",
    "memberName": "level",
    "mapping": "mojang",
    "mixinMemberName": "getLevel"
  }
}
```

`result.verdict.status` is `ok` for one match, with `advice` saying whether `@Shadow`, `@Accessor` or `@Invoker` fits; `ambiguous` when several overloads match the name, with a template in `meta.nextActions` that asks for the `descriptor`; or `not_found`, with similar members in `candidates`. Names in another namespace than the jar's are translated first (`autoRemap`, default `true`).

### Decode NBT, patch it, and encode it again

```json
{
  "tool": "nbt-decode",
  "arguments": {
    "nbtBase64": "<base64-nbt>"
  }
}
```

`compression` defaults to `auto`, which gunzips bytes that start with the gzip header. `result.typedJson` is the document; edit it with `nbt-patch`:

```json
{
  "tool": "nbt-patch",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": { "type": "compound", "value": { "health": { "type": "float", "value": 20 } } }
    },
    "patch": [
      { "op": "test", "path": "/root/value/health/value", "value": 20 },
      { "op": "replace", "path": "/root/value/health/value", "value": 10 },
      { "op": "add", "path": "/root/value/name", "value": { "type": "string", "value": "Alex" } }
    ]
  }
}
```

A failed `test` or an operation that would leave invalid typed NBT fails the whole call with `ERR_JSON_PATCH_CONFLICT`; `"path": ""` replaces the whole document. Then write the patched document, the `result.typedJson` of `nbt-patch`, back as bytes:

```json
{
  "tool": "nbt-encode",
  "arguments": {
    "typedJson": {
      "rootName": "Level",
      "root": {
        "type": "compound",
        "value": {
          "health": { "type": "float", "value": 10 },
          "name": { "type": "string", "value": "Alex" }
        }
      }
    },
    "compression": "gzip"
  }
}
```

### Clean up cached downloads, preview first

```json
{
  "tool": "cache-manage",
  "arguments": {
    "action": "delete",
    "cacheKinds": ["downloads"],
    "selector": { "version": "1.21.1" }
  }
}
```

The preview deletes nothing: `result.cache.deletedEntries` and `deletedBytes` count what would go, and when there is something, `meta.nextActions` holds the same call with `"apply": true`. `delete` needs a `selector` with at least one field. To see the entries first, use `"action": "list"` with the same `cacheKinds` and `selector`; `"action": "summary"` totals each kind and `"action": "verify"` checks their health.

### Read the server's counters

```json
{
  "tool": "server-metrics",
  "arguments": {}
}
```

`result.metrics.tool_call_counts` counts the calls of each tool under the name it was called by.

## Deprecated 8.x Tools

These requests are for the deprecated 8.x tools, which accept them until their removal in 10.0.0 at the earliest. [tool-reference.md → Migration from 8.x](tool-reference.md#migration-from-8x) names the catalog tools that replace each one, and the catalog requests above show the same work.

### 8.x Workflow Tools

#### Inspect Minecraft source from a version

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

#### Map or check a symbol

```json
{
  "tool": "analyze-symbol",
  "arguments": {
    "task": "map",
    "subject": {
      "kind": "method",
      "owner": "net.minecraft.server.MinecraftServer",
      "name": "tickServer"
    },
    "version": "1.21.10",
    "sourceMapping": "mojang",
    "targetMapping": "intermediary",
    "signatureMode": "name-only"
  }
}
```

#### Summarize a mod JAR

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

#### Validate a workspace

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

### Source Exploration

#### Resolve from a Minecraft version

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

#### Get class source with a line window

```json
{
  "tool": "get-class-source",
  "arguments": {
    "target": {
      "kind": "artifact",
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
    "target": {
      "kind": "artifact",
      "artifactId": "<artifact-id>"
    },
    "className": "net.minecraft.server.Main",
    "mapping": "obfuscated",
    "access": "all",
    "includeInherited": true,
    "maxMembers": 300
  }
}
```

#### List artifact files with a prefix filter

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

### Version Comparison and Symbol Tracking

#### Trace `Class.method` lifecycle

```json
{
  "tool": "trace-symbol-lifecycle",
  "arguments": {
    "symbol": "net.minecraft.server.MinecraftServer.tickServer",
    "descriptor": "(Ljava/util/function/BooleanSupplier;)V",
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
    "mapping": "obfuscated",
    "includeFullDiff": false
  }
}
```

### Mapping and Symbols

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
    "maxCandidates": 10,
    "disambiguation": {
      "ownerHint": "net.minecraft"
    }
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
    "includeKinds": "class,field,method",
    "maxRows": 100
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

### Mod Analysis

#### Analyze mod metadata

```json
{
  "tool": "analyze-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeClasses": true
  }
}
```

#### Decompile the mod JAR

```json
{
  "tool": "decompile-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeFiles": false,
    "className": "com.example.mymod.MyMod"
  }
}
```

#### Read a specific class from decompiled source

```json
{
  "tool": "get-mod-class-source",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "className": "com.example.mymod.mixin.PlayerMixin",
    "maxLines": 120
  }
}
```

#### Search across decompiled mod source

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

#### Remap a mod JAR to readable names

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

If the input JAR was already built with Mojang mappings, use `targetMapping: "mojang"` to get a copied output JAR and a `fromMapping: "mojang"` result.

#### Bridge a mod hit to a Minecraft-side check

When `search-mod-source` or `get-mod-class-source` surfaces a class or member that
looks like a Minecraft target (for example a Mixin `@Shadow`/`@Inject` target, or a
symbol from a crash stack), verify it against the target Minecraft version before
trusting it. Feed the owner/member into `verify-mixin-target`. When your owner/member
are in a readable namespace (e.g. `mojang`/`yarn`) but the resolved artifact is
obfuscated, set `autoRemap: true` to translate them automatically in one call:

```json
{
  "tool": "verify-mixin-target",
  "arguments": {
    "target": { "kind": "version", "value": "1.21.10" },
    "owner": "net.minecraft.world.entity.LivingEntity",
    "member": { "kind": "method", "name": "tick", "descriptor": "()V" },
    "mapping": "mojang",
    "autoRemap": true
  }
}
```

For a plain "does this symbol exist in this version?" question, use `symbol-check` instead (with the 8.x tools, `analyze-symbol task="exists"`).

### Validation

#### Validate Mixin source

```json
{
  "tool": "validate-mixin",
  "arguments": {
    "input": {
      "mode": "inline",
      "source": "@Mixin(PlayerEntity.class)\npublic abstract class PlayerMixin {\n  @Inject(method = \"tick\", at = @At(\"HEAD\"))\n  private void onTick(CallbackInfo ci) {}\n}"
    },
    "version": "1.21.10",
    "mapping": "yarn",
    "reportMode": "compact",
    "warningMode": "aggregated",
    "includeIssues": false
  }
}
```

#### Validate Access Widener content

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

#### Validate Access Widener content against a Loom runtime jar

```json
{
  "tool": "validate-access-widener",
  "arguments": {
    "content": "accessWidener v2 named\naccessible class net/minecraft/server/Main\naccessible method net/minecraft/server/Main tick ()V",
    "version": "1.21.10",
    "projectPath": "/workspace/example-mod",
    "scope": "loader",
    "preferProjectVersion": true
  }
}
```

#### Validate Access Transformer content against a Forge or NeoForge runtime jar

```json
{
  "tool": "validate-access-transformer",
  "arguments": {
    "content": "public net.minecraft.server.MinecraftServer\nprotected net.minecraft.server.MinecraftServer tickServer(Ljava/util/function/BooleanSupplier;)V",
    "version": "1.21.10",
    "projectPath": "/workspace/example-neoforge-mod",
    "scope": "loader",
    "preferProjectVersion": true
  }
}
```

### Registry and Diagnostics

#### Get all registries for a version

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10",
    "includeData": false
  }
}
```

#### Inspect runtime metrics

```json
{
  "tool": "get-runtime-metrics",
  "arguments": {}
}
```
