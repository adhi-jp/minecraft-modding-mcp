import type { ParsedAccessor, ParsedInjection, ParsedShadow } from "../mixin-parser.js";
import type {
  IssueConfidence,
  MappingHealthReport,
  ResolutionPath,
  ResolvedMember,
  ResolvedTargetMembers,
  ValidationIssue
} from "./types.js";
import {
  allFieldNames,
  allMethodNames,
  computeFalsePositiveRisk,
  extractMethodDescriptor,
  extractMethodName,
  suggestSimilar
} from "./helpers.js";

// Mixin regex target selector: "/pattern/" or "owner=/…/ name=/…/ desc=/…/".
const REGEX_SELECTOR_RE = /^(?:(?:owner|name|desc)\s*=\s*)?\//;
// Trailing target-selector quantifier. For the brace form, group 1 is the minimum,
// group 2 the comma (open or explicit maximum) and group 3 the maximum.
const QUANTIFIER_RE = /(?:\*|\+|\{(\d*)(?:(,)(\d*))?\})$/;

/**
 * Confidence, resolution path and degraded flag for a member name that is missing from a
 * target: a failed member remap or unavailable signature means the miss may be a tooling
 * artifact rather than a true missing member.
 */
function notFoundDegradation(
  targetName: string,
  memberName: string,
  confidence: IssueConfidence | undefined,
  confidenceReason: string | undefined,
  remapFailedMembers: Map<string, Set<string>> | undefined,
  signatureFailedTargets: Set<string> | undefined,
  healthReport: MappingHealthReport | undefined
): {
  issueConfidence: IssueConfidence | undefined;
  issueConfidenceReason: string | undefined;
  resolutionPath: ResolutionPath | undefined;
  memberDegraded: boolean | undefined;
} {
  const isRemapFailed = remapFailedMembers?.get(targetName)?.has(memberName);
  const isSigFailed = signatureFailedTargets?.has(targetName);
  return {
    issueConfidence: isRemapFailed ? "uncertain" : confidence,
    issueConfidenceReason: isRemapFailed
      ? `Member remap from obfuscated→mapping failed; name mismatch may be a remap artifact, not a true missing member.`
      : confidenceReason,
    resolutionPath: isRemapFailed
      ? "member-remap-failed"
      : isSigFailed ? "source-signature-unavailable" : undefined,
    memberDegraded: isRemapFailed && healthReport?.memberRemapAvailable === false
  };
}

