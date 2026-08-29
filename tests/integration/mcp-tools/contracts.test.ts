import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXPECTED_TOOLS } from "../../helpers/expected-tools.ts";
import { validateMixinSchema, getClassSourceSchema, getClassMembersSchema } from "../../../src/tool-schemas.ts";
import { listTools, type ToolSchema } from "../../helpers/mcp-tools-harness.ts";

function schemaDeclaresProperty(schema: unknown, key: string): boolean {
  if (Array.isArray(schema)) {
    return schema.some((entry) => schemaDeclaresProperty(entry, key));
  }
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && key in (properties as Record<string, unknown>)) {
      return true;
    }
    return Object.values(record).some((value) => schemaDeclaresProperty(value, key));
  }
  return false;
}

test("tools/list exposes the expected MCP tools without legacy mc prefixes", async () => {
  const toolNames = (await listTools()).map((entry) => entry.name).sort();

  assert.deepEqual(toolNames, [...EXPECTED_TOOLS].sort());
  assert.ok(toolNames.every((name) => !name.startsWith("mc-")));
});

test("expert tools steer callers to the entry tools, which keep plain descriptions", async () => {
  const tools = (await listTools()) as Array<ToolSchema & { description?: string }>;
  const description = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
  const NOTE = /prefer the entry tools/;

  // Entry, batch, and the no-entry-equivalent utilities must NOT carry the note.
  const plainTools = [
    "inspect-minecraft", "analyze-symbol", "compare-minecraft", "analyze-mod", "validate-project", "manage-cache",
    "verify-mixin-target", "batch-class-source", "batch-class-members", "batch-symbol-exists", "batch-mappings",
    "nbt-to-json", "nbt-apply-json-patch", "json-to-nbt", "get-runtime-metrics", "get-registry-data"
  ];
  for (const name of plainTools) {
    assert.ok(description.has(name), `${name} must be registered`);
    assert.doesNotMatch(description.get(name)!, NOTE, `${name} must not carry the expert-tool note`);
  }

  // Every low-level tool that duplicates an entry-tool capability carries it.
  const expertTools = [
    "list-versions", "resolve-artifact", "find-class", "get-class-source", "get-class-members",
    "search-class-source", "get-artifact-file", "list-artifact-files", "index-artifact",
    "trace-symbol-lifecycle", "diff-class-signatures", "compare-versions",
    "find-mapping", "resolve-method-mapping-exact", "get-class-api-matrix", "resolve-workspace-symbol", "check-symbol-exists",
    "analyze-mod-jar", "decompile-mod-jar", "get-mod-class-source", "search-mod-source", "remap-mod-jar",
    "validate-mixin", "validate-access-widener", "validate-access-transformer"
  ];
  for (const name of expertTools) {
    assert.ok(description.has(name), `${name} must be registered`);
    assert.match(description.get(name)!, NOTE, `${name} must carry the expert-tool note`);
  }

  // Together they account for every registered tool (no tool left unclassified).
  assert.equal(plainTools.length + expertTools.length, EXPECTED_TOOLS.length);
});

test("README states the registered tool count and entry/expert split", async () => {
  const readme = await readFile("README.md", "utf8");
  const entryCount = 6;
  const expertCount = EXPECTED_TOOLS.length - entryCount;

  assert.match(
    readme,
    new RegExp(`\\*\\*${EXPECTED_TOOLS.length} tools\\*\\*`),
    `README must state "${EXPECTED_TOOLS.length} tools"`
  );
  assert.ok(
    readme.includes(`${entryCount} entry + ${expertCount} expert`),
    `README must state "${entryCount} entry + ${expertCount} expert"`
  );
});

test("read-only tools do not expose file-writing fields", async () => {
  const tools = (await listTools()) as Array<ToolSchema & { annotations?: { readOnlyHint?: boolean } }>;
  const offenders = tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .filter((tool) => schemaDeclaresProperty(tool.inputSchema, "outputFile"))
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(
    offenders,
    [],
    `read-only tools must not accept the write-capable outputFile field: ${offenders.join(", ")}`
  );
});

test("index-artifact declares write annotations (readOnlyHint:false, idempotentHint:true)", async () => {
  const tools = (await listTools()) as Array<
    ToolSchema & { annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }
  >;
  const indexArtifact = tools.find((tool) => tool.name === "index-artifact");
  assert.ok(indexArtifact, "index-artifact tool must be registered");
  assert.equal(
    indexArtifact?.annotations?.readOnlyHint,
    false,
    "index-artifact writes the SQLite index, so it must declare readOnlyHint:false"
  );
  assert.equal(
    indexArtifact?.annotations?.idempotentHint,
    true,
    "re-indexing the same artifact is idempotent, so it must declare idempotentHint:true"
  );
});

