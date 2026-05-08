import { performance } from "node:perf_hooks";

import { buildSuggestedCall } from "../../build-suggested-call.js";
import { ERROR_CODES, createError } from "../../errors.js";
import type { ParsedMixin } from "../../mixin-parser.js";
import type {
  MappingHealthReport,
  MixinValidationProvenance,
  MixinStageBudgets,
  ResolvedTargetMembers,
  TargetOutcome as MixinTargetOutcome
} from "../../mixin-validator.js";
import type {
  ResolveArtifactOutput,
  ValidateMixinOptions
} from "../../source-service.js";
import type { StageEmitter } from "../../stage-emitter.js";
import type {
  ArtifactScope,
  MappingSourcePriority,
  SourceMapping
} from "../../types.js";
import type { ValidateMixinSingleInput } from "../validate-mixin.js";

/**
 * Diagnostic tag attached to every AppError thrown out of validate-mixin.
 * - "input-validation": required field missing or sourcePath unreadable
 * - "resolve": jar / artifact resolution
 * - "mapping-health": mapping infrastructure probe
 * - "parse": parseMixinSource failure
 * - "target-lookup": per-target symbol/signature/remap loop
 */
export type ValidateMixinStage =
  | "input-validation"
  | "resolve"
  | "mapping-health"
  | "parse"
  | "target-lookup";

export type MixinPipelineScopeFallback = {
  requested: string;
  applied: string;
  reason: string;
};

export interface MutableMixinPipelineContext {
  readonly input: ValidateMixinSingleInput;
  readonly source: string;
  readonly requestedScope: ArtifactScope;
  readonly currentSourcePriority: MappingSourcePriority;
  readonly initialSourcePriority: MappingSourcePriority;
  readonly stageEmitter: StageEmitter;
  readonly stageBudgets: MixinStageBudgets;
  readonly testHooks: ValidateMixinOptions["__testHooks"];
  readonly onStage: (stage: ValidateMixinStage) => void;

  warnings: string[];

  // Populated by the resolve stage.
  version: string;
  mappingAutoDetected: boolean;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  jarPath: string;
  resolvedArtifact?: ResolveArtifactOutput;
  signatureLookupMapping: SourceMapping;
  scopeFallback?: MixinPipelineScopeFallback;

  // Populated by the mapping-health stage.
  healthReport?: MappingHealthReport;

  // Populated by the parse stage.
  parsed: ParsedMixin;

  // Mutated by the target-lookup stage.
  targetOutcomes: MixinTargetOutcome[];
  degradedReason?: "stage-budget" | "stage-budget-pre-target";
  deferredTargetClasses: Set<string>;
  targetMembers: Map<string, ResolvedTargetMembers>;
  mappingFailedTargets: Set<string>;
  remapFailedMembers: Map<string, Set<string>>;
  wholeRemapFailedTargets: Set<string>;
  signatureFailedTargets: Set<string>;
  symbolExistsButSignatureFailed: Set<string>;
  resolutionTrace?: NonNullable<MixinValidationProvenance["resolutionTrace"]>;
  processedTargetCount: number;
  stageBudgetExhausted: boolean;
  nextTargetIndex: number;
  skippedForValidator: Set<string>;

  enterStage(stage: ValidateMixinStage): Promise<number>;
  checkPreParseBudget(stage: ValidateMixinStage, startedAt: number, budgetMs: number): void;
}

export type MixinPipelineSeed = {
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
};

const EMPTY_PARSED: ParsedMixin = {
  className: "",
  targets: [],
  imports: new Map(),
  injections: [],
  shadows: [],
  accessors: [],
  parseWarnings: []
};

export function createMixinPipelineContext(seed: MixinPipelineSeed): MutableMixinPipelineContext {
  const ctx: MutableMixinPipelineContext = {
    input: seed.input,
    source: seed.source,
    requestedScope: seed.requestedScope,
    currentSourcePriority: seed.currentSourcePriority,
    initialSourcePriority: seed.initialSourcePriority,
    stageEmitter: seed.stageEmitter,
    stageBudgets: seed.stageBudgets,
    testHooks: seed.testHooks,
    onStage: seed.onStage,

    warnings: [],

    version: seed.version,
    mappingAutoDetected: false,
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    jarPath: "",
    resolvedArtifact: undefined,
    signatureLookupMapping: "obfuscated",
    scopeFallback: undefined,

    healthReport: undefined,

    parsed: EMPTY_PARSED,

    targetOutcomes: [],
    degradedReason: undefined,
    deferredTargetClasses: new Set(),
    targetMembers: new Map(),
    mappingFailedTargets: new Set(),
    remapFailedMembers: new Map(),
    wholeRemapFailedTargets: new Set(),
    signatureFailedTargets: new Set(),
    symbolExistsButSignatureFailed: new Set(),
    resolutionTrace: seed.input.explain ? [] : undefined,
    processedTargetCount: 0,
    stageBudgetExhausted: false,
    nextTargetIndex: 0,
    skippedForValidator: new Set(),

    enterStage: async (stage) => {
      ctx.onStage(stage);
      const startedAt = performance.now();
      await ctx.stageEmitter(stage);
      return startedAt;
    },
    checkPreParseBudget: (stage, stageStartedAt, budgetMs) => {
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
    }
  };

  return ctx;
}

export function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
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
