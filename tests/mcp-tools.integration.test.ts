import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "./helpers/zip.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { EXPECTED_TOOLS } from "./helpers/expected-tools.ts";
import { checkSymbolExistsSchema, validateMixinSchema, getClassSourceSchema, getClassMembersSchema, verifyMixinTargetMemberSchema, findMappingSchema } from "../src/tool-schemas.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-tools-integration-cache");

type RequestHandler = (
  request: { jsonrpc: string; id: number; method: string; params: Record<string, unknown> },
  extra: Record<string, unknown>
) => Promise<unknown>;

type ToolSchema = {
  name: string;
  inputSchema: Record<string, unknown>;
};

async function getRequestHandler(method: "tools/list" | "tools/call"): Promise<RequestHandler> {
  const { server } = await import("../src/index.ts");
  const handler = (server.server as { _requestHandlers: Map<string, RequestHandler> })._requestHandlers.get(method);

  assert.ok(handler);
  return handler!;
}

async function listTools(): Promise<ToolSchema[]> {
  const handler = await getRequestHandler("tools/list");
  const response = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {}
  ) as { tools: ToolSchema[] };

  return response.tools;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = await getRequestHandler("tools/call");
  return handler(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    },
    {}
  );
}

test("tools/list exposes the expected MCP tools without legacy mc prefixes", async () => {
  const toolNames = (await listTools()).map((entry) => entry.name).sort();

  assert.deepEqual(toolNames, [...EXPECTED_TOOLS].sort());
  assert.ok(toolNames.every((name) => !name.startsWith("mc-")));
});

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

test("check-symbol-exists accepts a dotless class name with the default nameMode", () => {
  const parsed = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "class",
    name: "ItemStack",
    sourceMapping: "mojang"
  });

  assert.ok(
    parsed.success,
    parsed.success ? "" : `dotless class name should parse by default: ${JSON.stringify(parsed.error.issues)}`
  );
});

test("check-symbol-exists kind=method without descriptor is accepted by the default signatureMode", () => {
  // Default signatureMode is now name-only (was exact), so a method query needs no descriptor.
  const parsed = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated"
  });
  assert.ok(parsed.success, parsed.success ? "" : `should parse by default: ${JSON.stringify(parsed.error.issues)}`);

  // signatureMode=exact still requires a descriptor for methods.
  const strict = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    signatureMode: "exact"
  });
  assert.equal(strict.success, false);
});

test("find-mapping accepts a dotless class name under the default nameMode and rejects it with nameMode=fqcn", () => {
  // Default nameMode=auto relaxes the FQCN requirement for any sourceMapping (was obfuscated-only).
  assert.equal(
    findMappingSchema.safeParse({
      version: "1.21.10",
      kind: "class",
      name: "ItemStack",
      sourceMapping: "mojang",
      targetMapping: "intermediary"
    }).success,
    true
  );
  // nameMode=fqcn still requires a fully-qualified name.
  assert.equal(
    findMappingSchema.safeParse({
      version: "1.21.10",
      kind: "class",
      name: "ItemStack",
      sourceMapping: "mojang",
      targetMapping: "intermediary",
      nameMode: "fqcn"
    }).success,
    false
  );
});

test("validate-mixin omits version requirement for project mode", () => {
  const parsed = validateMixinSchema.safeParse({
    input: { mode: "project", path: "/workspace" }
  });

  assert.ok(
    parsed.success,
    parsed.success ? "" : `project mode should not require version: ${JSON.stringify(parsed.error.issues)}`
  );
});

