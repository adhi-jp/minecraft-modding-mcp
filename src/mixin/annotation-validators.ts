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
      // Name matched. If the reference carries a JVM descriptor, require an
      // overload to match it; otherwise a wrong-signature target (e.g. tick(D)V
      // when only tick(I)V exists) is silently reported as resolved.
      const refDescriptor = extractMethodDescriptor(inj.method);
      const sameNameMembers = [...members.constructors, ...members.methods].filter(
        (member) => member.name === methodName
      );
      if (
        refDescriptor &&
        sameNameMembers.length > 0 &&
        !sameNameMembers.some((member) => member.jvmDescriptor === refDescriptor)
      ) {
        const available = [...new Set(sameNameMembers.map((member) => member.jvmDescriptor))];
        const isRemapFailed = remapFailedMembers?.get(targetName)?.has(methodName);
        const isSigFailed = signatureFailedTargets?.has(targetName);
        // Only a healthy mapping lets us trust that the user-written descriptor is
        // byte-equal to the runtime descriptor; otherwise downgrade to a warning.
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
        issues.push({
          severity: mappingDegraded ? "warning" : "error",
          kind: "descriptor-mismatch",
          annotation: `@${inj.annotation}`,
          target: `${targetName}#${inj.method}`,
          message: `Method "${methodName}" exists in "${targetName}" but no overload matches descriptor ${refDescriptor} (available: ${available.join(", ")}).${mappingDegraded ? " (mapping degraded; may be a remap artifact)" : ""}`,
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
