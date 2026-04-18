# MCP Recipes

## Table of Contents

1. [When to Read This](#when-to-read-this)
2. [Shared Defaults](#shared-defaults)
3. [Common Error Shapes](#common-error-shapes)
4. [`inspect-minecraft`](#inspect-minecraft)
5. [`analyze-symbol`](#analyze-symbol)
6. [`compare-minecraft`](#compare-minecraft)
7. [`validate-project`](#validate-project)
8. [`analyze-mod`](#analyze-mod)
9. [Recovery Moves](#recovery-moves)

## When to Read This

Read this file when you already know which high-level MCP entry tool you need, but you want a payload shape that validates on the current v3 surface.

These are starting points, not mandatory templates. Keep the first pass small and expand only when `result.summary` says you need more detail.

## Shared Defaults

- Start with `detail: "summary"` unless you already know you need expanded blocks.
- Add `include` only for the exact blocks you need in the same response.
- Prefer workspace-aware calls when a real mod workspace exists.
- When a tool still requires `version`, pass it explicitly even if you also pass `projectPath`.
- If `summary` already answers the question, stop there instead of drilling down by default.
- Parallelize only independent read-only discovery calls after loader, version, mapping, and `projectPath` are known.
- Keep dependent chains sequential.
- Do not run `manage-cache`, `index-artifact`, remap apply flows, or other mutating maintenance calls in parallel with calls that depend on the same cache or JAR.

## Common Error Shapes

Treat the exact field names below as representative of the current MCP surface, not as a promise that every failure uses the same envelope forever.

### Validation error: fix the payload and retry the same high-level tool

Observed shape:

```json
{
  "error": {
    "code": "ERR_INVALID_INPUT",
    "detail": "Request validation failed.",
    "fieldErrors": [
      {
        "path": "version",
        "message": "version is required for non-workspace tasks."
      }
    ],
    "hints": [
      "Check fieldErrors and submit a valid tool argument payload."
    ]
  }
}
```

What to do:

- Read `fieldErrors` first.
- Fix the missing or malformed field and retry the same entry tool.
- Do not drop to a low-level tool just because the first payload was invalid.

### Missing file or bad local path: fix the path before changing tools

Observed shape:

```json
{
  "error": {
    "code": "ERR_INVALID_INPUT",
    "detail": "Jar not found: \"/does/not/exist.jar\"."
  }
}
```

What to do:

- Re-check `projectPath`, `jarPath`, or source file paths from the workspace.
- If the file truly does not exist, say so clearly and continue with the files that are actually present.

### `summary.status="not_found"`: absence is a result, not a transport error

Observed shape:

```json
{
  "result": {
    "summary": {
      "status": "not_found",
      "headline": "The symbol could not be resolved in 1.21.1."
    }
  }
}
```

What to do:

- Treat this as evidence that the symbol, class, or mapping path is not present in the requested version or namespace.
- Double-check the namespace, version, and owner before concluding the feature is unavailable.
- If it is still `not_found`, say so explicitly and propose the closest verified alternative.

### Tool unavailable, timeout, or stale data symptoms

What to do:

- If the tool call itself fails, times out, or returns obviously stale data, say that MCP could not verify the fact.
- Retry with a narrower high-level call first.
- Use `manage-cache` when the problem looks like stale cache or stale index state.
- Fall back to workspace files, logs, and nearby code without inventing descriptors, mappings, or registry IDs.

## `inspect-minecraft`

### List stable versions

```json
{
  "task": "versions",
  "detail": "summary",
  "includeSnapshots": false,
  "limit": 10
}
```

### Resolve the artifact for a specific version

```json
{
  "task": "artifact",
  "detail": "summary",
  "subject": {
    "kind": "version",
    "version": "1.21.1",
    "mapping": "mojang",
    "scope": "merged"
  }
}
```

### Read a vanilla class through workspace context

```json
{
  "task": "class-source",
  "detail": "summary",
  "subject": {
    "kind": "workspace",
    "projectPath": "/path/to/mod",
    "mapping": "mojang",
    "scope": "merged",
    "preferProjectVersion": true,
    "focus": {
      "kind": "class",
      "className": "net.minecraft.server.MinecraftServer"
    }
  }
}
```

### Search vanilla sources through workspace context

```json
{
  "task": "search",
  "detail": "summary",
  "subject": {
    "kind": "workspace",
    "projectPath": "/path/to/mod",
    "mapping": "mojang",
    "scope": "merged",
    "preferProjectVersion": true,
    "focus": {
      "kind": "search",
      "query": "tickServer"
    }
  }
}
```

## `analyze-symbol`

### Check whether a class exists

```json
{
  "task": "exists",
  "detail": "summary",
  "version": "1.21.1",
  "sourceMapping": "mojang",
  "subject": {
    "kind": "class",
    "name": "net.minecraft.world.item.Item"
  }
}
```

### Map a method between namespaces

```json
{
  "task": "map",
  "detail": "summary",
  "version": "1.21.1",
  "sourceMapping": "mojang",
  "targetMapping": "yarn",
  "subject": {
    "kind": "method",
    "owner": "net.minecraft.world.entity.player.Player",
    "name": "tick",
    "descriptor": "()V"
  }
}
```

If a direct namespace path returns `summary.status="partial"`, keep the same symbol input but retry with the namespace pair your workspace actually compiles against, or fall back to `get-class-api-matrix` / `find-mapping` for exact recovery.

### Resolve the compile-visible workspace name

```json
{
  "task": "workspace",
  "detail": "summary",
  "projectPath": "/path/to/mod",
  "version": "1.21.1",
  "sourceMapping": "mojang",
  "subject": {
    "kind": "method",
    "owner": "net.minecraft.world.entity.player.Player",
    "name": "tick",
    "descriptor": "()V"
  }
}
```

## `compare-minecraft`

### Get a migration overview between two versions

```json
{
  "task": "versions",
  "detail": "summary",
  "subject": {
    "kind": "version-pair",
    "fromVersion": "1.20.6",
    "toVersion": "1.21.1"
  }
}
```

### Diff a single class across versions

```json
{
  "task": "class-diff",
  "detail": "summary",
  "subject": {
    "kind": "class",
    "className": "net.minecraft.server.MinecraftServer",
    "fromVersion": "1.20.6",
    "toVersion": "1.21.1",
    "mapping": "mojang",
    "sourcePriority": "loom-first"
  }
}
```

## `validate-project`

### Summarize a workspace's Mixin and access widener health

```json
{
  "task": "project-summary",
  "detail": "summary",
  "version": "1.21.1",
  "mapping": "yarn",
  "preferProjectVersion": true,
  "preferProjectMapping": true,
  "subject": {
    "kind": "workspace",
    "projectPath": "/path/to/mod",
    "discover": ["mixins", "access-wideners"]
  },
  "include": ["workspace"]
}
```

### Validate one edited Mixin directly

```json
{
  "task": "mixin",
  "detail": "summary",
  "version": "1.21.1",
  "mapping": "yarn",
  "preferProjectVersion": true,
  "preferProjectMapping": true,
  "subject": {
    "kind": "mixin",
    "input": {
      "mode": "path",
      "path": "/path/to/mod/src/main/java/com/example/mymod/mixin/PlayerMixin.java"
    }
  },
  "include": ["issues", "recovery"]
}
```

## `analyze-mod`

### Summarize a mod JAR first

```json
{
  "task": "summary",
  "detail": "summary",
  "subject": {
    "kind": "jar",
    "jarPath": "/path/to/mod.jar"
  }
}
```

### Search decompiled mod source

```json
{
  "task": "search",
  "detail": "summary",
  "subject": {
    "kind": "jar",
    "jarPath": "/path/to/mod.jar"
  },
  "query": "onPlayerTick",
  "searchType": "method",
  "limit": 20
}
```

### Load one decompiled class

```json
{
  "task": "class-source",
  "detail": "summary",
  "subject": {
    "kind": "class",
    "jarPath": "/path/to/mod.jar",
    "className": "com.example.mymod.mixin.PlayerMixin"
  },
  "maxLines": 120
}
```

### Preview a remap without mutating the JAR

```json
{
  "task": "remap",
  "detail": "summary",
  "subject": {
    "kind": "jar",
    "jarPath": "/path/to/mod.jar"
  },
  "executionMode": "preview",
  "targetMapping": "mojang"
}
```

Start with `summary`. Use `search`, `class-source`, `decompile`, or `remap` only after metadata tells you the jar is the right target.

## Recovery Moves

- Validation error on an entry tool: fix the payload shape here before dropping to a low-level tool.
- Artifact context missing in `inspect-minecraft`: switch to a workspace subject with `focus`, or resolve the artifact explicitly first.
- Workspace mapping unresolved: keep `projectPath`, but also pass an explicit `version` and state that compile mapping detection was uncertain.
- `summary.status="not_found"`: verify namespace and version once, then treat the symbol as absent and choose a verified alternative.
- Suspected stale MCP data: inspect `manage-cache` before retrying expensive source calls.
- File or jar path error: fix the path or say the fixture is missing. Do not pretend the file was analyzed.
