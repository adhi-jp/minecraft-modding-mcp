import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "./helpers/zip.ts";

const EXPECTED_TOOLS = [
  "inspect-minecraft",
  "analyze-symbol",
  "compare-minecraft",
  "analyze-mod",
  "validate-project",
  "manage-cache",
  "list-versions",
  "resolve-artifact",
  "find-class",
  "get-class-source",
  "get-class-members",
  "search-class-source",
  "get-artifact-file",
  "list-artifact-files",
  "trace-symbol-lifecycle",
  "diff-class-signatures",
  "find-mapping",
  "resolve-method-mapping-exact",
  "get-class-api-matrix",
  "resolve-workspace-symbol",
  "check-symbol-exists",
  "nbt-to-json",
  "nbt-apply-json-patch",
  "json-to-nbt",
  "index-artifact",
  "get-runtime-metrics",
  "validate-mixin",
  "validate-access-widener",
  "analyze-mod-jar",
  "get-registry-data",
  "compare-versions",
  "decompile-mod-jar",
  "get-mod-class-source",
  "search-mod-source",
  "remap-mod-jar"
] as const;

test("index.ts registers the expected MCP tools without mc prefix", async () => {
  const source = await readFile("src/index.ts", "utf8");

  for (const toolName of EXPECTED_TOOLS) {
    assert.match(source, new RegExp(`server\\.tool\\("${toolName}"`));
  }

  const registrations = source.match(/server\.tool\(/g) ?? [];
  assert.equal(registrations.length, EXPECTED_TOOLS.length);
});

test("manual stdio smoke validates restarted list-versions against the current releases contract", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /requireToolOk<ListVersionsOutput>\(\s*"list-versions-after-restart"/s);
  assert.match(source, /versionsAfterRestart\.releases/);
  assert.doesNotMatch(source, /versionsAfterRestart\.items/);
});

test("manual stdio smoke bounds transport shutdown and force-kills a stuck supervisor", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /async function closeTransportWithTimeout\(transport: StdioClientTransport/);
  assert.match(source, /const pid = transport\.pid;/);
  assert.match(source, /const closePromise = transport\.close\(\)\.catch\(\(\) => undefined\);/);
  assert.match(source, /await Promise\.race\(\[\s*closePromise\.then\(\(\) => false\),\s*wait\(timeoutMs\)\.then\(\(\) => true\)\s*\]\)/s);
  assert.match(source, /process\.kill\(pid,\s*"SIGTERM"\)/);
  assert.match(source, /process\.kill\(pid,\s*"SIGKILL"\)/);
});

test("manual stdio smoke fully terminates the content-length probe child process", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /async function terminateChildProcess\(child: ChildProcess/);
  assert.match(source, /child\.kill\("SIGTERM"\)/);
  assert.match(source, /child\.kill\("SIGKILL"\)/);
  assert.match(source, /child\.unref\(\)/);
  assert.match(source, /await terminateChildProcess\(child\);/);
});

