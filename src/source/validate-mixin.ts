import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, dirname, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";

import fastGlob from "fast-glob";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { type AppError, ERROR_CODES, createError, isAppError } from "../errors.js";
import { parseMixinSource } from "../mixin-parser.js";
import {
  type IssueConfidence,
  type MappingHealthReport,
  type MixinValidationProvenance,
  type MixinValidationResult,
  type MixinStageBudgets,
  type ResolvedTargetMembers,
  type TargetOutcome as MixinTargetOutcome,
  loadMixinStageBudgets,
  refreshMixinValidationOutcome,
  validateParsedMixin
} from "../mixin-validator.js";
import { normalizePathForHost } from "../path-converter.js";
import type { SourceService } from "../source-service.js";
import type {
  ResolveArtifactOutput,
  ValidateMixinBatchResult,
  ValidateMixinInput,
  ValidateMixinOptions,
  ValidateMixinOutput,
  ValidateMixinResultSource
} from "../source-service.js";
import { NOOP_STAGE_EMITTER, type StageEmitter } from "../stage-emitter.js";
import type { ArtifactScope, MappingSourcePriority, SourceMapping } from "../types.js";
import type { FindMappingOutput as MappingFindMappingOutput } from "../mapping-service.js";
/* remapSignatureMembers reached via svc.remapSignatureMembers so tests can monkey-patch */

export type ValidateMixinSingleInput = Omit<ValidateMixinInput, "input"> & {
  source?: string;
  sourcePath?: string;
  batchCaches?: {
    classMappings: Map<string, Promise<MappingFindMappingOutput>>;
  };
  retryState?: {
    attempted: boolean;
    initialSourcePriority: MappingSourcePriority;
  };
  stageEmitter?: StageEmitter;
  __stageBudgets?: Partial<MixinStageBudgets>;
  __testHooks?: ValidateMixinOptions["__testHooks"];
};

type ValidateMixinConfigSource = {
  sourcePath: string;
  configPath: string;
};

type ResolvedValidateMixinConfigSources = {
  sources: ValidateMixinConfigSource[];
  warnings: string[];
};

/**
 * Diagnostic tag attached to every AppError thrown out of validate-mixin.
 * - "input-validation": required field missing or sourcePath unreadable
 * - "resolve": jar / artifact resolution
 * - "mapping-health": mapping infrastructure probe
 * - "parse": parseMixinSource failure
 * - "target-lookup": per-target symbol/signature/remap loop
 */
type ValidateMixinStage =
  | "input-validation"
  | "resolve"
  | "mapping-health"
  | "parse"
  | "target-lookup";

const COMMON_SOURCE_ROOTS = [
  "src/main/java",
  "src/client/java",
  "common/src/main/java",
  "common/src/client/java",
  "fabric/src/main/java",
  "fabric/src/client/java",
  "neoforge/src/main/java",
  "neoforge/src/client/java",
  "forge/src/main/java",
  "forge/src/client/java",
  "quilt/src/main/java",
  "quilt/src/client/java"
] as const;

const MIXIN_PROJECT_DISCOVERY_IGNORES = [
  "**/.git/**",
  "**/.gradle/**",
  "**/build/**",
  "**/out/**",
  "**/node_modules/**"
] as const;

