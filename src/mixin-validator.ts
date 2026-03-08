/**
 * Validation engine for parsed Mixin sources and Access Widener files.
 * Compares parsed annotations against resolved Minecraft bytecode signatures.
 */

import type { SignatureMember } from "./minecraft-explorer-service.js";
import type { ParsedMixin, ParsedInjection, ParsedShadow, ParsedAccessor } from "./mixin-parser.js";
import type { ParsedAccessWidener, AccessWidenerEntry } from "./access-widener-parser.js";
import type { SourceMapping } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
};

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

export type IssueCategory = "mapping" | "configuration" | "validation" | "resolution" | "parse";

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
};

export type ResolvedTargetMembers = {
  className: string;
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
    }
  >;
  summary: { total: number; valid: number; invalid: number };
  warnings: string[];
};

const TOOL_RESOLUTION_PATHS: ResolutionPath[] = [
  "target-mapping-failed",
  "member-remap-failed",
  "source-signature-unavailable"
];
const MAPPING_WARNING_RE = /(?:mapping|remap|fallback|could not map)/i;
const CONFIG_WARNING_RE = /(?:version|gradle|jar\b|properties|project)/i;
const PARSE_WARNING_RE = /(?:could not parse|parse\s+warning|missing method attribute)/i;

function classifyStructuredWarning(message: string): StructuredWarning {
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
/*  Mixin validation                                                   */
/* ------------------------------------------------------------------ */

function allMethodNames(members: ResolvedTargetMembers): string[] {
  return [
    ...members.constructors.map((m) => m.name),
    ...members.methods.map((m) => m.name)
  ];
}

function allFieldNames(members: ResolvedTargetMembers): string[] {
  return members.fields.map((m) => m.name);
}

function computeFalsePositiveRisk(
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

function computeConfidenceBreakdown(
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

function summarizeResolvedMembers(resolvedMembers: ResolvedMember[]): Pick<
  ValidationSummary,
  "membersValidated" | "membersSkipped" | "membersMissing"
> {
  return {
    membersValidated: resolvedMembers.filter((member) => member.status === "resolved").length,
    membersSkipped: resolvedMembers.filter((member) => member.status === "skipped").length,
    membersMissing: resolvedMembers.filter((member) => member.status === "not-found").length
  };
}

function computeValidationStatus(
  summary: ValidationSummary
): ValidationStatus {
  if (summary.errors > 0 || summary.definiteErrors > 0) {
    return "invalid";
  }
  if (summary.warnings > 0 || summary.membersSkipped > 0) {
    return "partial";
  }
  return "full";
}

function buildQuickSummary(
  status: ValidationStatus,
  summary: ValidationSummary
): string {
  if (status === "full") {
    return `${summary.membersValidated} member(s) validated successfully.`;
  }
  return `${summary.definiteErrors} error(s), ${summary.uncertainErrors} uncertain, ${summary.warnings} warning(s). ${summary.membersValidated} validated, ${summary.membersSkipped} member(s) skipped, ${summary.membersMissing} member(s) missing.`;
}

function addSkippedMembers(parsed: ParsedMixin, resolvedMembers: ResolvedMember[]): void {
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
  result.summary = {
    ...result.summary,
    ...memberSummary
  };
  result.validationStatus = computeValidationStatus(result.summary);
  result.valid = result.summary.definiteErrors === 0;
  result.quickSummary = buildQuickSummary(result.validationStatus, result.summary);
  return result;
}

function validateInjection(
  inj: ParsedInjection,
  targetMembers: Map<string, ResolvedTargetMembers>,
  targetNames: string[],
  issues: ValidationIssue[],
  resolvedMembers: ResolvedMember[],
  confidence?: IssueConfidence,
  confidenceReason?: string,
  remapFailedMembers?: Map<string, Set<string>>,
  signatureFailedTargets?: Set<string>,
  healthReport?: MappingHealthReport
): void {
  for (const targetName of targetNames) {
    const members = targetMembers.get(targetName);
    if (!members) continue;

    const methodNames = allMethodNames(members);
    // Strip owner prefix and JVM descriptor from the method reference
    const methodName = extractMethodName(inj.method);
    if (!methodNames.includes(methodName)) {
      const suggestions = suggestSimilar(methodName, methodNames);
      const descriptor = extractMethodDescriptor(inj.method);
      const descriptorHint = descriptor ? ` (descriptor: ${descriptor})` : "";

      // Determine if this is a remap artifact or signature unavailability
      const isRemapFailed = remapFailedMembers?.get(targetName)?.has(methodName);
      const isSigFailed = signatureFailedTargets?.has(targetName);
      const issueConfidence = isRemapFailed ? "uncertain" as IssueConfidence : confidence;
      const issueConfidenceReason = isRemapFailed
        ? `Member remap from obfuscated→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
        : confidenceReason;
      const resolutionPath: ResolutionPath | undefined = isRemapFailed
        ? "member-remap-failed"
        : isSigFailed ? "source-signature-unavailable" : undefined;
      const memberDegraded = isRemapFailed && healthReport?.memberRemapAvailable === false;

      issues.push({
        severity: memberDegraded ? "warning" : "error",
        kind: "method-not-found",
        annotation: `@${inj.annotation}`,
        target: `${targetName}#${inj.method}`,
        message: `Method "${methodName}" not found in target class "${targetName}".${descriptorHint}${memberDegraded ? " (infrastructure degraded; may be false positive)" : ""}`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        line: inj.line,
        confidence: issueConfidence,
        confidenceReason: issueConfidenceReason,
        resolutionPath,
        falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
      });
      resolvedMembers.push({
        annotation: `@${inj.annotation}`,
        name: methodName,
        line: inj.line,
        status: "not-found"
      });
    } else {
      resolvedMembers.push({
        annotation: `@${inj.annotation}`,
        name: methodName,
        line: inj.line,
        resolvedTo: `${targetName}#${methodName}`,
        status: "resolved"
      });
    }
  }
}

function validateShadow(
  shadow: ParsedShadow,
  targetMembers: Map<string, ResolvedTargetMembers>,
  targetNames: string[],
  issues: ValidationIssue[],
  resolvedMembers: ResolvedMember[],
  confidence?: IssueConfidence,
  confidenceReason?: string,
  remapFailedMembers?: Map<string, Set<string>>,
  signatureFailedTargets?: Set<string>,
  healthReport?: MappingHealthReport
): void {
  for (const targetName of targetNames) {
    const members = targetMembers.get(targetName);
    if (!members) continue;

    const isRemapFailed = remapFailedMembers?.get(targetName)?.has(shadow.name);
    const isSigFailed = signatureFailedTargets?.has(targetName);
    const issueConfidence = isRemapFailed ? "uncertain" as IssueConfidence : confidence;
    const issueConfidenceReason = isRemapFailed
      ? `Member remap from obfuscated→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
      : confidenceReason;
    const resolutionPath: ResolutionPath | undefined = isRemapFailed
      ? "member-remap-failed"
      : isSigFailed ? "source-signature-unavailable" : undefined;
    const memberDegraded = isRemapFailed && healthReport?.memberRemapAvailable === false;

    if (shadow.kind === "field") {
      const fieldNames = allFieldNames(members);
      if (!fieldNames.includes(shadow.name)) {
        const suggestions = suggestSimilar(shadow.name, fieldNames);
        issues.push({
          severity: memberDegraded ? "warning" : "error",
          kind: "field-not-found",
          annotation: "@Shadow",
          target: `${targetName}#${shadow.name}`,
          message: `Field "${shadow.name}" not found in target class "${targetName}" (${fieldNames.length} field(s) available).${memberDegraded ? " (infrastructure degraded; may be false positive)" : ""}`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          line: shadow.line,
          confidence: issueConfidence,
          confidenceReason: issueConfidenceReason,
          resolutionPath,
          falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
        });
        resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, status: "not-found" });
      } else {
        resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, resolvedTo: `${targetName}#${shadow.name}`, status: "resolved" });
      }
    } else {
      const methodNames = allMethodNames(members);
      if (!methodNames.includes(shadow.name)) {
        const suggestions = suggestSimilar(shadow.name, methodNames);
        issues.push({
          severity: memberDegraded ? "warning" : "error",
          kind: "method-not-found",
          annotation: "@Shadow",
          target: `${targetName}#${shadow.name}`,
          message: `Method "${shadow.name}" not found in target class "${targetName}" (${methodNames.length} method(s) available).${memberDegraded ? " (infrastructure degraded; may be false positive)" : ""}`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          line: shadow.line,
          confidence: issueConfidence,
          confidenceReason: issueConfidenceReason,
          resolutionPath,
          falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
        });
        resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, status: "not-found" });
      } else {
        resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, resolvedTo: `${targetName}#${shadow.name}`, status: "resolved" });
      }
    }
  }
}

