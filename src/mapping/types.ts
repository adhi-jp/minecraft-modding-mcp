import type { MappingSourcePriority, SourceMapping } from "../types.js";
import type {
  MappingLookupSource,
  MappingSymbolKind
} from "./internal-types.js";

export type MappingMatchKind = "exact" | "normalized" | "simple-name";

export type MappingLookupCandidate = {
  symbol: string;
  matchKind: MappingMatchKind;
  confidence: number;
  kind: MappingSymbolKind;
  owner?: string;
  name: string;
  descriptor?: string;
};

export type MappingLookupProvenance = {
  source: MappingLookupSource;
  mappingArtifact: string;
  version: string;
  priority: MappingSourcePriority;
};

export type SymbolQueryKind = MappingSymbolKind;

export type SymbolQueryInput = {
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
};

export type SymbolReference = {
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  symbol: string;
};

export type SymbolResolutionStatus = "resolved" | "not_found" | "ambiguous" | "mapping_unavailable";

export type SymbolResolutionOutput = {
  querySymbol: SymbolReference;
  mappingContext: {
    version: string;
    sourceMapping: SourceMapping;
    targetMapping?: SourceMapping;
    sourcePriorityApplied: MappingSourcePriority;
  };
  resolved: boolean;
  status: SymbolResolutionStatus;
  resolvedSymbol?: SymbolReference;
  candidates: Array<SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence">>;
  candidateCount: number;
  candidatesTruncated?: boolean;
  warnings: string[];
  provenance?: MappingLookupProvenance;
  ambiguityReasons?: string[];
};

export type FindMappingInput = {
  version: string;
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  signatureMode?: "exact" | "name-only";
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  disambiguation?: {
    ownerHint?: string;
    descriptorHint?: string;
  };
  maxCandidates?: number;
};

export type FindMappingOutput = SymbolResolutionOutput;

export type EnsureMappingAvailableInput = {
  version: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
};

export type EnsureMappingAvailableOutput = {
  transformChain: string[];
  warnings: string[];
  provenance?: MappingLookupProvenance;
};

export type ResolveMethodMappingExactInput = {
  version: string;
  name: string;
  owner: string;
  descriptor: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  maxCandidates?: number;
};

export type ResolveMethodMappingExactOutput = SymbolResolutionOutput;

export type ClassApiMatrixKind = "class" | "field" | "method";

export type ClassApiMatrixInput = {
  version: string;
  className: string;
  classNameMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  gradleUserHome?: string;
  includeKinds?: ClassApiMatrixKind[];
  maxRows?: number;
  cursor?: string;
};

export type ClassApiMatrixEntry = {
  symbol: string;
  owner?: string;
  name: string;
  descriptor?: string;
};

export type ClassApiMatrixRow = {
  kind: ClassApiMatrixKind;
  descriptor?: string;
  obfuscated?: ClassApiMatrixEntry;
  mojang?: ClassApiMatrixEntry;
  intermediary?: ClassApiMatrixEntry;
  yarn?: ClassApiMatrixEntry;
  completeness: boolean;
};

export type ClassApiMatrixOutput = {
  version: string;
  className: string;
  classNameMapping: SourceMapping;
  classIdentity: Partial<Record<SourceMapping, string>>;
  rows: ClassApiMatrixRow[];
  rowCount: number;
  rowsTruncated?: boolean;
  /** Continuation cursor when more rows remain; pass back as cursor for the next page. */
  nextCursor?: string;
  /** True when a provided cursor was malformed or belonged to a different query and was ignored. */
  cursorIgnored?: boolean;
  warnings: string[];
  ambiguousRowCount?: number;
};

export type SymbolExistenceInput = {
  version: string;
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  sourceMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  gradleUserHome?: string;
  nameMode?: "fqcn" | "auto";
  signatureMode?: "exact" | "name-only";
  maxCandidates?: number;
};

export type SymbolExistenceOutput = SymbolResolutionOutput;

export type ResolutionCandidate = SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence">;

export type DescriptorProjection = {
  descriptor: string;
  hadClassReferences: boolean;
  complete: boolean;
};