test("index.ts does not include legacy compatibility handlers", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.doesNotMatch(source, /server\.tool\("mc-/);
  assert.doesNotMatch(source, /mc-list-versions/);
  assert.doesNotMatch(source, /mc-resolve-source/);
  assert.doesNotMatch(source, /mc-get-source/);
  assert.doesNotMatch(source, /mc-search-source/);
  assert.doesNotMatch(source, /mc-query-symbols/);
  assert.doesNotMatch(source, /mc-get-source-context/);
  assert.doesNotMatch(source, /mc-get-source-file/);
  assert.doesNotMatch(source, /mc-resolve-context/);
  assert.doesNotMatch(source, /mc-find-symbol/);
  assert.doesNotMatch(source, /mc-get-class-index/);
  assert.doesNotMatch(source, /mc-get-signature/);
  assert.doesNotMatch(source, /mc-map-name/);
  assert.doesNotMatch(source, /mc-trace-usage/);
});

test("index.ts accepts expanded mapping enum in tool inputs", async () => {
  const source = await readFile("src/index.ts", "utf8");

  const mappingDescriptionMatches =
    source.match(/\.describe\("obfuscated \| mojang \| intermediary \| yarn/g) ?? [];
  assert.ok(mappingDescriptionMatches.length >= 4);
  assert.match(source, /const SOURCE_MAPPINGS = \["obfuscated", "mojang", "intermediary", "yarn"\] as const;/);
  assert.doesNotMatch(source, /const SOURCE_MAPPINGS = \["official", "mojang", "intermediary", "yarn"\] as const;/);
  assert.match(source, /sourceMapping:/);
});

test("index.ts coerces numeric string inputs for positive integer params", async () => {
  const indexSource = await readFile("src/index.ts", "utf8");
  const toolInputSource = await readFile("src/tool-input.ts", "utf8");

  assert.match(indexSource, /const optionalPositiveInt = z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\);/);
  assert.match(indexSource, /import\s+\{\s*prepareToolInput\s*\}\s+from\s+"\.\/tool-input\.js"/);
  assert.match(indexSource, /prepareToolInput\(rawInput\)/);
  assert.match(toolInputSource, /const POSITIVE_INT_FIELD_NAMES = new Set\(\[/);
  assert.match(toolInputSource, /function coerceTopLevelNumericStrings\(value: unknown\): unknown/);
  assert.match(toolInputSource, /typeof value !== "object" \|\| value == null \|\| Array\.isArray\(value\)/);
  assert.match(toolInputSource, /typeof entry === "string" && POSITIVE_INT_FIELD_NAMES\.has\(key\)/);
  assert.match(toolInputSource, /Number\.parseInt\(trimmed, 10\)/);
  assert.doesNotMatch(toolInputSource, /output\[key\] = coerceKnownNumericStrings\(entry\)/);
});

test("index.ts rejects removed official mapping namespace with obfuscated replacement hint", async () => {
  const indexSource = await readFile("src/index.ts", "utf8");
  const toolInputSource = await readFile("src/tool-input.ts", "utf8");

  assert.match(toolInputSource, /const MAPPING_FIELD_NAMES = new Set\(\["mapping", "sourceMapping", "targetMapping", "classNameMapping"\]\);/);
  assert.match(toolInputSource, /function collectRemovedOfficialNamespacePaths\(value: unknown\): string\[\]/);
  assert.match(toolInputSource, /function replaceRemovedOfficialMappings\(value: unknown\): Record<string, unknown> \| undefined/);
  assert.match(indexSource, /The "official" mapping namespace was removed\. Use "obfuscated" instead\./);
  assert.match(indexSource, /"official" is no longer supported for this field\. Use "obfuscated"\./);
});

test("index.ts accepts mapping source priority override inputs", async () => {
  const source = await readFile("src/index.ts", "utf8");

  const priorityDescriptionMatches =
    source.match(/\.describe\("loom-first \| maven-first"\)/g) ?? [];
  assert.ok(priorityDescriptionMatches.length >= 4);
  assert.match(source, /const SOURCE_PRIORITIES = \["loom-first", "maven-first"\] as const;/);
});

test("index.ts documents validate-mixin mode-based input schema", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const nonEmptyString = z\.string\(\)\.trim\(\)\.min\(1\);/);
  assert.match(source, /input:\s*z\.discriminatedUnion\("mode"/);
  assert.match(source, /configPaths:\s*z\.array\(nonEmptyString\)\.min\(1\)/);
});

test("index.ts uses unified target objects for source resolution tools", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const resolveArtifactBlock = source.match(/const resolveArtifactShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const classSourceBlock = source.match(/const getClassSourceShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const classMembersBlock = source.match(/const getClassMembersShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(resolveArtifactBlock, /target:\s*z\.object\(\{\s*kind:\s*targetKindSchema,\s*value:\s*nonEmptyString/s);
  assert.match(source, /type:\s*z\.literal\("artifact"\),\s*artifactId:\s*nonEmptyString/s);
  assert.match(source, /type:\s*z\.literal\("resolve"\),\s*kind:\s*targetKindSchema,\s*value:\s*nonEmptyString/s);
  assert.doesNotMatch(resolveArtifactBlock, /targetKind:/);
  assert.doesNotMatch(classSourceBlock, /artifactId:/);
  assert.doesNotMatch(classSourceBlock, /targetKind:/);
  assert.doesNotMatch(classMembersBlock, /artifactId:/);
  assert.doesNotMatch(classMembersBlock, /targetKind:/);
});

test("index.ts reshapes search-class-source around compact file hits", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const block = source.match(/const searchClassSourceShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(block, /artifactId:\s*nonEmptyString/);
  assert.match(block, /query:\s*nonEmptyString/);
  assert.match(block, /intent:\s*searchIntentSchema\.optional\(\)/);
  assert.match(block, /symbolKind:\s*searchSymbolKindSchema\.optional\(\)/);
  assert.match(block, /queryMode:\s*z\.enum\(\["auto", "token", "literal"\]\)\.optional\(\)/);
  assert.doesNotMatch(block, /snippetLines:/);
  assert.doesNotMatch(block, /includeDefinition:/);
  assert.doesNotMatch(block, /includeOneHop:/);
  assert.match(source, /symbolKind filter is only supported when intent="symbol"/);
  assert.doesNotMatch(source, /optional one-hop relation expansion/);
});

test("index.ts removes kind from resolve-method-mapping-exact contract", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const block = source.match(/const resolveMethodMappingExactShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(block, /version:\s*nonEmptyString[\s\S]*owner:\s*nonEmptyString[\s\S]*descriptor:\s*nonEmptyString/s);
  assert.doesNotMatch(block, /kind:/);
  assert.doesNotMatch(source, /resolve-method-mapping-exact requires kind=method/);
});

test("index.ts reshapes validate-mixin around mode-based input", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const validateMixinShape = \{[\s\S]*input:\s*z\.discriminatedUnion\("mode"/s);
  assert.match(source, /mode:\s*z\.literal\("inline"\),\s*source:\s*nonEmptyString/s);
  assert.match(source, /mode:\s*z\.literal\("path"\),\s*path:\s*nonEmptyString/s);
  assert.match(source, /mode:\s*z\.literal\("paths"\),\s*paths:\s*z\.array\(nonEmptyString\)\.min\(1\)/s);
  assert.match(source, /mode:\s*z\.literal\("config"\),\s*configPaths:\s*z\.array\(nonEmptyString\)\.min\(1\)/s);
  assert.match(source, /mode:\s*z\.literal\("project"\),\s*path:\s*nonEmptyString/s);
  assert.match(source, /sourceRoots:\s*z\.array\(z\.string\(\)\.min\(1\)\)\.optional\(\)/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourcePath:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourcePaths:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*mixinConfigPath:/);
  assert.doesNotMatch(source, /const validateMixinShape = \{[\s\S]*sourceRoot:/);
});

test("validate-mixin tools/list schema exposes all mode-based inputs to clients", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/list");
  assert.ok(handler);

  const response = await handler!(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {}
  ) as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };

  const tool = response.tools.find((entry) => entry.name === "validate-mixin");
  assert.ok(tool);

  const inputSchema = tool!.inputSchema as {
    properties?: {
      input?: {
        description?: string;
        anyOf?: Array<{ properties?: { mode?: { const?: string } } }>;
      };
    };
  };
  const modeEntries = inputSchema.properties?.input?.anyOf ?? [];
  const modes = modeEntries
    .map((entry) => entry.properties?.mode?.const)
    .filter((value): value is string => typeof value === "string")
    .sort();

  assert.deepEqual(modes, ["config", "inline", "path", "paths", "project"]);
  assert.match(inputSchema.properties?.input?.description ?? "", /inline.*path.*paths.*config.*project/s);
});

test("validate-mixin invalid input returns problem details with a retryable suggestedCall", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate-mixin",
        arguments: {
          input: "@Mixin(Player.class) class ExampleMixin {}",
          version: "1.21.10"
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            input?: { mode?: string; source?: string };
            version?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "input");
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("input.mode")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-mixin");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    input: {
      mode: "inline",
      source: "@Mixin(Player.class) class ExampleMixin {}"
    },
    version: "1.21.10"
  });
});

test("validate-mixin invalid JSON-like input string preserves structured input in suggestedCall", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate-mixin",
        arguments: {
          input: "{\"mode\":\"path\",\"path\":\"/workspace/src/main/java/ExampleMixin.java\"}",
          version: "1.21.10"
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            input?: { mode?: string; path?: string };
            version?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-mixin");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    input: {
      mode: "path",
      path: "/workspace/src/main/java/ExampleMixin.java"
    },
    version: "1.21.10"
  });
});

