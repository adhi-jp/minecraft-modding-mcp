export type SourceOrigin = "local-jar" | "local-m2" | "remote-repo" | "decompiled";
export type SourceMapping = "obfuscated" | "mojang" | "intermediary" | "yarn";
export type AccessTransformerNamespace = "srg" | "mojang" | "obfuscated";
export type RuntimeValidationNamespace = SourceMapping | AccessTransformerNamespace;
export type MappingSourcePriority = "loom-first" | "maven-first";

export type ArtifactTargetKind = "version" | "jar" | "coordinate";
export type ArtifactScope = "vanilla" | "merged" | "loader";
export type MappingVariant = "pass" | "mojang-remapped";

export interface SourceTargetInput {
  kind: ArtifactTargetKind;
  value: string;
}

export type WorkspaceTargetInput = {
  kind: "workspace";
  scope?: ArtifactScope;
  strict?: boolean;
};

export type DependencyTargetInput = {
  kind: "dependency";
  group: string;
  name: string;
  version?: string;
  versionFromProject?: boolean;
};

export type ResolveArtifactTargetInput = SourceTargetInput | WorkspaceTargetInput | DependencyTargetInput;

export interface ResolvedSourceArtifact {
  artifactId: string;
  artifactAlias?: string;
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

export interface WorkspaceResolutionProvenance {
  projectPath: string;
  detected: {
    minecraftVersion?: string;
    compileMapping?: SourceMapping;
    loader?: string;
  };
  source: string;
  cacheHit: boolean;
  warnings?: string[];
}

export interface DependencyResolutionProvenance {
  group: string;
  name: string;
  resolvedVersion?: string;
  source: string;
  candidatesSeen?: string[];
  attempts?: string[];
  cacheHit: boolean;
  /** Set when a submodule version was adopted from the cached umbrella POM. */
  submoduleVersionSource?: "umbrella-pom";
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
  workspaceResolution?: WorkspaceResolutionProvenance;
  dependencyResolution?: DependencyResolutionProvenance;
  warnings?: string[];
  /**
   * In-archive paths of bundled Jar-in-Jar nested jars, recorded once at
   * ingest for shell jars (near-zero own classes). Class-family lookups
   * redirect into these instead of dead-ending in decompilation.
   */
  nestedJars?: string[];
  /**
   * Set on responses that were served by redirecting a class lookup into a
   * nested jar of a shell artifact.
   */
  nestedJar?: {
    entryName: string;
    shellArtifactId: string;
  };
  /**
   * Additional sources jars indexed into this artifact alongside
   * resolvedFrom.sourceJarPath — the other half of a Loom split-source pair
   * (minecraft-common / minecraft-clientOnly), so client-only classes are not
   * lost to single-jar selection.
   */
  companionSourceJars?: string[];
}

export interface RuntimeValidationProvenance<
  TMapping extends RuntimeValidationNamespace = RuntimeValidationNamespace
> {
  version: string;
  jarPath: string;
  requestedScope?: ArtifactScope;
  appliedScope?: ArtifactScope;
  requestedMapping: TMapping;
  mappingApplied: TMapping;
  origin: SourceOrigin | "loom-cache" | "version-jar";
  resolutionNotes?: string[];
  scopeFallback?: { requested: string; applied: string; reason: string };
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
  searchScanMaxBytes: number;
  indexInsertChunkSize: number;
  maxMappingGraphCache: number;
  maxSignatureCache: number;
  maxVersionDetailCache: number;
  maxNbtInputBytes: number;
  maxNbtInflatedBytes: number;
  maxNbtResponseBytes: number;
  sqliteCacheKb: number;
  sqliteMmapSize: number;
  tinyRemapperJarPath: string | undefined;
  remapTimeoutMs: number;
  remapMaxMemoryMb: number;
  decompileMaxMemoryMb: number;
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
  alias: string | undefined;
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
