/**
 * Helper functions for the mixin validation engine. Pure / behavior-preserving;
 * extracted from `src/mixin-validator.ts` so the validators stay focused on
 * orchestration. The validators in `mixin-validator.ts` re-export these for
 * backward compatibility with existing importers.
 */

import type { ParsedMixin } from "../mixin-parser.js";
import type {
  ConfidenceBreakdown,
  ConfidencePenalty,
  IssueConfidence,
  MappingHealthReport,
  MixinValidationProvenance,
  MixinValidationResult,
  ResolutionPath,
  ResolvedMember,
  ResolvedTargetMembers,
  StructuredWarning,
  ValidationStatus,
  ValidationSummary
} from "./types.js";

export const TOOL_RESOLUTION_PATHS: ResolutionPath[] = [
  "target-mapping-failed",
  "member-remap-failed",
  "source-signature-unavailable"
];

const MAPPING_WARNING_RE = /(?:mapping|remap|fallback|could not map)/i;
const CONFIG_WARNING_RE = /(?:version|gradle|jar\b|properties|project)/i;
const PARSE_WARNING_RE = /(?:could not parse|parse\s+warning|missing method attribute)/i;

export function classifyStructuredWarning(message: string): StructuredWarning {
  return {
    severity: MAPPING_WARNING_RE.test(message) ? "warning" : PARSE_WARNING_RE.test(message) ? "warning" : "info",
    message,
    category: MAPPING_WARNING_RE.test(message)
      ? "mapping"
      : PARSE_WARNING_RE.test(message)
        ? "parse"
        : CONFIG_WARNING_RE.test(message)
          ? "configuration"
          : "validation"
  };
}

/* ------------------------------------------------------------------ */
/*  Levenshtein distance                                               */
/* ------------------------------------------------------------------ */

export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Single-row DP
  const prev = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    let diagPrev = prev[0];
    prev[0] = i;
    for (let j = 1; j <= lb; j++) {
      const temp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diagPrev;
      } else {
        prev[j] = 1 + Math.min(diagPrev, prev[j - 1], prev[j]);
      }
      diagPrev = temp;
    }
  }
  return prev[lb];
}

export function suggestSimilar(name: string, candidates: string[], maxDistance = 3, maxResults = 3): string[] {
  const normalizedName = name.toLowerCase();
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    if (Math.abs(normalizedName.length - normalizedCandidate.length) > maxDistance) {
      continue;
    }
    const distance = levenshteinDistance(normalizedName, normalizedCandidate);
    if (distance <= maxDistance && distance > 0) {
      scored.push({ candidate, distance });
    }
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, maxResults).map((s) => s.candidate);
}

/* ------------------------------------------------------------------ */
/*  Method reference helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Strip owner prefix (`Lowner;`) and JVM descriptor (`(...)V`) from a
 * Mixin method reference, returning just the method name.
 *
 * Examples:
 *   "playerTouch(Lnet/minecraft/world/entity/player/Player;)V" → "playerTouch"
 *   "Lnet/minecraft/SomeClass;tick(I)V"                        → "tick"
 *   "<init>"                                                    → "<init>"
 *   "<init>()V"                                                 → "<init>"
 *   "tick"                                                      → "tick"
 */
function stripOwnerPrefix(ref: string): string {
  if (!ref.startsWith("L")) return ref;
  const ownerEnd = ref.indexOf(";");
  if (ownerEnd === -1) return ref;
  const parenIdx = ref.indexOf("(");
  // Owner prefixes appear before the descriptor, e.g. Lpkg/Class;method(I)V.
  // If ';' appears inside the descriptor, this is not an owner prefix.
  if (parenIdx !== -1 && ownerEnd > parenIdx) return ref;
  return ref.substring(ownerEnd + 1);
}

export function extractMethodName(ref: string): string {
  let s = stripOwnerPrefix(ref);
  // Remove descriptor: everything from '(' onwards
  const parenIdx = s.indexOf("(");
  if (parenIdx !== -1) {
    s = s.substring(0, parenIdx);
  }
  return s;
}

/**
 * Extract the JVM descriptor portion from a method reference, if present.
 *
 * Examples:
 *   "playerTouch(Lnet/minecraft/world/entity/player/Player;)V" → "(Lnet/minecraft/world/entity/player/Player;)V"
 *   "tick"                                                      → undefined
 */