test("validate-mixin still requires version for inline mode without project detection", () => {
  const parsed = validateMixinSchema.safeParse({
    input: { mode: "inline", source: "class X {}" }
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.includes("version")));
  }
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

test("applyErrorMetaExtensions surfaces stageBudgetExhausted / budgetMs / elapsedMs on ERR_STAGE_BUDGET_PRE_PARSE", async () => {
  const { applyErrorMetaExtensions } = await import("../src/index.ts");
  const { createError, ERROR_CODES } = await import("../src/errors.ts");

  const meta: { stageBudgetExhausted?: boolean; budgetMs?: number; elapsedMs?: number } = {};
  applyErrorMetaExtensions(
    meta as never,
    createError({
      code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
      message: "Stage mapping-health exhausted budget before parse completed.",
      details: {
        failedStage: "mapping-health",
        stageBudgetExhausted: true,
        budgetMs: 1,
        elapsedMs: 12.5
      }
    })
  );
  assert.equal(meta.stageBudgetExhausted, true);
  assert.equal(meta.budgetMs, 1);
  assert.equal(meta.elapsedMs, 12.5);
});

test("applyErrorMetaExtensions does not touch meta for non-budget AppErrors or non-AppErrors", async () => {
  const { applyErrorMetaExtensions } = await import("../src/index.ts");
  const { createError, ERROR_CODES } = await import("../src/errors.ts");

  const meta1: Record<string, unknown> = {};
  applyErrorMetaExtensions(
    meta1 as never,
    createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "bad input",
      details: { stageBudgetExhausted: true, budgetMs: 99 }
    })
  );
  assert.deepEqual(meta1, {}, "non-budget AppErrors must not pass through budget meta");

  const meta2: Record<string, unknown> = {};
  applyErrorMetaExtensions(meta2 as never, new Error("plain"));
  assert.deepEqual(meta2, {}, "plain Error must not pass through budget meta");
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

test("validate-mixin invalid input returns problem details with a retryable suggestedCall", async () => {
  const result = await callTool("validate-mixin", {
    input: "@Mixin(Player.class) class ExampleMixin {}",
    version: "1.21.10",
    minSeverity: "all",
    hideUncertain: false,
    explain: false,
    preferProjectMapping: false,
    reportMode: "full",
    treatInfoAsWarning: true,
    includeIssues: true
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            input?: { mode?: string; source?: string };
            version?: string;
            reportMode?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "input");
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("input.mode")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-mixin");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    input: {
      mode: "inline",
      source: "@Mixin(Player.class) class ExampleMixin {}"
    },
    version: "1.21.10",
    // reportMode="full" is now a non-default explicit value, so it survives the
    // recovery suggestedCall (default is "summary-first").
    reportMode: "full"
  });
});

