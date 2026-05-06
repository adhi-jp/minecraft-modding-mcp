import { readFileSync } from "node:fs";
import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeStageEmitter, type StageEmitterExtra } from "./stage-emitter.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, z } from "zod";
import { CompatStdioServerTransport } from "./compat-stdio-transport.js";

import { objectResult } from "./mcp-helpers.js";
import { prepareToolInput } from "./tool-input.js";
import {
  isCompactEnabled,
  COMPACT_MAPPING_TOOL_NAMES,
  COMPACT_SOURCE_TOOL_NAMES,
  COMPACT_MEMBERS_TOOL_NAMES,
  COMPACT_LIGHT_TOOL_NAMES,
  TOOL_PRESERVE_PAYLOAD_KEYS,
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  compactSourceResponse,
  compactMembersResponse,
  compactLightResponse
} from "./response-utils.js";

import { loadConfig } from "./config.js";
import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { log } from "./logger.js";
import {
  applyNbtJsonPatch,
  nbtBase64ToTypedJson,
  typedJsonToNbtBase64,
  type DecodeCompression,
  type EncodeCompression
} from "./nbt/pipeline.js";
import { analyzeModJar } from "./mod-analyzer.js";
import { remapModJar } from "./mod-remap-service.js";
import { registerResources } from "./resources.js";
import { SourceService } from "./source-service.js";
import { ToolExecutionGate } from "./tool-execution-gate.js";
import type { ArtifactScope, MappingSourcePriority, SourceMapping, SourceTargetInput } from "./types.js";
import { WorkspaceMappingService } from "./workspace-mapping-service.js";
import {
  InspectMinecraftService,
  inspectMinecraftSchema,
  inspectMinecraftShape
} from "./entry-tools/inspect-minecraft-service.js";
import {
  AnalyzeSymbolService,
  analyzeSymbolSchema,
  analyzeSymbolShape
} from "./entry-tools/analyze-symbol-service.js";
import {
  CompareMinecraftService,
  compareMinecraftSchema,
  compareMinecraftShape
} from "./entry-tools/compare-minecraft-service.js";
import {
  AnalyzeModService,
  analyzeModSchema,
  analyzeModShape
} from "./entry-tools/analyze-mod-service.js";
import {
  ValidateProjectService,
  validateProjectSchema,
  validateProjectShape,
  discoverWorkspaceAccessTransformers,
  discoverWorkspaceAccessWideners,
  discoverWorkspaceMixins
} from "./entry-tools/validate-project-service.js";
import {
  ManageCacheService,
  manageCacheSchema,
  manageCacheShape
} from "./entry-tools/manage-cache-service.js";
import {
  VerifyMixinTargetService,
  VERIFY_MIXIN_TARGET_OFF
} from "./entry-tools/verify-mixin-target-service.js";
import { BATCH_TOOLS_OFF } from "./entry-tools/batch-runner.js";
import { BatchClassSourceService } from "./entry-tools/batch-class-source-service.js";
import { BatchClassMembersService } from "./entry-tools/batch-class-members-service.js";
import { BatchSymbolExistsService } from "./entry-tools/batch-symbol-exists-service.js";
import { BatchMappingsService } from "./entry-tools/batch-mappings-service.js";
import { createCacheRegistry } from "./cache-registry.js";
import { buildEntryToolMeta } from "./entry-tools/response-contract.js";
import { registerToolSchema } from "./tool-schema-registry.js";
import { buildSuggestedCall } from "./build-suggested-call.js";
import {
  applyErrorMetaExtensions,
  mapErrorToProblem,
  type ToolMeta as ToolGuidanceToolMeta
} from "./tool-guidance.js";
import {
  type SourceLookupTargetInput,
  type ResolveArtifactTargetInput,
  type WorkspaceSymbolKind,
  type SearchIntent,
  type SearchMatch,
  type SearchSymbolKind,
  nonEmptyString,
  optionalPositiveInt,
  analyzeModJarSchema,
  analyzeModJarShape,
  batchClassMembersSchema,
  batchClassMembersShape,
  batchClassSourceSchema,
  batchClassSourceShape,
  batchMappingsSchema,
  batchMappingsShape,
  batchSymbolExistsSchema,
  batchSymbolExistsShape,
  checkSymbolExistsSchema,
  checkSymbolExistsShape,
  compareVersionsSchema,
  compareVersionsShape,
  decompileModJarSchema,
  decompileModJarShape,
  diffClassSignaturesSchema,
  diffClassSignaturesShape,
  emptySchema,
  findMappingSchema,
  findMappingShape,
  getArtifactFileSchema,
  getArtifactFileShape,
  getClassApiMatrixSchema,
  getClassApiMatrixShape,
  getClassMembersSchema,
  getClassMembersShape,
  getClassSourceSchema,
  getClassSourceShape,
  getModClassSourceSchema,
  getModClassSourceShape,
  getRegistryDataSchema,
  getRegistryDataShape,
  indexArtifactSchema,
  indexArtifactShape,
  jsonToNbtSchema,
  jsonToNbtShape,
  listArtifactFilesSchema,
  listArtifactFilesShape,
  listVersionsSchema,
  listVersionsShape,
  nbtApplyJsonPatchSchema,
  nbtApplyJsonPatchShape,
  nbtToJsonSchema,
  nbtToJsonShape,
  remapModJarSchema,
  remapModJarShape,
  resolveArtifactSchema,
  resolveArtifactShape,
  resolveMethodMappingExactSchema,
  resolveMethodMappingExactShape,
  resolveWorkspaceSymbolSchema,
  resolveWorkspaceSymbolShape,
  searchClassSourceSchema,
  searchClassSourceShape,
  searchModSourceSchema,
  searchModSourceShape,
  traceSymbolLifecycleSchema,
  traceSymbolLifecycleShape,
  validateAccessTransformerSchema,
  validateAccessTransformerShape,
  validateAccessWidenerSchema,
  validateAccessWidenerShape,
  validateMixinSchema,
  validateMixinShape,
  verifyMixinTargetSchema,
  verifyMixinTargetShape
} from "./tool-schemas.js";