test("network-local NBT/runtime tools declare openWorldHint:false; network/cache tools do not", async () => {
  const tools = (await listTools()) as Array<
    ToolSchema & { annotations?: { openWorldHint?: boolean } }
  >;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Purely-local deterministic transforms must be marked closed-world.
  for (const name of ["nbt-to-json", "nbt-apply-json-patch", "json-to-nbt", "get-runtime-metrics"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(
      tool?.annotations?.openWorldHint,
      false,
      `${name} is a deterministic local transform and must declare openWorldHint:false`
    );
  }

  // Cache-with-network-fallback tools must NOT be marked closed-world (they fetch on a miss).
  for (const name of ["get-class-source", "get-class-members", "find-mapping", "find-class", "search-class-source"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.notEqual(
      tool?.annotations?.openWorldHint,
      false,
      `${name} falls back to network on a cache miss and must not declare openWorldHint:false`
    );
  }
});

test("validate-mixin tools/list schema exposes all mode-based inputs to clients", async () => {
  const tool = (await listTools()).find((entry) => entry.name === "validate-mixin");

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

test("inspect-minecraft tools/list schema explains structured workspace focus dispatch", async () => {
  const tool = (await listTools()).find((entry) => entry.name === "inspect-minecraft");
  assert.ok(tool);

  type SchemaNode = {
    description?: string;
    const?: string;
    anyOf?: SchemaNode[];
    properties?: Record<string, SchemaNode>;
  };

  const schema = tool.inputSchema as SchemaNode;
  assert.match(
    schema.properties?.task?.description ?? "",
    /auto.*subject\.kind.*focus\.kind.*not.*natural-language/is
  );

  const subjectBranches = schema.properties?.subject?.anyOf ?? [];
  const workspace = subjectBranches.find((entry) => entry.properties?.kind?.const === "workspace");
  const focus = workspace?.properties?.focus;
  assert.match(focus?.description ?? "", /Object, not string\./);
  assert.match(focus?.description ?? "", /class.*file.*search/is);

  const focusBranches = new Map(
    (focus?.anyOf ?? []).map((entry) => [entry.properties?.kind?.const, entry])
  );
  assert.deepEqual([...focusBranches.keys()].sort(), ["class", "file", "search"]);
  assert.match(focusBranches.get("class")?.description ?? "", /className/);
  assert.match(focusBranches.get("file")?.description ?? "", /filePath/);
  assert.match(focusBranches.get("search")?.description ?? "", /query/);
});

test("validate-mixin tools/list input schema does NOT introduce budget/test-only parameters", async () => {
  const tool = (await listTools()).find((entry) => entry.name === "validate-mixin");
  assert.ok(tool);

  const propertyNames = Object.keys(
    (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
  );

  // Spec §テスト Integration / smoke #1: input schema does not change.
  // __stageBudgets / __testHooks / stageEmitter must remain internal.
  for (const internalKey of ["__stageBudgets", "__testHooks", "stageEmitter"]) {
    assert.ok(
      !propertyNames.includes(internalKey),
      `validate-mixin input schema must not expose internal key "${internalKey}"`
    );
  }
});

test("source lookup tools/list schema clarifies object target inputs and loader scope semantics", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
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

  assert.match(resolveArtifactSchema.properties?.target?.description ?? "", /Object, not string\./);
  assert.match(getClassSourceSchema.properties?.target?.description ?? "", /Object, not string\./);
  assert.match(getClassMembersSchema.properties?.target?.description ?? "", /Object, not string\./);
  assert.match(resolveArtifactSchema.properties?.scope?.description ?? "", /loader.*runtime/i);
  assert.match(getClassSourceSchema.properties?.scope?.description ?? "", /loader.*runtime/i);
  assert.match(getClassMembersSchema.properties?.scope?.description ?? "", /loader.*runtime/i);
  assert.deepEqual(
    [...(validateMixinSchema.properties?.reportMode?.enum ?? [])].sort(),
    ["compact", "full", "summary-first"]
  );
  assert.match(validateMixinSchema.properties?.reportMode?.description ?? "", /summary-first/i);
});

test("validate-access-transformer tools/list schema exposes AT namespace and runtime-aware inputs", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
  const schema = toolMap.get("validate-access-transformer") as {
    properties?: {
      atNamespace?: { enum?: string[] };
      projectPath?: { description?: string };
      scope?: { description?: string };
    };
  };

  assert.deepEqual([...(schema.properties?.atNamespace?.enum ?? [])].sort(), ["mojang", "obfuscated", "srg"]);
  assert.match(schema.properties?.projectPath?.description ?? "", /workspace root/i);
  assert.match(schema.properties?.scope?.description ?? "", /loader.*runtime/i);
});

test("get-artifact-file, index-artifact, list-artifact-files, and search-class-source tools/list schemas expose projectPath for workspace resolution", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
  for (const name of ["get-artifact-file", "index-artifact", "list-artifact-files", "search-class-source"]) {
    const schema = toolMap.get(name) as
      | { properties?: { projectPath?: { description?: string } } }
      | undefined;
    assert.ok(schema, `${name} must be registered`);
    assert.match(
      schema?.properties?.projectPath?.description ?? "",
      /workspace root/i,
      `${name} tools/list schema must advertise projectPath`
    );
  }
});

test("tools/list schemas expose explicit defaults for public input parameters", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
  const listVersionsSchema = toolMap.get("list-versions") as {
    properties?: { includeSnapshots?: { default?: boolean }; limit?: { default?: number } };
  };
  const resolveArtifactSchema = toolMap.get("resolve-artifact") as {
    properties?: { allowDecompile?: { default?: boolean }; scope?: { default?: string } };
  };
  const validateMixinSchema = toolMap.get("validate-mixin") as {
    properties?: {
      minSeverity?: { default?: string };
      hideUncertain?: { default?: boolean };
      explain?: { default?: boolean };
      warningMode?: { default?: string };
      preferProjectMapping?: { default?: boolean };
      reportMode?: { default?: string };
      treatInfoAsWarning?: { default?: boolean };
      includeIssues?: { default?: boolean };
    };
  };
  const searchClassSourceSchema = toolMap.get("search-class-source") as {
    properties?: { queryMode?: { default?: string }; limit?: { default?: number } };
  };
  const inspectMinecraftSchema = toolMap.get("inspect-minecraft") as {
    properties?: { includeSnapshots?: { default?: boolean }; limit?: { default?: number } };
  };
  const analyzeSymbolSchema = toolMap.get("analyze-symbol") as {
    properties?: {
      nameMode?: { default?: string };
      signatureMode?: { default?: string };
      maxCandidates?: { default?: number };
      sourceMapping?: { default?: string };
    };
  };
  const compareMinecraftSchema = toolMap.get("compare-minecraft") as {
    properties?: {
      includeFullDiff?: { default?: boolean };
      maxClassResults?: { default?: number };
      limit?: { default?: number };
    };
  };
  const analyzeModSchema = toolMap.get("analyze-mod") as {
    properties?: {
      searchType?: { default?: string };
      includeFiles?: { default?: boolean };
      limit?: { default?: number };
      executionMode?: { default?: string };
    };
  };
  const validateProjectSchema = toolMap.get("validate-project") as {
    properties?: {
      preferProjectMapping?: { default?: boolean };
      minSeverity?: { default?: string };
      hideUncertain?: { default?: boolean };
      explain?: { default?: boolean };
      warningMode?: { default?: string };
      treatInfoAsWarning?: { default?: boolean };
      includeIssues?: { default?: boolean };
    };
  };
  const manageCacheSchema = toolMap.get("manage-cache") as {
    properties?: {
      executionMode?: { default?: string };
      limit?: { default?: number };
      cacheKinds?: { default?: unknown };
    };
  };
  const checkSymbolExistsToolSchema = toolMap.get("check-symbol-exists") as {
    properties?: { signatureMode?: { default?: string }; nameMode?: { default?: string } };
  };
  const findMappingToolSchema = toolMap.get("find-mapping") as {
    properties?: { signatureMode?: { default?: string }; nameMode?: { default?: string } };
  };

  function collectQueryModeDefaults(schema: unknown): string[] {
    const collected: string[] = [];
    const visit = (node: unknown) => {
      if (typeof node !== "object" || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      const properties = record.properties;
      if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
        const queryMode = (properties as Record<string, unknown>).queryMode;
        if (typeof queryMode === "object" && queryMode !== null) {
          const defaultValue = (queryMode as { default?: unknown }).default;
          if (typeof defaultValue === "string") {
            collected.push(defaultValue);
          }
        }
      }
      for (const value of Object.values(record)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            visit(entry);
          }
          continue;
        }
        visit(value);
      }
    };

    visit(schema);
    return collected;
  }

  assert.equal(listVersionsSchema.properties?.includeSnapshots?.default, false);
  assert.equal(listVersionsSchema.properties?.limit?.default, 20);
  assert.equal(resolveArtifactSchema.properties?.allowDecompile?.default, true);
  assert.equal(resolveArtifactSchema.properties?.scope?.default, undefined);
  assert.equal(searchClassSourceSchema.properties?.queryMode?.default, "auto");
  assert.equal(searchClassSourceSchema.properties?.limit?.default, 20);
  assert.equal(validateMixinSchema.properties?.minSeverity?.default, "all");
  assert.equal(validateMixinSchema.properties?.hideUncertain?.default, false);
  assert.equal(validateMixinSchema.properties?.explain?.default, false);
  assert.equal(validateMixinSchema.properties?.warningMode?.default, undefined);
  assert.equal(validateMixinSchema.properties?.preferProjectMapping?.default, false);
  assert.equal(validateMixinSchema.properties?.reportMode?.default, "summary-first");
  assert.equal(validateMixinSchema.properties?.treatInfoAsWarning?.default, true);
  assert.equal(validateMixinSchema.properties?.includeIssues?.default, true);
  assert.equal(inspectMinecraftSchema.properties?.includeSnapshots?.default, false);
  assert.equal(inspectMinecraftSchema.properties?.limit?.default, undefined);
  assert.equal(analyzeSymbolSchema.properties?.nameMode?.default, "auto");
  // analyze-symbol's OWN signatureMode default stays "exact" (entry tool, intentionally not flipped).
  assert.equal(analyzeSymbolSchema.properties?.signatureMode?.default, "exact");
  assert.equal(analyzeSymbolSchema.properties?.maxCandidates?.default, 5);
  assert.equal(analyzeSymbolSchema.properties?.sourceMapping?.default, undefined);
  // Expert symbol-lookup tools now share a name-only signatureMode default + auto nameMode.
  assert.equal(checkSymbolExistsToolSchema.properties?.signatureMode?.default, "name-only");
  assert.equal(checkSymbolExistsToolSchema.properties?.nameMode?.default, "auto");
  assert.equal(findMappingToolSchema.properties?.signatureMode?.default, "name-only");
  assert.equal(findMappingToolSchema.properties?.nameMode?.default, "auto");
  assert.equal(compareMinecraftSchema.properties?.includeFullDiff?.default, true);
  assert.equal(compareMinecraftSchema.properties?.maxClassResults?.default, 500);
  assert.equal(compareMinecraftSchema.properties?.limit?.default, undefined);
  assert.equal(analyzeModSchema.properties?.searchType?.default, "all");
  assert.equal(analyzeModSchema.properties?.includeFiles?.default, true);
  assert.equal(analyzeModSchema.properties?.limit?.default, 50);
  assert.equal(analyzeModSchema.properties?.executionMode?.default, "preview");
  assert.equal(validateProjectSchema.properties?.preferProjectMapping?.default, false);
  assert.equal(validateProjectSchema.properties?.minSeverity?.default, "all");
  assert.equal(validateProjectSchema.properties?.hideUncertain?.default, false);
  assert.equal(validateProjectSchema.properties?.explain?.default, false);
  assert.equal(validateProjectSchema.properties?.warningMode?.default, undefined);
  assert.equal(validateProjectSchema.properties?.treatInfoAsWarning?.default, true);
  assert.equal(validateProjectSchema.properties?.includeIssues?.default, true);
  assert.equal(validateProjectSchema.properties?.reportMode?.default, "summary-first");
  assert.equal(manageCacheSchema.properties?.executionMode?.default, "preview");
  assert.equal(manageCacheSchema.properties?.limit?.default, 50);
  assert.equal(manageCacheSchema.properties?.cacheKinds?.default, undefined);
  assert.deepEqual(collectQueryModeDefaults(inspectMinecraftSchema), ["auto", "auto"]);
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

test("index.ts wires check-symbol-exists into inspect-minecraft partial-source fallbacks", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const inspectMinecraftService = new InspectMinecraftService\(\{/);
  assert.match(source, /checkSymbolExists:\s*\(input\)\s*=>\s*sourceService\.checkSymbolExists\(input\)/);
});
