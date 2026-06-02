import { ERROR_CODES, createError } from "../errors.js";
import { normalizeOptionalProjectPath } from "../gradle-paths.js";
import type { MappingSourcePriority, SourceMapping } from "../types.js";
import type {
  CandidateAccumulator,
  DirectionIndex,
  LoadedGraph,
  MappingLookupSource,
  MappingSymbolRecord,
  MatchRankKey,
  PairKey,
  PairRecord
} from "./internal-types.js";
import {
  DESCRIPTOR_FALLBACK_CONFIDENCE,
  MATCH_RANK,
  MAX_CANDIDATES
} from "./internal-types.js";
import type {
  ClassApiMatrixKind,
  DescriptorProjection,
  MappingLookupCandidate,
  ResolutionCandidate,
  SymbolQueryInput,
  SymbolReference
} from "./types.js";
import {
  createClassSymbolRecord,
  createFieldSymbolRecord,
  createMethodSymbolRecord,
  normalizeMappedSymbolOutput,
  normalizedVariants,
  simpleName
} from "./parsers/symbol-records.js";
import { pairKey } from "./parsers/normalize.js";

// Re-export descriptor-related types and constants for downstream consumers.
export type { DescriptorProjection };
export { MAX_CANDIDATES };

export function addCandidates(
  target: Map<string, CandidateAccumulator>,
  index: DirectionIndex,
  symbols: Set<string> | undefined,
  kind: MatchRankKey,
  confidence: number
): void {
  if (!symbols || symbols.size === 0) {
    return;
  }

  const rank = MATCH_RANK[kind];
  for (const key of symbols) {
    const record = index.records.get(key);
    if (!record) {
      continue;
    }
    const current = target.get(key);
    if (!current || rank > current.rank || (rank === current.rank && confidence > current.confidence)) {
      target.set(key, {
        key,
        record,
        matchKind: kind,
        confidence,
        rank
      });
    }
  }
}

export function lookupCandidates(index: DirectionIndex, query: MappingSymbolRecord): MappingLookupCandidate[] {
  const trimmedQuery = query.symbol.trim();
  const collected = new Map<string, CandidateAccumulator>();

  addCandidates(collected, index, index.exact.get(trimmedQuery), "exact", 1);

  for (const variant of normalizedVariants(trimmedQuery)) {
    addCandidates(collected, index, index.normalized.get(variant), "normalized", 0.9);
  }

  if (query.kind === "method" && query.owner && query.descriptor) {
    const descriptorlessKey = `${query.owner}.${query.name}`;
    addCandidates(
      collected,
      index,
      index.exact.get(descriptorlessKey),
      "normalized",
      DESCRIPTOR_FALLBACK_CONFIDENCE
    );
    for (const variant of normalizedVariants(descriptorlessKey)) {
      addCandidates(
        collected,
        index,
        index.normalized.get(variant),
        "normalized",
        DESCRIPTOR_FALLBACK_CONFIDENCE
      );
    }
  }

  const simpleKeys = new Set<string>();
  const shortName = simpleName(trimmedQuery);
  if (shortName) {
    simpleKeys.add(shortName);
  }
  if (query.kind !== "class") {
    simpleKeys.add(query.name);
  }
  if (query.kind === "method" && query.descriptor) {
    simpleKeys.add(`${query.name}${query.descriptor}`);
  }

  for (const key of simpleKeys) {
    addCandidates(collected, index, index.simple.get(key), "simple-name", 0.75);
  }

  return [...collected.values()]
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (right.rank !== left.rank) {
        return right.rank - left.rank;
      }
      return left.record.symbol.localeCompare(right.record.symbol);
    })
    .slice(0, MAX_CANDIDATES)
    .map(({ record, matchKind, confidence }) => ({
      symbol: record.symbol,
      matchKind,
      confidence,
      kind: record.kind,
      owner: record.owner,
      name: record.name,
      descriptor: record.descriptor
    }));
}

export function mappingPriorityFromInput(
  configPriority: MappingSourcePriority,
  override: MappingSourcePriority | undefined
): MappingSourcePriority {
  if (override === "loom-first" || override === "maven-first") {
    return override;
  }
  return configPriority;
}