test("validate-mixin invalid JSON-like input string preserves structured input in suggestedCall", async () => {
  const result = await callTool("validate-mixin", {
    input: "{\"mode\":\"path\",\"path\":\"/workspace/src/main/java/ExampleMixin.java\"}",
    version: "1.21.10"
  }) as {
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

test("validate-mixin error envelope surfaces details.failedStage for caller recovery", async () => {
  const result = await callTool("validate-mixin", {
    input: { mode: "path", path: "/nonexistent/__validate_mixin_stage_test__/Missing.java" },
    version: "1.21.10"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
});

test("validate-mixin removed-namespace mapping=\"official\" carries failedStage=input-validation", async () => {
  const result = await callTool("validate-mixin", {
    input: { mode: "inline", source: "@Mixin(Player.class) class ExampleMixin {}" },
    version: "1.21.10",
    mapping: "official"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
        suggestedCall?: { tool?: string; params?: { mapping?: string } };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
});

test("validate-mixin removed-namespace surfaces a validated obfuscated suggestedCall via the single gate", async () => {
  // Regression lock for the double-validation removal: index.ts no longer
  // pre-validates the suggestedCall, so the sole mapErrorToProblem gate must
  // still emit the obfuscated replacement with no leaked internal marker.
  const result = await callTool("validate-mixin", {
    input: { mode: "inline", source: "@Mixin(Player.class) class ExampleMixin {}" },
    version: "1.21.10",
    mapping: "official"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: Record<string, unknown> & {
        code?: string;
        suggestedCall?: { tool?: string; params?: Record<string, unknown> };
      };
    };
  };

  assert.equal(result.isError, true);
  const error = result.structuredContent?.error;
  assert.equal(error?.code, "ERR_INVALID_INPUT");
  assert.equal(error?.suggestedCall?.tool, "validate-mixin");
  assert.equal(
    error?.suggestedCall?.params?.mapping,
    "obfuscated",
    "the single validation gate must rewrite official -> obfuscated in the suggestedCall"
  );
  // The internal buildSuggestedCall marker must never leak into the envelope.
  assert.equal(
    "_suggestedCallPrimaryDropped" in (error ?? {}),
    false,
    "the _suggestedCallPrimaryDropped marker must not appear in the error envelope"
  );
});

test("validate-project invalid legacy workspace payload returns a structured suggestedCall", async () => {
  const result = await callTool("validate-project", {
    task: "project-summary",
    subject: "/workspace/architectury",
    detail: "summary",
    include: ["projectSummary", "detectedConfig", "validationSummary"],
    preferProjectMapping: true,
    preferProjectVersion: true,
    includeIssues: false,
    warningMode: "aggregated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: { kind?: string; projectPath?: string };
            include?: string[];
            preferProjectMapping?: boolean;
            preferProjectVersion?: boolean;
            includeIssues?: boolean;
            warningMode?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject"));
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "include.0"));
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("subject.kind=workspace")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-project");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "project-summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/architectury"
    },
    include: ["workspace"],
    preferProjectMapping: true,
    preferProjectVersion: true,
    includeIssues: false,
    warningMode: "aggregated"
  });
});

test("analyze-mod invalid legacy summary payload returns a structured suggestedCall", async () => {
  const result = await callTool("analyze-mod", {
    task: "summary",
    subject: "/workspace/example.jar",
    detail: "summary",
    include: ["metadata", "entrypoints", "mixins", "dependencies"]
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            detail?: string;
            subject?: { kind?: string; jarPath?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject"));
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "include.0"));
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("subject.kind=jar")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "analyze-mod");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "summary",
    detail: "standard",
    subject: {
      kind: "jar",
      jarPath: "/workspace/example.jar"
    }
  });
});

test("analyze-mod invalid legacy summary payload without detail still promotes metadata retries to standard detail", async () => {
  const result = await callTool("analyze-mod", {
    task: "summary",
    subject: "/workspace/example.jar",
    include: ["metadata", "entrypoints"]
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            detail?: string;
            subject?: { kind?: string; jarPath?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "analyze-mod");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "summary",
    detail: "standard",
    subject: {
      kind: "jar",
      jarPath: "/workspace/example.jar"
    }
  });
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

test("inspect-minecraft search without artifact context returns retryable suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "search",
    subject: {
      kind: "search",
      query: "CreativeModeTab"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  // No detectable version: the recovery is a fill-in template (exampleCalls),
  // not a non-executable placeholder suggestedCall.
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "search");
  assert.equal(example?.params?.subject?.kind, "search");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-source without artifact context returns retryable suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    subject: {
      kind: "class",
      className: "net.minecraft.world.item.Item"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "class-source");
  assert.equal(example?.params?.subject?.kind, "class");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-members without artifact context preserves the requested task in suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-members",
    subject: {
      kind: "class",
      className: "net.minecraft.world.item.Item"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "class-members");
  assert.equal(example?.params?.subject?.kind, "class");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-source with version subject returns concrete retry guidance", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string; value?: string };
              };
            };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "class-source");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "class");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.kind, "version");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.value, "1.21.10");
});

test("inspect-minecraft class-members with version subject returns retry guidance instead of a dead-end error", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-members",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              version?: string;
            };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "artifact");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "version");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.version, "1.21.10");
});

test("resolve-artifact invalid string target returns retryable object target suggestedCall", async () => {
  const result = await callTool("resolve-artifact", {
    target: "1.21.10",
    allowDecompile: true,
    preferProjectVersion: false,
    strictVersion: false
  }) as {
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
  const result = await callTool("get-class-source", {
    className: "net.minecraft.server.Main",
    target: "1.21.10",
    mode: "metadata",
    allowDecompile: true,
    preferProjectVersion: false,
    strictVersion: false
  }) as {
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
      kind: "version",
      value: "1.21.10"
    }
  });
});

test("get-class-members invalid string target suggestedCall preserves valid fields only", async () => {
  const result = await callTool("get-class-members", {
    className: "net.minecraft.server.Main",
    target: "1.21.10",
    access: "all",
    memberPattern: "tick",
    mode: "full",
    outputFile: "/tmp/ignored.java",
    startLine: 10
  }) as {
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
      kind: "version",
      value: "1.21.10"
    },
    access: "all",
    memberPattern: "tick"
  });
});

