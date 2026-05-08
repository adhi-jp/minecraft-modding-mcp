import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import fastGlob from "fast-glob";

import { buildSuggestedCall } from "./build-suggested-call.js";
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
  type ResponseContext as ExplorerResponseContext,
  type SignatureMember
} from "./minecraft-explorer-service.js";
import { rebuildJavaSignature, remapJvmDescriptor } from "./source/descriptor-utils.js";
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
import { SourceServiceState } from "./source/state.js";
import * as cacheMetrics from "./source/cache-metrics.js";
import * as indexer from "./source/indexer.js";
import * as search from "./source/search.js";
import * as classSourceHelpers from "./source/class-source-helpers.js";
import * as lifecycle from "./source/lifecycle.js";
import * as workspaceTarget from "./source/workspace-target.js";
import * as accessValidate from "./source/access-validate.js";
import * as validateMixinModule from "./source/validate-mixin.js";
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
  isSafeMavenVersionToken,
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

const MEMBERS_STATUS_LEGACY = process.env.MEMBERS_STATUS_LEGACY === "1";

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

type MappingFallbackSuggestion = {
  suggestedCall?: { tool: string; params: Record<string, unknown> };
  exampleCalls?: Array<{ tool: string; params: Record<string, unknown>; reason: string }>;
  _suggestedCallPrimaryDropped?: true;
  nextAction: string;
};

export type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
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

export type GetClassMembersStatus = "ok" | "members_unavailable" | "partial";

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
  status?: GetClassMembersStatus;
  unavailableReason?: string;
  suggestedCall?: { tool: string; params: Record<string, unknown> };
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

export type DiffClassChange = "added" | "removed" | "present_in_both" | "absent_in_both";

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

/* IndexRebuildReason, IndexArtifactInput, IndexArtifactOutput moved to src/source/indexer.ts */
export type { IndexArtifactInput, IndexArtifactOutput } from "./source/indexer.js";

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

