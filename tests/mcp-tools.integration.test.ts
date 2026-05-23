import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "./helpers/zip.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-tools-integration-cache");

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
  "validate-access-transformer",
  "analyze-mod-jar",
  "get-registry-data",
  "compare-versions",
  "decompile-mod-jar",
  "get-mod-class-source",
  "search-mod-source",
  "remap-mod-jar",
  "verify-mixin-target",
  "batch-class-source",
  "batch-class-members",
  "batch-symbol-exists",
  "batch-mappings"
] as const;

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

test("manual stdio smoke validates restarted list-versions against the current releases contract", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /requireToolOk<ListVersionsOutput>\(\s*"list-versions-after-restart"/s);
  assert.match(source, /versionsAfterRestart\.releases/);
  assert.doesNotMatch(source, /versionsAfterRestart\.items/);
});

test("manual stdio smoke records cold and warm local resolve/search probes for a fresh artifact", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /resolve-artifact-probe-cold/);
  assert.match(source, /resolve-artifact-probe-warm/);
  assert.match(source, /search-class-source-probe-cold/);
  assert.match(source, /search-class-source-probe-warm/);
  assert.match(source, /Cold-start perf probes:/);
  assert.match(source, /function classifyColdStartProbes\(/);
  assert.match(source, /const coldStartClassification = classifyColdStartProbes\(/);
  assert.match(source, /classification:\s*coldStartClassification\.classification/);
});

test("manual stdio smoke bounds transport shutdown and force-kills a stuck supervisor", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /type ManagedTransport = Transport &/);
  assert.match(source, /async function closeTransportWithTimeout\(transport: ManagedTransport/);
  assert.match(source, /const pid = transport\.pid \?\? null;/);
  assert.match(source, /const closePromise = transport\.close\(\)\.catch\(\(\) => undefined\);/);
  assert.match(source, /await Promise\.race\(\[\s*closePromise\.then\(\(\) => false\),\s*wait\(timeoutMs\)\.then\(\(\) => true\)\s*\]\)/s);
  assert.match(source, /process\.kill\(pid,\s*"SIGTERM"\)/);
  assert.match(source, /process\.kill\(pid,\s*"SIGKILL"\)/);
});

test("manual stdio smoke falls back to the bash bridge when native child stdio pipes are unavailable", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /selectManualStdioMode\(await canUseStdioPipeReliably\(\)\)/);
  assert.match(source, /createDirectWorkerBridgeTransport\(/);
  assert.match(source, /Manual stdio smoke fallback active:/);
  assert.match(source, /worker restart validation is disabled in this mode/);
});

test("manual stdio smoke fully terminates the content-length probe child process", async () => {
  const source = await readFile("tests/manual/stdio-client-smoke.manual.ts", "utf8");

  assert.match(source, /async function terminateChildProcess\(child: ChildProcess/);
  assert.match(source, /child\.kill\("SIGTERM"\)/);
  assert.match(source, /child\.kill\("SIGKILL"\)/);
  assert.match(source, /child\.unref\(\)/);
  assert.match(source, /await terminateChildProcess\(child\);/);
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
    version: "1.21.10"
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
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
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

  assert.match(resolveArtifactSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
  assert.match(getClassSourceSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
  assert.match(getClassMembersSchema.properties?.target?.description ?? "", /Must be an object, not a string\./);
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
  assert.equal(validateMixinSchema.properties?.reportMode?.default, "full");
  assert.equal(validateMixinSchema.properties?.treatInfoAsWarning?.default, true);
  assert.equal(validateMixinSchema.properties?.includeIssues?.default, true);
  assert.equal(inspectMinecraftSchema.properties?.includeSnapshots?.default, false);
  assert.equal(inspectMinecraftSchema.properties?.limit?.default, undefined);
  assert.equal(analyzeSymbolSchema.properties?.nameMode?.default, "fqcn");
  assert.equal(analyzeSymbolSchema.properties?.signatureMode?.default, "exact");
  assert.equal(analyzeSymbolSchema.properties?.maxCandidates?.default, 5);
  assert.equal(analyzeSymbolSchema.properties?.sourceMapping?.default, undefined);
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
        suggestedCall?: {
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
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "search");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "search");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.kind, "version");
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
        suggestedCall?: {
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
        suggestedCall?: {
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
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "class-members");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "class");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.kind, "version");
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
      type: "resolve",
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
      type: "resolve",
      kind: "version",
      value: "1.21.10"
    },
    access: "all",
    memberPattern: "tick"
  });
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

  assert.equal(result.structuredContent?.meta?.detailApplied, "summary");
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
  // the owner+name descriptorless fallback. This guards against the F2 bug where exact
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
// compact mode integration (P1)
// ---------------------------------------------------------------------------

test("find-mapping compact:true does not corrupt identity-branch result and preserves meta.warnings", async () => {
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
    callTool("find-mapping", { ...baseArgs, compact: true }) as Promise<ToolResult>,
    callTool("find-mapping", { ...baseArgs, compact: false }) as Promise<ToolResult>
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

  // meta.warnings must survive — compact only applies to result, not meta
  assert.ok(Array.isArray(withCompact.structuredContent?.meta?.warnings));
  assert.ok(Array.isArray(withoutCompact.structuredContent?.meta?.warnings));
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
      compact: true
    }) as Promise<ToolResult>,
    callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      compact: false
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

  // meta.warnings must be present in both
  assert.ok(Array.isArray(withCompact.structuredContent?.meta?.warnings));
  assert.ok(Array.isArray(withoutCompact.structuredContent?.meta?.warnings));
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
    callTool("list-artifact-files", { artifactId, compact: true }) as Promise<ToolResult>,
    callTool("list-artifact-files", { artifactId, compact: false }) as Promise<ToolResult>
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
      compact: true
    }) as Promise<ToolResult>,
    callTool("search-class-source", {
      artifactId,
      query: "Example",
      intent: "symbol",
      compact: false
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

test("EXPECTED_TOOLS is locked at length 41 (bidirectional with tool registry)", async () => {
  // Literal magic-number fix: when this fires, update BOTH this assertion
  // and the EXPECTED_TOOLS array above to keep the public contract pinned.
  assert.equal(EXPECTED_TOOLS.length, 41);
});

test("EXPECTED_TOOLS matches the registered tool-schema-registry set (set equivalence)", async () => {
  await import("../src/index.ts");
  const { listRegisteredTools } = await import("../src/tool-schema-registry.ts");
  const registered = new Set(
    listRegisteredTools().filter((name) => !name.startsWith("__test-tool-"))
  );
  const expected = new Set(EXPECTED_TOOLS);
  // bidirectional equivalence
  for (const name of expected) {
    assert.ok(registered.has(name), `EXPECTED_TOOLS has ${name} but registry does not`);
  }
  for (const name of registered) {
    assert.ok(expected.has(name), `registry has ${name} but EXPECTED_TOOLS does not`);
  }
  assert.equal(registered.size, expected.size);
});

test("EXPECTED_TOOLS excludes every removed legacy tool name (negative-list)", () => {
  const expected = new Set<string>(EXPECTED_TOOLS);
  // Tool names only — mapping values (`official`) and parameter names
  // (`targetKind`, `snippetLines`) cannot appear here by construction and are
  // pinned by docs-contract tests instead.
  for (const removed of [
    "inspect-mc-class",
    "explore-mod",
    "mc-list-versions",
    "mc-resolve-artifact"
  ]) {
    assert.ok(!expected.has(removed), `EXPECTED_TOOLS must not contain removed name "${removed}"`);
  }
});
