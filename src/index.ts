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
import { registerAliasTool as registerAliasToolDirect } from "./registration-adapter.js";

import { objectResult } from "./mcp-helpers.js";
import { prepareToolInput } from "./tool-input.js";
import {
  DETAIL_ENABLED_TOOL_NAMES,
  DEFAULT_DETAIL_BY_TOOL,
  projectByDetail,
  type ResponseDetailLevel
} from "./response-utils.js";

import { loadConfig } from "./config.js";
import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { convertRuntimeSqliteCorruption } from "./storage/db.js";
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
import { reportedResolveNamespace } from "./source/artifact-resolver.js";
import { heavyToolExecutionGate } from "./tool-execution-gate.js";
import { SERVER_IDENTITY, SERVER_VERSION } from "./server-identity.js";
import { STDIO_WORKER_MODE_ENV } from "./stdio-supervisor.js";
import { capWarningDetailsForSummary, classifyWarnings } from "./warning-details.js";
import type { ArtifactScope } from "./types.js";
import { WorkspaceMappingService } from "./workspace-mapping-service.js";
import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "./entry-tools/inspect-minecraft-service.js";
import {
  AnalyzeSymbolService,
  analyzeSymbolSchema
} from "./entry-tools/analyze-symbol-service.js";
import {
  CompareMinecraftService,
  compareMinecraftSchema
} from "./entry-tools/compare-minecraft-service.js";
import {
  AnalyzeModService,
  analyzeModSchema
} from "./entry-tools/analyze-mod-service.js";
import {
  ValidateProjectService,
  validateProjectSchema,
  discoverWorkspaceAccessTransformers,
  discoverWorkspaceAccessWideners,
  discoverWorkspaceMixins
} from "./entry-tools/validate-project-service.js";
import {
  ManageCacheService,
  manageCacheSchema
} from "./entry-tools/manage-cache-service.js";
import { VerifyMixinTargetService } from "./entry-tools/verify-mixin-target-service.js";
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
  analyzeModJarSchema,
  batchClassMembersSchema,
  batchClassSourceSchema,
  batchMappingsSchema,
  batchSymbolExistsSchema,
  checkSymbolExistsSchema,
  compareVersionsSchema,
  decompileModJarSchema,
  diffClassSignaturesSchema,
  emptySchema,
  findMappingSchema,
  getArtifactFileSchema,
  getClassApiMatrixSchema,
  getClassMembersSchema,
  getClassSourceSchema,
  getModClassSourceSchema,
  getRegistryDataSchema,
  indexArtifactSchema,
  jsonToNbtSchema,
  listArtifactFilesSchema,
  listVersionsSchema,
  nbtApplyJsonPatchSchema,
  nbtToJsonSchema,
  remapModJarSchema,
  resolveArtifactSchema,
  resolveMethodMappingExactSchema,
  resolveWorkspaceSymbolSchema,
  searchClassSourceSchema,
  searchModSourceSchema,
  traceSymbolLifecycleSchema,
  validateAccessTransformerSchema,
  validateAccessWidenerSchema,
  validateMixinSchema,
  verifyMixinTargetSchema,
  findClassSchema
} from "./tool-schemas.js";
import {
  aliasDeprecation,
  ALIAS_BATCH_TOOL_NAMES,
  ALIAS_ENTRY_TOOL_NAMES,
  ALIAS_HEAVY_TOOL_NAMES,
  CATALOG_HEAVY_TOOL_NAMES,
  isAliasToolName,
  type AliasDeprecation
} from "./tools/inventory.js";
import { CATALOG_TOOL_SPECS } from "./tools/catalog.js";
import { registerCatalogTool } from "./tools/registration.js";
import type { CatalogRuntime, CatalogToolSpec } from "./tools/types.js";

type ToolMeta = ToolGuidanceToolMeta & { deprecated?: AliasDeprecation };

export { mapErrorToProblem, applyErrorMetaExtensions };

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const HEAVY_TOOL_NAMES = new Set([...ALIAS_HEAVY_TOOL_NAMES]);
const ENTRY_TOOL_NAMES = new Set([...ALIAS_ENTRY_TOOL_NAMES]);
// Batch tools self-project per entry but report the applied detail at the top level.
const BATCH_DETAIL_TOOL_NAMES = new Set([...ALIAS_BATCH_TOOL_NAMES]);


// Server identity ({name, version}) comes from the canonical module shared
// with the supervisor's synthetic decorator (src/server-identity.ts): the SDK
// stamps the Implementation passed to McpServer verbatim as
// `_meta[SERVER_INFO_META_KEY]` on every modern result, so identity equality
// with supervisor-synthesized results holds by construction.

