import type { SignatureMember } from "../minecraft-explorer-service.js";
import type { AccessWidenerEntry } from "../access-widener-parser.js";
import type { AccessTransformerEntry } from "../access-transformer-parser.js";
import type {
  AccessTransformerNamespace,
  RuntimeValidationProvenance,
  SourceMapping
} from "../types.js";

export type MappingHealthReport = {
  jarAvailable: boolean;
  jarPath: string;
  mojangMappingsAvailable: boolean;
  tinyMappingsAvailable: boolean;
  memberRemapAvailable: boolean;
  overallHealthy: boolean;
  degradations: string[];
};

export type IssueConfidence = "definite" | "likely" | "uncertain";
export type ValidationStatus = "full" | "partial" | "invalid";

export type ResolutionPath =
  | "member-remap-failed"
  | "target-mapping-failed"
  | "target-class-missing"
  | "source-signature-unavailable";

export type IssueCategory = "mapping" | "configuration" | "validation" | "resolution" | "parse";

export type ValidationIssue = {
  severity: "error" | "warning";
  kind:
    | "target-not-found"
    | "validation-incomplete"
    | "target-mapping-failed"
    | "method-not-found"
    | "field-not-found"
    | "descriptor-mismatch"
    | "access-mismatch"
    | "unknown-annotation";
  annotation: string;
  target: string;
  message: string;
  suggestions?: string[];
  line?: number;
  confidence?: IssueConfidence;
  confidenceReason?: string;
  category?: IssueCategory;
  resolutionPath?: ResolutionPath;
  explanation?: string;
  suggestedCall?: { tool: string; params: Record<string, unknown> };
  falsePositiveRisk?: "high" | "medium" | "low";
  issueOrigin?: "code_issue" | "tool_issue" | "parser_limitation";
};

export type ValidationSummary = {
  injections: number;
  shadows: number;
  accessors: number;
  total: number;
  membersValidated: number;
  membersSkipped: number;
  membersMissing: number;
  errors: number;
  warnings: number;
  definiteErrors: number;
  uncertainErrors: number;
  resolutionErrors: number;
  parseWarnings: number;
  /** Number of targets deferred because target-lookup stage budget was exhausted mid-loop. */
  targetsDeferredBudget?: number;
  /** Reason this run produced a partial result. Only set when budget caused degradation. */
  degradedReason?: "stage-budget" | "stage-budget-pre-target";
};

export type TargetOutcome = {
  targetClass: string;
  status: "ok" | "deferred-budget" | "tool-issue";
  reason?: string;
  budgetMs?: number;
  elapsedMs?: number;
  /** Per-target soft cap exceeded but the target still completed. */
  slowTarget?: boolean;
};

/**
 * Per-stage soft-deadline budgets (ms) for validate-mixin. Each stage uses
 * an independent timer; budgets do not accumulate across stages. `perTarget`
 * is an observability cap — it flags `slowTarget: true` on completed targets
 * but never aborts an in-flight one.
 */
export type MixinStageBudgets = {
  inputValidation: number;
  resolve: number;
  mappingHealth: number;
  parse: number;
  targetLookup: number;
  perTarget: number;
};

const DEFAULT_MIXIN_STAGE_BUDGETS: MixinStageBudgets = {
  inputValidation: 5_000,
  resolve: 15_000,
  mappingHealth: 10_000,
  parse: 10_000,
  targetLookup: 60_000,
  perTarget: 8_000
};

const INFINITE_MIXIN_STAGE_BUDGETS: MixinStageBudgets = {
  inputValidation: Number.POSITIVE_INFINITY,
  resolve: Number.POSITIVE_INFINITY,
  mappingHealth: Number.POSITIVE_INFINITY,
  parse: Number.POSITIVE_INFINITY,
  targetLookup: Number.POSITIVE_INFINITY,
  perTarget: Number.POSITIVE_INFINITY
};

/**
 * Load the stage-budget table. `MIXIN_STAGE_BUDGETS_OFF=1` overrides
 * everything to `Number.POSITIVE_INFINITY`; otherwise `override` patches
 * specific stages on top of the defaults.
 */
