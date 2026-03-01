export type SourceOrigin = "local-jar" | "local-m2" | "remote-repo" | "decompiled";
export type SourceMapping = "official" | "mojang" | "intermediary" | "yarn";
export type MappingSourcePriority = "loom-first" | "maven-first";

export type ArtifactTargetKind = "version" | "jar" | "coordinate";

export interface SourceTargetInput {
  kind: ArtifactTargetKind;
  value: string;
}

export interface ResolvedSourceArtifact {
  artifactId: string;
  artifactSignature: string;
  origin: SourceOrigin;
  binaryJarPath?: string;
  sourceJarPath?: string;
  adjacentSourceCandidates?: string[];
  coordinate?: string;
  version?: string;
  requestedMapping?: SourceMapping;
  mappingApplied?: SourceMapping;
  repoUrl?: string;
  provenance?: ArtifactProvenance;
  qualityFlags?: string[];
  isDecompiled: boolean;
  resolvedAt: string;
}

export interface ArtifactProvenance {
  target: SourceTargetInput;
  resolvedAt: string;
  resolvedFrom: {
    origin: SourceOrigin;
    sourceJarPath?: string;
    binaryJarPath?: string;
    coordinate?: string;
    version?: string;
    repoUrl?: string;
  };
  transformChain: string[];
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Config {
  cacheDir: string;
  sqlitePath: string;
  sourceRepos: string[];
  localM2Path: string;
  vineflowerJarPath: string | undefined;
  indexedSearchEnabled: boolean;
  mappingSourcePriority: MappingSourcePriority;
  maxContentBytes: number;
  maxSearchHits: number;
  maxArtifacts: number;
  maxCacheBytes: number;
  fetchTimeoutMs: number;
  fetchRetries: number;
  searchScanPageSize: number;
  indexInsertChunkSize: number;
  maxMappingGraphCache: number;
  maxSignatureCache: number;
  maxVersionDetailCache: number;
  maxNbtInputBytes: number;
  maxNbtInflatedBytes: number;
  maxNbtResponseBytes: number;
  tinyRemapperJarPath: string | undefined;
  remapTimeoutMs: number;
  remapMaxMemoryMb: number;
}

export interface ArtifactSignature {
  sourcePath: string;
  sourceArtifactId: string;
  signature: string;
  signatureParts: {
    mtimeMs: number;
    size: number;
  };
}

export interface SourceSearchHit {
  filePath: string;
  score: number;
  matchedIn: "path" | "content" | "both";
  preview: string;
}

export interface ArtifactRow {
  artifactId: string;
  origin: SourceOrigin;
  coordinate: string | undefined;
  version: string | undefined;
  binaryJarPath: string | undefined;
  sourceJarPath: string | undefined;
  repoUrl: string | undefined;
  requestedMapping: SourceMapping | undefined;
  mappingApplied: SourceMapping | undefined;
  provenance: ArtifactProvenance | undefined;
  qualityFlags: string[];
  artifactSignature: string | undefined;
  isDecompiled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileRow {
  artifactId: string;
  filePath: string;
  content: string;
  contentBytes: number;
  contentHash: string;
}

export interface SymbolRow {
  artifactId: string;
  filePath: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: string | undefined;
}