export function validateInjection(
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
    if (REGEX_SELECTOR_RE.test(inj.method.trim())) {
      // Regex selectors ("/pattern/", "name=/pattern/ desc=/pattern/") match by pattern,
      // which the name lookup below cannot evaluate; unverifiable.
      resolvedMembers.push({
        annotation: `@${inj.annotation}`,
        name: inj.method,
        line: inj.line,
        status: "skipped"
      });
      continue;
    }
    // Mixin strips all whitespace from a selector before parsing it ("tick{1, 3}").
    const selector = inj.method.replace(/\s+/g, "");
    // Strip owner prefix and JVM descriptor from the method reference
    const rawMethodName = extractMethodName(selector);
    // Strip a trailing target-selector quantifier (e.g. "tick*", "tick+", "tick{2,3}").
    // As in Mixin, the quantifier only bounds how many members the EXACT name (and
    // descriptor, when given) must match; it never turns the name into a prefix glob.
    const quantifierMatch = QUANTIFIER_RE.exec(rawMethodName);
    const quantifier = quantifierMatch?.[0];
    const methodName = quantifier
      ? rawMethodName.slice(0, rawMethodName.length - quantifier.length)
      : rawMethodName;
    let minMatches = quantifier === "+" ? 1 : 0;
    if (quantifierMatch && quantifier !== "*" && quantifier !== "+") {
      minMatches = quantifierMatch[1] ? Number.parseInt(quantifierMatch[1], 10) : 0;
      const maxMatches = quantifierMatch[2] === undefined
        ? minMatches
        : quantifierMatch[3]
          ? Number.parseInt(quantifierMatch[3], 10)
          : Number.POSITIVE_INFINITY;
      // Mixin clamps a max below the min up to the min ("{3,1}" acts as "{3}"), so only a
      // quantifier whose clamped max is 0 ("{}", "{0}") allows no match; Mixin rejects it.
      if (Math.max(minMatches, maxMatches) === 0) {
        issues.push({
          severity: "warning",
          kind: "method-not-found",
          annotation: `@${inj.annotation}`,
          target: `${targetName}#${inj.method}`,
          message: `Selector "${rawMethodName}" has a malformed quantifier "${quantifier}" (it allows no match); Mixin rejects it.`,
          line: inj.line,
          confidence: "likely"
        });
        resolvedMembers.push({
          annotation: `@${inj.annotation}`,
          name: rawMethodName,
          line: inj.line,
          status: "not-found"
        });
        continue;
      }
    }
    const anyName = quantifier !== undefined && methodName === "";
    if (anyName && minMatches === 0 && !extractMethodDescriptor(selector)) {
      // A bare "*" matches any method, or none at all; there is nothing to check.
      resolvedMembers.push({
        annotation: `@${inj.annotation}`,
        name: rawMethodName,
        line: inj.line,
        status: "skipped"
      });
      continue;
    }
    // An empty name with a quantifier ("*(I)V", "+", "{2}") matches any method name; its
    // descriptor and count still apply below.
    const matched = anyName || methodNames.includes(methodName);
    if (!matched) {
      const suggestions = suggestSimilar(methodName, methodNames);
      const descriptor = extractMethodDescriptor(selector);
      const descriptorHint = descriptor ? ` (descriptor: ${descriptor})` : "";

      // Determine if this is a remap artifact or signature unavailability
      const { issueConfidence, issueConfidenceReason, resolutionPath, memberDegraded } = notFoundDegradation(
        targetName,
        methodName,
        confidence,
        confidenceReason,
        remapFailedMembers,
        signatureFailedTargets,
        healthReport
      );

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
      // Name matched. If the reference carries a JVM descriptor, require an
      // overload to match it; otherwise a wrong-signature target (e.g. tick(D)V
      // when only tick(I)V exists) is silently reported as resolved.
      const refDescriptor = extractMethodDescriptor(selector);
      const sameNameMembers = anyName
        ? members.methods
        : [...members.constructors, ...members.methods].filter((member) => member.name === methodName);
      const displayName = anyName ? rawMethodName : methodName;
      const matchCount = refDescriptor
        ? sameNameMembers.filter((member) => member.jvmDescriptor === refDescriptor).length
        : sameNameMembers.length;
      const isRemapFailed = remapFailedMembers?.get(targetName)?.has(methodName);
      const isSigFailed = signatureFailedTargets?.has(targetName);
      // Only a healthy mapping lets us trust that the user-written descriptor (and the
      // overload count) is byte-equal to the runtime one; otherwise downgrade to a warning.
      const mappingDegraded =
        Boolean(isRemapFailed) || Boolean(isSigFailed) || healthReport?.overallHealthy === false;
      const resolutionPath: ResolutionPath | undefined = isRemapFailed
        ? "member-remap-failed"
        : isSigFailed
          ? "source-signature-unavailable"
          : undefined;
      const issueConfidence: IssueConfidence = mappingDegraded
        ? "uncertain"
        : confidence ?? "definite";
      if (refDescriptor && matchCount === 0 && (anyName || sameNameMembers.length > 0)) {
        const available = anyName
          ? []
          : [...new Set(sameNameMembers.map((member) => member.jvmDescriptor))];
        issues.push({
          severity: mappingDegraded ? "warning" : "error",
          kind: "descriptor-mismatch",
          annotation: `@${inj.annotation}`,
          target: `${targetName}#${inj.method}`,
          message: `${anyName
            ? `No method in "${targetName}" matches descriptor ${refDescriptor}.`
            : `Method "${methodName}" exists in "${targetName}" but no overload matches descriptor ${refDescriptor} (available: ${available.join(", ")}).`}${mappingDegraded ? " (mapping degraded; may be a remap artifact)" : ""}`,
          suggestions: available.length > 0 ? available : undefined,
          line: inj.line,
          confidence: issueConfidence,
          confidenceReason: mappingDegraded
            ? `Member remap/signature degraded; descriptor mismatch may be a tooling artifact, not a true signature error.`
            : confidenceReason,
          resolutionPath,
          falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
        });
        resolvedMembers.push({
          annotation: `@${inj.annotation}`,
          name: displayName,
          line: inj.line,
          status: "not-found"
        });
      } else if (matchCount < minMatches) {
        // "+" and "{n}"/"{n,}"/"{n,m}" demand at least n matching members. A shortfall stays
        // uncertain: if a remap ran, a member whose name could not be remapped may not be counted.
        issues.push({
          severity: "warning",
          kind: "method-not-found",
          annotation: `@${inj.annotation}`,
          target: `${targetName}#${inj.method}`,
          message: `Selector "${rawMethodName}" requires at least ${minMatches} matching method(s)${anyName ? "" : ` named "${methodName}"`} in target class "${targetName}" but found ${matchCount}.${mappingDegraded ? " (mapping degraded; may be a remap artifact)" : ""}`,
          line: inj.line,
          confidence: "uncertain",
          confidenceReason: mappingDegraded
            ? `Member remap/signature degraded; the overload count may be a tooling artifact.`
            : `Counted from the listed members; a member whose name could not be remapped, if any, is not counted.`,
          resolutionPath,
          falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, "uncertain")
        });
        resolvedMembers.push({
          annotation: `@${inj.annotation}`,
          name: displayName,
          line: inj.line,
          status: "not-found"
        });
      } else {
        resolvedMembers.push({
          annotation: `@${inj.annotation}`,
          name: displayName,
          line: inj.line,
          resolvedTo: `${targetName}#${displayName}`,
          status: "resolved"
        });
      }
    }
  }
}

