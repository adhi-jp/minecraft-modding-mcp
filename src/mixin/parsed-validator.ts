import type { ParsedMixin } from "../mixin-parser.js";
import { buildSuggestedCall } from "../build-suggested-call.js";
import type {
  AggregatedWarningGroup,
  IssueCategory,
  IssueConfidence,
  MappingHealthReport,
  MixinValidationProvenance,
  MixinValidationResult,
  ResolvedMember,
  ResolvedTargetMembers,
  StructuredWarning,
  ValidationIssue,
  ValidationSummary
} from "./types.js";
import {
  TOOL_RESOLUTION_PATHS,
  addSkippedMembers,
  buildQuickSummary,
  classifyStructuredWarning,
  computeConfidenceBreakdown,
  computeValidationStatus,
  summarizeResolvedMembers
} from "./helpers.js";
import {
  validateAccessor,
  validateInjection,
  validateShadow
} from "./annotation-validators.js";

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
  symbolExistsButSignatureFailed?: Set<string>,
  deferredBudgetTargets?: Set<string>
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
      } else if (deferredBudgetTargets?.has(target.className)) {
        // Deferred by stage budget; the targetOutcomes entry already records
        // this, so skip member validation rather than emit a not-found error.
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

    const assignSuggested = (
      issue: ValidationIssue,
      tool: string,
      params: Record<string, unknown>
    ): void => {
      // Result-level suggestions go through the same schema gate as
      // error-side suggestedCall payloads; a payload that does not parse
      // stays unset rather than reaching the agent in broken form.
      const gated = buildSuggestedCall({ tool, params });
      if (gated.suggestedCall) {
        issue.suggestedCall = gated.suggestedCall;
      }
    };

    for (const issue of issues) {
      switch (issue.kind) {
        case "target-not-found":
          issue.explanation = `The class "${issue.target}" was not found in the game jar. It may be misspelled, from a different version, or use a different mapping namespace.`;
          if (version && mapping) {
            assignSuggested(issue, "check-symbol-exists", {
              kind: "class",
              name: issue.target,
              version,
              sourceMapping: mapping,
              nameMode: "auto",
              ...symbolLookupContext
            });
          }
          break;
        case "validation-incomplete":
          issue.explanation = `Target metadata for "${issue.target}" could not be loaded reliably, so validation was only partial. This usually indicates a tool or environment limitation rather than a confirmed code error.`;
          if (version) {
            assignSuggested(issue, "get-class-source", {
              className: issue.target,
              target: { type: "resolve" as const, kind: "version" as const, value: version },
              ...(mapping ? { mapping } : {}),
              mode: "metadata",
              ...classSourceContext
            });
          }
          break;
        case "target-mapping-failed":
          issue.explanation = `Mapping lookup failed for "${issue.target}". The class may exist under a different name in the target namespace.`;
          if (version && mapping) {
            assignSuggested(issue, "check-symbol-exists", {
              kind: "class",
              name: issue.target,
              version,
              sourceMapping: mapping,
              nameMode: "auto",
              ...symbolLookupContext
            });
          }
          break;
        case "method-not-found": {
          const parts = issue.target.split("#");
          const className = parts[0] ?? issue.target;
          issue.explanation = `The method was not found in the target class. It may be named differently in the current mapping, or might not exist in this version.`;
          if (version) {
            assignSuggested(issue, "get-class-source", {
              className,
              target: { type: "resolve" as const, kind: "version" as const, value: version },
              ...(mapping ? { mapping } : {}),
              mode: "metadata",
              ...classSourceContext
            });
          }
          break;
        }
        case "field-not-found": {
          const parts = issue.target.split("#");
          const ownerName = parts[0] ?? issue.target;
          const fieldName = parts[1] ?? issue.target;
          issue.explanation = `The field "${fieldName}" was not found in the target class. Verify the field name matches the expected mapping namespace.`;
          if (version && mapping) {
            assignSuggested(issue, "check-symbol-exists", {
              kind: "field",
              owner: ownerName,
              name: fieldName,
              version,
              sourceMapping: mapping,
              ...symbolLookupContext
            });
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
  const quickSummary = buildQuickSummary(validationStatus, summary, { provenance, healthReport });

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
