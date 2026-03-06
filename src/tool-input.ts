const POSITIVE_INT_FIELD_NAMES = new Set([
  "limit",
  "startLine",
  "endLine",
  "maxLines",
  "maxChars",
  "maxMembers",
  "maxBytes",
  "maxVersions",
  "maxClassResults"
]);

const MAPPING_FIELD_NAMES = new Set(["mapping", "sourceMapping", "targetMapping", "classNameMapping"]);

export type PreparedToolInput = {
  normalizedInput: unknown;
  removedOfficialPaths: string[];
  suggestedReplacementInput?: Record<string, unknown>;
};

function coerceTopLevelNumericStrings(value: unknown): unknown {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && POSITIVE_INT_FIELD_NAMES.has(key)) {
      const trimmed = entry.trim();
      if (/^\d+$/.test(trimmed)) {
        output[key] = Number.parseInt(trimmed, 10);
        continue;
      }
    }
    output[key] = entry;
  }
  return output;
}

function collectRemovedOfficialNamespacePaths(value: unknown): string[] {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return [];
  }

  const matches: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && MAPPING_FIELD_NAMES.has(key) && entry.trim() === "official") {
      matches.push(key);
    }
  }
  return matches;
}

function replaceRemovedOfficialMappings(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] =
      typeof entry === "string" && MAPPING_FIELD_NAMES.has(key) && entry.trim() === "official"
        ? "obfuscated"
        : entry;
  }
  return output;
}

export function prepareToolInput(rawInput: unknown): PreparedToolInput {
  const normalizedInput = coerceTopLevelNumericStrings(rawInput);
  const removedOfficialPaths = collectRemovedOfficialNamespacePaths(normalizedInput);

  return {
    normalizedInput,
    removedOfficialPaths,
    suggestedReplacementInput:
      removedOfficialPaths.length > 0 ? replaceRemovedOfficialMappings(normalizedInput) : undefined
  };
}