type ToolMeta = ToolGuidanceToolMeta;

export { mapErrorToProblem, applyErrorMetaExtensions };

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const HEAVY_TOOL_NAMES = new Set([
  "trace-symbol-lifecycle",
  "diff-class-signatures",
  "compare-versions",
  "find-mapping",
  "resolve-method-mapping-exact",
  "get-class-api-matrix",
  "get-registry-data"
]);
const ENTRY_TOOL_NAMES = new Set([
  "inspect-minecraft",
  "analyze-symbol",
  "compare-minecraft",
  "analyze-mod",
  "validate-project",
  "manage-cache"
]);
const heavyToolExecutionGate = new ToolExecutionGate({ maxConcurrent: 1, maxQueue: 2 });


function getServerVersionFromPackageJson(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // ignore and fallback
  }
  return "0.3.0";
}

const SERVER_VERSION = getServerVersionFromPackageJson();

const server = new McpServer({
  name: "@adhisang/minecraft-modding-mcp",
  version: SERVER_VERSION
});

// The SDK validates tool args before invoking handlers and returns generic InvalidParams text.
// Bypass that layer so runTool() remains the single source of truth for validation and error envelopes.
(
  server as unknown as {
    validateToolInput: (_tool: unknown, args: unknown, _toolName: string) => Promise<unknown>;
  }
).validateToolInput = async (_tool: unknown, args: unknown) => args;

const config = loadConfig();
const nbtLimits = {
  maxInputBytes: config.maxNbtInputBytes,
  maxInflatedBytes: config.maxNbtInflatedBytes,
  maxResponseBytes: config.maxNbtResponseBytes
};

let sourceServiceInstance: SourceService | undefined;

function getSourceService(): SourceService {
  sourceServiceInstance ??= new SourceService(config);
  return sourceServiceInstance;
}

const sourceService = new Proxy({} as SourceService, {
  get(_target, property, _receiver) {
    const service = getSourceService();
    const value = Reflect.get(service, property, service);
    return typeof value === "function" ? value.bind(service) : value;
  }
});
const workspaceMappingService = new WorkspaceMappingService();
const inspectMinecraftService = new InspectMinecraftService({
  listVersions: (input) => sourceService.listVersions(input),
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  findClass: (input) => Promise.resolve(sourceService.findClass(input)),
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input),
  getClassSource: (input) => sourceService.getClassSource(input),
  getClassMembers: (input) => sourceService.getClassMembers(input),
  searchClassSource: (input) => sourceService.searchClassSource(input),
  getArtifactFile: (input) => sourceService.getArtifactFile(input),
  listArtifactFiles: (input) => sourceService.listArtifactFiles(input),
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath)
});
const analyzeSymbolService = new AnalyzeSymbolService({
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input),
  findMapping: (input) => sourceService.findMapping(input),
  resolveMethodMappingExact: (input) => sourceService.resolveMethodMappingExact(input),
  traceSymbolLifecycle: (input) => sourceService.traceSymbolLifecycle(input),
  resolveWorkspaceSymbol: (input) => sourceService.resolveWorkspaceSymbol(input),
  getClassApiMatrix: (input) => sourceService.getClassApiMatrix(input)
});
const compareMinecraftService = new CompareMinecraftService({
  compareVersions: (input) => sourceService.compareVersions(input),
  diffClassSignatures: (input) => sourceService.diffClassSignatures(input),
  getRegistryData: (input) => sourceService.getRegistryData(input)
});
const analyzeModService = new AnalyzeModService({
  analyzeModJar: (jarPath, options) => analyzeModJar(jarPath, options),
  decompileModJar: (input) => sourceService.decompileModJar(input),
  getModClassSource: (input) => sourceService.getModClassSource(input),
  searchModSource: (input) => sourceService.searchModSource(input),
  remapModJar: (input) => remapModJar(input, config) as unknown as Promise<Record<string, unknown> & { warnings?: string[] }>
});
const validateProjectService = new ValidateProjectService({
  validateMixin: (input) => sourceService.validateMixin(input as any) as Promise<Record<string, unknown> & { warnings?: string[] }>,
  validateAccessWidener: (input) => sourceService.validateAccessWidener(input),
  validateAccessTransformer: (input) => sourceService.validateAccessTransformer(input),
  discoverMixins: discoverWorkspaceMixins,
  discoverAccessWideners: discoverWorkspaceAccessWideners,
  discoverAccessTransformers: discoverWorkspaceAccessTransformers,
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath),
  resolveArtifact: async (input) => {
    const output = await sourceService.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      warnings: output.warnings
    };
  }
});
const manageCacheService = new ManageCacheService({
  registry: createCacheRegistry({
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath
  })
});
const verifyMixinTargetService = new VerifyMixinTargetService({
  resolveArtifact: async (input) => {
    const output = await sourceService.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      binaryJarPath: output.binaryJarPath,
      provenance: output.provenance,
      warnings: output.warnings
    };
  },
  getSignature: (input) =>
    (sourceService as unknown as {
      explorerService: {
        getSignature: (input: Record<string, unknown>) => Promise<{
          classAccessFlags?: number;
          constructors: Array<Record<string, unknown>>;
          methods: Array<Record<string, unknown>>;
          fields: Array<Record<string, unknown>>;
          warnings: string[];
        }>;
      };
    }).explorerService.getSignature(input) as Promise<{
      classAccessFlags?: number;
      constructors: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      methods: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      fields: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      warnings: string[];
    }>
});