function annotateValidateMixinError(err: unknown, stage: ValidateMixinStage): AppError {
  if (isAppError(err)) {
    const existing = (err.details ?? {}) as Record<string, unknown>;
    if (typeof existing.failedStage === "string") {
      return err;
    }
    return createError({
      code: err.code,
      message: err.message,
      details: { ...existing, failedStage: stage }
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return createError({
    code: ERROR_CODES.INTERNAL,
    message: `validate-mixin failed during stage "${stage}": ${message}`,
    details: { failedStage: stage }
  });
}

function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
  if (mapping == null) {
    return "obfuscated";
  }
  if (
    mapping === "obfuscated" ||
    mapping === "mojang" ||
    mapping === "intermediary" ||
    mapping === "yarn"
  ) {
    return mapping;
  }
  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Unsupported mapping "${mapping}".`,
    details: {
      mapping,
      nextAction: "Try mapping=obfuscated which is always available.",
      ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
    }
  });
}

function normalizePathStyle(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeRequestedArtifactScope(scope: ArtifactScope | undefined): ArtifactScope {
  return scope ?? "vanilla";
}

function inferAppliedArtifactScope(input: {
  requestedScope: ArtifactScope;
  scopeFallback?: { applied: string };
  jarPath: string;
  resolvedSourceJarPath?: string;
}): ArtifactScope {
  if (input.scopeFallback?.applied === "vanilla") {
    return "vanilla";
  }
  if (input.requestedScope === "vanilla") {
    return "vanilla";
  }

  const joinedPath = `${normalizePathStyle(input.jarPath)} ${normalizePathStyle(input.resolvedSourceJarPath ?? "")}`.toLowerCase();
  if (joinedPath.includes("minecraft-merged")) {
    return "merged";
  }
  if (input.requestedScope === "loader" && joinedPath.includes("merged")) {
    return "merged";
  }
  return input.requestedScope;
}

function scopeToJarType(scope: ArtifactScope): "vanilla-client" | "merged" | "loader" {
  if (scope === "vanilla") {
    return "vanilla-client";
  }
  return scope;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameScopeFallback(
  left: MixinValidationProvenance["scopeFallback"] | undefined,
  right: MixinValidationProvenance["scopeFallback"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.requested === right.requested && left.applied === right.applied && left.reason === right.reason;
}

function sameResolutionTrace(
  left: MixinValidationProvenance["resolutionTrace"] | undefined,
  right: MixinValidationProvenance["resolutionTrace"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (!leftEntry || !rightEntry) {
      return false;
    }
    if (
      leftEntry.target !== rightEntry.target ||
      leftEntry.step !== rightEntry.step ||
      leftEntry.input !== rightEntry.input ||
      leftEntry.output !== rightEntry.output ||
      leftEntry.success !== rightEntry.success ||
      leftEntry.detail !== rightEntry.detail
    ) {
      return false;
    }
  }
  return true;
}

function sameMixinValidationProvenance(
  left: MixinValidationProvenance | undefined,
  right: MixinValidationProvenance | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.version === right.version &&
    left.jarPath === right.jarPath &&
    left.requestedMapping === right.requestedMapping &&
    left.mappingApplied === right.mappingApplied &&
    left.requestedScope === right.requestedScope &&
    left.appliedScope === right.appliedScope &&
    left.requestedSourcePriority === right.requestedSourcePriority &&
    left.appliedSourcePriority === right.appliedSourcePriority &&
    sameStringArray(left.resolutionNotes, right.resolutionNotes) &&
    left.jarType === right.jarType &&
    sameStringArray(left.mappingChain, right.mappingChain) &&
    left.remapFailures === right.remapFailures &&
    left.mappingAutoDetected === right.mappingAutoDetected &&
    sameScopeFallback(left.scopeFallback, right.scopeFallback) &&
    sameResolutionTrace(left.resolutionTrace, right.resolutionTrace)
  );
}

export async function validateMixin(
  svc: SourceService,
  input: ValidateMixinInput,
  options: ValidateMixinOptions = {}
): Promise<ValidateMixinOutput> {
  // Wrap the dispatcher so any untagged AppError coming out of path
  // normalization, preflight discovery, or config resolution surfaces with a
  // meaningful failedStage. annotateValidateMixinError preserves any
  // inner-pipeline tag (resolve/mapping-health/parse/target-lookup) so only
  // the dispatcher-level errors default to input-validation.
  try {
    return await runValidateMixinDispatcher(svc, input, options);
  } catch (err) {
    throw annotateValidateMixinError(err, "input-validation");
  }
}

async function runValidateMixinDispatcher(
  svc: SourceService,
  input: ValidateMixinInput,
  options: ValidateMixinOptions = {}
): Promise<ValidateMixinOutput> {
  const { input: sourceInput, ...sharedInput } = input;
  const mode = sourceInput.mode;
  const stageEmitter = options.stageEmitter ?? NOOP_STAGE_EMITTER;
  const sharedSingleOptions = {
    stageEmitter,
    __stageBudgets: options.__stageBudgets,
    __testHooks: options.__testHooks
  };

  if (mode === "inline") {
    const singleResult = await svc.validateMixinSingle({
      ...sharedInput,
      source: sourceInput.source,
      ...sharedSingleOptions
    });
    return applyValidateMixinOutputCompaction(buildValidateMixinOutput(mode, [
      {
        source: {
          kind: "inline",
          label: "<inline>"
        },
        result: singleResult
      }
    ]), input);
  }

  if (mode === "path") {
    const resolvedPath = resolveMixinInputPath(sourceInput.path, "path");
    const singleResult = await svc.validateMixinSingle({
      ...sharedInput,
      sourcePath: sourceInput.path,
      ...sharedSingleOptions
    });
    return applyValidateMixinOutputCompaction(buildValidateMixinOutput(mode, [
      {
        source: {
          kind: "path",
          label: resolvedPath,
          path: resolvedPath
        },
        result: singleResult
      }
    ]), input);
  }

  if (mode === "paths") {
    return validateMixinMany(
      svc,
      mode,
      sourceInput.paths.map((path) => ({
        source: {
          kind: "path" as const,
          label: resolveMixinInputPath(path, "path"),
          path: resolveMixinInputPath(path, "path")
        },
        sourcePath: path
      })),
      input,
      [],
      sharedSingleOptions
    );
  }

  const resolvedInput = mode === "project"
    ? await createProjectValidateMixinConfigInput(input)
    : input;
  const { sources: configSources, warnings: configWarnings } = await resolveMixinConfigSources(resolvedInput);
  if (configSources.length === 0) {
    const emptyOutput = buildValidateMixinOutput(mode, []);
    return applyValidateMixinOutputCompaction({
      ...emptyOutput,
      warnings: [...new Set([...emptyOutput.warnings, ...configWarnings])]
    }, input);
  }

  return validateMixinMany(
    svc,
    mode,
    configSources.map((entry) => ({
      source: {
        kind: "config" as const,
        label: entry.sourcePath,
        path: entry.sourcePath,
        configPath: entry.configPath
      },
      sourcePath: entry.sourcePath
    })),
    resolvedInput,
    configWarnings,
    sharedSingleOptions
  );
}

async function createProjectValidateMixinConfigInput(input: ValidateMixinInput): Promise<ValidateMixinInput> {
  if (input.input.mode !== "project") {
    return input;
  }

  const resolvedProjectPath = resolveMixinInputPath(input.input.path, "path");
  const configPaths = (await fastGlob.glob(["**/*.mixins.json"], {
    cwd: resolvedProjectPath,
    absolute: true,
    onlyFiles: true,
    ignore: [...MIXIN_PROJECT_DISCOVERY_IGNORES]
  })).sort((left, right) => left.localeCompare(right));

  if (configPaths.length === 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `No mixin config JSON files were found under project path "${input.input.path}".`,
      details: {
        failedStage: "input-validation",
        nextAction: "Use input.mode='config' with explicit configPaths[], or point input.path at the workspace root that contains *.mixins.json files."
      }
    });
  }

  return {
    ...input,
    projectPath: input.projectPath ?? resolvedProjectPath,
    input: {
      mode: "config",
      configPaths
    }
  };
}

function shouldRetryValidateMixinWithMavenFirst(
  svc: SourceService,
  input: ValidateMixinSingleInput,
  result: MixinValidationResult
): boolean {
  const initialPriority = input.retryState?.initialSourcePriority ?? input.sourcePriority ?? svc.config.mappingSourcePriority;
  if (input.retryState?.attempted || initialPriority !== "loom-first") {
    return false;
  }
  if (result.validationStatus !== "partial") {
    return false;
  }
  // Budget-driven partials are the soft-deadline's final output; retrying
  // under maven-first would re-run the same expensive pipeline.
  if (
    result.summary.degradedReason !== undefined ||
    (result.summary.targetsDeferredBudget ?? 0) > 0
  ) {
    return false;
  }
  if (result.summary.membersSkipped > 0) {
    return true;
  }
  return result.issues.some((issue) =>
    issue.resolutionPath === "source-signature-unavailable" ||
    issue.resolutionPath === "target-mapping-failed" ||
    issue.resolutionPath === "member-remap-failed"
  );
}

function findValidateMixinClassMapping(svc: SourceService, input: {
  version: string;
  className: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority: MappingSourcePriority;
  projectPath?: string;
  batchCaches?: ValidateMixinSingleInput["batchCaches"];
}): Promise<MappingFindMappingOutput> {
  const cache = input.batchCaches?.classMappings;
  if (!cache) {
    return svc.mappingService.findMapping({
      version: input.version,
      kind: "class",
      name: input.className,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath
    });
  }

  const cacheKey = [
    input.version,
    input.className,
    input.sourceMapping,
    input.targetMapping,
    input.sourcePriority,
    input.projectPath ?? ""
  ].join("\0");
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = svc.mappingService.findMapping({
    version: input.version,
    kind: "class",
    name: input.className,
    sourceMapping: input.sourceMapping,
    targetMapping: input.targetMapping,
    sourcePriority: input.sourcePriority,
    projectPath: input.projectPath
  }).catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, pending);
  return pending;
}

export async function validateMixinSingle(svc: SourceService, input: ValidateMixinSingleInput): Promise<MixinValidationResult> {
  // Start at input-validation so path normalization, file reads, and the
  // simple guard checks all land under that stage.
  let currentStage: ValidateMixinStage = "input-validation";
  const stageBudgets = loadMixinStageBudgets(input.__stageBudgets);
  const inputValidationStartedAt = performance.now();
  try {
    const version = input.version.trim();
    const requestedScope = normalizeRequestedArtifactScope(input.scope);
    const currentSourcePriority = input.sourcePriority ?? svc.config.mappingSourcePriority;
    const initialSourcePriority = input.retryState?.initialSourcePriority ?? currentSourcePriority;
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: { failedStage: "input-validation" }
      });
    }

    let source: string;
    if (input.sourcePath) {
      const normalizedSourcePath = normalizePathForHost(input.sourcePath, undefined, "sourcePath");
      const resolvedSourcePath = isAbsolute(normalizedSourcePath)
        ? normalizedSourcePath
        : resolvePath(process.cwd(), normalizedSourcePath);
      try {
        source = await readFile(resolvedSourcePath, "utf-8");
      } catch (err) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message:
            `Could not read sourcePath "${input.sourcePath}" (resolved to "${resolvedSourcePath}"):` +
            ` ${err instanceof Error ? err.message : String(err)}`,
          details: { failedStage: "input-validation" }
        });
      }
    } else {
      source = input.source ?? "";
    }
    if (!source.trim()) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "source must be non-empty.",
        details: { failedStage: "input-validation" }
      });
    }

    const inputElapsed = performance.now() - inputValidationStartedAt;
    if (inputElapsed > stageBudgets.inputValidation) {
      throw createError({
        code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
        message: "Stage input-validation exhausted budget before parse completed.",
        details: {
          failedStage: "input-validation",
          stageBudgetExhausted: true,
          budgetMs: stageBudgets.inputValidation,
          elapsedMs: inputElapsed
        }
      });
    }

    return await runValidateMixinPipeline(svc, {
      input,
      version,
      source,
      requestedScope,
      currentSourcePriority,
      initialSourcePriority,
      stageEmitter: input.stageEmitter ?? NOOP_STAGE_EMITTER,
      stageBudgets,
      testHooks: input.__testHooks,
      onStage: (stage) => { currentStage = stage; }
    });
  } catch (err) {
    throw annotateValidateMixinError(err, currentStage);
  }
}

async function runValidateMixinPipeline(svc: SourceService, ctx: {
  input: ValidateMixinSingleInput;
  version: string;
  source: string;
  requestedScope: ArtifactScope;
  currentSourcePriority: MappingSourcePriority;
  initialSourcePriority: MappingSourcePriority;
  stageEmitter: StageEmitter;
  stageBudgets: MixinStageBudgets;
  testHooks: ValidateMixinOptions["__testHooks"];
  onStage: (stage: ValidateMixinStage) => void;
}): Promise<MixinValidationResult> {
  const {
    input,
    source,
    requestedScope,
    currentSourcePriority,
    initialSourcePriority,
    stageEmitter,
    stageBudgets,
    testHooks,
    onStage
  } = ctx;
  let { version } = ctx;
  const enterStage = async (stage: ValidateMixinStage): Promise<number> => {
    onStage(stage);
    const startedAt = performance.now();
    await stageEmitter(stage);
    return startedAt;
  };
  const checkPreParseBudget = (
    stage: ValidateMixinStage,
    stageStartedAt: number,
    budgetMs: number
  ): void => {
    const elapsed = performance.now() - stageStartedAt;
    if (elapsed > budgetMs) {
      throw createError({
        code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
        message: `Stage ${stage} exhausted budget before parse completed.`,
        details: {
          failedStage: stage,
          stageBudgetExhausted: true,
          budgetMs,
          elapsedMs: elapsed
        }
      });
    }
  };
  const resolveStartedAt = await enterStage("resolve");
  const warnings: string[] = [];
  let mappingAutoDetected = false;

  let detectedMapping: SourceMapping | undefined;
  if ((!input.mapping || input.preferProjectMapping) && input.projectPath) {
    try {
      const detection = await svc.workspaceMappingService.detectCompileMapping({ projectPath: input.projectPath });
      if (detection.resolved && detection.mappingApplied) {
        detectedMapping = detection.mappingApplied;
        mappingAutoDetected = true;
        warnings.push(`Auto-detected mapping '${detectedMapping}' from project configuration.`);
        warnings.push(...detection.warnings);
      } else {
        warnings.push(...detection.warnings);
      }
    } catch {
      // Detection failed — fall through to default
    }
  }

  const requestedMapping = normalizeMapping(detectedMapping ?? input.mapping);
  let mappingApplied: SourceMapping = requestedMapping;

  if (input.preferProjectVersion && input.projectPath) {
    const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
    if (detected && detected !== version) {
      warnings.push(`Overriding version "${version}" with project version "${detected}" from gradle.properties.`);
    }
    version = detected ?? version;
  }

  let jarPath: string;
  let resolvedArtifact: ResolveArtifactOutput | undefined;
  let signatureLookupMapping: SourceMapping = "obfuscated";
  let scopeFallback: { requested: string; applied: string; reason: string } | undefined;
  if (input.scope && input.scope !== "vanilla" && input.projectPath) {
    try {
      resolvedArtifact = await svc.resolveArtifact({
        target: { kind: "version", value: version },
        mapping: requestedMapping,
        sourcePriority: currentSourcePriority,
        projectPath: input.projectPath,
        scope: input.scope,
        preferProjectVersion: false
      });
      jarPath = resolvedArtifact.binaryJarPath ?? (await svc.versionService.resolveVersionJar(version)).jarPath;
      warnings.push(...resolvedArtifact.warnings);
      mappingApplied = resolvedArtifact.mappingApplied;
      signatureLookupMapping = resolvedArtifact.mappingApplied;
      if (resolvedArtifact.version) {
        version = resolvedArtifact.version;
      }
    } catch (scopeErr) {
      scopeFallback = {
        requested: input.scope,
        applied: "vanilla",
        reason: `Loom cache unavailable: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`
      };
      warnings.push(`Scope "${input.scope}" resolution failed; falling back to vanilla. ${scopeFallback.reason}`);
      jarPath = (await svc.versionService.resolveVersionJar(version)).jarPath;
    }
  } else {
    jarPath = (await svc.versionService.resolveVersionJar(version)).jarPath;
  }

  if (jarPath.includes("-sources.jar")) {
    warnings.push(`Resolved jar appears to be a sources jar. Falling back to vanilla client jar.`);
    jarPath = (await svc.versionService.resolveVersionJar(version)).jarPath;
    signatureLookupMapping = "obfuscated";
    scopeFallback = {
      requested: input.scope ?? "vanilla",
      applied: "vanilla",
      reason: "Resolved jar was a sources jar, not a binary class jar."
    };
  }

  if (testHooks?.afterResolve) {
    await testHooks.afterResolve();
  }
  checkPreParseBudget("resolve", resolveStartedAt, stageBudgets.resolve);

  const mappingHealthStartedAt = await enterStage("mapping-health");
  let healthReport: MappingHealthReport | undefined;
  try {
    const health = await svc.mappingService.checkMappingHealth({
      version,
      requestedMapping,
      sourcePriority: currentSourcePriority
    });
    const jarAvailable = existsSync(jarPath);
    healthReport = {
      jarAvailable,
      jarPath,
      mojangMappingsAvailable: health.mojangMappingsAvailable,
      tinyMappingsAvailable: health.tinyMappingsAvailable,
      memberRemapAvailable: health.memberRemapAvailable,
      overallHealthy: jarAvailable && health.mojangMappingsAvailable,
      degradations: [
        ...(jarAvailable ? [] : ["Game jar not found."]),
        ...health.degradations
      ]
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    healthReport = {
      jarAvailable: existsSync(jarPath),
      jarPath,
      mojangMappingsAvailable: false,
      tinyMappingsAvailable: false,
      memberRemapAvailable: false,
      overallHealthy: false,
      degradations: [`Mapping health probe failed: ${reason}`]
    };
  }

  if (testHooks?.afterMappingHealth) {
    await testHooks.afterMappingHealth();
  }
  checkPreParseBudget("mapping-health", mappingHealthStartedAt, stageBudgets.mappingHealth);

  const parseStartedAt = await enterStage("parse");
  const parsed = parseMixinSource(source);

  if (testHooks?.afterParse) {
    await testHooks.afterParse();
  }
  checkPreParseBudget("parse", parseStartedAt, stageBudgets.parse);

  const targetLookupStartedAt = await enterStage("target-lookup");
  if (testHooks?.beforeTargetLoop) {
    await testHooks.beforeTargetLoop();
  }
  let degradedReason: "stage-budget" | "stage-budget-pre-target" | undefined;
  const targetOutcomes: MixinTargetOutcome[] = [];
  const deferredTargetClasses = new Set<string>();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailedTargets = new Set<string>();
  const remapFailedMembers = new Map<string, Set<string>>();
  const wholeRemapFailedTargets = new Set<string>();
  const signatureFailedTargets = new Set<string>();
  const symbolExistsButSignatureFailed = new Set<string>();
  const resolutionTrace: MixinValidationProvenance["resolutionTrace"] = input.explain ? [] : undefined;

  const totalTargets = parsed.targets.length;
  let processedTargetCount = 0;
  let stageBudgetExhausted = false;
  let nextTargetIndex = 0;
  for (let targetIndex = 0; targetIndex < totalTargets; targetIndex++) {
    const stageElapsed = performance.now() - targetLookupStartedAt;
    if (stageElapsed > stageBudgets.targetLookup) {
      stageBudgetExhausted = true;
      nextTargetIndex = targetIndex;
      break;
    }
    const target = parsed.targets[targetIndex];
    await stageEmitter("target-lookup", {
      targetIndex,
      targetTotal: totalTargets,
      targetClass: target.className,
      memberCount:
        parsed.injections.length + parsed.shadows.length + parsed.accessors.length
    });
    const targetStartedAt = performance.now();
    if (testHooks?.beforeTargetIter) {
      await testHooks.beforeTargetIter(targetIndex);
    }
    let resolvedClassName = target.className;
    if (!resolvedClassName.includes(".")) {
      const fqcn = parsed.imports.get(resolvedClassName);
      if (fqcn) {
        resolvedClassName = fqcn;
      }
    } else {
      const segments = resolvedClassName.split(".");
      const firstSegment = segments[0];
      if (firstSegment && /^[A-Z]/.test(firstSegment)) {
        const outerFqcn = parsed.imports.get(firstSegment);
        if (outerFqcn) {
          resolvedClassName = outerFqcn + "$" + segments.slice(1).join("$");
        }
      }
    }

    let obfuscatedName = resolvedClassName;

    if (requestedMapping !== signatureLookupMapping) {
      try {
        const mapped = await findValidateMixinClassMapping(svc, {
          version,
          className: resolvedClassName,
          sourceMapping: requestedMapping,
          targetMapping: signatureLookupMapping,
          sourcePriority: currentSourcePriority,
          projectPath: input.projectPath,
          batchCaches: input.batchCaches
        });
        if (mapped.resolved && mapped.resolvedSymbol) {
          obfuscatedName = mapped.resolvedSymbol.name;
          resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: true });
        } else {
          warnings.push(
            `Could not map class "${resolvedClassName}" from ${requestedMapping} to ${signatureLookupMapping}; using "${obfuscatedName}" for lookup.`
          );
          mappingFailedTargets.add(target.className);
          resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: "No mapping found" });
        }
      } catch (mapErr) {
        warnings.push(
          `Mapping lookup failed for class "${resolvedClassName}" while preparing ${signatureLookupMapping} lookup; using "${obfuscatedName}" for lookup.`
        );
        mappingFailedTargets.add(target.className);
        resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: mapErr instanceof Error ? mapErr.message : String(mapErr) });
      }
    }

    try {
      const sig = await svc.explorerService.getSignature({
        fqn: obfuscatedName,
        jarPath,
        access: "all"
      });
      warnings.push(...sig.warnings);
      resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: `${sig.methods.length} methods, ${sig.fields.length} fields`, success: true });

      let constructors = sig.constructors;
      let methods = sig.methods;
      let fields = sig.fields;

      if (requestedMapping !== signatureLookupMapping) {
        try {
          const [ctorResult, methodResult, fieldResult] = await Promise.all([
            svc.remapSignatureMembers(
              sig.constructors,
              "method",
              version,
              signatureLookupMapping,
              requestedMapping,
              currentSourcePriority,
              warnings,
              input.projectPath
            ),
            svc.remapSignatureMembers(
              sig.methods,
              "method",
              version,
              signatureLookupMapping,
              requestedMapping,
              currentSourcePriority,
              warnings,
              input.projectPath
            ),
            svc.remapSignatureMembers(
              sig.fields,
              "field",
              version,
              signatureLookupMapping,
              requestedMapping,
              currentSourcePriority,
              warnings,
              input.projectPath
            )
          ]);
          constructors = ctorResult.members;
          methods = methodResult.members;
          fields = fieldResult.members;

          const targetFailed = new Set<string>();
          for (const n of ctorResult.failedNames) targetFailed.add(n);
          for (const n of methodResult.failedNames) targetFailed.add(n);
          for (const n of fieldResult.failedNames) targetFailed.add(n);
          if (targetFailed.size > 0) {
            remapFailedMembers.set(target.className, targetFailed);
            resolutionTrace?.push({ target: target.className, step: "remap", input: `${targetFailed.size} members`, output: "failed", success: false });
          } else {
            resolutionTrace?.push({ target: target.className, step: "remap", input: `${methods.length + fields.length} members`, output: "remapped", success: true });
          }
        } catch (remapErr) {
          warnings.push(
            `Member remapping failed for "${resolvedClassName}"; falling back to ${signatureLookupMapping} names. ` +
            `Member names shown may be in the ${signatureLookupMapping} runtime namespace.`
          );
          mappingApplied = signatureLookupMapping;
          wholeRemapFailedTargets.add(target.className);
          resolutionTrace?.push({
            target: target.className,
            step: "remap",
            input: resolvedClassName,
            output: `${signatureLookupMapping} fallback`,
            success: false,
            detail: remapErr instanceof Error ? remapErr.message : String(remapErr)
          });
        }
      }

      targetMembers.set(target.className, {
        className: target.className,
        constructors,
        methods,
        fields
      });
    } catch (sigErr) {
      warnings.push(`Could not load signature for class "${resolvedClassName}" (obfuscated: "${obfuscatedName}").`);
      resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: "CLASS_NOT_FOUND", success: false, detail: sigErr instanceof Error ? sigErr.message : String(sigErr) });

      try {
        const existenceCheck = await svc.mappingService.checkSymbolExists({
          version, kind: "class", name: resolvedClassName,
          sourceMapping: requestedMapping, nameMode: "auto", sourcePriority: currentSourcePriority
        });
        if (existenceCheck.resolved) {
          symbolExistsButSignatureFailed.add(target.className);
          resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "exists in mapping graph", success: true });
        } else {
          resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "not found", success: false });
        }
      } catch {
        signatureFailedTargets.add(target.className);
        resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "check failed", success: false });
      }
    }

    const targetElapsed = performance.now() - targetStartedAt;
    const hadToolIssue =
      mappingFailedTargets.has(target.className) ||
      signatureFailedTargets.has(target.className) ||
      symbolExistsButSignatureFailed.has(target.className) ||
      remapFailedMembers.has(target.className) ||
      wholeRemapFailedTargets.has(target.className);
    const completedOutcome: MixinTargetOutcome = hadToolIssue
      ? {
          targetClass: target.className,
          status: "tool-issue",
          elapsedMs: targetElapsed,
          reason: signatureFailedTargets.has(target.className)
            ? "signature-load-failed"
            : symbolExistsButSignatureFailed.has(target.className)
              ? "signature-load-failed-symbol-exists"
              : mappingFailedTargets.has(target.className)
                ? "mapping-failed"
                : wholeRemapFailedTargets.has(target.className)
                  ? "member-remap-failed-whole"
                  : "member-remap-failed"
        }
      : {
          targetClass: target.className,
          status: "ok",
          elapsedMs: targetElapsed
        };
    if (targetElapsed > stageBudgets.perTarget) {
      completedOutcome.slowTarget = true;
      completedOutcome.budgetMs = stageBudgets.perTarget;
    }
    targetOutcomes.push(completedOutcome);
    processedTargetCount += 1;
  }

  const skippedForValidator = new Set<string>();
  if (stageBudgetExhausted) {
    if (processedTargetCount === 0) {
      degradedReason = "stage-budget-pre-target";
      for (const remaining of parsed.targets) {
        skippedForValidator.add(remaining.className);
      }
    } else {
      degradedReason = "stage-budget";
      for (let j = nextTargetIndex; j < totalTargets; j++) {
        const remaining = parsed.targets[j];
        deferredTargetClasses.add(remaining.className);
        skippedForValidator.add(remaining.className);
        targetOutcomes.push({
          targetClass: remaining.className,
          status: "deferred-budget",
          reason: "stage-budget",
          budgetMs: stageBudgets.targetLookup
        });
      }
    }
  }

  if (healthReport) {
    const hasFailures =
      signatureFailedTargets.size > 0 ||
      mappingFailedTargets.size > 0 ||
      symbolExistsButSignatureFailed.size > 0;
    if (hasFailures && healthReport.overallHealthy) {
      healthReport.overallHealthy = false;
      healthReport.degradations.push(
        `${mappingFailedTargets.size} mapping failure(s), ${signatureFailedTargets.size} signature failure(s), ${symbolExistsButSignatureFailed.size} partial validation target(s).`
      );
    }
  }

  const resolutionNotes: string[] = [];
  if (requestedMapping !== mappingApplied) {
    resolutionNotes.push(
      `Mapping fallback: requested "${requestedMapping}" but applied "${mappingApplied}" due to remapping failure.`
    );
  }
  const appliedScope = inferAppliedArtifactScope({
    requestedScope,
    scopeFallback,
    jarPath,
    resolvedSourceJarPath: resolvedArtifact?.resolvedSourceJarPath
  });
  if (!scopeFallback && requestedScope !== appliedScope) {
    resolutionNotes.push(
      `Scope adjusted during validation: requested "${requestedScope}" but resolved artifact looks like "${appliedScope}".`
    );
  }

  const REMAP_WARNING_RE = /^(?:Could not remap|Remap failed for)\b/;
  const remapFailures = warnings.filter((w) => REMAP_WARNING_RE.test(w)).length;

  let confidence: IssueConfidence = "definite";
  if (requestedMapping !== mappingApplied) {
    confidence = "uncertain";
  } else if (remapFailures > 0) {
    confidence = "likely";
  }

  const mappingChain: string[] = [];
  if (requestedMapping !== signatureLookupMapping) {
    mappingChain.push(`${requestedMapping} → ${signatureLookupMapping}`);
  }
  if (mappingApplied !== signatureLookupMapping) {
    mappingChain.push(`fallback to ${mappingApplied}`);
  }

  const provenance: MixinValidationProvenance = {
    version,
    jarPath,
    requestedMapping,
    mappingApplied,
    requestedScope,
    appliedScope,
    requestedSourcePriority: initialSourcePriority,
    appliedSourcePriority: currentSourcePriority,
    resolutionNotes: resolutionNotes.length > 0 ? resolutionNotes : undefined,
    jarType: scopeToJarType(appliedScope),
    mappingChain: mappingChain.length > 0 ? mappingChain : undefined,
    remapFailures: remapFailures > 0 ? remapFailures : undefined,
    mappingAutoDetected: mappingAutoDetected || undefined,
    scopeFallback,
    resolutionTrace: resolutionTrace && resolutionTrace.length > 0 ? resolutionTrace : undefined
  };

  const baseResult = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, confidence, mappingFailedTargets, input.explain,
    remapFailedMembers, signatureFailedTargets,
    input.explain ? { scope: requestedScope, sourcePriority: currentSourcePriority, projectPath: input.projectPath, mapping: requestedMapping } : undefined,
    input.warningMode,
    healthReport,
    symbolExistsButSignatureFailed.size > 0 ? symbolExistsButSignatureFailed : undefined,
    skippedForValidator.size > 0 ? skippedForValidator : undefined
  );
  if (targetOutcomes.length > 0) {
    baseResult.targetOutcomes = targetOutcomes;
  }
  if (degradedReason !== undefined) {
    baseResult.summary = { ...baseResult.summary, degradedReason };
  }
  if (deferredTargetClasses.size > 0) {
    baseResult.summary = {
      ...baseResult.summary,
      targetsDeferredBudget: deferredTargetClasses.size
    };
  }
  const result = refreshMixinValidationOutcome(baseResult);

  const minSeverity = input.minSeverity ?? "all";
  const hideUncertain = input.hideUncertain ?? false;

  if (minSeverity !== "all" || hideUncertain) {
    const unfilteredSummary = { ...result.summary };
    let filtered = result.issues;

    if (minSeverity === "error") {
      filtered = filtered.filter((i) => i.severity === "error");
    } else if (minSeverity === "warning") {
      filtered = filtered.filter((i) => i.severity === "error" || i.severity === "warning");
    }

    if (hideUncertain) {
      filtered = filtered.filter((i) => i.confidence !== "uncertain");
    }

    const filteredErrors = filtered.filter((i) => i.severity === "error").length;
    const filteredWarnings = filtered.filter((i) => i.severity === "warning").length;
    const filteredDefiniteErrors = filtered.filter((i) => i.severity === "error" && i.confidence !== "uncertain").length;
    const filteredUncertainErrors = filtered.filter((i) => i.severity === "error" && i.confidence === "uncertain").length;
    const filteredResolutionErrors = filtered.filter((i) => i.resolutionPath != null).length;
    const filteredParseWarnings = filtered.filter((i) => i.category === "parse").length;

    result.issues = filtered;
    result.summary = {
      ...result.summary,
      errors: filteredErrors,
      warnings: filteredWarnings,
      definiteErrors: filteredDefiniteErrors,
      uncertainErrors: filteredUncertainErrors,
      resolutionErrors: filteredResolutionErrors,
      parseWarnings: filteredParseWarnings
    };
    result.unfilteredSummary = unfilteredSummary;
  }

  if (input.warningCategoryFilter && input.warningCategoryFilter.length > 0) {
    const allowedCategories = new Set(input.warningCategoryFilter);
    result.issues = result.issues.filter((i) => i.category && allowedCategories.has(i.category));
    if (result.structuredWarnings) {
      result.structuredWarnings = result.structuredWarnings.filter((sw) => sw.category && allowedCategories.has(sw.category));
      if (result.structuredWarnings.length === 0) result.structuredWarnings = undefined;
    }
    const catErrors = result.issues.filter((i) => i.severity === "error").length;
    const catWarnings = result.issues.filter((i) => i.severity === "warning").length;
    const catDefiniteErrors = result.issues.filter((i) => i.severity === "error" && i.confidence !== "uncertain").length;
    result.summary = {
      ...result.summary,
      errors: catErrors,
      warnings: catWarnings,
      definiteErrors: catDefiniteErrors,
      uncertainErrors: result.issues.filter((i) => i.severity === "error" && i.confidence === "uncertain").length,
      resolutionErrors: result.issues.filter((i) => i.resolutionPath != null).length,
      parseWarnings: result.issues.filter((i) => i.category === "parse").length
    };
  }

  if (input.treatInfoAsWarning === false && result.structuredWarnings) {
    result.structuredWarnings = result.structuredWarnings.filter((sw) => sw.severity !== "info");
    if (result.structuredWarnings.length === 0) result.structuredWarnings = undefined;
  }

  if (input.reportMode === "compact") {
    refreshMixinValidationOutcome(result);
    result.resolvedMembers = undefined;
    result.structuredWarnings = undefined;
    result.aggregatedWarnings = undefined;
    result.toolHealth = undefined;
    result.confidenceBreakdown = undefined;
    if (result.provenance) {
      result.provenance.resolutionTrace = undefined;
    }
  } else {
    refreshMixinValidationOutcome(result);
  }

  if (shouldRetryValidateMixinWithMavenFirst(svc, input, result)) {
    const retryWarning =
      `Retrying validate-mixin with sourcePriority="maven-first" after partial validation using "${currentSourcePriority}".`;
    try {
      const retried = await svc.validateMixinSingle({
        ...input,
        source,
        sourcePath: undefined,
        sourcePriority: "maven-first",
        retryState: {
          attempted: true,
          initialSourcePriority
        }
      });
      retried.warnings = [retryWarning, ...retried.warnings];
      if (retried.provenance) {
        retried.provenance.requestedSourcePriority = initialSourcePriority;
        retried.provenance.appliedSourcePriority = "maven-first";
        retried.provenance.resolutionNotes = [
          ...(retried.provenance.resolutionNotes ?? []),
          `Validation retried with sourcePriority "maven-first" after partial result from "${currentSourcePriority}".`
        ];
      }
      return retried;
    } catch (retryErr) {
      result.warnings.unshift(
        `${retryWarning} Retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
      );
      return result;
    }
  }

  return result;
}

