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

/** Max number of unresolved candidates that get full metadata in compact mode. */
const UNRESOLVED_FULL_DETAIL_LIMIT = 3;

/**
 * Slim projection of a candidate: retains only identification + confidence fields.
 *
 * `kind` and `symbol` are part of the public `SymbolReference` / candidate contract that
 * clients branch on and use as rendering keys, so they MUST survive the slim. The heavy
 * fields removed here are the cycle-local diagnostic metadata (provenance, context,
 * ambiguityReasons, warnings on the candidate, etc.) — not the identity fields.
 */
function slimCandidate(candidate: unknown): Record<string, unknown> | unknown {
  if (!isPlainObject(candidate)) return candidate;
  const picked: Record<string, unknown> = {};
  for (const key of ["kind", "symbol", "owner", "name", "descriptor", "confidence", "matchKind"]) {
    if (candidate[key] !== undefined) {
      picked[key] = candidate[key];
    }
  }
  return picked;
}

/**
 * Mapping tool compact: project candidates for size reduction.
 *
 * Resolved-exact path: omit candidates entirely when provably redundant.
 *   All of: resolved===true, resolvedSymbol exists, single exact candidate, not truncated,
 *           confidence missing or 1.
 *
 * Unresolved/ambiguous path: keep top {@link UNRESOLVED_FULL_DETAIL_LIMIT} candidates with full
 *   metadata, slim the tail to {owner,name,descriptor,confidence,matchKind}, and surface
 *   `candidatesTruncated:true` + `totalCandidateCount` so the caller knows what it's seeing.
 */
export function compactMappingResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const projected = { ...obj };
  const candidates = projected.candidates;

  if (
    projected.resolved === true &&
    projected.resolvedSymbol !== undefined &&
    Array.isArray(candidates) &&
    candidates.length === 1 &&
    projected.candidateCount === 1 &&
    !projected.candidatesTruncated
  ) {
    const candidate = candidates[0] as Record<string, unknown> | undefined;
    if (
      candidate &&
      candidate.matchKind === "exact" &&
      (candidate.confidence === undefined || candidate.confidence === 1)
    ) {
      delete projected.candidates;
      return projected;
    }
  }

  if (
    projected.resolved === false &&
    Array.isArray(candidates) &&
    candidates.length > UNRESOLVED_FULL_DETAIL_LIMIT
  ) {
    const head = candidates.slice(0, UNRESOLVED_FULL_DETAIL_LIMIT);
    const tail = candidates.slice(UNRESOLVED_FULL_DETAIL_LIMIT).map(slimCandidate);
    projected.candidates = [...head, ...tail];
    // Tail slimming keeps the full candidate array; only metadata was dropped. Use a
    // dedicated `candidateDetailsTruncated` signal so clients do not confuse it with the
    // existing `candidatesTruncated` semantics ("more candidates exist than this response
    // contains"). If the upstream already reported list-level truncation via
    // `candidatesTruncated`, that value is preserved unchanged.
    projected.candidateDetailsTruncated = true;
  }

  return projected;
}
