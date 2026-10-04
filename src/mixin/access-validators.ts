import type { ParsedAccessTransformer } from "../access-transformer-parser.js";
import type { AccessWidenerEntry, ParsedAccessWidener } from "../access-widener-parser.js";
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

const VALID_AW_HEADER_VERSIONS = new Set(["v1", "v2"]);

type RuntimeEvidence = {
  resolvedInRuntime?: boolean;
  resolvedRuntimeAccess?: "public" | "protected" | "private" | "package-private";
  resolvedRuntimeJvmDescriptor?: string;
  resolvedRuntimeJavaSignature?: string;
};

/**
 * Runtime-evidence fields for an entry that resolved against the runtime jar, or nothing when
 * evidence was not requested. `member` adds the descriptor and signature of a matched method or
 * field; classes and wildcards pass only access flags (or none).
 */
function runtimeEvidence(
  include: boolean | undefined,
  accessFlags: number | undefined,
  member?: { jvmDescriptor?: string; javaSignature?: string }
): RuntimeEvidence {
  if (!include) {
    return {};
  }
  const runtimeAccess = accessLevelFromFlags(accessFlags);
  return {
    resolvedInRuntime: true,
    ...(runtimeAccess ? { resolvedRuntimeAccess: runtimeAccess } : {}),
    ...(member?.jvmDescriptor ? { resolvedRuntimeJvmDescriptor: member.jvmDescriptor } : {}),
    ...(member?.javaSignature ? { resolvedRuntimeJavaSignature: member.javaSignature } : {})
  };
}

/**
 * Fabric access widener grammar rules (AUTHORITY): `accessible` applies to
 * class, method, field; `extendable` applies to class and method only;
 * `mutable` applies to field only; `transitive-` exists only under a v2
 * header. Returns a line+rule message when `entry` breaks one of these, or
 * undefined when the pairing is legal.
 */
function checkAccessWidenerEntryLegality(
  entry: AccessWidenerEntry,
  headerVersion: string
): string | undefined {
  if (entry.kind === "mutable" && entry.targetKind !== "field") {
    return `Line ${entry.line}: "mutable" only applies to field, not ${entry.targetKind}.`;
  }
  if (entry.kind === "extendable" && entry.targetKind === "field") {
    return `Line ${entry.line}: "extendable" does not apply to field (only class and method).`;
  }
  if (entry.transitive && headerVersion !== "v2") {
    return `Line ${entry.line}: "transitive-" entries require a v2 header (declared "${headerVersion || "none"}").`;
  }
  return undefined;
}

