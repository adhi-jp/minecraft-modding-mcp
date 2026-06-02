/**
 * Internal types shared between the MappingService class and the parser
 * modules under `src/mapping/parsers/`. Public mapping API types live in
 * `src/mapping-service.ts`; this file is intentionally limited to types
 * the parsers need to operate on indexes.
 */

import type { SourceMapping } from "../types.js";

export type PairKey = `${SourceMapping}->${SourceMapping}`;

export type MappingSymbolKind = "class" | "field" | "method";

export type MappingSymbolRecord = {
  kind: MappingSymbolKind;
  symbol: string;
  owner?: string;
  name: string;
  descriptor?: string;
};

export type DirectionIndex = {
  exact: Map<string, Set<string>>;
  normalized: Map<string, Set<string>>;
  simple: Map<string, Set<string>>;
  records: Map<string, MappingSymbolRecord>;
};

export type MappingLookupSource = "loom-cache" | "maven" | "mojang-client-mappings";

export type PairRecord = {
  index: DirectionIndex;
  source: MappingLookupSource;
  mappingArtifact: string;
};

export const MATCH_RANK = {
  exact: 3,
  normalized: 2,
  "simple-name": 1
} as const;
export const DESCRIPTOR_FALLBACK_CONFIDENCE = 0.85;
export const MAX_CANDIDATES = 200;

export type MatchRankKey = keyof typeof MATCH_RANK;

export type GraphLoadMode = "full" | "obfuscated-mojang-only";

export type CandidateAccumulator = {
  key: string;
  record: MappingSymbolRecord;
  matchKind: import("./types.js").MappingMatchKind;
  confidence: number;
  rank: number;
};

export type LoadedGraph = {
  version: string;
  priority: import("../types.js").MappingSourcePriority;
  mode: GraphLoadMode;
  pairs: Map<PairKey, PairRecord>;
  adjacency: Map<import("../types.js").SourceMapping, import("../types.js").SourceMapping[]>;
  pathCache: Map<PairKey, import("../types.js").SourceMapping[] | undefined>;
  recordsByTarget: Map<import("../types.js").SourceMapping, MappingSymbolRecord[]>;
  /**
   * Graph-scoped cache of class-to-class descriptor projections, keyed by
   * `path.join(">") + NUL + internalName`. Value is the projected internal name,
   * or `null` to memoize an unmapped/ambiguous class. Shared across all member
   * lookups on this graph; dies with graph eviction.
   */
  classProjectionCache: Map<string, string | null>;
  warnings: string[];
};
