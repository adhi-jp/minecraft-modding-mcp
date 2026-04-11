/**
 * Compact-mode response utilities.
 *
 * Applied at the public boundary (runTool) only — internal service types are never modified.
 */

/** Tools that accept the `compact` parameter. */
export const COMPACT_ENABLED_TOOL_NAMES = new Set([
  "resolve-artifact",
  "find-mapping",
  "resolve-method-mapping-exact",
  "resolve-workspace-symbol",
  "check-symbol-exists"
]);

/** Mapping-oriented tools that get additional field projection via compactMappingResponse. */
export const COMPACT_MAPPING_TOOL_NAMES = new Set([
  "find-mapping",
  "resolve-method-mapping-exact",
  "resolve-workspace-symbol",
  "check-symbol-exists"
]);

/**
 * Double-gated compact check: tool must be in the allowlist AND parsedInput.compact must be true.
 * Prevents activation on passthrough schemas where Zod doesn't strip unknown keys.
 */
export function isCompactEnabled(
  tool: string,
  parsedInput: unknown
): boolean {
  if (!COMPACT_ENABLED_TOOL_NAMES.has(tool)) return false;
  if (
    parsedInput &&
    typeof parsedInput === "object" &&
    !Array.isArray(parsedInput) &&
    (parsedInput as Record<string, unknown>).compact === true
  ) {
    return true;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Shallow-strip empty values from a response object.
 * Only operates on the top level — nested structures are preserved as-is.
 * Non-plain objects (Date, Map, class instances) are never treated as empty.
 */
export function compactResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  if (!isPlainObject(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isPlainObject(value) && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}

/** Fields to omit from resolve-artifact in compact mode. */
const ARTIFACT_COMPACT_OMIT_KEYS = new Set([
  "provenance",
  "artifactContents",
  "sampleEntries",
  "adjacentSourceCandidates",
  "binaryJarPath",
  "coordinate",
  "repoUrl",
  "resolvedSourceJarPath"
]);

/** resolve-artifact compact: omit debug/diagnostic fields. */
export function compactArtifactResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (ARTIFACT_COMPACT_OMIT_KEYS.has(key)) continue;
    projected[key] = value;
  }
  return projected;
}

/**
 * Compact projection for mapping tool responses (P4 stub).
 * Full implementation in P4 plan.
 */
export function compactMappingResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return obj;
}
