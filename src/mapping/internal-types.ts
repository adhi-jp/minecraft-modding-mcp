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
