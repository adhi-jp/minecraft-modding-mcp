import type { ParsedAccessTransformer } from "../access-transformer-parser.js";
import type { ParsedAccessWidener } from "../access-widener-parser.js";
import type {
  AccessTransformerValidationResult,
  AccessWidenerValidationResult,
  ResolvedTargetMembers
} from "./types.js";
import {
  accessLevelFromFlags,
  allFieldNames,
  allMethodNames,
  suggestSimilar
} from "./helpers.js";

export function validateParsedAccessWidener(
  parsed: ParsedAccessWidener,
  membersByClass: Map<string, ResolvedTargetMembers>,
  warnings: string[],
  options?: { includeRuntimeEvidence?: boolean }
): AccessWidenerValidationResult {
  warnings.push(...parsed.parseWarnings);

  const validatedEntries: AccessWidenerValidationResult["entries"] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const entry of parsed.entries) {
    const ownerFqn = entry.target.replace(/\//g, ".");

    if (entry.targetKind === "class") {
      const members = membersByClass.get(ownerFqn);
      if (members) {
        const runtimeAccess = accessLevelFromFlags(members.classAccessFlags);
        validatedEntries.push({
          ...entry,
          valid: true,
          ...(options?.includeRuntimeEvidence
            ? {
                resolvedInRuntime: true,
                ...(runtimeAccess
                  ? { resolvedRuntimeAccess: runtimeAccess }
                  : {})
              }
            : {})
        });
        validCount++;
      } else {
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Class "${ownerFqn}" not found in game jar.`,
          ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
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
        issue: `Owner class "${ownerFqn}" not found in game jar.`,
        ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
      });
      invalidCount++;
      continue;
    }

    if (entry.targetKind === "method") {
      const methodNames = allMethodNames(members);
      const matchedMember = members.methods.find(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      ) ?? members.constructors.find(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      );
      const found = matchedMember != null;

      if (found) {
        const runtimeMember = matchedMember;
        const runtimeAccess = accessLevelFromFlags(runtimeMember.accessFlags);
        validatedEntries.push({
          ...entry,
          valid: true,
          ...(options?.includeRuntimeEvidence
            ? {
                resolvedInRuntime: true,
                ...(runtimeAccess
                  ? { resolvedRuntimeAccess: runtimeAccess }
                  : {}),
                ...(runtimeMember.jvmDescriptor
                  ? { resolvedRuntimeJvmDescriptor: runtimeMember.jvmDescriptor }
                  : {}),
                ...(runtimeMember.javaSignature
                  ? { resolvedRuntimeJavaSignature: runtimeMember.javaSignature }
                  : {})
              }
            : {})
        });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, methodNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Method "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
        });
        invalidCount++;
      }
    } else {
      // field
      const fieldNames = allFieldNames(members);
      const matchedMember = members.fields.find(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      );
      const found = matchedMember != null;

      if (found) {
        const runtimeMember = matchedMember;
        const runtimeAccess = accessLevelFromFlags(runtimeMember.accessFlags);
        validatedEntries.push({
          ...entry,
          valid: true,
          ...(options?.includeRuntimeEvidence
            ? {
                resolvedInRuntime: true,
                ...(runtimeAccess
                  ? { resolvedRuntimeAccess: runtimeAccess }
                  : {}),
                ...(runtimeMember.jvmDescriptor
                  ? { resolvedRuntimeJvmDescriptor: runtimeMember.jvmDescriptor }
                  : {}),
                ...(runtimeMember.javaSignature
                  ? { resolvedRuntimeJavaSignature: runtimeMember.javaSignature }
                  : {})
              }
            : {})
        });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, fieldNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Field "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
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

export function validateParsedAccessTransformer(
  parsed: ParsedAccessTransformer,
  membersByClass: Map<string, ResolvedTargetMembers>,
  warnings: string[],
  options?: { includeRuntimeEvidence?: boolean }
): AccessTransformerValidationResult {
  warnings.push(...parsed.parseWarnings);

  const validatedEntries: AccessTransformerValidationResult["entries"] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const entry of parsed.entries) {
    const ownerFqn = entry.owner;
    const members = membersByClass.get(ownerFqn);

    if (entry.targetKind === "class") {
      if (!members) {
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Class "${ownerFqn}" not found in runtime jar.`,
          ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
        });
        invalidCount++;
        continue;
      }

      const runtimeAccess = accessLevelFromFlags(members.classAccessFlags);
      validatedEntries.push({
        ...entry,
        valid: true,
        ...(options?.includeRuntimeEvidence
          ? {
              resolvedInRuntime: true,
              ...(runtimeAccess ? { resolvedRuntimeAccess: runtimeAccess } : {})
            }
          : {})
      });
      validCount++;
      continue;
    }

    if (!members) {
      validatedEntries.push({
        ...entry,
        valid: false,
        issue: `Owner class "${ownerFqn}" not found in runtime jar.`,
        ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
      });
      invalidCount++;
      continue;
    }

    if (entry.targetKind === "field") {
      const fieldNames = allFieldNames(members);
      const matchedField = members.fields.find((member) => member.name === entry.name);
      if (!matchedField) {
        const suggestions = entry.name ? suggestSimilar(entry.name, fieldNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Field "${entry.name}" not found in class "${ownerFqn}".`,
          ...(suggestions.length > 0 ? { suggestions } : {}),
          ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
        });
        invalidCount++;
        continue;
      }

      const runtimeAccess = accessLevelFromFlags(matchedField.accessFlags);
      validatedEntries.push({
        ...entry,
        valid: true,
        ...(options?.includeRuntimeEvidence
          ? {
              resolvedInRuntime: true,
              ...(runtimeAccess ? { resolvedRuntimeAccess: runtimeAccess } : {}),
              ...(matchedField.jvmDescriptor ? { resolvedRuntimeJvmDescriptor: matchedField.jvmDescriptor } : {}),
              ...(matchedField.javaSignature ? { resolvedRuntimeJavaSignature: matchedField.javaSignature } : {})
            }
          : {})
      });
      validCount++;
      continue;
    }

    const methodNames = allMethodNames(members);
    const matchedMethod = members.methods.find(
      (member) => member.name === entry.name && member.jvmDescriptor === entry.descriptor
    ) ?? members.constructors.find(
      (member) => member.name === entry.name && member.jvmDescriptor === entry.descriptor
    );
    if (!matchedMethod) {
      const suggestions = entry.name ? suggestSimilar(entry.name, methodNames) : [];
      validatedEntries.push({
        ...entry,
        valid: false,
        issue: `Method "${entry.name}" not found in class "${ownerFqn}".`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
        ...(options?.includeRuntimeEvidence ? { resolvedInRuntime: false } : {})
      });
      invalidCount++;
      continue;
    }

    const runtimeAccess = accessLevelFromFlags(matchedMethod.accessFlags);
    validatedEntries.push({
      ...entry,
      valid: true,
      ...(options?.includeRuntimeEvidence
        ? {
            resolvedInRuntime: true,
            ...(runtimeAccess ? { resolvedRuntimeAccess: runtimeAccess } : {}),
            ...(matchedMethod.jvmDescriptor ? { resolvedRuntimeJvmDescriptor: matchedMethod.jvmDescriptor } : {}),
            ...(matchedMethod.javaSignature ? { resolvedRuntimeJavaSignature: matchedMethod.javaSignature } : {})
          }
        : {})
    });
    validCount++;
  }

  return {
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