export function validateShadow(
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
  // A @Shadow method declared as `<prefix>name` refers to `name` in the target; a
  // @Shadow field's targetName is its declared name unchanged, since fields are not
  // prefixed. `aliases` adds fallback names. Messages keep the declared name so they
  // stay recognisable in the mixin source.
  const effectiveName = shadow.targetName ?? shadow.name;
  const candidateNames = [effectiveName, ...(shadow.aliases ?? [])];
  const prefixHint = effectiveName !== shadow.name
    ? ` (resolved to "${effectiveName}" after @Shadow prefix removal)`
    : "";

  for (const targetName of targetNames) {
    const members = targetMembers.get(targetName);
    if (!members) continue;

    const isField = shadow.kind === "field";
    const memberNames = isField ? allFieldNames(members) : allMethodNames(members);
    const matchedName = candidateNames.find((candidate) => memberNames.includes(candidate));
    if (matchedName === undefined) {
      const { issueConfidence, issueConfidenceReason, resolutionPath, memberDegraded } = notFoundDegradation(
        targetName,
        effectiveName,
        confidence,
        confidenceReason,
        remapFailedMembers,
        signatureFailedTargets,
        healthReport
      );
      const suggestions = suggestSimilar(effectiveName, memberNames);
      issues.push({
        severity: memberDegraded ? "warning" : "error",
        kind: isField ? "field-not-found" : "method-not-found",
        annotation: "@Shadow",
        target: `${targetName}#${effectiveName}`,
        message: `${isField ? "Field" : "Method"} "${shadow.name}" not found in target class "${targetName}" (${memberNames.length} ${isField ? "field(s)" : "method(s)"} available).${prefixHint}${memberDegraded ? " (infrastructure degraded; may be false positive)" : ""}`,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        line: shadow.line,
        confidence: issueConfidence,
        confidenceReason: issueConfidenceReason,
        resolutionPath,
        falsePositiveRisk: computeFalsePositiveRisk(healthReport, resolutionPath, issueConfidence)
      });
      resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, status: "not-found" });
    } else {
      resolvedMembers.push({ annotation: "@Shadow", name: shadow.name, line: shadow.line, resolvedTo: `${targetName}#${matchedName}`, status: "resolved" });
    }
  }
}

export function validateAccessor(
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
      const { issueConfidence, issueConfidenceReason, resolutionPath, memberDegraded } = notFoundDegradation(
        targetName,
        accessor.targetName,
        confidence,
        confidenceReason,
        remapFailedMembers,
        signatureFailedTargets,
        healthReport
      );

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
