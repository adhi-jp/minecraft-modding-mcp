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

export type IssueConfidence = "definite" | "likely" | "uncertain";

export type ResolutionPath =
  | "member-remap-failed"
  | "target-mapping-failed"
  | "target-class-missing"
  | "source-signature-unavailable";

export type ValidationIssue = {
  severity: "error" | "warning";
  kind:
    | "target-not-found"
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
};

export type ValidationSummary = {
  injections: number;
  shadows: number;
  accessors: number;
  total: number;
  errors: number;
  warnings: number;
  definiteErrors: number;
  uncertainErrors: number;
  resolutionErrors: number;
};

export type MixinValidationProvenance = {
  version: string;
  jarPath: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  resolutionNotes?: string[];
  jarType?: "vanilla-client" | "merged" | "unknown";
  mappingChain?: string[];
  remapFailures?: number;
  mappingAutoDetected?: boolean;
  scopeFallback?: { requested: string; applied: string; reason: string };
};

export type IssueCategory = "mapping" | "configuration" | "validation" | "resolution";

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
  status: "resolved" | "not-found";
};

export type AggregatedWarningGroup = {
  category: IssueCategory;
  count: number;
  samples: string[];
};

export type MixinValidationResult = {
  className: string;
  targets: string[];
  priority?: number;
  valid: boolean;
  issues: ValidationIssue[];
  summary: ValidationSummary;
  unfilteredSummary?: ValidationSummary;
  provenance?: MixinValidationProvenance;
  warnings: string[];
  structuredWarnings?: StructuredWarning[];
  aggregatedWarnings?: AggregatedWarningGroup[];
  resolvedMembers?: ResolvedMember[];
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
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of candidates) {
    const distance = levenshteinDistance(name.toLowerCase(), candidate.toLowerCase());
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

function validateInjection(
  inj: ParsedInjection,
  targetMembers: Map<string, ResolvedTargetMembers>,
  targetNames: string[],
  issues: ValidationIssue[],
  resolvedMembers: ResolvedMember[],
  confidence?: IssueConfidence,
  confidenceReason?: string,
  remapFailedMembers?: Map<string, Set<string>>,
  signatureFailedTargets?: Set<string>
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
        ? `Member remap from official→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
        : confidenceReason;
      const resolutionPath: ResolutionPath | undefined = isRemapFailed
        ? "member-remap-failed"
        : isSigFailed ? "source-signature-unavailable" : undefined;

      issues.push({
        severity: "error",
        kind: "method-not-found",
        annotation: `@${inj.annotation}`,
        target: `${targetName}#${inj.method}`,
        message: `Method "${methodName}" not found in target class "${targetName}".${descriptorHint}`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        line: inj.line,
        confidence: issueConfidence,
        confidenceReason: issueConfidenceReason,
        resolutionPath
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
  signatureFailedTargets?: Set<string>
): void {
  for (const targetName of targetNames) {
    const members = targetMembers.get(targetName);
    if (!members) continue;

    const isRemapFailed = remapFailedMembers?.get(targetName)?.has(shadow.name);
    const isSigFailed = signatureFailedTargets?.has(targetName);
    const issueConfidence = isRemapFailed ? "uncertain" as IssueConfidence : confidence;
    const issueConfidenceReason = isRemapFailed
      ? `Member remap from official→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
      : confidenceReason;
    const resolutionPath: ResolutionPath | undefined = isRemapFailed
      ? "member-remap-failed"
      : isSigFailed ? "source-signature-unavailable" : undefined;

    if (shadow.kind === "field") {
      const fieldNames = allFieldNames(members);
      if (!fieldNames.includes(shadow.name)) {
        const suggestions = suggestSimilar(shadow.name, fieldNames);
        issues.push({
          severity: "error",
          kind: "field-not-found",
          annotation: "@Shadow",
          target: `${targetName}#${shadow.name}`,
          message: `Field "${shadow.name}" not found in target class "${targetName}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          line: shadow.line,
          confidence: issueConfidence,
          confidenceReason: issueConfidenceReason,
          resolutionPath
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
          severity: "error",
          kind: "method-not-found",
          annotation: "@Shadow",
          target: `${targetName}#${shadow.name}`,
          message: `Method "${shadow.name}" not found in target class "${targetName}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          line: shadow.line,
          confidence: issueConfidence,
          confidenceReason: issueConfidenceReason,
          resolutionPath
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
  signatureFailedTargets?: Set<string>
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
        ? `Member remap from official→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
        : confidenceReason;
      const resolutionPath: ResolutionPath | undefined = isRemapFailed
        ? "member-remap-failed"
        : isSigFailed ? "source-signature-unavailable" : undefined;

      const suggestions = suggestSimilar(accessor.targetName, candidateNames);
      issues.push({
        severity: "error",
        kind: accessor.annotation === "Invoker" ? "method-not-found" : "field-not-found",
        annotation: `@${accessor.annotation}`,
        target: `${targetName}#${accessor.targetName}`,
        message: `Target "${accessor.targetName}" (inferred from "${accessor.name}") not found in class "${targetName}".`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        line: accessor.line,
        confidence: issueConfidence,
        confidenceReason: issueConfidenceReason,
        resolutionPath
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
  warningMode?: "full" | "aggregated"
): MixinValidationResult {
  const issues: ValidationIssue[] = [];
  const targetNames = parsed.targets.map((t) => t.className);

  const confidenceReason = confidence === "uncertain"
    ? `Mapping fallback: requested "${provenance?.requestedMapping}" but applied "${provenance?.mappingApplied}".`
    : confidence === "likely"
      ? "Some members could not be remapped."
      : undefined;

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
          message: `Could not map target class "${target.className}" to official namespace; class may still exist under a different mapping.`,
          confidence: "uncertain",
          confidenceReason: `Mapping from "${provenance?.requestedMapping}" to official failed for this class.`,
          category: "mapping",
          resolutionPath: "target-mapping-failed"
        });
      } else if (signatureFailedTargets?.has(target.className)) {
        issues.push({
          severity: "error",
          kind: "target-not-found",
          annotation: "@Mixin",
          target: target.className,
          message: `Target class "${target.className}" not found in game jar.`,
          confidence,
          confidenceReason,
          category: "resolution",
          resolutionPath: "source-signature-unavailable"
        });
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
  const resolvedMembers: ResolvedMember[] = [];

  for (const inj of parsed.injections) {
    validateInjection(inj, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets);
  }

  for (const shadow of parsed.shadows) {
    validateShadow(shadow, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets);
  }

  for (const accessor of parsed.accessors) {
    validateAccessor(accessor, targetMembers, resolvedTargetNames, issues, resolvedMembers, confidence, confidenceReason, remapFailedMembers, signatureFailedTargets);
  }

  // Add parse warnings — escalate @Accessor/@Invoker parse failures to issues
  for (const pw of parsed.parseWarnings) {
    if (/@Accessor\b/.test(pw) || /@Invoker\b/.test(pw)) {
      issues.push({
        severity: "warning",
        kind: "unknown-annotation",
        annotation: pw.includes("@Accessor") ? "@Accessor" : "@Invoker",
        target: parsed.className,
        message: pw,
        confidence,
        confidenceReason
      });
    } else {
      warnings.push(pw);
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const definiteErrors = issues.filter((i) => i.severity === "error" && i.confidence !== "uncertain").length;
  const uncertainErrors = issues.filter((i) => i.severity === "error" && i.confidence === "uncertain").length;
  const resolutionErrors = issues.filter((i) => i.resolutionPath != null).length;

  // Assign category to member validation issues that don't have one yet
  for (const issue of issues) {
    if (!issue.category) {
      issue.category = issue.resolutionPath ? "resolution" : "validation";
    }
  }

  // Enrich issues with explanations and suggested calls when explain=true
  if (explain) {
    const version = provenance?.version;
    const mapping = provenance?.requestedMapping;
    // Build context fields to spread into suggestedCall params
    const ctx: Record<string, unknown> = {};
    if (suggestedCallContext?.scope) ctx.scope = suggestedCallContext.scope;
    if (suggestedCallContext?.sourcePriority) ctx.sourcePriority = suggestedCallContext.sourcePriority;
    if (suggestedCallContext?.projectPath) ctx.projectPath = suggestedCallContext.projectPath;
    if (suggestedCallContext?.mapping) ctx.mapping = suggestedCallContext.mapping;

    for (const issue of issues) {
      switch (issue.kind) {
        case "target-not-found":
          issue.explanation = `The class "${issue.target}" was not found in the game jar. It may be misspelled, from a different version, or use a different mapping namespace.`;
          if (version && mapping) {
            issue.suggestedCall = {
              tool: "check-symbol-exists",
              params: { kind: "class", name: issue.target, version, sourceMapping: mapping, nameMode: "auto", ...ctx }
            };
          }
          break;
        case "target-mapping-failed":
          issue.explanation = `Mapping lookup failed for "${issue.target}". The class may exist under a different name in the target namespace.`;
          if (version && mapping) {
            issue.suggestedCall = {
              tool: "check-symbol-exists",
              params: { kind: "class", name: issue.target, version, sourceMapping: mapping, nameMode: "auto", ...ctx }
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
              params: { className, targetKind: "version" as const, targetValue: version, ...(mapping ? { mapping } : {}), mode: "metadata", ...ctx }
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
              params: { kind: "field", owner: ownerName, name: fieldName, version, sourceMapping: mapping, ...ctx }
            };
          }
          break;
        }
      }
    }
  }

  // Build structuredWarnings — classify by severity and category
  const MAPPING_WARNING_RE = /(?:mapping|remap|fallback|could not map)/i;
  const CONFIG_WARNING_RE = /(?:version|gradle|jar\b|properties|project)/i;
  const structuredWarnings: StructuredWarning[] = warnings.map((msg) => ({
    severity: MAPPING_WARNING_RE.test(msg) ? "warning" as const : "info" as const,
    message: msg,
    category: MAPPING_WARNING_RE.test(msg) ? "mapping" as IssueCategory : CONFIG_WARNING_RE.test(msg) ? "configuration" as IssueCategory : "validation" as IssueCategory
  }));

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

  return {
    className: parsed.className,
    targets: targetNames,
    priority: parsed.priority,
    valid: definiteErrors === 0,
    issues,
    summary: {
      injections: parsed.injections.length,
      shadows: parsed.shadows.length,
      accessors: parsed.accessors.length,
      total: parsed.injections.length + parsed.shadows.length + parsed.accessors.length,
      errors: errorCount,
      warnings: warningCount,
      definiteErrors,
      uncertainErrors,
      resolutionErrors
    },
    provenance,
    warnings: outputWarnings,
    structuredWarnings: outputStructuredWarnings,
    aggregatedWarnings,
    resolvedMembers: resolvedMembers.length > 0 ? resolvedMembers : undefined
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