// The McpServer instance is constructed per serveStdio factory call inside
// buildServer() below; module scope keeps only the shared services/config.

// The 8.x tools register as deprecated aliases through
// src/registration-adapter.ts: a validation-bypassing Standard Schema adapter
// keeps runTool() the single source of truth for validation and error
// envelopes, tools/list shows a minimal deprecation entry, and every reply
// gains meta.deprecated. MCP_DEPRECATED_TOOLS=off leaves them unregistered.

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

// Catalog calls share the 8.x tools' heavy-tool gate (one queue protects one
// machine) and record per-tool call metrics through the same path.
const catalogRuntime: CatalogRuntime = {
  heavyGate: heavyToolExecutionGate,
  isHeavy: (tool) => CATALOG_HEAVY_TOOL_NAMES.has(tool),
  recordToolCall: recordToolCallBestEffort,
  sqlitePath: config.sqlitePath,
  services: sourceService,
  config,
  stageEmitterFor: (ctx) => makeStageEmitter(ctx !== undefined ? stageEmitterExtraFromCtx(ctx) : undefined)
};

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
  getRegistryData: (input) => sourceService.getRegistryData(input),
  getVersionLibraries: (input) => sourceService.getVersionLibraries(input.version)
});
const analyzeModService = new AnalyzeModService({
  analyzeModJar: (jarPath, options) => analyzeModJar(jarPath, options),
  decompileModJar: (input) => sourceService.decompileModJar(input),
  getModClassSource: (input) => sourceService.getModClassSource(input),
  searchModSource: (input) => sourceService.searchModSource(input),
  remapModJar: (input) => remapModJar(input, config),
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
  probeMinecraftArtifact: (input) => sourceService.probeMinecraftArtifact(input)
});
const manageCacheService = new ManageCacheService({
  registry: createCacheRegistry({
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath,
    sqliteCacheKb: config.sqliteCacheKb,
    sqliteMmapSize: config.sqliteMmapSize
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
  getSignature: (input) => sourceService.explorerService.getSignature(input)
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

    // Expert tools share the entry-tool detail/include response contract:
    // resolution tools default to detail=summary, source/file tools to
    // detail=standard, and includeProvenance/includeDescriptors are aliases
    // folded into the include set.
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
        ...(warningDetails.length > 0 ? { warningDetails } : {}),
        deprecated: aliasDeprecation(tool, rawInput)
      } satisfies ToolMeta
    });
  } catch (caughtError) {
    // A raw SQLite corruption error surfaced mid-call (as opposed to at DB
    // open, which is already a typed AppError by the time it gets here) means
    // the file opened but a live query read a damaged page; a normal open runs
    // no consistency check.
    // Escalate the next open to a full integrity_check and report a typed,
    // restart-guiding ERR_DB_FAILURE instead of leaking ERR_INTERNAL.
    const reportedError = convertRuntimeSqliteCorruption(caughtError, config.sqlitePath);
    if (reportedError !== caughtError) {
      // The public envelope only ever gets the generic ERR_DB_FAILURE message
      // and nextAction (see convertRuntimeSqliteCorruption) - the original
      // SQLite diagnostic is server-side-only, logged here with the request
      // context convertRuntimeSqliteCorruption itself does not have access to.
      const rawSqliteError = caughtError as { message?: unknown; code?: unknown; errcode?: unknown };
      log("error", "tool.call.sqlite_runtime_corruption", {
        requestId,
        tool,
        message: typeof rawSqliteError?.message === "string" ? rawSqliteError.message : String(caughtError),
        code: rawSqliteError?.code,
        errcode: rawSqliteError?.errcode
      });
    }
    const problem = mapErrorToProblem(reportedError, requestId, {
      tool,
      normalizedInput
    });

    if (isAppError(reportedError)) {
      const isSevere =
        reportedError.code === ERROR_CODES.DB_FAILURE ||
        reportedError.code === ERROR_CODES.REPO_FETCH_FAILED ||
        reportedError.code === ERROR_CODES.REGISTRY_GENERATION_FAILED ||
        reportedError.code === ERROR_CODES.JAVA_UNAVAILABLE ||
        reportedError.code.startsWith("ERR_DECOMPILER");
      if (isSevere) {
        log("error", "tool.call.failed", {
          requestId,
          tool,
          code: reportedError.code,
          message: reportedError.message
        });
      } else {
        log("warn", "tool.call.warning", {
          requestId,
          tool,
          code: reportedError.code,
          message: reportedError.message
        });
      }
    } else if (!(reportedError instanceof ZodError)) {
      log("error", "tool.call.unhandled", {
        requestId,
        tool,
        reason: reportedError instanceof Error ? reportedError.message : String(reportedError)
      });
    }

    const errorDurationMs = Date.now() - startedAt;
    recordToolCallBestEffort(tool, errorDurationMs);
    const errorMeta: ToolMeta = {
      requestId,
      tool,
      durationMs: errorDurationMs
    };
    applyErrorMetaExtensions(errorMeta, reportedError);
    errorMeta.deprecated = aliasDeprecation(tool, rawInput);
    return objectResult({
      error: problem,
      meta: errorMeta
    }, { isError: true });
  }
}