test("get-class-source/get-class-members targets use the unified kind shape and reject the legacy type:artifact shape", () => {
  // New unified shape: same kind-based vocabulary as resolve-artifact, plus kind:"artifact".
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { kind: "artifact", artifactId: "x" } }).success, true);
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { kind: "version", value: "1.21.10" } }).success, true);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { kind: "artifact", artifactId: "x" } }).success, true);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { kind: "dependency", group: "g", name: "n" } }).success, true);

  // The legacy `{type:"artifact",artifactId}` form (no `kind` discriminator) no longer validates —
  // it must migrate to `{kind:"artifact",artifactId}`.
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { type: "artifact", artifactId: "x" } }).success, false);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { type: "artifact", artifactId: "x" } }).success, false);

  // Back-compat: the redundant `{type:"resolve",...}` wrapper still validates — the discriminated
  // union keys on `kind` and the now-ignored `type` key is stripped.
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { type: "resolve", kind: "version", value: "1.21.10" } }).success, true);
});

test("get-class-members surfaces meta.warningDetails for the truncation family", async () => {
  const root = await mkdtemp(join(tmpdir(), "warning-details-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [
        { name: "alpha", descriptor: "()V", accessFlags: 0x0001 },
        { name: "beta", descriptor: "()V", accessFlags: 0x0001 },
        { name: "gamma", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  const result = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all",
    maxMembers: 1
  }) as {
    structuredContent?: {
      result?: { truncated?: boolean };
      meta?: { warnings?: string[]; warningDetails?: Array<{ code?: string; category?: string; index?: number; message?: string }> };
    };
  };

  assert.equal(result.structuredContent?.result?.truncated, true);
  const details = result.structuredContent?.meta?.warningDetails;
  assert.ok(Array.isArray(details) && details.length >= 1, "expected meta.warningDetails");
  const truncationDetail = details!.find((d) => d.code === "result_truncated" && d.category === "pagination");
  assert.ok(truncationDetail, "truncation warning must classify as result_truncated/pagination");
  // The text lives only in meta.warnings; the detail references it by index.
  const warnings = result.structuredContent?.meta?.warnings;
  assert.ok(Array.isArray(warnings));
  assert.equal(typeof truncationDetail!.index, "number");
  assert.equal(typeof warnings![truncationDetail!.index!], "string");
  assert.equal(truncationDetail!.message, undefined, "warningDetails must not duplicate the text");
});

test("get-class-source/get-class-members schemas default includeProvenance to false and accept true", () => {
  const target = { kind: "artifact", artifactId: "x" } as const;
  const source = getClassSourceSchema.parse({ className: "a.B", target });
  assert.equal(source.includeProvenance, false);
  assert.equal(getClassSourceSchema.parse({ className: "a.B", target, includeProvenance: true }).includeProvenance, true);
  const members = getClassMembersSchema.parse({ className: "a.B", target });
  assert.equal(members.includeProvenance, false);
  assert.equal(getClassMembersSchema.parse({ className: "a.B", target, includeProvenance: true }).includeProvenance, true);
  // includeDescriptors defaults false and is accepted.
  assert.equal(members.includeDescriptors, false);
  assert.equal(getClassMembersSchema.parse({ className: "a.B", target, includeDescriptors: true }).includeDescriptors, true);
});

test("get-class-members drops FIELD jvmDescriptor by default and restores it with includeDescriptors (methods always keep it)", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-descriptor-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      fields: [{ name: "count", descriptor: "I", accessFlags: 0x0001 }],
      methods: [{ name: "run", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  type MembersResult = { structuredContent?: { result?: { members?: { fields?: Array<Record<string, unknown>>; methods?: Array<Record<string, unknown>> } } } };
  const base = { target: { kind: "artifact", artifactId }, className: "com.example.Widget", access: "all" } as const;

  const def = await callTool("get-class-members", base) as MembersResult;
  const defMembers = def.structuredContent?.result?.members ?? {};
  assert.equal(defMembers.fields?.[0]?.jvmDescriptor, undefined, "field descriptor omitted by default");
  assert.equal(defMembers.methods?.[0]?.jvmDescriptor, "()V", "method descriptor always present");

  const opted = await callTool("get-class-members", { ...base, includeDescriptors: true }) as MembersResult;
  const optedMembers = opted.structuredContent?.result?.members ?? {};
  assert.equal(optedMembers.fields?.[0]?.jvmDescriptor, "I", "field descriptor restored with includeDescriptors");
  assert.equal(optedMembers.methods?.[0]?.jvmDescriptor, "()V");

  // The new include:["descriptors"] array form must be an equivalent alias on the expert tool.
  const viaInclude = await callTool("get-class-members", { ...base, include: ["descriptors"] }) as MembersResult;
  const viaIncludeMembers = viaInclude.structuredContent?.result?.members ?? {};
  assert.equal(viaIncludeMembers.fields?.[0]?.jvmDescriptor, "I", "field descriptor restored with include:[\"descriptors\"]");
});

test("get-class-source / get-class-members include:[\"provenance\"] round-trips diagnostics (alias of includeProvenance)", async () => {
  const root = await mkdtemp(join(tmpdir(), "include-provenance-roundtrip-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [{ name: "run", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });
  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  type Res = { structuredContent?: { result?: Record<string, unknown> } };
  const target = { kind: "artifact", artifactId } as const;

  // Default (no include) omits diagnostics; include:["provenance"] restores them — for both tools.
  const memDefault = await callTool("get-class-members", { target, className: "com.example.Widget", access: "all" }) as Res;
  assert.equal("provenance" in (memDefault.structuredContent?.result ?? {}), false, "members provenance omitted by default");
  const memInc = await callTool("get-class-members", { target, className: "com.example.Widget", access: "all", include: ["provenance"] }) as Res;
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in (memInc.structuredContent?.result ?? {}), `members ${key} restored with include:["provenance"]`);
  }
  const srcInc = await callTool("get-class-source", { target, className: "com.example.Widget", mode: "metadata", include: ["provenance"] }) as Res;
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in (srcInc.structuredContent?.result ?? {}), `source ${key} restored with include:["provenance"]`);
  }
});

