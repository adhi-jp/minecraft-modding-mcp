import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";

import {
  McpServer,
  type CallToolResult,
  type JSONRPCMessage,
  type McpRequestContext,
  type ServerContext
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeStageEmitter, type StageEmitterExtra } from "./stage-emitter.js";
import { ZodError, z } from "zod";
import { RESOURCE_LISTS_CACHE_HINT } from "./cache-policy.js";
import { CompatStdioServerTransport } from "./compat-stdio-transport.js";
import {
  registerAppTool as registerAppToolDirect,
  registerExpertTool as registerExpertToolDirect
} from "./registration-adapter.js";

import { objectResult } from "./mcp-helpers.js";
import { runWithRequestContext } from "./request-context.js";
import { prepareToolInput } from "./tool-input.js";
import {
  DETAIL_ENABLED_TOOL_NAMES,
  DEFAULT_DETAIL_BY_TOOL,
  projectByDetail,
  type ResponseDetailLevel
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
import { SERVER_IDENTITY, SERVER_VERSION } from "./server-identity.js";
import { STDIO_WORKER_MODE_ENV } from "./stdio-supervisor.js";
import { capWarningDetailsForSummary, classifyWarnings } from "./warning-details.js";
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
import {
  getToolSchema,
  registerToolSchema as registerToolSchemaInRegistry
} from "./tool-schema-registry.js";
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
  verifyMixinTargetShape,
  findClassShape,
  findClassSchema
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
// Batch tools self-project per entry but report the applied detail at the top level.
const BATCH_DETAIL_TOOL_NAMES = new Set([
  "batch-class-source",
  "batch-class-members",
  "batch-symbol-exists",
  "batch-mappings"
]);
const heavyToolExecutionGate = new ToolExecutionGate({ maxConcurrent: 1, maxQueue: 2 });


// Server identity ({name, version}) comes from the canonical module shared
// with the supervisor's synthetic decorator (src/server-identity.ts): the SDK
// stamps the Implementation passed to McpServer verbatim as
// `_meta[SERVER_INFO_META_KEY]` on every modern result, so identity equality
// with supervisor-synthesized results holds by construction.

// The McpServer instance is constructed per serveStdio factory call inside
// buildServer() below; module scope keeps only the shared services/config.

// Tool registration goes through src/registration-adapter.ts: a
// validation-bypassing Standard Schema adapter keeps runTool() the single
// source of truth for validation and error envelopes, and serves the frozen
// pre-migration inputSchema bytes (src/v1-parity-schemas.ts) in tools/list.
// registerExpertTool() appends the expert-tool note to the description.

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

function recordToolCallBestEffort(tool: string, durationMs: number): void {
  try {
    sourceService.recordToolCall(tool, durationMs);
  } catch (caughtError) {
    log("warn", "tool.metrics.record.failed", {
      tool,
      reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
    });
  }
}

const workspaceMappingService = new WorkspaceMappingService();
const inspectMinecraftService = new InspectMinecraftService({
  listVersions: (input) => sourceService.listVersions(input),
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  findClass: (input) => sourceService.findClassIncludingNested(input),
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input),
  getClassSource: (input) => sourceService.getClassSource(input),
  getClassMembers: (input) => sourceService.getClassMembers(input),
  searchClassSource: (input) => sourceService.searchClassSource(input),
  getArtifactFile: (input) => sourceService.getArtifactFile(input),
  listArtifactFiles: (input) => sourceService.listArtifactFiles(input),
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath),
  listWorkspaceContexts: () => sourceService.workspaceContextCache.list()
});
const analyzeSymbolService = new AnalyzeSymbolService({
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath),
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
  remapModJar: (input) => remapModJar(input, config) as unknown as Promise<Record<string, unknown> & { warnings?: string[] }>,
  getModClassMembers: (input) => sourceService.getModClassMembers(input)
});
const validateProjectService = new ValidateProjectService({
  validateMixin: (input, options) =>
    sourceService.validateMixin(input as any, options) as Promise<Record<string, unknown> & { warnings?: string[] }>,
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
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      warnings: output.warnings
    };
  },
  probeMinecraftArtifact: (input) => sourceService.probeMinecraftArtifact(input)
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
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      binaryJarPath: output.binaryJarPath,
      version: output.version,
      provenance: output.provenance,
      warnings: output.warnings
    };
  },
  findMapping: async (input) => {
    const output = await sourceService.findMapping({
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping
    });
    return {
      resolved: output.resolved,
      resolvedSymbol: output.resolvedSymbol
        ? {
            name: output.resolvedSymbol.name,
            owner: output.resolvedSymbol.owner,
            descriptor: output.resolvedSymbol.descriptor
          }
        : undefined
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
    if (process.env[STDIO_WORKER_MODE_ENV] === "1") {
      process.exit(1);
    }
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    log("error", "process.unhandled_rejection", {
      message: error.message,
      stack: error.stack
    });
    if (process.env[STDIO_WORKER_MODE_ENV] === "1") {
      process.exit(1);
    }
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
  if (target.kind === "artifact") {
    return { artifactId: target.artifactId };
  }
  return { target: target as ResolveArtifactTargetInput };
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

/**
 * Read the detail/include response-shape controls from a parsed tool input.
 * Folds the legacy includeProvenance/includeDescriptors flags into the include
 * set as aliases so the migration off `compact` preserves Phase-4 behavior.
 */
function readResponseShapeInput(parsedInput: unknown): {
  detail?: ResponseDetailLevel;
  include: Set<string>;
} {
  const include = new Set<string>();
  if (parsedInput === null || typeof parsedInput !== "object" || Array.isArray(parsedInput)) {
    return { include };
  }
  const record = parsedInput as Record<string, unknown>;
  if (Array.isArray(record.include)) {
    for (const group of record.include) {
      if (typeof group === "string") include.add(group);
    }
  }
  if (record.includeProvenance === true) include.add("provenance");
  if (record.includeDescriptors === true) include.add("descriptors");
  const detail =
    typeof record.detail === "string" &&
    (record.detail === "summary" || record.detail === "standard" || record.detail === "full")
      ? (record.detail as ResponseDetailLevel)
      : undefined;
  return { detail, include };
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
    return await runWithRequestContext({ requestId }, async () => {
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
            // Route construction through buildSuggestedCall to satisfy the D12
            // invariant (tests/suggested-call-invariant.test.ts): every emitted
            // suggestedCall must be built by the helper. The downstream
            // mapErrorToProblem gate re-validates on emission; that second pass is
            // the intentional, cheap cost of the two complementary safety gates.
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

      // Expert tools share the entry-tool detail/include response contract (the old
      // per-tool `compact` boolean is gone). projectByDetail reproduces the previous
      // compact defaults byte-identically: resolution tools default detail=summary
      // (old compact:true), source/file tools default detail=standard (old compact:false).
      // The legacy includeProvenance/includeDescriptors flags are folded into the
      // include set as aliases so Phase-4 behavior is preserved.
      const shapeInput = readResponseShapeInput(parsedInput);
      const effectiveDetail: ResponseDetailLevel = ENTRY_TOOL_NAMES.has(tool)
        ? (shapeInput.detail ?? "summary")
        : (shapeInput.detail ?? DEFAULT_DETAIL_BY_TOOL[tool] ?? "summary");
      let projectedResult = result;
      if (DETAIL_ENABLED_TOOL_NAMES.has(tool)) {
        projectedResult = projectByDetail(
          tool,
          projectedResult as Record<string, unknown>,
          effectiveDetail,
          shapeInput.include
        );
      }

      // Entry, expert, and batch tools report the applied detail/include shape in meta.
      // detailApplied is omitted when it matches the tool's default to keep responses lean.
      const defaultDetail: ResponseDetailLevel = ENTRY_TOOL_NAMES.has(tool)
        ? "summary"
        : DEFAULT_DETAIL_BY_TOOL[tool] ?? "summary";
      const entryMeta =
        ENTRY_TOOL_NAMES.has(tool) ||
        DETAIL_ENABLED_TOOL_NAMES.has(tool) ||
        BATCH_DETAIL_TOOL_NAMES.has(tool)
          ? buildEntryToolMeta({
              detail: effectiveDetail,
              defaultDetail,
              include: shapeInput.include.size > 0 ? [...shapeInput.include] : undefined
            })
          : undefined;

      const durationMs = Date.now() - startedAt;
      recordToolCallBestEffort(tool, durationMs);
      const warningDetails = capWarningDetailsForSummary(
        classifyWarnings(warnings),
        effectiveDetail === "summary"
      );
      return objectResult({
        result: projectedResult,
        meta: {
          ...(entryMeta ?? {}),
          ...resultMeta,
          requestId,
          tool,
          durationMs,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(warningDetails.length > 0 ? { warningDetails } : {})
        } satisfies ToolMeta
      });
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
    recordToolCallBestEffort(tool, errorDurationMs);
    const errorMeta: ToolMeta = {
      requestId,
      tool,
      durationMs: errorDurationMs
    };
    applyErrorMetaExtensions(errorMeta, caughtError);
    return objectResult({
      error: problem,
      meta: errorMeta
    }, { isError: true });
  }
}

/**
 * Builds a fully-registered McpServer instance. serveStdio calls its factory
 * PER INSTANCE, not per connection: a modern `server/discover` opening builds
 * a probe instance which a following legacy `initialize` DISCARDS
 * (`product.close()`) before calling the factory again — and the probe path
 * MUTATES the instance (installModernOnlyHandlers adds "2026-07-28" support
 * and a server/discover handler). Every call therefore constructs a FRESH
 * McpServer so probe-instance mutations can never leak onto the re-pinned
 * legacy instance (frozen negotiate-down contract). Module-scope services,
 * config, and helpers stay shared; only the McpServer and its registrations
 * are per-instance.
 *
 * Tool registration ORDER: the CALL-SITE order inside this function is the
 * frozen legacy tools/list order — do not reorder the call sites. The calls
 * are captured as deferred thunks and executed at the bottom of the
 * function: in call-site order for legacy/ctx-less instances (byte-frozen
 * golden contract), and in raw tool-name-ascending order when serveStdio
 * constructs a MODERN-era instance (`ctx.era === "modern"` — the SDK's
 * documented era-parameterized factory seam; the v2 SDK itself emits
 * registration order and never sorts). Each instance serves exactly one era,
 * so the two orders can never mix on one connection. (Adopted ordering
 * policy.)
 *
 * Cache hints (adopted policy, src/cache-policy.ts): the constructor options
 * configure the non-zero resources/list + resources/templates/list rows;
 * per-resource rows live in registerResources(); all hints ride the SDK's
 * never-serialized carrier, so 2025-era responses are unaffected.
 *
 * NOTE: the function body below intentionally keeps the original module-scope
 * indentation of the registration block to preserve a reviewable minimal diff.
 */
// eslint-disable-next-line func-style
function buildServer(ctx?: McpRequestContext): McpServer {
const server = new McpServer({
  name: SERVER_IDENTITY.name,
  version: SERVER_IDENTITY.version
}, {
  cacheHints: {
    "resources/list": RESOURCE_LISTS_CACHE_HINT,
    "resources/templates/list": RESOURCE_LISTS_CACHE_HINT
  }
});

registerResources(server, sourceService);

// Deferred tool-registration capture: the adapter imports are RENAMED to
// registerAppToolDirect/registerExpertToolDirect, and these local wrapper
// functions take the original names, so every call site below records
// {name, thunk} in call-site order; the executor at the bottom of this
// function replays them in the era-appropriate order.
const pendingToolRegistrations: Array<{ name: string; register: () => void }> = [];
const registerAppTool: typeof registerAppToolDirect = (srv, name, description, shape, annotations, handler) => {
  pendingToolRegistrations.push({
    name,
    register: () => registerAppToolDirect(srv, name, description, shape, annotations, handler)
  });
};
const registerExpertTool: typeof registerExpertToolDirect = (srv, name, description, shape, annotations, handler) => {
  pendingToolRegistrations.push({
    name,
    register: () => registerExpertToolDirect(srv, name, description, shape, annotations, handler)
  });
};

// The app-level schema registry (tool-schema-registry) is register-once and
// module-scoped: the eager `buildServer()` call at the bottom of this module
// populates it at load time; re-builds (one per serveStdio instance) skip
// re-registration so the registry never sees a duplicate.
const registerToolSchema = (
  name: string,
  schema: Parameters<typeof registerToolSchemaInRegistry>[1]
): void => {
  if (getToolSchema(name) === undefined) registerToolSchemaInRegistry(name, schema);
};

registerExpertTool(server, "list-versions",
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

registerAppTool(server, "inspect-minecraft",
  "Top-level workflow tool for version discovery, artifact resolution, class inspection, source search, file reads, and file listings. Workspace subject.focus is a structured class/file/search object, never a string; task=auto dispatches from subject.kind and focus.kind.",
  inspectMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("inspect-minecraft", args, inspectMinecraftSchema, async (input) =>
    inspectMinecraftService.execute(input as z.infer<typeof inspectMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("inspect-minecraft", inspectMinecraftSchema);

registerAppTool(server, "analyze-symbol",
  "Top-level workflow tool for symbol existence, mapping, lifecycle, workspace analysis, and API overview. subject.kind='symbol' auto-detects class/field/method from the selector.",
  analyzeSymbolShape,
  { readOnlyHint: true },
  async (args) => runTool("analyze-symbol", args, analyzeSymbolSchema, async (input) =>
    analyzeSymbolService.execute(input as z.infer<typeof analyzeSymbolSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-symbol", analyzeSymbolSchema);

registerAppTool(server, "compare-minecraft",
  "Top-level workflow tool for version comparisons, class diffs, registry diffs, and migration overviews.",
  compareMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("compare-minecraft", args, compareMinecraftSchema, async (input) =>
    compareMinecraftService.execute(input as z.infer<typeof compareMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-minecraft", compareMinecraftSchema);

registerAppTool(server, "analyze-mod",
  "Top-level workflow tool for mod metadata inspection, decompile/search flows, class source, bytecode-only class member reads, and safe remap previews/applies.",
  analyzeModShape,
  { readOnlyHint: false },
  async (args) => runTool("analyze-mod", args, analyzeModSchema, async (input) =>
    analyzeModService.execute(input as z.infer<typeof analyzeModSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-mod", analyzeModSchema);

registerAppTool(server, "validate-project",
  "Top-level workflow tool for project summary, direct mixin validation, and access widener/access transformer validation.",
  validateProjectShape,
  { readOnlyHint: true },
  async (args, ctx) => runTool("validate-project", args, validateProjectSchema, async (input) =>
    validateProjectService.execute(input as z.infer<typeof validateProjectSchema>, {
      stageEmitter: makeStageEmitter(stageEmitterExtraFromCtx(ctx))
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-project", validateProjectSchema);

registerAppTool(server, "manage-cache",
  "Top-level workflow tool for cache summaries, listing, verification, previewed mutation, and explicit apply operations.",
  manageCacheShape,
  { readOnlyHint: false },
  async (args) => runTool("manage-cache", args, manageCacheSchema, async (input) =>
    manageCacheService.execute(input as z.infer<typeof manageCacheSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("manage-cache", manageCacheSchema);

if (!VERIFY_MIXIN_TARGET_OFF) {
  registerAppTool(server, "verify-mixin-target",
    "Single-call probe: does this target owner / member exist and which @Shadow / @Accessor / @Invoker should the mixin use? Reuses target.kind workspace/version/coordinate/dependency/jar.",
    verifyMixinTargetShape,
    { readOnlyHint: true },
    async (args) => runTool("verify-mixin-target", args, verifyMixinTargetSchema, async (input) =>
      verifyMixinTargetService.execute({
        owner: input.owner,
        member: input.member,
        mixinMemberName: input.mixinMemberName,
        mapping: input.mapping,
        autoRemap: input.autoRemap,
        sourcePriority: input.sourcePriority,
        projectPath: input.projectPath,
        gradleUserHome: input.gradleUserHome,
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
  registerAppTool(server, "batch-class-source",
    "Batch get-class-source for many classes sharing one resolved artifact; returns per-entry status plus aggregate summary. Not read-only: per-entry outputFile writes to disk.",
    batchClassSourceShape,
    { readOnlyHint: false },
    async (args) => runTool("batch-class-source", args, batchClassSourceSchema, async (input) =>
      batchClassSourceService.execute(input as z.infer<typeof batchClassSourceSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-source", batchClassSourceSchema);

  registerAppTool(server, "batch-class-members",
    "Batch get-class-members for many classes sharing one resolved artifact; returns per-entry status plus aggregate summary.",
    batchClassMembersShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-class-members", args, batchClassMembersSchema, async (input) =>
      batchClassMembersService.execute(input as z.infer<typeof batchClassMembersSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-members", batchClassMembersSchema);

  registerAppTool(server, "batch-symbol-exists",
    "Batch check-symbol-exists for many symbols against one shared Minecraft version (target.kind=version or workspace only).",
    batchSymbolExistsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-symbol-exists", args, batchSymbolExistsSchema, async (input) =>
      batchSymbolExistsService.execute(input as z.infer<typeof batchSymbolExistsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-symbol-exists", batchSymbolExistsSchema);

  registerAppTool(server, "batch-mappings",
    "Batch find-mapping: resolve many symbols across mapping namespaces with one shared Minecraft version.",
    batchMappingsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-mappings", args, batchMappingsSchema, async (input) =>
      batchMappingsService.execute(input as z.infer<typeof batchMappingsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-mappings", batchMappingsSchema);
}

registerExpertTool(server, "resolve-artifact",
  "Resolve a source artifact and return artifact metadata. For target.kind=jar, only <basename>-sources.jar is auto-adopted.",
  resolveArtifactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-artifact", args, resolveArtifactSchema, async (input) =>
    sourceService.resolveArtifact({
      target: input.target as ResolveArtifactTargetInput,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      includeSampleEntries:
        input.detail === "full" ||
        (Array.isArray(input.include) && input.include.includes("samples"))
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-artifact", resolveArtifactSchema);

// Flat tools accept `target` as an additive alternative to `artifactId`
// (mutually exclusive, enforced by each schema). A target is resolved to its
// artifactId here before the underlying artifactId-based service call.
async function resolveFlatArtifactId(input: {
  artifactId?: string;
  target?: unknown;
  projectPath?: string;
}): Promise<string> {
  if (input.artifactId) {
    return input.artifactId;
  }
  const target = input.target as
    | { kind?: string; artifactId?: string; projectPath?: string }
    | undefined;
  // {kind:"artifact"} reuses an already-resolved artifact without a resolve
  // round-trip. Workspace-context kinds carry their own projectPath when the
  // target shape provides one; kinds that require workspace context beyond
  // that fail with the resolver's own projectPath guidance.
  if (target?.kind === "artifact" && target.artifactId) {
    return target.artifactId;
  }
  const projectPath = input.projectPath ?? target?.projectPath;
  const resolved = await sourceService.resolveArtifact({
    target: target as Parameters<typeof sourceService.resolveArtifact>[0]["target"],
    ...(projectPath ? { projectPath } : {})
  });
  return resolved.artifactId;
}

registerExpertTool(server, "find-class",
  "Resolve a simple or qualified class name to fully-qualified class names within an artifact. Use this before get-class-source when you only have a simple name.",
  findClassShape,
  { readOnlyHint: true },
  async (args) => runTool("find-class", args, findClassSchema, async (input) =>
    sourceService.findClassIncludingNested({
      className: input.className,
      artifactId: await resolveFlatArtifactId(input),
      limit: input.limit
    }) as unknown as Promise<Record<string, unknown>>
  )
);
registerToolSchema("find-class", findClassSchema);

registerExpertTool(server, "get-class-source",
  "Get Java source for a class. Default mode=metadata returns a symbol outline only; pass mode=snippet or mode=full to read source text. Not read-only: outputFile writes to disk.",
  getClassSourceShape,
  { readOnlyHint: false },
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
      gradleUserHome: input.gradleUserHome,
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

registerExpertTool(server, "get-class-members",
  "Get fields/methods/constructors for one class from binary bytecode.",
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
      projection: input.projection,
      cursor: input.cursor,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      // includeDescriptors is the documented alias for include:["descriptors"]; honor both
      // (mirror batch-class-members-service / inspect-minecraft class-members handler).
      includeDescriptors:
        input.includeDescriptors === true ||
        (Array.isArray(input.include) && input.include.includes("descriptors"))
    }) as Promise<Record<string, unknown>>
    );
  })
);
registerToolSchema("get-class-members", getClassMembersSchema);

registerExpertTool(server, "search-class-source",
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
        artifactId: await resolveFlatArtifactId(input),
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
        sourcePriority: input.sourcePriority,
        gradleUserHome: input.gradleUserHome
      }) as Promise<Record<string, unknown>>;
    })
);
registerToolSchema("search-class-source", searchClassSourceSchema);

registerExpertTool(server, "get-artifact-file",
  "Get full source file content by artifactId and file path.",
  getArtifactFileShape,
  { readOnlyHint: true },
  async (args) => runTool("get-artifact-file", args, getArtifactFileSchema, async (input) =>
    sourceService.getArtifactFile({
      artifactId: await resolveFlatArtifactId(input),
      filePath: input.filePath,
      maxBytes: input.maxBytes
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-artifact-file", getArtifactFileSchema);

registerExpertTool(server, "list-artifact-files",
  "List source file paths in an artifact with optional prefix filter and cursor-based pagination.",
  listArtifactFilesShape,
  { readOnlyHint: true },
  async (args) => runTool("list-artifact-files", args, listArtifactFilesSchema, async (input) =>
    sourceService.listArtifactFiles({
      artifactId: await resolveFlatArtifactId(input),
      prefix: input.prefix,
      limit: input.limit,
      cursor: input.cursor
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-artifact-files", listArtifactFilesSchema);

registerExpertTool(server, "trace-symbol-lifecycle",
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
      gradleUserHome: input.gradleUserHome,
      includeSnapshots: input.includeSnapshots,
      maxVersions: input.maxVersions,
      includeTimeline: input.includeTimeline
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("trace-symbol-lifecycle", traceSymbolLifecycleSchema);

registerExpertTool(server, "diff-class-signatures",
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
      gradleUserHome: input.gradleUserHome,
      includeFullDiff: input.includeFullDiff
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("diff-class-signatures", diffClassSignaturesSchema);

registerExpertTool(server, "find-mapping",
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
      gradleUserHome: input.gradleUserHome,
      nameMode: input.nameMode,
      signatureMode: input.signatureMode,
      disambiguation: input.disambiguation,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("find-mapping", findMappingSchema);

registerExpertTool(server, "resolve-method-mapping-exact",
  "Strict variant of find-mapping(kind=method, signatureMode=exact): requires a COMPLETE descriptor projection and returns mapping_unavailable when any descriptor class reference cannot be projected. Prefer find-mapping unless you need that guarantee.",
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
      gradleUserHome: input.gradleUserHome,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-method-mapping-exact", resolveMethodMappingExactSchema);

registerExpertTool(server, "get-class-api-matrix",
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
      gradleUserHome: input.gradleUserHome,
      maxRows: input.maxRows,
      cursor: input.cursor
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-class-api-matrix", getClassApiMatrixSchema);

registerExpertTool(server, "resolve-workspace-symbol",
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
      gradleUserHome: input.gradleUserHome,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-workspace-symbol", resolveWorkspaceSymbolSchema);

registerExpertTool(server, "check-symbol-exists",
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
      gradleUserHome: input.gradleUserHome,
      nameMode: input.nameMode,
      signatureMode: input.signatureMode,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("check-symbol-exists", checkSymbolExistsSchema);

registerAppTool(server, "nbt-to-json",
  "Decode Java Edition NBT binary payload (base64) into typed JSON.",
  nbtToJsonShape,
  { readOnlyHint: true, openWorldHint: false },
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

registerAppTool(server, "nbt-apply-json-patch",
  "Apply RFC6902 add/remove/replace/test operations to typed NBT JSON.",
  nbtApplyJsonPatchShape,
  { readOnlyHint: true, openWorldHint: false },
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

registerAppTool(server, "json-to-nbt",
  "Encode typed NBT JSON to Java Edition NBT binary payload (base64).",
  jsonToNbtShape,
  { readOnlyHint: true, openWorldHint: false },
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

registerExpertTool(server, "index-artifact",
  "Rebuild indexed files/symbols metadata for an artifact addressed by artifactId or target. A new target is resolved and ingested first; force rebuilds an existing index.",
  indexArtifactShape,
  { readOnlyHint: false, idempotentHint: true },
  async (args) => runTool("index-artifact", args, indexArtifactSchema, async (input) =>
    sourceService.indexArtifact({
      artifactId: await resolveFlatArtifactId(input),
      force: input.force
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("index-artifact", indexArtifactSchema);

registerAppTool(server, "get-runtime-metrics",
  "Get runtime service counters and latency snapshots for cache/search/index diagnostics.",
  {},
  { readOnlyHint: true, openWorldHint: false },
  async (args) => runTool("get-runtime-metrics", args, emptySchema, async () =>
    Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
  )
);
registerToolSchema("get-runtime-metrics", emptySchema);

registerExpertTool(server, "validate-mixin",
  "Validate Mixin source against Minecraft bytecode signatures for a given version.",
  validateMixinShape,
  { readOnlyHint: true },
  async (args, ctx) => runTool("validate-mixin", args, validateMixinSchema, async (input) =>
    sourceService.validateMixin({
      input: input.input,
      sourceRoots: input.sourceRoots,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope as ArtifactScope | undefined,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
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
      stageEmitter: makeStageEmitter(stageEmitterExtraFromCtx(ctx))
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-mixin", validateMixinSchema);

registerExpertTool(server, "validate-access-widener",
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
      gradleUserHome: input.gradleUserHome,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-widener", validateAccessWidenerSchema);

registerExpertTool(server, "validate-access-transformer",
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
      gradleUserHome: input.gradleUserHome,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-transformer", validateAccessTransformerSchema);

registerExpertTool(server, "analyze-mod-jar",
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

registerAppTool(server, "get-registry-data",
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

registerExpertTool(server, "compare-versions",
  "Compare two Minecraft versions to find added/removed classes and registry entry changes.",
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

registerExpertTool(server, "decompile-mod-jar",
  "Decompile a Minecraft mod JAR using Vineflower and list available classes, or view a specific class source. Builds on analyze-mod-jar.",
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

registerExpertTool(server, "get-mod-class-source",
  "Get decompiled source code for a specific class in a mod JAR. The mod JAR will be decompiled if not already cached. Not read-only: outputFile writes the source to disk.",
  getModClassSourceShape,
  { readOnlyHint: false },
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

registerExpertTool(server, "search-mod-source",
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

registerExpertTool(server, "remap-mod-jar",
  "Remap a Fabric mod JAR from intermediary to yarn/mojang names. Requires Java to be installed.",
  remapModJarShape,
  { readOnlyHint: false },
  async (args) => runTool("remap-mod-jar", args, remapModJarSchema, async (input) => {
    const result = await remapModJar(
      {
        inputJar: input.inputJar,
        outputJar: input.outputJar,
        mcVersion: input.mcVersion,
        targetMapping: input.targetMapping,
        forceRemap: input.forceRemap
      },
      config
    );
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("remap-mod-jar", remapModJarSchema);

// Deferred-registration executor: legacy (and the ctx-less module singleton)
// keeps the frozen call-site order; a modern-era instance registers in raw
// tool-name-ascending order (plain code-unit comparison — tool names are
// ASCII, so this is byte order). The advertised tools/list order follows
// registration order in the SDK, which is exactly what the two golden/pinned
// contracts observe.
const toolRegistrationOrder =
  ctx?.era === "modern"
    ? [...pendingToolRegistrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : pendingToolRegistrations;
for (const pending of toolRegistrationOrder) pending.register();

return server;
}

/**
 * Module-scope singleton: populates the register-once tool-schema registry at
 * load time and serves in-process consumers (tests drive its request handlers
 * directly). The stdio wire path does NOT serve this instance — serveStdio's
 * factory builds a fresh one per pinned/probe instance (see buildServer).
 */
const server = buildServer();

/**
 * The worker's wire transport, kept module-scoped so per-request stage
 * emitters can write `$/stageUpdate` notifications directly onto the wire
 * (the v2 ServerContext exposes no raw sendNotification). Set once by
 * startServer(); undefined outside stdio worker mode, in which case
 * makeStageEmitter() NOOPs exactly as before.
 */
let workerTransport: CompatStdioServerTransport | undefined;

/**
 * Builds the makeStageEmitter() argument from a v2 ServerContext: the
 * JSON-RPC request id comes from ctx.mcpReq.id and delivery goes through the
 * module-scoped worker transport. Returns undefined (NOOP emitter) when the
 * transport is not up or the id is not a wire-correlatable string/number.
 */
function stageEmitterExtraFromCtx(ctx: ServerContext): StageEmitterExtra | undefined {
  const transport = workerTransport;
  const requestId = ctx.mcpReq?.id;
  if (!transport || (typeof requestId !== "string" && typeof requestId !== "number")) {
    return undefined;
  }
  return {
    requestId,
    sendNotification: (notification) =>
      transport.send({
        jsonrpc: "2.0",
        method: notification.method,
        ...(notification.params !== undefined ? { params: notification.params } : {})
      } as JSONRPCMessage)
  };
}

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
  workerTransport = transport;
  // serveStdio owns the connection and calls the factory PER INSTANCE: a
  // modern server/discover opening builds a probe instance that a following
  // legacy initialize discards and replaces via a second factory call. The
  // probe path mutates its instance (modern-only handlers + protocol
  // versions), so the factory MUST build a fresh McpServer each time — never
  // the module-scope singleton — or probe mutations would leak onto the
  // re-pinned legacy instance and break the negotiate-down contract. The
  // transport is started synchronously inside serveStdio, so resolving here
  // keeps the READY marker contract: the worker is listening once
  // startServer() returns.
  serveStdio(buildServer, { transport });
  // In stdio mode, explicitly resume stdin so JSON-RPC lines are consumed.
  process.stdin.resume();
  serverStarted = true;
}

export { server, sourceService, config, SERVER_VERSION, buildServer };