test("source lookup tools/list schema clarifies object target inputs and loader scope fallback", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/list");
  assert.ok(handler);

  const response = await handler!(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {}
  ) as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };

  const toolMap = new Map(response.tools.map((entry) => [entry.name, entry.inputSchema]));
  const resolveArtifactSchema = toolMap.get("resolve-artifact") as {
    properties?: { target?: { description?: string }; scope?: { description?: string } };
  };
  const getClassSourceSchema = toolMap.get("get-class-source") as {
    properties?: { target?: { description?: string }; scope?: { description?: string } };
  };
  const getClassMembersSchema = toolMap.get("get-class-members") as {
    properties?: { target?: { description?: string }; scope?: { description?: string } };
  };
  const validateMixinSchema = toolMap.get("validate-mixin") as {
    properties?: { reportMode?: { enum?: string[]; description?: string } };
  };

  assert.match(resolveArtifactSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
  assert.match(getClassSourceSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
  assert.match(getClassMembersSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
  assert.match(resolveArtifactSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.match(getClassSourceSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.match(getClassMembersSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.deepEqual(
    [...(validateMixinSchema.properties?.reportMode?.enum ?? [])].sort(),
    ["compact", "full", "summary-first"]
  );
  assert.match(validateMixinSchema.properties?.reportMode?.description ?? "", /summary-first/i);
});

test("resolve-artifact invalid string target returns retryable object target suggestedCall", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolve-artifact",
        arguments: {
          target: "1.21.10"
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        suggestedCall?: {
          tool?: string;
          params?: { target?: { kind?: string; value?: string } };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "resolve-artifact");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    target: {
      kind: "version",
      value: "1.21.10"
    }
  });
});

test("get-class-source invalid string target returns resolve-target suggestedCall", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get-class-source",
        arguments: {
          className: "net.minecraft.server.Main",
          target: "1.21.10"
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        suggestedCall?: {
          tool?: string;
          params?: {
            className?: string;
            target?: { type?: string; kind?: string; value?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "get-class-source");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    className: "net.minecraft.server.Main",
    target: {
      type: "resolve",
      kind: "version",
      value: "1.21.10"
    }
  });
});

test("get-class-members invalid string target suggestedCall preserves valid fields only", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get-class-members",
        arguments: {
          className: "net.minecraft.server.Main",
          target: "1.21.10",
          access: "all",
          memberPattern: "tick",
          mode: "full",
          outputFile: "/tmp/ignored.java",
          startLine: 10
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: Record<string, unknown>;
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "get-class-members");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    className: "net.minecraft.server.Main",
    target: {
      type: "resolve",
      kind: "version",
      value: "1.21.10"
    },
    access: "all",
    memberPattern: "tick"
  });
});