test("get-class-members omits provenance/qualityFlags/artifactContents by default and restores them with includeProvenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-default-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [{ name: "alpha", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  const defaultResult = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all"
  }) as { structuredContent?: { result?: Record<string, unknown> } };
  const defaulted = defaultResult.structuredContent?.result ?? {};
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.equal(key in defaulted, false, `${key} must be omitted by default`);
  }
  // The diagnostic-free common path still carries the members + context.
  assert.ok("members" in defaulted);
  assert.ok("context" in defaulted, "context survives the default strip");

  const withProvenance = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all",
    includeProvenance: true
  }) as { structuredContent?: { result?: Record<string, unknown> } };
  const enriched = withProvenance.structuredContent?.result ?? {};
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in enriched, `${key} must return with includeProvenance:true`);
  }
});

test("analyze-mod remap preview returns an operation block without mutating", async () => {
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

  const result = await callTool("analyze-mod", {
    task: "remap",
    subject: {
      kind: "jar",
      jarPath
    },
    targetMapping: "mojang",
    executionMode: "preview"
  }) as {
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
  const result = await callTool("manage-cache", {
    action: "summary",
    cacheKinds: ["downloads"],
    executionMode: "apply",
    include: ["preview", "warnings"]
  }) as {
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

  // detailApplied is omitted when it equals the tool default ("summary" for entry tools)
  assert.equal(result.structuredContent?.meta?.detailApplied, undefined);
  assert.deepEqual(result.structuredContent?.meta?.includeApplied, ["warnings", "preview"]);
  assert.equal(result.structuredContent?.result?.operation?.executionMode, "preview");
});

test("analyze-symbol rejects api-overview requests that include owner or descriptor selectors", async () => {
  const result = await callTool("analyze-symbol", {
    task: "api-overview",
    version: "1.21.10",
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks",
      owner: "net.minecraft.world.level.block.Blocks"
    }
  }) as {
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

test("find-mapping accepts short obfuscated class names", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "class",
    name: "dhl",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
      result?: {
        status?: string;
        resolvedSymbol?: {
          name?: string;
        };
      };
    };
  };

  assert.notEqual(result.isError, true);
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.result?.status, "resolved");
  assert.equal(result.structuredContent?.result?.resolvedSymbol?.name, "dhl");
});


test("find-mapping kind=method without descriptor is accepted (default signatureMode=name-only)", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  // Whatever status (resolved/not_found/ambiguous), the input itself must not be rejected as invalid.
  assert.notEqual(
    result.structuredContent?.error?.code,
    "ERR_INVALID_INPUT",
    "find-mapping must not require descriptor under the default signatureMode=name-only"
  );
  assert.equal(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "descriptor"),
    undefined
  );
});