export function loadMixinStageBudgets(
  override?: Partial<MixinStageBudgets>
): MixinStageBudgets {
  if (process.env.MIXIN_STAGE_BUDGETS_OFF === "1") {
    return { ...INFINITE_MIXIN_STAGE_BUDGETS };
  }
  return { ...DEFAULT_MIXIN_STAGE_BUDGETS, ...(override ?? {}) };
}

export type MixinValidationProvenance = {
  version: string;
  jarPath: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  requestedScope?: "vanilla" | "merged" | "loader";
  appliedScope?: "vanilla" | "merged" | "loader";
  requestedSourcePriority?: "loom-first" | "maven-first";
  appliedSourcePriority?: "loom-first" | "maven-first";
  resolutionNotes?: string[];
  jarType?: "vanilla-client" | "merged" | "loader" | "unknown";
  mappingChain?: string[];
  remapFailures?: number;
  mappingAutoDetected?: boolean;
  scopeFallback?: { requested: string; applied: string; reason: string };
  resolutionTrace?: Array<{
    target: string;
    step: "mapping" | "signature" | "remap" | "fallback-check";
    input: string;
    output: string;
    success: boolean;
    detail?: string;
  }>;
};

export type StructuredWarning = {
  severity: "info" | "warning";
  message: string;
  category?: IssueCategory;
};

export type ResolvedMember = {
  annotation: string;
  name: string;
  line?: number;
  resolvedTo?: string;
  status: "resolved" | "not-found" | "skipped";
};

export type AggregatedWarningGroup = {
  category: IssueCategory;
  count: number;
  samples: string[];
};

export type ConfidencePenalty = {
  reason: string;
  points: number;
};

export type ConfidenceBreakdown = {
  baseScore: number;
  score: number;
  penalties: ConfidencePenalty[];
};

export type MixinValidationResult = {
  className: string;
  targets: string[];
  priority?: number;
  /** Legacy coarse pass/fail flag. Prefer validationStatus for the primary outcome. */
  valid: boolean;
  /** full = fully validated, partial = tool-limited/incomplete, invalid = definite validation errors. */
  validationStatus: ValidationStatus;
  issues: ValidationIssue[];
  summary: ValidationSummary;
  unfilteredSummary?: ValidationSummary;
  provenance?: MixinValidationProvenance;
  warnings: string[];
  structuredWarnings?: StructuredWarning[];
  aggregatedWarnings?: AggregatedWarningGroup[];
  resolvedMembers?: ResolvedMember[];
  toolHealth?: MappingHealthReport;
  confidenceScore?: number;
  confidenceBreakdown?: ConfidenceBreakdown;
  quickSummary?: string;
  targetOutcomes?: TargetOutcome[];
};

export type ResolvedTargetMembers = {
  className: string;
  classAccessFlags?: number;
  constructors: SignatureMember[];
  methods: SignatureMember[];
  fields: SignatureMember[];
};

export type AccessWidenerValidationResult = {
  headerVersion: string;
  namespace: string;
  valid: boolean;
  entries: Array<
    AccessWidenerEntry & {
      valid: boolean;
      issue?: string;
      suggestions?: string[];
      resolvedInRuntime?: boolean;
      resolvedRuntimeAccess?: "public" | "protected" | "private" | "package-private";
      resolvedRuntimeJvmDescriptor?: string;
      resolvedRuntimeJavaSignature?: string;
    }
  >;
  summary: { total: number; valid: number; invalid: number };
  provenance?: RuntimeValidationProvenance<SourceMapping>;
  warnings: string[];
};

export type AccessTransformerValidationResult = {
  valid: boolean;
  entries: Array<
    AccessTransformerEntry & {
      valid: boolean;
      issue?: string;
      suggestions?: string[];
      resolvedInRuntime?: boolean;
      resolvedRuntimeAccess?: "public" | "protected" | "private" | "package-private";
      resolvedRuntimeJvmDescriptor?: string;
      resolvedRuntimeJavaSignature?: string;
    }
  >;
  summary: { total: number; valid: number; invalid: number };
  provenance?: RuntimeValidationProvenance<AccessTransformerNamespace>;
  warnings: string[];
};