test("index.ts exposes token-efficiency options on relevant tool schemas", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const diffClassSignaturesBlock = source.match(/const diffClassSignaturesShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const findMappingBlock = source.match(/const findMappingShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const resolveMethodBlock = source.match(/const resolveMethodMappingExactShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const classApiBlock = source.match(/const getClassApiMatrixShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const resolveWorkspaceBlock = source.match(/const resolveWorkspaceSymbolShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const checkExistsBlock = source.match(/const checkSymbolExistsShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const validateMixinBlock = source.match(/const validateMixinShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const registryBlock = source.match(/const getRegistryDataShape = \{[\s\S]*?\n\};/)?.[0] ?? "";
  const decompileBlock = source.match(/const decompileModJarShape = \{[\s\S]*?\n\};/)?.[0] ?? "";

  assert.match(diffClassSignaturesBlock, /includeFullDiff:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(findMappingBlock, /maxCandidates:\s*optionalPositiveInt/);
  assert.match(resolveMethodBlock, /maxCandidates:\s*optionalPositiveInt/);
  assert.match(classApiBlock, /maxRows:\s*optionalPositiveInt/);
  assert.match(resolveWorkspaceBlock, /maxCandidates:\s*optionalPositiveInt/);
  assert.match(checkExistsBlock, /maxCandidates:\s*optionalPositiveInt/);
  assert.match(validateMixinBlock, /includeIssues:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(registryBlock, /includeData:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(registryBlock, /maxEntriesPerRegistry:\s*optionalPositiveInt/);
  assert.match(decompileBlock, /includeFiles:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(decompileBlock, /maxFiles:\s*optionalPositiveInt/);
});

test("index.ts documents symbol-query grammar for mapping tools", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /kind:\s*workspaceSymbolKindSchema\.describe\("class \| field \| method"\)/);
  assert.match(source, /name:\s*nonEmptyString/);
  assert.match(source, /owner:\s*optionalNonEmptyString/);
  assert.match(source, /descriptor:\s*optionalNonEmptyString/);
});

test("index.ts documents exact method mapping and workspace symbol tools", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /server\.tool\("resolve-method-mapping-exact"/);
  assert.match(source, /server\.tool\("get-class-api-matrix"/);
  assert.match(source, /server\.tool\("resolve-workspace-symbol"/);
  assert.match(source, /server\.tool\("check-symbol-exists"/);
  assert.match(source, /\.describe\("class \| field \| method"\)/);
  assert.doesNotMatch(source, /memberName:/);
});

test("index.ts formats tool responses with result/error/meta envelope", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const helperSource = await readFile("src/mcp-helpers.ts", "utf8");

  assert.match(source, /result:/);
  assert.match(source, /error:/);
  assert.match(source, /meta:/);
  assert.match(source, /patch:\s*z\.array\(/);
  assert.match(helperSource, /structuredContent:\s*data/);
  assert.match(helperSource, /options\.isError \? \{ isError: true \} : \{\}/);
});

test("analyze-mod remap preview returns an operation block without mutating", async () => {
  const { server } = await import("../src/index.ts");

  const root = await mkdtemp(join(tmpdir(), "analyze-mod-tool-"));
  const jarPath = join(root, "example.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example",
      version: "1.0.0",
      name: "Example",
      depends: {
        minecraft: "1.21.10"
      }
    }, null, 2)
  });

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "analyze-mod",
        arguments: {
          task: "remap",
          subject: {
            kind: "jar",
            jarPath
          },
          targetMapping: "mojang",
          executionMode: "preview"
        }
      }
    },
    {}
  ) as {
    structuredContent?: {
      result?: {
        summary?: { status?: string };
        operation?: { executionMode?: string; targetMapping?: string };
      };
    };
  };

  assert.equal(result.structuredContent?.result?.summary?.status, "unchanged");
  assert.equal(result.structuredContent?.result?.operation?.executionMode, "preview");
  assert.equal(result.structuredContent?.result?.operation?.targetMapping, "mojang");
});

test("manage-cache summary normalizes apply to preview at the public contract", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "manage-cache",
        arguments: {
          action: "summary",
          cacheKinds: ["downloads"],
          executionMode: "apply",
          include: ["preview", "warnings"]
        }
      }
    },
    {}
  ) as {
    structuredContent?: {
      meta?: {
        detailApplied?: string;
        includeApplied?: string[];
      };
      result?: {
        operation?: { executionMode?: string };
      };
    };
  };

  assert.equal(result.structuredContent?.meta?.detailApplied, "summary");
  assert.deepEqual(result.structuredContent?.meta?.includeApplied, ["warnings", "preview"]);
  assert.equal(result.structuredContent?.result?.operation?.executionMode, "preview");
});

