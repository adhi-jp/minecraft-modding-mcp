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
  "check-symbol-exists",
  "get-class-source",
  "get-class-members",
  "search-class-source",
  "list-artifact-files"
]);

/** Mapping-oriented tools that get additional field projection via compactMappingResponse. */
export const COMPACT_MAPPING_TOOL_NAMES = new Set([
  "find-mapping",
  "resolve-method-mapping-exact",
  "resolve-workspace-symbol",
  "check-symbol-exists"
]);

/** Source-oriented tools (get-class-source) that get compactSourceResponse projection. */
export const COMPACT_SOURCE_TOOL_NAMES = new Set([
  "get-class-source"
]);

/** Member-listing tools (get-class-members) that get compactMembersResponse projection. */
export const COMPACT_MEMBERS_TOOL_NAMES = new Set([
  "get-class-members"
]);

/**
 * Tools that only need the light artifactContents projection (search hits,
 * file listing). The primary payload is already small; the projection just
 * drops the artifact-level summary that callers rarely consume.
 */
export const COMPACT_LIGHT_TOOL_NAMES = new Set([
  "search-class-source",
  "list-artifact-files"
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
 * Primary-payload keys that compact mode must preserve per tool, even when
 * the value is an empty array (no hits, no files, no members). Without this
 * the generic {@link compactResponse} path would strip `hits: []` / `items: []`
 * from successful zero-result responses and callers could not distinguish
 * "empty success" from "field missing".
 *
 * Only tools whose primary payload can legitimately be an empty array need
 * an entry here. `get-class-source` returns `sourceText: string` which is
 * never stripped by compactResponse.
 */
export const TOOL_PRESERVE_PAYLOAD_KEYS: Record<string, ReadonlySet<string>> = {
  "search-class-source": new Set(["hits"]),
  "list-artifact-files": new Set(["items"]),
  "get-class-members": new Set(["members", "counts", "decompiledFallback", "decompiledMemberCounts"])
};

/**
 * Shallow-strip empty values from a response object.
 * Only operates on the top level — nested structures are preserved as-is.
 * Non-plain objects (Date, Map, class instances) are never treated as empty.
 *
 * `preserveKeys` names keys whose values MUST survive the strip even if
 * empty (used by tools whose primary payload is an array that can legitimately
 * be empty — e.g. zero-hit search, empty file listing). `null` / `undefined`
 * values are still dropped even for preserved keys, so absent optional
 * payload fields do not leak through as explicit nulls.
 */
export function compactResponse(
  obj: Record<string, unknown>,
  preserveKeys?: ReadonlySet<string>
): Record<string, unknown> {
  if (!isPlainObject(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (preserveKeys?.has(key)) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length === 0) continue;
    if (isPlainObject(value) && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}

function projectOmitKeys(
  obj: Record<string, unknown>,
  omit: ReadonlySet<string>
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (omit.has(key)) continue;
    projected[key] = value;
  }
  return projected;
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

/**
 * include-group => the resolve-artifact fields that group re-adds (un-omits) when present.
 * Used by the detail/include projection so callers can opt specific diagnostics back in.
 */
const ARTIFACT_INCLUDE_PROTECTS: Record<string, readonly string[]> = {
  provenance: ["provenance"],
  artifact: ["artifactContents"],
  samples: ["sampleEntries"],
  candidates: ["adjacentSourceCandidates"],
  paths: ["binaryJarPath", "resolvedSourceJarPath", "coordinate", "repoUrl"]
};

/**
 * resolve-artifact compact: omit debug/diagnostic fields. When `include` is provided,
 * any field protected by a present include group is kept (re-added).
 */
export function compactArtifactResponse(
  obj: Record<string, unknown>,
  include?: ReadonlySet<string>
): Record<string, unknown> {
  if (!include || include.size === 0) {
    return projectOmitKeys(obj, ARTIFACT_COMPACT_OMIT_KEYS);
  }
  const omit = new Set(ARTIFACT_COMPACT_OMIT_KEYS);
  for (const group of include) {
    for (const protectedKey of ARTIFACT_INCLUDE_PROTECTS[group] ?? []) {
      omit.delete(protectedKey);
    }
  }
  return projectOmitKeys(obj, omit);
}

/** Fields to omit from get-class-source in compact mode. */
const SOURCE_COMPACT_OMIT_KEYS = new Set([
  "provenance",
  "artifactContents",
  "qualityFlags"
]);

/** get-class-source compact: drop provenance, artifactContents, qualityFlags. */
export function compactSourceResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return projectOmitKeys(obj, SOURCE_COMPACT_OMIT_KEYS);
}

/** Fields to omit from get-class-members in compact mode. */
const MEMBERS_COMPACT_OMIT_KEYS = new Set([
  "provenance",
  "artifactContents",
  "qualityFlags",
  "context"
]);

/** get-class-members compact: drop provenance, artifactContents, qualityFlags, context. */
export function compactMembersResponse(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return projectOmitKeys(obj, MEMBERS_COMPACT_OMIT_KEYS);
}

/**
 * Default diagnostic strip for get-class-source / get-class-members. Drops the
 * three diagnostic fields (provenance, artifactContents, qualityFlags) that the
 * common path never needs, applied unless the caller passes includeProvenance.
 * Unlike compactMembersResponse this KEEPS members' `context` — only compact:true
 * drops context. Reuses SOURCE_COMPACT_OMIT_KEYS (exactly those three keys).
 */
export function stripSourceDiagnostics(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return projectOmitKeys(obj, SOURCE_COMPACT_OMIT_KEYS);
}

export function stripMembersDiagnostics(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return projectOmitKeys(obj, SOURCE_COMPACT_OMIT_KEYS);
}

/** Fields to omit from search-class-source / list-artifact-files in compact mode. */
const LIGHT_COMPACT_OMIT_KEYS = new Set([
  "artifactContents"
]);

/**
 * Light compact projection: drop the artifactContents summary only. When `include`
 * contains "artifact", the summary is kept (re-added).
 */
export function compactLightResponse(
  obj: Record<string, unknown>,
  include?: ReadonlySet<string>
): Record<string, unknown> {
  if (include?.has("artifact")) {
    return obj;
  }
  return projectOmitKeys(obj, LIGHT_COMPACT_OMIT_KEYS);
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
 *   metadata, slim the tail to {kind,symbol,owner,name,descriptor,confidence,matchKind}, and
 *   surface `candidatesTruncated:true` + `totalCandidateCount` so the caller knows what it's
 *   seeing.
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

// ---------------------------------------------------------------------------
// detail / include projection
//
// The expert and batch tools now share the entry-tool response-shaping
// vocabulary (`detail: summary|standard|full` + `include[]`) instead of a
// per-tool `compact` boolean. projectByDetail() maps (tool, detail, include)
// onto the existing compact omit-sets so the DEFAULT wire output is
// byte-identical to the previous compact defaults:
//   - resolution/mapping tools + batch defaulted compact:true  -> default summary
//   - source/file tools defaulted compact:false (post Phase 4) -> default standard
// summary == old compact:true; standard == old compact:false; full keeps
// everything (incl. diagnostics). include groups opt specific fields back in.
// ---------------------------------------------------------------------------

export type ResponseDetailLevel = "summary" | "standard" | "full";

/** Expert + batch tools that accept the detail/include response contract. */
export const DETAIL_ENABLED_TOOL_NAMES = COMPACT_ENABLED_TOOL_NAMES;

/** Per-tool default detail level, chosen so default output is byte-identical to the old compact defaults. */
export const DEFAULT_DETAIL_BY_TOOL: Record<string, ResponseDetailLevel> = {
  "resolve-artifact": "summary",
  "find-mapping": "summary",
  "resolve-method-mapping-exact": "summary",
  "resolve-workspace-symbol": "summary",
  "check-symbol-exists": "summary",
  "get-class-source": "standard",
  "get-class-members": "standard",
  "search-class-source": "standard",
  "list-artifact-files": "standard"
};

/** Extra keys omitted from get-class-members at detail=summary (beyond the diagnostic strip). */
const MEMBERS_SUMMARY_EXTRA_OMIT = new Set(["context"]);

/**
 * Project an expert/batch tool result for the requested detail level + include set.
 * Reuses the existing compact omit-sets; see the block comment above for the mapping.
 */
export function projectByDetail(
  tool: string,
  result: Record<string, unknown>,
  detail: ResponseDetailLevel,
  include: ReadonlySet<string>
): Record<string, unknown> {
  let out = result;

  // Phase-4 diagnostic strip for source/members, now detail/include-aware:
  // kept at detail=full or when include opts provenance back in.
  const keepDiagnostics = detail === "full" || include.has("provenance");
  if (!keepDiagnostics) {
    if (tool === "get-class-source") out = stripSourceDiagnostics(out);
    if (tool === "get-class-members") out = stripMembersDiagnostics(out);
  }

  if (detail === "summary") {
    if (tool === "resolve-artifact") {
      out = compactArtifactResponse(out, include);
    }
    if (COMPACT_MAPPING_TOOL_NAMES.has(tool) && !include.has("candidates")) {
      out = compactMappingResponse(out);
    }
    if (tool === "get-class-members") {
      out = projectOmitKeys(out, MEMBERS_SUMMARY_EXTRA_OMIT);
    }
    if (COMPACT_LIGHT_TOOL_NAMES.has(tool)) {
      out = compactLightResponse(out, include);
    }
    out = compactResponse(out, TOOL_PRESERVE_PAYLOAD_KEYS[tool]);
  }

  return out;
}