/* IndexedFileRecord, RebuiltArtifactData, INDEX_SCHEMA_VERSION moved to src/source/indexer.ts */

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

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
      ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
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
  readonly config: Config;
  readonly db;
  readonly artifactsRepo: ArtifactsRepo;
  readonly filesRepo: FilesRepo;
  readonly indexMetaRepo: IndexMetaRepo;
  readonly symbolsRepo: SymbolsRepo;
  readonly metrics: RuntimeMetrics;
  readonly versionService: VersionService;
  readonly mappingService: MappingService;
  readonly workspaceMappingService: WorkspaceMappingService;
  readonly workspaceContextCache: WorkspaceContextCache;
  readonly explorerService: MinecraftExplorerService;
  readonly registryService: RegistryService;
  readonly versionDiffService: VersionDiffService;
  readonly modDecompileService: ModDecompileService;
  readonly modSearchService: ModSearchService;
  readonly state = new SourceServiceState();

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

  async resolveAccessWidenerRuntimeArtifact(input: {
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
          ...buildSuggestedCall({
            tool: "validate-access-widener",
            params: {
              version,
              scope: requestedScope,
              ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {})
            }
          })
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

  async resolveAccessTransformerNamespace(input: {
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

  async resolveAccessTransformerRuntimeArtifact(input: {
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

  buildArtifactContentsSummary(input: {
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
  }): Promise<MappingFallbackSuggestion> {
    const { input, kind, value, scope, effectiveMapping } = args;
    const isVanillaMojang = scope === "vanilla" && effectiveMapping === "mojang";

    if (process.env.WORKSPACE_FALLBACK_LEGACY === "1") {
      return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: input.projectPath });
    }

    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: undefined });
    }

    if (kind !== "version") {
      return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
    }

    const cached = this.workspaceContextCache.read(projectPath);
    if (
      cached &&
      !cached.partial &&
      cached.compileMapping &&
      cached.compileMapping !== "obfuscated" &&
      cached.minecraftVersion === value
    ) {
      return {
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: {
            target: { kind: "workspace" },
            projectPath,
            mapping: cached.compileMapping
          }
        }),
        nextAction: `Workspace at ${projectPath} maps as ${cached.compileMapping}. Retry with target.kind="workspace" to use the project's compile mapping.`
      };
    }

    if (!cached) {
      try {
        const detectedVersion = await this.workspaceMappingService.detectProjectMinecraftVersion(projectPath);
        if (!detectedVersion || detectedVersion !== value) {
          return this.buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
        }
        const detection = await this.workspaceMappingService.detectCompileMapping({ projectPath });
        if (detection.resolved && detection.mappingApplied && detection.mappingApplied !== "obfuscated") {
          const partial: WorkspaceContext = {
            projectPath,
            minecraftVersion: detectedVersion,
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
            ...buildSuggestedCall({
              tool: "resolve-artifact",
              params: {
                target: { kind: "workspace" },
                projectPath,
                mapping: detection.mappingApplied
              }
            }),
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
  }): MappingFallbackSuggestion {
    const { kind, value, scope, isVanillaMojang, projectPath } = args;
    if (isVanillaMojang && projectPath) {
      return {
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: buildResolveArtifactParams(
            { kind, value },
            { mapping: "mojang", scope: "merged", projectPath }
          )
        }),
        nextAction:
          "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
          "Retry with scope=merged to allow source-jar resolution from the project cache."
      };
    }
    if (isVanillaMojang) {
      return {
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: buildResolveArtifactParams(
            { kind, value },
            { mapping: "obfuscated", scope: "vanilla" }
          )
        }),
        nextAction:
          "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
          "Without a projectPath, use mapping=obfuscated to read vanilla runtime names directly."
      };
    }
    return {
      ...buildSuggestedCall({
        tool: "resolve-artifact",
        params: buildResolveArtifactParams(
          { kind, value },
          { mapping: "obfuscated", ...(scope ? { scope } : {}) }
        )
      }),
      nextAction: "Retry with mapping=obfuscated to use the runtime obfuscated namespace."
    };
  }

  private async loadOrDetectWorkspaceContext(projectPath: string): Promise<WorkspaceContext> {
    return workspaceTarget.loadOrDetectWorkspaceContext(this, projectPath);
  }

  private async synthesizeWorkspaceTarget(
    input: ResolveArtifactInput,
    workspace: WorkspaceTargetInput
  ): ReturnType<typeof workspaceTarget.synthesizeWorkspaceTarget> {
    return workspaceTarget.synthesizeWorkspaceTarget(this, input, workspace);
  }

  private async synthesizeDependencyTarget(
    input: ResolveArtifactInput,
    dep: DependencyTargetInput
  ): ReturnType<typeof workspaceTarget.synthesizeDependencyTarget> {
    return workspaceTarget.synthesizeDependencyTarget(this, input, dep);
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
        if (
          dependencyOrigin &&
          isAppError(caughtError) &&
          caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED
        ) {
          mappingDecision = {
            mappingApplied: "obfuscated",
            transformChain: [],
            qualityFlags: [
              ...(resolved.qualityFlags ?? []),
              "dependency-mapping-unverified"
            ]
          };
        } else if (isAppError(caughtError) && caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED) {
          const fallback = await this.buildMappingFallbackSuggestedCall({
            input,
            kind,
            value,
            scope,
            effectiveMapping
          });
          const { nextAction, ...fallbackGated } = fallback;
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
              ...fallbackGated
            }
          });
        }
        throw caughtError;
      }
      const additionalTransformChain: string[] = [];
      if (!dependencyOrigin && (effectiveMapping === "intermediary" || effectiveMapping === "yarn")) {
        if (!resolved.version) {
          throw createError({
            code: ERROR_CODES.MAPPING_NOT_APPLIED,
            message: `Requested ${effectiveMapping} mapping cannot be guaranteed because artifact version is unknown.`,
            details: {
              mapping: effectiveMapping,
              target: { kind, value },
              nextAction:
                "Use target: { kind: \"version\", value } or a versioned Maven coordinate so mapping artifacts can be resolved.",
              ...buildSuggestedCall({
                tool: "resolve-artifact",
                params: buildResolveArtifactParams(
                  { kind: "version", value },
                  { ...(scope ? { scope } : {}) }
                )
              })
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
      if (dependencyOrigin && dependencyRequestedMapping && dependencyRequestedMapping !== "obfuscated") {
        const coord = resolved.coordinate ?? value;
        warnings.push(
          `Dependency artifact ${coord} mapping "${dependencyRequestedMapping}" is not enforced (binary remap is disabled for non-vanilla artifacts); the JAR is returned in its native namespace and mappingApplied is reported as "obfuscated" with qualityFlag "dependency-mapping-unverified". Caller must validate symbol availability.`
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
                ...buildSuggestedCall({
                  tool: "resolve-artifact",
                  params: buildResolveArtifactParams({ kind: "version", value }, { strictVersion: false })
                })
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
    return search.searchClassSource(this, input);
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
    return lifecycle.checkSymbolExistsInUnobfuscatedRuntime(this, input, fallbackBase);
  }

  async traceSymbolLifecycle(input: TraceSymbolLifecycleInput): Promise<TraceSymbolLifecycleOutput> {
    return lifecycle.traceSymbolLifecycle(this, input);
  }

  async diffClassSignatures(input: DiffClassSignaturesInput): Promise<DiffClassSignaturesOutput> {
    return lifecycle.diffClassSignatures(this, input);
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

    let requestedMapping: SourceMapping = normalizeMapping(input.mapping);

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
      warnings.push(...resolved.warnings);
      requestedMapping = resolved.requestedMapping;
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
          ...buildSuggestedCall({
            tool: "resolve-artifact",
            params: buildResolveArtifactParams({ kind: "version", value: "latest" })
          })
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

    let signatureContext: ExplorerResponseContext;
    let signatureConstructors: SignatureMember[];
    let signatureFields: SignatureMember[];
    let signatureMethods: SignatureMember[];
    let binaryExtractionFailed = false;
    let binaryExtractionFailureReason: string | undefined;
    try {
      const signature = await this.explorerService.getSignature({
        fqn: lookupClassName,
        jarPath: binaryJarPath,
        access,
        includeSynthetic,
        includeInherited,
        memberPattern: requestedMapping === mappingApplied ? memberPattern : undefined
      });
      warnings.push(...signature.warnings);
      signatureContext = signature.context;
      signatureConstructors = signature.constructors;
      signatureFields = signature.fields;
      signatureMethods = signature.methods;
    } catch (error) {
      if (isAppError(error) && error.code === ERROR_CODES.CLASS_NOT_FOUND) {
        throw error;
      }
      binaryExtractionFailed = true;
      binaryExtractionFailureReason = error instanceof Error ? error.message : String(error);
      signatureContext = {
        minecraftVersion: version ?? "unknown",
        mappingType: "unknown",
        mappingNamespace: mappingApplied === "intermediary" ? "obfuscated" : mappingApplied,
        jarHash: "",
        generatedAt: new Date().toISOString()
      };
      signatureConstructors = [];
      signatureFields = [];
      signatureMethods = [];
    }

    let remappedConstructors =
      version != null
        ? (
            await this.remapSignatureMembers(
              signatureConstructors,
              "method",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signatureConstructors;
    let remappedFields =
      version != null
        ? (
            await this.remapSignatureMembers(
              signatureFields,
              "field",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signatureFields;
    let remappedMethods =
      version != null
        ? (
            await this.remapSignatureMembers(
              signatureMethods,
              "method",
              version,
              mappingApplied,
              requestedMapping,
              input.sourcePriority,
              warnings
            )
          ).members
        : signatureMethods;

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

    let statusFields: Pick<GetClassMembersOutput, "status" | "unavailableReason" | "suggestedCall"> = {};
    if (!MEMBERS_STATUS_LEGACY) {
      let status: GetClassMembersStatus;
      let unavailableReason: string | undefined;
      let suggestedCall: GetClassMembersOutput["suggestedCall"];
      if (counts.total > 0) {
        status = "ok";
      } else if (decompiledFallback) {
        status = "partial";
      } else if (binaryExtractionFailed) {
        status = "members_unavailable";
        unavailableReason =
          binaryExtractionFailureReason
          ?? `binary extraction failed for "${className}".`;
        suggestedCall = buildSuggestedCall({
          tool: "get-class-source",
          params: {
            target: { type: "artifact", artifactId },
            className,
            mode: "snippet",
            mapping: requestedMapping
          }
        }).suggestedCall;
      } else {
        status = "ok";
      }
      statusFields = {
        status,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(suggestedCall ? { suggestedCall } : {})
      };
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
      context: signatureContext,
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
      ...statusFields,
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
    return validateMixinModule.validateMixin(this, input, options);
  }

  async validateMixinSingle(input: validateMixinModule.ValidateMixinSingleInput): Promise<MixinValidationResult> {
    return validateMixinModule.validateMixinSingle(this, input);
  }

  async remapSignatureMembers(
    members: SignatureMember[],
    kind: "field" | "method",
    version: string,
    sourceMapping: SourceMapping,
    targetMapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[],
    projectPath?: string
  ): Promise<{ members: SignatureMember[]; failedNames: Set<string> }> {
    return lifecycle.remapSignatureMembers(this, members, kind, version, sourceMapping, targetMapping, sourcePriority, warnings, projectPath);
  }

  async validateAccessWidener(input: ValidateAccessWidenerInput): Promise<ValidateAccessWidenerOutput> {
    return accessValidate.validateAccessWidener(this, input);
  }

  async validateAccessTransformer(input: ValidateAccessTransformerInput): Promise<ValidateAccessTransformerOutput> {
    return accessValidate.validateAccessTransformer(this, input);
  }

  recordToolCall(tool: string, durationMs: number): void {
    this.metrics.recordToolCall(tool, durationMs);
  }

  getRuntimeMetrics(): RuntimeMetricSnapshot {
    this.snapshotLruAccounting();
    this.metrics.setMappingResolutionCacheStats(this.mappingService.resolutionCacheStats);
    return this.metrics.snapshot();
  }

  async indexArtifact(input: indexer.IndexArtifactInput): Promise<indexer.IndexArtifactOutput> {
    return indexer.indexArtifact(this, input);
  }

  private extractClassMetadata(filePath: string, content: string): string {
    return classSourceHelpers.extractClassMetadata(filePath, content);
  }

  private extractDecompiledMembers(
    className: string,
    filePath: string,
    content: string
  ): { constructors: DecompiledMember[]; fields: DecompiledMember[]; methods: DecompiledMember[] } {
    return classSourceHelpers.extractDecompiledMembers(className, filePath, content);
  }

  private computeLineBraceDepths(lines: string[]): number[] {
    return classSourceHelpers.computeLineBraceDepths(lines);
  }

  private computeBraceRange(
    lines: string[],
    symbols: Array<{ symbolKind: string; symbolName: string; line: number }>,
    simpleName: string
  ): { declarationLine: number; endLine: number } | undefined {
    return classSourceHelpers.computeBraceRange(lines, symbols, simpleName);
  }

  private scanBraceRange(
    lines: string[],
    declarationLine: number
  ): { declarationLine: number; endLine: number } {
    return classSourceHelpers.scanBraceRange(lines, declarationLine);
  }

  private computeNestedTypeRanges(
    lines: string[],
    symbols: Array<{ symbolKind: string; line: number }>,
    outerBody: { declarationLine: number; endLine: number }
  ): Array<{ declarationLine: number; endLine: number }> {
    return classSourceHelpers.computeNestedTypeRanges(lines, symbols, outerBody);
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

  async resolveClassNameForLookup(input: {
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
    let suggestionSpec: { tool: string; params: Record<string, unknown> } = {
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
        suggestionSpec = {
          tool: "get-class-api-matrix",
          params: {
            version: input.version,
            className: input.className,
            classNameMapping: input.requestedMapping
          }
        };
      } else {
        suggestionSpec = {
          tool: "find-class",
          params: { className: simpleName, artifactId: input.artifactId }
        };
      }
    }

    if (input.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(input.className)) {
      nextAction += ` ${obfuscatedNamespaceHint(input.className)}`;
    }

    details.nextAction = nextAction;
    Object.assign(details, buildSuggestedCall(suggestionSpec));

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
    lifecycle.rejectLifecycleClassLikeInput(this, input);
  }

  private releaseLifecycleMappingGraph(version: string, sourcePriority: MappingSourcePriority | undefined): void {
    lifecycle.releaseLifecycleMappingGraph(this, version, sourcePriority);
  }

  private async resolveToObfuscatedClassName(
    className: string,
    version: string,
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<string> {
    return lifecycle.resolveToObfuscatedClassName(this, className, version, mapping, sourcePriority, warnings);
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
    return lifecycle.resolveToObfuscatedMemberName(this, name, ownerInSourceMapping, descriptor, kind, version, mapping, sourcePriority, warnings);
  }

/* remapSignatureMembers moved earlier — public delegate enables test monkey-patching */

  private fallbackArtifactSignature(artifactId: string): string {
    return indexer.fallbackArtifactSignature(artifactId);
  }

  private resolveIndexRebuildReason(input: {
    force: boolean;
    expectedSignature: string;
    hasFiles: boolean;
    meta: ArtifactIndexMetaRow | undefined;
  }) {
    return indexer.resolveIndexRebuildReason(input);
  }

  private toResolvedArtifact(artifact: ArtifactRow): ResolvedSourceArtifact {
    return indexer.toResolvedArtifact(this, artifact);
  }

  private async rebuildAndPersistArtifactIndex(
    resolved: ResolvedSourceArtifact,
    reason: Exclude<indexer.IndexRebuildReason, "already_current">
  ): Promise<indexer.RebuiltArtifactData> {
    return indexer.rebuildAndPersistArtifactIndex(this, resolved, reason);
  }

  private async buildRebuiltArtifactData(resolved: ResolvedSourceArtifact): Promise<indexer.RebuiltArtifactData> {
    return indexer.buildRebuiltArtifactData(this, resolved);
  }

  getArtifact(artifactId: string): ArtifactRow {
    return indexer.getArtifact(this, artifactId);
  }

  private async ingestIfNeeded(resolved: ResolvedSourceArtifact): Promise<void> {
    return indexer.ingestIfNeeded(this, resolved);
  }

  private async maybeRemapBinaryForMojang(resolved: ResolvedSourceArtifact): Promise<string> {
    return indexer.maybeRemapBinaryForMojang(this, resolved);
  }

  private async recordRemappedJarBytesFromDisk(artifactId: string, path: string): Promise<void> {
    return indexer.recordRemappedJarBytesFromDisk(this, artifactId, path);
  }

  private async isUsableJarFile(path: string): Promise<boolean> {
    return indexer.isUsableJarFile(path);
  }

  private async runBinaryRemap(input: {
    version: string;
    inputJar: string;
    remappedDir: string;
    remappedJarPath: string;
  }): Promise<string> {
    return indexer.runBinaryRemap(this, input);
  }

  private async loadFromSourceJar(sourceJarPath: string): Promise<indexer.IndexedFileRecord[]> {
    return indexer.loadFromSourceJar(this, sourceJarPath);
  }

  private hasAnyFiles(artifactId: string): boolean {
    return cacheMetrics.hasAnyFiles(this, artifactId);
  }

  private unlinkRemappedJarForArtifact(artifactId: string): void {
    cacheMetrics.unlinkRemappedJarForArtifact(this, artifactId);
  }

  private recordRemappedJarBytes(artifactId: string, sizeBytes: number): void {
    cacheMetrics.recordRemappedJarBytes(this, artifactId, sizeBytes);
  }

  private releaseRemappedJarBytes(artifactId: string): void {
    cacheMetrics.releaseRemappedJarBytes(this, artifactId);
  }

  private enforceCacheLimits(): void {
    cacheMetrics.enforceCacheLimits(this);
  }

  private refreshCacheMetrics(): void {
    cacheMetrics.refreshCacheMetrics(this);
  }

  private touchCacheMetrics(artifactId: string, updatedAt: string): void {
    cacheMetrics.touchCacheMetrics(this, artifactId, updatedAt);
  }

  private upsertCacheMetrics(artifactId: string, totalContentBytes: number, updatedAt: string): void {
    cacheMetrics.upsertCacheMetrics(this, artifactId, totalContentBytes, updatedAt);
  }

  private removeCacheMetrics(artifactId: string, publish = true): void {
    cacheMetrics.removeCacheMetrics(this, artifactId, publish);
  }

  private publishCacheMetrics(): void {
    cacheMetrics.publishCacheMetrics(this);
  }

  private snapshotLruAccounting(): void {
    cacheMetrics.snapshotLruAccounting(this);
  }
}

/* descriptor utils extracted to src/source/descriptor-utils.ts */