const batchClassSourceService = new BatchClassSourceService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  getClassSource: (input) => sourceService.getClassSource(input)
});
const batchClassMembersService = new BatchClassMembersService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  getClassMembers: (input) => sourceService.getClassMembers(input)
});
const batchSymbolExistsService = new BatchSymbolExistsService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input)
});
const batchMappingsService = new BatchMappingsService({
  findMapping: (input) => sourceService.findMapping(input)
});

registerResources(server, sourceService);

let processHandlersAttached = false;
let serverStarted = false;

function attachProcessErrorHandlers(): void {
  if (processHandlersAttached) {
    return;
  }
  processHandlersAttached = true;

  process.on("uncaughtException", (caughtError) => {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
    log("error", "process.uncaught_exception", {
      message: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    log("error", "process.unhandled_rejection", {
      message: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  });
}

function buildRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSourceLookupTarget(
  target: SourceLookupTargetInput
): {
  artifactId?: string;
  target?: ResolveArtifactTargetInput;
} {
  if (target.type === "artifact") {
    return { artifactId: target.artifactId };
  }
  const { type: _type, ...rest } = target;
  return { target: rest as ResolveArtifactTargetInput };
}

function parseClassApiKinds(value: string | undefined): WorkspaceSymbolKind[] | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(
      (entry): entry is WorkspaceSymbolKind =>
        entry === "class" || entry === "field" || entry === "method"
    );

  if (normalized.length === 0) {
    return undefined;
  }

  return [...new Set(normalized)];
}

/* Helpers moved to src/tool-guidance.ts: toFieldErrorsFromZod, toHints,
 * VALIDATION_FALLBACK_HINT, extractValidatedSuggestionAndExamples,
 * extractFailedStageFromDetails, extractFieldErrorsFromDetails,
 * asObjectRecord, asNonEmptyString, asStringArray, truncateSuggestionText,
 * parseJsonObjectString, inferTargetKindFromString, copySourceLookupSuggestionFields,
 * copyValidateMixinSharedParams, buildValidateMixinSuggestedParams,
 * buildResolveArtifactSuggestedParams, buildSourceLookupSuggestedParams,
 * filterAllowedIncludeValues, buildAnalyzeModSuggestedParams,
 * buildValidateProjectSuggestedParams, gatedGuidance,
 * buildInvalidInputGuidance, mapErrorToProblem, applyErrorMetaExtensions */

function splitWarnings(data: Record<string, unknown>): {
  result: Record<string, unknown>;
  warnings: string[];
  meta: Record<string, unknown>;
} {
  const result = { ...data };
  const warnings: string[] = [];
  const maybeWarnings = result.warnings;
  if (Array.isArray(maybeWarnings)) {
    warnings.push(...maybeWarnings.filter((entry): entry is string => typeof entry === "string"));
    delete result.warnings;
  }

  let meta: Record<string, unknown> = {};
  const maybeMeta = result.meta;
  if (maybeMeta && typeof maybeMeta === "object" && !Array.isArray(maybeMeta)) {
    meta = { ...(maybeMeta as Record<string, unknown>) };
    delete result.meta;
    const metaWarnings = meta.warnings;
    if (Array.isArray(metaWarnings)) {
      warnings.push(...metaWarnings.filter((entry): entry is string => typeof entry === "string"));
      delete meta.warnings;
    }
  }

  return {
    result,
    warnings: [...new Set(warnings)],
    meta
  };
}

async function runTool<TInput, TResult extends Record<string, unknown>>(
  tool: string,
  rawInput: unknown,
  schema: z.ZodType<TInput>,
  action: (input: TInput) => Promise<TResult>
): Promise<CallToolResult> {
  const requestId = buildRequestId();
  const startedAt = Date.now();
  let normalizedInput: unknown = rawInput;

  try {
    const preparedInput = prepareToolInput(rawInput);
    normalizedInput = preparedInput.normalizedInput;
    const { removedOfficialPaths, suggestedReplacementInput } = preparedInput;
    if (removedOfficialPaths.length > 0) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `The "official" mapping namespace was removed. Use "obfuscated" instead.`,
        details: {
          fieldErrors: removedOfficialPaths.map((path) => ({
            path,
            message: `"official" is no longer supported for this field. Use "obfuscated".`,
            code: "invalid_enum_value"
          })),
          nextAction: `Replace "official" with "obfuscated" in mapping-related fields and retry.`,
          ...(suggestedReplacementInput
            ? buildSuggestedCall({
                tool,
                params: suggestedReplacementInput as Record<string, unknown>
              })
            : {})
        }
      });
    }

    const parsedInput = schema.parse(normalizedInput);
    const payload = await (
      HEAVY_TOOL_NAMES.has(tool)
        ? heavyToolExecutionGate.run(tool, () => action(parsedInput))
        : action(parsedInput)
    );
    const { result, warnings, meta: resultMeta } = splitWarnings(payload);

    const isCompact = isCompactEnabled(tool, parsedInput);
    let projectedResult = result;
    if (isCompact) {
      if (tool === "resolve-artifact") {
        projectedResult = compactArtifactResponse(projectedResult);
      }
      if (COMPACT_MAPPING_TOOL_NAMES.has(tool)) {
        projectedResult = compactMappingResponse(projectedResult);
      }
      if (COMPACT_SOURCE_TOOL_NAMES.has(tool)) {
        projectedResult = compactSourceResponse(projectedResult);
      }
      if (COMPACT_MEMBERS_TOOL_NAMES.has(tool)) {
        projectedResult = compactMembersResponse(projectedResult);
      }
      if (COMPACT_LIGHT_TOOL_NAMES.has(tool)) {
        projectedResult = compactLightResponse(projectedResult);
      }
      projectedResult = compactResponse(
        projectedResult,
        TOOL_PRESERVE_PAYLOAD_KEYS[tool]
      );
    }

    const entryMeta = ENTRY_TOOL_NAMES.has(tool)
      ? buildEntryToolMeta({
          detail:
            normalizedInput &&
            typeof normalizedInput === "object" &&
            !Array.isArray(normalizedInput) &&
            typeof (normalizedInput as { detail?: unknown }).detail === "string"
              ? (normalizedInput as { detail?: "summary" | "standard" | "full" }).detail ?? "summary"
              : "summary",
          include:
            normalizedInput &&
            typeof normalizedInput === "object" &&
            !Array.isArray(normalizedInput) &&
            Array.isArray((normalizedInput as { include?: unknown }).include)
              ? (normalizedInput as { include?: string[] }).include
              : undefined
        })
      : undefined;

    const durationMs = Date.now() - startedAt;
    sourceService.recordToolCall(tool, durationMs);
    return objectResult({
      result: projectedResult,
      meta: {
        ...(entryMeta ?? {}),
        ...resultMeta,
        requestId,
        tool,
        durationMs,
        warnings
      } satisfies ToolMeta
    });
  } catch (caughtError) {
    const problem = mapErrorToProblem(caughtError, requestId, {
      tool,
      normalizedInput
    });

    if (isAppError(caughtError)) {
      const isSevere =
        caughtError.code === ERROR_CODES.DB_FAILURE ||
        caughtError.code === ERROR_CODES.REPO_FETCH_FAILED ||
        caughtError.code === ERROR_CODES.REGISTRY_GENERATION_FAILED ||
        caughtError.code === ERROR_CODES.JAVA_UNAVAILABLE ||
        caughtError.code.startsWith("ERR_DECOMPILER");
      if (isSevere) {
        log("error", "tool.call.failed", {
          requestId,
          tool,
          code: caughtError.code,
          message: caughtError.message
        });
      } else {
        log("warn", "tool.call.warning", {
          requestId,
          tool,
          code: caughtError.code,
          message: caughtError.message
        });
      }
    } else if (!(caughtError instanceof ZodError)) {
      log("error", "tool.call.unhandled", {
        requestId,
        tool,
        reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
    }

    const errorDurationMs = Date.now() - startedAt;
    sourceService.recordToolCall(tool, errorDurationMs);
    const errorMeta: ToolMeta = {
      requestId,
      tool,
      durationMs: errorDurationMs,
      warnings: []
    };
    applyErrorMetaExtensions(errorMeta, caughtError);
    return objectResult({
      error: problem,
      meta: errorMeta
    }, { isError: true });
  }
}

server.tool("list-versions",
  "List available Minecraft versions from Mojang manifest and locally cached version jars.",
  listVersionsShape,
  { readOnlyHint: true },
  async (args) => runTool("list-versions", args, listVersionsSchema, async (input) =>
    sourceService.listVersions({
      includeSnapshots: input.includeSnapshots,
      limit: input.limit
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-versions", listVersionsSchema);

server.tool("inspect-minecraft",
  "High-level v3 entry tool for version discovery, artifact resolution, class inspection, source search, file reads, and file listings.",
  inspectMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("inspect-minecraft", args, inspectMinecraftSchema, async (input) =>
    inspectMinecraftService.execute(input as z.infer<typeof inspectMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("inspect-minecraft", inspectMinecraftSchema);

server.tool("analyze-symbol",
  "High-level v3 entry tool for symbol existence, mapping, lifecycle, workspace analysis, and API overview.",
  analyzeSymbolShape,
  { readOnlyHint: true },
  async (args) => runTool("analyze-symbol", args, analyzeSymbolSchema, async (input) =>
    analyzeSymbolService.execute(input as z.infer<typeof analyzeSymbolSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-symbol", analyzeSymbolSchema);

server.tool("compare-minecraft",
  "High-level v3 entry tool for version comparisons, class diffs, registry diffs, and migration overviews.",
  compareMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("compare-minecraft", args, compareMinecraftSchema, async (input) =>
    compareMinecraftService.execute(input as z.infer<typeof compareMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-minecraft", compareMinecraftSchema);

server.tool("analyze-mod",
  "High-level v3 entry tool for mod metadata inspection, decompile/search flows, class source, and safe remap previews/applies.",
  analyzeModShape,
  { readOnlyHint: false },
  async (args) => runTool("analyze-mod", args, analyzeModSchema, async (input) =>
    analyzeModService.execute(input as z.infer<typeof analyzeModSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-mod", analyzeModSchema);

server.tool("validate-project",
  "High-level v3 entry tool for project summary, direct mixin validation, and access widener/access transformer validation.",
  validateProjectShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-project", args, validateProjectSchema, async (input) =>
    validateProjectService.execute(input as z.infer<typeof validateProjectSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-project", validateProjectSchema);

server.tool("manage-cache",
  "High-level v3 entry tool for cache summaries, listing, verification, previewed mutation, and explicit apply operations.",
  manageCacheShape,
  { readOnlyHint: false },
  async (args) => runTool("manage-cache", args, manageCacheSchema, async (input) =>
    manageCacheService.execute(input as z.infer<typeof manageCacheSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("manage-cache", manageCacheSchema);

if (!VERIFY_MIXIN_TARGET_OFF) {
  server.tool("verify-mixin-target",
    "Single-call probe: does this target owner / member exist and which @Shadow / @Accessor / @Invoker should the mixin use? Reuses target.kind workspace/version/coordinate/dependency/jar.",
    verifyMixinTargetShape,
    { readOnlyHint: true },
    async (args) => runTool("verify-mixin-target", args, verifyMixinTargetSchema, async (input) =>
      verifyMixinTargetService.execute({
        owner: input.owner,
        member: input.member,
        mixinMemberName: input.mixinMemberName,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        projectPath: input.projectPath,
        target: input.target as ResolveArtifactTargetInput,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion,
        strictVersion: input.strictVersion
      }) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("verify-mixin-target", verifyMixinTargetSchema);
}

if (!BATCH_TOOLS_OFF) {
  server.tool("batch-class-source",
    "Batch lookup: read source for many classes in one call, sharing a single resolved artifact. Returns per-entry { status, result?, error? } plus aggregate summary. Per-entry retry suggestions point at get-class-source.",
    batchClassSourceShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-class-source", args, batchClassSourceSchema, async (input) =>
      batchClassSourceService.execute(input as z.infer<typeof batchClassSourceSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-source", batchClassSourceSchema);

  server.tool("batch-class-members",
    "Batch lookup: list members for many classes in one call, sharing a single resolved artifact. Returns per-entry { status, result?, error? } plus aggregate summary. Per-entry retry suggestions point at get-class-members.",
    batchClassMembersShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-class-members", args, batchClassMembersSchema, async (input) =>
      batchClassMembersService.execute(input as z.infer<typeof batchClassMembersSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-members", batchClassMembersSchema);

  server.tool("batch-symbol-exists",
    "Batch existence/mapping query: probe many symbols in one call against a shared Minecraft-version artifact. Accepts target.kind=workspace or version only (other kinds carry library versions, not Minecraft versions). Per-entry retry suggestions point at check-symbol-exists.",
    batchSymbolExistsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-symbol-exists", args, batchSymbolExistsSchema, async (input) =>
      batchSymbolExistsService.execute(input as z.infer<typeof batchSymbolExistsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-symbol-exists", batchSymbolExistsSchema);

  server.tool("batch-mappings",
    "Batch mapping translation: resolve many symbols across mapping namespaces with one shared Minecraft version. Per-entry retry suggestions point at find-mapping.",
    batchMappingsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-mappings", args, batchMappingsSchema, async (input) =>
      batchMappingsService.execute(input as z.infer<typeof batchMappingsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-mappings", batchMappingsSchema);
}

server.tool("resolve-artifact",
  "Resolve source artifact from a target object ({ kind, value }) and return artifact metadata. For target.kind=jar, only <basename>-sources.jar is auto-adopted; other adjacent *-sources.jar files are informational.",
  resolveArtifactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-artifact", args, resolveArtifactSchema, async (input) =>
    sourceService.resolveArtifact({
      target: input.target as ResolveArtifactTargetInput,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      compact: input.compact
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-artifact", resolveArtifactSchema);

const findClassShape = {
  className: nonEmptyString.describe("Simple name (e.g. Blocks) or fully-qualified name (e.g. net.minecraft.world.level.block.Blocks)"),
  artifactId: nonEmptyString,
  limit: optionalPositiveInt.describe("default 20, max 200")
};
const findClassSchema = z.object(findClassShape);

server.tool("find-class",
  "Resolve a simple or qualified class name to fully-qualified class names within an artifact. Use this before get-class-source when you only have a simple name.",
  findClassShape,
  { readOnlyHint: true },
  async (args) => runTool("find-class", args, findClassSchema, async (input) =>
    sourceService.findClass({
      className: input.className,
      artifactId: input.artifactId,
      limit: input.limit
    }) as unknown as Record<string, unknown>
  )
);
registerToolSchema("find-class", findClassSchema);

server.tool("get-class-source",
  "Get Java source for a class by target ({ type: 'artifact', artifactId } or { type: 'resolve', kind, value }). Default mode=metadata returns symbol outline only; use mode=snippet for bounded excerpts or mode=full for entire source.",
  getClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-source", args, getClassSourceSchema, async (input) => {
    const normalizedTarget = normalizeSourceLookupTarget(input.target as SourceLookupTargetInput);
    return (
    sourceService.getClassSource({
      className: input.className,
      mode: input.mode,
      artifactId: normalizedTarget.artifactId,
      target: normalizedTarget.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      startLine: input.startLine,
      endLine: input.endLine,
      maxLines: input.maxLines,
      maxChars: input.maxChars,
      outputFile: input.outputFile
    }) as Promise<Record<string, unknown>>
    );
  })
);
registerToolSchema("get-class-source", getClassSourceSchema);

server.tool("get-class-members",
  "Get fields/methods/constructors for one class from binary bytecode by target ({ type: 'artifact', artifactId } or { type: 'resolve', kind, value }).",
  getClassMembersShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-members", args, getClassMembersSchema, async (input) => {
    const normalizedTarget = normalizeSourceLookupTarget(input.target as SourceLookupTargetInput);
    return (
    sourceService.getClassMembers({
      className: input.className,
      artifactId: normalizedTarget.artifactId,
      target: normalizedTarget.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      access: input.access,
      includeSynthetic: input.includeSynthetic,
      includeInherited: input.includeInherited,
      memberPattern: input.memberPattern,
      maxMembers: input.maxMembers,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    }) as Promise<Record<string, unknown>>
    );
  })
);
registerToolSchema("get-class-members", getClassMembersSchema);

server.tool("search-class-source",
  "Search indexed class source files for one artifact with symbol/text/path intent and compact hit output.",
  searchClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("search-class-source", args, searchClassSourceSchema, async (input) => {
      const scope =
        input.packagePrefix || input.fileGlob || input.symbolKind
          ? {
              packagePrefix: input.packagePrefix,
              fileGlob: input.fileGlob,
              symbolKind: input.symbolKind
            }
          : undefined;

      return sourceService.searchClassSource({
        artifactId: input.artifactId,
        query: input.query,
        intent: input.intent as SearchIntent | undefined,
        match: input.match as SearchMatch | undefined,
        scope: scope as
          | {
              packagePrefix?: string;
              fileGlob?: string;
              symbolKind?: SearchSymbolKind;
            }
          | undefined,
        queryMode: input.queryMode,
        limit: input.limit,
        cursor: input.cursor,
        queryNamespace: input.queryNamespace,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>;
    })
);
registerToolSchema("search-class-source", searchClassSourceSchema);

server.tool("get-artifact-file",
  "Get full source file content by artifactId and file path.",
  getArtifactFileShape,
  { readOnlyHint: true },
  async (args) => runTool("get-artifact-file", args, getArtifactFileSchema, async (input) =>
    sourceService.getArtifactFile({
      artifactId: input.artifactId,
      filePath: input.filePath,
      maxBytes: input.maxBytes
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-artifact-file", getArtifactFileSchema);

server.tool("list-artifact-files",
  "List source file paths in an artifact with optional prefix filter and cursor-based pagination.",
  listArtifactFilesShape,
  { readOnlyHint: true },
  async (args) => runTool("list-artifact-files", args, listArtifactFilesSchema, async (input) =>
    sourceService.listArtifactFiles({
      artifactId: input.artifactId,
      prefix: input.prefix,
      limit: input.limit,
      cursor: input.cursor
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-artifact-files", listArtifactFilesSchema);

server.tool("trace-symbol-lifecycle",
  "Trace which Minecraft versions contain a specific class method and report first/last seen versions.",
  traceSymbolLifecycleShape,
  { readOnlyHint: true },
  async (args) => runTool("trace-symbol-lifecycle", args, traceSymbolLifecycleSchema, async (input) =>
    sourceService.traceSymbolLifecycle({
      symbol: input.symbol,
      descriptor: input.descriptor,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      includeSnapshots: input.includeSnapshots,
      maxVersions: input.maxVersions,
      includeTimeline: input.includeTimeline
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("trace-symbol-lifecycle", traceSymbolLifecycleSchema);

server.tool("diff-class-signatures",
  "Compare one class signature between two Minecraft versions and report added/removed/modified constructors, methods, and fields.",
  diffClassSignaturesShape,
  { readOnlyHint: true },
  async (args) => runTool("diff-class-signatures", args, diffClassSignaturesSchema, async (input) =>
    sourceService.diffClassSignatures({
      className: input.className,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      includeFullDiff: input.includeFullDiff
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("diff-class-signatures", diffClassSignaturesSchema);

server.tool("find-mapping",
  "Find symbol mapping candidates between namespaces using structured symbol inputs for a specific Minecraft version.",
  findMappingShape,
  { readOnlyHint: true },
  async (args) => runTool("find-mapping", args, findMappingSchema, async (input) =>
    sourceService.findMapping({
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      signatureMode: input.signatureMode,
      disambiguation: input.disambiguation,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("find-mapping", findMappingSchema);

server.tool("resolve-method-mapping-exact",
  "Resolve one method mapping exactly by owner+name+descriptor between namespaces and report resolved/not_found/ambiguous.",
  resolveMethodMappingExactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-method-mapping-exact", args, resolveMethodMappingExactSchema, async (input) =>
    sourceService.resolveMethodMappingExact({
      version: input.version,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-method-mapping-exact", resolveMethodMappingExactSchema);

server.tool("get-class-api-matrix",
  "List class/member API rows across obfuscated/mojang/intermediary/yarn mappings for one class and Minecraft version.",
  getClassApiMatrixShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-api-matrix", args, getClassApiMatrixSchema, async (input) =>
    sourceService.getClassApiMatrix({
      version: input.version,
      className: input.className,
      classNameMapping: input.classNameMapping,
      includeKinds: parseClassApiKinds(input.includeKinds),
      sourcePriority: input.sourcePriority,
      maxRows: input.maxRows
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-class-api-matrix", getClassApiMatrixSchema);

server.tool("resolve-workspace-symbol",
  "Resolve class/field/method names as seen at compile time for a workspace by reading Gradle Loom mapping settings.",
  resolveWorkspaceSymbolShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-workspace-symbol", args, resolveWorkspaceSymbolSchema, async (input) =>
    sourceService.resolveWorkspaceSymbol({
      projectPath: input.projectPath,
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      sourcePriority: input.sourcePriority,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-workspace-symbol", resolveWorkspaceSymbolSchema);

server.tool("check-symbol-exists",
  "Check whether a class/field/method symbol exists in a specific mapping namespace for one Minecraft version.",
  checkSymbolExistsShape,
  { readOnlyHint: true },
  async (args) => runTool("check-symbol-exists", args, checkSymbolExistsSchema, async (input) =>
    sourceService.checkSymbolExists({
      version: input.version,
      kind: input.kind,
      owner: input.owner,
      name: input.name,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      sourcePriority: input.sourcePriority,
      nameMode: input.nameMode,
      signatureMode: input.signatureMode,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("check-symbol-exists", checkSymbolExistsSchema);

server.tool("nbt-to-json",
  "Decode Java Edition NBT binary payload (base64) into typed JSON.",
  nbtToJsonShape,
  { readOnlyHint: true },
  async (args) => runTool("nbt-to-json", args, nbtToJsonSchema, async (input) =>
    Promise.resolve(
      nbtBase64ToTypedJson({
        nbtBase64: input.nbtBase64,
        compression: input.compression as DecodeCompression | undefined
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("nbt-to-json", nbtToJsonSchema);

server.tool("nbt-apply-json-patch",
  "Apply RFC6902 add/remove/replace/test operations to typed NBT JSON.",
  nbtApplyJsonPatchShape,
  { readOnlyHint: true },
  async (args) => runTool("nbt-apply-json-patch", args, nbtApplyJsonPatchSchema, async (input) =>
    Promise.resolve(
      applyNbtJsonPatch({
        typedJson: input.typedJson,
        patch: input.patch
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("nbt-apply-json-patch", nbtApplyJsonPatchSchema);

server.tool("json-to-nbt",
  "Encode typed NBT JSON to Java Edition NBT binary payload (base64).",
  jsonToNbtShape,
  { readOnlyHint: true },
  async (args) => runTool("json-to-nbt", args, jsonToNbtSchema, async (input) =>
    Promise.resolve(
      typedJsonToNbtBase64({
        typedJson: input.typedJson,
        compression: input.compression as EncodeCompression | undefined
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("json-to-nbt", jsonToNbtSchema);

server.tool("index-artifact",
  "Rebuild indexed files/symbols metadata for an existing artifactId. Does not resolve new artifacts.",
  indexArtifactShape,
  async (args) => runTool("index-artifact", args, indexArtifactSchema, async (input) =>
    sourceService.indexArtifact({
      artifactId: input.artifactId,
      force: input.force
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("index-artifact", indexArtifactSchema);

server.tool("get-runtime-metrics",
  "Get runtime service counters and latency snapshots for cache/search/index diagnostics.",
  { readOnlyHint: true },
  async (args) => runTool("get-runtime-metrics", args, emptySchema, async () =>
    Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
  )
);
registerToolSchema("get-runtime-metrics", emptySchema);

server.tool("validate-mixin",
  "Validate Mixin source against Minecraft bytecode signatures for a given version.",
  validateMixinShape,
  { readOnlyHint: true },
  async (args, extra) => runTool("validate-mixin", args, validateMixinSchema, async (input) =>
    sourceService.validateMixin({
      input: input.input,
      sourceRoots: input.sourceRoots,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope as ArtifactScope | undefined,
      projectPath: input.projectPath,
      preferProjectVersion: input.preferProjectVersion,
      minSeverity: input.minSeverity,
      hideUncertain: input.hideUncertain,
      explain: input.explain,
      warningMode: input.warningMode,
      preferProjectMapping: input.preferProjectMapping,
      reportMode: input.reportMode,
      warningCategoryFilter: input.warningCategoryFilter,
      treatInfoAsWarning: input.treatInfoAsWarning,
      includeIssues: input.includeIssues
    }, {
      stageEmitter: makeStageEmitter(extra as unknown as StageEmitterExtra)
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-mixin", validateMixinSchema);

server.tool("validate-access-widener",
  "Validate Access Widener file entries against Minecraft bytecode signatures for a given version.",
  validateAccessWidenerShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-access-widener", args, validateAccessWidenerSchema, async (input) =>
    sourceService.validateAccessWidener({
      content: input.content,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-widener", validateAccessWidenerSchema);

server.tool("validate-access-transformer",
  "Validate Access Transformer file entries against Minecraft bytecode signatures for a given version.",
  validateAccessTransformerShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-access-transformer", args, validateAccessTransformerSchema, async (input) =>
    sourceService.validateAccessTransformer({
      content: input.content,
      version: input.version,
      atNamespace: input.atNamespace,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-transformer", validateAccessTransformerSchema);

server.tool("analyze-mod-jar",
  "Analyze a Minecraft mod JAR to extract loader type, metadata, entrypoints, mixins, and dependencies.",
  analyzeModJarShape,
  { readOnlyHint: true },
  async (args) => runTool("analyze-mod-jar", args, analyzeModJarSchema, async (input) => {
    const result = await analyzeModJar(input.jarPath, {
      includeClasses: input.includeClasses ?? false
    });
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("analyze-mod-jar", analyzeModJarSchema);

server.tool("get-registry-data",
  "Get Minecraft registry data (blocks, items, biomes, etc.) for a specific version by running the server data generator.",
  getRegistryDataShape,
  { readOnlyHint: true },
  async (args) => runTool("get-registry-data", args, getRegistryDataSchema, async (input) =>
    sourceService.getRegistryData({
      version: input.version,
      registry: input.registry,
      includeData: input.includeData,
      maxEntriesPerRegistry: input.maxEntriesPerRegistry
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-registry-data", getRegistryDataSchema);

server.tool("compare-versions",
  "Compare two Minecraft versions to find added/removed classes and registry entry changes. Useful for understanding what changed between versions during mod migration.",
  compareVersionsShape,
  { readOnlyHint: true },
  async (args) => runTool("compare-versions", args, compareVersionsSchema, async (input) =>
    sourceService.compareVersions({
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      category: input.category,
      packageFilter: input.packageFilter,
      maxClassResults: input.maxClassResults
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-versions", compareVersionsSchema);

server.tool("decompile-mod-jar",
  "Decompile a Minecraft mod JAR using Vineflower and list available classes, or view a specific class source. Builds on analyze-mod-jar by exposing the actual source code.",
  decompileModJarShape,
  { readOnlyHint: true },
  async (args) => runTool("decompile-mod-jar", args, decompileModJarSchema, async (input) =>
    sourceService.decompileModJar({
      jarPath: input.jarPath,
      className: input.className,
      includeFiles: input.includeFiles,
      maxFiles: input.maxFiles
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("decompile-mod-jar", decompileModJarSchema);

server.tool("get-mod-class-source",
  "Get decompiled source code for a specific class in a mod JAR. The mod JAR will be decompiled if not already cached.",
  getModClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-mod-class-source", args, getModClassSourceSchema, async (input) =>
    sourceService.getModClassSource({
      jarPath: input.jarPath,
      className: input.className,
      maxLines: input.maxLines,
      maxChars: input.maxChars,
      outputFile: input.outputFile
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-mod-class-source", getModClassSourceSchema);

server.tool("search-mod-source",
  "Search through decompiled mod JAR source code by class name, method, field, or content pattern. The mod JAR will be decompiled automatically if not already cached.",
  searchModSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("search-mod-source", args, searchModSourceSchema, async (input) =>
    sourceService.searchModSource({
      jarPath: input.jarPath,
      query: input.query,
      searchType: input.searchType,
      limit: input.limit
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("search-mod-source", searchModSourceSchema);

server.tool("remap-mod-jar",
  "Remap a Fabric mod JAR from intermediary to yarn/mojang names. Requires Java to be installed.",
  remapModJarShape,
  { readOnlyHint: false },
  async (args) => runTool("remap-mod-jar", args, remapModJarSchema, async (input) => {
    const result = await remapModJar(
      {
        inputJar: input.inputJar,
        outputJar: input.outputJar,
        mcVersion: input.mcVersion,
        targetMapping: input.targetMapping
      },
      config
    );
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("remap-mod-jar", remapModJarSchema);

export async function startServer(): Promise<void> {
  if (serverStarted) {
    return;
  }
  attachProcessErrorHandlers();
  log("info", "server.start", {
    version: SERVER_VERSION,
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath,
    sourceRepos: config.sourceRepos.length
  });
  const transport = new CompatStdioServerTransport();
  await server.connect(transport);
  // In stdio mode, explicitly resume stdin so JSON-RPC lines are consumed.
  process.stdin.resume();
  serverStarted = true;
}

export { server, sourceService, config, SERVER_VERSION };
