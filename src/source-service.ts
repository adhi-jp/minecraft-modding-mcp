import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import fastGlob from "fast-glob";

import { mapWithConcurrencyLimit } from "./concurrency.js";
import { createError, ERROR_CODES, isAppError, type AppError } from "./errors.js";
import { buildArtifactAlias, loadConfig } from "./config.js";
import { decompileBinaryJar } from "./decompiler/vineflower.js";
import { resolveVineflowerJar } from "./vineflower-resolver.js";
import { remapJar } from "./tiny-remapper-service.js";
import { resolveTinyRemapperJar } from "./tiny-remapper-resolver.js";
import { resolveMojangTinyFile } from "./mojang-tiny-mapping-service.js";
import { parseCoordinate } from "./maven-resolver.js";
import {
  MinecraftExplorerService,
  modifierPrefix,
  parseFieldType,
  parseMethodDescriptor,
  type ResponseContext as ExplorerResponseContext,
  type SignatureMember
} from "./minecraft-explorer-service.js";
import { parseMixinSource } from "./mixin-parser.js";
import { parseAccessWidener } from "./access-widener-parser.js";
import { parseAccessTransformer } from "./access-transformer-parser.js";
import {
  validateParsedMixin,
  refreshMixinValidationOutcome,
  validateParsedAccessWidener,
  validateParsedAccessTransformer,
  loadMixinStageBudgets,
  type IssueConfidence,
  type ResolvedTargetMembers,
  type MixinValidationResult,
  type MixinValidationProvenance,
  type MappingHealthReport,
  type AccessWidenerValidationResult,
  type AccessTransformerValidationResult,
  type MixinStageBudgets,
  type TargetOutcome as MixinTargetOutcome
} from "./mixin-validator.js";
import {
  resolveSourceTarget as resolveSourceTargetInternal,
  type MappingVariant
} from "./source-resolver.js";
import { applyMappingPipeline } from "./mapping-pipeline-service.js";
import {
  MappingService,
  type ClassApiMatrixInput as MappingClassApiMatrixInput,
  type ClassApiMatrixOutput as MappingClassApiMatrixOutput,
  type FindMappingInput as MappingFindMappingInput,
  type FindMappingOutput as MappingFindMappingOutput,
  type ResolveMethodMappingExactInput as MappingResolveMethodMappingExactInput,
  type ResolveMethodMappingExactOutput as MappingResolveMethodMappingExactOutput,
  type SymbolResolutionOutput as MappingSymbolResolutionOutput,
  type SymbolExistenceInput as MappingSymbolExistenceInput,
  type SymbolExistenceOutput as MappingSymbolExistenceOutput
} from "./mapping-service.js";
import { extractSymbolsFromSource } from "./symbols/symbol-extractor.js";
import { detectFabricLikeInputNamespace, iterateJavaEntriesAsUtf8, listJavaEntries } from "./source-jar-reader.js";
import { openDatabase } from "./storage/db.js";
import { ArtifactsRepo } from "./storage/artifacts-repo.js";
import { FilesRepo } from "./storage/files-repo.js";
import { IndexMetaRepo, type ArtifactIndexMetaRow } from "./storage/index-meta-repo.js";
import { SymbolsRepo } from "./storage/symbols-repo.js";
import { RuntimeMetrics, type RuntimeMetricSnapshot } from "./observability.js";
import { LruList } from "./lru-list.js";
import { log } from "./logger.js";
import { NOOP_STAGE_EMITTER, type StageEmitter } from "./stage-emitter.js";
import { normalizePathForHost } from "./path-converter.js";
import {
  buildLoaderRuntimeSearchRoots,
  buildVersionSourceSearchRoots,
  normalizeOptionalProjectPath
} from "./gradle-paths.js";
import {
  createSearchHitAccumulator,
  decodeSearchCursor,
  encodeSearchCursor
} from "./search-hit-accumulator.js";
import {
  WorkspaceMappingService,
  type WorkspaceCompileMappingOutput,
  type WorkspaceProjectLoader
} from "./workspace-mapping-service.js";
import {
  getProcessWorkspaceContextCache,
  type WorkspaceContext,
  type WorkspaceContextCache
} from "./workspace-context-cache.js";
import type {
  AccessTransformerNamespace,
  ArtifactProvenance,
  ArtifactRow,
  ArtifactScope,
  ArtifactTargetKind,
  Config,
  DependencyResolutionProvenance,
  DependencyTargetInput,
  FileRow,
  MappingSourcePriority,
  ResolveArtifactTargetInput,
  ResolvedSourceArtifact,
  RuntimeValidationProvenance,
  SourceMapping,
  SourceTargetInput,
  SymbolRow,
  WorkspaceResolutionProvenance,
  WorkspaceTargetInput
} from "./types.js";
import {
  VersionService,
  isUnobfuscatedVersion,
  type ListVersionsInput,
  type ListVersionsOutput
} from "./version-service.js";
import {
  RegistryService,
  type GetRegistryDataInput,
  type GetRegistryDataOutput
} from "./registry-service.js";
import {
  VersionDiffService,
  type CompareVersionsInput,
  type CompareVersionsOutput
} from "./version-diff-service.js";
import {
  ModDecompileService,
  type DecompileModJarInput,
  type DecompileModJarOutput,
  type GetModClassSourceInput,
  type GetModClassSourceOutput
} from "./mod-decompile-service.js";
import {
  ModSearchService,
  type SearchModSourceInput,
  type SearchModSourceOutput
} from "./mod-search-service.js";

const WORKSPACE_TARGET_OFF = process.env.WORKSPACE_TARGET_OFF === "1";
const DEPENDENCY_TARGET_OFF = process.env.DEPENDENCY_TARGET_OFF === "1";

export type ResolveArtifactInput = {
  target: ResolveArtifactTargetInput;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
  compact?: boolean;
};

export type ResolveArtifactOutput = {
  artifactId: string;
  artifactAlias: string;
  origin: "local-jar" | "local-m2" | "remote-repo" | "decompiled";
  isDecompiled: boolean;
  resolvedSourceJarPath?: string;
  adjacentSourceCandidates?: string[];
  binaryJarPath?: string;
  coordinate?: string;
  version?: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  provenance: ArtifactProvenance;
  qualityFlags: string[];
  repoUrl?: string;
  artifactContents: ArtifactContentsSummary;
  warnings: string[];
  sampleEntries?: string[];
};

export type ArtifactContentsSummary = {
  sourceKind: "source-jar" | "decompiled-binary";
  indexedContentKinds: string[];
  resourcesIncluded: boolean;
  sourceCoverage: "full" | "partial";
};

type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
type SearchIntent = "symbol" | "text" | "path";
type SearchMatch = "exact" | "prefix" | "contains" | "regex";

export type SearchScope = {
  packagePrefix?: string;
  fileGlob?: string;
  symbolKind?: SymbolKind;
};

export type SearchResultSymbol = {
  symbolKind: SymbolKind;
  symbolName: string;
  qualifiedName?: string;
  line: number;
};

export type SearchSourceHit = {
  filePath: string;
  score: number;
  matchedIn: "symbol" | "path" | "content";
  reasonCodes: string[];
  symbol?: SearchResultSymbol;
};

export type QueryMode = "auto" | "token" | "literal";

export type SearchClassSourceInput = {
  artifactId: string;
  query: string;
  intent?: SearchIntent;
  match?: SearchMatch;
  scope?: SearchScope;
  queryMode?: QueryMode;
  limit?: number;
  cursor?: string;
  queryNamespace?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
};

export type SearchClassSourceOutput = {
  hits: SearchSourceHit[];
  nextCursor?: string;
  mappingApplied: SourceMapping;
  returnedNamespace: SourceMapping;
  artifactContents: ArtifactContentsSummary;
  translatedQuery?: {
    original: string;
    translated: string;
    fromNamespace: SourceMapping;
    toNamespace: SourceMapping;
  };
  warnings?: string[];
};

export type GetArtifactFileInput = {
  artifactId: string;
  filePath: string;
  maxBytes?: number;
};

export type GetArtifactFileOutput = {
  filePath: string;
  content: string;
  contentBytes: number;
  truncated: boolean;
  mappingApplied: SourceMapping;
  returnedNamespace: SourceMapping;
  artifactContents: ArtifactContentsSummary;
};

export type ListArtifactFilesInput = {
  artifactId: string;
  prefix?: string;
  limit?: number;
  cursor?: string;
};

export type ListArtifactFilesOutput = {
  items: string[];
  nextCursor?: string;
  mappingApplied: SourceMapping;
  artifactContents: ArtifactContentsSummary;
  warnings: string[];
};

export type FindMappingInput = MappingFindMappingInput;
export type FindMappingOutput = MappingFindMappingOutput;
export type ResolveMethodMappingExactInput = MappingResolveMethodMappingExactInput;
export type ResolveMethodMappingExactOutput = MappingResolveMethodMappingExactOutput;
export type GetClassApiMatrixInput = MappingClassApiMatrixInput;
export type GetClassApiMatrixOutput = MappingClassApiMatrixOutput;
export type CheckSymbolExistsInput = MappingSymbolExistenceInput;
export type CheckSymbolExistsOutput = MappingSymbolExistenceOutput;

export type WorkspaceSymbolKind = "class" | "field" | "method";

export type ResolveWorkspaceSymbolInput = {
  projectPath: string;
  version: string;
  kind: WorkspaceSymbolKind;
  name: string;
  owner?: string;
  descriptor?: string;
  sourceMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  maxCandidates?: number;
};

export type ResolveWorkspaceSymbolOutput = MappingSymbolResolutionOutput & {
  workspaceDetection: WorkspaceCompileMappingOutput;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const VERSION_TOKEN_REGEX_CACHE = new Map<string, RegExp>();
const GLOB_REGEX_CACHE = new Map<string, RegExp>();
const MAX_HELPER_REGEX_CACHE = 128;

function rememberCachedRegex(cache: Map<string, RegExp>, key: string, regex: RegExp): RegExp {
  if (cache.size >= MAX_HELPER_REGEX_CACHE) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, regex);
  return regex;
}

function truncateUtf8ToMaxBytes(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content, "utf8");
  if (encoded.length <= maxBytes) {
    return content;
  }

  let end = Math.max(0, Math.min(maxBytes, encoded.length));
  while (end > 0) {
    try {
      const decoded = utf8Decoder.decode(encoded.subarray(0, end));
      return decoded;
    } catch {
      end -= 1;
    }
  }

  return "";
}

function dedupeQualityFlags(qualityFlags: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const qualityFlag of qualityFlags) {
    if (seen.has(qualityFlag)) {
      continue;
    }
    seen.add(qualityFlag);
    deduped.push(qualityFlag);
  }
  return deduped;
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function sameScopeFallback(
  left: MixinValidationProvenance["scopeFallback"] | undefined,
  right: MixinValidationProvenance["scopeFallback"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.requested === right.requested && left.applied === right.applied && left.reason === right.reason;
}

function sameResolutionTrace(
  left: MixinValidationProvenance["resolutionTrace"] | undefined,
  right: MixinValidationProvenance["resolutionTrace"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (!leftEntry || !rightEntry) {
      return false;
    }
    if (
      leftEntry.target !== rightEntry.target ||
      leftEntry.step !== rightEntry.step ||
      leftEntry.input !== rightEntry.input ||
      leftEntry.output !== rightEntry.output ||
      leftEntry.success !== rightEntry.success ||
      leftEntry.detail !== rightEntry.detail
    ) {
      return false;
    }
  }
  return true;
}

function sameMixinValidationProvenance(
  left: MixinValidationProvenance | undefined,
  right: MixinValidationProvenance | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.version === right.version &&
    left.jarPath === right.jarPath &&
    left.requestedMapping === right.requestedMapping &&
    left.mappingApplied === right.mappingApplied &&
    left.requestedScope === right.requestedScope &&
    left.appliedScope === right.appliedScope &&
    left.requestedSourcePriority === right.requestedSourcePriority &&
    left.appliedSourcePriority === right.appliedSourcePriority &&
    sameStringArray(left.resolutionNotes, right.resolutionNotes) &&
    left.jarType === right.jarType &&
    sameStringArray(left.mappingChain, right.mappingChain) &&
    left.remapFailures === right.remapFailures &&
    left.mappingAutoDetected === right.mappingAutoDetected &&
    sameScopeFallback(left.scopeFallback, right.scopeFallback) &&
    sameResolutionTrace(left.resolutionTrace, right.resolutionTrace)
  );
}

export type SourceMode = "metadata" | "snippet" | "full";

export type GetClassSourceInput = {
  artifactId?: string;
  target?: ResolveArtifactTargetInput;
  className: string;
  mode?: SourceMode;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxChars?: number;
  outputFile?: string;
};

export type GetClassSourceOutput = {
  className: string;
  mode: SourceMode;
  sourceText: string;
  totalLines: number;
  returnedRange: {
    start: number;
    end: number;
  };
  truncated: boolean;
  charsTruncated?: boolean;
  origin: ResolvedSourceArtifact["origin"];
  artifactId: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  returnedNamespace: SourceMapping;
  provenance: ArtifactProvenance;
  qualityFlags: string[];
  artifactContents: ArtifactContentsSummary;
  outputFile?: string;
  warnings: string[];
};

export type FindClassInput = {
  className: string;
  artifactId: string;
  limit?: number;
};

export type FindClassMatch = {
  qualifiedName: string;
  filePath: string;
  line: number;
  symbolKind: string;
};

export type FindClassOutput = {
  matches: FindClassMatch[];
  total: number;
  warnings: string[];
};

type MemberAccess = "public" | "all";

export type GetClassMembersInput = {
  artifactId?: string;
  target?: ResolveArtifactTargetInput;
  className: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  access?: MemberAccess;
  includeSynthetic?: boolean;
  includeInherited?: boolean;
  memberPattern?: string;
  maxMembers?: number;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
};

export type DecompiledMember = {
  name: string;
  line: number;
  kind: "constructor" | "field" | "method";
};

export type DecompiledFallback = {
  constructors: DecompiledMember[];
  fields: DecompiledMember[];
  methods: DecompiledMember[];
  origin: "source-extracted";
};

export type GetClassMembersOutput = {
  className: string;
  members: {
    constructors: SignatureMember[];
    fields: SignatureMember[];
    methods: SignatureMember[];
  };
  counts: {
    constructors: number;
    fields: number;
    methods: number;
    total: number;
  };
  truncated: boolean;
  context: ExplorerResponseContext;
  origin: ResolvedSourceArtifact["origin"];
  artifactId: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  returnedNamespace: SourceMapping;
  provenance: ArtifactProvenance;
  qualityFlags: string[];
  artifactContents: ArtifactContentsSummary;
  decompiledFallback?: DecompiledFallback;
  decompiledMemberCounts?: {
    constructors: number;
    fields: number;
    methods: number;
    total: number;
  };
  warnings: string[];
};

export type TraceSymbolLifecycleInput = {
  symbol: string;
  descriptor?: string;
  fromVersion?: string;
  toVersion?: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  includeSnapshots?: boolean;
  maxVersions?: number;
  includeTimeline?: boolean;
};

export type TraceSymbolLifecycleTimelineEntry = {
  version: string;
  exists: boolean;
  reason?: "class-not-found" | "descriptor-mismatch" | "unresolved";
};

export type TraceSymbolLifecycleOutput = {
  query: {
    className: string;
    methodName: string;
    descriptor?: string;
    mapping: SourceMapping;
  };
  range: {
    fromVersion: string;
    toVersion: string;
    scannedCount: number;
  };
  presence: {
    firstSeen?: string;
    lastSeen?: string;
    missingBetween: string[];
    existsNow: boolean;
  };
  timeline?: TraceSymbolLifecycleTimelineEntry[];
  warnings: string[];
};

type DiffClassChange = "added" | "removed" | "present_in_both" | "absent_in_both";

type DiffMemberChangedField = "accessFlags" | "isSynthetic" | "javaSignature" | "jvmDescriptor";

export type DiffMember = SignatureMember;

export type DiffMemberChange = {
  key: string;
  changed: DiffMemberChangedField[];
  from?: DiffMember;
  to?: DiffMember;
};

export type DiffClassMemberDelta = {
  added: DiffMember[];
  removed: DiffMember[];
  modified: DiffMemberChange[];
};

export type DiffClassSignaturesInput = {
  className: string;
  fromVersion: string;
  toVersion: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  includeFullDiff?: boolean;
};

export type DiffClassSignaturesOutput = {
  query: {
    className: string;
    fromVersion: string;
    toVersion: string;
    mapping: SourceMapping;
  };
  range: {
    fromVersion: string;
    toVersion: string;
  };
  classChange: DiffClassChange;
  constructors: DiffClassMemberDelta;
  methods: DiffClassMemberDelta;
  fields: DiffClassMemberDelta;
  summary: {
    constructors: {
      added: number;
      removed: number;
      modified: number;
    };
    methods: {
      added: number;
      removed: number;
      modified: number;
    };
    fields: {
      added: number;
      removed: number;
      modified: number;
    };
    total: {
      added: number;
      removed: number;
      modified: number;
    };
  };
  warnings: string[];
};

export type IndexArtifactInput = {
  artifactId: string;
  force?: boolean;
};

type IndexRebuildReason =
  | "force"
  | "missing_meta"
  | "schema_mismatch"
  | "signature_mismatch"
  | "already_current";

export type IndexArtifactOutput = {
  artifactId: string;
  reindexed: boolean;
  reason: IndexRebuildReason;
  counts: {
    files: number;
    symbols: number;
    ftsRows: number;
  };
  indexedAt: string;
  durationMs: number;
  mappingApplied: SourceMapping;
};

export type ValidateMixinInput = {
  input:
    | {
        mode: "inline";
        source: string;
      }
    | {
        mode: "path";
        path: string;
      }
    | {
        mode: "paths";
        paths: string[];
      }
    | {
        mode: "config";
        configPaths: string[];
      }
    | {
        mode: "project";
        path: string;
      };
  sourceRoots?: string[];
  version: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  scope?: ArtifactScope;
  projectPath?: string;
  preferProjectVersion?: boolean;
  minSeverity?: "error" | "warning" | "all";
  hideUncertain?: boolean;
  explain?: boolean;
  warningMode?: "full" | "aggregated";
  preferProjectMapping?: boolean;
  reportMode?: "compact" | "full" | "summary-first";
  warningCategoryFilter?: ("mapping" | "configuration" | "validation" | "resolution" | "parse")[];
  treatInfoAsWarning?: boolean;
  includeIssues?: boolean;
};

export type ValidateMixinOptions = {
  stageEmitter?: StageEmitter;
  /** Test-only override for stage budgets. Production code uses defaults. */
  __stageBudgets?: Partial<MixinStageBudgets>;
  /** Test-only hooks injected at stage boundaries to simulate slow work. */
  __testHooks?: {
    afterResolve?: () => Promise<void>;
    afterMappingHealth?: () => Promise<void>;
    afterParse?: () => Promise<void>;
    beforeTargetLoop?: () => Promise<void>;
    beforeTargetIter?: (targetIndex: number) => Promise<void>;
  };
};

export type ValidateMixinResultSource = {
  kind: "inline" | "path" | "config";
  label: string;
  path?: string;
  configPath?: string;
};

export type ValidateMixinBatchResult = {
  source: ValidateMixinResultSource;
  result?: MixinValidationResult;
  error?: string;
  /** Stable error code from AppError when the entry failed with a typed error (e.g. ERR_STAGE_BUDGET_PRE_PARSE). */
  errorCode?: string;
  /** AppError details (failedStage, stageBudgetExhausted, budgetMs, elapsedMs, …) preserved across batch aggregation. */
  errorDetails?: Record<string, unknown>;
};

export type ValidateMixinBatchIssueSummaryItem = {
  kind: string;
  confidence: string;
  category: string;
  count: number;
  sampleTargets: string[];
};

export type ValidateMixinOutput = {
  mode: ValidateMixinInput["input"]["mode"];
  results: ValidateMixinBatchResult[];
  summary: {
    total: number;
    valid: number;
    partial: number;
    invalid: number;
    processingErrors: number;
    totalValidationErrors: number;
    totalValidationWarnings: number;
  };
  issueSummary?: ValidateMixinBatchIssueSummaryItem[];
  provenance?: MixinValidationProvenance;
  incompleteReasons?: string[];
  toolHealth?: MappingHealthReport;
  confidenceScore?: number;
  warnings: string[];
};

type ValidateMixinSingleInput = Omit<ValidateMixinInput, "input"> & {
  source?: string;
  sourcePath?: string;
  batchCaches?: {
    classMappings: Map<string, Promise<MappingFindMappingOutput>>;
  };
  retryState?: {
    attempted: boolean;
    initialSourcePriority: MappingSourcePriority;
  };
  stageEmitter?: StageEmitter;
  __stageBudgets?: Partial<MixinStageBudgets>;
  __testHooks?: ValidateMixinOptions["__testHooks"];
};

type ValidateMixinConfigSource = {
  sourcePath: string;
  configPath: string;
};

type ResolvedValidateMixinConfigSources = {
  sources: ValidateMixinConfigSource[];
  warnings: string[];
};

/**
 * Diagnostic tag attached to every AppError thrown out of validate-mixin.
 * - "input-validation": required field missing or sourcePath unreadable
 * - "resolve": jar / artifact resolution (versionService, resolveArtifact, workspace detection)
 * - "mapping-health": mapping infrastructure probe (checkMappingHealth)
 * - "parse": parseMixinSource failure
 * - "target-lookup": per-target symbol/signature/remap loop
 */
type ValidateMixinStage =
  | "input-validation"
  | "resolve"
  | "mapping-health"
  | "parse"
  | "target-lookup";

function annotateValidateMixinError(err: unknown, stage: ValidateMixinStage): AppError {
  if (isAppError(err)) {
    const existing = (err.details ?? {}) as Record<string, unknown>;
    if (typeof existing.failedStage === "string") {
      // A nested call already tagged this error (e.g. input-validation). Preserve it.
      return err;
    }
    return createError({
      code: err.code,
      message: err.message,
      details: { ...existing, failedStage: stage }
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return createError({
    code: ERROR_CODES.INTERNAL,
    message: `validate-mixin failed during stage "${stage}": ${message}`,
    details: { failedStage: stage }
  });
}

export type ValidateAccessWidenerInput = {
  content: string;
  version: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
};

export type ValidateAccessWidenerOutput = AccessWidenerValidationResult;

export type ValidateAccessTransformerInput = {
  content: string;
  version: string;
  atNamespace?: AccessTransformerNamespace;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
};

export type ValidateAccessTransformerOutput = AccessTransformerValidationResult;

interface IndexedFileRecord {
  filePath: string;
  content: string;
  contentBytes: number;
  contentHash: string;
}

interface RebuiltArtifactData {
  files: IndexedFileRecord[];
  symbols: Array<{
    filePath: string;
    symbolKind: string;
    symbolName: string;
    qualifiedName: string | undefined;
    line: number;
  }>;
  indexedAt: string;
  indexDurationMs: number;
  totalContentBytes: number;
}

const INDEX_SCHEMA_VERSION = 1;

interface IndexedSymbolHit {
  symbol: SymbolRow;
  score: number;
  matchIndex: number;
}

interface LifecycleScanEntry {
  version: string;
  exists: boolean;
  reason?: TraceSymbolLifecycleTimelineEntry["reason"];
  determinate: boolean;
}

type SignatureSnapshot = {
  constructors: SignatureMember[];
  fields: SignatureMember[];
  methods: SignatureMember[];
  warnings: string[];
};

const SYMBOL_KINDS: SymbolKind[] = ["class", "interface", "enum", "record", "method", "field"];

function isSymbolKind(value: string): value is SymbolKind {
  return SYMBOL_KINDS.includes(value as SymbolKind);
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

const MAX_REGEX_QUERY_LENGTH = 200;
const MAX_REGEX_RESULT_LIMIT = 100;
const TRACE_LIFECYCLE_MAX_CONCURRENCY = 3;

type VersionSourceCandidate = {
  jarPath: string;
  javaEntryCount: number;
  hasMinecraftNamespace: boolean;
  looksLikeMinecraftArtifact: boolean;
  score: number;
};

type VersionSourceDiscovery = {
  searchedPaths: string[];
  candidateArtifacts: string[];
  selectedSourceJarPath?: string;
  selectedHasMinecraftNamespace?: boolean;
};

type RuntimeJarCandidate = {
  jarPath: string;
  score: number;
  appliedScope: ArtifactScope;
  origin: RuntimeValidationProvenance["origin"];
  namespaceHint?: "intermediary" | "mojang" | "named";
};

function normalizePathStyle(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactVersionToken(path: string, version: string): boolean {
  const normalizedPath = normalizePathStyle(path).toLowerCase();
  const normalizedVersion = version.trim().toLowerCase();
  if (!normalizedVersion) {
    return false;
  }
  // Avoid prefix false-positives like "1.21.1" matching "1.21.10".
  const cached = VERSION_TOKEN_REGEX_CACHE.get(normalizedVersion);
  const pattern =
    cached
    ?? rememberCachedRegex(
      VERSION_TOKEN_REGEX_CACHE,
      normalizedVersion,
      new RegExp(`(^|[^0-9a-z])${escapeRegexLiteral(normalizedVersion)}([^0-9a-z]|$)`, "i")
    );
  return pattern.test(normalizedPath);
}

function inferMergedRuntimeNamespaceHint(
  path: string
): RuntimeJarCandidate["namespaceHint"] {
  const normalizedPath = normalizePathStyle(path).toLowerCase();
  if (
    normalizedPath.includes("merged-intermediary-v2") ||
    normalizedPath.includes("merged-intermediary")
  ) {
    return "intermediary";
  }
  if (
    normalizedPath.includes("minecraft-merged-mojang") ||
    normalizedPath.includes("merged-mojang")
  ) {
    return "mojang";
  }
  if (normalizedPath.includes("merged-named")) {
    return "named";
  }
  return undefined;
}

function runtimeJarNamespaceHintScore(hint: RuntimeJarCandidate["namespaceHint"]): number {
  if (hint === "intermediary" || hint === "mojang") {
    return 8_000;
  }
  if (hint === "named") {
    return 1_000;
  }
  return 0;
}

function looksLikeDeobfuscatedClassName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("net.minecraft.") || trimmed.startsWith("com.mojang.")) {
    return true;
  }
  const simpleName = trimmed.split(/[.$]/).at(-1) ?? trimmed;
  return /^[A-Z][A-Za-z0-9_$]{2,}$/.test(simpleName);
}

function obfuscatedNamespaceHint(className: string): string {
  return `Artifact is indexed in obfuscated runtime names. Deobfuscated names like "${className}" usually require mapping="mojang" or a find-mapping lookup to obfuscated names.`;
}

function hasPartialNetMinecraftCoverage(qualityFlags: string[]): boolean {
  return qualityFlags.includes("partial-source-no-net-minecraft");
}

function buildResolveArtifactParams(
  target: SourceTargetInput,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    target: {
      kind: target.kind,
      value: target.value
    },
    ...extra
  };
}

function looksLikeClassSegment(name: string): boolean {
  const trimmed = name.trim();
  return /^[A-Z_$]/.test(trimmed);
}

function looksLikeJvmMethodDescriptor(descriptor: string | undefined): boolean {
  const trimmed = descriptor?.trim();
  if (!trimmed || !trimmed.startsWith("(")) {
    return false;
  }
  const closing = trimmed.indexOf(")");
  return closing > 0 && closing < trimmed.length - 1;
}

function looksLikeMinecraftSourceArtifact(path: string, hasMinecraftNamespace: boolean): boolean {
  if (hasMinecraftNamespace) {
    return true;
  }

  const normalizedPath = normalizePathStyle(path).toLowerCase();
  return (
    normalizedPath.includes("/minecraftmaven/") ||
    normalizedPath.includes("/net/minecraft/") ||
    /(?:^|\/)minecraft(?:-[a-z0-9._+]+)*-sources\.jar$/i.test(normalizedPath) ||
    normalizedPath.includes("minecraft-merged") ||
    normalizedPath.includes("minecraft-common") ||
    normalizedPath.includes("minecraft-clientonly") ||
    normalizedPath.includes("minecraft-client") ||
    normalizedPath.includes("minecraft-server")
  );
}

function normalizeRequestedArtifactScope(scope: ArtifactScope | undefined): ArtifactScope {
  return scope ?? "vanilla";
}

function inferAppliedArtifactScope(input: {
  requestedScope: ArtifactScope;
  scopeFallback?: { applied: string };
  jarPath: string;
  resolvedSourceJarPath?: string;
}): ArtifactScope {
  if (input.scopeFallback?.applied === "vanilla") {
    return "vanilla";
  }
  if (input.requestedScope === "vanilla") {
    return "vanilla";
  }

  const joinedPath = `${normalizePathStyle(input.jarPath)} ${normalizePathStyle(input.resolvedSourceJarPath ?? "")}`.toLowerCase();
  if (joinedPath.includes("minecraft-merged")) {
    return "merged";
  }
  if (input.requestedScope === "loader" && joinedPath.includes("merged")) {
    return "merged";
  }
  return input.requestedScope;
}

function scopeToJarType(scope: ArtifactScope): "vanilla-client" | "merged" | "loader" {
  if (scope === "vanilla") {
    return "vanilla-client";
  }
  return scope;
}

function parseQualifiedMethodSymbol(symbol: string): {
  className: string;
  methodName: string;
  inlineDescriptor?: string;
} {
  const trimmed = symbol.trim();
  const descriptorStart = trimmed.indexOf("(");
  const qualifiedSymbol = descriptorStart >= 0 ? trimmed.slice(0, descriptorStart) : trimmed;
  const inlineDescriptor = descriptorStart >= 0 ? trimmed.slice(descriptorStart).trim() : undefined;
  const separator = qualifiedSymbol.lastIndexOf(".");
  if (separator <= 0 || separator >= qualifiedSymbol.length - 1) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: { symbol }
    });
  }

  const className = qualifiedSymbol.slice(0, separator);
  const methodName = qualifiedSymbol.slice(separator + 1);
  if (
    !className ||
    !methodName ||
    className.includes("/") ||
    methodName.includes(".") ||
    /\s/.test(methodName)
  ) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: { symbol }
    });
  }

  return {
    className,
    methodName,
    ...(inlineDescriptor ? { inlineDescriptor } : {})
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStrictPositiveInt(
  value: number | undefined,
  field: string
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `${field} must be a positive integer.`,
      details: {
        field,
        value
      }
    });
  }
  return value;
}

const COMMON_SOURCE_ROOTS = [
  "src/main/java",
  "src/client/java",
  "common/src/main/java",
  "common/src/client/java",
  "fabric/src/main/java",
  "fabric/src/client/java",
  "neoforge/src/main/java",
  "neoforge/src/client/java",
  "forge/src/main/java",
  "forge/src/client/java",
  "quilt/src/main/java",
  "quilt/src/client/java"
] as const;