test("find-mapping signatureMode=exact still rejects method lookups missing a descriptor", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
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
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "descriptor")
  );
});

test("find-mapping signatureMode=name-only still rejects malformed descriptors", async () => {
  // name-only ignores a missing descriptor, but a malformed descriptor that the caller
  // does supply must still surface as ERR_INVALID_INPUT instead of being silently dropped.
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: "not-a-valid-descriptor",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "name-only"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
});

test("find-mapping descriptor validator rejects array dimensions above the JVM limit without a stack overflow", async () => {
  // JVM §4.3.2 caps array type dimensions at 255. Pathological inputs with 20000 leading `[`
  // must surface as ERR_INVALID_INPUT (enforcing the cap) and must NOT bubble up as
  // ERR_INTERNAL from a RangeError in the validator.
  const oversizedArrayDescriptor = `(${"[".repeat(20000)}I)V`;
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: oversizedArrayDescriptor,
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
    };
  };

  const errorCode = result.structuredContent?.error?.code;
  assert.notEqual(errorCode, "ERR_INTERNAL", "deep array descriptors must not crash the validator");
  assert.equal(
    errorCode,
    "ERR_INVALID_INPUT",
    "descriptors with more than 255 array dimensions must be rejected per JVM spec"
  );
});

test("find-mapping descriptor validator accepts arrays at the JVM dimension limit", async () => {
  // Exactly 255 leading `[` is the maximum valid JVM array depth. The validator must accept
  // the descriptor as syntactically valid (downstream may still return not_found because the
  // symbol does not exist); an ERR_INVALID_INPUT here would be an off-by-one rejection.
  const maxArrayDescriptor = `(${"[".repeat(255)}I)V`;
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: maxArrayDescriptor,
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: { code?: string };
    };
  };

  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INTERNAL");
});

test("find-mapping signatureMode=exact does not resolve to a different overload when the caller's descriptor is stale", async () => {
  // When only foo(I)V exists in the mapping graph and the caller asks for foo(Z)V with
  // signatureMode="exact", the service must NOT silently resolve to the (I)V overload via
  // the owner+name descriptorless fallback. This guards against a bug where exact
  // lookups could return wrong overloads during migration-tooling workflows.
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: "(Z)V",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      result?: {
        status?: string;
        resolved?: boolean;
        resolvedSymbol?: { descriptor?: string };
      };
      error?: { code?: string };
    };
  };

  // The call itself should not error on input validation (the descriptor is syntactically
  // valid). The specific graph state doesn't contain `tick(Z)V`, so we expect status=not_found
  // or mapping_unavailable — but NEVER resolved with a different descriptor.
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  const payload = result.structuredContent?.result;
  if (payload?.resolved === true && payload.resolvedSymbol?.descriptor) {
    assert.equal(
      payload.resolvedSymbol.descriptor,
      "(Z)V",
      "exact-mode resolution must only accept descriptors equal to the requested one"
    );
  }
});

test("find-mapping descriptor validator rejects empty return type and unterminated L references", async () => {
  const invalidCases: string[] = ["()", "(I)", "(L;)V", "(Lfoo)V", "()X"];
  for (const descriptor of invalidCases) {
    const result = await callTool("find-mapping", {
      version: "1.21.10",
      kind: "method",
      owner: "net.minecraft.server.Main",
      name: "tick",
      descriptor,
      sourceMapping: "obfuscated",
      targetMapping: "obfuscated",
      signatureMode: "exact"
    }) as {
      isError?: boolean;
      structuredContent?: {
        error?: {
          code?: string;
        };
      };
    };
    assert.equal(
      result.structuredContent?.error?.code,
      "ERR_INVALID_INPUT",
      `descriptor "${descriptor}" must be rejected as ERR_INVALID_INPUT`
    );
  }
});