test("analyze-symbol rejects api-overview requests that include owner or descriptor selectors", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "analyze-symbol",
        arguments: {
          task: "api-overview",
          version: "1.21.10",
          subject: {
            kind: "class",
            name: "net.minecraft.world.level.block.Blocks",
            owner: "net.minecraft.world.level.block.Blocks"
          }
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject.owner")
  );
});

test("validate-project rejects top-level configPaths for direct access-widener validation", async () => {
  const { server } = await import("../src/index.ts");

  const handler = (server.server as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  assert.ok(handler);

  const result = await handler!(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate-project",
        arguments: {
          task: "access-widener",
          version: "1.21.10",
          configPaths: ["example.mixins.json"],
          subject: {
            kind: "access-widener",
            input: {
              mode: "inline",
              content: "accessWidener v2 named"
            }
          }
        }
      }
    },
    {}
  ) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "configPaths")
  );
});

test("index.ts validates includeKinds values instead of silently ignoring invalid kinds", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const classApiKindsSchema = z\.string\(\)/);
  assert.doesNotMatch(source, /includeKinds:\s*z\.string\(\)\.optional\(\)/);
});

test("index.ts maps NBT parse failures to bad request status", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /code === ERROR_CODES\.NBT_PARSE_FAILED/);
});

test("index.ts serializes heavy analysis tools to protect MCP transport stability", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /import\s+\{\s*ToolExecutionGate\s*\}\s+from\s+"\.\/tool-execution-gate\.js"/);
  assert.match(source, /const HEAVY_TOOL_NAMES = new Set\(\[/);
  assert.match(source, /"trace-symbol-lifecycle"/);
  assert.match(source, /"diff-class-signatures"/);
  assert.match(source, /"compare-versions"/);
  assert.match(source, /"find-mapping"/);
  assert.match(source, /const heavyToolExecutionGate = new ToolExecutionGate\(/);
  assert.match(source, /HEAVY_TOOL_NAMES\.has\(tool\)/);
  assert.match(source, /heavyToolExecutionGate\.run\(tool,\s*\(\)\s*=>\s*action\(parsedInput\)\)/s);
});

test("index.ts remap target enum includes yarn and mojang", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const REMAP_TARGETS = \["yarn", "mojang"\] as const;/);
});