export function validateParsedAccessWidener(
  parsed: ParsedAccessWidener,
  membersByClass: Map<string, ResolvedTargetMembers>,
  warnings: string[],
  options?: { includeRuntimeEvidence?: boolean }
): AccessWidenerValidationResult {
  warnings.push(...parsed.parseWarnings);
  const unresolved = options?.includeRuntimeEvidence ? { resolvedInRuntime: false as const } : {};

  let headerValid = true;
  const headerLine = parsed.headerLine ?? 1;
  if (!parsed.headerVersion) {
    headerValid = false;
    warnings.push(
      `Line ${headerLine}: accessWidener requires a header line ("accessWidener <v1|v2> <namespace>"); none was found.`
    );
  } else if (!VALID_AW_HEADER_VERSIONS.has(parsed.headerVersion)) {
    headerValid = false;
    warnings.push(
      `Line ${headerLine}: Unsupported accessWidener header version "${parsed.headerVersion}" (expected v1 or v2).`
    );
  }

  const validatedEntries: AccessWidenerValidationResult["entries"] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const entry of parsed.entries) {
    const legalityIssue = checkAccessWidenerEntryLegality(entry, parsed.headerVersion);
    if (legalityIssue) {
      validatedEntries.push({ ...entry, valid: false, issue: legalityIssue });
      invalidCount++;
      continue;
    }

    const ownerFqn = entry.target.replace(/\//g, ".");

    if (entry.targetKind === "class") {
      const members = membersByClass.get(ownerFqn);
      if (members) {
        validatedEntries.push({
          ...entry,
          valid: true,
          ...runtimeEvidence(options?.includeRuntimeEvidence, members.classAccessFlags)
        });
        validCount++;
      } else {
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Class "${ownerFqn}" not found in game jar.`,
          ...unresolved
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
        ...unresolved
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

      if (matchedMember) {
        validatedEntries.push({
          ...entry,
          valid: true,
          ...runtimeEvidence(options?.includeRuntimeEvidence, matchedMember.accessFlags, matchedMember)
        });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, methodNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Method "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          ...unresolved
        });
        invalidCount++;
      }
    } else {
      // field
      const fieldNames = allFieldNames(members);
      const matchedMember = members.fields.find(
        (m) => m.name === entry.name && (!entry.descriptor || m.jvmDescriptor === entry.descriptor)
      );

      if (matchedMember) {
        validatedEntries.push({
          ...entry,
          valid: true,
          ...runtimeEvidence(options?.includeRuntimeEvidence, matchedMember.accessFlags, matchedMember)
        });
        validCount++;
      } else {
        const suggestions = entry.name ? suggestSimilar(entry.name, fieldNames) : [];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Field "${entry.name}" not found in class "${ownerFqn}".`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          ...unresolved
        });
        invalidCount++;
      }
    }
  }

  return {
    headerVersion: parsed.headerVersion,
    namespace: parsed.namespace,
    valid: invalidCount === 0 && headerValid && (parsed.rejectedEntryCount ?? 0) === 0,
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
  const unresolved = options?.includeRuntimeEvidence ? { resolvedInRuntime: false as const } : {};

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
          ...unresolved
        });
        invalidCount++;
        continue;
      }

      validatedEntries.push({
        ...entry,
        valid: true,
        ...runtimeEvidence(options?.includeRuntimeEvidence, members.classAccessFlags)
      });
      validCount++;
      continue;
    }

    if (!members) {
      validatedEntries.push({
        ...entry,
        valid: false,
        issue: `Owner class "${ownerFqn}" not found in runtime jar.`,
        ...unresolved
      });
      invalidCount++;
      continue;
    }

    if (entry.targetKind === "wildcard-all" || entry.targetKind === "wildcard-method") {
      // A wildcard transforms all members (or all methods); it is valid as long as
      // the owner class resolved, which it has by this point.
      validatedEntries.push({
        ...entry,
        valid: true,
        ...runtimeEvidence(options?.includeRuntimeEvidence, undefined)
      });
      validCount++;
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
          ...unresolved
        });
        invalidCount++;
        continue;
      }

      validatedEntries.push({
        ...entry,
        valid: true,
        ...runtimeEvidence(options?.includeRuntimeEvidence, matchedField.accessFlags, matchedField)
      });
      validCount++;
      continue;
    }

    const methodNames = allMethodNames(members);
    const sameNameMethods = [...members.methods, ...members.constructors].filter(
      (member) => member.name === entry.name
    );
    // Match by descriptor when one is supplied (AT method lines always carry one);
    // fall back to a unique name match when it is absent.
    const matchedMethod = entry.descriptor
      ? sameNameMethods.find((member) => member.jvmDescriptor === entry.descriptor)
      : sameNameMethods.length === 1
        ? sameNameMethods[0]
        : undefined;
    if (!matchedMethod) {
      // Distinguish a true missing method from a descriptor mismatch so the user
      // can see which overloads exist instead of a flat "not found".
      if (entry.descriptor && sameNameMethods.length > 0) {
        const available = [...new Set(sameNameMethods.map((member) => member.jvmDescriptor))];
        validatedEntries.push({
          ...entry,
          valid: false,
          issue: `Method "${entry.name}" exists in "${ownerFqn}" but no overload matches descriptor ${entry.descriptor} (available: ${available.join(", ")}).`,
          suggestions: available,
          ...unresolved
        });
        invalidCount++;
        continue;
      }
      const suggestions = entry.name ? suggestSimilar(entry.name, methodNames) : [];
      validatedEntries.push({
        ...entry,
        valid: false,
        issue: `Method "${entry.name}" not found in class "${ownerFqn}".`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
        ...unresolved
      });
      invalidCount++;
      continue;
    }

    validatedEntries.push({
      ...entry,
      valid: true,
      ...runtimeEvidence(options?.includeRuntimeEvidence, matchedMethod.accessFlags, matchedMethod)
    });
    validCount++;
  }

  return {
    valid: invalidCount === 0 && (parsed.rejectedEntryCount ?? 0) === 0,
    entries: validatedEntries,
    summary: {
      total: parsed.entries.length,
      valid: validCount,
      invalid: invalidCount
    },
    warnings
  };
}
