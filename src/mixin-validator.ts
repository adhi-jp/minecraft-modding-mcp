/**
 * Public barrel for the mixin validation engine. The implementation lives
 * under `src/mixin/`; this file preserves the historical entry point used
 * by source-service, entry tools, and tests.
 */

export type {
  AccessTransformerValidationResult,
  AccessWidenerValidationResult,
  AggregatedWarningGroup,
  ConfidenceBreakdown,
  ConfidencePenalty,
  IssueCategory,
  IssueConfidence,
  MappingHealthReport,
  MixinStageBudgets,
  MixinValidationProvenance,
  MixinValidationResult,
  ResolutionPath,
  ResolvedMember,
  ResolvedTargetMembers,
  StructuredWarning,
  TargetOutcome,
  ValidationIssue,
  ValidationStatus,
  ValidationSummary
} from "./mixin/types.js";

export { loadMixinStageBudgets } from "./mixin/types.js";

export {
  accessLevelFromFlags,
  buildQuickSummary,
  computeConfidenceBreakdown,
  computeFalsePositiveRisk,
  computeValidationStatus,
  extractMethodDescriptor,
  extractMethodName,
  levenshteinDistance,
  refreshMixinValidationOutcome,
  suggestSimilar,
  summarizeResolvedMembers
} from "./mixin/helpers.js";

export {
  validateAccessor,
  validateInjection,
  validateShadow
} from "./mixin/annotation-validators.js";

export { validateParsedMixin } from "./mixin/parsed-validator.js";

export {
  validateParsedAccessTransformer,
  validateParsedAccessWidener
} from "./mixin/access-validators.js";