// ── Resources integration ──────────────────────────────────────────

const EXPECTED_FIXED_RESOURCES = ["versions-list", "runtime-metrics"] as const;

const EXPECTED_TEMPLATE_RESOURCES = [
  "class-source",
  "artifact-file",
  "find-mapping",
  "class-members",
  "artifact-metadata"
] as const;

const ALL_RESOURCES = [...EXPECTED_FIXED_RESOURCES, ...EXPECTED_TEMPLATE_RESOURCES] as const;

test("resources.ts registers the expected fixed and template resources", async () => {
  const source = await readFile("src/resources.ts", "utf8");

  for (const name of ALL_RESOURCES) {
    assert.match(source, new RegExp(`server\\.resource\\("${name}"`));
  }

  const registrations = source.match(/server\.resource\(/g) ?? [];
  assert.equal(registrations.length, ALL_RESOURCES.length);
});

test("resources.ts uses ResourceTemplate for template resources", async () => {
  const source = await readFile("src/resources.ts", "utf8");

  const templateConstructors = source.match(/new ResourceTemplate\(/g) ?? [];
  assert.equal(templateConstructors.length, EXPECTED_TEMPLATE_RESOURCES.length);
});

test("index.ts calls registerResources", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /registerResources\(server,\s*sourceService\)/);
  assert.match(source, /import\s*\{[^}]*registerResources[^}]*\}\s*from\s*"\.\/resources\.js"/);
});


test("index.ts lazily initializes SourceService to reduce startup overhead", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /let\s+sourceServiceInstance:\s*SourceService\s*\|\s*undefined/);
  assert.match(source, /function\s+getSourceService\(\):\s*SourceService/);
  assert.match(source, /sourceServiceInstance\s*\?\?=\s*new\s+SourceService\(config\)/);
  assert.match(source, /const\s+sourceService\s*=\s*new\s+Proxy\(/);
  assert.doesNotMatch(source, /setImmediate\(getSourceService\)/);
});

test("get-class-members contract preserves actual mappingApplied metadata", async () => {
  const serviceSource = await readFile("src/source-service.ts", "utf8");

  assert.match(
    serviceSource,
    /async getClassMembers[\s\S]*requestedMapping,[\s\S]*mappingApplied,[\s\S]*provenance: normalizedProvenance/
  );
  assert.doesNotMatch(
    serviceSource,
    /async getClassMembers[\s\S]*mappingApplied:\s*requestedMapping/
  );
});

test("CLI entrypoint runs a supervised worker wrapper around startServer", async () => {
  const cliSource = await readFile("src/cli.ts", "utf8");
  const supervisorSource = await readFile("src/stdio-supervisor.ts", "utf8");

  assert.match(cliSource, /^#!\/usr\/bin\/env node/m);
  assert.match(cliSource, /import\s+\{\s*startServer\s*\}\s+from\s+"\.\/index\.js"/);
  assert.match(cliSource, /import\s+\{\s*STDIO_WORKER_MODE_ENV,\s*StdioSupervisor\s*\}\s+from\s+"\.\/stdio-supervisor\.js"/);
  assert.match(cliSource, /if\s*\(process\.env\[STDIO_WORKER_MODE_ENV\]\s*===\s*"1"\)/);
  assert.match(cliSource, /const keepAliveTimer = setInterval\(\(\) => undefined,\s*60_000\)/);
  assert.match(cliSource, /process\.stderr\.write\(`\$\{WORKER_READY_MARKER\}\\n`\)/);
  assert.match(cliSource, /new StdioSupervisor\(/);
  assert.match(supervisorSource, /const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__"/);
  assert.match(supervisorSource, /handleWorkerReady\(\)/);
  assert.match(supervisorSource, /this\.queuedMessages\.push\(message\)/);
  assert.match(supervisorSource, /this\.forwardToWorker\(this\.initializeRequest\)/);
  assert.match(supervisorSource, /buildWorkerRestartError/);
});

test("startServer installs process-level error handlers", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /process\.on\("uncaughtException"/);
  assert.match(source, /process\.on\("unhandledRejection"/);
  assert.match(source, /attachProcessErrorHandlers\(\)/);
});

test("index.ts uses compatibility stdio transport for newline and Content-Length clients", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /import\s+\{\s*CompatStdioServerTransport\s*\}\s+from\s+"\.\/compat-stdio-transport\.js"/);
  assert.match(source, /new CompatStdioServerTransport\(\)/);
  assert.doesNotMatch(source, /server\/stdio\.js/);
});