const MIXIN_PROJECT_DISCOVERY_IGNORES = [
  "**/.git/**",
  "**/.gradle/**",
  "**/build/**",
  "**/out/**",
  "**/node_modules/**"
] as const;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
  if (mapping == null) {
    return "obfuscated";
  }
  if (
    mapping === "obfuscated" ||
    mapping === "mojang" ||
    mapping === "intermediary" ||
    mapping === "yarn"
  ) {
    return mapping;
  }
  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Unsupported mapping "${mapping}".`,
    details: {
      mapping,
      nextAction: "Try mapping=obfuscated which is always available.",
      suggestedCall: { tool: "resolve-artifact", params: { mapping: "obfuscated" } }
    }
  });
}

function normalizeAccessWidenerNamespace(namespace: string | undefined): SourceMapping | undefined {
  const normalized = namespace?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "named") {
    return "yarn";
  }
  if (
    normalized === "obfuscated" ||
    normalized === "mojang" ||
    normalized === "intermediary" ||
    normalized === "yarn"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeAccessTransformerNamespace(
  namespace: AccessTransformerNamespace | string | undefined
): AccessTransformerNamespace | undefined {
  const normalized = namespace?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "srg" || normalized === "mojang" || normalized === "obfuscated") {
    return normalized;
  }
  return undefined;
}

function isSourceMappingNamespace(
  namespace: SourceMapping | AccessTransformerNamespace
): namespace is SourceMapping {
  return namespace === "obfuscated" || namespace === "mojang" || namespace === "intermediary" || namespace === "yarn";
}

function normalizeMemberAccess(access: MemberAccess | undefined): MemberAccess {
  if (access == null) {
    return "public";
  }
  if (access === "public" || access === "all") {
    return access;
  }
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: `access must be "public" or "all".`,
    details: { access }
  });
}

function sortDiffMembers(members: DiffMember[]): DiffMember[] {
  return [...members].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const descriptorCompare = left.jvmDescriptor.localeCompare(right.jvmDescriptor);
    if (descriptorCompare !== 0) {
      return descriptorCompare;
    }

    return left.ownerFqn.localeCompare(right.ownerFqn);
  });
}

function sortDiffMemberChanges(changes: DiffMemberChange[]): DiffMemberChange[] {
  return [...changes].sort((left, right) => {
    const keyCompare = left.key.localeCompare(right.key);
    if (keyCompare !== 0) {
      return keyCompare;
    }

    const fromOwnerCompare = (left.from?.ownerFqn ?? "").localeCompare(right.from?.ownerFqn ?? "");
    if (fromOwnerCompare !== 0) {
      return fromOwnerCompare;
    }

    return (left.to?.ownerFqn ?? "").localeCompare(right.to?.ownerFqn ?? "");
  });
}

function changedMemberFields(
  fromMember: DiffMember,
  toMember: DiffMember,
  includeDescriptor: boolean
): DiffMemberChangedField[] {
  const changed: DiffMemberChangedField[] = [];

  if (fromMember.accessFlags !== toMember.accessFlags) {
    changed.push("accessFlags");
  }
  if (fromMember.isSynthetic !== toMember.isSynthetic) {
    changed.push("isSynthetic");
  }
  if (fromMember.javaSignature !== toMember.javaSignature) {
    changed.push("javaSignature");
  }
  if (includeDescriptor && fromMember.jvmDescriptor !== toMember.jvmDescriptor) {
    changed.push("jvmDescriptor");
  }

  return changed;
}

function diffMembersByKey(
  fromMembersInput: DiffMember[],
  toMembersInput: DiffMember[],
  buildKey: (member: DiffMember) => string,
  includeDescriptorInModified: boolean
): DiffClassMemberDelta {
  const fromMembers = sortDiffMembers(fromMembersInput);
  const toMembers = sortDiffMembers(toMembersInput);
  const fromByKey = new Map<string, DiffMember>();
  const toByKey = new Map<string, DiffMember>();

  for (const member of fromMembers) {
    const key = buildKey(member);
    if (!fromByKey.has(key)) {
      fromByKey.set(key, member);
    }
  }
  for (const member of toMembers) {
    const key = buildKey(member);
    if (!toByKey.has(key)) {
      toByKey.set(key, member);
    }
  }

  const added: DiffMember[] = [];
  const removed: DiffMember[] = [];
  const modified: DiffMemberChange[] = [];

  for (const [key, toMember] of toByKey.entries()) {
    const fromMember = fromByKey.get(key);
    if (!fromMember) {
      added.push(toMember);
      continue;
    }

    const changed = changedMemberFields(fromMember, toMember, includeDescriptorInModified);
    if (changed.length > 0) {
      modified.push({
        key,
        from: fromMember,
        to: toMember,
        changed
      });
    }
  }

  for (const [key, fromMember] of fromByKey.entries()) {
    if (!toByKey.has(key)) {
      removed.push(fromMember);
    }
  }

  return {
    added: sortDiffMembers(added),
    removed: sortDiffMembers(removed),
    modified: sortDiffMemberChanges(modified)
  };
}

function emptyDiffDelta(): DiffClassMemberDelta {
  return {
    added: [],
    removed: [],
    modified: []
  };
}

function compactDiffDelta(delta: DiffClassMemberDelta): DiffClassMemberDelta {
  return {
    added: delta.added,
    removed: delta.removed,
    modified: delta.modified.map((change) => ({
      key: change.key,
      changed: [...change.changed]
    }))
  };
}

function normalizeIntent(intent: SearchIntent | undefined): SearchIntent {
  if (intent === "path" || intent === "text") {
    return intent;
  }
  return "symbol";
}

function normalizeMatch(match: SearchMatch | undefined): SearchMatch {
  if (match === "exact" || match === "contains" || match === "regex") {
    return match;
  }
  return "prefix";
}

function canUseIndexedSearchPath(
  indexedSearchEnabled: boolean,
  intent: SearchIntent,
  match: SearchMatch,
  _scope: SearchScope | undefined
): boolean {
  if (!indexedSearchEnabled) {
    return false;
  }
  if (intent !== "text" && intent !== "path") {
    return false;
  }
  if (match === "regex") {
    return false;
  }

  // packagePrefix and fileGlob are applied as post-filters on indexed candidates.
  return true;
}

function buildGlobRegex(pattern: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(pattern);
  if (cached) {
    GLOB_REGEX_CACHE.delete(pattern);
    GLOB_REGEX_CACHE.set(pattern, cached);
    return cached;
  }

  const REGEX_META = /[-/\\^$+.()|[\]{}]/;
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      result += ".*";
      i += 2;
      if (pattern[i] === "/") {
        result += "(?:/)?";
        i += 1;
      }
    } else if (ch === "*") {
      result += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      result += "[^/]";
      i += 1;
    } else {
      result += REGEX_META.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return rememberCachedRegex(GLOB_REGEX_CACHE, pattern, new RegExp(`^${result}$`));
}

function globToSqlLike(pattern: string): string {
  let result = "";
  for (const char of pattern) {
    if (char === "*") {
      result += "%";
      continue;
    }
    if (char === "?") {
      result += "_";
      continue;
    }
    if (char === "%" || char === "_" || char === "\\") {
      result += `\\${char}`;
      continue;
    }
    result += char;
  }
  return result;
}

function isPackageCompatible(filePath: string, classPath: string): boolean {
  const lastSlash = classPath.lastIndexOf("/");
  if (lastSlash < 0) return true;
  const expectedPrefix = classPath.slice(0, lastSlash + 1);
  return filePath.startsWith(expectedPrefix);
}

function classNameToClassPath(className: string): string {
  const normalized = normalizePathStyle(className.trim()).replace(/\//g, ".");
  const segments = normalized.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "";
  }

  const firstTypeSegment = segments.findIndex((segment) => /^[A-Z_$]/.test(segment));
  if (firstTypeSegment < 0) {
    return segments.join("/");
  }

  const packagePath = segments.slice(0, firstTypeSegment).join("/");
  const typePath = segments.slice(firstTypeSegment).join("$");
  return packagePath ? `${packagePath}/${typePath}` : typePath;
}

function checkPackagePrefix(filePath: string, packagePrefix?: string): boolean {
  if (!packagePrefix) {
    return true;
  }

  const normalizedPrefix = packagePrefix.replace(/\.+/g, "/").replace(/\/+$/, "");
  return normalizePathStyle(filePath).startsWith(`${normalizedPrefix}/`);
}

function buildSearchCursorContext(input: {
  artifactId: string;
  query: string;
  intent: SearchIntent;
  match: SearchMatch;
  queryMode: QueryMode;
  scope: SearchScope | undefined;
}): string {
  return JSON.stringify({
    artifactId: input.artifactId,
    query: input.query,
    intent: input.intent,
    match: input.match,
    queryMode: input.queryMode,
    packagePrefix: input.scope?.packagePrefix ?? "",
    fileGlob: input.scope?.fileGlob ?? "",
    symbolKind: input.scope?.symbolKind ?? ""
  });
}

function toLower(value: string): string {
  return value.toLocaleLowerCase();
}

function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Invalid regex query.",
      details: { query }
    });
  }
}

function findMatchIndex(target: string, query: string, match: SearchMatch, pattern?: RegExp): number {
  if (!query) {
    return -1;
  }

  if (match === "regex") {
    if (!pattern) {
      return -1;
    }
    pattern.lastIndex = 0;
    const result = pattern.exec(target);
    return result?.index ?? -1;
  }

  if (match === "exact") {
    return target === query ? 0 : -1;
  }

  const normalizedTarget = toLower(target);
  const normalizedQuery = toLower(query);

  if (match === "prefix") {
    return normalizedTarget.startsWith(normalizedQuery) ? 0 : -1;
  }

  return normalizedTarget.indexOf(normalizedQuery);
}

/**
 * Content-aware variant of findMatchIndex for searching within file text.
 * Unlike findMatchIndex (designed for short identifiers/paths), this handles:
 * - exact: case-sensitive substring search (indexOf)
 * - prefix: case-insensitive substring search (same as contains for content)
 * - contains: case-insensitive substring search
 * - regex: delegated to pattern.exec
 */
function findContentMatchIndex(content: string, query: string, match: SearchMatch, pattern?: RegExp): number {
  if (!query) {
    return -1;
  }

  if (match === "regex") {
    if (!pattern) {
      return -1;
    }
    pattern.lastIndex = 0;
    const result = pattern.exec(content);
    return result?.index ?? -1;
  }

  if (match === "exact") {
    return content.indexOf(query);
  }

  const normalizedContent = toLower(content);
  const normalizedQuery = toLower(query);
  return normalizedContent.indexOf(normalizedQuery);
}

function scoreSymbolMatch(match: SearchMatch, index: number, symbolKind: SymbolKind): number {
  const matchBase =
    match === "exact" ? 350 : match === "prefix" ? 310 : match === "contains" ? 270 : 250;
  const kindBonus =
    symbolKind === "class" || symbolKind === "interface" || symbolKind === "record"
      ? 25
      : symbolKind === "enum"
        ? 20
        : symbolKind === "method"
          ? 15
          : 8;

  return matchBase + kindBonus + Math.max(0, 80 - Math.min(80, index));
}

function scoreTextMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 280 : match === "prefix" ? 250 : match === "contains" ? 220 : 200;
  return matchBase + Math.max(0, 90 - Math.min(90, Math.floor(index / 2)));
}

function scorePathMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 260 : match === "prefix" ? 230 : match === "contains" ? 210 : 190;
  return matchBase + Math.max(0, 100 - Math.min(100, index));
}

function matchRegexIndex(target: string, regex: RegExp): number {
  regex.lastIndex = 0;
  const result = regex.exec(target);
  return result?.index ?? -1;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.trunc(chunkSize));
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class SourceService {
  private readonly config: Config;
  private readonly db;
  private readonly artifactsRepo: ArtifactsRepo;
  private readonly filesRepo: FilesRepo;
  private readonly indexMetaRepo: IndexMetaRepo;
  private readonly symbolsRepo: SymbolsRepo;
  private readonly metrics: RuntimeMetrics;
  private readonly versionService: VersionService;
  private readonly mappingService: MappingService;
  private readonly workspaceMappingService: WorkspaceMappingService;
  private readonly workspaceContextCache: WorkspaceContextCache;
  private readonly explorerService: MinecraftExplorerService;
  private readonly registryService: RegistryService;
  private readonly versionDiffService: VersionDiffService;
  private readonly modDecompileService: ModDecompileService;
  private readonly modSearchService: ModSearchService;
  private readonly lru = new LruList<{ totalContentBytes: number; updatedAt: string }>();
  private cacheTotalContentBytes = 0;
  private readonly remappedJarBytes = new Map<string, number>();
  /** In-flight binary-remap jobs keyed by remapped jar path so concurrent
   * resolveArtifact calls for the same artifactId share a single tiny-remapper run. */
  private readonly inflightRemaps = new Map<string, Promise<string>>();

  constructor(
    explicitConfig?: Config,
    metrics = new RuntimeMetrics(),
    deps: { workspaceContextCache?: WorkspaceContextCache } = {}
  ) {
    this.config = explicitConfig ?? loadConfig();
    this.metrics = metrics;
    this.versionService = new VersionService(this.config);
    this.mappingService = new MappingService(this.config, this.versionService);
    this.workspaceMappingService = new WorkspaceMappingService();
    this.workspaceContextCache = deps.workspaceContextCache ?? getProcessWorkspaceContextCache();
    this.explorerService = new MinecraftExplorerService(this.config);
    this.registryService = new RegistryService(this.config, this.versionService);
    this.versionDiffService = new VersionDiffService(this.config, this.versionService, this.registryService);
    this.modDecompileService = new ModDecompileService(this.config);
    this.modSearchService = new ModSearchService(this.modDecompileService);
    const initialized = openDatabase(this.config);
    this.db = initialized.db;
    this.artifactsRepo = new ArtifactsRepo(this.db);
    this.filesRepo = new FilesRepo(this.db);
    this.indexMetaRepo = new IndexMetaRepo(this.db);
    this.symbolsRepo = new SymbolsRepo(this.db);
    this.refreshCacheMetrics();
  }

  private async discoverVersionSourceJar(input: {
    version: string;
    projectPath?: string;
  }): Promise<VersionSourceDiscovery> {
    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    const searchRoots = buildVersionSourceSearchRoots(normalizedProjectPath);
    const searchedPaths: string[] = [];
    const candidates: VersionSourceCandidate[] = [];
    const seen = new Set<string>();

    for (const root of searchRoots) {
      searchedPaths.push(root);
      let discovered: string[] = [];
      try {
        discovered = await fastGlob.glob("**/*sources.jar", {
          cwd: root,
          absolute: true,
          onlyFiles: true
        });
      } catch {
        continue;
      }

      for (const candidatePath of discovered) {
        const normalizedPath = normalizePathStyle(candidatePath);
        if (seen.has(normalizedPath)) {
          continue;
        }
        seen.add(normalizedPath);
        const lower = normalizedPath.toLowerCase();
        if (!lower.includes(input.version.toLowerCase()) && !lower.includes("minecraft")) {
          continue;
        }

        let javaEntries: string[] = [];
        try {
          javaEntries = await listJavaEntries(normalizedPath);
        } catch {
          continue;
        }
        if (javaEntries.length === 0) {
          continue;
        }

        const hasMinecraftNamespace = javaEntries.some((entry) =>
          normalizePathStyle(entry).startsWith("net/minecraft/")
        );
        const looksLikeMinecraftArtifact = looksLikeMinecraftSourceArtifact(
          normalizedPath,
          hasMinecraftNamespace
        );
        const exactVersionMatch = hasExactVersionToken(normalizedPath, input.version);
        const score =
          (looksLikeMinecraftArtifact ? 20_000 : 0) +
          (hasMinecraftNamespace ? 10_000 : 0) +
          (lower.includes("minecraft-merged") ? 2_000 : 0) +
          (exactVersionMatch ? 1_000 : 0) +
          Math.min(javaEntries.length, 500);
        candidates.push({
          jarPath: normalizedPath,
          javaEntryCount: javaEntries.length,
          hasMinecraftNamespace,
          looksLikeMinecraftArtifact,
          score
        });
      }
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.jarPath.localeCompare(right.jarPath);
    });

    const selected =
      candidates.find((candidate) => candidate.looksLikeMinecraftArtifact && candidate.hasMinecraftNamespace) ??
      candidates.find((candidate) => candidate.looksLikeMinecraftArtifact);
    const candidateArtifacts = candidates
      .slice(0, 20)
      .map((candidate) => `${candidate.jarPath}#java=${candidate.javaEntryCount}#net_minecraft=${candidate.hasMinecraftNamespace ? 1 : 0}`);

    return {
      searchedPaths,
      candidateArtifacts,
      selectedSourceJarPath: selected?.jarPath,
      selectedHasMinecraftNamespace: selected?.hasMinecraftNamespace
    };
  }

  private async discoverAccessWidenerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    requestedScope: ArtifactScope;
  }): Promise<{ searchedPaths: string[]; candidateArtifacts: string[]; selected?: RuntimeJarCandidate }> {
    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    const normalizedProjectPathLower = normalizedProjectPath
      ? normalizePathStyle(normalizedProjectPath).toLowerCase()
      : undefined;
    const searchRoots = buildVersionSourceSearchRoots(normalizedProjectPath);
    const searchedPaths: string[] = [];
    const candidates: RuntimeJarCandidate[] = [];
    const seen = new Set<string>();

    for (const root of searchRoots) {
      searchedPaths.push(root);
      let discovered: string[] = [];
      try {
        discovered = await fastGlob.glob(["**/*minecraft*.jar", "**/*merged*.jar"], {
          cwd: root,
          absolute: true,
          onlyFiles: true,
          ignore: ["**/*sources.jar", "**/node_modules/**", "**/.git/**", "**/build/**", "**/out/**"]
        });
      } catch {
        continue;
      }

      for (const candidatePath of discovered) {
        const normalizedPath = normalizePathStyle(candidatePath);
        if (seen.has(normalizedPath)) {
          continue;
        }
        seen.add(normalizedPath);

        const lower = normalizedPath.toLowerCase();
        if (!lower.includes("minecraft")) {
          continue;
        }

        const exactVersionMatch = hasExactVersionToken(normalizedPath, input.version);
        const looksMerged = lower.includes("minecraft-merged") || lower.includes("/merged/") || lower.includes("-merged");
        const namespaceHint = inferMergedRuntimeNamespaceHint(normalizedPath);
        const appliedScope: ArtifactScope =
          looksMerged
            ? "merged"
            : input.requestedScope === "loader"
              ? "merged"
              : input.requestedScope;

        const score =
          (exactVersionMatch ? 5_000 : 0) +
          (looksMerged ? 4_000 : 0) +
          runtimeJarNamespaceHintScore(namespaceHint) +
          (normalizedProjectPathLower && lower.startsWith(normalizedProjectPathLower) ? 2_000 : 0) +
          (lower.includes("loom-cache") || lower.includes("/caches/fabric-loom/") ? 500 : 0) +
          (lower.includes("minecraft-client") || lower.includes("client") ? 100 : 0);

        candidates.push({
          jarPath: normalizedPath,
          score,
          appliedScope,
          origin:
            lower.includes("loom-cache") || lower.includes("/caches/fabric-loom/")
              ? "loom-cache"
              : "local-jar",
          namespaceHint
        });
      }
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.jarPath.localeCompare(right.jarPath);
    });

    return {
      searchedPaths,
      candidateArtifacts: candidates.slice(0, 20).map((candidate) => candidate.jarPath),
      selected: candidates[0]
    };
  }

  private async discoverAccessTransformerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    requestedScope: ArtifactScope;
    atNamespace: AccessTransformerNamespace;
    loader: WorkspaceProjectLoader | "unknown";
  }): Promise<{ searchedPaths: string[]; candidateArtifacts: string[]; selected?: RuntimeJarCandidate }> {
    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    const normalizedProjectPathLower = normalizedProjectPath
      ? normalizePathStyle(normalizedProjectPath).toLowerCase()
      : undefined;
    const searchRoots = buildLoaderRuntimeSearchRoots(normalizedProjectPath);
    const searchedPaths: string[] = [];
    const candidates: RuntimeJarCandidate[] = [];
    const seen = new Set<string>();

    const globs = [
      "**/*minecraft*.jar",
      "**/*patched*.jar",
      "**/*srg*.jar",
      "**/*joined*.jar",
      "**/*client-extra*.jar",
      "**/*forge*.jar",
      "**/*neoforge*.jar",
      "**/*moddev*.jar",
      "**/*neoform*.jar"
    ];

    for (const root of searchRoots) {
      searchedPaths.push(root);
      if (!(await pathExists(root))) {
        continue;
      }
      let discovered: string[] = [];
      try {
        discovered = await fastGlob.glob(globs, {
          cwd: root,
          absolute: true,
          onlyFiles: true,
          ignore: ["**/*sources.jar", "**/node_modules/**", "**/.git/**", "**/out/**"]
        });
      } catch {
        continue;
      }

      for (const candidatePath of discovered) {
        const normalizedPath = normalizePathStyle(candidatePath);
        if (seen.has(normalizedPath)) {
          continue;
        }
        seen.add(normalizedPath);

        const lower = normalizedPath.toLowerCase();
        if (!hasExactVersionToken(normalizedPath, input.version)) {
          continue;
        }

        const looksMerged = lower.includes("merged");
        const looksSrg = lower.includes("srg");
        const looksForge = lower.includes("forge");
        const looksNeoForge = lower.includes("neoforge") || lower.includes("moddev") || lower.includes("neoform");
        const looksPatchedRuntime = lower.includes("patched") || lower.includes("client-extra") || lower.includes("joined");
        const appliedScope: ArtifactScope =
          looksMerged
            ? "merged"
            : "loader";

        if (input.atNamespace === "srg" && !looksSrg) {
          continue;
        }
        if (input.loader === "forge" && !looksForge && !looksSrg && !looksPatchedRuntime) {
          continue;
        }
        if (input.loader === "neoforge" && !looksNeoForge && !looksPatchedRuntime && !lower.includes("minecraft")) {
          continue;
        }

        const score =
          10_000 +
          (normalizedProjectPathLower && lower.startsWith(normalizedProjectPathLower) ? 4_000 : 0) +
          (looksPatchedRuntime ? 3_000 : 0) +
          (looksSrg ? 2_500 : 0) +
          (input.loader === "forge" && looksForge ? 1_500 : 0) +
          (input.loader === "neoforge" && looksNeoForge ? 1_500 : 0) +
          (input.requestedScope === appliedScope ? 1_000 : 0) +
          (looksMerged ? -500 : 0);

        candidates.push({
          jarPath: normalizedPath,
          score,
          appliedScope,
          origin: "local-jar"
        });
      }
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.jarPath.localeCompare(right.jarPath);
    });

    return {
      searchedPaths,
      candidateArtifacts: candidates.slice(0, 20).map((candidate) => candidate.jarPath),
      selected: candidates[0]
    };
  }

  private async resolveAccessWidenerRuntimeArtifact(input: {
    version: string;
    awNamespace: SourceMapping;
    projectPath?: string;
    scope?: ArtifactScope;
    preferProjectVersion?: boolean;
  }): Promise<RuntimeValidationProvenance<SourceMapping>> {
    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    let version = input.version;
    if (input.preferProjectVersion && normalizedProjectPath) {
      const detected = await this.workspaceMappingService.detectProjectMinecraftVersion(normalizedProjectPath);
      version = detected ?? version;
    }

    const requestedScope: ArtifactScope = input.scope ?? (normalizedProjectPath ? "loader" : "vanilla");
    if (requestedScope === "vanilla") {
      const versionJar = await this.versionService.resolveVersionJar(version);
      return {
        version: versionJar.version,
        jarPath: versionJar.jarPath,
        requestedScope,
        appliedScope: "vanilla",
        requestedMapping: input.awNamespace,
        mappingApplied: "obfuscated",
        origin: "version-jar"
      };
    }

    const discovery = await this.discoverAccessWidenerRuntimeCandidates({
      version,
      projectPath: normalizedProjectPath,
      requestedScope
    });
    if (!discovery.selected) {
      throw createError({
        code: ERROR_CODES.CONTEXT_UNRESOLVED,
        message: "Could not resolve a runtime jar for Access Widener validation.",
        details: {
          version,
          requestedScope,
          projectPath: normalizedProjectPath,
          searchedPaths: discovery.searchedPaths,
          candidateArtifacts: discovery.candidateArtifacts,
          nextAction: "Provide projectPath for a Loom workspace with generated runtime jars, or run Gradle tasks that populate the Loom cache before retrying.",
          suggestedCall: {
            tool: "validate-access-widener",
            params: {
              version,
              scope: requestedScope,
              ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {})
            }
          }
        }
      });
    }

    const appliedScope = discovery.selected.appliedScope;
    const scopeFallback =
      requestedScope !== appliedScope
        ? {
            requested: requestedScope,
            applied: appliedScope,
            reason: requestedScope === "loader"
              ? "Fabric loader runtime validation currently reuses the merged runtime jar."
              : "Selected runtime jar matched a nearby merged artifact."
          }
        : undefined;

    let detectedMapping: "obfuscated" | "intermediary" | "mojang";
    const notes: string[] = [];
    if (scopeFallback) {
      notes.push(scopeFallback.reason);
    }
    if (isUnobfuscatedVersion(version)) {
      detectedMapping = "obfuscated";
    } else if (
      discovery.selected.namespaceHint === "intermediary" ||
      discovery.selected.namespaceHint === "mojang"
    ) {
      detectedMapping = discovery.selected.namespaceHint;
    } else {
      const detection = await detectFabricLikeInputNamespace(discovery.selected.jarPath);
      detectedMapping = detection.fromNamespace;
      if (detection.warnings.length > 0) {
        notes.push(...detection.warnings);
      }
    }

    return {
      version,
      jarPath: discovery.selected.jarPath,
      requestedScope,
      appliedScope,
      requestedMapping: input.awNamespace,
      mappingApplied: detectedMapping,
      origin: discovery.selected.origin,
      resolutionNotes: notes.length > 0 ? notes : undefined,
      scopeFallback
    };
  }

  private async resolveAccessTransformerNamespace(input: {
    atNamespace?: AccessTransformerNamespace;
    projectPath?: string;
  }): Promise<AccessTransformerNamespace> {
    const explicit = normalizeAccessTransformerNamespace(input.atNamespace);
    if (explicit) {
      return explicit;
    }

    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    if (!normalizedProjectPath) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "atNamespace is required when projectPath is not provided.",
        details: {
          nextAction: "Pass atNamespace explicitly, or provide projectPath for a Forge/NeoForge workspace so the namespace can be inferred."
        }
      });
    }

    const loaderDetection = await this.workspaceMappingService.detectProjectLoader(normalizedProjectPath);
    if (loaderDetection.resolved && loaderDetection.loader === "forge") {
      return "srg";
    }
    if (loaderDetection.resolved && loaderDetection.loader === "neoforge") {
      return "mojang";
    }

    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Could not infer atNamespace from the workspace.",
      details: {
        projectPath: normalizedProjectPath,
        evidence: loaderDetection.evidence,
        warnings: loaderDetection.warnings,
        nextAction: "Pass atNamespace explicitly, or point projectPath at a Forge/NeoForge workspace."
      }
    });
  }

  private async resolveAccessTransformerRuntimeArtifact(input: {
    version: string;
    atNamespace: AccessTransformerNamespace;
    projectPath?: string;
    scope?: ArtifactScope;
    preferProjectVersion?: boolean;
  }): Promise<RuntimeValidationProvenance<AccessTransformerNamespace>> {
    const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
    let version = input.version;
    if (input.preferProjectVersion && normalizedProjectPath) {
      const detected = await this.workspaceMappingService.detectProjectMinecraftVersion(normalizedProjectPath);
      version = detected ?? version;
    }

    const requestedScope: ArtifactScope = input.scope ?? (normalizedProjectPath ? "loader" : "vanilla");
    if (requestedScope === "vanilla") {
      if (input.atNamespace === "srg") {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved."
        });
      }
      const versionJar = await this.versionService.resolveVersionJar(version);
      return {
        version: versionJar.version,
        jarPath: versionJar.jarPath,
        requestedScope,
        appliedScope: "vanilla",
        requestedMapping: input.atNamespace,
        mappingApplied: "obfuscated",
        origin: "version-jar"
      };
    }

    const loaderDetection = normalizedProjectPath
      ? await this.workspaceMappingService.detectProjectLoader(normalizedProjectPath)
      : { resolved: false, loader: undefined, evidence: [], warnings: [] };
    const loader = loaderDetection.resolved ? loaderDetection.loader ?? "unknown" : "unknown";
    const discovery = await this.discoverAccessTransformerRuntimeCandidates({
      version,
      projectPath: normalizedProjectPath,
      requestedScope,
      atNamespace: input.atNamespace,
      loader
    });

    if (!discovery.selected) {
      throw createError({
        code: ERROR_CODES.CONTEXT_UNRESOLVED,
        message: "Could not resolve a runtime jar for Access Transformer validation.",
        details: {
          version,
          requestedScope,
          atNamespace: input.atNamespace,
          projectPath: normalizedProjectPath,
          searchedPaths: discovery.searchedPaths,
          candidateArtifacts: discovery.candidateArtifacts,
          loaderEvidence: loaderDetection.evidence,
          loaderWarnings: loaderDetection.warnings,
          nextAction: "Provide projectPath for a Forge/NeoForge workspace with generated runtime jars, or run the Gradle tasks that populate transformed runtime artifacts before retrying."
        }
      });
    }

    const selected = discovery.selected;
    const selectedLower = selected.jarPath.toLowerCase();
    const mappingApplied: AccessTransformerNamespace =
      input.atNamespace === "srg" || selectedLower.includes("srg")
        ? "srg"
        : loader === "neoforge" || selectedLower.includes("moddev") || selectedLower.includes("neoforge")
          ? "mojang"
          : "obfuscated";
    const scopeFallback =
      requestedScope !== selected.appliedScope
        ? {
            requested: requestedScope,
            applied: selected.appliedScope,
            reason: selected.appliedScope === "merged"
              ? "Resolved a nearby merged runtime jar because no transformed loader artifact was available."
              : "Resolved the closest transformed runtime artifact for validation."
          }
        : undefined;

    return {
      version,
      jarPath: selected.jarPath,
      requestedScope,
      appliedScope: selected.appliedScope,
      requestedMapping: input.atNamespace,
      mappingApplied,
      origin: selected.origin,
      resolutionNotes: scopeFallback ? [scopeFallback.reason] : undefined,
      scopeFallback
    };
  }

  private buildVersionSourceRecoveryCommand(projectPath?: string): string {
    const normalizedProjectPath = normalizeOptionalProjectPath(projectPath);
    const prefix = normalizedProjectPath
      ? `cd ${JSON.stringify(normalizedProjectPath)} && `
      : "";
    return `${prefix}./gradlew genSources --no-daemon`;
  }

  /**
   * Decide whether the upcoming resolveArtifact call may transparently remap a
   * binary-only artifact (obfuscated -> mojang) and decompile it. The gate
   * succeeds only when:
   *   - the requested mapping is "mojang" on a still-obfuscated runtime
   *   - tiny-remapper jar is downloadable / available locally
   *   - the version's Mojang tiny mapping file can be produced
   *   - checkMappingHealth reports mojang mappings are usable
   * On any failure the variant defaults to "pass" so the legacy
   * MAPPING_NOT_APPLIED fallback (or the existing source-backed flow) keeps
   * its existing artifactId hash.
   */
  private async computeBinaryRemapGate(input: {
    requestedMapping: SourceMapping;
    runtimeNamesUnobfuscated: boolean;
    version: string | undefined;
    targetKind: ArtifactTargetKind;
    sourcePriority?: MappingSourcePriority;
    forceBinaryRemapDisabled?: boolean;
  }): Promise<{
    allowBinaryRemap: boolean;
    mappingVariant: MappingVariant;
    tinyRemapperJarPath?: string;
    mojangTinyFilePath?: string;
    warnings: string[];
  }> {
    const baseline: {
      allowBinaryRemap: boolean;
      mappingVariant: MappingVariant;
      warnings: string[];
    } = {
      allowBinaryRemap: false,
      mappingVariant: "pass",
      warnings: []
    };

    if (input.forceBinaryRemapDisabled === true) {
      return baseline;
    }

    if (
      input.requestedMapping !== "mojang" ||
      input.runtimeNamesUnobfuscated ||
      !input.version
    ) {
      return baseline;
    }
    // The Mojang tiny mapping file is only valid for vanilla Minecraft client/server jars.
    // For coordinate / jar inputs the resolver cannot prove the artifact identity, so
    // applying Minecraft mappings to an unrelated library/mod jar would produce a
    // "successful" but corrupted artifact instead of the safe MAPPING_NOT_APPLIED reject.
    // Only target.kind="version" goes through versionService.resolveVersionJar with a
    // verified Minecraft download URL, so we restrict the gate to that input shape.
    if (input.targetKind !== "version") {
      return baseline;
    }

    let tinyRemapperJarPath: string;
    try {
      tinyRemapperJarPath = await resolveTinyRemapperJar(
        this.config.cacheDir,
        this.config.tinyRemapperJarPath
      );
    } catch (caughtError) {
      log("warn", "binary-remap.gate.tiny-remapper-unavailable", {
        version: input.version,
        error: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
      return baseline;
    }

    let mojangTinyFilePath: string;
    try {
      const mojangTiny = await resolveMojangTinyFile(input.version, this.config);
      mojangTinyFilePath = mojangTiny.path;
      if (mojangTiny.warnings.length > 0) {
        baseline.warnings.push(...mojangTiny.warnings);
      }
    } catch (caughtError) {
      log("warn", "binary-remap.gate.mojang-tiny-unavailable", {
        version: input.version,
        error: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
      return baseline;
    }

    let mojangAvailable = false;
    try {
      const health = await this.mappingService.checkMappingHealth({
        version: input.version,
        requestedMapping: "mojang",
        sourcePriority: input.sourcePriority
      });
      mojangAvailable = health.mojangMappingsAvailable;
    } catch (caughtError) {
      log("warn", "binary-remap.gate.health-check-failed", {
        version: input.version,
        error: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
      return baseline;
    }

    if (!mojangAvailable) {
      return baseline;
    }

    return {
      allowBinaryRemap: true,
      mappingVariant: "mojang-remapped",
      tinyRemapperJarPath,
      mojangTinyFilePath,
      warnings: baseline.warnings
    };
  }

  private buildArtifactContentsSummary(input: {
    origin: ResolvedSourceArtifact["origin"];
    sourceJarPath?: string;
    isDecompiled?: boolean;
    qualityFlags: string[];
  }): ArtifactContentsSummary {
    const sourceKind =
      input.isDecompiled || input.origin === "decompiled" || !normalizeOptionalString(input.sourceJarPath)
        ? "decompiled-binary"
        : "source-jar";
    const sourceCoverage = hasPartialNetMinecraftCoverage(input.qualityFlags) ? "partial" : "full";

    return {
      sourceKind,
      indexedContentKinds: ["java-source"],
      resourcesIncluded: false,
      sourceCoverage
    };
  }

  private inferVersionFromContext(input: {
    version?: string;
    provenance?: ArtifactProvenance;
    coordinate?: string;
  }): string | undefined {
    const direct = normalizeOptionalString(input.version);
    if (direct) {
      return direct;
    }

    const resolvedFromVersion = normalizeOptionalString(input.provenance?.resolvedFrom.version);
    if (resolvedFromVersion) {
      return resolvedFromVersion;
    }

    if (input.provenance?.target.kind === "version") {
      const targetVersion = normalizeOptionalString(input.provenance.target.value);
      if (targetVersion) {
        return targetVersion;
      }
    }

    const coordinate = normalizeOptionalString(input.coordinate);
    if (coordinate) {
      try {
        return parseCoordinate(coordinate).version;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private async resolveVersionContext(input: {
    version?: string;
    provenance?: ArtifactProvenance;
    coordinate?: string;
    projectPath?: string;
    preferProjectVersion?: boolean;
    warnings: string[];
  }): Promise<string | undefined> {
    const inferredVersion = this.inferVersionFromContext(input);
    if (inferredVersion) {
      return inferredVersion;
    }

    if (!input.preferProjectVersion || !input.projectPath) {
      return undefined;
    }

    const detected = await this.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
    if (detected) {
      input.warnings.push(
        `Using project version "${detected}" from gradle.properties because the artifact metadata did not include a version.`
      );
    }
    return detected;
  }

  private async buildMappingFallbackSuggestedCall(args: {
    input: ResolveArtifactInput;
    kind: ArtifactTargetKind;
    value: string;
    scope: ArtifactScope | undefined;
    effectiveMapping: SourceMapping;
  }): Promise<{
    suggestedCall: { tool: string; params: Record<string, unknown> };
    nextAction: string;
  }> {
    const { input, kind, value, scope, effectiveMapping } = args;
    const isVanillaMojang = scope === "vanilla" && effectiveMapping === "mojang";

    if (process.env.WORKSPACE_FALLBACK_LEGACY === "1") {
      return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: input.projectPath });
    }

    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: undefined });
    }

    const cached = this.workspaceContextCache.read(projectPath);
    if (cached && !cached.partial && cached.compileMapping && cached.compileMapping !== "obfuscated") {
      return {
        suggestedCall: {
          tool: "resolve-artifact",
          params: {
            target: { kind: "workspace" },
            projectPath,
            mapping: cached.compileMapping
          }
        },
        nextAction: `Workspace at ${projectPath} maps as ${cached.compileMapping}. Retry with target.kind="workspace" to use the project's compile mapping.`
      };
    }

    if (!cached) {
      try {
        const detection = await this.workspaceMappingService.detectCompileMapping({ projectPath });
        if (detection.resolved && detection.mappingApplied && detection.mappingApplied !== "obfuscated") {
          const partial: WorkspaceContext = {
            projectPath,
            compileMapping: detection.mappingApplied,
            detectedAt: Date.now(),
            evidence: detection.evidence.map((entry) => ({
              source: entry.filePath,
              field: "compileMapping",
              value: entry.mapping
            })),
            dependencyVersions: new Map<string, string>(),
            partial: true
          };
          this.workspaceContextCache.write(partial);
          return {
            suggestedCall: {
              tool: "resolve-artifact",
              params: {
                target: { kind: "workspace" },
                projectPath,
                mapping: detection.mappingApplied
              }
            },
            nextAction: `Workspace at ${projectPath} maps as ${detection.mappingApplied}. Retry with target.kind="workspace" to use the project's compile mapping.`
          };
        }
      } catch {
        // bounded detection failed; fall back to legacy
      }
    }

    return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
  }

  private buildLegacyMappingFallback(args: {
    kind: ArtifactTargetKind;
    value: string;
    scope: ArtifactScope | undefined;
    isVanillaMojang: boolean;
    projectPath: string | undefined;
  }): {
    suggestedCall: { tool: string; params: Record<string, unknown> };
    nextAction: string;
  } {
    const { kind, value, scope, isVanillaMojang, projectPath } = args;
    if (isVanillaMojang && projectPath) {
      return {
        suggestedCall: {
          tool: "resolve-artifact",
          params: buildResolveArtifactParams(
            { kind, value },
            { mapping: "mojang", scope: "merged", projectPath }
          )
        },
        nextAction:
          "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
          "Retry with scope=merged to allow source-jar resolution from the project cache."
      };
    }
    if (isVanillaMojang) {
      return {
        suggestedCall: {
          tool: "resolve-artifact",
          params: buildResolveArtifactParams(
            { kind, value },
            { mapping: "obfuscated", scope: "vanilla" }
          )
        },
        nextAction:
          "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
          "Without a projectPath, use mapping=obfuscated to read vanilla runtime names directly."
      };
    }
    return {
      suggestedCall: {
        tool: "resolve-artifact",
        params: buildResolveArtifactParams(
          { kind, value },
          { mapping: "obfuscated", ...(scope ? { scope } : {}) }
        )
      },
      nextAction: "Retry with mapping=obfuscated to use the runtime obfuscated namespace."
    };
  }

  private async loadOrDetectWorkspaceContext(projectPath: string): Promise<WorkspaceContext> {
    const cached = this.workspaceContextCache.read(projectPath);
    if (cached && !cached.partial) {
      return cached;
    }

    const [minecraftVersion, mappingResult, loaderResult] = await Promise.all([
      this.workspaceMappingService.detectProjectMinecraftVersion(projectPath),
      this.workspaceMappingService.detectCompileMapping({ projectPath }).catch(() => undefined),
      this.workspaceMappingService.detectProjectLoader(projectPath).catch(() => undefined)
    ]);

    const evidence: WorkspaceContext["evidence"] = [];
    if (minecraftVersion) {
      evidence.push({
        source: "gradle.properties",
        field: "minecraft_version",
        value: minecraftVersion
      });
    }
    if (mappingResult?.resolved && mappingResult.evidence[0]) {
      evidence.push({
        source: mappingResult.evidence[0].filePath,
        field: "compileMapping",
        value: mappingResult.mappingApplied
      });
    }
    if (loaderResult?.resolved && loaderResult.evidence[0]) {
      evidence.push({
        source: loaderResult.evidence[0].filePath,
        field: "loader",
        value: loaderResult.loader
      });
    }

    const ctx: WorkspaceContext = {
      projectPath,
      minecraftVersion,
      compileMapping: mappingResult?.resolved ? mappingResult.mappingApplied : undefined,
      loader: loaderResult?.resolved ? loaderResult.loader : undefined,
      detectedAt: Date.now(),
      evidence,
      dependencyVersions: cached?.dependencyVersions ?? new Map<string, string>(),
      partial: false
    };
    this.workspaceContextCache.write(ctx);
    return ctx;
  }

  private async synthesizeWorkspaceTarget(
    input: ResolveArtifactInput,
    workspace: WorkspaceTargetInput
  ): Promise<{
    target: SourceTargetInput;
    scope?: ArtifactScope;
    mapping?: SourceMapping;
    provenance: WorkspaceResolutionProvenance;
    warnings: string[];
  }> {
    if (WORKSPACE_TARGET_OFF) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="workspace" is disabled by WORKSPACE_TARGET_OFF=1.',
        details: {
          fieldErrors: [{ path: "target.kind", message: 'target.kind="workspace" is disabled.' }]
        }
      });
    }

    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'projectPath is required when target.kind="workspace".',
        details: {
          fieldErrors: [{ path: "projectPath", message: 'projectPath is required when target.kind="workspace".' }]
        }
      });
    }

    const cachedBefore = this.workspaceContextCache.read(projectPath);
    const cacheHit = Boolean(cachedBefore && !cachedBefore.partial);
    const ctx = cacheHit ? cachedBefore! : await this.loadOrDetectWorkspaceContext(projectPath);

    const warnings: string[] = [];
    let resolvedVersion = ctx.minecraftVersion;
    if (!resolvedVersion) {
      if (workspace.strict === true) {
        throw createError({
          code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
          message: `Could not detect a Minecraft version for projectPath "${projectPath}".`,
          details: {
            projectPath,
            nextAction:
              "Set minecraft_version in gradle.properties or pass target.kind=\"version\" with an explicit Minecraft version.",
            suggestedCall: {
              tool: "resolve-artifact",
              params: {
                target: { kind: "version", value: "<your-mc-version>" },
                projectPath
              }
            }
          }
        });
      }
      const fallback = await this.versionService.listVersions({ includeSnapshots: false, limit: 1 });
      const latestVersion = fallback.latest.release ?? fallback.releases[0]?.id;
      if (!latestVersion) {
        throw createError({
          code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
          message: `Could not detect a Minecraft version for projectPath "${projectPath}" and no fallback Minecraft version is available.`,
          details: { projectPath }
        });
      }
      resolvedVersion = latestVersion;
      warnings.push(
        `No Minecraft version detected in workspace; falling back to latest stable Minecraft version "${latestVersion}".`
      );
    }

    const requestedMapping = normalizeMapping(input.mapping);
    let effectiveMapping: SourceMapping | undefined;
    if (input.mapping) {
      effectiveMapping = requestedMapping;
      if (ctx.compileMapping && ctx.compileMapping !== requestedMapping) {
        warnings.push(
          `Compile mapping mismatch (workspace=${ctx.compileMapping}, requested=${requestedMapping}); using requested mapping.`
        );
      }
    } else {
      effectiveMapping = ctx.compileMapping ?? "obfuscated";
    }

    const effectiveScope: ArtifactScope = workspace.scope ?? (ctx.loader ? "merged" : "vanilla");

    const provenance: WorkspaceResolutionProvenance = {
      projectPath,
      detected: {
        minecraftVersion: ctx.minecraftVersion,
        compileMapping: ctx.compileMapping,
        loader: ctx.loader
      },
      source: ctx.evidence
        .map((entry) => `${entry.source}:${entry.field}`)
        .join("; ") || (cacheHit ? "workspace-context-cache" : "workspace-detection"),
      cacheHit,
      warnings: [...warnings]
    };

    return {
      target: { kind: "version", value: resolvedVersion },
      scope: effectiveScope,
      mapping: effectiveMapping,
      provenance,
      warnings
    };
  }

  private async synthesizeDependencyTarget(
    input: ResolveArtifactInput,
    dep: DependencyTargetInput
  ): Promise<{
    target: SourceTargetInput;
    provenance: DependencyResolutionProvenance;
    requestedMapping?: SourceMapping;
    warnings: string[];
  }> {
    if (DEPENDENCY_TARGET_OFF) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" is disabled by DEPENDENCY_TARGET_OFF=1.',
        details: {
          fieldErrors: [{ path: "target.kind", message: 'target.kind="dependency" is disabled.' }]
        }
      });
    }

    const group = dep.group?.trim();
    const name = dep.name?.trim();
    if (!group || !name) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" requires non-empty group and name.',
        details: {
          fieldErrors: [
            ...(group ? [] : [{ path: "target.group", message: "group is required" }]),
            ...(name ? [] : [{ path: "target.name", message: "name is required" }])
          ]
        }
      });
    }
    if (
      group.includes("/") ||
      group.includes("\\") ||
      group.includes("..") ||
      group.includes("\0") ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..") ||
      name.includes("\0")
    ) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" group/name must not contain path traversal characters.',
        details: {
          fieldErrors: [{ path: "target", message: "group and name must not contain '/', '\\', '..', or NUL." }]
        }
      });
    }

    if (dep.version) {
      const coordinate = `${group}:${name}:${dep.version}`;
      return {
        target: { kind: "coordinate", value: coordinate },
        requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
        warnings: [],
        provenance: {
          group,
          name,
          resolvedVersion: dep.version,
          source: "explicit",
          cacheHit: false
        }
      };
    }

    if (dep.versionFromProject === false) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" requires version when versionFromProject=false.',
        details: {
          fieldErrors: [
            { path: "target.version", message: "version is required when versionFromProject=false." }
          ]
        }
      });
    }

    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'projectPath is required when target.kind="dependency" without an explicit version.',
        details: {
          fieldErrors: [{ path: "projectPath", message: 'projectPath is required for dependency target without version.' }]
        }
      });
    }

    const cacheKey = `${group}:${name}`;
    const ctxBefore = this.workspaceContextCache.read(projectPath);
    const cachedVersion = ctxBefore?.dependencyVersions.get(cacheKey);
    const warningsBucket: string[] = [];
    if (cachedVersion) {
      const coordinate = `${group}:${name}:${cachedVersion}`;
      return {
        target: { kind: "coordinate", value: coordinate },
        requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
        warnings: [],
        provenance: {
          group,
          name,
          resolvedVersion: cachedVersion,
          source: "workspace-context-cache",
          cacheHit: true
        }
      };
    }

    const result = await this.workspaceMappingService.detectDependencyVersion(projectPath, group, name);
    if (!result.resolved) {
      throw createError({
        code: ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
        message: `Could not resolve a version for dependency ${group}:${name} from gradle.properties or modules-2 cache.`,
        details: {
          group,
          name,
          attempts: result.attempts,
          candidatesSeen: result.candidatesSeen,
          nextAction:
            "Provide an explicit version on the dependency target, or add a property to gradle.properties so detectDependencyVersion can find it.",
          suggestedCall: {
            tool: "resolve-artifact",
            params: {
              target: {
                kind: "dependency",
                group,
                name,
                version: "<your-version>"
              },
              projectPath
            }
          }
        }
      });
    }

    const ctxAfter = this.workspaceContextCache.read(projectPath);
    if (ctxAfter) {
      const updatedDeps = new Map(ctxAfter.dependencyVersions);
      updatedDeps.set(cacheKey, result.version);
      this.workspaceContextCache.write({ ...ctxAfter, dependencyVersions: updatedDeps });
    } else {
      const updatedDeps = new Map<string, string>();
      updatedDeps.set(cacheKey, result.version);
      this.workspaceContextCache.write({
        projectPath,
        detectedAt: Date.now(),
        evidence: [],
        dependencyVersions: updatedDeps,
        partial: true
      });
    }

    if (result.candidatesSeen.length > 1) {
      warningsBucket.push(
        `multiple cached versions: [${result.candidatesSeen.join(", ")}]; using ${result.version}`
      );
    }

    const coordinate = `${group}:${name}:${result.version}`;
    return {
      target: { kind: "coordinate", value: coordinate },
      requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
      warnings: warningsBucket,
      provenance: {
        group,
        name,
        resolvedVersion: result.version,
        source: result.source,
        candidatesSeen: result.candidatesSeen,
        attempts: result.attempts,
        cacheHit: false
      }
    };
  }

  async resolveArtifact(input: ResolveArtifactInput): Promise<ResolveArtifactOutput> {
    let workspaceProvenance: WorkspaceResolutionProvenance | undefined;
    let dependencyProvenance: DependencyResolutionProvenance | undefined;
    let dependencyOrigin = false;
    let dependencyRequestedMapping: SourceMapping | undefined;
    const synthesisWarnings: string[] = [];

    if (input.target.kind === "workspace") {
      const synthesized = await this.synthesizeWorkspaceTarget(input, input.target);
      workspaceProvenance = synthesized.provenance;
      synthesisWarnings.push(...synthesized.warnings);
      input = {
        ...input,
        target: synthesized.target,
        scope: synthesized.scope ?? input.scope,
        mapping: synthesized.mapping
      };
    } else if (input.target.kind === "dependency") {
      const synthesized = await this.synthesizeDependencyTarget(input, input.target);
      dependencyProvenance = synthesized.provenance;
      dependencyOrigin = true;
      dependencyRequestedMapping = synthesized.requestedMapping;
      synthesisWarnings.push(...synthesized.warnings);
      input = { ...input, target: synthesized.target };
    }

    const target = input.target as SourceTargetInput;
    const kind = target.kind;
    let value = target.value?.trim();
    const mapping = normalizeMapping(input.mapping);
    const scope = input.scope;
    const warnings: string[] = [...synthesisWarnings];

    // P5: preferProjectVersion - detect MC version from gradle.properties
    if (input.preferProjectVersion && input.projectPath && kind === "version") {
      const detected = await this.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
      if (detected && detected !== value) {
        warnings.push(`Overriding version "${value}" with project version "${detected}" from gradle.properties.`);
      }
      value = detected ?? value;
    }
    if (!value) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "target.value must be non-empty.",
        details: { target: input.target }
      });
    }
    if (kind !== "jar" && kind !== "coordinate" && kind !== "version") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Unsupported target kind "${kind}".`,
        details: { target: input.target }
      });
    }
    if (kind === "jar" && !value.toLowerCase().endsWith(".jar")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "target.kind=jar requires a .jar path.",
        details: { target: input.target }
      });
    }

    const startedAt = Date.now();
    try {
      let resolvedTarget: SourceTargetInput = { kind, value };
      let resolvedVersion: string | undefined;
      let versionSourceDiscovery: VersionSourceDiscovery | undefined;
      let runtimeNamesUnobfuscated = false;
      if (kind === "version") {
        const versionJar = await this.versionService.resolveVersionJar(value);
        resolvedVersion = versionJar.version;
        runtimeNamesUnobfuscated = isUnobfuscatedVersion(resolvedVersion);
        resolvedTarget = {
          kind: "jar",
          value: versionJar.jarPath
        };
        warnings.push(`Resolved Minecraft ${versionJar.version} from ${versionJar.clientJarUrl}.`);
      }
      if (kind === "coordinate") {
        try {
          resolvedVersion = parseCoordinate(value).version;
        } catch {
          // coordinate validity is validated by resolver, keep version undefined on parse failure.
        }
      }
      if (!runtimeNamesUnobfuscated && resolvedVersion && isUnobfuscatedVersion(resolvedVersion)) {
        runtimeNamesUnobfuscated = true;
      }

      // Unobfuscated versions (MC 26.1+) ship with deobfuscated runtime names; intermediary/yarn are not applicable.
      let effectiveMapping: SourceMapping = mapping;
      if (
        (mapping === "intermediary" || mapping === "yarn") &&
        resolvedVersion &&
        isUnobfuscatedVersion(resolvedVersion)
      ) {
        warnings.push(
          `Version ${resolvedVersion} is unobfuscated; ${mapping} mappings are not applicable. Using the obfuscated namespace label for the deobfuscated runtime names.`
        );
        effectiveMapping = "obfuscated";
      }

      if (
        kind === "version" &&
        resolvedVersion &&
        effectiveMapping === "mojang" &&
        !runtimeNamesUnobfuscated &&
        scope !== "vanilla"
      ) {
        versionSourceDiscovery = await this.discoverVersionSourceJar({
          version: resolvedVersion,
          projectPath: input.projectPath
        });
        if (versionSourceDiscovery.selectedSourceJarPath) {
          resolvedTarget = {
            kind: "jar",
            value: versionSourceDiscovery.selectedSourceJarPath
          };
          warnings.push(
            `Resolved source-backed artifact from Loom cache candidate: ${versionSourceDiscovery.selectedSourceJarPath}.`
          );
        }
      }

      // The mojang binary-remap gate is only relevant when no source jar has been pre-selected.
      // If discoverVersionSourceJar already chose a source jar, the resolver will return a
      // source-backed artifact and applyMappingPipeline will take the source-backed branch,
      // which never consults allowBinaryRemap. Skipping the gate avoids paying for tiny-remapper
      // download / mojang tiny generation / mapping-health probe on healthy source-backed paths.
      const sourceJarPreSelected = Boolean(versionSourceDiscovery?.selectedSourceJarPath);
      const binaryRemapGate = sourceJarPreSelected
        ? { allowBinaryRemap: false, mappingVariant: "pass" as MappingVariant, warnings: [] }
        : await this.computeBinaryRemapGate({
            requestedMapping: effectiveMapping,
            runtimeNamesUnobfuscated,
            version: resolvedVersion,
            targetKind: kind,
            sourcePriority: input.sourcePriority,
            forceBinaryRemapDisabled: dependencyOrigin
          });
      if (binaryRemapGate.warnings.length > 0) {
        warnings.push(...binaryRemapGate.warnings);
      }

      const resolved = await resolveSourceTargetInternal(
        resolvedTarget,
        {
          // mojang requires source-backed artifact guarantee; force resolution to consider decompile candidate
          // and reject later if mapping cannot be applied.
          allowDecompile: effectiveMapping === "mojang" ? true : input.allowDecompile ?? true,
          mappingVariant: binaryRemapGate.mappingVariant,
          onRepoFailover: (event) => {
            this.metrics.recordRepoFailover();
            log("warn", "repo.failover", {
              stage: event.stage,
              repoUrl: event.repoUrl,
              statusCode: event.statusCode,
              reason: event.reason,
              attempt: event.attempt,
              totalAttempts: event.totalAttempts
            });
          }
        },
        this.config
      );
      resolved.version = resolvedVersion;

      let mappingDecision: ReturnType<typeof applyMappingPipeline>;
      try {
        mappingDecision = applyMappingPipeline({
          requestedMapping: effectiveMapping,
          target: { kind, value },
          resolved,
          runtimeNamesUnobfuscated,
          allowBinaryRemap: binaryRemapGate.allowBinaryRemap
        });
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED) {
          const fallback = await this.buildMappingFallbackSuggestedCall({
            input,
            kind,
            value,
            scope,
            effectiveMapping
          });
          const suggestedCall = fallback.suggestedCall;
          const nextAction = fallback.nextAction;
          throw createError({
            code: ERROR_CODES.MAPPING_NOT_APPLIED,
            message: caughtError.message,
            details: {
              ...(caughtError.details ?? {}),
              artifactOrigin: resolved.origin,
              searchedPaths: versionSourceDiscovery?.searchedPaths ?? [],
              candidateArtifacts:
                versionSourceDiscovery?.candidateArtifacts ?? resolved.adjacentSourceCandidates ?? [],
              recommendedCommand: this.buildVersionSourceRecoveryCommand(input.projectPath),
              nextAction,
              suggestedCall
            }
          });
        }
        throw caughtError;
      }
      const additionalTransformChain: string[] = [];
      if (effectiveMapping === "intermediary" || effectiveMapping === "yarn") {
        if (!resolved.version) {
          throw createError({
            code: ERROR_CODES.MAPPING_NOT_APPLIED,
            message: `Requested ${effectiveMapping} mapping cannot be guaranteed because artifact version is unknown.`,
            details: {
              mapping: effectiveMapping,
              target: { kind, value },
              nextAction:
                "Use target: { kind: \"version\", value } or a versioned Maven coordinate so mapping artifacts can be resolved.",
              suggestedCall: {
                tool: "resolve-artifact",
                params: buildResolveArtifactParams(
                  { kind: "version", value },
                  { ...(scope ? { scope } : {}) }
                )
              }
            }
          });
        }

        const mappingAvailability = await this.mappingService.ensureMappingAvailable({
          version: resolved.version,
          sourceMapping: "obfuscated",
          targetMapping: effectiveMapping,
          sourcePriority: input.sourcePriority
        });
        additionalTransformChain.push(...mappingAvailability.transformChain);
        if (mappingAvailability.warnings.length > 0) {
          warnings.push(...mappingAvailability.warnings);
        }
      }
      const provenance = this.buildProvenance({
        requestedTarget: { kind, value },
        resolved,
        transformChain: [...mappingDecision.transformChain, ...additionalTransformChain]
      });
      if (workspaceProvenance) {
        provenance.workspaceResolution = workspaceProvenance;
      }
      if (dependencyProvenance) {
        provenance.dependencyResolution = dependencyProvenance;
      }

      let finalMappingApplied = mappingDecision.mappingApplied;
      if (dependencyOrigin && dependencyRequestedMapping && dependencyRequestedMapping !== finalMappingApplied) {
        const coord = resolved.coordinate ?? value;
        warnings.push(
          `Dependency artifact ${coord} is in ${finalMappingApplied} namespace; requested mapping "${dependencyRequestedMapping}" cannot be applied to dependency JARs (binary remap is disabled for non-vanilla artifacts).`
        );
      }

      const provenanceWarnings = [...synthesisWarnings];
      if (provenanceWarnings.length > 0) {
        provenance.warnings = [...(provenance.warnings ?? []), ...provenanceWarnings];
      }

      resolved.requestedMapping = effectiveMapping;
      resolved.mappingApplied = finalMappingApplied;
      resolved.provenance = provenance;
      resolved.qualityFlags = [...mappingDecision.qualityFlags];
      if (versionSourceDiscovery?.candidateArtifacts.length) {
        resolved.qualityFlags.push("source-jar-found");
      }
      if (versionSourceDiscovery?.selectedSourceJarPath) {
        resolved.qualityFlags.push("source-jar-validated");
        if (versionSourceDiscovery.selectedHasMinecraftNamespace === false) {
          resolved.qualityFlags.push("partial-source-no-net-minecraft");
          warnings.push(
            `Source coverage does not include net.minecraft for ${versionSourceDiscovery.selectedSourceJarPath}; class lookups may fall back to the binary artifact.`
          );
        }
        if (kind === "version" && !hasExactVersionToken(versionSourceDiscovery.selectedSourceJarPath, value)) {
          if (input.strictVersion) {
            throw createError({
              code: ERROR_CODES.VERSION_NOT_FOUND,
              message: `Strict version match failed: requested "${value}" but nearest source jar is for a different version.`,
              details: {
                requestedVersion: value,
                selectedSourceJar: versionSourceDiscovery.selectedSourceJarPath,
                candidateArtifacts: versionSourceDiscovery.candidateArtifacts,
                nextAction: "Use strictVersion=false (default) to allow approximation, or ensure the exact version source jar is in the Loom cache.",
                suggestedCall: {
                  tool: "resolve-artifact",
                  params: buildResolveArtifactParams({ kind: "version", value }, { strictVersion: false })
                }
              }
            });
          }
          resolved.qualityFlags.push("version-approximated");
          warnings.push(
            `Requested version "${value}" but resolved source jar does not contain exact version string: ${versionSourceDiscovery.selectedSourceJarPath}`
          );
        }
      }
      resolved.qualityFlags = dedupeQualityFlags(resolved.qualityFlags);
      // Use the resolver's canonical path (already normalizeJarPath-applied)
      // for the readable jar token. Without this, two requests for the same
      // artifact via a symlink path and the real path would share artifactId
      // but produce different alias readable tokens, and setAlias rotation
      // on the warm-cache hit would invalidate the alias returned to the
      // earlier caller. Coordinate / version paths are already canonical:
      // resolved.coordinate is normalized inside the resolver and
      // resolvedVersion comes from versionService.resolveVersionJar().
      const aliasValue =
        kind === "jar"
          ? (resolved.sourceJarPath ?? resolved.binaryJarPath ?? value)
          : value;
      const artifactAlias = buildArtifactAlias({
        artifactId: resolved.artifactId,
        kind,
        value: aliasValue,
        mappingVariant: binaryRemapGate.mappingVariant,
        resolvedVersion: resolvedVersion ?? resolved.version,
        coordinate: resolved.coordinate
      });
      resolved.artifactAlias = artifactAlias;
      await this.ingestIfNeeded(resolved);

      let sampleEntries: string[] | undefined;
      if (input.compact === false && resolved.sourceJarPath) {
        try {
          const javaEntries = await listJavaEntries(resolved.sourceJarPath);
          const MAX_SAMPLE = 10;
          sampleEntries = javaEntries.slice(0, MAX_SAMPLE);
          if (javaEntries.length > MAX_SAMPLE) {
            sampleEntries.push(`... and ${javaEntries.length - MAX_SAMPLE} more .java entries`);
          }
        } catch {
          // non-fatal: sampleEntries remains undefined
        }
      }

      return {
        artifactId: resolved.artifactId,
        artifactAlias,
        origin: resolved.origin,
        isDecompiled: resolved.isDecompiled,
        resolvedSourceJarPath: resolved.sourceJarPath,
        adjacentSourceCandidates: resolved.adjacentSourceCandidates,
        binaryJarPath: resolved.binaryJarPath,
        coordinate: resolved.coordinate,
        version: resolved.version,
        requestedMapping: effectiveMapping,
        mappingApplied: mappingDecision.mappingApplied,
        provenance,
        qualityFlags: resolved.qualityFlags,
        repoUrl: resolved.repoUrl,
        artifactContents: this.buildArtifactContentsSummary({
          origin: resolved.origin,
          sourceJarPath: resolved.sourceJarPath,
          isDecompiled: resolved.isDecompiled,
          qualityFlags: resolved.qualityFlags
        }),
        warnings,
        sampleEntries
      };
    } catch (caughtError) {
      if (isAppError(caughtError)) {
        throw caughtError;
      }
      throw createError({
        code: ERROR_CODES.ARTIFACT_RESOLUTION_FAILED,
        message: "Failed to resolve artifact.",
        details: {
          target: input.target,
          mapping,
          reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
        }
      });
    } finally {
      this.metrics.recordDuration("resolve_duration_ms", Date.now() - startedAt);
    }
  }

  async searchClassSource(input: SearchClassSourceInput): Promise<SearchClassSourceOutput> {
    const startedAt = Date.now();
    try {
      const artifact = this.getArtifact(input.artifactId);
      const originalQuery = input.query.trim();
      if (!originalQuery) {
        return {
          hits: [],
          mappingApplied: artifact.mappingApplied ?? "obfuscated",
          returnedNamespace: artifact.mappingApplied ?? "obfuscated",
          artifactContents: this.buildArtifactContentsSummary({
            origin: artifact.origin,
            sourceJarPath: artifact.sourceJarPath,
            isDecompiled: artifact.isDecompiled,
            qualityFlags: artifact.qualityFlags
          })
        };
      }

      const intent = normalizeIntent(input.intent);
      const match = normalizeMatch(input.match);

      const artifactMapping = artifact.mappingApplied ?? "obfuscated";
      const searchWarnings: string[] = [];
      let translatedInfo: SearchClassSourceOutput["translatedQuery"];
      let query = originalQuery;
      let translationPackagePrefix: string | undefined;

      if (
        input.queryNamespace
        && input.queryNamespace !== artifactMapping
        && !artifact.version
      ) {
        searchWarnings.push(
          `queryNamespace=${input.queryNamespace} could not be applied because the artifact has no version recorded; namespace translation requires a version. Running literal search in ${artifactMapping} instead.`
        );
      }

      if (
        input.queryNamespace
        && input.queryNamespace !== artifactMapping
        && artifact.version
      ) {
        if (intent === "symbol" && originalQuery.includes(".") && /^[\w.$]+$/.test(originalQuery)) {
          try {
            const translated = await this.mappingService.findMapping({
              version: artifact.version,
              kind: "class",
              name: originalQuery,
              sourceMapping: input.queryNamespace,
              targetMapping: artifactMapping,
              sourcePriority: input.sourcePriority,
              signatureMode: "name-only",
              maxCandidates: 5
            });
            if (translated.resolved === true && translated.resolvedSymbol) {
              const resolvedName = translated.resolvedSymbol.symbol
                ?? translated.resolvedSymbol.name;
              if (resolvedName && resolvedName !== originalQuery) {
                translatedInfo = {
                  original: originalQuery,
                  translated: resolvedName,
                  fromNamespace: input.queryNamespace,
                  toNamespace: artifactMapping
                };
                // Downstream symbol search matches on simpleName only, so split
                // the translated FQCN into simpleName + derived packagePrefix
                // scope. Preserve a caller-supplied packagePrefix if present.
                if (resolvedName.includes(".")) {
                  const lastDot = resolvedName.lastIndexOf(".");
                  const simpleName = resolvedName.slice(lastDot + 1);
                  const packagePart = resolvedName.slice(0, lastDot);
                  query = simpleName;
                  if (!input.scope?.packagePrefix) {
                    translationPackagePrefix = packagePart;
                  }
                } else {
                  query = resolvedName;
                }
              }
            } else if (translated.status === "ambiguous") {
              const candidateCount = translated.candidateCount ?? translated.candidates?.length ?? 0;
              searchWarnings.push(
                `queryNamespace=${input.queryNamespace}: translation for "${originalQuery}" was ambiguous (${candidateCount} candidates); running literal search instead. Narrow the query with a more specific FQCN or call find-mapping directly.`
              );
            } else if (translated.status === "not_found") {
              searchWarnings.push(
                `queryNamespace=${input.queryNamespace}: no ${artifactMapping} mapping found for "${originalQuery}"; running literal search instead.`
              );
            } else if (translated.status === "mapping_unavailable") {
              searchWarnings.push(
                `queryNamespace=${input.queryNamespace}: mapping data unavailable for version ${artifact.version}; running literal search instead.`
              );
            } else {
              searchWarnings.push(
                `queryNamespace=${input.queryNamespace}: could not translate "${originalQuery}" to ${artifactMapping}; running literal search instead.`
              );
            }
          } catch (caughtError) {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: translation failed (${caughtError instanceof Error ? caughtError.message : String(caughtError)}); running literal search instead.`
            );
          }
        } else if (intent === "text" || intent === "path") {
          searchWarnings.push(
            `queryNamespace=${input.queryNamespace} has no effect when intent="${intent}" — ${intent} search is a literal match against the artifact's ${artifactMapping} index. Use intent="symbol" for namespace translation.`
          );
        }
      }
      if (match === "regex" && query.length > MAX_REGEX_QUERY_LENGTH) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Regex query exceeds max length of ${MAX_REGEX_QUERY_LENGTH} characters.`,
          details: {
            queryLength: query.length,
            maxLength: MAX_REGEX_QUERY_LENGTH
          }
        });
      }
      const searchLimitCap =
        match === "regex"
          ? Math.max(1, Math.min(this.config.maxSearchHits, MAX_REGEX_RESULT_LIMIT))
          : this.config.maxSearchHits;
      const scope: SearchScope | undefined = translationPackagePrefix
        ? { ...(input.scope ?? {}), packagePrefix: translationPackagePrefix }
        : input.scope;
      if (scope?.symbolKind && intent !== "symbol") {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'symbolKind filter is only supported when intent="symbol".'
        });
      }
      const limit = clampLimit(input.limit, 20, searchLimitCap);
      const regexPattern = match === "regex" ? compileRegex(query) : undefined;
      const queryMode = input.queryMode ?? "auto";
      this.metrics.recordSearchQueryMode(queryMode);
      const cursorContext = buildSearchCursorContext({
        artifactId: artifact.artifactId,
        query,
        intent,
        match,
        queryMode,
        scope
      });
      const decodedCursor = decodeSearchCursor(input.cursor);
      const cursor = decodedCursor?.contextKey === cursorContext ? decodedCursor : undefined;
      const accumulator = createSearchHitAccumulator(limit, cursor);
      const indexedSearchEnabled = this.config.indexedSearchEnabled !== false;
      if (match === "regex") {
        this.metrics.recordSearchRegexFallback();
      }
      const intentStartedAt = Date.now();

      const recordHit = (hit: SearchSourceHit): void => {
        accumulator.add(hit);
      };
      const tokenOnlyTextIntent = intent === "text" && queryMode === "token";
      if (intent === "symbol") {
        this.searchSymbolIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
      } else if (queryMode === "literal" && intent === "text") {
        // F-03: queryMode=literal forces substring scan for text intent
        this.metrics.recordSearchFallback();
        this.searchTextIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
      } else if (!indexedSearchEnabled) {
        this.metrics.recordIndexedDisabled();
        if (!tokenOnlyTextIntent) {
          this.metrics.recordSearchFallback();
          if (intent === "path") {
            this.searchPathIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
          } else {
            this.searchTextIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
          }
        }
      } else if (canUseIndexedSearchPath(indexedSearchEnabled, intent, match, scope)) {
        try {
          if (intent === "path") {
            this.searchPathIntentIndexed(artifact.artifactId, query, match, scope, recordHit);
          } else {
            this.searchTextIntentIndexed(artifact.artifactId, query, match, scope, recordHit);
          }
          this.metrics.recordSearchIndexedHit();
        } catch (caughtError) {
          this.metrics.recordSearchFallback();
          log("warn", "search.indexed_fallback", {
            artifactId: artifact.artifactId,
            intent,
            match,
            reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
          });
          // F-03: queryMode=token suppresses error-path fallback to brute-force scan
          if (!tokenOnlyTextIntent) {
            if (intent === "path") {
              this.searchPathIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
            } else {
              this.searchTextIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
            }
          }
        }
      } else {
        if (!tokenOnlyTextIntent) {
          this.metrics.recordSearchFallback();
          if (intent === "path") {
            this.searchPathIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
          } else {
            this.searchTextIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
          }
        }
      }
      this.metrics.recordSearchIntentDuration(intent, Date.now() - intentStartedAt);

      const finalizedHits = accumulator.finalize();
      const page = finalizedHits.page;
      this.metrics.recordSearchRowsReturned(page.length);
      const nextCursor = finalizedHits.nextCursorHit
        ? encodeSearchCursor(finalizedHits.nextCursorHit, cursorContext)
        : undefined;

      this.metrics.recordSearchTokenBytesReturned(
        Buffer.byteLength(JSON.stringify({ hits: page }), "utf8")
      );

      return {
        hits: page,
        nextCursor,
        mappingApplied: artifact.mappingApplied ?? "obfuscated",
        returnedNamespace: artifact.mappingApplied ?? "obfuscated",
        artifactContents: this.buildArtifactContentsSummary({
          origin: artifact.origin,
          sourceJarPath: artifact.sourceJarPath,
          isDecompiled: artifact.isDecompiled,
          qualityFlags: artifact.qualityFlags
        }),
        ...(translatedInfo ? { translatedQuery: translatedInfo } : {}),
        ...(searchWarnings.length > 0 ? { warnings: searchWarnings } : {})
      };
    } finally {
      this.metrics.recordDuration("search_duration_ms", Date.now() - startedAt);
    }
  }

  async getArtifactFile(input: GetArtifactFileInput): Promise<GetArtifactFileOutput> {
    const startedAt = Date.now();
    try {
      const artifact = this.getArtifact(input.artifactId);
      const row = this.filesRepo.getFileContent(artifact.artifactId, normalizePathStyle(input.filePath));
      if (!row) {
        throw createError({
          code: ERROR_CODES.FILE_NOT_FOUND,
          message: `Source file "${input.filePath}" was not found.`,
          details: { artifactId: input.artifactId, filePath: input.filePath }
        });
      }

      const maxBytes = clampLimit(input.maxBytes, this.config.maxContentBytes, Number.MAX_SAFE_INTEGER);
      const fullBytes = Buffer.byteLength(row.content, "utf8");
      const truncated = fullBytes > maxBytes;
      const content = truncated ? truncateUtf8ToMaxBytes(row.content, maxBytes) : row.content;

      if (truncated) {
        log("warn", "source.get_file.truncated", {
          artifactId: input.artifactId,
          filePath: input.filePath,
          maxBytes,
          returnedBytes: Buffer.byteLength(content, "utf8"),
          fullBytes
        });
      }

      return {
        filePath: row.filePath,
        content,
        contentBytes: fullBytes,
        truncated,
        mappingApplied: artifact.mappingApplied ?? "obfuscated",
        returnedNamespace: artifact.mappingApplied ?? "obfuscated",
        artifactContents: this.buildArtifactContentsSummary({
          origin: artifact.origin,
          sourceJarPath: artifact.sourceJarPath,
          isDecompiled: artifact.isDecompiled,
          qualityFlags: artifact.qualityFlags
        })
      };
    } finally {
      this.metrics.recordDuration("get_file_duration_ms", Date.now() - startedAt);
    }
  }

  async listArtifactFiles(input: ListArtifactFilesInput): Promise<ListArtifactFilesOutput> {
    const startedAt = Date.now();
    try {
      const artifact = this.getArtifact(input.artifactId);
      const limit = clampLimit(input.limit, 200, 2000);
      const warnings: string[] = [];
      const page = this.filesRepo.listFiles(artifact.artifactId, {
        limit,
        cursor: input.cursor,
        prefix: input.prefix
      });
      const normalizedPrefix = normalizeOptionalString(input.prefix);
      if (
        normalizedPrefix &&
        page.items.length === 0 &&
        (normalizedPrefix.startsWith("assets/") || normalizedPrefix.startsWith("data/"))
      ) {
        warnings.push(
          "Indexed artifacts currently include Java source only; non-Java resources are not indexed. Inspect the original jar on disk if you need assets or data files."
        );
      }
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        mappingApplied: artifact.mappingApplied ?? "obfuscated",
        artifactContents: this.buildArtifactContentsSummary({
          origin: artifact.origin,
          sourceJarPath: artifact.sourceJarPath,
          isDecompiled: artifact.isDecompiled,
          qualityFlags: artifact.qualityFlags
        }),
        warnings
      };
    } finally {
      this.metrics.recordDuration("list_files_duration_ms", Date.now() - startedAt);
    }
  }

  async listVersions(input: ListVersionsInput = {}): Promise<ListVersionsOutput> {
    return this.versionService.listVersions(input);
  }

  async getRegistryData(input: GetRegistryDataInput): Promise<GetRegistryDataOutput> {
    return this.registryService.getRegistryData(input);
  }

  async compareVersions(input: CompareVersionsInput): Promise<CompareVersionsOutput> {
    return this.versionDiffService.compareVersions(input);
  }

  async decompileModJar(input: DecompileModJarInput): Promise<DecompileModJarOutput> {
    return this.modDecompileService.decompileModJar(input);
  }

  async getModClassSource(input: GetModClassSourceInput): Promise<GetModClassSourceOutput> {
    return this.modDecompileService.getModClassSource(input);
  }

  async searchModSource(input: SearchModSourceInput): Promise<SearchModSourceOutput> {
    return this.modSearchService.searchModSource(input);
  }

  async findMapping(input: FindMappingInput): Promise<FindMappingOutput> {
    return this.mappingService.findMapping(input);
  }

  async resolveMethodMappingExact(
    input: ResolveMethodMappingExactInput
  ): Promise<ResolveMethodMappingExactOutput> {
    return this.mappingService.resolveMethodMappingExact(input);
  }

  async getClassApiMatrix(input: GetClassApiMatrixInput): Promise<GetClassApiMatrixOutput> {
    return this.mappingService.getClassApiMatrix(input);
  }

  async checkSymbolExists(input: CheckSymbolExistsInput): Promise<CheckSymbolExistsOutput> {
    const result = await this.mappingService.checkSymbolExists(input);
    if (
      result.status !== "mapping_unavailable" ||
      !isUnobfuscatedVersion(input.version) ||
      (input.sourceMapping !== "mojang" && input.sourceMapping !== "obfuscated")
    ) {
      return result;
    }

    const runtimeFallback = await this.checkSymbolExistsInUnobfuscatedRuntime(input, result);
    return runtimeFallback ?? result;
  }

  async resolveWorkspaceSymbol(input: ResolveWorkspaceSymbolInput): Promise<ResolveWorkspaceSymbolOutput> {
    const projectPath = input.projectPath?.trim();
    const version = input.version?.trim();
    const kind = input.kind;
    const name = input.name?.trim();
    const owner = input.owner?.trim();
    const descriptor = input.descriptor?.trim();
    if (!projectPath || !version || !name) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "projectPath, version, and name must be non-empty strings.",
        details: {
          projectPath: input.projectPath,
          version: input.version,
          name: input.name
        }
      });
    }

    if (kind !== "class" && kind !== "field" && kind !== "method") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Unsupported symbol kind "${kind}".`,
        details: {
          kind
        }
      });
    }
    if (kind === "class") {
      if (owner) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "owner is not allowed when kind=class. Use name as FQCN.",
          details: {
            owner: input.owner,
            name: input.name
          }
        });
      }
      if (descriptor) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "descriptor is not allowed when kind=class.",
          details: {
            descriptor: input.descriptor
          }
        });
      }
    } else if (!owner) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "owner is required when kind is field or method.",
        details: {
          kind,
          owner: input.owner
        }
      });
    }
    if (kind === "field" && descriptor) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "descriptor is not allowed when kind=field.",
        details: {
          descriptor: input.descriptor
        }
      });
    }
    if (kind === "method" && !descriptor) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "descriptor is required when kind=method."
      });
    }

    const querySymbol =
      kind === "class"
        ? {
            kind,
            name: name.replace(/\//g, "."),
            symbol: name.replace(/\//g, ".")
          }
        : {
            kind,
            name,
            owner: owner?.replace(/\//g, "."),
            descriptor: kind === "method" ? descriptor : undefined,
            symbol: `${owner?.replace(/\//g, ".")}.${name}${kind === "method" ? descriptor : ""}`
          };
    const sourcePriorityApplied = input.sourcePriority ?? this.config.mappingSourcePriority;

    const workspaceDetection = await this.workspaceMappingService.detectCompileMapping({
      projectPath
    });
    const warnings = [...workspaceDetection.warnings];
    if (!workspaceDetection.resolved || !workspaceDetection.mappingApplied) {
      return {
        querySymbol,
        mappingContext: {
          version,
          sourceMapping: input.sourceMapping,
          sourcePriorityApplied
        },
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        workspaceDetection,
        warnings
      };
    }

    const mappingApplied = workspaceDetection.mappingApplied;
    if (kind === "method") {
      const methodOwner = owner as string;
      const methodDescriptor = descriptor as string;
      const exact = await this.mappingService.resolveMethodMappingExact({
        version,
        owner: methodOwner,
        name,
        descriptor: methodDescriptor,
        sourceMapping: input.sourceMapping,
        targetMapping: mappingApplied,
        sourcePriority: input.sourcePriority,
        maxCandidates: input.maxCandidates
      });

      return {
        ...exact,
        workspaceDetection,
        warnings: [...warnings, ...exact.warnings]
      };
    }

    if (kind === "class") {
      const className = name.replace(/\//g, ".");
      const matrix = await this.mappingService.getClassApiMatrix({
        version,
        className,
        classNameMapping: input.sourceMapping,
        includeKinds: ["class"],
        sourcePriority: input.sourcePriority
      });

      const resolvedClass = matrix.classIdentity[mappingApplied];
      if (!resolvedClass) {
        return {
          querySymbol,
          mappingContext: {
            version,
            sourceMapping: input.sourceMapping,
            targetMapping: mappingApplied,
            sourcePriorityApplied
          },
          resolved: false,
          status: "not_found",
          candidates: [],
          candidateCount: 0,
          workspaceDetection,
          warnings: [...warnings, ...matrix.warnings]
        };
      }

      const normalizedClass = resolvedClass.replace(/\//g, ".");
      const resolvedSymbol = {
        kind: "class" as const,
        name: normalizedClass,
        symbol: normalizedClass
      };
      const resolvedCandidate = {
        ...resolvedSymbol,
        matchKind: "exact" as const,
        confidence: 1
      };

      return {
        querySymbol,
        mappingContext: {
          version,
          sourceMapping: input.sourceMapping,
          targetMapping: mappingApplied,
          sourcePriorityApplied
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol,
        candidates: [resolvedCandidate],
        candidateCount: 1,
        workspaceDetection,
        warnings: [...warnings, ...matrix.warnings]
      };
    }

    // By this point the method and class branches have already returned; only the field
    // branch reaches the generic findMapping fallthrough, and fields do not consume
    // signatureMode on the service side. Leave signatureMode undefined (service default =
    // "name-only" for any accidental future non-field caller hitting this path).
    const mapped = await this.mappingService.findMapping({
      version,
      kind,
      name,
      owner,
      descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: mappingApplied,
      sourcePriority: input.sourcePriority,
      maxCandidates: input.maxCandidates
    });

    const filtered = mapped.candidates.filter((candidate) => candidate.kind === kind);
    let status: ResolveWorkspaceSymbolOutput["status"];
    if (mapped.status === "mapping_unavailable") {
      status = "mapping_unavailable";
    } else if (filtered.length === 1) {
      status = "resolved";
    } else if (filtered.length > 1) {
      status = "ambiguous";
    } else {
      status = "not_found";
    }

    return {
      querySymbol: mapped.querySymbol,
      mappingContext: mapped.mappingContext,
      resolved: status === "resolved",
      status,
      resolvedSymbol: status === "resolved" ? filtered[0] : undefined,
      candidates: filtered,
      candidateCount: mapped.candidateCount,
      candidatesTruncated: mapped.candidatesTruncated,
      workspaceDetection,
      warnings: [...warnings, ...mapped.warnings]
    };
  }

  private async checkSymbolExistsInUnobfuscatedRuntime(
    input: CheckSymbolExistsInput,
    fallbackBase: CheckSymbolExistsOutput
  ): Promise<CheckSymbolExistsOutput | undefined> {
    const version = input.version.trim();
    const name = input.name.trim();
    const owner = input.owner?.trim();
    if (!version || !name) {
      return undefined;
    }

    if (input.kind === "class" && input.nameMode !== "fqcn" && !name.includes(".")) {
      return {
        ...fallbackBase,
        warnings: [
          ...fallbackBase.warnings,
          `Version ${version} is unobfuscated, but short class name "${name}" could not be checked against runtime bytecode without a fully-qualified name.`
        ]
      };
    }

    const querySymbol: MappingSymbolResolutionOutput["querySymbol"] =
      input.kind === "class"
        ? {
            kind: "class",
            name,
            symbol: name
          }
        : input.kind === "field"
          ? {
              kind: "field",
              owner,
              name,
              symbol: `${owner}.${name}`
            }
          : {
              kind: "method",
              owner,
              name,
              descriptor: input.descriptor?.trim(),
              symbol: `${owner}.${name}${input.descriptor?.trim() ?? ""}`
            };

    const targetClass = input.kind === "class" ? name : owner;
    if (!targetClass) {
      return fallbackBase;
    }

    let jarPath: string;
    try {
      ({ jarPath } = await this.versionService.resolveVersionJar(version));
    } catch {
      return undefined;
    }

    let signature: Awaited<ReturnType<MinecraftExplorerService["getSignature"]>>;
    try {
      signature = await this.explorerService.getSignature({
        fqn: targetClass,
        jarPath,
        access: "all"
      });
    } catch {
      return {
        ...fallbackBase,
        querySymbol,
        warnings: [
          ...fallbackBase.warnings,
          `Version ${version} is unobfuscated; runtime bytecode lookup could not load class "${targetClass}".`
        ]
      };
    }

    const warnings = [
      ...fallbackBase.warnings,
      ...signature.warnings,
      `Version ${version} is unobfuscated; validated symbol existence against runtime bytecode.`
    ];

    const buildResolved = (
      resolvedSymbol: MappingSymbolResolutionOutput["resolvedSymbol"]
    ): CheckSymbolExistsOutput => ({
      ...fallbackBase,
      querySymbol,
      resolved: true,
      status: "resolved",
      resolvedSymbol,
      candidates: resolvedSymbol
        ? [{
            ...resolvedSymbol,
            matchKind: "exact",
            confidence: 1
          }]
        : [],
      candidateCount: resolvedSymbol ? 1 : 0,
      warnings
    });

    const buildUnresolved = (status: CheckSymbolExistsOutput["status"]): CheckSymbolExistsOutput => ({
      ...fallbackBase,
      querySymbol,
      resolved: false,
      status,
      resolvedSymbol: undefined,
      candidates: [],
      candidateCount: 0,
      warnings
    });

    if (input.kind === "class") {
      return buildResolved({
        kind: "class",
        name,
        symbol: name
      });
    }

    if (input.kind === "field") {
      const matched = signature.fields.filter((field) => field.name === name);
      if (matched.length !== 1) {
        return buildUnresolved(matched.length > 1 ? "ambiguous" : "not_found");
      }
      return buildResolved({
        kind: "field",
        owner,
        name,
        symbol: `${owner}.${name}`
      });
    }

    const methodCandidates = signature.methods.filter((method) => method.name === name);
    if (input.signatureMode === "name-only") {
      if (methodCandidates.length !== 1) {
        return buildUnresolved(methodCandidates.length > 1 ? "ambiguous" : "not_found");
      }
      return buildResolved({
        kind: "method",
        owner,
        name,
        descriptor: methodCandidates[0]?.jvmDescriptor,
        symbol: `${owner}.${name}${methodCandidates[0]?.jvmDescriptor ?? ""}`
      });
    }

    const descriptor = input.descriptor?.trim();
    const matched = methodCandidates.filter((method) => method.jvmDescriptor === descriptor);
    if (matched.length !== 1) {
      return buildUnresolved(matched.length > 1 ? "ambiguous" : "not_found");
    }
    return buildResolved({
      kind: "method",
      owner,
      name,
      descriptor,
      symbol: `${owner}.${name}${descriptor ?? ""}`
    });
  }

  async traceSymbolLifecycle(input: TraceSymbolLifecycleInput): Promise<TraceSymbolLifecycleOutput> {
    const mapping = normalizeMapping(input.mapping);

    const {
      className: userClassName,
      methodName: userMethodName,
      inlineDescriptor
    } = parseQualifiedMethodSymbol(input.symbol);
    const descriptor = normalizeOptionalString(input.descriptor)
      ?? (looksLikeJvmMethodDescriptor(inlineDescriptor) ? normalizeOptionalString(inlineDescriptor) : undefined);
    const includeTimeline = input.includeTimeline ?? false;
    const includeSnapshots = input.includeSnapshots ?? false;
    const maxVersions = clampLimit(input.maxVersions, 120, 400);

    const manifestOrder = await this.versionService.listVersionIds({ includeSnapshots });
    if (manifestOrder.length === 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: "No Minecraft versions were returned by manifest.",
        details: {
          includeSnapshots,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const chronological = [...manifestOrder].reverse();
    const requestedFrom = normalizeOptionalString(input.fromVersion) ?? chronological[0];
    const requestedTo = normalizeOptionalString(input.toVersion) ?? chronological[chronological.length - 1];
    const fromIndex = chronological.indexOf(requestedFrom);
    const toIndex = chronological.indexOf(requestedTo);

    if (fromIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `fromVersion "${requestedFrom}" was not found in manifest.`,
        details: {
          fromVersion: requestedFrom,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }
    if (toIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `toVersion "${requestedTo}" was not found in manifest.`,
        details: {
          toVersion: requestedTo,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }
    if (fromIndex > toIndex) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "fromVersion must be older than or equal to toVersion.",
        details: { fromVersion: requestedFrom, toVersion: requestedTo }
      });
    }

    let selectedVersions = chronological.slice(fromIndex, toIndex + 1);
    const warnings: string[] = [];
    if (selectedVersions.length > maxVersions) {
      selectedVersions = selectedVersions.slice(selectedVersions.length - maxVersions);
      warnings.push(
        `Version scan truncated to ${maxVersions} entries. Effective fromVersion is now "${selectedVersions[0]}".`
      );
    }

    const referenceVersion = selectedVersions[selectedVersions.length - 1];
    await this.rejectLifecycleClassLikeInput({
      symbol: input.symbol,
      className: userClassName,
      methodName: userMethodName,
      mapping,
      version: referenceVersion,
      sourcePriority: input.sourcePriority
    });

    const scannedResults = await mapWithConcurrencyLimit(
      selectedVersions,
      TRACE_LIFECYCLE_MAX_CONCURRENCY,
      async (version) => {
        const versionWarnings: string[] = [];

        try {
          const [obfuscatedClassName, obfuscatedMethod, resolvedJar] = await Promise.all([
            this.resolveToObfuscatedClassName(
              userClassName,
              version,
              mapping,
              input.sourcePriority,
              versionWarnings
            ),
            this.resolveToObfuscatedMemberName(
              userMethodName,
              userClassName,
              descriptor,
              "method",
              version,
              mapping,
              input.sourcePriority,
              versionWarnings
            ),
            this.versionService.resolveVersionJar(version)
          ]);

          const signature = await this.explorerService.getSignature({
            fqn: obfuscatedClassName,
            jarPath: resolvedJar.jarPath,
            access: "all",
            includeSynthetic: true
          });
          const sameNameMethods = signature.methods.filter((method) => method.name === obfuscatedMethod.name);
          const effectiveDescriptor = obfuscatedMethod.descriptor ?? descriptor;
          const matchesDescriptor = effectiveDescriptor
            ? sameNameMethods.some((method) => method.jvmDescriptor === effectiveDescriptor)
            : sameNameMethods.length > 0;
          const reason =
            !matchesDescriptor && descriptor && sameNameMethods.length > 0 ? "descriptor-mismatch" : undefined;

          return {
            entry: {
              version,
              exists: matchesDescriptor,
              reason,
              determinate: true
            } satisfies LifecycleScanEntry,
            warnings: versionWarnings
          };
        } catch (caughtError) {
          if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
            return {
              entry: {
                version,
                exists: false,
                reason: "class-not-found",
                determinate: true
              } satisfies LifecycleScanEntry,
              warnings: versionWarnings
            };
          }

          versionWarnings.push(
            `Failed to evaluate ${version}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
          );
          return {
            entry: {
              version,
              exists: false,
              reason: "unresolved",
              determinate: false
            } satisfies LifecycleScanEntry,
            warnings: versionWarnings
          };
        } finally {
          this.releaseLifecycleMappingGraph(version, input.sourcePriority);
        }
      }
    );

    const scanned = scannedResults.map((result) => result.entry);
    for (const result of scannedResults) {
      warnings.push(...result.warnings);
    }

    const determinate = scanned.filter((entry) => entry.determinate);
    const present = determinate.filter((entry) => entry.exists);
    const firstSeen = present[0]?.version;
    const lastSeen = present[present.length - 1]?.version;
    const missingBetween: string[] = [];

    if (firstSeen && lastSeen) {
      const firstSeenIndex = determinate.findIndex((entry) => entry.version === firstSeen);
      const lastSeenIndex = determinate.findIndex((entry) => entry.version === lastSeen);
      for (let index = firstSeenIndex; index <= lastSeenIndex; index += 1) {
        const entry = determinate[index];
        if (entry && !entry.exists) {
          missingBetween.push(entry.version);
        }
      }
    }

    const toVersionEntry = scanned.find((entry) => entry.version === selectedVersions[selectedVersions.length - 1]);
    const existsNow = toVersionEntry?.determinate ? toVersionEntry.exists : false;
    if (toVersionEntry && !toVersionEntry.determinate) {
      warnings.push(`Latest requested version "${toVersionEntry.version}" could not be evaluated.`);
    }

    return {
      query: {
        className: userClassName,
        methodName: userMethodName,
        descriptor,
        mapping
      },
      range: {
        fromVersion: selectedVersions[0],
        toVersion: selectedVersions[selectedVersions.length - 1],
        scannedCount: selectedVersions.length
      },
      presence: {
        firstSeen,
        lastSeen,
        missingBetween,
        existsNow
      },
      timeline: includeTimeline
        ? scanned.map((entry) => ({
            version: entry.version,
            exists: entry.exists,
            reason: entry.reason
          }))
        : undefined,
      warnings
    };
  }

  async diffClassSignatures(input: DiffClassSignaturesInput): Promise<DiffClassSignaturesOutput> {
    const className = input.className.trim();
    const fromVersion = input.fromVersion.trim();
    const toVersion = input.toVersion.trim();
    const includeFullDiff = input.includeFullDiff ?? true;
    if (!className || !fromVersion || !toVersion) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className, fromVersion, and toVersion must be non-empty strings.",
        details: {
          className: input.className,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion
        }
      });
    }

    const mapping = normalizeMapping(input.mapping);

    const manifestOrder = await this.versionService.listVersionIds();
    if (manifestOrder.length === 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: "No Minecraft versions were returned by manifest.",
        details: {
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const chronological = [...manifestOrder].reverse();
    const fromIndex = chronological.indexOf(fromVersion);
    const toIndex = chronological.indexOf(toVersion);

    if (fromIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `fromVersion "${fromVersion}" was not found in manifest.`,
        details: {
          fromVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }
    if (toIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `toVersion "${toVersion}" was not found in manifest.`,
        details: {
          toVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }
    if (fromIndex > toIndex) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "fromVersion must be older than or equal to toVersion.",
        details: { fromVersion, toVersion }
      });
    }

    const mappingWarnings: string[] = [];
    const obfuscatedFromClassName = await this.resolveToObfuscatedClassName(
      className,
      fromVersion,
      mapping,
      input.sourcePriority,
      mappingWarnings
    );
    const obfuscatedToClassName =
      fromVersion === toVersion
        ? obfuscatedFromClassName
        : await this.resolveToObfuscatedClassName(
            className,
            toVersion,
            mapping,
            input.sourcePriority,
            mappingWarnings
          );

    const [fromResolved, toResolved] = await Promise.all([
      this.versionService.resolveVersionJar(fromVersion),
      this.versionService.resolveVersionJar(toVersion)
    ]);

    const loadSignature = async (
      version: string,
      jarPath: string,
      obfuscatedClassName: string
    ): Promise<SignatureSnapshot | undefined> => {
      try {
        const signature = await this.explorerService.getSignature({
          fqn: obfuscatedClassName,
          jarPath,
          access: "all",
          includeSynthetic: false,
          includeInherited: false
        });
        return {
          constructors: signature.constructors,
          fields: signature.fields,
          methods: signature.methods,
          warnings: signature.warnings
        };
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
          return undefined;
        }
        throw caughtError;
      }
    };

    const [fromSignature, toSignature] = await Promise.all([
      loadSignature(fromVersion, fromResolved.jarPath, obfuscatedFromClassName),
      loadSignature(toVersion, toResolved.jarPath, obfuscatedToClassName)
    ]);

    const warnings: string[] = [...mappingWarnings];
    if (fromSignature) {
      warnings.push(...fromSignature.warnings.map((warning) => `[${fromVersion}] ${warning}`));
    }
    if (toSignature) {
      warnings.push(...toSignature.warnings.map((warning) => `[${toVersion}] ${warning}`));
    }

    let classChange: DiffClassChange = "present_in_both";
    if (!fromSignature && !toSignature) {
      classChange = "absent_in_both";
      warnings.push(`Class "${className}" was not found in both versions.`);
    } else if (!fromSignature) {
      classChange = "added";
    } else if (!toSignature) {
      classChange = "removed";
    }

    const fromMembers = fromSignature ?? {
      constructors: [],
      fields: [],
      methods: [],
      warnings: []
    };
    const toMembers = toSignature ?? {
      constructors: [],
      fields: [],
      methods: [],
      warnings: []
    };

    const constructors =
      classChange === "added"
        ? {
            added: sortDiffMembers(toMembers.constructors),
            removed: [],
            modified: []
          }
        : classChange === "removed"
          ? {
              added: [],
              removed: sortDiffMembers(fromMembers.constructors),
              modified: []
            }
          : classChange === "absent_in_both"
            ? emptyDiffDelta()
            : diffMembersByKey(fromMembers.constructors, toMembers.constructors, (member) => member.jvmDescriptor, false);

    const methods =
      classChange === "added"
        ? {
            added: sortDiffMembers(toMembers.methods),
            removed: [],
            modified: []
          }
        : classChange === "removed"
          ? {
              added: [],
              removed: sortDiffMembers(fromMembers.methods),
              modified: []
            }
          : classChange === "absent_in_both"
            ? emptyDiffDelta()
            : diffMembersByKey(
                fromMembers.methods,
                toMembers.methods,
                (member) => `${member.name}#${member.jvmDescriptor}`,
                false
              );

    const fields =
      classChange === "added"
        ? {
            added: sortDiffMembers(toMembers.fields),
            removed: [],
            modified: []
          }
        : classChange === "removed"
          ? {
              added: [],
              removed: sortDiffMembers(fromMembers.fields),
              modified: []
            }
          : classChange === "absent_in_both"
            ? emptyDiffDelta()
            : diffMembersByKey(fromMembers.fields, toMembers.fields, (member) => member.name, true);

    // Remap diff delta members for non-obfuscated mappings
    const remapDelta = async (
      delta: DiffClassMemberDelta,
      kind: "field" | "method"
    ): Promise<DiffClassMemberDelta> => {
      const [addedResult, removedResult] = await Promise.all([
        this.remapSignatureMembers(delta.added, kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings),
        this.remapSignatureMembers(delta.removed, kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings)
      ]);
      const remappedModified = await Promise.all(
        delta.modified.map(async (change) => {
          if (!change.from || !change.to) {
            throw createError({
              code: ERROR_CODES.INTERNAL,
              message: "Modified diff members are missing before remap.",
              details: {
                key: change.key,
                kind,
                fromVersion,
                toVersion,
                mapping
              }
            });
          }
          const [fromResult, toResult] = await Promise.all([
            this.remapSignatureMembers([change.from], kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings),
            this.remapSignatureMembers([change.to], kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings)
          ]);
          const fromMember = fromResult.members[0];
          const toMember = toResult.members[0];
          if (!fromMember || !toMember) {
            throw createError({
              code: ERROR_CODES.INTERNAL,
              message: "Failed to remap modified diff members.",
              details: {
                key: change.key,
                kind,
                fromVersion,
                toVersion,
                mapping
              }
            });
          }
          return { ...change, from: fromMember, to: toMember };
        })
      );
      return { added: addedResult.members, removed: removedResult.members, modified: remappedModified };
    };

    const [remappedConstructors, remappedMethods, remappedFields] = await Promise.all([
      remapDelta(constructors, "method"),
      remapDelta(methods, "method"),
      remapDelta(fields, "field")
    ]);

    const summary = {
      constructors: {
        added: remappedConstructors.added.length,
        removed: remappedConstructors.removed.length,
        modified: remappedConstructors.modified.length
      },
      methods: {
        added: remappedMethods.added.length,
        removed: remappedMethods.removed.length,
        modified: remappedMethods.modified.length
      },
      fields: {
        added: remappedFields.added.length,
        removed: remappedFields.removed.length,
        modified: remappedFields.modified.length
      },
      total: {
        added: remappedConstructors.added.length + remappedMethods.added.length + remappedFields.added.length,
        removed: remappedConstructors.removed.length + remappedMethods.removed.length + remappedFields.removed.length,
        modified: remappedConstructors.modified.length + remappedMethods.modified.length + remappedFields.modified.length
      }
    };

    return {
      query: {
        className,
        fromVersion,
        toVersion,
        mapping
      },
      range: {
        fromVersion,
        toVersion
      },
      classChange,
      constructors: includeFullDiff ? remappedConstructors : compactDiffDelta(remappedConstructors),
      methods: includeFullDiff ? remappedMethods : compactDiffDelta(remappedMethods),
      fields: includeFullDiff ? remappedFields : compactDiffDelta(remappedFields),
      summary,
      warnings
    };
  }

  findClass(input: FindClassInput): FindClassOutput {
    const className = input.className.trim();
    if (!className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className must be non-empty."
      });
    }
    const inputArtifactId = input.artifactId.trim();
    if (!inputArtifactId) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId must be non-empty."
      });
    }
    // Verify artifact exists. The input may be either a 64-char artifactId or
    // an alias; normalize to the canonical row id so downstream symbolsRepo
    // calls (keyed by artifact_id only) do not silently miss for alias input.
    const artifact = this.getArtifact(inputArtifactId);
    const artifactId = artifact.artifactId;

    const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
    const warnings: string[] = [];
    const isQualified = className.includes(".");

    if (isQualified) {
      // Qualified name: fetch a broad candidate set first, then filter to exact class path/FQCN.
      // Limiting before filtering can miss the target when many packages share the same simple name.
      const classPath = className.replace(/\./g, "/");
      const result = this.symbolsRepo.findScopedSymbols({
        artifactId,
        query: className.split(".").at(-1) ?? className,
        match: "exact",
        limit: 5000
      });
      const matches = result.items
        .filter((row) => {
          const isTypeSymbol = row.symbolKind === "class" || row.symbolKind === "interface" ||
            row.symbolKind === "enum" || row.symbolKind === "record";
          if (!isTypeSymbol) return false;
          const rowQualified = row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", ".");
          return rowQualified === className || row.filePath === `${classPath}.java`;
        })
        .map((row) => ({
          qualifiedName: row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", "."),
          filePath: row.filePath,
          line: row.line,
          symbolKind: row.symbolKind
        }))
        .slice(0, limit);
      const partialVanillaLookup =
        hasPartialNetMinecraftCoverage(artifact.qualityFlags) && looksLikeDeobfuscatedClassName(className);
      const filteredMatches =
        partialVanillaLookup && matches.every((match) =>
          !match.qualifiedName.startsWith("net.minecraft.") && !match.qualifiedName.startsWith("com.mojang.")
        )
          ? []
          : matches;
      if (filteredMatches.length === 0 && partialVanillaLookup) {
        warnings.push(
          `Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches for "${className}" would be misleading. Use get-class-source/get-class-members for binary fallback or get-class-api-matrix for mapped API inspection.`
        );
      }
      if (filteredMatches.length === 0 && artifact.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(className)) {
        warnings.push(`No exact class symbol matched "${className}". ${obfuscatedNamespaceHint(className)}`);
      }
      return { matches: filteredMatches, total: filteredMatches.length, warnings };
    }

    // Simple name: search for exact symbol name match among type symbols
    const result = this.symbolsRepo.findScopedSymbols({
      artifactId,
      query: className,
      match: "exact",
      limit: limit * 5 // over-fetch to filter by kind
    });
    const matches: FindClassMatch[] = [];
    for (const row of result.items) {
      if (matches.length >= limit) break;
      const isTypeSymbol = row.symbolKind === "class" || row.symbolKind === "interface" ||
        row.symbolKind === "enum" || row.symbolKind === "record";
      if (!isTypeSymbol) continue;
      matches.push({
        qualifiedName: row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", "."),
        filePath: row.filePath,
        line: row.line,
        symbolKind: row.symbolKind
      });
    }
    const partialVanillaLookup =
      hasPartialNetMinecraftCoverage(artifact.qualityFlags) && looksLikeDeobfuscatedClassName(className);
    const filteredMatches =
      partialVanillaLookup && matches.every((match) =>
        !match.qualifiedName.startsWith("net.minecraft.") && !match.qualifiedName.startsWith("com.mojang.")
      )
        ? []
        : matches;
    if (filteredMatches.length === 0 && partialVanillaLookup) {
      warnings.push(
        `Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches for "${className}" would be misleading. Use get-class-source/get-class-members for binary fallback or get-class-api-matrix for mapped API inspection.`
      );
    }
    if (filteredMatches.length === 0 && artifact.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(className)) {
      warnings.push(`No exact class symbol matched "${className}". ${obfuscatedNamespaceHint(className)}`);
    }
    return { matches: filteredMatches, total: filteredMatches.length, warnings };
  }

  async getClassSource(input: GetClassSourceInput): Promise<GetClassSourceOutput> {
    const className = input.className.trim();
    if (!className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className must be non-empty."
      });
    }

    const mode: SourceMode = input.mode ?? "metadata";

    const startLine = normalizeStrictPositiveInt(input.startLine, "startLine");
    const endLine = normalizeStrictPositiveInt(input.endLine, "endLine");
    let maxLines = normalizeStrictPositiveInt(input.maxLines, "maxLines");
    const maxChars = normalizeStrictPositiveInt(input.maxChars, "maxChars");
    const outputFile = normalizeOptionalString(input.outputFile);

    // In snippet mode, default maxLines to 200 when no range or maxLines is specified
    if (mode === "snippet" && startLine == null && endLine == null && maxLines == null) {
      maxLines = 200;
    }

    if (startLine != null && endLine != null && startLine > endLine) {
      throw createError({
        code: ERROR_CODES.INVALID_LINE_RANGE,
        message: `Invalid line range: startLine (${startLine}) is greater than endLine (${endLine}).`,
        details: {
          startLine,
          endLine
        }
      });
    }

    const normalizedArtifactId = normalizeOptionalString(input.artifactId);
    if (normalizedArtifactId && input.target) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId and target are mutually exclusive.",
        details: {
          artifactId: normalizedArtifactId,
          target: input.target
        }
      });
    }

    let artifactId = normalizedArtifactId;
    let origin: ResolvedSourceArtifact["origin"] = "local-jar";
    let warnings: string[] = [];
    let requestedMapping: SourceMapping = normalizeMapping(input.mapping);
    let mappingApplied: SourceMapping = requestedMapping;
    let provenance: ArtifactProvenance | undefined;
    let qualityFlags: string[] = [];
    let sourceJarPath: string | undefined;
    let binaryJarPath: string | undefined;
    let version: string | undefined;
    let coordinate: string | undefined;
    if (!artifactId) {
      if (!input.target) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "Either artifactId or target must be provided."
        });
      }

      const resolved = await this.resolveArtifact({
        target: input.target,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        allowDecompile: input.allowDecompile,
        projectPath: input.projectPath,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion,
        strictVersion: input.strictVersion
      });
      artifactId = resolved.artifactId;
      origin = resolved.origin;
      warnings = [...resolved.warnings];
      requestedMapping = resolved.requestedMapping;
      mappingApplied = resolved.mappingApplied;
      provenance = resolved.provenance;
      qualityFlags = [...resolved.qualityFlags];
      sourceJarPath = resolved.resolvedSourceJarPath;
      binaryJarPath = resolved.binaryJarPath;
      version = resolved.version;
      coordinate = resolved.coordinate;
    } else {
      const artifact = this.getArtifact(artifactId);
      // Normalize alias input to the canonical row id so downstream
      // resolveClassFilePath / filesRepo lookups (keyed by 64-char
      // artifact_id only) do not silently miss when the caller passed an
      // alias from a previous resolveArtifact response.
      artifactId = artifact.artifactId;
      origin = artifact.origin;
      requestedMapping = artifact.requestedMapping ?? requestedMapping;
      mappingApplied = artifact.mappingApplied ?? requestedMapping;
      provenance = artifact.provenance;
      qualityFlags = artifact.qualityFlags;
      sourceJarPath = artifact.sourceJarPath;
      binaryJarPath = artifact.binaryJarPath;
      version = artifact.version;
      coordinate = artifact.coordinate;
    }

    version = await this.resolveVersionContext({
      version,
      provenance,
      coordinate,
      projectPath: input.projectPath,
      preferProjectVersion: input.preferProjectVersion,
      warnings
    });

    let activeArtifactId = artifactId;
    let activeOrigin = origin;
    let activeProvenance = provenance;
    let activeQualityFlags = [...qualityFlags];
    let activeMappingApplied = mappingApplied;
    let activeSourceJarPath = sourceJarPath;
    let attemptedBinaryFallback = false;
    const tryBinaryFallback = async (): Promise<boolean> => {
      if (attemptedBinaryFallback) {
        return false;
      }
      attemptedBinaryFallback = true;
      const normalizedBinaryJarPath = normalizeOptionalString(binaryJarPath);
      if (!normalizedBinaryJarPath) {
        return false;
      }
      if (
        activeSourceJarPath &&
        normalizePathStyle(activeSourceJarPath) === normalizePathStyle(normalizedBinaryJarPath)
      ) {
        return false;
      }

      const fallbackResolved = await this.resolveBinaryFallbackArtifact({
        binaryJarPath: normalizedBinaryJarPath,
        version,
        coordinate,
        requestedMapping,
        mappingApplied,
        provenance: activeProvenance,
        qualityFlags: activeQualityFlags
      });
      if (!fallbackResolved || fallbackResolved.artifactId === activeArtifactId) {
        return false;
      }

      activeArtifactId = fallbackResolved.artifactId;
      activeOrigin = fallbackResolved.origin;
      activeMappingApplied = fallbackResolved.mappingApplied ?? activeMappingApplied;
      activeProvenance = fallbackResolved.provenance ?? activeProvenance;
      activeQualityFlags = dedupeQualityFlags([...(fallbackResolved.qualityFlags ?? []), "binary-fallback"]);
      activeSourceJarPath = fallbackResolved.sourceJarPath;
      warnings.push(
        `Falling back to binary artifact "${normalizedBinaryJarPath}" because source coverage for "${className}" was incomplete.`
      );
      if (activeMappingApplied !== requestedMapping) {
        warnings.push(
          `Fallback source text is indexed in ${activeMappingApplied} names; returned source is not remapped to ${requestedMapping}.`
        );
      }
      return true;
    };

    let activeLookupClassName = await this.resolveClassNameForLookup({
      className,
      version,
      sourceMapping: requestedMapping,
      targetMapping: activeMappingApplied,
      sourcePriority: input.sourcePriority,
      warnings,
      context: "source lookup"
    });
    let filePath = this.resolveClassFilePath(activeArtifactId, activeLookupClassName);
    if (!filePath && (await tryBinaryFallback())) {
      activeLookupClassName = await this.resolveClassNameForLookup({
        className,
        version,
        sourceMapping: requestedMapping,
        targetMapping: activeMappingApplied,
        sourcePriority: input.sourcePriority,
        warnings,
        context: "source lookup"
      });
      filePath = this.resolveClassFilePath(activeArtifactId, activeLookupClassName);
    }
    if (!filePath) {
      throw this.buildClassSourceNotFoundError({
        artifactId: activeArtifactId,
        className,
        lookupClassName: activeLookupClassName,
        mappingApplied: activeMappingApplied,
        requestedMapping,
        qualityFlags: activeQualityFlags,
        attemptedBinaryFallback,
        targetKind: input.target?.kind,
        targetValue:
          input.target && "value" in input.target ? input.target.value : undefined,
        scope: input.scope,
        projectPath: input.projectPath,
        version
      });
    }

    let row = this.filesRepo.getFileContent(activeArtifactId, filePath);
    if (!row && (await tryBinaryFallback())) {
      activeLookupClassName = await this.resolveClassNameForLookup({
        className,
        version,
        sourceMapping: requestedMapping,
        targetMapping: activeMappingApplied,
        sourcePriority: input.sourcePriority,
        warnings,
        context: "source lookup"
      });
      filePath = this.resolveClassFilePath(activeArtifactId, activeLookupClassName) ?? filePath;
      row = this.filesRepo.getFileContent(activeArtifactId, filePath);
    }
    if (!row) {
      throw this.buildClassSourceNotFoundError({
        artifactId: activeArtifactId,
        className,
        lookupClassName: activeLookupClassName,
        mappingApplied: activeMappingApplied,
        requestedMapping,
        qualityFlags: activeQualityFlags,
        attemptedBinaryFallback,
        filePath,
        targetKind: input.target?.kind,
        targetValue:
          input.target && "value" in input.target ? input.target.value : undefined,
        scope: input.scope,
        projectPath: input.projectPath,
        version
      });
    }

    const lines = row.content.split(/\r?\n/);
    const totalLines = lines.length;

    let sourceText: string;
    let returnedStart: number;
    let returnedEnd: number;
    let truncated = false;
    let charsTruncated = false;

    if (mode === "metadata") {
      const metadataText = this.extractClassMetadata(filePath, row.content);
      sourceText = metadataText;
      returnedStart = 1;
      returnedEnd = totalLines;
      truncated = false;
    } else {
      // snippet and full modes use the existing line-range logic
      const requestedStart = startLine ?? 1;
      const requestedEnd = endLine ?? totalLines;
      const normalizedStart = Math.min(Math.max(1, requestedStart), Math.max(totalLines, 1));
      const normalizedEnd = Math.min(Math.max(normalizedStart, requestedEnd), Math.max(totalLines, 1));
      let selectedLines = lines.slice(normalizedStart - 1, normalizedEnd);
      const clippedByRange = normalizedStart !== requestedStart || normalizedEnd !== requestedEnd;

      let clippedByMax = false;
      if (maxLines != null && selectedLines.length > maxLines) {
        selectedLines = selectedLines.slice(0, maxLines);
        clippedByMax = true;
      }

      sourceText = selectedLines.join("\n");
      returnedStart = normalizedStart;
      returnedEnd = normalizedStart + Math.max(0, selectedLines.length - 1);
      truncated = clippedByRange || clippedByMax;
    }

    // Apply maxChars truncation
    if (maxChars != null && sourceText.length > maxChars) {
      sourceText = sourceText.slice(0, maxChars);
      charsTruncated = true;
      truncated = true;
    }

    // Write to file if outputFile is specified
    let resolvedOutputFile: string | undefined;
    if (outputFile) {
      const outputPath = isAbsolute(outputFile)
        ? outputFile
        : resolvePath(outputFile);
      await writeFile(outputPath, sourceText, "utf8");
      resolvedOutputFile = outputPath;
      sourceText = `[Written to ${outputPath}]`;
    }

    const normalizedProvenance =
      activeProvenance ??
      this.buildFallbackProvenance({
        artifactId: activeArtifactId,
        origin: activeOrigin,
        requestedMapping,
        mappingApplied: activeMappingApplied
      });

    return {
      className,
      mode,
      sourceText,
      totalLines,
      returnedRange: {
        start: returnedStart,
        end: returnedEnd
      },
      truncated,
      ...(charsTruncated ? { charsTruncated } : {}),
      origin: activeOrigin,
      artifactId: activeArtifactId,
      requestedMapping,
      mappingApplied: activeMappingApplied,
      returnedNamespace: activeMappingApplied,
      provenance: normalizedProvenance,
      qualityFlags: activeQualityFlags,
      artifactContents: this.buildArtifactContentsSummary({
        origin: activeOrigin,
        sourceJarPath: activeSourceJarPath,
        isDecompiled: activeOrigin === "decompiled",
        qualityFlags: activeQualityFlags
      }),
      ...(resolvedOutputFile ? { outputFile: resolvedOutputFile } : {}),
      warnings
    };
  }

  async getClassMembers(input: GetClassMembersInput): Promise<GetClassMembersOutput> {
    const className = input.className.trim();
    if (!className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className must be non-empty."
      });
    }

    const requestedMapping = normalizeMapping(input.mapping);

    const access = normalizeMemberAccess(input.access);
    const includeSynthetic = input.includeSynthetic ?? false;
    const includeInherited = input.includeInherited ?? false;
    const memberPattern = normalizeOptionalString(input.memberPattern);
    const parsedMaxMembers = normalizeStrictPositiveInt(input.maxMembers, "maxMembers");
    const maxMembers = parsedMaxMembers == null ? 500 : Math.min(parsedMaxMembers, 5000);

    const normalizedArtifactId = normalizeOptionalString(input.artifactId);
    if (normalizedArtifactId && input.target) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId and target are mutually exclusive.",
        details: {
          artifactId: normalizedArtifactId,
          target: input.target
        }
      });
    }

    let artifactId = normalizedArtifactId;
    let origin: ResolvedSourceArtifact["origin"] = "local-jar";
    let warnings: string[] = [];
    let mappingApplied: SourceMapping = requestedMapping;
    let provenance: ArtifactProvenance | undefined;
    let qualityFlags: string[] = [];
    let binaryJarPath: string | undefined;
    let sourceJarPath: string | undefined;
    let coordinate: string | undefined;

    if (parsedMaxMembers != null && parsedMaxMembers > 5000) {
      warnings.push(`maxMembers was clamped to 5000 from ${parsedMaxMembers}.`);
    }

    let version: string | undefined;

    if (!artifactId) {
      if (!input.target) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "Either artifactId or target must be provided."
        });
      }

      const resolved = await this.resolveArtifact({
        target: input.target,
        mapping: requestedMapping,
        sourcePriority: input.sourcePriority,
        allowDecompile: input.allowDecompile,
        projectPath: input.projectPath,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion,
        strictVersion: input.strictVersion
      });
      artifactId = resolved.artifactId;
      origin = resolved.origin;
      warnings.push(...resolved.warnings);
      mappingApplied = resolved.mappingApplied;
      provenance = resolved.provenance;
      qualityFlags = [...resolved.qualityFlags];
      binaryJarPath = resolved.binaryJarPath;
      sourceJarPath = resolved.resolvedSourceJarPath;
      version = resolved.version;
      coordinate = resolved.coordinate;
    } else {
      const artifact = this.getArtifact(artifactId);
      // Normalize alias input to canonical row id; downstream files/symbols
      // lookups use this id directly.
      artifactId = artifact.artifactId;
      origin = artifact.origin;
      mappingApplied = artifact.mappingApplied ?? requestedMapping;
      provenance = artifact.provenance;
      qualityFlags = artifact.qualityFlags;
      binaryJarPath = artifact.binaryJarPath;
      sourceJarPath = artifact.sourceJarPath;
      version = artifact.version;
      coordinate = artifact.coordinate;
    }

    version = await this.resolveVersionContext({
      version,
      provenance,
      coordinate,
      projectPath: input.projectPath,
      preferProjectVersion: input.preferProjectVersion,
      warnings
    });

    if (requestedMapping !== "obfuscated" && !version) {
      throw createError({
        code: ERROR_CODES.MAPPING_NOT_APPLIED,
        message: `Non-obfuscated mapping "${requestedMapping}" requires a version, but none was resolved.`,
        details: {
          mapping: requestedMapping,
          nextAction:
            "Resolve with target: { kind: \"version\", value: ... } or specify a versioned coordinate.",
          suggestedCall: {
            tool: "resolve-artifact",
            params: buildResolveArtifactParams({ kind: "version", value: "latest" })
          }
        }
      });
    }

    if (!binaryJarPath) {
      throw createError({
        code: ERROR_CODES.CONTEXT_UNRESOLVED,
        message: `Class members require a binary jar, but artifact "${artifactId}" has no binaryJarPath.`,
        details: {
          artifactId,
          className,
          nextAction:
            "Resolve with target: { kind: \"jar\" | \"version\", value: ... } or use an artifact that has a binary jar."
        }
      });
    }

    const lookupClassName = await this.resolveClassNameForLookup({
      className,
      version,
      sourceMapping: requestedMapping,
      targetMapping: mappingApplied,
      sourcePriority: input.sourcePriority,
      warnings,
      context: "binary lookup"
    });

    const signature = await this.explorerService.getSignature({
      fqn: lookupClassName,
      jarPath: binaryJarPath,
      access,
      includeSynthetic,
      includeInherited,
      memberPattern: requestedMapping === mappingApplied ? memberPattern : undefined
    });
    warnings.push(...signature.warnings);

    let remappedConstructors =
      version != null
        ? (
            await this.remapSignatureMembers(
              signature.constructors,
              "method",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signature.constructors;
    let remappedFields =
      version != null
        ? (
            await this.remapSignatureMembers(
              signature.fields,
              "field",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signature.fields;
    let remappedMethods =
      version != null
        ? (
            await this.remapSignatureMembers(
              signature.methods,
              "method",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signature.methods;

    // Apply memberPattern after remap when the lookup namespace differs from the requested namespace.
    if (requestedMapping !== mappingApplied && memberPattern) {
      const lowerPattern = memberPattern.toLowerCase();
      remappedConstructors = remappedConstructors.filter((m) => m.name.toLowerCase().includes(lowerPattern));
      remappedFields = remappedFields.filter((m) => m.name.toLowerCase().includes(lowerPattern));
      remappedMethods = remappedMethods.filter((m) => m.name.toLowerCase().includes(lowerPattern));
    }

    const counts = {
      constructors: remappedConstructors.length,
      fields: remappedFields.length,
      methods: remappedMethods.length,
      total: remappedConstructors.length + remappedFields.length + remappedMethods.length
    };

    let remaining = maxMembers;
    const takeWithinLimit = (members: SignatureMember[]): SignatureMember[] => {
      if (remaining <= 0) {
        return [];
      }
      const slice = members.slice(0, remaining);
      remaining -= slice.length;
      return slice;
    };

    const constructors = takeWithinLimit(remappedConstructors);
    const fields = takeWithinLimit(remappedFields);
    const methods = takeWithinLimit(remappedMethods);
    const returnedTotal = constructors.length + fields.length + methods.length;
    const truncated = returnedTotal < counts.total;
    if (truncated) {
      warnings.push(`Member list was truncated to ${returnedTotal} entries (from ${counts.total}).`);
    }

    const normalizedProvenance =
      provenance ??
      this.buildFallbackProvenance({
        artifactId,
        origin,
        requestedMapping,
        mappingApplied
      });

    let decompiledFallback: DecompiledFallback | undefined;
    let decompiledMemberCounts: GetClassMembersOutput["decompiledMemberCounts"];
    let fallbackQualityFlags = qualityFlags;

    if (counts.total === 0) {
      // When the request namespace differs from the artifact namespace, the
      // caller's memberPattern is authored against requested-namespace names
      // (e.g. a Mojang pattern). The fallback extracts artifact-namespace
      // names (e.g. obfuscated), so filtering by the raw pattern would
      // silently drop every entry. Skip the filter in that case and warn.
      const namespaceMismatch = requestedMapping !== mappingApplied;
      const fallbackPattern = namespaceMismatch ? undefined : memberPattern;
      const sourceFallback = this.buildDecompiledFallback(
        artifactId,
        lookupClassName,
        fallbackPattern,
        maxMembers
      );
      if (sourceFallback) {
        decompiledFallback = sourceFallback.fallback;
        decompiledMemberCounts = sourceFallback.counts;
        fallbackQualityFlags = dedupeQualityFlags([
          ...qualityFlags,
          "members-from-decompiled-source"
        ]);
        const namespaceNote = namespaceMismatch
          ? ` Member names are in ${mappingApplied} (artifact namespace); the request asked for ${requestedMapping}.`
          : "";
        warnings.push(
          "Bytecode member enumeration returned zero; populated decompiledFallback from decompiled source. "
          + "Descriptors and access modifiers are unavailable — use get-class-source for full details."
          + namespaceNote
        );
        if (namespaceMismatch && memberPattern) {
          warnings.push(
            `memberPattern="${memberPattern}" was not applied to decompiledFallback because the artifact namespace (${mappingApplied}) differs from the requested namespace (${requestedMapping}); filter the response client-side after mapping.`
          );
        }
      }
    }

    return {
      className,
      members: {
        constructors,
        fields,
        methods
      },
      counts,
      truncated,
      context: signature.context,
      origin,
      artifactId,
      requestedMapping,
      mappingApplied,
      returnedNamespace: requestedMapping,
      provenance: normalizedProvenance,
      qualityFlags: fallbackQualityFlags,
      artifactContents: this.buildArtifactContentsSummary({
        origin,
        sourceJarPath,
        isDecompiled: origin === "decompiled",
        qualityFlags: fallbackQualityFlags
      }),
      ...(decompiledFallback ? { decompiledFallback } : {}),
      ...(decompiledMemberCounts ? { decompiledMemberCounts } : {}),
      warnings
    };
  }

  private buildDecompiledFallback(
    artifactId: string,
    lookupClassName: string,
    memberPattern: string | undefined,
    maxMembers: number
  ): { fallback: DecompiledFallback; counts: NonNullable<GetClassMembersOutput["decompiledMemberCounts"]> } | undefined {
    const filePath = this.resolveClassFilePath(artifactId, lookupClassName);
    if (!filePath) {
      return undefined;
    }
    const row = this.filesRepo.getFileContent(artifactId, filePath);
    if (!row) {
      return undefined;
    }
    const extracted = this.extractDecompiledMembers(lookupClassName, filePath, row.content);
    const filterByPattern = (list: DecompiledMember[]): DecompiledMember[] => {
      if (!memberPattern) {
        return list;
      }
      const lower = memberPattern.toLowerCase();
      return list.filter((entry) => entry.name.toLowerCase().includes(lower));
    };
    let constructors = filterByPattern(extracted.constructors);
    let fields = filterByPattern(extracted.fields);
    let methods = filterByPattern(extracted.methods);
    const totalBefore = constructors.length + fields.length + methods.length;
    if (totalBefore === 0) {
      return undefined;
    }
    let remaining = maxMembers;
    const takeWithinLimit = <T,>(list: T[]): T[] => {
      if (remaining <= 0) {
        return [];
      }
      const slice = list.slice(0, remaining);
      remaining -= slice.length;
      return slice;
    };
    constructors = takeWithinLimit(constructors);
    fields = takeWithinLimit(fields);
    methods = takeWithinLimit(methods);
    return {
      fallback: {
        constructors,
        fields,
        methods,
        origin: "source-extracted"
      },
      counts: {
        constructors: constructors.length,
        fields: fields.length,
        methods: methods.length,
        total: constructors.length + fields.length + methods.length
      }
    };
  }

  async validateMixin(
    input: ValidateMixinInput,
    options: ValidateMixinOptions = {}
  ): Promise<ValidateMixinOutput> {
    // Wrap the dispatcher so any untagged AppError coming out of path
    // normalization, preflight discovery, or config resolution surfaces with a
    // meaningful failedStage. annotateValidateMixinError preserves any
    // inner-pipeline tag (resolve/mapping-health/parse/target-lookup) so only
    // the dispatcher-level errors default to input-validation.
    try {
      return await this.runValidateMixinDispatcher(input, options);
    } catch (err) {
      throw annotateValidateMixinError(err, "input-validation");
    }
  }

  private async runValidateMixinDispatcher(
    input: ValidateMixinInput,
    options: ValidateMixinOptions = {}
  ): Promise<ValidateMixinOutput> {
    const { input: sourceInput, ...sharedInput } = input;
    const mode = sourceInput.mode;
    const stageEmitter = options.stageEmitter ?? NOOP_STAGE_EMITTER;
    const sharedSingleOptions = {
      stageEmitter,
      __stageBudgets: options.__stageBudgets,
      __testHooks: options.__testHooks
    };

    if (mode === "inline") {
      const singleResult = await this.validateMixinSingle({
        ...sharedInput,
        source: sourceInput.source,
        ...sharedSingleOptions
      });
      return this.applyValidateMixinOutputCompaction(this.buildValidateMixinOutput(mode, [
        {
          source: {
            kind: "inline",
            label: "<inline>"
          },
          result: singleResult
        }
      ]), input);
    }

    if (mode === "path") {
      const resolvedPath = this.resolveMixinInputPath(sourceInput.path, "path");
      const singleResult = await this.validateMixinSingle({
        ...sharedInput,
        sourcePath: sourceInput.path,
        ...sharedSingleOptions
      });
      return this.applyValidateMixinOutputCompaction(this.buildValidateMixinOutput(mode, [
        {
          source: {
            kind: "path",
            label: resolvedPath,
            path: resolvedPath
          },
          result: singleResult
        }
      ]), input);
    }

    if (mode === "paths") {
      return this.validateMixinMany(
        mode,
        sourceInput.paths.map((path) => ({
          source: {
            kind: "path" as const,
            label: this.resolveMixinInputPath(path, "path"),
            path: this.resolveMixinInputPath(path, "path")
          },
          sourcePath: path
        })),
        input,
        [],
        sharedSingleOptions
      );
    }

    const resolvedInput = mode === "project"
      ? await this.createProjectValidateMixinConfigInput(input)
      : input;
    const { sources: configSources, warnings: configWarnings } = await this.resolveMixinConfigSources(resolvedInput);
    if (configSources.length === 0) {
      const emptyOutput = this.buildValidateMixinOutput(mode, []);
      return this.applyValidateMixinOutputCompaction({
        ...emptyOutput,
        warnings: [...new Set([...emptyOutput.warnings, ...configWarnings])]
      }, input);
    }

    return this.validateMixinMany(
      mode,
      configSources.map((entry) => ({
        source: {
          kind: "config" as const,
          label: entry.sourcePath,
          path: entry.sourcePath,
          configPath: entry.configPath
        },
        sourcePath: entry.sourcePath
      })),
      resolvedInput,
      configWarnings,
      sharedSingleOptions
    );
  }

  private async createProjectValidateMixinConfigInput(input: ValidateMixinInput): Promise<ValidateMixinInput> {
    if (input.input.mode !== "project") {
      return input;
    }

    const resolvedProjectPath = this.resolveMixinInputPath(input.input.path, "path");
    const configPaths = (await fastGlob.glob(["**/*.mixins.json"], {
      cwd: resolvedProjectPath,
      absolute: true,
      onlyFiles: true,
      ignore: [...MIXIN_PROJECT_DISCOVERY_IGNORES]
    })).sort((left, right) => left.localeCompare(right));

    if (configPaths.length === 0) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `No mixin config JSON files were found under project path "${input.input.path}".`,
        details: {
          failedStage: "input-validation",
          nextAction: "Use input.mode='config' with explicit configPaths[], or point input.path at the workspace root that contains *.mixins.json files."
        }
      });
    }

    return {
      ...input,
      projectPath: input.projectPath ?? resolvedProjectPath,
      input: {
        mode: "config",
        configPaths
      }
    };
  }

  private shouldRetryValidateMixinWithMavenFirst(
    input: ValidateMixinSingleInput,
    result: MixinValidationResult
  ): boolean {
    const initialPriority = input.retryState?.initialSourcePriority ?? input.sourcePriority ?? this.config.mappingSourcePriority;
    if (input.retryState?.attempted || initialPriority !== "loom-first") {
      return false;
    }
    if (result.validationStatus !== "partial") {
      return false;
    }
    // Budget-driven partials are the soft-deadline's final output; retrying
    // under maven-first would re-run the same expensive pipeline. The retry
    // path targets mapping-infrastructure failures, not stage-budget cuts.
    if (
      result.summary.degradedReason !== undefined ||
      (result.summary.targetsDeferredBudget ?? 0) > 0
    ) {
      return false;
    }
    if (result.summary.membersSkipped > 0) {
      return true;
    }
    return result.issues.some((issue) =>
      issue.resolutionPath === "source-signature-unavailable" ||
      issue.resolutionPath === "target-mapping-failed" ||
      issue.resolutionPath === "member-remap-failed"
    );
  }

  private findValidateMixinClassMapping(input: {
    version: string;
    className: string;
    sourceMapping: SourceMapping;
    targetMapping: SourceMapping;
    sourcePriority: MappingSourcePriority;
    projectPath?: string;
    batchCaches?: ValidateMixinSingleInput["batchCaches"];
  }): Promise<MappingFindMappingOutput> {
    const cache = input.batchCaches?.classMappings;
    if (!cache) {
      return this.mappingService.findMapping({
        version: input.version,
        kind: "class",
        name: input.className,
        sourceMapping: input.sourceMapping,
        targetMapping: input.targetMapping,
        sourcePriority: input.sourcePriority,
        projectPath: input.projectPath
      });
    }

    const cacheKey = [
      input.version,
      input.className,
      input.sourceMapping,
      input.targetMapping,
      input.sourcePriority,
      input.projectPath ?? ""
    ].join("\0");
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.mappingService.findMapping({
      version: input.version,
      kind: "class",
      name: input.className,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath
    }).catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, pending);
    return pending;
  }

  private async validateMixinSingle(input: ValidateMixinSingleInput): Promise<MixinValidationResult> {
    // Start at input-validation so path normalization, file reads, and the
    // simple guard checks all land under that stage. The pipeline callback
    // shifts the stage tracker before the first non-input-validation action,
    // and annotateValidateMixinError() preserves any nested-call stage
    // (e.g. a deeper resolver that set failedStage="version-manifest").
    let currentStage: ValidateMixinStage = "input-validation";
    // Loaded here so the input-validation budget covers the sourcePath read
    // and version normalization that happen before the pipeline starts.
    const stageBudgets = loadMixinStageBudgets(input.__stageBudgets);
    const inputValidationStartedAt = performance.now();
    try {
      let version = input.version.trim();
      const requestedScope = normalizeRequestedArtifactScope(input.scope);
      const currentSourcePriority = input.sourcePriority ?? this.config.mappingSourcePriority;
      const initialSourcePriority = input.retryState?.initialSourcePriority ?? currentSourcePriority;
      if (!version) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "version must be non-empty.",
          details: { failedStage: "input-validation" }
        });
      }

      // Resolve source from source or sourcePath
      let source: string;
      if (input.sourcePath) {
        const normalizedSourcePath = normalizePathForHost(input.sourcePath, undefined, "sourcePath");
        const resolvedSourcePath = isAbsolute(normalizedSourcePath)
          ? normalizedSourcePath
          : resolvePath(process.cwd(), normalizedSourcePath);
        try {
          source = await readFile(resolvedSourcePath, "utf-8");
        } catch (err) {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message:
              `Could not read sourcePath "${input.sourcePath}" (resolved to "${resolvedSourcePath}"):` +
              ` ${err instanceof Error ? err.message : String(err)}`,
            details: { failedStage: "input-validation" }
          });
        }
      } else {
        source = input.source ?? "";
      }
      if (!source.trim()) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "source must be non-empty.",
          details: { failedStage: "input-validation" }
        });
      }

      // Check after the stage's I/O so a slow path read surfaces as
      // ERR_STAGE_BUDGET_PRE_PARSE rather than hanging the call.
      const inputElapsed = performance.now() - inputValidationStartedAt;
      if (inputElapsed > stageBudgets.inputValidation) {
        throw createError({
          code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
          message: "Stage input-validation exhausted budget before parse completed.",
          details: {
            failedStage: "input-validation",
            stageBudgetExhausted: true,
            budgetMs: stageBudgets.inputValidation,
            elapsedMs: inputElapsed
          }
        });
      }

      return await this.runValidateMixinPipeline({
        input,
        version,
        source,
        requestedScope,
        currentSourcePriority,
        initialSourcePriority,
        stageEmitter: input.stageEmitter ?? NOOP_STAGE_EMITTER,
        stageBudgets,
        testHooks: input.__testHooks,
        onStage: (stage) => { currentStage = stage; }
      });
    } catch (err) {
      throw annotateValidateMixinError(err, currentStage);
    }
  }

  private async runValidateMixinPipeline(ctx: {
    input: ValidateMixinSingleInput;
    version: string;
    source: string;
    requestedScope: ArtifactScope;
    currentSourcePriority: MappingSourcePriority;
    initialSourcePriority: MappingSourcePriority;
    stageEmitter: StageEmitter;
    stageBudgets: MixinStageBudgets;
    testHooks: ValidateMixinOptions["__testHooks"];
    onStage: (stage: ValidateMixinStage) => void;
  }): Promise<MixinValidationResult> {
    const {
      input,
      source,
      requestedScope,
      currentSourcePriority,
      initialSourcePriority,
      stageEmitter,
      stageBudgets,
      testHooks,
      onStage
    } = ctx;
    let { version } = ctx;
    const enterStage = async (stage: ValidateMixinStage): Promise<number> => {
      onStage(stage);
      const startedAt = performance.now();
      await stageEmitter(stage);
      return startedAt;
    };
    const checkPreParseBudget = (
      stage: ValidateMixinStage,
      stageStartedAt: number,
      budgetMs: number
    ): void => {
      const elapsed = performance.now() - stageStartedAt;
      if (elapsed > budgetMs) {
        throw createError({
          code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
          message: `Stage ${stage} exhausted budget before parse completed.`,
          details: {
            failedStage: stage,
            stageBudgetExhausted: true,
            budgetMs,
            elapsedMs: elapsed
          }
        });
      }
    };
    const resolveStartedAt = await enterStage("resolve");
    const warnings: string[] = [];
    let mappingAutoDetected = false;

    // Auto-detect mapping from project config when not explicitly provided (or when preferProjectMapping is set)
    let detectedMapping: SourceMapping | undefined;
    if ((!input.mapping || input.preferProjectMapping) && input.projectPath) {
      try {
        const detection = await this.workspaceMappingService.detectCompileMapping({ projectPath: input.projectPath });
        if (detection.resolved && detection.mappingApplied) {
          detectedMapping = detection.mappingApplied;
          mappingAutoDetected = true;
          warnings.push(`Auto-detected mapping '${detectedMapping}' from project configuration.`);
          warnings.push(...detection.warnings);
        } else {
          warnings.push(...detection.warnings);
        }
      } catch {
        // Detection failed — fall through to default
      }
    }

    const requestedMapping = normalizeMapping(detectedMapping ?? input.mapping);
    let mappingApplied: SourceMapping = requestedMapping;

    // preferProjectVersion: detect MC version from gradle.properties
    if (input.preferProjectVersion && input.projectPath) {
      const detected = await this.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
      if (detected && detected !== version) {
        warnings.push(`Overriding version "${version}" with project version "${detected}" from gradle.properties.`);
      }
      version = detected ?? version;
    }

    // Resolve jar: use Loom cache for non-vanilla scope with projectPath
    let jarPath: string;
    let resolvedArtifact: ResolveArtifactOutput | undefined;
    let signatureLookupMapping: SourceMapping = "obfuscated";
    let scopeFallback: { requested: string; applied: string; reason: string } | undefined;
    if (input.scope && input.scope !== "vanilla" && input.projectPath) {
      try {
        resolvedArtifact = await this.resolveArtifact({
          target: { kind: "version", value: version },
          mapping: requestedMapping,
          sourcePriority: currentSourcePriority,
          projectPath: input.projectPath,
          scope: input.scope,
          preferProjectVersion: false
        });
        jarPath = resolvedArtifact.binaryJarPath ?? (await this.versionService.resolveVersionJar(version)).jarPath;
        warnings.push(...resolvedArtifact.warnings);
        mappingApplied = resolvedArtifact.mappingApplied;
        signatureLookupMapping = resolvedArtifact.mappingApplied;
        if (resolvedArtifact.version) {
          version = resolvedArtifact.version;
        }
      } catch (scopeErr) {
        // Scope preflight failed — fall back to vanilla
        scopeFallback = {
          requested: input.scope,
          applied: "vanilla",
          reason: `Loom cache unavailable: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`
        };
        warnings.push(`Scope "${input.scope}" resolution failed; falling back to vanilla. ${scopeFallback.reason}`);
        jarPath = (await this.versionService.resolveVersionJar(version)).jarPath;
      }
    } else {
      jarPath = (await this.versionService.resolveVersionJar(version)).jarPath;
    }

    // Guard: reject sources jars — they contain Java source, not bytecode
    if (jarPath.includes("-sources.jar")) {
      warnings.push(`Resolved jar appears to be a sources jar. Falling back to vanilla client jar.`);
      jarPath = (await this.versionService.resolveVersionJar(version)).jarPath;
      signatureLookupMapping = "obfuscated";
      scopeFallback = {
        requested: input.scope ?? "vanilla",
        applied: "vanilla",
        reason: "Resolved jar was a sources jar, not a binary class jar."
      };
    }

    if (testHooks?.afterResolve) {
      await testHooks.afterResolve();
    }
    checkPreParseBudget("resolve", resolveStartedAt, stageBudgets.resolve);

    // Health check: probe mapping infrastructure
    const mappingHealthStartedAt = await enterStage("mapping-health");
    let healthReport: MappingHealthReport | undefined;
    try {
      const health = await this.mappingService.checkMappingHealth({
        version,
        requestedMapping,
        sourcePriority: currentSourcePriority
      });
      const jarAvailable = existsSync(jarPath);
      healthReport = {
        jarAvailable,
        jarPath,
        mojangMappingsAvailable: health.mojangMappingsAvailable,
        tinyMappingsAvailable: health.tinyMappingsAvailable,
        memberRemapAvailable: health.memberRemapAvailable,
        overallHealthy: jarAvailable && health.mojangMappingsAvailable,
        degradations: [
          ...(jarAvailable ? [] : ["Game jar not found."]),
          ...health.degradations
        ]
      };
    } catch (err) {
      // Probe itself failed — surface the degradation instead of swallowing it
      // silently, so quickSummary and toolHealth reflect the unknown-health
      // state rather than looking clean.
      const reason = err instanceof Error ? err.message : String(err);
      healthReport = {
        jarAvailable: existsSync(jarPath),
        jarPath,
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        overallHealthy: false,
        degradations: [`Mapping health probe failed: ${reason}`]
      };
    }

    if (testHooks?.afterMappingHealth) {
      await testHooks.afterMappingHealth();
    }
    checkPreParseBudget("mapping-health", mappingHealthStartedAt, stageBudgets.mappingHealth);

    const parseStartedAt = await enterStage("parse");
    const parsed = parseMixinSource(source);

    if (testHooks?.afterParse) {
      await testHooks.afterParse();
    }
    checkPreParseBudget("parse", parseStartedAt, stageBudgets.parse);

    const targetLookupStartedAt = await enterStage("target-lookup");
    if (testHooks?.beforeTargetLoop) {
      await testHooks.beforeTargetLoop();
    }
    let degradedReason: "stage-budget" | "stage-budget-pre-target" | undefined;
    const targetOutcomes: MixinTargetOutcome[] = [];
    const deferredTargetClasses = new Set<string>();
    const targetMembers = new Map<string, ResolvedTargetMembers>();
    const mappingFailedTargets = new Set<string>();
    const remapFailedMembers = new Map<string, Set<string>>();
    // Distinct from per-member entries in `remapFailedMembers`: when the
    // whole remap batch throws, no per-member key matches and the target
    // would otherwise be reported as `status: "ok"` despite the fallback.
    const wholeRemapFailedTargets = new Set<string>();
    const signatureFailedTargets = new Set<string>();
    const symbolExistsButSignatureFailed = new Set<string>();
    const resolutionTrace: MixinValidationProvenance["resolutionTrace"] = input.explain ? [] : undefined;

    const totalTargets = parsed.targets.length;
    let processedTargetCount = 0;
    let stageBudgetExhausted = false;
    let nextTargetIndex = 0;
    for (let targetIndex = 0; targetIndex < totalTargets; targetIndex++) {
      // Stage-total budget check (BEFORE starting next target).
      const stageElapsed = performance.now() - targetLookupStartedAt;
      if (stageElapsed > stageBudgets.targetLookup) {
        stageBudgetExhausted = true;
        nextTargetIndex = targetIndex;
        break;
      }
      const target = parsed.targets[targetIndex];
      await stageEmitter("target-lookup", {
        targetIndex,
        targetTotal: totalTargets,
        targetClass: target.className,
        memberCount:
          parsed.injections.length + parsed.shadows.length + parsed.accessors.length
      });
      const targetStartedAt = performance.now();
      if (testHooks?.beforeTargetIter) {
        await testHooks.beforeTargetIter(targetIndex);
      }
      // Bug 1 fix: resolve simple names via imports
      let resolvedClassName = target.className;
      if (!resolvedClassName.includes(".")) {
        // Simple name — look up in imports
        const fqcn = parsed.imports.get(resolvedClassName);
        if (fqcn) {
          resolvedClassName = fqcn;
        }
      } else {
        // Might be inner class like Foo.Bar where Foo is imported
        const segments = resolvedClassName.split(".");
        const firstSegment = segments[0];
        if (firstSegment && /^[A-Z]/.test(firstSegment)) {
          const outerFqcn = parsed.imports.get(firstSegment);
          if (outerFqcn) {
            resolvedClassName = outerFqcn + "$" + segments.slice(1).join("$");
          }
        }
      }

      let obfuscatedName = resolvedClassName;

      if (requestedMapping !== signatureLookupMapping) {
        try {
          const mapped = await this.findValidateMixinClassMapping({
            version,
            className: resolvedClassName,
            sourceMapping: requestedMapping,
            targetMapping: signatureLookupMapping,
            sourcePriority: currentSourcePriority,
            projectPath: input.projectPath,
            batchCaches: input.batchCaches
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            obfuscatedName = mapped.resolvedSymbol.name;
            resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: true });
          } else {
            warnings.push(
              `Could not map class "${resolvedClassName}" from ${requestedMapping} to ${signatureLookupMapping}; using "${obfuscatedName}" for lookup.`
            );
            mappingFailedTargets.add(target.className);
            resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: "No mapping found" });
          }
        } catch (mapErr) {
          warnings.push(
            `Mapping lookup failed for class "${resolvedClassName}" while preparing ${signatureLookupMapping} lookup; using "${obfuscatedName}" for lookup.`
          );
          mappingFailedTargets.add(target.className);
          resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: mapErr instanceof Error ? mapErr.message : String(mapErr) });
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: obfuscatedName,
          jarPath,
          access: "all"
        });
        warnings.push(...sig.warnings);
        resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: `${sig.methods.length} methods, ${sig.fields.length} fields`, success: true });

        // Bug 2 fix: remap signature members to requested mapping
        let constructors = sig.constructors;
        let methods = sig.methods;
        let fields = sig.fields;

        if (requestedMapping !== signatureLookupMapping) {
          try {
            const [ctorResult, methodResult, fieldResult] = await Promise.all([
              this.remapSignatureMembers(
                sig.constructors,
                "method",
                version,
                signatureLookupMapping,
                requestedMapping,
                currentSourcePriority,
                warnings,
                input.projectPath
              ),
              this.remapSignatureMembers(
                sig.methods,
                "method",
                version,
                signatureLookupMapping,
                requestedMapping,
                currentSourcePriority,
                warnings,
                input.projectPath
              ),
              this.remapSignatureMembers(
                sig.fields,
                "field",
                version,
                signatureLookupMapping,
                requestedMapping,
                currentSourcePriority,
                warnings,
                input.projectPath
              )
            ]);
            constructors = ctorResult.members;
            methods = methodResult.members;
            fields = fieldResult.members;

            // Collect remap-failed member names for this target
            const targetFailed = new Set<string>();
            for (const n of ctorResult.failedNames) targetFailed.add(n);
            for (const n of methodResult.failedNames) targetFailed.add(n);
            for (const n of fieldResult.failedNames) targetFailed.add(n);
            if (targetFailed.size > 0) {
              remapFailedMembers.set(target.className, targetFailed);
              resolutionTrace?.push({ target: target.className, step: "remap", input: `${targetFailed.size} members`, output: "failed", success: false });
            } else {
              resolutionTrace?.push({ target: target.className, step: "remap", input: `${methods.length + fields.length} members`, output: "remapped", success: true });
            }
          } catch (remapErr) {
            warnings.push(
              `Member remapping failed for "${resolvedClassName}"; falling back to ${signatureLookupMapping} names. ` +
              `Member names shown may be in the ${signatureLookupMapping} runtime namespace.`
            );
            mappingApplied = signatureLookupMapping;
            wholeRemapFailedTargets.add(target.className);
            resolutionTrace?.push({
              target: target.className,
              step: "remap",
              input: resolvedClassName,
              output: `${signatureLookupMapping} fallback`,
              success: false,
              detail: remapErr instanceof Error ? remapErr.message : String(remapErr)
            });
          }
        }

        targetMembers.set(target.className, {
          className: target.className,
          constructors,
          methods,
          fields
        });
      } catch (sigErr) {
        warnings.push(`Could not load signature for class "${resolvedClassName}" (obfuscated: "${obfuscatedName}").`);
        resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: "CLASS_NOT_FOUND", success: false, detail: sigErr instanceof Error ? sigErr.message : String(sigErr) });

        // Fallback: check if the symbol exists in the mapping graph even though getSignature failed
        try {
          const existenceCheck = await this.mappingService.checkSymbolExists({
            version, kind: "class", name: resolvedClassName,
            sourceMapping: requestedMapping, nameMode: "auto", sourcePriority: currentSourcePriority
          });
          if (existenceCheck.resolved) {
            symbolExistsButSignatureFailed.add(target.className);
            resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "exists in mapping graph", success: true });
          } else {
            resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "not found", success: false });
          }
        } catch {
          // Fallback check failed — treat as tool-limited partial validation.
          signatureFailedTargets.add(target.className);
          resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "check failed", success: false });
        }
      }

      const targetElapsed = performance.now() - targetStartedAt;
      // A target with a mapping / signature / remap failure consumed budget
      // but produced unreliable members; emit `tool-issue` so callers using
      // `includeIssues: false` still see the per-target failure signal.
      const hadToolIssue =
        mappingFailedTargets.has(target.className) ||
        signatureFailedTargets.has(target.className) ||
        symbolExistsButSignatureFailed.has(target.className) ||
        remapFailedMembers.has(target.className) ||
        wholeRemapFailedTargets.has(target.className);
      const completedOutcome: MixinTargetOutcome = hadToolIssue
        ? {
            targetClass: target.className,
            status: "tool-issue",
            elapsedMs: targetElapsed,
            reason: signatureFailedTargets.has(target.className)
              ? "signature-load-failed"
              : symbolExistsButSignatureFailed.has(target.className)
                ? "signature-load-failed-symbol-exists"
                : mappingFailedTargets.has(target.className)
                  ? "mapping-failed"
                  : wholeRemapFailedTargets.has(target.className)
                    ? "member-remap-failed-whole"
                    : "member-remap-failed"
          }
        : {
            targetClass: target.className,
            status: "ok",
            elapsedMs: targetElapsed
          };
      if (targetElapsed > stageBudgets.perTarget) {
        completedOutcome.slowTarget = true;
        completedOutcome.budgetMs = stageBudgets.perTarget;
      }
      targetOutcomes.push(completedOutcome);
      processedTargetCount += 1;
    }

    // Targets the validator must skip so it emits "skipped" members instead
    // of target-not-found errors. Pre-target boundary keeps the public
    // `targetOutcomes` empty (per spec); mid-loop boundary records each
    // deferred target with `status: "deferred-budget"`.
    const skippedForValidator = new Set<string>();
    if (stageBudgetExhausted) {
      if (processedTargetCount === 0) {
        degradedReason = "stage-budget-pre-target";
        for (const remaining of parsed.targets) {
          skippedForValidator.add(remaining.className);
        }
      } else {
        degradedReason = "stage-budget";
        for (let j = nextTargetIndex; j < totalTargets; j++) {
          const remaining = parsed.targets[j];
          deferredTargetClasses.add(remaining.className);
          skippedForValidator.add(remaining.className);
          targetOutcomes.push({
            targetClass: remaining.className,
            status: "deferred-budget",
            reason: "stage-budget",
            budgetMs: stageBudgets.targetLookup
          });
        }
      }
    }

    // Fix toolHealth accuracy: reflect actual failures after target resolution
    if (healthReport) {
      const hasFailures =
        signatureFailedTargets.size > 0 ||
        mappingFailedTargets.size > 0 ||
        symbolExistsButSignatureFailed.size > 0;
      if (hasFailures && healthReport.overallHealthy) {
        healthReport.overallHealthy = false;
        healthReport.degradations.push(
          `${mappingFailedTargets.size} mapping failure(s), ${signatureFailedTargets.size} signature failure(s), ${symbolExistsButSignatureFailed.size} partial validation target(s).`
        );
      }
    }

    const resolutionNotes: string[] = [];
    if (requestedMapping !== mappingApplied) {
      resolutionNotes.push(
        `Mapping fallback: requested "${requestedMapping}" but applied "${mappingApplied}" due to remapping failure.`
      );
    }
    const appliedScope = inferAppliedArtifactScope({
      requestedScope,
      scopeFallback,
      jarPath,
      resolvedSourceJarPath: resolvedArtifact?.resolvedSourceJarPath
    });
    if (!scopeFallback && requestedScope !== appliedScope) {
      resolutionNotes.push(
        `Scope adjusted during validation: requested "${requestedScope}" but resolved artifact looks like "${appliedScope}".`
      );
    }

    // Count remap failures from warnings
    const REMAP_WARNING_RE = /^(?:Could not remap|Remap failed for)\b/;
    const remapFailures = warnings.filter((w) => REMAP_WARNING_RE.test(w)).length;

    // Determine confidence level
    let confidence: IssueConfidence = "definite";
    if (requestedMapping !== mappingApplied) {
      confidence = "uncertain";
    } else if (remapFailures > 0) {
      confidence = "likely";
    }

    // Build mapping chain description
    const mappingChain: string[] = [];
    if (requestedMapping !== signatureLookupMapping) {
      mappingChain.push(`${requestedMapping} → ${signatureLookupMapping}`);
    }
    if (mappingApplied !== signatureLookupMapping) {
      mappingChain.push(`fallback to ${mappingApplied}`);
    }

    const provenance: MixinValidationProvenance = {
      version,
      jarPath,
      requestedMapping,
      mappingApplied,
      requestedScope,
      appliedScope,
      requestedSourcePriority: initialSourcePriority,
      appliedSourcePriority: currentSourcePriority,
      resolutionNotes: resolutionNotes.length > 0 ? resolutionNotes : undefined,
      jarType: scopeToJarType(appliedScope),
      mappingChain: mappingChain.length > 0 ? mappingChain : undefined,
      remapFailures: remapFailures > 0 ? remapFailures : undefined,
      mappingAutoDetected: mappingAutoDetected || undefined,
      scopeFallback,
      resolutionTrace: resolutionTrace && resolutionTrace.length > 0 ? resolutionTrace : undefined
    };

    const baseResult = validateParsedMixin(
      parsed, targetMembers, warnings, provenance, confidence, mappingFailedTargets, input.explain,
      remapFailedMembers, signatureFailedTargets,
      input.explain ? { scope: requestedScope, sourcePriority: currentSourcePriority, projectPath: input.projectPath, mapping: requestedMapping } : undefined,
      input.warningMode,
      healthReport,
      symbolExistsButSignatureFailed.size > 0 ? symbolExistsButSignatureFailed : undefined,
      skippedForValidator.size > 0 ? skippedForValidator : undefined
    );
    if (targetOutcomes.length > 0) {
      baseResult.targetOutcomes = targetOutcomes;
    }
    if (degradedReason !== undefined) {
      baseResult.summary = { ...baseResult.summary, degradedReason };
    }
    if (deferredTargetClasses.size > 0) {
      baseResult.summary = {
        ...baseResult.summary,
        targetsDeferredBudget: deferredTargetClasses.size
      };
    }
    const result = refreshMixinValidationOutcome(baseResult);

    // Apply minSeverity / hideUncertain filters
    const minSeverity = input.minSeverity ?? "all";
    const hideUncertain = input.hideUncertain ?? false;

    if (minSeverity !== "all" || hideUncertain) {
      const unfilteredSummary = { ...result.summary };
      let filtered = result.issues;

      if (minSeverity === "error") {
        filtered = filtered.filter((i) => i.severity === "error");
      } else if (minSeverity === "warning") {
        filtered = filtered.filter((i) => i.severity === "error" || i.severity === "warning");
      }

      if (hideUncertain) {
        filtered = filtered.filter((i) => i.confidence !== "uncertain");
      }

      const filteredErrors = filtered.filter((i) => i.severity === "error").length;
      const filteredWarnings = filtered.filter((i) => i.severity === "warning").length;
      const filteredDefiniteErrors = filtered.filter((i) => i.severity === "error" && i.confidence !== "uncertain").length;
      const filteredUncertainErrors = filtered.filter((i) => i.severity === "error" && i.confidence === "uncertain").length;
      const filteredResolutionErrors = filtered.filter((i) => i.resolutionPath != null).length;
      const filteredParseWarnings = filtered.filter((i) => i.category === "parse").length;

      result.issues = filtered;
      result.summary = {
        ...result.summary,
        errors: filteredErrors,
        warnings: filteredWarnings,
        definiteErrors: filteredDefiniteErrors,
        uncertainErrors: filteredUncertainErrors,
        resolutionErrors: filteredResolutionErrors,
        parseWarnings: filteredParseWarnings
      };
      result.unfilteredSummary = unfilteredSummary;
    }

    // Apply warningCategoryFilter
    if (input.warningCategoryFilter && input.warningCategoryFilter.length > 0) {
      const allowedCategories = new Set(input.warningCategoryFilter);
      result.issues = result.issues.filter((i) => i.category && allowedCategories.has(i.category));
      if (result.structuredWarnings) {
        result.structuredWarnings = result.structuredWarnings.filter((sw) => sw.category && allowedCategories.has(sw.category));
        if (result.structuredWarnings.length === 0) result.structuredWarnings = undefined;
      }
      // Re-compute summary after category filter
      const catErrors = result.issues.filter((i) => i.severity === "error").length;
      const catWarnings = result.issues.filter((i) => i.severity === "warning").length;
      const catDefiniteErrors = result.issues.filter((i) => i.severity === "error" && i.confidence !== "uncertain").length;
      result.summary = {
        ...result.summary,
        errors: catErrors,
        warnings: catWarnings,
        definiteErrors: catDefiniteErrors,
        uncertainErrors: result.issues.filter((i) => i.severity === "error" && i.confidence === "uncertain").length,
        resolutionErrors: result.issues.filter((i) => i.resolutionPath != null).length,
        parseWarnings: result.issues.filter((i) => i.category === "parse").length
      };
    }

    // Apply treatInfoAsWarning filter
    if (input.treatInfoAsWarning === false && result.structuredWarnings) {
      result.structuredWarnings = result.structuredWarnings.filter((sw) => sw.severity !== "info");
      if (result.structuredWarnings.length === 0) result.structuredWarnings = undefined;
    }

    // Apply compact report mode. refreshMixinValidationOutcome reads
    // result.toolHealth / result.provenance when it rebuilds quickSummary, so
    // refresh BEFORE stripping those fields; otherwise compact mode would
    // silently drop the mapping-health-degraded and scope-fallback notes.
    if (input.reportMode === "compact") {
      refreshMixinValidationOutcome(result);
      result.resolvedMembers = undefined;
      result.structuredWarnings = undefined;
      result.aggregatedWarnings = undefined;
      result.toolHealth = undefined;
      result.confidenceBreakdown = undefined;
      if (result.provenance) {
        result.provenance.resolutionTrace = undefined;
      }
    } else {
      refreshMixinValidationOutcome(result);
    }

    if (this.shouldRetryValidateMixinWithMavenFirst(input, result)) {
      const retryWarning =
        `Retrying validate-mixin with sourcePriority="maven-first" after partial validation using "${currentSourcePriority}".`;
      try {
        const retried = await this.validateMixinSingle({
          ...input,
          source,
          sourcePath: undefined,
          sourcePriority: "maven-first",
          retryState: {
            attempted: true,
            initialSourcePriority
          }
        });
        retried.warnings = [retryWarning, ...retried.warnings];
        if (retried.provenance) {
          retried.provenance.requestedSourcePriority = initialSourcePriority;
          retried.provenance.appliedSourcePriority = "maven-first";
          retried.provenance.resolutionNotes = [
            ...(retried.provenance.resolutionNotes ?? []),
            `Validation retried with sourcePriority "maven-first" after partial result from "${currentSourcePriority}".`
          ];
        }
        // The recursive validateMixinSingle call already produced final summary /
        // status / quickSummary. The only mutations above are warnings and
        // provenance.resolutionNotes, which quickSummary does not read. Calling
        // refreshMixinValidationOutcome(retried) here would rebuild quickSummary
        // against the already-compacted `retried.toolHealth === undefined`, which
        // silently strips the mapping-health-degraded note we just preserved in
        // the compact branch above.
        return retried;
      } catch (retryErr) {
        result.warnings.unshift(
          `${retryWarning} Retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
        return result;
      }
    }

    return result;
  }

  private resolveMixinInputPath(rawPath: string, fieldName: string): string {
    const normalizedPath = normalizePathForHost(rawPath, undefined, fieldName);
    return isAbsolute(normalizedPath)
      ? normalizedPath
      : resolvePath(process.cwd(), normalizedPath);
  }

  private async resolveMixinConfigSources(input: ValidateMixinInput): Promise<ResolvedValidateMixinConfigSources> {
    if (input.input.mode !== "config") {
      return {
        sources: [],
        warnings: []
      };
    }

    const results: ValidateMixinConfigSource[] = [];
    const warnings: string[] = [];

    for (const rawConfigPath of input.input.configPaths) {
      const resolvedConfigPath = this.resolveMixinInputPath(rawConfigPath, "configPath");
      let configJson: { package?: string; mixins?: string[]; client?: string[]; server?: string[] };
      try {
        const raw = await readFile(resolvedConfigPath, "utf-8");
        configJson = JSON.parse(raw);
      } catch (err) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Could not read/parse mixin config "${rawConfigPath}": ${err instanceof Error ? err.message : String(err)}`,
          details: { failedStage: "input-validation" }
        });
      }

      const pkg = configJson.package ?? "";
      const classNames = [
        ...(configJson.mixins ?? []),
        ...(configJson.client ?? []),
        ...(configJson.server ?? [])
      ];
      if (classNames.length === 0) {
        warnings.push(`Mixin config "${resolvedConfigPath}" contains no mixin class entries.`);
        continue;
      }

      const projectBase = input.projectPath
        ? (isAbsolute(input.projectPath) ? input.projectPath : resolvePath(process.cwd(), input.projectPath))
        : dirname(resolvedConfigPath);

      let sourceRootCandidates: string[];
      if (input.sourceRoots && input.sourceRoots.length > 0) {
        sourceRootCandidates = input.sourceRoots;
      } else {
        const detected: string[] = [];
        for (const candidateRoot of COMMON_SOURCE_ROOTS) {
          let foundInRoot = false;
          for (const className of classNames) {
            const fqcn = pkg ? `${pkg}.${className}` : className;
            const relative = fqcn.replace(/\./g, "/") + ".java";
            if (await pathExists(resolvePath(projectBase, candidateRoot, relative))) {
              foundInRoot = true;
              break;
            }
          }
          if (foundInRoot) {
            detected.push(candidateRoot);
          }
        }
        sourceRootCandidates = detected.length > 0 ? detected : ["src/main/java"];
      }

      for (const cls of classNames) {
        const fqcn = pkg ? `${pkg}.${cls}` : cls;
        const relativePath = fqcn.replace(/\./g, "/") + ".java";
        let sourcePath = resolvePath(projectBase, sourceRootCandidates[0], relativePath);
        for (const root of sourceRootCandidates) {
          const candidate = resolvePath(projectBase, root, relativePath);
          if (await pathExists(candidate)) {
            sourcePath = candidate;
            break;
          }
        }
        results.push({
          sourcePath,
          configPath: resolvedConfigPath
        });
      }
    }

    return {
      sources: results,
      warnings
    };
  }

  private async validateMixinMany(
    mode: "paths" | "config" | "project",
    entries: Array<{ source: ValidateMixinResultSource; sourcePath: string }>,
    input: ValidateMixinInput,
    additionalWarnings: string[],
    extras: {
      stageEmitter?: StageEmitter;
      __stageBudgets?: Partial<MixinStageBudgets>;
      __testHooks?: ValidateMixinOptions["__testHooks"];
    } = {}
  ): Promise<ValidateMixinOutput> {
    const results: ValidateMixinBatchResult[] = [];
    const batchWarningMode = input.warningMode ?? "aggregated";
    const { input: _discardedInput, ...sharedInput } = input;
    const batchCaches = {
      classMappings: new Map<string, Promise<MappingFindMappingOutput>>()
    };
    const stageEmitter = extras.stageEmitter ?? NOOP_STAGE_EMITTER;

    for (const entry of entries) {
      try {
        const singleResult = await this.validateMixinSingle({
          ...sharedInput,
          sourcePath: entry.sourcePath,
          warningMode: batchWarningMode,
          batchCaches,
          stageEmitter,
          __stageBudgets: extras.__stageBudgets,
          __testHooks: extras.__testHooks
        });
        results.push({
          source: entry.source,
          result: singleResult
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const entryResult: ValidateMixinBatchResult = {
          source: entry.source,
          error: message
        };
        if (isAppError(err)) {
          entryResult.errorCode = err.code;
          if (err.details) {
            entryResult.errorDetails = { ...err.details };
          }
        }
        results.push(entryResult);
      }
    }

    const output = this.buildValidateMixinOutput(mode, results);
    return this.applyValidateMixinOutputCompaction({
      ...output,
      warnings: additionalWarnings.length === 0
        ? output.warnings
        : [...new Set([...output.warnings, ...additionalWarnings])]
    }, input);
  }

  private applyValidateMixinOutputCompaction(
    output: ValidateMixinOutput,
    input: ValidateMixinInput
  ): ValidateMixinOutput {
    let nextOutput = output;
    const canHoistProvenance = nextOutput.provenance != null;
    const warningCandidates = nextOutput.results
      .map((entry) => entry.result?.warnings)
      .filter((entry): entry is string[] => entry != null);
    const canHoistWarnings = warningCandidates.length === 0
      ? true
      : warningCandidates.every((entry) => sameStringArray(entry, warningCandidates[0]));

    if (input.reportMode === "summary-first") {
      nextOutput = {
        ...nextOutput,
        results: nextOutput.results.map((entry) => (
          entry.result
            ? {
                ...entry,
                result: {
                  ...entry.result,
                  warnings: canHoistWarnings ? [] : entry.result.warnings,
                  structuredWarnings: undefined,
                  aggregatedWarnings: undefined,
                  resolvedMembers: undefined,
                  toolHealth: undefined,
                  confidenceBreakdown: undefined,
                  provenance: canHoistProvenance ? undefined : entry.result.provenance
                }
              }
            : entry
        ))
      };
    }

    if (input.includeIssues !== false) {
      return nextOutput;
    }

    return {
      ...nextOutput,
      results: nextOutput.results.map((entry) => (
        entry.result
          ? {
              ...entry,
              result: {
                ...entry.result,
                issues: []
              }
            }
          : entry
      ))
    };
  }

  private buildValidateMixinOutput(
    mode: ValidateMixinOutput["mode"],
    results: ValidateMixinBatchResult[]
  ): ValidateMixinOutput {
    let valid = 0;
    let partial = 0;
    let invalid = 0;
    let processingErrors = 0;
    let totalValidationErrors = 0;
    let totalValidationWarnings = 0;
    const warningSet = new Set<string>();
    const incompleteReasonSet = new Set<string>();
    const issueGroupMap = new Map<string, { kind: string; confidence: string; category: string; count: number; sampleTargets: string[] }>();

    for (const entry of results) {
      if (!entry.result) {
        processingErrors++;
        continue;
      }

      if (entry.result.valid) {
        valid++;
      } else {
        invalid++;
      }
      if (entry.result.validationStatus === "partial") {
        partial++;
      }

      totalValidationErrors += entry.result.summary.errors;
      totalValidationWarnings += entry.result.summary.warnings;

      for (const warning of entry.result.warnings) {
        warningSet.add(warning);
      }

      for (const issue of entry.result.issues) {
        if (issue.kind === "validation-incomplete") {
          incompleteReasonSet.add(`validation-incomplete: ${issue.message}`);
        }
        const key = `${issue.kind}\0${issue.confidence ?? "unknown"}\0${issue.category ?? "validation"}`;
        const existing = issueGroupMap.get(key);
        if (existing) {
          existing.count++;
          if (existing.sampleTargets.length < 3) {
            existing.sampleTargets.push(issue.target);
          }
        } else {
          issueGroupMap.set(key, {
            kind: issue.kind,
            confidence: issue.confidence ?? "unknown",
            category: issue.category ?? "validation",
            count: 1,
            sampleTargets: [issue.target]
          });
        }
      }
    }

    const issueSummary = issueGroupMap.size > 0 ? [...issueGroupMap.values()] : undefined;
    const provenanceCandidates = results
      .map((entry) => entry.result?.provenance)
      .filter((entry): entry is MixinValidationProvenance => entry != null);
    const provenance = provenanceCandidates.length === 0
      ? undefined
      : provenanceCandidates.every((entry) => sameMixinValidationProvenance(entry, provenanceCandidates[0]))
        ? provenanceCandidates[0]
        : undefined;
    const toolHealth = results.find((entry) => entry.result?.toolHealth)?.result?.toolHealth;
    const confidenceScores = results
      .map((entry) => entry.result?.confidenceScore)
      .filter((score): score is number => score != null);

    return {
      mode,
      results,
      summary: {
        total: results.length,
        valid,
        partial,
        invalid,
        processingErrors,
        totalValidationErrors,
        totalValidationWarnings
      },
      issueSummary,
      provenance,
      incompleteReasons: incompleteReasonSet.size > 0 ? [...incompleteReasonSet] : undefined,
      toolHealth,
      confidenceScore: confidenceScores.length > 0 ? Math.min(...confidenceScores) : undefined,
      warnings: [...warningSet]
    };
  }

  async validateAccessWidener(input: ValidateAccessWidenerInput): Promise<ValidateAccessWidenerOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
    }
    const content = input.content;
    if (!content.trim()) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "content must be non-empty." });
    }

    const warnings: string[] = [];
    const parsed = parseAccessWidener(content);

    const headerNamespaceRaw = normalizeOptionalString(parsed.namespace);
    const overrideMapping = input.mapping ? normalizeMapping(input.mapping) : undefined;
    const headerNamespace = normalizeAccessWidenerNamespace(headerNamespaceRaw);
    if (!headerNamespace && headerNamespaceRaw && !overrideMapping) {
      warnings.push(`Unsupported access widener namespace "${headerNamespaceRaw}". Assuming intermediary.`);
    }

    const awNamespace = overrideMapping ?? headerNamespace ?? "intermediary";
    if (overrideMapping && headerNamespace && overrideMapping !== headerNamespace) {
      warnings.push(
        `Using mapping override "${overrideMapping}" instead of header namespace "${headerNamespaceRaw}".`
      );
    }
    const runtimeAware = input.projectPath != null || input.scope != null || input.preferProjectVersion === true;
    let resolvedVersion = version;
    let jarPath: string;
    let lookupMapping: SourceMapping = "obfuscated";
    let provenance: RuntimeValidationProvenance<SourceMapping> | undefined;

    if (runtimeAware) {
      provenance = await this.resolveAccessWidenerRuntimeArtifact({
        version,
        awNamespace,
        projectPath: input.projectPath,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion
      });
      resolvedVersion = provenance.version;
      jarPath = provenance.jarPath;
      lookupMapping = provenance.mappingApplied;
    } else {
      ({ jarPath } = await this.versionService.resolveVersionJar(version));
    }
    const needsLookupMapping = awNamespace !== lookupMapping;

    // Collect unique class FQNs from entries
    const classFqns = new Set<string>();
    for (const entry of parsed.entries) {
      const fqn = entry.target.replace(/\//g, ".");
      classFqns.add(fqn);
    }

    const membersByClass = new Map<string, ResolvedTargetMembers>();
    for (const fqn of classFqns) {
      let lookupFqn = fqn;

      if (needsLookupMapping) {
        try {
          const mapped = await this.mappingService.findMapping({
            version: resolvedVersion,
            kind: "class",
            name: fqn,
            sourceMapping: awNamespace,
            targetMapping: lookupMapping,
            sourcePriority: input.sourcePriority,
            projectPath: input.projectPath
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            lookupFqn = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${fqn}" from ${awNamespace} to ${lookupMapping}.`);
          }
        } catch {
          warnings.push(`Mapping lookup failed for class "${fqn}".`);
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: lookupFqn,
          jarPath,
          access: "all"
        });
        warnings.push(...sig.warnings);
        let constructors = sig.constructors;
        let methods = sig.methods;
        let fields = sig.fields;
        if (needsLookupMapping) {
          const [ctorResult, methodResult, fieldResult] = await Promise.all([
            this.remapSignatureMembers(
              sig.constructors,
              "method",
              resolvedVersion,
              lookupMapping,
              awNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            ),
            this.remapSignatureMembers(
              sig.methods,
              "method",
              resolvedVersion,
              lookupMapping,
              awNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            ),
            this.remapSignatureMembers(
              sig.fields,
              "field",
              resolvedVersion,
              lookupMapping,
              awNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            )
          ]);
          constructors = ctorResult.members;
          methods = methodResult.members;
          fields = fieldResult.members;
        }
        membersByClass.set(fqn, {
          className: fqn,
          classAccessFlags: sig.classAccessFlags,
          constructors,
          methods,
          fields
        });
      } catch {
        warnings.push(`Could not load signature for class "${lookupFqn}".`);
      }
    }

    const result = validateParsedAccessWidener(parsed, membersByClass, warnings, {
      includeRuntimeEvidence: runtimeAware
    });
    if (provenance) {
      result.provenance = provenance;
    }
    return result;
  }

  async validateAccessTransformer(input: ValidateAccessTransformerInput): Promise<ValidateAccessTransformerOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
    }
    const content = input.content;
    if (!content.trim()) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "content must be non-empty." });
    }

    const warnings: string[] = [];
    const parsed = parseAccessTransformer(content);
    const atNamespace = await this.resolveAccessTransformerNamespace({
      atNamespace: input.atNamespace,
      projectPath: input.projectPath
    });
    const runtimeAware = input.projectPath != null || input.scope != null || input.preferProjectVersion === true;
    let resolvedVersion = version;
    let jarPath: string;
    let lookupMapping: SourceMapping | AccessTransformerNamespace = "obfuscated";
    let provenance: RuntimeValidationProvenance<AccessTransformerNamespace> | undefined;

    if (runtimeAware) {
      provenance = await this.resolveAccessTransformerRuntimeArtifact({
        version,
        atNamespace,
        projectPath: input.projectPath,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion
      });
      resolvedVersion = provenance.version;
      jarPath = provenance.jarPath;
      lookupMapping = provenance.mappingApplied;
    } else {
      if (atNamespace === "srg") {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: "atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved."
        });
      }
      ({ jarPath } = await this.versionService.resolveVersionJar(version));
    }

    const needsLookupMapping = atNamespace !== lookupMapping;
    const classFqns = new Set(parsed.entries.map((entry) => entry.owner));
    const membersByClass = new Map<string, ResolvedTargetMembers>();

    for (const fqn of classFqns) {
      let lookupFqn = fqn;
      if (needsLookupMapping) {
        if (!isSourceMappingNamespace(atNamespace) || !isSourceMappingNamespace(lookupMapping)) {
          warnings.push(`Could not map class "${fqn}" from ${atNamespace} to ${lookupMapping}.`);
        } else {
          try {
            const mapped = await this.mappingService.findMapping({
              version: resolvedVersion,
              kind: "class",
              name: fqn,
              sourceMapping: atNamespace,
              targetMapping: lookupMapping,
              sourcePriority: input.sourcePriority,
              projectPath: input.projectPath
            });
            if (mapped.resolved && mapped.resolvedSymbol) {
              lookupFqn = mapped.resolvedSymbol.name;
            } else {
              warnings.push(`Could not map class "${fqn}" from ${atNamespace} to ${lookupMapping}.`);
            }
          } catch {
            warnings.push(`Mapping lookup failed for class "${fqn}".`);
          }
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: lookupFqn,
          jarPath,
          access: "all"
        });
        warnings.push(...sig.warnings);
        let constructors = sig.constructors;
        let methods = sig.methods;
        let fields = sig.fields;

        if (needsLookupMapping && isSourceMappingNamespace(atNamespace) && isSourceMappingNamespace(lookupMapping)) {
          const [ctorResult, methodResult, fieldResult] = await Promise.all([
            this.remapSignatureMembers(
              sig.constructors,
              "method",
              resolvedVersion,
              lookupMapping,
              atNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            ),
            this.remapSignatureMembers(
              sig.methods,
              "method",
              resolvedVersion,
              lookupMapping,
              atNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            ),
            this.remapSignatureMembers(
              sig.fields,
              "field",
              resolvedVersion,
              lookupMapping,
              atNamespace,
              input.sourcePriority,
              warnings,
              input.projectPath
            )
          ]);
          constructors = ctorResult.members;
          methods = methodResult.members;
          fields = fieldResult.members;
        }

        membersByClass.set(fqn, {
          className: fqn,
          classAccessFlags: sig.classAccessFlags,
          constructors,
          methods,
          fields
        });
      } catch {
        warnings.push(`Could not load signature for class "${lookupFqn}".`);
      }
    }

    const result = validateParsedAccessTransformer(parsed, membersByClass, warnings, {
      includeRuntimeEvidence: runtimeAware
    });
    if (provenance) {
      result.provenance = provenance;
    }
    return result;
  }

  recordToolCall(tool: string, durationMs: number): void {
    this.metrics.recordToolCall(tool, durationMs);
  }

  getRuntimeMetrics(): RuntimeMetricSnapshot {
    this.snapshotLruAccounting();
    this.metrics.setMappingResolutionCacheStats(this.mappingService.resolutionCacheStats);
    return this.metrics.snapshot();
  }

  async indexArtifact(input: IndexArtifactInput): Promise<IndexArtifactOutput> {
    const artifactId = input.artifactId?.trim();
    if (!artifactId) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId must be non-empty."
      });
    }

    const artifact = this.getArtifact(artifactId);
    const force = input.force ?? false;
    const hasFiles = this.hasAnyFiles(artifact.artifactId);
    const meta = this.indexMetaRepo.get(artifact.artifactId);
    const expectedSignature = artifact.artifactSignature ?? this.fallbackArtifactSignature(artifact.artifactId);
    const reason = this.resolveIndexRebuildReason({
      force,
      expectedSignature,
      hasFiles,
      meta
    });

    if (reason === "already_current") {
      this.metrics.recordReindexSkip();
      const currentMeta = meta as ArtifactIndexMetaRow;
      return {
        artifactId: artifact.artifactId,
        reindexed: false,
        reason,
        counts: {
          files: currentMeta.filesCount,
          symbols: currentMeta.symbolsCount,
          ftsRows: currentMeta.ftsRowsCount
        },
        indexedAt: currentMeta.indexedAt,
        durationMs: 0,
        mappingApplied: artifact.mappingApplied ?? "obfuscated"
      };
    }

    const resolved = this.toResolvedArtifact(artifact);
    const rebuilt = await this.rebuildAndPersistArtifactIndex(resolved, reason);
    this.metrics.recordReindex();
    return {
      artifactId: artifact.artifactId,
      reindexed: true,
      reason,
      counts: {
        files: rebuilt.files.length,
        symbols: rebuilt.symbols.length,
        ftsRows: rebuilt.files.length
      },
      indexedAt: rebuilt.indexedAt,
      durationMs: rebuilt.indexDurationMs,
      mappingApplied: artifact.mappingApplied ?? "obfuscated"
    };
  }

  private searchSymbolIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    regexPattern: RegExp | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const matchedSymbols = this.findSymbolHits(artifactId, query, match, scope, regexPattern);

    for (const item of matchedSymbols) {
      onHit({
        filePath: item.symbol.filePath,
        score: item.score,
        matchedIn: "symbol",
        reasonCodes: [`symbol_${match}`],
        symbol: {
          symbolKind: item.symbol.symbolKind as SymbolKind,
          symbolName: item.symbol.symbolName,
          qualifiedName: item.symbol.qualifiedName,
          line: item.symbol.line
        }
      });
    }
  }

  private searchTextIntentIndexed(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const candidateLimit = this.indexedCandidateLimitForMatch(match);
    const indexed = this.filesRepo.searchFileCandidates(artifactId, {
      query,
      match,
      limit: candidateLimit,
      mode: "text"
    });
    this.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
    this.metrics.recordSearchRowsScanned(indexed.scannedRows);

    // Zero-result short-circuit: if indexed search returns nothing, skip hydration
    if (indexed.items.length === 0) {
      this.metrics.recordSearchIndexedZeroShortcircuit();
      return;
    }

    const globFilter = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
    const candidatePaths = indexed.items
      .filter((candidate) => candidate.matchedIn !== "path")
      .map((candidate) => candidate.filePath)
      .filter((filePath) => checkPackagePrefix(filePath, scope?.packagePrefix))
      .filter((filePath) => !globFilter || globFilter.test(filePath));

    const candidateContentRows = this.filesRepo.getFileContentsByPaths(artifactId, candidatePaths);
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(candidateContentRows.length);

    const candidateRows: Array<{ filePath: string; contentIndex: number }> = [];

    for (const candidate of candidateContentRows) {
      const contentIndex = findContentMatchIndex(candidate.content, query, match);
      if (contentIndex < 0) {
        continue;
      }

      candidateRows.push({
        filePath: candidate.filePath,
        contentIndex
      });
    }

    for (const candidate of candidateRows) {
      onHit({
        filePath: candidate.filePath,
        score: scoreTextMatch(match, candidate.contentIndex),
        matchedIn: "content",
        reasonCodes: ["content_match", `text_${match}`, "indexed"]
      });
    }
  }

  private searchPathIntentIndexed(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const candidateLimit = this.indexedCandidateLimitForMatch(match);
    const indexed = this.filesRepo.searchFileCandidates(artifactId, {
      query,
      limit: candidateLimit,
      mode: "path"
    });
    this.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
    this.metrics.recordSearchRowsScanned(indexed.scannedRows);

    // Zero-result short-circuit: if indexed search returns nothing, skip hydration
    if (indexed.items.length === 0) {
      this.metrics.recordSearchIndexedZeroShortcircuit();
      return;
    }

    const globFilter = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
    const candidateRows: Array<{ filePath: string; pathIndex: number }> = [];

    for (const candidate of indexed.items) {
      if (candidate.matchedIn === "content") {
        continue;
      }

      if (!checkPackagePrefix(candidate.filePath, scope?.packagePrefix)) {
        continue;
      }

      if (globFilter && !globFilter.test(candidate.filePath)) {
        continue;
      }

      const pathIndex = findMatchIndex(candidate.filePath, query, match);
      if (pathIndex < 0) {
        continue;
      }

      candidateRows.push({
        filePath: candidate.filePath,
        pathIndex
      });
    }
    for (const candidate of candidateRows) {
      onHit({
        filePath: candidate.filePath,
        score: scorePathMatch(match, candidate.pathIndex),
        matchedIn: "path",
        reasonCodes: ["path_match", `path_${match}`, "indexed"]
      });
    }
  }

  private searchTextIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    regexPattern: RegExp | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);
    const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
    let cursor: string | undefined = undefined;

    while (true) {
      const page = this.filesRepo.listFileRows(artifactId, { limit: pageSize, cursor });
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(page.items.length);

      for (const row of page.items) {
        if (!checkPackagePrefix(row.filePath, scope?.packagePrefix)) {
          continue;
        }
        if (glob && !glob.test(row.filePath)) {
          continue;
        }

        const contentIndex =
          match === "regex"
            ? matchRegexIndex(row.content, regexPattern as RegExp)
            : findContentMatchIndex(row.content, query, match);
        if (contentIndex < 0) {
          continue;
        }

        onHit({
          filePath: row.filePath,
          score: scoreTextMatch(match, contentIndex),
          matchedIn: "content",
          reasonCodes: ["content_match", `text_${match}`]
        });
      }

      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
  }

  private searchPathIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    regexPattern: RegExp | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);
    const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
    let cursor: string | undefined = undefined;

    while (true) {
      const page = this.filesRepo.listFiles(artifactId, { limit: pageSize, cursor });
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(page.items.length);

      for (const filePath of page.items) {
        if (!checkPackagePrefix(filePath, scope?.packagePrefix)) {
          continue;
        }
        if (glob && !glob.test(filePath)) {
          continue;
        }

        const pathIndex =
          match === "regex"
            ? matchRegexIndex(filePath, regexPattern as RegExp)
            : findMatchIndex(filePath, query, match);
        if (pathIndex < 0) {
          continue;
        }

        onHit({
          filePath,
          score: scorePathMatch(match, pathIndex),
          matchedIn: "path",
          reasonCodes: ["path_match", `path_${match}`]
        });
      }

      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
  }

  private findSymbolHits(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    regexPattern: RegExp | undefined
  ): IndexedSymbolHit[] {
    if (match !== "regex") {
      const filePathLike = scope?.fileGlob ? globToSqlLike(normalizePathStyle(scope.fileGlob)) : undefined;
      const scoped = this.symbolsRepo.findScopedSymbols({
        artifactId,
        query,
        match,
        symbolKind: scope?.symbolKind,
        packagePrefix: scope?.packagePrefix,
        filePathLike,
        limit: this.indexedCandidateLimit()
      });
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(scoped.items.length);

      const result: IndexedSymbolHit[] = [];
      for (const symbol of scoped.items) {
        if (!isSymbolKind(symbol.symbolKind)) {
          continue;
        }
        const index = findMatchIndex(symbol.symbolName, query, match);
        if (index < 0) {
          continue;
        }
        result.push({
          symbol,
          score: scoreSymbolMatch(match, index, symbol.symbolKind),
          matchIndex: index
        });
      }
      return result;
    }

    const candidates = this.symbolsRepo.listSymbolsForArtifact(artifactId, scope?.symbolKind);
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(candidates.length);
    const result: IndexedSymbolHit[] = [];
    const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;

    for (const symbol of candidates) {
      if (!checkPackagePrefix(symbol.filePath, scope?.packagePrefix)) {
        continue;
      }

      if (glob && !glob.test(symbol.filePath)) {
        continue;
      }

      if (!isSymbolKind(symbol.symbolKind)) {
        continue;
      }

      const index =
        match === "regex"
          ? matchRegexIndex(symbol.symbolName, regexPattern as RegExp)
          : findMatchIndex(symbol.symbolName, query, match);
      if (index < 0) {
        continue;
      }

      result.push({
        symbol,
        score: scoreSymbolMatch(match, index, symbol.symbolKind),
        matchIndex: index
      });
    }

    return result;
  }

  private indexedCandidateLimit(): number {
    return Math.min(Math.max(this.config.maxSearchHits * 5, 500), 5000);
  }

  private indexedCandidateLimitForMatch(match: SearchMatch): number {
    const base = this.indexedCandidateLimit();
    if (match === "exact" || match === "prefix") {
      // Exact/prefix matches are more selective — fewer candidates needed
      return Math.min(base, 500);
    }
    // Contains matches need more candidates
    return base;
  }

  private extractClassMetadata(filePath: string, content: string): string {
    const lines = content.split(/\r?\n/);
    const symbols = extractSymbolsFromSource(filePath, content);
    const outputParts: string[] = [];

    // Include package + import header (lines before first symbol declaration)
    const firstSymbolLine = symbols.length > 0 ? symbols[0]!.line : lines.length + 1;
    for (let i = 0; i < Math.min(firstSymbolLine - 1, lines.length); i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("package ") || trimmed.startsWith("import ") || trimmed === "") {
        outputParts.push(line);
      }
    }

    // Add each symbol's declaration line
    for (const symbol of symbols) {
      const lineIndex = symbol.line - 1;
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const prefix = symbol.symbolKind === "class" || symbol.symbolKind === "interface" ||
          symbol.symbolKind === "enum" || symbol.symbolKind === "record"
          ? `\n// [${symbol.symbolKind}] line ${symbol.line}`
          : `// [${symbol.symbolKind}] line ${symbol.line}`;
        outputParts.push(prefix);
        outputParts.push(lines[lineIndex]!);
      }
    }

    return outputParts.join("\n");
  }

  private extractDecompiledMembers(
    className: string,
    filePath: string,
    content: string
  ): { constructors: DecompiledMember[]; fields: DecompiledMember[]; methods: DecompiledMember[] } {
    const symbols = extractSymbolsFromSource(filePath, content);
    const simpleName = className.split(/[.$]/).at(-1) ?? className;
    const lines = content.split(/\r?\n/);
    const body = this.computeBraceRange(lines, symbols, simpleName);
    if (!body) {
      return { constructors: [], fields: [], methods: [] };
    }
    const depths = this.computeLineBraceDepths(lines);
    const baseDepth = depths[body.declarationLine - 1] ?? 0;
    const nestedRanges = this.computeNestedTypeRanges(lines, symbols, body);
    const constructors: DecompiledMember[] = [];
    const fields: DecompiledMember[] = [];
    const methods: DecompiledMember[] = [];
    for (const symbol of symbols) {
      if (symbol.line <= body.declarationLine || symbol.line > body.endLine) {
        continue;
      }
      if (nestedRanges.some((range) => symbol.line >= range.declarationLine && symbol.line <= range.endLine)) {
        continue;
      }
      const lineDepth = depths[symbol.line - 1] ?? baseDepth;
      // Declarations directly inside the class body sit at baseDepth+1; anything
      // deeper is a method/constructor body, an initializer block, etc.
      if (lineDepth !== baseDepth + 1) {
        continue;
      }
      if (symbol.symbolKind === "method") {
        if (symbol.symbolName === simpleName) {
          constructors.push({ name: "<init>", line: symbol.line, kind: "constructor" });
        } else {
          methods.push({ name: symbol.symbolName, line: symbol.line, kind: "method" });
        }
      } else if (symbol.symbolKind === "field") {
        fields.push({ name: symbol.symbolName, line: symbol.line, kind: "field" });
      }
    }
    return { constructors, fields, methods };
  }

  private computeLineBraceDepths(lines: string[]): number[] {
    const depths: number[] = new Array(lines.length).fill(0);
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      // Entry depth for this line = depth observed before any brace on it.
      depths[i] = depth;
      const stripped = (lines[i] ?? "")
        .replace(/\/\/.*/g, "")
        .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
      for (const char of stripped) {
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
        }
      }
    }
    return depths;
  }

  private computeBraceRange(
    lines: string[],
    symbols: Array<{ symbolKind: string; symbolName: string; line: number }>,
    simpleName: string
  ): { declarationLine: number; endLine: number } | undefined {
    const classSymbol = symbols.find((symbol) =>
      (symbol.symbolKind === "class" || symbol.symbolKind === "interface"
        || symbol.symbolKind === "enum" || symbol.symbolKind === "record")
      && symbol.symbolName === simpleName
    );
    if (!classSymbol) {
      return undefined;
    }
    return this.scanBraceRange(lines, classSymbol.line);
  }

  private scanBraceRange(
    lines: string[],
    declarationLine: number
  ): { declarationLine: number; endLine: number } {
    let depth = 0;
    let started = false;
    for (let i = declarationLine - 1; i < lines.length; i += 1) {
      const stripped = (lines[i] ?? "")
        .replace(/\/\/.*/g, "")
        .replace(/"(?:\\.|[^"\\])*"/g, "\"\"");
      for (const char of stripped) {
        if (char === "{") {
          depth += 1;
          started = true;
        } else if (char === "}") {
          depth -= 1;
          if (started && depth === 0) {
            return { declarationLine, endLine: i + 1 };
          }
        }
      }
    }
    return { declarationLine, endLine: lines.length };
  }

  private computeNestedTypeRanges(
    lines: string[],
    symbols: Array<{ symbolKind: string; line: number }>,
    outerBody: { declarationLine: number; endLine: number }
  ): Array<{ declarationLine: number; endLine: number }> {
    const ranges: Array<{ declarationLine: number; endLine: number }> = [];
    for (const candidate of symbols) {
      if (candidate.symbolKind !== "class" && candidate.symbolKind !== "interface"
        && candidate.symbolKind !== "enum" && candidate.symbolKind !== "record") {
        continue;
      }
      if (candidate.line <= outerBody.declarationLine || candidate.line > outerBody.endLine) {
        continue;
      }
      if (ranges.some((range) => candidate.line >= range.declarationLine && candidate.line <= range.endLine)) {
        continue;
      }
      const nestedRange = this.scanBraceRange(lines, candidate.line);
      ranges.push(nestedRange);
    }
    return ranges;
  }

  private resolveClassFilePath(artifactId: string, className: string): string | undefined {
    const normalizedClassName = className.trim();
    const classPath = classNameToClassPath(normalizedClassName);
    if (!classPath) {
      return undefined;
    }
    const candidates = new Set<string>([`${classPath}.java`]);
    const innerIndex = classPath.indexOf("$");
    if (innerIndex > 0) {
      candidates.add(`${classPath.slice(0, innerIndex)}.java`);
    }

    const simpleName = normalizedClassName.split(/[.$]/).at(-1);
    if (!simpleName) {
      return undefined;
    }
    const lastSlash = classPath.lastIndexOf("/");
    const expectedPrefix = lastSlash < 0 ? "" : classPath.slice(0, lastSlash + 1);
    return this.filesRepo.findBestClassLookupPath(
      artifactId,
      [...candidates],
      normalizedClassName,
      simpleName,
      expectedPrefix
    );
  }

  private async resolveBinaryFallbackArtifact(input: {
    binaryJarPath?: string;
    version?: string;
    coordinate?: string;
    requestedMapping: SourceMapping;
    mappingApplied: SourceMapping;
    provenance?: ArtifactProvenance;
    qualityFlags: string[];
  }): Promise<ResolvedSourceArtifact | undefined> {
    const binaryJarPath = normalizeOptionalString(input.binaryJarPath);
    if (!binaryJarPath) {
      return undefined;
    }

    try {
      const fallbackResolved = await resolveSourceTargetInternal(
        { kind: "jar", value: binaryJarPath },
        { allowDecompile: true, preferBinaryOnly: true },
        this.config
      );
      fallbackResolved.version = fallbackResolved.version ?? input.version;
      fallbackResolved.coordinate = fallbackResolved.coordinate ?? input.coordinate;
      fallbackResolved.requestedMapping = input.requestedMapping;
      fallbackResolved.mappingApplied = input.mappingApplied;
      fallbackResolved.provenance = input.provenance;
      fallbackResolved.qualityFlags = dedupeQualityFlags([
        ...(fallbackResolved.qualityFlags ?? []),
        ...input.qualityFlags,
        "binary-fallback"
      ]);
      await this.ingestIfNeeded(fallbackResolved);
      return fallbackResolved;
    } catch {
      return undefined;
    }
  }

  private buildProvenance(input: {
    requestedTarget: SourceTargetInput;
    resolved: ResolvedSourceArtifact;
    transformChain: string[];
  }): ArtifactProvenance {
    const provenance: ArtifactProvenance = {
      target: input.requestedTarget,
      resolvedAt: input.resolved.resolvedAt,
      resolvedFrom: {
        origin: input.resolved.origin,
        sourceJarPath: input.resolved.sourceJarPath,
        binaryJarPath: input.resolved.binaryJarPath,
        coordinate: input.resolved.coordinate,
        version: input.resolved.version,
        repoUrl: input.resolved.repoUrl
      },
      transformChain: [...input.transformChain]
    };

    if (!provenance.resolvedAt || !provenance.target.kind || !provenance.target.value) {
      throw createError({
        code: ERROR_CODES.PROVENANCE_INCOMPLETE,
        message: "Artifact provenance is incomplete.",
        details: {
          artifactId: input.resolved.artifactId,
          provenance
        }
      });
    }

    return provenance;
  }

  private buildFallbackProvenance(input: {
    artifactId: string;
    origin: ResolvedSourceArtifact["origin"];
    requestedMapping: SourceMapping;
    mappingApplied: SourceMapping;
  }): ArtifactProvenance {
    const artifact = this.getArtifact(input.artifactId);
    const fallbackTarget: SourceTargetInput = artifact.version
      ? { kind: "version", value: artifact.version }
      : artifact.coordinate
        ? { kind: "coordinate", value: artifact.coordinate }
        : { kind: "jar", value: artifact.sourceJarPath ?? artifact.binaryJarPath ?? input.artifactId };

    const transformChain =
      artifact.provenance?.transformChain && artifact.provenance.transformChain.length > 0
        ? artifact.provenance.transformChain
        : [`mapping:${input.requestedMapping}->${input.mappingApplied}`];

    return {
      target: fallbackTarget,
      resolvedAt: artifact.updatedAt,
      resolvedFrom: {
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        binaryJarPath: artifact.binaryJarPath,
        coordinate: artifact.coordinate,
        version: artifact.version,
        repoUrl: artifact.repoUrl
      },
      transformChain
    };
  }

  private async resolveClassNameForLookup(input: {
    className: string;
    version?: string;
    sourceMapping: SourceMapping;
    targetMapping: SourceMapping;
    sourcePriority: MappingSourcePriority | undefined;
    warnings: string[];
    context: string;
  }): Promise<string> {
    if (input.sourceMapping === input.targetMapping) {
      return input.className;
    }
    if (!input.version) {
      input.warnings.push(
        `Could not map class "${input.className}" from ${input.sourceMapping} to ${input.targetMapping} for ${input.context} because version is unavailable.`
      );
      return input.className;
    }
    try {
      const mapped = await this.mappingService.findMapping({
        version: input.version,
        kind: "class",
        name: input.className,
        sourceMapping: input.sourceMapping,
        targetMapping: input.targetMapping,
        sourcePriority: input.sourcePriority
      });
      if (mapped.resolved && mapped.resolvedSymbol) {
        return mapped.resolvedSymbol.name;
      }
      input.warnings.push(
        `Could not map class "${input.className}" from ${input.sourceMapping} to ${input.targetMapping} for ${input.context}.`
      );
    } catch {
      input.warnings.push(
        `Mapping lookup failed for class "${input.className}" while preparing ${input.context} in ${input.targetMapping}.`
      );
    }
    return input.className;
  }

  private buildClassSourceNotFoundError(input: {
    className: string;
    lookupClassName: string;
    artifactId: string;
    mappingApplied: SourceMapping;
    requestedMapping: SourceMapping;
    qualityFlags: string[];
    attemptedBinaryFallback: boolean;
    filePath?: string;
    targetKind?: string;
    targetValue?: string;
    scope?: ArtifactScope;
    projectPath?: string;
    version?: string;
  }): AppError {
    const simpleName = input.className.split(/[.$]/).at(-1) ?? input.className;
    const details: Record<string, unknown> = {
      artifactId: input.artifactId,
      className: input.className,
      mapping: input.mappingApplied,
      qualityFlags: input.qualityFlags,
      ...(input.lookupClassName !== input.className ? { lookupClassName: input.lookupClassName } : {}),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.targetKind ? { targetKind: input.targetKind } : {}),
      ...(input.targetValue ? { targetValue: input.targetValue } : {}),
      ...(input.attemptedBinaryFallback ? { binaryFallbackAttempted: true } : {})
    };

    let nextAction = `Use find-class to resolve the correct fully-qualified name for "${simpleName}".`;
    let suggestedCall: { tool: string; params: Record<string, unknown> } = {
      tool: "find-class",
      params: { className: simpleName, artifactId: input.artifactId }
    };

    if (input.targetKind === "version" && input.scope && input.scope !== "merged" && !input.projectPath) {
      nextAction +=
        ` If the class exists in a modded environment, retry with scope: "merged" and projectPath pointing to your mod project.`;
    } else if (input.targetKind === "version" && input.scope && input.scope !== "merged" && input.projectPath) {
      nextAction += ` The class may exist in merged sources; retry with scope: "merged".`;
    }

    if (hasPartialNetMinecraftCoverage(input.qualityFlags)) {
      nextAction =
        `Resolved source coverage does not include net.minecraft for "${input.className}",` +
        (input.attemptedBinaryFallback
          ? " and binary fallback did not produce source for that class."
          : " and a binary fallback has not produced source for that class.") +
        " Use get-class-api-matrix or find-mapping instead of find-class for vanilla API discovery.";
      if (input.version) {
        suggestedCall = {
          tool: "get-class-api-matrix",
          params: {
            version: input.version,
            className: input.className,
            classNameMapping: input.requestedMapping
          }
        };
      } else {
        suggestedCall = {
          tool: "find-class",
          params: { className: simpleName, artifactId: input.artifactId }
        };
      }
    }

    if (input.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(input.className)) {
      nextAction += ` ${obfuscatedNamespaceHint(input.className)}`;
    }

    details.nextAction = nextAction;
    details.suggestedCall = suggestedCall;

    return createError({
      code: ERROR_CODES.CLASS_NOT_FOUND,
      message: `Source for class "${input.className}" was not found.`,
      details
    });
  }

  private rejectLifecycleClassLikeInput(input: {
    symbol: string;
    className: string;
    methodName: string;
    mapping: SourceMapping;
    version?: string;
    sourcePriority?: MappingSourcePriority;
  }): void {
    if (!looksLikeClassSegment(input.methodName)) {
      return;
    }

    const classLikeSymbol = `${input.className}.${input.methodName}`;
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: {
        symbol: input.symbol,
        classLikeSymbol,
        nextAction: "Pass lifecycle input as Class.method and use the separate descriptor field for exact overload matching.",
        suggestedCall: input.version
          ? {
          tool: "check-symbol-exists",
          params: {
            version: input.version,
            kind: "class",
            name: classLikeSymbol,
            sourceMapping: input.mapping
          }
          }
          : undefined
      }
    });
  }

  private releaseLifecycleMappingGraph(version: string, sourcePriority: MappingSourcePriority | undefined): void {
    if (
      "releaseGraphCacheEntry" in this.mappingService &&
      typeof this.mappingService.releaseGraphCacheEntry === "function"
    ) {
      this.mappingService.releaseGraphCacheEntry(version, sourcePriority);
    }
  }

  private async resolveToObfuscatedClassName(
    className: string,
    version: string,
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<string> {
    return this.resolveClassNameForLookup({
      className,
      version,
      sourceMapping: mapping,
      targetMapping: "obfuscated",
      sourcePriority,
      warnings,
      context: "bytecode lookup"
    });
  }

  private async resolveToObfuscatedMemberName(
    name: string,
    ownerInSourceMapping: string,
    descriptor: string | undefined,
    kind: "field" | "method",
    version: string,
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<{ name: string; descriptor?: string }> {
    if (mapping === "obfuscated") {
      return {
        name,
        descriptor: kind === "method" ? descriptor : undefined
      };
    }
    try {
      const canResolveMethodExactly =
        kind === "method" &&
        descriptor &&
        "resolveMethodMappingExact" in this.mappingService &&
        typeof this.mappingService.resolveMethodMappingExact === "function";
      const mapped = canResolveMethodExactly
        ? await this.mappingService.resolveMethodMappingExact({
            version,
            owner: ownerInSourceMapping,
            name,
            descriptor,
            sourceMapping: mapping,
            targetMapping: "obfuscated",
            sourcePriority
          })
        : await this.mappingService.findMapping({
            version,
            kind,
            name,
            owner: ownerInSourceMapping,
            descriptor,
            // When we do have a descriptor this path is an exact lookup (the resolveMethodMappingExact
            // fast path is chosen instead whenever possible). findMapping's service-layer default is
            // "name-only" to match the public tool schema, so we must opt in to strict semantics here
            // to preserve the descriptor-aware overload selection this caller relies on.
            signatureMode:
              kind === "method"
                ? descriptor
                  ? "exact"
                  : "name-only"
                : undefined,
            sourceMapping: mapping,
            targetMapping: "obfuscated",
            sourcePriority
          });
      warnings.push(...mapped.warnings);
      if (mapped.resolved && mapped.resolvedSymbol) {
        return {
          name: mapped.resolvedSymbol.name,
          descriptor: kind === "method" ? mapped.resolvedSymbol.descriptor ?? descriptor : undefined
        };
      }
      // resolveMethodMappingExact still rejects partial descriptor projections, so a
      // Mojang / Yarn method whose descriptor mixes a remapped Minecraft class with a JDK
      // type (e.g. `(L...ItemStack;Ljava/lang/String;)V`) bottoms out as unresolved /
      // mapping_unavailable here even though `findMapping` with signatureMode="exact" would
      // accept the partially projected descriptor. Fall back to `findMapping` before giving
      // up so downstream paths (access-widener remap, trace-symbol-lifecycle, signature
      // member remap) do not silently miss real methods.
      if (canResolveMethodExactly && (mapped.status === "not_found" || mapped.status === "mapping_unavailable")) {
        const fallbackMapped = await this.mappingService.findMapping({
          version,
          kind,
          name,
          owner: ownerInSourceMapping,
          descriptor,
          signatureMode: "exact",
          sourceMapping: mapping,
          targetMapping: "obfuscated",
          sourcePriority
        });
        warnings.push(...fallbackMapped.warnings);
        if (fallbackMapped.resolved && fallbackMapped.resolvedSymbol) {
          return {
            name: fallbackMapped.resolvedSymbol.name,
            descriptor: kind === "method" ? fallbackMapped.resolvedSymbol.descriptor ?? descriptor : undefined
          };
        }
      }
      warnings.push(`Could not map ${kind} "${name}" from ${mapping} to obfuscated.`);
    } catch (caughtError) {
      warnings.push(
        `Mapping lookup failed for ${kind} "${name}": ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
      );
    }
    return {
      name,
      descriptor: kind === "method" ? descriptor : undefined
    };
  }

  private async remapSignatureMembers(
    members: SignatureMember[],
    kind: "field" | "method",
    version: string,
    sourceMapping: SourceMapping,
    targetMapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[],
    projectPath?: string
  ): Promise<{ members: SignatureMember[]; failedNames: Set<string> }> {
    const failedNames = new Set<string>();
    if (sourceMapping === targetMapping) {
      return { members, failedNames };
    }

    // Build deduplicated lookup tables for member names and owner FQNs
    const memberKeyToRemapped = new Map<string, string>();
    const memberDescriptorRemapped = new Map<string, string>();
    const ownerToRemapped = new Map<string, string>();

    for (const member of members) {
      const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
      if (!memberKeyToRemapped.has(memberKey)) {
        memberKeyToRemapped.set(memberKey, member.name); // default = source name
      }
      if (!ownerToRemapped.has(member.ownerFqn)) {
        ownerToRemapped.set(member.ownerFqn, member.ownerFqn); // default = source FQN
      }
    }

    // Phase 1: Remap owner FQNs first (needed for member disambiguation)
    const ownerEntries = [...ownerToRemapped.entries()];
    await Promise.all(
      ownerEntries.map(async ([obfuscatedFqn]) => {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: obfuscatedFqn,
            sourceMapping,
            targetMapping,
            sourcePriority,
            projectPath
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            ownerToRemapped.set(obfuscatedFqn, mapped.resolvedSymbol.name);
          }
        } catch {
          // keep source FQN as fallback
        }
      })
    );

    // Phase 1.5: Collect class references from descriptors and remap them
    const descriptorClassRefs = new Set<string>();
    for (const member of members) {
      for (const match of member.jvmDescriptor.matchAll(/L([^;]+);/g)) {
        const dotFqn = match[1]!.replace(/\//g, ".");
        if (!ownerToRemapped.has(dotFqn)) {
          descriptorClassRefs.add(dotFqn);
        }
      }
    }
    if (descriptorClassRefs.size > 0) {
      const refs = [...descriptorClassRefs];
      for (const ref of refs) {
        ownerToRemapped.set(ref, ref); // default = source name
      }
      await Promise.all(
        refs.map(async (dotFqn) => {
          try {
            const mapped = await this.mappingService.findMapping({
              version,
              kind: "class",
              name: dotFqn,
              sourceMapping,
              targetMapping,
              sourcePriority,
              projectPath
            });
            if (mapped.resolved && mapped.resolvedSymbol) {
              ownerToRemapped.set(dotFqn, mapped.resolvedSymbol.name);
            }
          } catch {
            // keep source name as fallback
          }
        })
      );
    }

    // Build a class map for descriptor remapping (dot-FQN → dot-FQN)
    const classMap = new Map<string, string>();
    for (const [src, tgt] of ownerToRemapped) {
      if (src !== tgt) {
        classMap.set(src, tgt);
      }
    }

    // Phase 2: Remap member names (and descriptors for methods) using resolved owners
    const canResolveMethodExactly =
      kind === "method" &&
      "resolveMethodMappingExact" in this.mappingService &&
      typeof this.mappingService.resolveMethodMappingExact === "function";

    const memberEntries = [...memberKeyToRemapped.entries()];
    await Promise.all(
      memberEntries.map(async ([key, _sourceName]) => {
        const [ownerFqn, name, descriptor] = key.split("\0");
        try {
          const targetOwner = ownerToRemapped.get(ownerFqn!) ?? ownerFqn;

          // For methods with descriptors, try exact resolution first
          if (canResolveMethodExactly && descriptor) {
            try {
              const exactResult = await this.mappingService.resolveMethodMappingExact({
                version,
                owner: ownerFqn!,
                name: name!,
                descriptor,
                sourceMapping,
                targetMapping,
                sourcePriority,
                projectPath
              });
              if (exactResult.resolved && exactResult.resolvedSymbol) {
                memberKeyToRemapped.set(key, exactResult.resolvedSymbol.name);
                if (exactResult.resolvedSymbol.descriptor) {
                  memberDescriptorRemapped.set(key, exactResult.resolvedSymbol.descriptor);
                }
                return; // exact resolution succeeded
              }
              // Fall through to findMapping with descriptorHint
            } catch (exactError) {
              warnings.push(
                `Exact method resolution failed for "${name}" (falling back to name-based lookup): ${exactError instanceof Error ? exactError.message : String(exactError)}`
              );
            }
          }

          // Fallback: findMapping with descriptorHint for overload disambiguation
          const remappedDescriptorHint = kind === "method" && descriptor
            ? remapJvmDescriptor(descriptor, classMap)
            : undefined;

          const mapped = await this.mappingService.findMapping({
            version,
            kind,
            name,
            owner: ownerFqn,
            descriptor: kind === "method" ? descriptor : undefined,
            // Access-widener / access-transformer remap runs after validation has accepted
            // the descriptor as authoritative, so preserve exact overload matching even
            // though the descriptorHint path also exists for ambiguity fallback.
            signatureMode: kind === "method" && descriptor ? "exact" : undefined,
            sourceMapping,
            targetMapping,
            sourcePriority,
            projectPath,
            disambiguation: {
              ownerHint: targetOwner,
              descriptorHint: remappedDescriptorHint
            }
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            memberKeyToRemapped.set(key, mapped.resolvedSymbol.name);
            if (kind === "method" && mapped.resolvedSymbol.descriptor) {
              memberDescriptorRemapped.set(key, mapped.resolvedSymbol.descriptor);
            }
          } else if (mapped.status === "ambiguous" && mapped.candidates && mapped.candidates.length > 0) {
            // Disambiguate: filter by target owner and pick the best candidate
            const ownerMatched = mapped.candidates.filter(
              (c) => c.owner === targetOwner
            );
            const best = ownerMatched.length > 0 ? ownerMatched : mapped.candidates;
            if (best.length > 0) {
              memberKeyToRemapped.set(key, best[0]!.name);
              // Only mark as failed if the best candidate is not a high-confidence match
              if (best[0]!.confidence < 0.9) {
                failedNames.add(name!);
              }
            } else {
              warnings.push(`Could not remap ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
              failedNames.add(name!);
            }
          } else {
            warnings.push(`Could not remap ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
            failedNames.add(name!);
          }
        } catch {
          warnings.push(`Remap failed for ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
          failedNames.add(name!);
        }
      })
    );

    const isField = kind === "field";
    return {
      members: members.map((member) => {
        const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
        const remappedName = memberKeyToRemapped.get(memberKey) ?? member.name;
        const remappedOwner = ownerToRemapped.get(member.ownerFqn) ?? member.ownerFqn;
        const remappedDescriptor = memberDescriptorRemapped.get(memberKey)
          ?? remapJvmDescriptor(member.jvmDescriptor, classMap);
        return {
          ...member,
          name: remappedName,
          ownerFqn: remappedOwner,
          jvmDescriptor: remappedDescriptor,
          javaSignature: rebuildJavaSignature(
            { name: remappedName, ownerFqn: remappedOwner, accessFlags: member.accessFlags },
            remappedDescriptor,
            isField
          )
        };
      }),
      failedNames
    };
  }

  private fallbackArtifactSignature(artifactId: string): string {
    return createHash("sha256").update(artifactId).digest("hex");
  }

  private resolveIndexRebuildReason(input: {
    force: boolean;
    expectedSignature: string;
    hasFiles: boolean;
    meta: ArtifactIndexMetaRow | undefined;
  }): IndexRebuildReason {
    if (input.force) {
      return "force";
    }
    if (!input.hasFiles || !input.meta) {
      return "missing_meta";
    }
    if (input.meta.indexSchemaVersion !== INDEX_SCHEMA_VERSION) {
      return "schema_mismatch";
    }
    if (input.meta.artifactSignature !== input.expectedSignature) {
      return "signature_mismatch";
    }
    return "already_current";
  }

  private toResolvedArtifact(artifact: ArtifactRow): ResolvedSourceArtifact {
    return {
      artifactId: artifact.artifactId,
      artifactAlias: artifact.alias,
      artifactSignature: artifact.artifactSignature ?? this.fallbackArtifactSignature(artifact.artifactId),
      origin: artifact.origin,
      binaryJarPath: artifact.binaryJarPath,
      sourceJarPath: artifact.sourceJarPath,
      coordinate: artifact.coordinate,
      version: artifact.version,
      requestedMapping: artifact.requestedMapping,
      mappingApplied: artifact.mappingApplied,
      repoUrl: artifact.repoUrl,
      provenance: artifact.provenance,
      qualityFlags: artifact.qualityFlags,
      isDecompiled: artifact.isDecompiled,
      resolvedAt: new Date().toISOString()
    };
  }

  private async rebuildAndPersistArtifactIndex(
    resolved: ResolvedSourceArtifact,
    reason: Exclude<IndexRebuildReason, "already_current">
  ): Promise<RebuiltArtifactData> {
    const rebuilt = await this.buildRebuiltArtifactData(resolved);
    const timestamp = new Date().toISOString();
    const chunkSize = Math.max(1, this.config.indexInsertChunkSize ?? 200);

    const tx = this.db.transaction(() => {
      this.artifactsRepo.upsertArtifact({
        artifactId: resolved.artifactId,
        alias: resolved.artifactAlias,
        origin: resolved.origin,
        coordinate: resolved.coordinate,
        version: resolved.version,
        binaryJarPath: resolved.binaryJarPath,
        sourceJarPath: resolved.sourceJarPath,
        repoUrl: resolved.repoUrl,
        requestedMapping: resolved.requestedMapping,
        mappingApplied: resolved.mappingApplied,
        provenance: resolved.provenance,
        qualityFlags: resolved.qualityFlags,
        artifactSignature: resolved.artifactSignature,
        isDecompiled: resolved.isDecompiled,
        timestamp
      });
      this.filesRepo.clearFilesForArtifact(resolved.artifactId);
      for (const chunk of chunkArray(rebuilt.files, chunkSize)) {
        this.filesRepo.insertFilesForArtifact(resolved.artifactId, chunk);
      }
      this.symbolsRepo.clearSymbolsForArtifact(resolved.artifactId);
      for (const chunk of chunkArray(rebuilt.symbols, chunkSize)) {
        this.symbolsRepo.insertSymbolsForArtifact(resolved.artifactId, chunk);
      }
      this.indexMetaRepo.upsert({
        artifactId: resolved.artifactId,
        artifactSignature: resolved.artifactSignature,
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        filesCount: rebuilt.files.length,
        symbolsCount: rebuilt.symbols.length,
        ftsRowsCount: rebuilt.files.length,
        indexedAt: rebuilt.indexedAt,
        indexDurationMs: rebuilt.indexDurationMs
      });
    });
    tx();
    this.upsertCacheMetrics(resolved.artifactId, rebuilt.totalContentBytes, timestamp);

    log("info", "index.rebuild.done", {
      artifactId: resolved.artifactId,
      reason,
      files: rebuilt.files.length,
      symbols: rebuilt.symbols.length,
      indexDurationMs: rebuilt.indexDurationMs
    });

    return rebuilt;
  }

  private async buildRebuiltArtifactData(resolved: ResolvedSourceArtifact): Promise<RebuiltArtifactData> {
    const indexStartedAt = Date.now();
    let files: IndexedFileRecord[] = [];
    if (resolved.sourceJarPath) {
      files = await this.loadFromSourceJar(resolved.sourceJarPath);
    } else if (resolved.binaryJarPath) {
      const decompileInputJarPath = await this.maybeRemapBinaryForMojang(resolved);
      // When the binary jar was remapped from obfuscated to mojang, swap the resolved
      // artifact's binaryJarPath to the remapped jar so downstream bytecode consumers
      // (getClassMembers, validateMixin) look up mojang names in the mojang jar — not
      // the original obfuscated jar. Persistence in upsertArtifact happens after this
      // function returns, so the swap reaches both the database row and the
      // resolveArtifact response.
      if (decompileInputJarPath !== resolved.binaryJarPath) {
        resolved.binaryJarPath = decompileInputJarPath;
      }
      const vineflowerPath = await resolveVineflowerJar(
        this.config.cacheDir,
        this.config.vineflowerJarPath
      );
      const decompileStartedAt = Date.now();
      try {
        const decompileResult = await decompileBinaryJar(decompileInputJarPath, this.config.cacheDir, {
          vineflowerJarPath: vineflowerPath,
          artifactIdCandidate: resolved.artifactId,
          timeoutMs: 120_000,
          signature: resolved.artifactId
        });
        files = decompileResult.javaFiles.map((entry) => ({
          filePath: normalizePathStyle(entry.filePath),
          content: entry.content,
          contentBytes: Buffer.byteLength(entry.content, "utf8"),
          contentHash: createHash("sha256").update(entry.content).digest("hex")
        }));
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.DECOMPILER_FAILED) {
          throw createError({
            code: ERROR_CODES.DECOMPILER_FAILED,
            message: caughtError.message,
            details: {
              ...(caughtError.details ?? {}),
              artifactId: resolved.artifactId,
              binaryJarPath: resolved.binaryJarPath,
              producedJavaCount:
                typeof (caughtError.details as Record<string, unknown> | undefined)?.producedJavaCount === "number"
                  ? (caughtError.details as Record<string, unknown>).producedJavaCount
                  : 0,
              nextAction:
                "Verify Java runtime and Vineflower availability, then retry. If available, prefer source-backed artifacts.",
              recommendedCommand: "echo $MCP_VINEFLOWER_JAR_PATH"
            }
          });
        }
        throw caughtError;
      } finally {
        this.metrics.recordDuration("decompile_duration_ms", Date.now() - decompileStartedAt);
      }
    } else {
      throw createError({
        code: ERROR_CODES.SOURCE_NOT_FOUND,
        message: "No source artifact available.",
        details: {
          artifactId: resolved.artifactId,
          nextAction: "Use list-artifact-files to inspect the artifact's contents.",
          suggestedCall: { tool: "list-artifact-files", params: { artifactId: resolved.artifactId } }
        }
      });
    }

    const symbols: RebuiltArtifactData["symbols"] = [];
    for (const file of files) {
      const extracted = extractSymbolsFromSource(file.filePath, file.content);
      for (const symbol of extracted) {
        symbols.push({
          filePath: file.filePath,
          ...symbol
        });
      }
    }

    return {
      files,
      symbols,
      indexedAt: new Date().toISOString(),
      indexDurationMs: Date.now() - indexStartedAt,
      totalContentBytes: files.reduce((sum, file) => sum + file.contentBytes, 0)
    };
  }

  getArtifact(artifactId: string): ArtifactRow {
    if (artifactId.includes("..") || artifactId.includes("/")) {
      // intentionally reject suspicious IDs that are not artifact hashes
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId contains invalid characters.",
        details: { artifactId }
      });
    }
    const artifact = this.artifactsRepo.getArtifact(artifactId);
    if (!artifact) {
      throw createError({
        code: ERROR_CODES.SOURCE_NOT_FOUND,
        message: "Artifact not found. Resolve context first.",
        details: {
          artifactId,
          nextAction: "Use resolve-artifact to resolve a source artifact first.",
          suggestedCall: {
            tool: "resolve-artifact",
            params: buildResolveArtifactParams({ kind: "version", value: "latest" })
          }
        }
      });
    }

    return artifact;
  }

  private async ingestIfNeeded(resolved: ResolvedSourceArtifact): Promise<void> {
    const existing = this.artifactsRepo.getArtifact(resolved.artifactId);
    const hasFiles = this.hasAnyFiles(resolved.artifactId);
    const meta = this.indexMetaRepo.get(resolved.artifactId);
    const reason = this.resolveIndexRebuildReason({
      force: false,
      expectedSignature: resolved.artifactSignature,
      hasFiles,
      meta
    });

    if (existing && reason === "already_current") {
      // Mojang binary-remap reconciliation on the warm cache hit path:
      // resolveSourceTargetInternal always returns the original binary jar
      // (resolver does not know about prior remap output), so without this
      // step a warm-cache resolve would return mappingApplied="mojang"
      // alongside binaryJarPath pointing at the obfuscated client jar.
      // maybeRemapBinaryForMojang short-circuits on a healthy cache hit
      // (existsSync + ZIP magic) and re-remaps when the cache is missing
      // or corrupted, so this also recovers from out-of-band cache loss.
      const transformChain = resolved.provenance?.transformChain ?? [];
      if (transformChain.includes("binary-remap:obf->mojang") && resolved.binaryJarPath) {
        const reconciledBinaryJarPath = await this.maybeRemapBinaryForMojang(resolved);
        if (reconciledBinaryJarPath !== resolved.binaryJarPath) {
          resolved.binaryJarPath = reconciledBinaryJarPath;
        }
      }
      // Backfill / rotate alias on the warm-cache path. Without this, schema-v4
      // migrated rows (alias=NULL) and rows whose alias parameters changed since
      // the last upsert would return an artifactAlias from resolveArtifact that
      // does not resolve back via getArtifact(alias), breaking the 3.1b lookup
      // contract. UNIQUE conflicts here are caller bugs (two distinct artifactIds
      // colliding on alias) and surface as DB errors rather than silent drift.
      if (resolved.artifactAlias && existing.alias !== resolved.artifactAlias) {
        this.artifactsRepo.setAlias(resolved.artifactId, resolved.artifactAlias);
      }
      this.metrics.recordArtifactCacheHit();
      const touchedAt = new Date().toISOString();
      this.artifactsRepo.touchArtifact(resolved.artifactId, touchedAt);
      this.touchCacheMetrics(resolved.artifactId, touchedAt);
      return;
    }

    this.metrics.recordArtifactCacheMiss();
    this.metrics.recordReindex();
    log("info", "index.rebuild.start", {
      artifactId: resolved.artifactId,
      reason
    });

    await this.rebuildAndPersistArtifactIndex(
      resolved,
      reason === "already_current" ? "missing_meta" : reason
    );
    this.enforceCacheLimits();
  }

  /**
   * If the resolved artifact's transformChain promised an "obf -> mojang"
   * binary remap, run tiny-remapper now and return the remapped jar path.
   * Otherwise return the original binaryJarPath unchanged.
   *
   * Cache safety: writes to a per-attempt temp file then atomic-renames into
   * <cacheDir>/remapped/<artifactId>.jar. A per-target inflight Promise map
   * collapses concurrent calls so two simultaneous resolveArtifact calls for
   * the same artifactId share one tiny-remapper run instead of racing on the
   * same output path.
   */
  private async maybeRemapBinaryForMojang(resolved: ResolvedSourceArtifact): Promise<string> {
    const binaryJarPath = resolved.binaryJarPath;
    if (!binaryJarPath) {
      throw createError({
        code: ERROR_CODES.SOURCE_NOT_FOUND,
        message: "Cannot run binary remap: resolved artifact has no binary jar path.",
        details: { artifactId: resolved.artifactId }
      });
    }
    const transformChain = resolved.provenance?.transformChain ?? [];
    if (!transformChain.includes("binary-remap:obf->mojang")) {
      return binaryJarPath;
    }
    if (!resolved.version) {
      throw createError({
        code: ERROR_CODES.MAPPING_NOT_APPLIED,
        message: "Binary remap promised but artifact has no resolved Minecraft version.",
        details: {
          artifactId: resolved.artifactId,
          binaryJarPath,
          nextAction: "Use target.kind=\"version\" so the remap pipeline can locate Mojang mappings."
        }
      });
    }

    const remappedDir = join(this.config.cacheDir, "remapped");
    const remappedJarPath = join(remappedDir, `${resolved.artifactId}.jar`);
    if (existsSync(remappedJarPath)) {
      // Validate the cached jar is at least structurally a ZIP (`PK\x03\x04`) and
      // non-empty before reusing. If a prior atomic-rename window was interrupted
      // or the cache file was hand-edited, drop it and re-remap rather than
      // silently feeding a corrupt jar into Vineflower.
      if (await this.isUsableJarFile(remappedJarPath)) {
        await this.recordRemappedJarBytesFromDisk(resolved.artifactId, remappedJarPath);
        return remappedJarPath;
      }
      log("warn", "binary-remap.cache.evict-corrupt", {
        artifactId: resolved.artifactId,
        remappedJarPath
      });
      try {
        await unlink(remappedJarPath);
      } catch {
        // ignore: race with another process or already-deleted file.
      }
      this.releaseRemappedJarBytes(resolved.artifactId);
    }

    const inflight = this.inflightRemaps.get(remappedJarPath);
    if (inflight) {
      return inflight;
    }

    const remapPromise = this.runBinaryRemap({
      version: resolved.version,
      inputJar: binaryJarPath,
      remappedDir,
      remappedJarPath
    });
    this.inflightRemaps.set(remappedJarPath, remapPromise);
    try {
      const path = await remapPromise;
      await this.recordRemappedJarBytesFromDisk(resolved.artifactId, path);
      return path;
    } finally {
      this.inflightRemaps.delete(remappedJarPath);
    }
  }

  private async recordRemappedJarBytesFromDisk(artifactId: string, path: string): Promise<void> {
    try {
      const fileStat = await stat(path);
      this.recordRemappedJarBytes(artifactId, fileStat.size);
    } catch {
      // best-effort: accounting will be rebuilt on the next refreshCacheMetrics.
    }
  }

  /**
   * Best-effort structural check that `path` is a non-empty file beginning with
   * the ZIP local-file-header magic (`50 4B 03 04`). Used to drop partial /
   * corrupt remap-cache entries before they reach Vineflower. False positives
   * are acceptable (Vineflower will surface a clearer error); false negatives
   * are not (a corrupt cache hit must be evicted).
   */
  private async isUsableJarFile(path: string): Promise<boolean> {
    try {
      const stats = await stat(path);
      if (!stats.isFile() || stats.size < 4) {
        return false;
      }
    } catch {
      return false;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      return bytesRead === 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async runBinaryRemap(input: {
    version: string;
    inputJar: string;
    remappedDir: string;
    remappedJarPath: string;
  }): Promise<string> {
    const tinyRemapperJarPath = await resolveTinyRemapperJar(
      this.config.cacheDir,
      this.config.tinyRemapperJarPath
    );
    const mojangTiny = await resolveMojangTinyFile(input.version, this.config);

    await mkdir(input.remappedDir, { recursive: true });

    const tempPath = `${input.remappedJarPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const remapStartedAt = Date.now();
    try {
      await remapJar(tinyRemapperJarPath, {
        inputJar: input.inputJar,
        outputJar: tempPath,
        mappingsFile: mojangTiny.path,
        fromNamespace: "obfuscated",
        toNamespace: "mojang",
        timeoutMs: this.config.remapTimeoutMs,
        maxMemoryMb: this.config.remapMaxMemoryMb
      });
      const tempStats = await stat(tempPath);
      if (tempStats.size === 0) {
        throw createError({
          code: ERROR_CODES.REMAP_FAILED,
          message: "tiny-remapper produced an empty output jar.",
          details: { inputJar: input.inputJar, tempPath }
        });
      }
      await rename(tempPath, input.remappedJarPath);
      return input.remappedJarPath;
    } catch (caughtError) {
      try {
        await unlink(tempPath);
      } catch {
        // tempPath may not exist if remapJar failed before writing anything; ignore.
      }
      throw caughtError;
    } finally {
      this.metrics.recordDuration("binary_remap_duration_ms", Date.now() - remapStartedAt);
    }
  }

  private async loadFromSourceJar(sourceJarPath: string): Promise<IndexedFileRecord[]> {
    const files: IndexedFileRecord[] = [];
    for await (const entry of iterateJavaEntriesAsUtf8(sourceJarPath, this.config.maxContentBytes)) {
      files.push({
        filePath: normalizePathStyle(entry.filePath),
        content: entry.content,
        contentBytes: Buffer.byteLength(entry.content, "utf8"),
        contentHash: createHash("sha256").update(entry.content).digest("hex")
      });
    }

    return files;
  }

  private hasAnyFiles(artifactId: string): boolean {
    return this.filesRepo.listFiles(artifactId, { limit: 1 }).items.length > 0;
  }

  /**
   * Best-effort cleanup of `<cacheDir>/remapped/<artifactId>.jar` written by
   * `maybeRemapBinaryForMojang`. Called from cache-eviction paths so the
   * Mojang-remapped binary jar does not outlive the artifact row that owns it.
   * Also releases the jar's bytes from `cacheTotalContentBytes`. Errors are
   * swallowed: orphaned jars remain visible to `manage-cache` under the
   * `binary-remap` cache kind and can be reclaimed there.
   */
  private unlinkRemappedJarForArtifact(artifactId: string): void {
    this.releaseRemappedJarBytes(artifactId);
    const remappedJarPath = join(this.config.cacheDir, "remapped", `${artifactId}.jar`);
    try {
      if (existsSync(remappedJarPath)) {
        unlinkSync(remappedJarPath);
      }
    } catch {
      // ignore: orphaned jar is still reclaimable via manage-cache binary-remap kind.
    }
  }

  /**
   * Add the remapped jar's on-disk size to `cacheTotalContentBytes` so the
   * `enforceCacheLimits` byte gate sees the jar before deciding to evict.
   * Without this, a Mojang-remapped client jar (tens of MB) can accumulate
   * silently while the indexed-source byte total stays below `maxCacheBytes`.
   */
  private recordRemappedJarBytes(artifactId: string, sizeBytes: number): void {
    const normalized = Math.max(0, Math.trunc(sizeBytes));
    const existing = this.remappedJarBytes.get(artifactId) ?? 0;
    this.cacheTotalContentBytes = Math.max(
      0,
      this.cacheTotalContentBytes - existing + normalized
    );
    this.remappedJarBytes.set(artifactId, normalized);
    this.publishCacheMetrics();
  }

  private releaseRemappedJarBytes(artifactId: string): void {
    const existing = this.remappedJarBytes.get(artifactId);
    if (!existing) {
      return;
    }
    this.cacheTotalContentBytes = Math.max(0, this.cacheTotalContentBytes - existing);
    this.remappedJarBytes.delete(artifactId);
    this.publishCacheMetrics();
  }

  private enforceCacheLimits(): void {
    let artifactCount = this.lru.size;
    let totalBytes = this.cacheTotalContentBytes;
    if (artifactCount <= this.config.maxArtifacts && totalBytes <= this.config.maxCacheBytes) {
      return;
    }

    const candidates = this.lru.toArray();
    for (const candidate of candidates) {
      const shouldEvict = artifactCount > this.config.maxArtifacts || totalBytes > this.config.maxCacheBytes;
      if (!shouldEvict || artifactCount <= 1) {
        break;
      }

      const artifactCountBefore = artifactCount;
      const totalBytesBefore = totalBytes;
      const remappedBytesForCandidate = this.remappedJarBytes.get(candidate.key) ?? 0;
      this.filesRepo.deleteFilesForArtifact(candidate.key);
      this.artifactsRepo.deleteArtifact(candidate.key);
      this.unlinkRemappedJarForArtifact(candidate.key);
      this.removeCacheMetrics(candidate.key, false);
      artifactCount = Math.max(0, artifactCount - 1);
      totalBytes = Math.max(
        0,
        totalBytes - candidate.value.totalContentBytes - remappedBytesForCandidate
      );
      this.metrics.recordCacheEviction();
      log("warn", "cache.evict", {
        artifactId: candidate.key,
        artifactCountBefore,
        totalBytesBefore,
        artifactBytes: candidate.value.totalContentBytes + remappedBytesForCandidate
      });
    }

    this.publishCacheMetrics();
  }

  private refreshCacheMetrics(): void {
    const cacheEntries = this.artifactsRepo.countArtifacts();
    const totalContentBytes = this.artifactsRepo.totalContentBytes();
    const lruAccounting = this.artifactsRepo.listArtifactsByLruWithContentBytes(Math.max(cacheEntries, 1));

    this.lru.clear();
    for (const row of lruAccounting) {
      this.lru.upsert(row.artifactId, {
        totalContentBytes: row.totalContentBytes,
        updatedAt: row.updatedAt
      });
    }
    this.remappedJarBytes.clear();
    let remappedTotal = 0;
    const remappedDir = join(this.config.cacheDir, "remapped");
    if (existsSync(remappedDir)) {
      // Only count remapped jars whose owning artifact is still in the LRU set.
      // Orphaned jars (artifact deleted, prior unlink lost a race, externally
      // placed) stay visible to manage-cache under the `binary-remap` kind
      // for prune, but must not be folded into `cacheTotalContentBytes` here:
      // enforceCacheLimits cannot evict them, so counting their bytes would
      // force unrelated live artifacts to be evicted to chase orphan bytes.
      const liveArtifactIds = new Set(this.lru.toArray().map((entry) => entry.key));
      try {
        for (const entry of readdirSync(remappedDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".jar")) {
            continue;
          }
          const artifactId = entry.name.slice(0, -".jar".length);
          if (!liveArtifactIds.has(artifactId)) {
            continue;
          }
          try {
            const fileStat = statSync(join(remappedDir, entry.name));
            const size = Math.max(0, Math.trunc(fileStat.size));
            this.remappedJarBytes.set(artifactId, size);
            remappedTotal += size;
          } catch {
            // ignore stat failure on a single jar; total stays best-effort.
          }
        }
      } catch {
        // ignore listing failure; remapped accounting stays empty until next remap.
      }
    }
    this.cacheTotalContentBytes = totalContentBytes + remappedTotal;
    this.publishCacheMetrics();
  }

  private touchCacheMetrics(artifactId: string, updatedAt: string): void {
    const entry = this.lru.touch(artifactId);
    if (!entry) {
      this.refreshCacheMetrics();
      return;
    }
    entry.updatedAt = updatedAt;
    this.publishCacheMetrics();
  }

  private upsertCacheMetrics(artifactId: string, totalContentBytes: number, updatedAt: string): void {
    const normalizedBytes = Math.max(0, Math.trunc(totalContentBytes));
    const existing = this.lru.remove(artifactId);
    if (existing) {
      this.cacheTotalContentBytes = Math.max(
        0,
        this.cacheTotalContentBytes - existing.totalContentBytes + normalizedBytes
      );
    } else {
      this.cacheTotalContentBytes += normalizedBytes;
    }
    this.lru.upsert(artifactId, { totalContentBytes: normalizedBytes, updatedAt });
    this.publishCacheMetrics();
  }

  private removeCacheMetrics(artifactId: string, publish = true): void {
    const existing = this.lru.remove(artifactId);
    if (!existing) {
      this.refreshCacheMetrics();
      return;
    }
    this.cacheTotalContentBytes = Math.max(0, this.cacheTotalContentBytes - existing.totalContentBytes);
    if (publish) {
      this.publishCacheMetrics();
    }
  }

  private publishCacheMetrics(): void {
    this.metrics.setCacheEntries(this.lru.size);
    this.metrics.setCacheTotalContentBytes(this.cacheTotalContentBytes);
  }

  private snapshotLruAccounting(): void {
    this.metrics.setCacheArtifactByteAccountingRef(
      this.lru.toArray().map(({ key, value }) => ({
        artifactId: key,
        totalContentBytes: value.totalContentBytes,
        updatedAt: value.updatedAt
      }))
    );
  }
}

function remapJvmDescriptor(descriptor: string, classMap: Map<string, string>): string {
  if (classMap.size === 0) {
    return descriptor;
  }
  return descriptor.replace(/L([^;]+);/g, (match, ref: string) => {
    const dotFqn = ref.replace(/\//g, ".");
    const remapped = classMap.get(dotFqn);
    return remapped ? `L${remapped.replace(/\./g, "/")};` : match;
  });
}

function rebuildJavaSignature(
  member: { name: string; ownerFqn: string; accessFlags: number },
  remappedDescriptor: string,
  isField: boolean
): string {
  const modifiers = modifierPrefix(member.accessFlags, isField ? "field" : "method");
  const prefix = modifiers ? `${modifiers} ` : "";
  if (isField) {
    try {
      const { type } = parseFieldType(remappedDescriptor, 0, { allowVoid: false });
      return `${prefix}${type} ${member.name}`.trim();
    } catch {
      return `${prefix}${member.name}`.trim();
    }
  }
  try {
    const { args, returnType } = parseMethodDescriptor(remappedDescriptor);
    const argStr = args.join(", ");
    if (member.name === "<init>") {
      const ownerSimple = member.ownerFqn.split(".").pop()!;
      return `${prefix}${ownerSimple}(${argStr})`.trim();
    }
    return `${prefix}${returnType} ${member.name}(${argStr})`.trim();
  } catch {
    return `${prefix}${member.name}`.trim();
  }
}