function validateAccessor(
  accessor: ParsedAccessor,
  targetMembers: Map<string, ResolvedTargetMembers>,
  targetNames: string[],
  issues: ValidationIssue[],
  resolvedMembers: ResolvedMember[],
  confidence?: IssueConfidence,
  confidenceReason?: string,
  remapFailedMembers?: Map<string, Set<string>>,
  signatureFailedTargets?: Set<string>,
  healthReport?: MappingHealthReport
): void {
  for (const targetName of targetNames) {
    const members = targetMembers.get(targetName);
    if (!members) continue;

    const candidateNames = accessor.annotation === "Invoker"
      ? allMethodNames(members)
      : allFieldNames(members);

    if (!candidateNames.includes(accessor.targetName)) {
      const isRemapFailed = remapFailedMembers?.get(targetName)?.has(accessor.targetName);
      const isSigFailed = signatureFailedTargets?.has(targetName);
      const issueConfidence = isRemapFailed ? "uncertain" as IssueConfidence : confidence;
      const issueConfidenceReason = isRemapFailed
        ? `Member remap from obfuscated→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
        : confidenceReason;
      const resolutionPath: ResolutionPath | undefined = isRemapFailed
        ? "member-remap-failed"
        : isSigFailed ? "source-signature-unavailable" : undefined;
      const memberDegraded = isRemapFailed && healthReport?.memberRemapAvailable === false;

      const suggestions = suggestSimilar(accessor.targetName, candidateNames);
      const inferenceHint = accessor.targetName !== accessor.name
        ? ` (inferred "${accessor.targetName}" from "${accessor.name}" via prefix removal)`
        : "";
      issues.push({
        severity: memberDegraded ? "warning" : "error",
        kind: accessor.annotation === "Invoker" ? "method-not-found" : "field-not-found",
        annotation: `@${accessor.annotation}`,
        target: `${targetName}#${accessor.targetName}`,
        message: `Target "${accessor.targetName}" not found in class "${targetName}".${inferenceHint}${memberDegraded ? " (infrastructure degraded; may be false positive)" : ""}`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        line: accessor.line,
        confidence: issueConfidence,
        confidenceReason: issueConfidenceReason,
        resolutionPath,
        falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
      });
      resolvedMembers.push({ annotation: `@${accessor.annotation}`, name: accessor.targetName, line: accessor.line, status: "not-found" });
    } else {
      resolvedMembers.push({ annotation: `@${accessor.annotation}`, name: accessor.targetName, line: accessor.line, resolvedTo: `${targetName}#${accessor.targetName}`, status: "resolved" });
    }
  }
}

