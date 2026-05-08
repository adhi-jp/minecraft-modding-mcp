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
import * as artifactResolver from "./source/artifact-resolver.js";
import * as classSource from "./source/class-source.js";
import * as symbolResolver from "./source/symbol-resolver.js";
import * as fileAccess from "./source/file-access.js";
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

  async resolveArtifact(input: ResolveArtifactInput): Promise<ResolveArtifactOutput> {
    return artifactResolver.resolveArtifact(this, input);
  }

  async synthesizeWorkspaceTarget(
    input: ResolveArtifactInput,
    workspace: import("./types.js").WorkspaceTargetInput
  ): ReturnType<typeof workspaceTarget.synthesizeWorkspaceTarget> {
    return workspaceTarget.synthesizeWorkspaceTarget(this, input, workspace);
  }

  async synthesizeDependencyTarget(
    input: ResolveArtifactInput,
    dep: import("./types.js").DependencyTargetInput
  ): ReturnType<typeof workspaceTarget.synthesizeDependencyTarget> {
    return workspaceTarget.synthesizeDependencyTarget(this, input, dep);
  }

  async loadOrDetectWorkspaceContext(projectPath: string): ReturnType<typeof workspaceTarget.loadOrDetectWorkspaceContext> {
    return workspaceTarget.loadOrDetectWorkspaceContext(this, projectPath);
  }

  async resolveAccessWidenerRuntimeArtifact(input: {
    version: string;
    awNamespace: SourceMapping;
    projectPath?: string;
    scope?: ArtifactScope;
    preferProjectVersion?: boolean;
  }): Promise<RuntimeValidationProvenance<SourceMapping>> {
    return artifactResolver.resolveAccessWidenerRuntimeArtifact(this, input);
  }

  async resolveAccessTransformerNamespace(input: {
    atNamespace?: AccessTransformerNamespace;
    projectPath?: string;
  }): Promise<AccessTransformerNamespace> {
    return artifactResolver.resolveAccessTransformerNamespace(this, input);
  }

  async resolveAccessTransformerRuntimeArtifact(input: {
    version: string;
    atNamespace: AccessTransformerNamespace;
    projectPath?: string;
    scope?: ArtifactScope;
    preferProjectVersion?: boolean;
  }): Promise<RuntimeValidationProvenance<AccessTransformerNamespace>> {
    return artifactResolver.resolveAccessTransformerRuntimeArtifact(this, input);
  }

  buildArtifactContentsSummary(input: {
    origin: ResolvedSourceArtifact["origin"];
    sourceJarPath?: string;
    isDecompiled?: boolean;
    qualityFlags: string[];
  }): ArtifactContentsSummary {
    return artifactResolver.buildArtifactContentsSummary(this, input);
  }

  async discoverVersionSourceJar(input: {
    version: string;
    projectPath?: string;
  }): ReturnType<typeof artifactResolver.discoverVersionSourceJar> {
    return artifactResolver.discoverVersionSourceJar(this, input);
  }

  async discoverAccessWidenerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    requestedScope: ArtifactScope;
  }): ReturnType<typeof artifactResolver.discoverAccessWidenerRuntimeCandidates> {
    return artifactResolver.discoverAccessWidenerRuntimeCandidates(this, input);
  }

  async discoverAccessTransformerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    requestedScope: ArtifactScope;
    atNamespace: AccessTransformerNamespace;
    loader: import("./workspace-mapping-service.js").WorkspaceProjectLoader | "unknown";
  }): ReturnType<typeof artifactResolver.discoverAccessTransformerRuntimeCandidates> {
    return artifactResolver.discoverAccessTransformerRuntimeCandidates(this, input);
  }

  async buildMappingFallbackSuggestedCall(args: {
    input: ResolveArtifactInput;
    kind: import("./types.js").ArtifactTargetKind;
    value: string;
    scope: ArtifactScope | undefined;
    effectiveMapping: SourceMapping;
  }): ReturnType<typeof artifactResolver.buildMappingFallbackSuggestedCall> {
    return artifactResolver.buildMappingFallbackSuggestedCall(this, args);
  }

  async searchClassSource(input: SearchClassSourceInput): Promise<SearchClassSourceOutput> {
    return search.searchClassSource(this, input);
  }

  async getArtifactFile(input: GetArtifactFileInput): Promise<GetArtifactFileOutput> {
    return fileAccess.getArtifactFile(this, input);
  }

  async listArtifactFiles(input: ListArtifactFilesInput): Promise<ListArtifactFilesOutput> {
    return fileAccess.listArtifactFiles(this, input);
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
    return symbolResolver.resolveWorkspaceSymbol(this, input);
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
    return classSource.findClass(this, input);
  }

  async getClassSource(input: GetClassSourceInput): Promise<GetClassSourceOutput> {
    return classSource.getClassSource(this, input);
  }

  async getClassMembers(input: GetClassMembersInput): Promise<GetClassMembersOutput> {
    return classSource.getClassMembers(this, input);
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

  async resolveClassNameForLookup(input: {
    className: string;
    version?: string;
    sourceMapping: SourceMapping;
    targetMapping: SourceMapping;
    sourcePriority: MappingSourcePriority | undefined;
    warnings: string[];
    context: string;
  }): Promise<string> {
    return classSource.resolveClassNameForLookup(this, input);
  }

  async resolveBinaryFallbackArtifact(input: {
    binaryJarPath?: string;
    version?: string;
    coordinate?: string;
    requestedMapping: SourceMapping;
    mappingApplied: SourceMapping;
    provenance?: ArtifactProvenance;
    qualityFlags: string[];
  }): Promise<ResolvedSourceArtifact | undefined> {
    return artifactResolver.resolveBinaryFallbackArtifact(this, input);
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

  async ingestIfNeeded(resolved: ResolvedSourceArtifact): Promise<void> {
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