function resolveMixinInputPath(rawPath: string, fieldName: string): string {
  const normalizedPath = normalizePathForHost(rawPath, undefined, fieldName);
  return isAbsolute(normalizedPath)
    ? normalizedPath
    : resolvePath(process.cwd(), normalizedPath);
}

async function resolveMixinConfigSources(input: ValidateMixinInput): Promise<ResolvedValidateMixinConfigSources> {
  if (input.input.mode !== "config") {
    return {
      sources: [],
      warnings: []
    };
  }

  const results: ValidateMixinConfigSource[] = [];
  const warnings: string[] = [];

  for (const rawConfigPath of input.input.configPaths) {
    const resolvedConfigPath = resolveMixinInputPath(rawConfigPath, "configPath");
    let configJson: { package?: string; mixins?: string[]; client?: string[]; server?: string[] };
    try {
      const raw = await readFile(resolvedConfigPath, "utf-8");
      configJson = JSON.parse(raw);
    } catch (err) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Could not read/parse mixin config "${rawConfigPath}": ${err instanceof Error ? err.message : String(err)}`,
        details: { failedStage: "input-validation" }
      });
    }

    const pkg = configJson.package ?? "";
    const classNames = [
      ...(configJson.mixins ?? []),
      ...(configJson.client ?? []),
      ...(configJson.server ?? [])
    ];
    if (classNames.length === 0) {
      warnings.push(`Mixin config "${resolvedConfigPath}" contains no mixin class entries.`);
      continue;
    }

    const projectBase = input.projectPath
      ? (isAbsolute(input.projectPath) ? input.projectPath : resolvePath(process.cwd(), input.projectPath))
      : dirname(resolvedConfigPath);

    let sourceRootCandidates: string[];
    if (input.sourceRoots && input.sourceRoots.length > 0) {
      sourceRootCandidates = input.sourceRoots;
    } else {
      const detected: string[] = [];
      for (const candidateRoot of COMMON_SOURCE_ROOTS) {
        let foundInRoot = false;
        for (const className of classNames) {
          const fqcn = pkg ? `${pkg}.${className}` : className;
          const relative = fqcn.replace(/\./g, "/") + ".java";
          if (await pathExists(resolvePath(projectBase, candidateRoot, relative))) {
            foundInRoot = true;
            break;
          }
        }
        if (foundInRoot) {
          detected.push(candidateRoot);
        }
      }
      sourceRootCandidates = detected.length > 0 ? detected : ["src/main/java"];
    }

    for (const cls of classNames) {
      const fqcn = pkg ? `${pkg}.${cls}` : cls;
      const relativePath = fqcn.replace(/\./g, "/") + ".java";
      let sourcePath = resolvePath(projectBase, sourceRootCandidates[0], relativePath);
      for (const root of sourceRootCandidates) {
        const candidate = resolvePath(projectBase, root, relativePath);
        if (await pathExists(candidate)) {
          sourcePath = candidate;
          break;
        }
      }
      results.push({
        sourcePath,
        configPath: resolvedConfigPath
      });
    }
  }

  return {
    sources: results,
    warnings
  };
}

async function validateMixinMany(
  svc: SourceService,
  mode: "paths" | "config" | "project",
  entries: Array<{ source: ValidateMixinResultSource; sourcePath: string }>,
  input: ValidateMixinInput,
  additionalWarnings: string[],
  extras: {
    stageEmitter?: StageEmitter;
    __stageBudgets?: Partial<MixinStageBudgets>;
    __testHooks?: ValidateMixinOptions["__testHooks"];
  } = {}
): Promise<ValidateMixinOutput> {
  const results: ValidateMixinBatchResult[] = [];
  const batchWarningMode = input.warningMode ?? "aggregated";
  const { input: _discardedInput, ...sharedInput } = input;
  const batchCaches = {
    classMappings: new Map<string, Promise<MappingFindMappingOutput>>()
  };
  const stageEmitter = extras.stageEmitter ?? NOOP_STAGE_EMITTER;

  for (const entry of entries) {
    try {
      const singleResult = await svc.validateMixinSingle({
        ...sharedInput,
        sourcePath: entry.sourcePath,
        warningMode: batchWarningMode,
        batchCaches,
        stageEmitter,
        __stageBudgets: extras.__stageBudgets,
        __testHooks: extras.__testHooks
      });
      results.push({
        source: entry.source,
        result: singleResult
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const entryResult: ValidateMixinBatchResult = {
        source: entry.source,
        error: message
      };
      if (isAppError(err)) {
        entryResult.errorCode = err.code;
        if (err.details) {
          entryResult.errorDetails = { ...err.details };
        }
      }
      results.push(entryResult);
    }
  }

  const output = buildValidateMixinOutput(mode, results);
  return applyValidateMixinOutputCompaction({
    ...output,
    warnings: additionalWarnings.length === 0
      ? output.warnings
      : [...new Set([...output.warnings, ...additionalWarnings])]
  }, input);
}

function applyValidateMixinOutputCompaction(
  output: ValidateMixinOutput,
  input: ValidateMixinInput
): ValidateMixinOutput {
  let nextOutput = output;
  const canHoistProvenance = nextOutput.provenance != null;
  const warningCandidates = nextOutput.results
    .map((entry) => entry.result?.warnings)
    .filter((entry): entry is string[] => entry != null);
  const canHoistWarnings = warningCandidates.length === 0
    ? true
    : warningCandidates.every((entry) => sameStringArray(entry, warningCandidates[0]));

  if (input.reportMode === "summary-first") {
    nextOutput = {
      ...nextOutput,
      results: nextOutput.results.map((entry) => (
        entry.result
          ? {
              ...entry,
              result: {
                ...entry.result,
                warnings: canHoistWarnings ? [] : entry.result.warnings,
                structuredWarnings: undefined,
                aggregatedWarnings: undefined,
                resolvedMembers: undefined,
                toolHealth: undefined,
                confidenceBreakdown: undefined,
                provenance: canHoistProvenance ? undefined : entry.result.provenance
              }
            }
          : entry
      ))
    };
  }

  if (input.includeIssues !== false) {
    return nextOutput;
  }

  return {
    ...nextOutput,
    results: nextOutput.results.map((entry) => (
      entry.result
        ? {
            ...entry,
            result: {
              ...entry.result,
              issues: []
            }
          }
        : entry
    ))
  };
}

function buildValidateMixinOutput(
  mode: ValidateMixinOutput["mode"],
  results: ValidateMixinBatchResult[]
): ValidateMixinOutput {
  let valid = 0;
  let partial = 0;
  let invalid = 0;
  let processingErrors = 0;
  let totalValidationErrors = 0;
  let totalValidationWarnings = 0;
  const warningSet = new Set<string>();
  const incompleteReasonSet = new Set<string>();
  const issueGroupMap = new Map<string, { kind: string; confidence: string; category: string; count: number; sampleTargets: string[] }>();

  for (const entry of results) {
    if (!entry.result) {
      processingErrors++;
      continue;
    }

    if (entry.result.valid) {
      valid++;
    } else {
      invalid++;
    }
    if (entry.result.validationStatus === "partial") {
      partial++;
    }

    totalValidationErrors += entry.result.summary.errors;
    totalValidationWarnings += entry.result.summary.warnings;

    for (const warning of entry.result.warnings) {
      warningSet.add(warning);
    }

    for (const issue of entry.result.issues) {
      if (issue.kind === "validation-incomplete") {
        incompleteReasonSet.add(`validation-incomplete: ${issue.message}`);
      }
      const key = `${issue.kind}\0${issue.confidence ?? "unknown"}\0${issue.category ?? "validation"}`;
      const existing = issueGroupMap.get(key);
      if (existing) {
        existing.count++;
        if (existing.sampleTargets.length < 3) {
          existing.sampleTargets.push(issue.target);
        }
      } else {
        issueGroupMap.set(key, {
          kind: issue.kind,
          confidence: issue.confidence ?? "unknown",
          category: issue.category ?? "validation",
          count: 1,
          sampleTargets: [issue.target]
        });
      }
    }
  }

  const issueSummary = issueGroupMap.size > 0 ? [...issueGroupMap.values()] : undefined;
  const provenanceCandidates = results
    .map((entry) => entry.result?.provenance)
    .filter((entry): entry is MixinValidationProvenance => entry != null);
  const provenance = provenanceCandidates.length === 0
    ? undefined
    : provenanceCandidates.every((entry) => sameMixinValidationProvenance(entry, provenanceCandidates[0]))
      ? provenanceCandidates[0]
      : undefined;
  const toolHealth = results.find((entry) => entry.result?.toolHealth)?.result?.toolHealth;
  const confidenceScores = results
    .map((entry) => entry.result?.confidenceScore)
    .filter((score): score is number => score != null);

  return {
    mode,
    results,
    summary: {
      total: results.length,
      valid,
      partial,
      invalid,
      processingErrors,
      totalValidationErrors,
      totalValidationWarnings
    },
    issueSummary,
    provenance,
    incompleteReasons: incompleteReasonSet.size > 0 ? [...incompleteReasonSet] : undefined,
    toolHealth,
    confidenceScore: confidenceScores.length > 0 ? Math.min(...confidenceScores) : undefined,
    warnings: [...warningSet]
  };
}
