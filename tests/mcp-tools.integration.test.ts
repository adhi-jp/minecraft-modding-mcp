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

test("source lookup tools/list schema clarifies object target inputs and loader scope fallback", async () => {
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
  assert.match(resolveArtifactSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.match(getClassSourceSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.match(getClassMembersSchema.properties?.scope?.description ?? "", /loader.*same as "merged"/i);
  assert.deepEqual(
    [...(validateMixinSchema.properties?.reportMode?.enum ?? [])].sort(),
    ["compact", "full", "summary-first"]
  );
  assert.match(validateMixinSchema.properties?.reportMode?.description ?? "", /summary-first/i);
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
  assert.equal(analyzeSymbolSchema.properties?.maxCandidates?.default, 200);
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