test("verify-mixin-target member schema normalizes empty/whitespace descriptor to undefined", () => {
  // Empty / whitespace descriptors must normalize to undefined (treated as omitted),
  // matching every other optional descriptor field (optionalDescriptorString).
  const emptyCases: Array<{ kind: "method" | "field"; name: string; descriptor: string }> = [
    { kind: "method", name: "tick", descriptor: "" },
    { kind: "method", name: "tick", descriptor: "   " },
    { kind: "field", name: "airSupply", descriptor: "" },
    { kind: "field", name: "airSupply", descriptor: "\t " }
  ];
  for (const input of emptyCases) {
    const parsed = verifyMixinTargetMemberSchema.safeParse(input);
    assert.equal(parsed.success, true, `${input.kind} descriptor ${JSON.stringify(input.descriptor)} must parse`);
    if (parsed.success) {
      assert.equal(parsed.data.descriptor, undefined, "empty descriptor must normalize to undefined");
    }
  }
  // Guard against over-loosening: a real descriptor must survive verbatim (trimmed).
  const real = verifyMixinTargetMemberSchema.safeParse({ kind: "method", name: "tick", descriptor: "()V" });
  assert.equal(real.success, true);
  if (real.success) {
    assert.equal(real.data.descriptor, "()V");
  }
});

test("validate-project rejects top-level configPaths for direct access-widener validation", async () => {
  const result = await callTool("validate-project", {
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
  }) as {
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

// ---------------------------------------------------------------------------
// detail/include response contract (replaces the per-tool compact boolean)
// ---------------------------------------------------------------------------

test("expert and batch tools expose detail/include and no longer expose compact", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
  const detailTools = [
    "resolve-artifact",
    "find-mapping",
    "resolve-method-mapping-exact",
    "resolve-workspace-symbol",
    "check-symbol-exists",
    "get-class-source",
    "get-class-members",
    "search-class-source",
    "list-artifact-files",
    "batch-class-source",
    "batch-class-members",
    "batch-symbol-exists",
    "batch-mappings"
  ];
  for (const name of detailTools) {
    const schema = toolMap.get(name) as { properties?: Record<string, { enum?: string[]; default?: string }> };
    assert.ok(schema?.properties, `${name} must have an input schema`);
    assert.equal("compact" in (schema.properties ?? {}), false, `${name} must not expose compact`);
    const detail = schema.properties?.detail;
    assert.ok(detail, `${name} must expose detail`);
    assert.deepEqual(detail.enum, ["summary", "standard", "full"], `${name} detail enum`);
    assert.ok("include" in (schema.properties ?? {}), `${name} must expose include`);
  }
  // resolution/mapping + batch default summary; source/file default standard.
  const expectDefault: Record<string, string> = {
    "resolve-artifact": "summary",
    "find-mapping": "summary",
    "resolve-method-mapping-exact": "summary",
    "resolve-workspace-symbol": "summary",
    "check-symbol-exists": "summary",
    "batch-class-source": "summary",
    "batch-class-members": "summary",
    "batch-symbol-exists": "summary",
    "batch-mappings": "summary",
    "get-class-source": "standard",
    "get-class-members": "standard",
    "search-class-source": "standard",
    "list-artifact-files": "standard"
  };
  for (const [name, want] of Object.entries(expectDefault)) {
    const schema = toolMap.get(name) as { properties?: { detail?: { default?: string } } };
    assert.equal(schema.properties?.detail?.default, want, `${name} default detail`);
  }
});

// ---------------------------------------------------------------------------
// compact mode integration (P1)
// ---------------------------------------------------------------------------

test("find-mapping detail=summary does not corrupt identity-branch result and preserves meta.warnings", async () => {
  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const baseArgs = {
    version: "1.21.10",
    kind: "class",
    name: "dhl",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("find-mapping", { ...baseArgs, detail: "summary" }) as Promise<ToolResult>,
    callTool("find-mapping", { ...baseArgs, detail: "full" }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  // Compact must not add or corrupt any key
  for (const [key, value] of Object.entries(compactResult)) {
    assert.ok(key in normalResult, `compact added unexpected key: ${key}`);
    assert.deepEqual(value, normalResult[key], `compact corrupted key: ${key}`);
  }

  // Keys that compact is allowed to drop:
  // - empty/null/undefined values (P1 compactResponse)
  // - "candidates" when provably redundant (P4 compactMappingResponse)
  const ALLOWED_COMPACT_DROPS = new Set(["candidates", "candidatesTruncated"]);
  const droppedKeys: string[] = [];
  for (const key of Object.keys(normalResult)) {
    if (!(key in compactResult)) {
      droppedKeys.push(key);
      if (!ALLOWED_COMPACT_DROPS.has(key)) {
        const v = normalResult[key];
        const isEmpty =
          v === null ||
          v === undefined ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
        assert.ok(isEmpty, `compact dropped non-empty key: ${key} = ${JSON.stringify(v)}`);
      }
    }
  }

  // At least one key must have been dropped to prove compact is active
  assert.ok(droppedKeys.length > 0, `compact must drop at least one key, but none were dropped`);
  // candidates must be dropped (P4: identity branch resolved + exact + count=1)
  assert.ok(droppedKeys.includes("candidates"), "candidates should be dropped for resolved exact identity branch");

  // meta.warnings is omitted when empty; detail must not change what meta carries
  assert.deepEqual(
    withCompact.structuredContent?.meta?.warnings,
    withoutCompact.structuredContent?.meta?.warnings
  );
});

test("resolve-artifact compact:true omits diagnostic fields from local-jar result", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-artifact-"));
  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n"
  });

  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      detail: "summary"
    }) as Promise<ToolResult>,
    callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      detail: "full"
    }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  // Diagnostic fields must be omitted in compact mode
  const omitKeys = [
    "provenance", "artifactContents", "sampleEntries",
    "adjacentSourceCandidates", "binaryJarPath", "coordinate",
    "repoUrl", "resolvedSourceJarPath"
  ];
  for (const key of omitKeys) {
    assert.equal(key in compactResult, false, `${key} should be omitted in compact mode`);
  }

  // Essential fields must be preserved
  const keptKeys = ["artifactId", "origin", "isDecompiled", "mappingApplied", "qualityFlags"];
  for (const key of keptKeys) {
    assert.ok(key in compactResult, `${key} should be preserved`);
    assert.deepEqual(compactResult[key], normalResult[key], `${key} value should match`);
  }

  // Normal result must have at least some of the diagnostic fields
  assert.ok("artifactContents" in normalResult, "normal result should have artifactContents");

  // meta.warnings is omitted when empty; detail must not change what meta carries
  assert.deepEqual(
    withCompact.structuredContent?.meta?.warnings,
    withoutCompact.structuredContent?.meta?.warnings
  );
});

