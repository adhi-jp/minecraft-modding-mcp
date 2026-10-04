/**
 * Public barrel for the mixin validation engine. The implementation lives
 * under `src/mixin/`; this file preserves the historical entry point used
 * by source-service, top-level workflow tools, and tests.
 */

export type {
  AccessTransformerValidationResult,
  AccessWidenerValidationResult,
  IssueCategory,
  IssueConfidence,
  MappingHealthReport,
  MixinStageBudgets,
  MixinValidationProvenance,
  MixinValidationResult,
  ResolutionPath,
  ResolvedTargetMembers,
  TargetOutcome,
  ValidationSummary
} from "./mixin/types.js";

export { loadMixinStageBudgets } from "./mixin/types.js";

export {
  extractMethodDescriptor,
  extractMethodName,
  levenshteinDistance,
  refreshMixinValidationOutcome,
  suggestSimilar
} from "./mixin/helpers.js";

export { validateParsedMixin } from "./mixin/parsed-validator.js";

export {
  validateParsedAccessTransformer,
  validateParsedAccessWidener
} from "./mixin/access-validators.js";
