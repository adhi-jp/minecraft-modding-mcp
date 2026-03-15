# Example Requests

Start with these top-level workflow tools when possible. They cover the common workflows and are the best default starting points for MCP clients and agents.

## Workflow Starting Points

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

## Source Exploration

### Resolve from a Minecraft version

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

### Get class source with a line window

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

### Search by method symbol

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

### Get class member list

```json
{
  "tool": "get-class-members",
  "arguments": {
    "target": {
      "type": "artifact",
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

### List artifact files with a prefix filter

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

## Version Comparison and Symbol Tracking

### Trace `Class.method` lifecycle

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

### Diff one class across two versions

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

## Mapping and Symbols

### Lookup mapping candidates

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

### Resolve exact method mapping

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

### Show class API mapping matrix

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

### Resolve workspace compile-visible symbol

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

### Check symbol existence

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

## NBT Utilities

### Decode Java NBT base64 to typed JSON

```json
{
  "tool": "nbt-to-json",
  "arguments": {
    "nbtBase64": "<base64-nbt>",
    "compression": "auto"
  }
}
```

### Patch typed NBT JSON

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

### Encode typed JSON back to NBT base64

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

## Mod Analysis

### Analyze mod metadata

```json
{
  "tool": "analyze-mod-jar",
  "arguments": {
    "jarPath": "/path/to/mymod-1.0.0.jar",
    "includeClasses": true
  }
}
```

### Decompile the mod JAR

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

### Read a specific class from decompiled source

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

### Search across decompiled mod source

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

### Remap a mod JAR to readable names

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

## Validation

### Validate Mixin source

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

### Validate Access Widener content

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

## Registry and Diagnostics

### Get all registries for a version

```json
{
  "tool": "get-registry-data",
  "arguments": {
    "version": "1.21.10",
    "includeData": false
  }
}
```

### Inspect runtime metrics

```json
{
  "tool": "get-runtime-metrics",
  "arguments": {}
}
```