/**
 * The `instructions` primer for AI agents: the shared vocabulary of the
 * catalog tools in a few sentences. The SDK sends it in the legacy
 * `initialize` result and in the modern `server/discover` result. Tool
 * descriptions stay self-sufficient for clients that do not show it.
 */
const CATALOG_PRIMER = [
  "The catalog tools are listed first.",
  "Each answers one kind of question and rejects an unknown argument key with `ERR_INVALID_INPUT` naming the key.",
  "`target` says where to look.",
  "`mapping` names the namespace of the names in a call; tools that would otherwise have to assume one require it.",
  "Catalog replies are `{ result, meta }`, or `{ error, meta }` on failure.",
  "`meta.nextActions` holds follow-up calls ready to send; one with `template: true` has `<placeholder>` values to fill in first.",
  "`meta.warnings` says what you should know."
].join(" ");

/** The primer's last sentence, sent only while the 8.x aliases are served. */
const ALIAS_PRIMER =
  "The 8.x tools listed after them are deprecated aliases, removed in 10.0.0; " +
  "their replies name the catalog tools to use in `meta.deprecated.replacedBy`.";

/** The primer text for a server that serves the 8.x aliases or leaves them out. */
function serverInstructions(deprecatedToolsEnabled: boolean): string {
  return deprecatedToolsEnabled ? `${CATALOG_PRIMER} ${ALIAS_PRIMER}` : CATALOG_PRIMER;
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
 * policy.) Catalog tools (`catalogSpecs`) register as their own group ahead of
 * the 8.x tools, ordered by the same era rule within the group.
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
function buildServer(
  ctx?: McpRequestContext,
  catalogSpecs: readonly CatalogToolSpec[] = CATALOG_TOOL_SPECS
): McpServer {
const server = new McpServer({
  name: SERVER_IDENTITY.name,
  version: SERVER_IDENTITY.version
}, {
  // Advertised capabilities (adopted policy). The SDK defaults BOTH
  // listChanged flags to `true` the first time a tool/resource is registered
  // (`... ?? true`), so an explicit `false` passed here is the only public way
  // to suppress them — the key cannot be omitted through any public API, and
  // per the revision an explicit `false` and an absent flag are equivalent.
  // The suppression is deliberate and is NOT era-gated: this server never
  // emits `notifications/tools/list_changed` or
  // `notifications/resources/list_changed` (the tool and resource surface is
  // fixed at process start by environment flags), and `subscriptions/listen`
  // answers -32601 in both eras, so advertising `true` would promise a stream
  // no client can subscribe to or ever receive.
  // KEY ORDER IS LOAD-BEARING: `resources` before `tools` reproduces the
  // frozen wire order of the legacy `initialize` and modern `server/discover`
  // capability payloads. Pinned by
  // tests/stdio/stdio-dependency-method-inventory.test.ts (legacy) and
  // tests/stdio/stdio-modern-discover-contents.test.ts (modern).
  capabilities: {
    resources: { listChanged: false },
    tools: { listChanged: false }
  },
  cacheHints: {
    "resources/list": RESOURCE_LISTS_CACHE_HINT,
    "resources/templates/list": RESOURCE_LISTS_CACHE_HINT
  },
  instructions: serverInstructions(config.deprecatedToolsEnabled)
});

registerResources(server, sourceService);

// Deferred tool-registration capture: the adapter import is RENAMED to
// registerAliasToolDirect, and this local wrapper function takes the original
// name, so every call site below records {name, thunk} in call-site order;
// the executor at the bottom of this function replays them in the
// era-appropriate order. With MCP_DEPRECATED_TOOLS=off the aliases record
// nothing, so they are neither listed nor callable.
const pendingToolRegistrations: Array<{ name: string; register: () => void; catalog?: true }> = [];
const registerAliasTool: typeof registerAliasToolDirect = (srv, name, annotations, handler) => {
  if (!config.deprecatedToolsEnabled) return;
  pendingToolRegistrations.push({
    name,
    register: () => registerAliasToolDirect(srv, name, annotations, handler)
  });
};

// The app-level schema registry (tool-schema-registry) is register-once and
// module-scoped: the eager `buildServer()` call at the bottom of this module
// populates it at load time; re-builds (one per serveStdio instance) skip
// re-registration so the registry never sees a duplicate. With the aliases
// switched off their names stay out of the registry, so the supervisor
// answers a legacy-era call to one as an unknown tool.
const registerToolSchema = (
  name: string,
  schema: Parameters<typeof registerToolSchemaInRegistry>[1]
): void => {
  if (!config.deprecatedToolsEnabled && isAliasToolName(name)) return;
  if (getToolSchema(name) === undefined) registerToolSchemaInRegistry(name, schema);
};

for (const spec of catalogSpecs) {
  pendingToolRegistrations.push({
    name: spec.name,
    catalog: true,
    register: () => registerCatalogTool(server, spec, catalogRuntime)
  });
  registerToolSchema(spec.name, spec.inputSchema);
}

registerAliasTool(server, "list-versions",
  { readOnlyHint: true },
  async (args) => runTool("list-versions", args, listVersionsSchema, async (input) =>
    sourceService.listVersions({
      includeSnapshots: input.includeSnapshots,
      limit: input.limit
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-versions", listVersionsSchema);

registerAliasTool(server, "inspect-minecraft",
  { readOnlyHint: true },
  async (args) => runTool("inspect-minecraft", args, inspectMinecraftSchema, async (input) =>
    inspectMinecraftService.execute(input as z.infer<typeof inspectMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("inspect-minecraft", inspectMinecraftSchema);

registerAliasTool(server, "analyze-symbol",
  { readOnlyHint: true },
  async (args) => runTool("analyze-symbol", args, analyzeSymbolSchema, async (input) =>
    analyzeSymbolService.execute(input as z.infer<typeof analyzeSymbolSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-symbol", analyzeSymbolSchema);

registerAliasTool(server, "compare-minecraft",
  { readOnlyHint: true },
  async (args) => runTool("compare-minecraft", args, compareMinecraftSchema, async (input) =>
    compareMinecraftService.execute(input as z.infer<typeof compareMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-minecraft", compareMinecraftSchema);

registerAliasTool(server, "analyze-mod",
  { readOnlyHint: false },
  async (args) => runTool("analyze-mod", args, analyzeModSchema, async (input) =>
    analyzeModService.execute(input as z.infer<typeof analyzeModSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-mod", analyzeModSchema);

registerAliasTool(server, "validate-project",
  { readOnlyHint: true },
  async (args, ctx) => runTool("validate-project", args, validateProjectSchema, async (input) =>
    validateProjectService.execute(input as z.infer<typeof validateProjectSchema>, {
      stageEmitter: makeStageEmitter(stageEmitterExtraFromCtx(ctx))
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-project", validateProjectSchema);

registerAliasTool(server, "manage-cache",
  { readOnlyHint: false },
  async (args) => runTool("manage-cache", args, manageCacheSchema, async (input) =>
    manageCacheService.execute(input as z.infer<typeof manageCacheSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("manage-cache", manageCacheSchema);

registerAliasTool(server, "verify-mixin-target",
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

registerAliasTool(server, "batch-class-source",
  { readOnlyHint: false },
  async (args) => runTool("batch-class-source", args, batchClassSourceSchema, async (input) =>
    batchClassSourceService.execute(input as z.infer<typeof batchClassSourceSchema>) as unknown as Promise<Record<string, unknown>>
  )
);
registerToolSchema("batch-class-source", batchClassSourceSchema);

registerAliasTool(server, "batch-class-members",
  { readOnlyHint: true },
  async (args) => runTool("batch-class-members", args, batchClassMembersSchema, async (input) =>
    batchClassMembersService.execute(input as z.infer<typeof batchClassMembersSchema>) as unknown as Promise<Record<string, unknown>>
  )
);
registerToolSchema("batch-class-members", batchClassMembersSchema);

registerAliasTool(server, "batch-symbol-exists",
  { readOnlyHint: true },
  async (args) => runTool("batch-symbol-exists", args, batchSymbolExistsSchema, async (input) =>
    batchSymbolExistsService.execute(input as z.infer<typeof batchSymbolExistsSchema>) as unknown as Promise<Record<string, unknown>>
  )
);
registerToolSchema("batch-symbol-exists", batchSymbolExistsSchema);

registerAliasTool(server, "batch-mappings",
  { readOnlyHint: true },
  async (args) => runTool("batch-mappings", args, batchMappingsSchema, async (input) =>
    batchMappingsService.execute(input as z.infer<typeof batchMappingsSchema>) as unknown as Promise<Record<string, unknown>>
  )
);
registerToolSchema("batch-mappings", batchMappingsSchema);

registerAliasTool(server, "resolve-artifact",
  { readOnlyHint: true },
  async (args) => runTool("resolve-artifact", args, resolveArtifactSchema, async (input) => {
    const output = await sourceService.resolveArtifact({
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
    });
    // Relabelled only here: every internal caller of resolveArtifact branches on
    // the stored label, so the resolve output itself keeps it.
    return { ...output, mappingApplied: reportedResolveNamespace(output) } as Record<string, unknown>;
  })
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

registerAliasTool(server, "find-class",
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

registerAliasTool(server, "get-class-source",
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

registerAliasTool(server, "get-class-members",
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
      includeAnnotations: input.includeAnnotations,
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

registerAliasTool(server, "search-class-source",
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

registerAliasTool(server, "get-artifact-file",
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

registerAliasTool(server, "list-artifact-files",
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

registerAliasTool(server, "trace-symbol-lifecycle",
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

registerAliasTool(server, "diff-class-signatures",
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

registerAliasTool(server, "find-mapping",
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

registerAliasTool(server, "resolve-method-mapping-exact",
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

registerAliasTool(server, "get-class-api-matrix",
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

registerAliasTool(server, "resolve-workspace-symbol",
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

registerAliasTool(server, "check-symbol-exists",
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

registerAliasTool(server, "nbt-to-json",
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

registerAliasTool(server, "nbt-apply-json-patch",
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

registerAliasTool(server, "json-to-nbt",
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

registerAliasTool(server, "index-artifact",
  { readOnlyHint: false, idempotentHint: true },
  async (args) => runTool("index-artifact", args, indexArtifactSchema, async (input) =>
    sourceService.indexArtifact({
      artifactId: await resolveFlatArtifactId(input),
      force: input.force
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("index-artifact", indexArtifactSchema);

registerAliasTool(server, "get-runtime-metrics",
  { readOnlyHint: true, openWorldHint: false },
  async (args) => runTool("get-runtime-metrics", args, emptySchema, async () =>
    Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
  )
);
registerToolSchema("get-runtime-metrics", emptySchema);

registerAliasTool(server, "validate-mixin",
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

registerAliasTool(server, "validate-access-widener",
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

registerAliasTool(server, "validate-access-transformer",
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

registerAliasTool(server, "analyze-mod-jar",
  { readOnlyHint: true },
  async (args) => runTool("analyze-mod-jar", args, analyzeModJarSchema, async (input) => {
    const result = await analyzeModJar(input.jarPath, {
      includeClasses: input.includeClasses ?? false
    });
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("analyze-mod-jar", analyzeModJarSchema);

registerAliasTool(server, "get-registry-data",
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

registerAliasTool(server, "compare-versions",
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

registerAliasTool(server, "decompile-mod-jar",
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

registerAliasTool(server, "get-mod-class-source",
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

registerAliasTool(server, "search-mod-source",
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

registerAliasTool(server, "remap-mod-jar",
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

// Deferred-registration executor: catalog tools first, then the 8.x tools.
// Within each group, legacy (and the ctx-less module singleton) keeps the
// frozen call-site order; a modern-era instance registers in raw
// tool-name-ascending order (plain code-unit comparison — tool names are
// ASCII, so this is byte order). The advertised tools/list order follows
// registration order in the SDK, which is exactly what the two golden/pinned
// contracts observe.
const inEraOrder = (group: typeof pendingToolRegistrations): typeof pendingToolRegistrations =>
  ctx?.era === "modern"
    ? [...group].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : group;
const toolRegistrationOrder = [
  ...inEraOrder(pendingToolRegistrations.filter((pending) => pending.catalog === true)),
  ...inEraOrder(pendingToolRegistrations.filter((pending) => pending.catalog !== true))
];
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
  // maxSubscriptions: 0 is defense in depth for the supervisor's admission
  // rejection of subscriptions/listen (docs/tool-reference.md, "Absent modern
  // surfaces"). The SDK stdio entry auto-provides that method with zero
  // registration and its default cap is 1024, so without this a frame that
  // somehow bypassed admission would be ACCEPTED — answered with an id-less
  // acknowledgment notification that never settles the request id — instead of
  // being refused.
  serveStdio(buildServer, { transport, maxSubscriptions: 0 });
  // In stdio mode, explicitly resume stdin so JSON-RPC lines are consumed.
  process.stdin.resume();
  serverStarted = true;
}

export { server, sourceService, config, SERVER_VERSION, buildServer, serverInstructions };