test("list-artifact-files compact:true drops artifactContents and preserves items", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-listfiles-"));
  const jarPath = join(root, "example-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n",
    "net/minecraft/Other.java": "package net.minecraft;\npublic class Other {}\n"
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath }
  }) as {
    isError?: boolean;
    structuredContent?: { result?: { artifactId?: string } };
  };
  assert.notEqual(resolveResult.isError, true);
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId);

  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("list-artifact-files", { artifactId, detail: "summary" }) as Promise<ToolResult>,
    callTool("list-artifact-files", { artifactId, detail: "full" }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  assert.equal("artifactContents" in compactResult, false, "artifactContents should be omitted in compact");
  assert.ok("artifactContents" in normalResult, "normal result should have artifactContents");
  assert.deepEqual(compactResult.items, normalResult.items, "items payload should match");
});

test("search-class-source compact:true preserves hits and drops empty arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-searchsrc-"));
  const jarPath = join(root, "example-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n"
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath }
  }) as {
    isError?: boolean;
    structuredContent?: { result?: { artifactId?: string } };
  };
  assert.notEqual(resolveResult.isError, true);
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId);

  type ToolResult = {
    isError?: boolean;
    structuredContent?: { result?: Record<string, unknown> };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("search-class-source", {
      artifactId,
      query: "Example",
      intent: "symbol",
      detail: "summary"
    }) as Promise<ToolResult>,
    callTool("search-class-source", {
      artifactId,
      query: "Example",
      intent: "symbol",
      detail: "full"
    }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  assert.equal("artifactContents" in compactResult, false);
  assert.ok("artifactContents" in normalResult);
  assert.deepEqual(compactResult.hits, normalResult.hits);
});

test("get-runtime-metrics ignores compact:true (passthrough schema + allowlist)", async () => {
  const withCompact = await callTool("get-runtime-metrics", {
    compact: true
  }) as {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
    };
  };

  const withoutCompact = await callTool("get-runtime-metrics", {}) as {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
    };
  };

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  // Both results should have the same keys — compact must NOT have stripped anything
  const keysWithCompact = Object.keys(withCompact.structuredContent?.result ?? {}).sort();
  const keysWithoutCompact = Object.keys(withoutCompact.structuredContent?.result ?? {}).sort();
  assert.deepEqual(keysWithCompact, keysWithoutCompact);
});