export function extractMethodDescriptor(ref: string): string | undefined {
  // After stripping optional owner prefix, find '('
  const s = stripOwnerPrefix(ref);
  const parenIdx = s.indexOf("(");
  if (parenIdx !== -1) {
    return s.substring(parenIdx);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Member-set helpers                                                 */
/* ------------------------------------------------------------------ */

export function allMethodNames(members: ResolvedTargetMembers): string[] {
  return [
    ...members.constructors.map((m) => m.name),
    ...members.methods.map((m) => m.name)
  ];
}

export function allFieldNames(members: ResolvedTargetMembers): string[] {
  return members.fields.map((m) => m.name);
}

export function accessLevelFromFlags(
  accessFlags: number | undefined
): "public" | "protected" | "private" | "package-private" | undefined {
  if (accessFlags == null) {
    return undefined;
  }
  if ((accessFlags & 0x0001) !== 0) {
    return "public";
  }
  if ((accessFlags & 0x0004) !== 0) {
    return "protected";
  }
  if ((accessFlags & 0x0002) !== 0) {
    return "private";
  }
  return "package-private";
}

/* ------------------------------------------------------------------ */
/*  Confidence / risk scoring                                          */
/* ------------------------------------------------------------------ */

export function computeFalsePositiveRisk(
  healthReport: MappingHealthReport | undefined,
  resolutionPath: ResolutionPath | undefined,
  issueConfidence: IssueConfidence | undefined
): "high" | "medium" | "low" | undefined {
  if (!healthReport) return undefined;

  if (healthReport.overallHealthy === false) {
    if (
      resolutionPath === "source-signature-unavailable" ||
      resolutionPath === "target-mapping-failed" ||
      resolutionPath === "member-remap-failed"
    ) return "high";
    if (issueConfidence === "uncertain") return "medium";
    return "medium";
  }

  if (healthReport.memberRemapAvailable === false) {
    if (resolutionPath === "member-remap-failed") return "high";
    if (issueConfidence === "uncertain") return "medium";
  }

  return undefined;
}

export function computeConfidenceBreakdown(
  healthReport: MappingHealthReport | undefined,
  provenance: MixinValidationProvenance | undefined,
  remapFailureCount: number,
  skippedMemberCount: number
): ConfidenceBreakdown {
  const baseScore = 100;
  const penalties: ConfidencePenalty[] = [];
  let score = baseScore;
  if (healthReport) {
    if (!healthReport.overallHealthy) {
      penalties.push({ reason: "mapping-health", points: 30 });
      score -= 30;
    }
    if (!healthReport.tinyMappingsAvailable) {
      penalties.push({ reason: "tiny-mappings-unavailable", points: 20 });
      score -= 20;
    }
    if (!healthReport.memberRemapAvailable) {
      penalties.push({ reason: "member-remap-unavailable", points: 15 });
      score -= 15;
    }
  }
  if (provenance?.scopeFallback) {
    penalties.push({ reason: "scope-fallback", points: 10 });
    score -= 10;
  }
  if (provenance && provenance.requestedMapping !== provenance.mappingApplied) {
    penalties.push({ reason: "mapping-mismatch", points: 15 });
    score -= 15;
  }
  if (skippedMemberCount > 0) {
    penalties.push({ reason: "members-skipped", points: 25 });
    score -= 25;
  }
  const remapPenalty = Math.min(remapFailureCount * 2, 20);
  if (remapPenalty > 0) {
    penalties.push({ reason: "remap-failures", points: remapPenalty });
    score -= remapPenalty;
  }
  return {
    baseScore,
    score: Math.max(score, 0),
    penalties
  };
}

/* ------------------------------------------------------------------ */
/*  Resolved-member summarisation                                      */
/* ------------------------------------------------------------------ */

export function summarizeResolvedMembers(resolvedMembers: ResolvedMember[]): Pick<
  ValidationSummary,
  "membersValidated" | "membersSkipped" | "membersMissing"
> {
  return {
    membersValidated: resolvedMembers.filter((member) => member.status === "resolved").length,
    membersSkipped: resolvedMembers.filter((member) => member.status === "skipped").length,
    membersMissing: resolvedMembers.filter((member) => member.status === "not-found").length
  };
}

export function computeValidationStatus(
  summary: ValidationSummary
): ValidationStatus {
  if (summary.errors > 0 || summary.definiteErrors > 0) {
    return "invalid";
  }
  if (
    summary.warnings > 0 ||
    summary.membersSkipped > 0 ||
    (summary.targetsDeferredBudget ?? 0) > 0 ||
    summary.degradedReason !== undefined
  ) {
    return "partial";
  }
  return "full";
}

export function buildQuickSummary(
  status: ValidationStatus,
  summary: ValidationSummary,
  context?: {
    provenance?: MixinValidationProvenance;
    healthReport?: MappingHealthReport;
  }
): string {
  const base = status === "full"
    ? `${summary.membersValidated} member(s) validated successfully.`
    : `${summary.definiteErrors} error(s), ${summary.uncertainErrors} uncertain, ${summary.warnings} warning(s). ${summary.membersValidated} validated, ${summary.membersSkipped} member(s) skipped, ${summary.membersMissing} member(s) missing.`;

  const notes: string[] = [];
  const scopeFallback = context?.provenance?.scopeFallback;
  if (scopeFallback) {
    notes.push(
      `Scope fell back from "${scopeFallback.requested}" to "${scopeFallback.applied}" (${scopeFallback.reason}).`
    );
  }
  const healthReport = context?.healthReport;
  if (healthReport && !healthReport.overallHealthy) {
    const degradations = healthReport.degradations.length > 0
      ? healthReport.degradations.join("; ")
      : "mapping infrastructure degraded";
    notes.push(`Mapping health degraded: ${degradations}.`);
  }
  if (summary.degradedReason === "stage-budget-pre-target") {
    notes.push("Budget exhausted before any target processed — increase budget or split mixinConfigPath.");
  } else if ((summary.targetsDeferredBudget ?? 0) > 0) {
    notes.push(
      `${summary.targetsDeferredBudget} target(s) deferred by stage budget — narrow mixinConfigPath or split the run.`
    );
  }

  return notes.length > 0 ? `${base} ${notes.join(" ")}` : base;
}

export function addSkippedMembers(parsed: ParsedMixin, resolvedMembers: ResolvedMember[]): void {
  for (const inj of parsed.injections) {
    resolvedMembers.push({
      annotation: `@${inj.annotation}`,
      name: extractMethodName(inj.method),
      line: inj.line,
      status: "skipped"
    });
  }

  for (const shadow of parsed.shadows) {
    resolvedMembers.push({
      annotation: "@Shadow",
      name: shadow.name,
      line: shadow.line,
      status: "skipped"
    });
  }

  for (const accessor of parsed.accessors) {
    resolvedMembers.push({
      annotation: `@${accessor.annotation}`,
      name: accessor.targetName,
      line: accessor.line,
      status: "skipped"
    });
  }
}

export function refreshMixinValidationOutcome(result: MixinValidationResult): MixinValidationResult {
  const memberSummary = result.resolvedMembers
    ? summarizeResolvedMembers(result.resolvedMembers)
    : {
        membersValidated: result.summary.membersValidated,
        membersSkipped: result.summary.membersSkipped,
        membersMissing: result.summary.membersMissing
      };
  // Preserve budget signals across refresh; otherwise pre-target partial
  // paths regress to "full" on a second recompute.
  const preservedBudget = {
    targetsDeferredBudget: result.summary.targetsDeferredBudget,
    degradedReason: result.summary.degradedReason
  };
  result.summary = {
    ...result.summary,
    ...memberSummary,
    ...(preservedBudget.targetsDeferredBudget !== undefined
      ? { targetsDeferredBudget: preservedBudget.targetsDeferredBudget }
      : {}),
    ...(preservedBudget.degradedReason !== undefined
      ? { degradedReason: preservedBudget.degradedReason }
      : {})
  };
  result.validationStatus = computeValidationStatus(result.summary);
  result.valid = result.summary.definiteErrors === 0;
  result.quickSummary = buildQuickSummary(result.validationStatus, result.summary, {
    provenance: result.provenance,
    healthReport: result.toolHealth
  });
  return result;
}