export function validateParsedMixin(
  parsed: ParsedMixin,
  targetMembers: Map<string, ResolvedTargetMembers>,
  warnings: string[],
  provenance?: MixinValidationProvenance,
  confidence?: IssueConfidence,
  mappingFailedTargets?: Set<string>,
  explain?: boolean,
  remapFailedMembers?: Map<string, Set<string>>,
  signatureFailedTargets?: Set<string>,
  suggestedCallContext?: { scope?: string; sourcePriority?: string; projectPath?: string; mapping?: string },
  warningMode?: "full" | "aggregated",
  healthReport?: MappingHealthReport,
  symbolExistsButSignatureFailed?: Set<string>
): MixinValidationResult {
  const issues: ValidationIssue[] = [];
  const targetNames = parsed.targets.map((t) => t.className);

  const confidenceReason = confidence === "uncertain"
    ? `Mapping fallback: requested "${provenance?.requestedMapping}" but applied "${provenance?.mappingApplied}".`
    : confidence === "likely"
      ? "Some members could not be remapped."
      : undefined;

  const resolvedMembers: ResolvedMember[] = [];

  // Check target classes exist
  for (const target of parsed.targets) {
    if (!targetMembers.has(target.className)) {
      if (mappingFailedTargets?.has(target.className)) {
        // Mapping failure — report as warning with distinct kind
        issues.push({
          severity: "warning",
          kind: "target-mapping-failed",
          annotation: "@Mixin",
          target: target.className,
          message: `Could not map target class "${target.className}" to obfuscated namespace; class may still exist under a different mapping.`,
          confidence: "uncertain",
          confidenceReason: `Mapping from "${provenance?.requestedMapping}" to obfuscated failed for this class.`,
          category: "mapping",
          resolutionPath: "target-mapping-failed",
          falsePositiveRisk: healthReport?.overallHealthy === false ? "high" : "medium"
        });
      } else if (symbolExistsButSignatureFailed?.has(target.className)) {
        // Symbol exists in mapping graph but getSignature failed — tool limitation, not code issue
        issues.push({
          severity: "warning",
          kind: "validation-incomplete",
          annotation: "@Mixin",
          target: target.className,
          message: `Target class "${target.className}" exists in mapping data but could not be loaded from game jar (tool limitation). Members not validated.`,
          confidence: "uncertain",
          confidenceReason: "Class exists in mapping graph but bytecode signature extraction failed.",
          category: "resolution",
          resolutionPath: "source-signature-unavailable",
          issueOrigin: "tool_issue",
          falsePositiveRisk: "high"
        });
        addSkippedMembers(parsed, resolvedMembers);
      } else if (signatureFailedTargets?.has(target.className)) {
        issues.push({
          severity: "warning",
          kind: "validation-incomplete",
          annotation: "@Mixin",
          target: target.className,
          message: `Target class "${target.className}" could not load enough target metadata for reliable validation. Members were not validated.`,
          confidence: "uncertain",
          confidenceReason: "Target bytecode could not be loaded and fallback existence checks were unavailable.",
          category: "resolution",
          resolutionPath: "source-signature-unavailable",
          issueOrigin: "tool_issue",
          falsePositiveRisk: "high"
        });
        addSkippedMembers(parsed, resolvedMembers);
      } else {
        issues.push({
          severity: "error",
          kind: "target-not-found",
          annotation: "@Mixin",
          target: target.className,
          message: `Target class "${target.className}" not found in game jar.`,
          confidence,
          confidenceReason,
          category: "validation",
          resolutionPath: "target-class-missing"
        });
      }
    }
  }

  // Only validate members against targets that were resolved
  const resolvedTargetNames = targetNames.filter((t) => targetMembers.has(t));

  for (const inj of parsed.injections) {
    validateInjection(inj, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets, healthReport);
  }

  for (const shadow of parsed.shadows) {
    validateShadow(shadow, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets, healthReport);
  }

  for (const accessor of parsed.accessors) {
    validateAccessor(accessor, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets, healthReport);
  }

  // Add parse warnings — escalate @Accessor/@Invoker/@Shadow parse failures to issues
  for (const pw of parsed.parseWarnings) {
    if (/@(Accessor|Invoker|Shadow)\b/.test(pw)) {
      const annotation = pw.includes("@Accessor") ? "@Accessor"
        : pw.includes("@Invoker") ? "@Invoker" : "@Shadow";
      issues.push({
        severity: "warning",
        kind: "unknown-annotation",
        annotation,
        target: parsed.className,
        message: pw,
        confidence: "uncertain",
        confidenceReason: "Parser could not extract member declaration; the annotation may be valid.",
        category: "parse",
        issueOrigin: "parser_limitation",
        falsePositiveRisk: "high"
      });
    } else {
      warnings.push(pw);
    }
  }

  // Contradiction detection: if some same-annotation members resolved OK but parse failed for others, note it
  const resolvedAnnotations = new Set<string>();
  for (const member of resolvedMembers) {
    if (member.status === "resolved") {
      resolvedAnnotations.add(member.annotation);
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  let definiteErrors = 0;
  let uncertainErrors = 0;
  let resolutionErrors = 0;
  let parseWarningCount = 0;
  for (const issue of issues) {
    if (issue.category === "parse" && resolvedAnnotations.has(issue.annotation)) {
      issue.message += " (Note: other members with the same annotation resolved successfully.)";
    }

    if (!issue.category) {
      issue.category = issue.resolutionPath ? "resolution" : "validation";
    }
    if (!issue.issueOrigin) {
      if (issue.category === "parse") {
        issue.issueOrigin = "parser_limitation";
      } else {
        issue.issueOrigin = issue.resolutionPath && TOOL_RESOLUTION_PATHS.includes(issue.resolutionPath)
          ? "tool_issue"
          : "code_issue";
      }
    }

    if (issue.severity === "error") {
      errorCount++;
      if (issue.confidence === "uncertain") {
        uncertainErrors++;
      } else {
        definiteErrors++;
      }
    } else {
      warningCount++;
    }
    if (issue.resolutionPath != null) {
      resolutionErrors++;
    }
    if (issue.category === "parse") {
      parseWarningCount++;
    }
  }

  // Enrich issues with explanations and suggested calls when explain=true
  if (explain) {
    const version = provenance?.version;
    const mapping = provenance?.requestedMapping;
    const symbolLookupContext: Record<string, unknown> = {};
    if (suggestedCallContext?.sourcePriority) {
      symbolLookupContext.sourcePriority = suggestedCallContext.sourcePriority;
    }
    const classSourceContext: Record<string, unknown> = {};
    if (suggestedCallContext?.scope) classSourceContext.scope = suggestedCallContext.scope;
    if (suggestedCallContext?.sourcePriority) classSourceContext.sourcePriority = suggestedCallContext.sourcePriority;
    if (suggestedCallContext?.projectPath) classSourceContext.projectPath = suggestedCallContext.projectPath;
    if (suggestedCallContext?.mapping) classSourceContext.mapping = suggestedCallContext.mapping;

    for (const issue of issues) {
      switch (issue.kind) {
        case "target-not-found":
          issue.explanation = `The class "${issue.target}" was not found in the game jar. It may be misspelled, from a different version, or use a different mapping namespace.`;
          if (version && mapping) {
            issue.suggestedCall = {
              tool: "check-symbol-exists",
              params: { kind: "class", name: issue.target, version, sourceMapping: mapping, nameMode: "auto", ...symbolLookupContext }
            };
          }
          break;
        case "validation-incomplete":
          issue.explanation = `Target metadata for "${issue.target}" could not be loaded reliably, so validation was only partial. This usually indicates a tool or environment limitation rather than a confirmed code error.`;
          if (version) {
            issue.suggestedCall = {
              tool: "get-class-source",
              params: {
                className: issue.target,
                target: { type: "resolve" as const, kind: "version" as const, value: version },
                ...(mapping ? { mapping } : {}),
                mode: "metadata",
                ...classSourceContext
              }
            };
          }
          break;
        case "target-mapping-failed":
          issue.explanation = `Mapping lookup failed for "${issue.target}". The class may exist under a different name in the target namespace.`;
          if (version && mapping) {
            issue.suggestedCall = {
              tool: "check-symbol-exists",
              params: { kind: "class", name: issue.target, version, sourceMapping: mapping, nameMode: "auto", ...symbolLookupContext }
            };
          }
          break;
        case "method-not-found": {
          const parts = issue.target.split("#");
          const className = parts[0] ?? issue.target;
          issue.explanation = `The method was not found in the target class. It may be named differently in the current mapping, or might not exist in this version.`;
          if (version) {
            issue.suggestedCall = {
              tool: "get-class-source",
              params: {
                className,
                target: { type: "resolve" as const, kind: "version" as const, value: version },
                ...(mapping ? { mapping } : {}),
                mode: "metadata",
                ...classSourceContext
              }
            };
          }
          break;
        }
        case "field-not-found": {
          const parts = issue.target.split("#");
          const ownerName = parts[0] ?? issue.target;
          const fieldName = parts[1] ?? issue.target;
          issue.explanation = `The field "${fieldName}" was not found in the target class. Verify the field name matches the expected mapping namespace.`;
          if (version && mapping) {
            issue.suggestedCall = {
              tool: "check-symbol-exists",
              params: { kind: "field", owner: ownerName, name: fieldName, version, sourceMapping: mapping, ...symbolLookupContext }
            };
          }
          break;
        }
      }
    }
  }

  const structuredWarnings: StructuredWarning[] = warnings.map(classifyStructuredWarning);

  // Warning aggregation mode
  let aggregatedWarnings: AggregatedWarningGroup[] | undefined;
  let outputWarnings = warnings;
  let outputStructuredWarnings = structuredWarnings.length > 0 ? structuredWarnings : undefined;

  if (warningMode === "aggregated" && structuredWarnings.length > 0) {
    const groupMap = new Map<IssueCategory, { count: number; samples: string[] }>();
    for (const sw of structuredWarnings) {
      const cat = sw.category ?? "validation";
      const existing = groupMap.get(cat);
      if (existing) {
        existing.count++;
        if (existing.samples.length < 2) {
          existing.samples.push(sw.message);
        }
      } else {
        groupMap.set(cat, { count: 1, samples: [sw.message] });
      }
    }
    aggregatedWarnings = [...groupMap.entries()].map(([category, { count, samples }]) => ({
      category,
      count,
      samples
    }));
    outputWarnings = [];
    outputStructuredWarnings = undefined;
  }

  // Compute confidence score
  const remapFailureCount = provenance?.remapFailures ?? 0;
  const memberSummary = summarizeResolvedMembers(resolvedMembers);
  const confidenceBreakdown = healthReport
    ? computeConfidenceBreakdown(healthReport, provenance, remapFailureCount, memberSummary.membersSkipped)
    : undefined;
  const confidenceScore = confidenceBreakdown?.score;
  const total = parsed.injections.length + parsed.shadows.length + parsed.accessors.length;
  const summary: ValidationSummary = {
    injections: parsed.injections.length,
    shadows: parsed.shadows.length,
    accessors: parsed.accessors.length,
    total,
    ...memberSummary,
    errors: errorCount,
    warnings: warningCount,
    definiteErrors,
    uncertainErrors,
    resolutionErrors,
    parseWarnings: parseWarningCount
  };
  const validationStatus = computeValidationStatus(summary);
  const quickSummary = buildQuickSummary(validationStatus, summary);

  return {
    className: parsed.className,
    targets: targetNames,
    priority: parsed.priority,
    valid: definiteErrors === 0,
    validationStatus,
    issues,
    summary,
    provenance,
    warnings: outputWarnings,
    structuredWarnings: outputStructuredWarnings,
    aggregatedWarnings,
    resolvedMembers: resolvedMembers.length > 0 ? resolvedMembers : undefined,
    toolHealth: healthReport,
    confidenceScore,
    confidenceBreakdown,
    quickSummary
  };
}

/* ------------------------------------------------------------------ */
/*  Access Widener validation                                          */
/* ------------------------------------------------------------------ */

export function validateParsedAccessWidener(
  parsed: ParsedAccessWidener,
  membersByClass: Map<string, ResolvedTargetMembers>,
  warnings: string[]
): AccessWidenerValidationResult {
  warnings.push(...parsed.parseWarnings);

  const validatedEntries: AccessWidenerValidationResult["entries"] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const entry of parsed.entries) {
    const ownerFqn = entry.target.replace(/\//g, ".");

    if (entry.targetKind === "class") {
      if (membersByClass.has(ownerFqn)) {
        validatedEntries.push({ ...entry, valid: true });
        validCount++;
      } else {
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Class "${ownerFqn}" not found in game jar.`
        });
        invalidCount++;
      }
      continue;
    }

    // method or field
    const members = membersByClass.get(ownerFqn);
    if (!members) {
      validatedEntries.push({
        ...entry,
        valid: false,
        issue: `Owner class "${ownerFqn}" not found in game jar.`
      });
      invalidCount++;
      continue;
    }

    if (entry.targetKind === "method") {
      const methodNames = allMethodNames(members);
      const found = members.methods.some(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      ) || members.constructors.some(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      );

      if (found) {
        validatedEntries.push({ ...entry, valid: true });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, methodNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Method "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined
        });
        invalidCount++;
      }
    } else {
      // field
      const fieldNames = allFieldNames(members);
      const found = members.fields.some(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      );

      if (found) {
        validatedEntries.push({ ...entry, valid: true });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, fieldNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Field "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined
        });
        invalidCount++;
      }
    }
  }

  return {
    headerVersion: parsed.headerVersion,
    namespace: parsed.namespace,
    valid: invalidCount === 0,
    entries: validatedEntries,
    summary: {
      total: parsed.entries.length,
      valid: validCount,
      invalid: invalidCount
    },
    warnings
  };
}