export function mappingSourceOrder(priority: MappingSourcePriority): Array<"loom-cache" | "maven"> {
  if (priority === "maven-first") {
    return ["maven", "loom-cache"];
  }
  return ["loom-cache", "maven"];
}

export function requiresOnlyObfuscatedMojangGraph(
  sourceMapping: SourceMapping,
  targetMapping?: SourceMapping
): boolean {
  return sourceMapping !== "intermediary" &&
    sourceMapping !== "yarn" &&
    targetMapping !== "intermediary" &&
    targetMapping !== "yarn";
}

export function namespacePath(
  graph: LoadedGraph,
  sourceMapping: SourceMapping,
  targetMapping: SourceMapping
): SourceMapping[] | undefined {
  if (sourceMapping === targetMapping) {
    return [sourceMapping];
  }

  const key = pairKey(sourceMapping, targetMapping);
  if (graph.pathCache.has(key)) {
    return graph.pathCache.get(key);
  }

  const { adjacency } = graph;
  const queue: SourceMapping[] = [sourceMapping];
  let queueIndex = 0;
  const parent = new Map<SourceMapping, SourceMapping | undefined>([[sourceMapping, undefined]]);

  while (queueIndex < queue.length) {
    const current = queue[queueIndex] as SourceMapping;
    queueIndex += 1;
    if (current === targetMapping) {
      break;
    }

    const neighbors = adjacency.get(current);
    if (!neighbors) {
      continue;
    }
    for (const neighbor of neighbors) {
      if (parent.has(neighbor)) {
        continue;
      }
      parent.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  if (!parent.has(targetMapping)) {
    graph.pathCache.set(key, undefined);
    return undefined;
  }

  const reversedPath: SourceMapping[] = [];
  let cursor: SourceMapping | undefined = targetMapping;
  while (cursor) {
    reversedPath.push(cursor);
    cursor = parent.get(cursor);
  }
  const path = reversedPath.reverse();
  graph.pathCache.set(key, path);
  return path;
}

export function pathUsesSource(
  pairs: Map<PairKey, PairRecord>,
  path: SourceMapping[],
  source: MappingLookupSource
): boolean {
  for (let index = 0; index < path.length - 1; index += 1) {
    const hop = pairs.get(pairKey(path[index], path[index + 1]));
    if (hop?.source === source) {
      return true;
    }
  }
  return false;
}

export function pathToTransformChain(path: SourceMapping[]): string[] {
  if (path.length <= 1) {
    return [];
  }
  const transform: string[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    transform.push(`mapping:${path[index]}->${path[index + 1]}`);
  }
  return transform;
}

export function toLookupCandidate(record: MappingSymbolRecord): MappingLookupCandidate {
  return {
    symbol: record.symbol,
    matchKind: "exact",
    confidence: 1,
    kind: record.kind,
    owner: record.owner,
    name: record.name,
    descriptor: record.descriptor
  };
}

export function toSymbolReference(record: MappingSymbolRecord): SymbolReference {
  return {
    kind: record.kind,
    name: record.kind === "class" ? record.symbol : record.name,
    owner: record.kind === "class" ? undefined : record.owner,
    descriptor: record.kind === "method" ? record.descriptor : undefined,
    symbol: record.symbol
  };
}

export function toResolutionCandidate(
  candidate: MappingLookupCandidate
): SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence"> {
  return {
    kind: candidate.kind,
    name: candidate.kind === "class" ? candidate.symbol : candidate.name,
    owner: candidate.kind === "class" ? undefined : candidate.owner,
    descriptor: candidate.kind === "method" ? candidate.descriptor : undefined,
    symbol: candidate.symbol,
    matchKind: candidate.matchKind,
    confidence: candidate.confidence
  };
}

export function invalidInputError(message: string, details: Record<string, unknown>) {
  return createError({
    code: ERROR_CODES.INVALID_INPUT,
    message,
    details
  });
}

export function normalizeMemberName(name: string): string {
  const normalized = name.trim();
  if (!normalized || /[\s./()]/.test(normalized)) {
    throw invalidInputError(
      "name must be a simple member name without separators when kind is field or method.",
      {
        name
      }
    );
  }
  return normalized;
}

/**
 * Validate a JVM method descriptor such as `(I)V`, `()Lfoo/Bar;`, `(Lfoo/Bar;[I)V`.
 * Rejects empty strings, missing/mis-positioned parens, empty return type, and invalid base
 * type tokens so "(" or "()" style half-descriptors surface as ERR_INVALID_INPUT instead of
 * being silently accepted.
 */
export function normalizeMethodDescriptor(descriptor: string | undefined): string {
  const normalized = descriptor?.trim() ?? "";
  if (!normalized) {
    throw invalidInputError("descriptor must be a valid JVM descriptor when kind=method.", {
      descriptor
    });
  }
  if (!isValidMethodDescriptor(normalized)) {
    throw invalidInputError("descriptor must be a valid JVM descriptor when kind=method.", {
      descriptor
    });
  }
  return normalized;
}

export function isValidMethodDescriptor(descriptor: string): boolean {
  if (!descriptor.startsWith("(")) return false;
  const closingIndex = descriptor.indexOf(")");
  if (closingIndex < 0) return false;
  const argsSection = descriptor.slice(1, closingIndex);
  const returnSection = descriptor.slice(closingIndex + 1);
  if (returnSection.length === 0) return false;
  let cursor = 0;
  while (cursor < argsSection.length) {
    const next = consumeFieldType(argsSection, cursor, /*allowVoid*/ false);
    if (next < 0) return false;
    cursor = next;
  }
  const returnEnd = consumeFieldType(returnSection, 0, /*allowVoid*/ true);
  return returnEnd === returnSection.length;
}

/**
 * JVM specification §4.3.2: "An array type descriptor is valid only if it represents a type
 * with 255 or fewer dimensions." Matches the `multianewarray` / field-signature limit.
 */
const JVM_MAX_ARRAY_DIMENSIONS = 255;

export function consumeFieldType(descriptor: string, position: number, allowVoid: boolean): number {
  // Arrays are handled iteratively so pathological inputs such as `(` + "[".repeat(20000) + `I)V`
  // cannot blow the call stack. After consuming every leading `[`, only the element type token
  // is dispatched through the switch below. Dimensions above the JVM limit are rejected rather
  // than merely accepted as "syntactically valid but semantically absurd" — clients must not be
  // able to push a 20000-dimension descriptor through cache-key construction.
  let cursor = position;
  let arrayDimensions = 0;
  while (cursor < descriptor.length && descriptor[cursor] === "[") {
    cursor += 1;
    arrayDimensions += 1;
    if (arrayDimensions > JVM_MAX_ARRAY_DIMENSIONS) return -1;
  }
  if (cursor >= descriptor.length) return -1;
  // Void is only valid at the outermost position — inside an array element it is illegal.
  const elementAllowsVoid = cursor === position && allowVoid;
  const token = descriptor[cursor];
  switch (token) {
    case "B":
    case "C":
    case "D":
    case "F":
    case "I":
    case "J":
    case "S":
    case "Z":
      return cursor + 1;
    case "V":
      return elementAllowsVoid ? cursor + 1 : -1;
    case "L": {
      const end = descriptor.indexOf(";", cursor);
      // Reject empty class names like L; and unterminated references.
      if (end < 0 || end === cursor + 1) return -1;
      return end + 1;
    }
    default:
      return -1;
  }
}

export function normalizeQuerySymbol(
  input: SymbolQueryInput,
  signatureMode?: "exact" | "name-only",
  options?: {
    allowShortClassName?: boolean;
  }
): {
  record: MappingSymbolRecord;
  querySymbol: SymbolReference;
} {
  if (input.kind !== "class" && input.kind !== "field" && input.kind !== "method") {
    throw invalidInputError('kind must be one of "class", "field", or "method".', {
      kind: input.kind
    });
  }

  const normalizedName = input.name?.trim() ?? "";
  if (!normalizedName) {
    throw invalidInputError("name must be a non-empty string.", {
      name: input.name
    });
  }

  if (input.kind === "class") {
    const owner = input.owner?.trim();
    if (owner) {
      throw invalidInputError("owner is not allowed when kind=class. Use name as FQCN.", {
        owner: input.owner,
        nextAction: 'Provide class as name, e.g. "net.minecraft.server.Main".'
      });
    }
    if (input.descriptor?.trim()) {
      throw invalidInputError("descriptor is not allowed when kind=class.", {
        descriptor: input.descriptor
      });
    }

    const className = normalizeMappedSymbolOutput(normalizedName);
    if (!className.includes(".") && !options?.allowShortClassName) {
      throw invalidInputError("name must be a fully qualified class name when kind=class.", {
        name: input.name
      });
    }
    const record = createClassSymbolRecord(className);
    return {
      record,
      querySymbol: toSymbolReference(record)
    };
  }

  const owner = normalizeMappedSymbolOutput(input.owner?.trim() ?? "");
  if (!owner) {
    throw invalidInputError("owner is required when kind is field or method.", {
      owner: input.owner,
      kind: input.kind
    });
  }

  if (input.kind === "field") {
    if (input.descriptor?.trim()) {
      throw invalidInputError("descriptor is not allowed when kind=field.", {
        descriptor: input.descriptor
      });
    }
    const record = createFieldSymbolRecord(owner, normalizeMemberName(normalizedName));
    return {
      record,
      querySymbol: toSymbolReference(record)
    };
  }

  let descriptor: string;
  if (signatureMode === "name-only") {
    // name-only matches by owner+name only; a supplied descriptor is validated (so malformed
    // input still surfaces as ERR_INVALID_INPUT) but discarded afterwards so downstream
    // projection / filtering treats the query as "no descriptor".
    if (input.descriptor?.trim()) {
      normalizeMethodDescriptor(input.descriptor);
    }
    descriptor = "";
  } else {
    descriptor = normalizeMethodDescriptor(input.descriptor);
  }
  const record = createMethodSymbolRecord(
    owner,
    normalizeMemberName(normalizedName),
    descriptor
  );
  return {
    record,
    querySymbol: toSymbolReference(record)
  };
}

export function normalizeOwnerHint(ownerHint: string | undefined): string | undefined {
  const normalized = ownerHint?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalizeMappedSymbolOutput(normalized);
}

export function normalizeDescriptorHint(descriptorHint: string | undefined): string | undefined {
  const normalized = descriptorHint?.trim();
  return normalized || undefined;
}

export function applyDisambiguationHints(
  candidates: MappingLookupCandidate[],
  disambiguation: { ownerHint?: string; descriptorHint?: string } | undefined,
  warnings?: string[]
): MappingLookupCandidate[] {
  if (!disambiguation || candidates.length <= 1) {
    return candidates;
  }

  let filtered = [...candidates];
  const ownerHint = normalizeOwnerHint(disambiguation.ownerHint);
  if (ownerHint) {
    const ownerMatched = filtered.filter((candidate) => {
      if (candidate.owner) {
        return normalizeMappedSymbolOutput(candidate.owner) === ownerHint;
      }
      const normalizedSymbol = normalizeMappedSymbolOutput(candidate.symbol);
      return normalizedSymbol.startsWith(`${ownerHint}.`);
    });
    if (ownerMatched.length > 0) {
      filtered = ownerMatched;
    }
  }

  const descriptorHint = normalizeDescriptorHint(disambiguation.descriptorHint);
  if (descriptorHint) {
    const descriptorMatched = filtered.filter((candidate) =>
      candidate.descriptor != null && candidate.descriptor === descriptorHint
    );
    if (descriptorMatched.length > 0) {
      filtered = descriptorMatched;
    } else {
      // Candidate descriptors are projected toward the target namespace, so a hint
      // written in another namespace silently matches nothing. Surface that instead
      // of leaving the ambiguity unexplained.
      warnings?.push(
        `descriptorHint "${descriptorHint}" matched none of the ${filtered.length} candidate descriptor(s); it may be in a different mapping namespace. Hint ignored.`
      );
    }
  }

  return filtered;
}

export function projectLookupCandidateDescriptor(
  candidate: MappingLookupCandidate,
  sourceDescriptor: string,
  targetDescriptor: string | undefined
): MappingLookupCandidate {
  // Tiny mappings preserve method descriptors verbatim, so single-hop tiny paths often
  // return the source descriptor even though the final symbol is already in the target
  // namespace. Multi-hop paths that already produced a target-side descriptor are left
  // unchanged by design.
  if (
    candidate.kind !== "method" ||
    !candidate.descriptor ||
    !targetDescriptor ||
    candidate.descriptor !== sourceDescriptor
  ) {
    return candidate;
  }
  return {
    ...candidate,
    descriptor: targetDescriptor
  };
}

export function effectiveLoomSearchProjectPath(projectPath: string | undefined): string | undefined {
  return normalizeOptionalProjectPath(projectPath) ?? normalizeOptionalProjectPath(process.cwd());
}

export function collectTargetRecords(graph: LoadedGraph, targetMapping: SourceMapping): MappingSymbolRecord[] {
  return [...(graph.recordsByTarget.get(targetMapping) ?? [])];
}

export function normalizeIncludedKinds(inputKinds: ClassApiMatrixKind[] | undefined): Set<ClassApiMatrixKind> {
  const normalized = new Set<ClassApiMatrixKind>();
  const kinds = inputKinds ?? ["class", "field", "method"];
  for (const kind of kinds) {
    if (kind === "class" || kind === "field" || kind === "method") {
      normalized.add(kind);
    }
  }
  if (normalized.size === 0) {
    normalized.add("class");
    normalized.add("field");
    normalized.add("method");
  }
  return normalized;
}

export function inferAmbiguityReasons(
  candidates: ResolutionCandidate[],
  usedMojangClientMappings: boolean
): string[] {
  if (candidates.length <= 1) {
    return [];
  }
  const reasons: string[] = [];

  const owners = [...new Set(candidates.map((c) => c.owner).filter(Boolean))];
  if (owners.length > 1) {
    reasons.push(`Multiple owner classes matched: ${owners.join(", ")}`);
  }

  const matchKinds = [...new Set(candidates.map((c) => c.matchKind))];
  if (matchKinds.length > 1) {
    reasons.push(`Candidates matched at different precision levels: ${matchKinds.join(", ")}`);
  }

  if (usedMojangClientMappings) {
    const hasDescriptor = candidates.some((c) => c.descriptor);
    const missingDescriptor = candidates.some((c) => !c.descriptor);
    if (hasDescriptor && missingDescriptor) {
      reasons.push("Method descriptor was lost through mojang-client-mappings path, causing broader matching.");
    }
  }

  if (owners.length <= 1) {
    const descriptors = [...new Set(candidates.map((c) => c.descriptor).filter(Boolean))];
    if (descriptors.length > 1) {
      reasons.push(`Overloaded method: ${descriptors.length} variants`);
    }
  }

  if (reasons.length === 0) {
    reasons.push(`${candidates.length} candidates matched with similar confidence scores.`);
  }

  return reasons;
}

export function clampCandidateLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit == null) {
    return MAX_CANDIDATES;
  }
  return Math.max(1, Math.min(MAX_CANDIDATES, Math.trunc(limit)));
}

export function limitResolutionCandidates(
  candidates: ResolutionCandidate[],
  requestedLimit: number | undefined
): {
  candidates: ResolutionCandidate[];
  candidateCount: number;
  candidatesTruncated?: boolean;
} {
  const candidateCount = candidates.length;
  const limit = clampCandidateLimit(requestedLimit);
  const limitedCandidates = candidateCount > limit ? candidates.slice(0, limit) : candidates;
  return {
    candidates: limitedCandidates,
    candidateCount,
    ...(limitedCandidates.length < candidateCount ? { candidatesTruncated: true } : {})
  };
}

export function clampRowLimit(limit: number | undefined): number | undefined {
  if (!Number.isFinite(limit) || limit == null) {
    return undefined;
  }
  return Math.max(1, Math.min(5000, Math.trunc(limit)));
}
