import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES, isAppError, type AppError } from "./errors.js";
import { loadConfig } from "./config.js";
import { decompileBinaryJar } from "./decompiler/vineflower.js";
import { resolveVineflowerJar } from "./vineflower-resolver.js";
import { parseCoordinate } from "./maven-resolver.js";
import {
  MinecraftExplorerService,
  type ResponseContext as ExplorerResponseContext,
  type SignatureMember
} from "./minecraft-explorer-service.js";
import { parseMixinSource } from "./mixin-parser.js";
import { parseAccessWidener } from "./access-widener-parser.js";
import {
  validateParsedMixin,
  validateParsedAccessWidener,
  type IssueConfidence,
  type ResolvedTargetMembers,
  type MixinValidationResult,
  type MixinValidationProvenance,
  type MappingHealthReport,
  type AccessWidenerValidationResult
} from "./mixin-validator.js";
import { resolveSourceTarget as resolveSourceTargetInternal } from "./source-resolver.js";
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
import { iterateJavaEntriesAsUtf8, listJavaEntries } from "./source-jar-reader.js";
import { openDatabase } from "./storage/db.js";
import { ArtifactsRepo } from "./storage/artifacts-repo.js";
import { FilesRepo } from "./storage/files-repo.js";
import { IndexMetaRepo, type ArtifactIndexMetaRow } from "./storage/index-meta-repo.js";
import { SymbolsRepo } from "./storage/symbols-repo.js";
import { RuntimeMetrics, type RuntimeMetricSnapshot } from "./observability.js";
import { log } from "./logger.js";
import { normalizePathForHost } from "./path-converter.js";
import {
  createSearchHitAccumulator,
  decodeSearchCursor,
  encodeSearchCursor
} from "./search-hit-accumulator.js";
import {
  WorkspaceMappingService,
  type WorkspaceCompileMappingOutput
} from "./workspace-mapping-service.js";
import type {
  ArtifactProvenance,
  ArtifactRow,
  ArtifactScope,
  Config,
  FileRow,
  MappingSourcePriority,
  ResolvedSourceArtifact,
  SourceMapping,
  SourceTargetInput,
  SymbolRow
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

export type ResolveArtifactInput = {
  target: SourceTargetInput;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
};

export type ResolveArtifactOutput = {
  artifactId: string;
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
  sourceCoverage: "full" | "partial" | "unknown";
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
};

export type SearchClassSourceOutput = {
  hits: SearchSourceHit[];
  nextCursor?: string;
  mappingApplied: SourceMapping;
  returnedNamespace: SourceMapping;
  artifactContents: ArtifactContentsSummary;
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
};

export type ResolveWorkspaceSymbolOutput = MappingSymbolResolutionOutput & {
  workspaceDetection: WorkspaceCompileMappingOutput;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

export type SourceMode = "metadata" | "snippet" | "full";

export type GetClassSourceInput = {
  artifactId?: string;
  target?: SourceTargetInput;
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
  target?: SourceTargetInput;
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
  from: DiffMember;
  to: DiffMember;
  changed: DiffMemberChangedField[];
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
  reportMode?: "compact" | "full";
  warningCategoryFilter?: ("mapping" | "configuration" | "validation" | "resolution" | "parse")[];
  treatInfoAsWarning?: boolean;
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
    invalid: number;
    processingErrors: number;
    totalValidationErrors: number;
    totalValidationWarnings: number;
  };
  issueSummary?: ValidateMixinBatchIssueSummaryItem[];
  toolHealth?: MappingHealthReport;
  confidenceScore?: number;
  warnings: string[];
};

type ValidateMixinSingleInput = Omit<ValidateMixinInput, "input"> & {
  source?: string;
  sourcePath?: string;
};

type ValidateMixinConfigSource = {
  sourcePath: string;
  configPath: string;
};

export type ValidateAccessWidenerInput = {
  content: string;
  version: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
};

export type ValidateAccessWidenerOutput = AccessWidenerValidationResult;

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

type VersionSourceCandidate = {
  jarPath: string;
  javaEntryCount: number;
  hasMinecraftNamespace: boolean;
  score: number;
};

type VersionSourceDiscovery = {
  searchedPaths: string[];
  candidateArtifacts: string[];
  selectedSourceJarPath?: string;
  selectedHasMinecraftNamespace?: boolean;
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
  const pattern = new RegExp(
    `(^|[^0-9a-z])${escapeRegexLiteral(normalizedVersion)}([^0-9a-z]|$)`,
    "i"
  );
  return pattern.test(normalizedPath);
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

function normalizeOptionalProjectPath(projectPath: string | undefined): string | undefined {
  if (!projectPath) {
    return undefined;
  }
  const trimmed = projectPath.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePathForHost(trimmed, undefined, "projectPath");
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

function buildVersionSourceSearchRoots(projectPath: string | undefined): string[] {
  const roots = new Set<string>();
  if (projectPath) {
    roots.add(resolvePath(projectPath, ".gradle", "loom-cache"));
    roots.add(resolvePath(projectPath, ".gradle-user", "caches", "fabric-loom"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "fabric-loom"));
    return [...roots];
  }
  const homeGradle = resolvePath(homedir(), ".gradle");
  roots.add(resolvePath(homeGradle, "loom-cache"));
  roots.add(resolvePath(homeGradle, "caches", "fabric-loom"));
  return [...roots];
}

function parseQualifiedMethodSymbol(symbol: string): { className: string; methodName: string } {
  const trimmed = symbol.trim();
  const separator = trimmed.lastIndexOf(".");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: { symbol }
    });
  }

  const className = trimmed.slice(0, separator);
  const methodName = trimmed.slice(separator + 1);
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

  return { className, methodName };
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

    const fromOwnerCompare = left.from.ownerFqn.localeCompare(right.from.ownerFqn);
    if (fromOwnerCompare !== 0) {
      return fromOwnerCompare;
    }

    return left.to.ownerFqn.localeCompare(right.to.ownerFqn);
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
  return new RegExp(`^${result}$`);
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
  private readonly explorerService: MinecraftExplorerService;
  private readonly registryService: RegistryService;
  private readonly versionDiffService: VersionDiffService;
  private readonly modDecompileService: ModDecompileService;
  private readonly modSearchService: ModSearchService;

  constructor(explicitConfig?: Config, metrics = new RuntimeMetrics()) {
    this.config = explicitConfig ?? loadConfig();
    this.metrics = metrics;
    this.versionService = new VersionService(this.config);
    this.mappingService = new MappingService(this.config, this.versionService);
    this.workspaceMappingService = new WorkspaceMappingService();
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
        discovered = fastGlob.sync("**/*sources.jar", {
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
        const score =
          (hasMinecraftNamespace ? 10_000 : 0) +
          (lower.includes("minecraft-merged") ? 2_000 : 0) +
          (lower.includes(input.version.toLowerCase()) ? 1_000 : 0) +
          Math.min(javaEntries.length, 500);
        candidates.push({
          jarPath: normalizedPath,
          javaEntryCount: javaEntries.length,
          hasMinecraftNamespace,
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
      candidates.find((candidate) => candidate.hasMinecraftNamespace) ?? candidates[0];
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

  private buildVersionSourceRecoveryCommand(projectPath?: string): string {
    const normalizedProjectPath = normalizeOptionalProjectPath(projectPath);
    const prefix = normalizedProjectPath
      ? `cd ${JSON.stringify(normalizedProjectPath)} && `
      : "";
    return `${prefix}./gradlew genSources --no-daemon`;
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
    const sourceCoverage = hasPartialNetMinecraftCoverage(input.qualityFlags)
      ? "partial"
      : input.qualityFlags.length > 0 || sourceKind === "source-jar" || sourceKind === "decompiled-binary"
        ? "full"
        : "unknown";

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

  async resolveArtifact(input: ResolveArtifactInput): Promise<ResolveArtifactOutput> {
    const kind = input.target.kind;
    let value = input.target.value?.trim();
    const mapping = normalizeMapping(input.mapping);
    const scope = input.scope;
    const warnings: string[] = [];

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
      if (kind === "version") {
        const versionJar = await this.versionService.resolveVersionJar(value);
        resolvedVersion = versionJar.version;
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

      if (kind === "version" && resolvedVersion && effectiveMapping === "mojang" && scope !== "vanilla") {
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

      const resolved = await resolveSourceTargetInternal(
        resolvedTarget,
        {
          // mojang requires source-backed artifact guarantee; force resolution to consider decompile candidate
          // and reject later if mapping cannot be applied.
          allowDecompile: effectiveMapping === "mojang" ? true : input.allowDecompile ?? true,
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
          resolved
        });
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED) {
          const isVanillaMojang = scope === "vanilla" && effectiveMapping === "mojang";
          let suggestedCall: { tool: string; params: Record<string, unknown> };
          let nextAction: string;
          if (isVanillaMojang && input.projectPath) {
            suggestedCall = {
              tool: "resolve-artifact",
              params: buildResolveArtifactParams(
                { kind, value },
                { mapping: "mojang", scope: "merged", projectPath: input.projectPath }
              )
            };
            nextAction =
              "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
              "Retry with scope=merged to allow source-jar resolution from the project cache.";
          } else if (isVanillaMojang) {
            suggestedCall = {
              tool: "resolve-artifact",
              params: buildResolveArtifactParams(
                { kind, value },
                { mapping: "obfuscated", scope: "vanilla" }
              )
            };
            nextAction =
              "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
              "Without a projectPath, use mapping=obfuscated to read vanilla runtime names directly.";
          } else {
            suggestedCall = {
              tool: "resolve-artifact",
              params: buildResolveArtifactParams(
                { kind, value },
                { mapping: "obfuscated", ...(scope ? { scope } : {}) }
              )
            };
            nextAction = "Retry with mapping=obfuscated to use the runtime obfuscated namespace.";
          }
          throw createError({
            code: ERROR_CODES.MAPPING_NOT_APPLIED,
            message: caughtError.message,
            details: {
              ...(caughtError.details ?? {}),
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

      resolved.requestedMapping = effectiveMapping;
      resolved.mappingApplied = mappingDecision.mappingApplied;
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
      resolved.qualityFlags = [...new Set(resolved.qualityFlags)];
      await this.ingestIfNeeded(resolved);

      let sampleEntries: string[] | undefined;
      if (resolved.sourceJarPath) {
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
      const query = input.query.trim();
      if (!query) {
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
      const scope = input.scope;
      if (scope?.symbolKind && intent !== "symbol") {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'symbolKind filter is only supported when intent="symbol".'
        });
      }
      const limit = clampLimit(input.limit, 20, searchLimitCap);
      const regexPattern = match === "regex" ? compileRegex(query) : undefined;
      const queryMode = input.queryMode ?? "auto";
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
      const hasSeparators = /[._$]/.test(query);
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

            // F-03: queryMode=auto fallback — when indexed returns 0 hits and query has separators, retry with literal scan
            if (queryMode === "auto" && hasSeparators && accumulator.currentCount() === 0) {
              this.searchTextIntent(artifact.artifactId, query, match, scope, regexPattern, recordHit);
            }
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
        })
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
    return this.mappingService.checkSymbolExists(input);
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
        sourcePriority: input.sourcePriority
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
        workspaceDetection,
        warnings: [...warnings, ...matrix.warnings]
      };
    }

    const mapped = await this.mappingService.findMapping({
      version,
      kind,
      name,
      owner,
      descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: mappingApplied,
      sourcePriority: input.sourcePriority
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
      workspaceDetection,
      warnings: [...warnings, ...mapped.warnings]
    };
  }

  async traceSymbolLifecycle(input: TraceSymbolLifecycleInput): Promise<TraceSymbolLifecycleOutput> {
    const mapping = normalizeMapping(input.mapping);

    const { className: userClassName, methodName: userMethodName } = parseQualifiedMethodSymbol(input.symbol);
    const descriptor = normalizeOptionalString(input.descriptor);
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

    const resolvedSymbolsByVersion = new Map<
      string,
      { className: string; methodName: string; methodDescriptor?: string }
    >();

    const scanned: LifecycleScanEntry[] = [];
    for (const version of selectedVersions) {
      try {
        let resolvedSymbols = resolvedSymbolsByVersion.get(version);
        if (!resolvedSymbols) {
          const [obfuscatedClassName, obfuscatedMethod] = await Promise.all([
            this.resolveToObfuscatedClassName(
              userClassName,
              version,
              mapping,
              input.sourcePriority,
              warnings
            ),
            this.resolveToObfuscatedMemberName(
              userMethodName,
              userClassName,
              descriptor,
              "method",
              version,
              mapping,
              input.sourcePriority,
              warnings
            )
          ]);
          resolvedSymbols = {
            className: obfuscatedClassName,
            methodName: obfuscatedMethod.name,
            methodDescriptor: obfuscatedMethod.descriptor
          };
          resolvedSymbolsByVersion.set(version, resolvedSymbols);
        }

        const resolvedJar = await this.versionService.resolveVersionJar(version);
        const signature = await this.explorerService.getSignature({
          fqn: resolvedSymbols.className,
          jarPath: resolvedJar.jarPath,
          access: "all",
          includeSynthetic: true
        });
        const sameNameMethods = signature.methods.filter((method) => method.name === resolvedSymbols.methodName);
        const matchesDescriptor = (resolvedSymbols.methodDescriptor ?? descriptor)
          ? sameNameMethods.some(
              (method) => method.jvmDescriptor === (resolvedSymbols.methodDescriptor ?? descriptor)
            )
          : sameNameMethods.length > 0;
        const reason =
          !matchesDescriptor && descriptor && sameNameMethods.length > 0 ? "descriptor-mismatch" : undefined;

        scanned.push({
          version,
          exists: matchesDescriptor,
          reason,
          determinate: true
        });
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
          scanned.push({
            version,
            exists: false,
            reason: "class-not-found",
            determinate: true
          });
          continue;
        }

        scanned.push({
          version,
          exists: false,
          reason: "unresolved",
          determinate: false
        });
        warnings.push(
          `Failed to evaluate ${version}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
        );
      }
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
          const [fromResult, toResult] = await Promise.all([
            this.remapSignatureMembers([change.from], kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings),
            this.remapSignatureMembers([change.to], kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings)
          ]);
          return { ...change, from: fromResult.members[0], to: toResult.members[0] };
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
      constructors: remappedConstructors,
      methods: remappedMethods,
      fields: remappedFields,
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
    const artifactId = input.artifactId.trim();
    if (!artifactId) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "artifactId must be non-empty."
      });
    }
    // Verify artifact exists
    const artifact = this.getArtifact(artifactId);

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
      activeQualityFlags = [...new Set([...(fallbackResolved.qualityFlags ?? []), "binary-fallback"])];
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
        targetValue: input.target?.value,
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
        targetValue: input.target?.value,
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
      qualityFlags,
      artifactContents: this.buildArtifactContentsSummary({
        origin,
        sourceJarPath,
        isDecompiled: origin === "decompiled",
        qualityFlags
      }),
      warnings
    };
  }

  async validateMixin(input: ValidateMixinInput): Promise<ValidateMixinOutput> {
    const { input: sourceInput, ...sharedInput } = input;
    const mode = sourceInput.mode;

    if (mode === "inline") {
      const singleResult = await this.validateMixinSingle({
        ...sharedInput,
        source: sourceInput.source
      });
      return this.buildValidateMixinOutput(mode, [
        {
          source: {
            kind: "inline",
            label: "<inline>"
          },
          result: singleResult
        }
      ]);
    }

    if (mode === "path") {
      const resolvedPath = this.resolveMixinInputPath(sourceInput.path, "path");
      const singleResult = await this.validateMixinSingle({
        ...sharedInput,
        sourcePath: sourceInput.path
      });
      return this.buildValidateMixinOutput(mode, [
        {
          source: {
            kind: "path",
            label: resolvedPath,
            path: resolvedPath
          },
          result: singleResult
        }
      ]);
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
        input
      );
    }

    const configSources = await this.resolveMixinConfigSources(input);
    if (configSources.length === 0) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Mixin config(s) contain no mixin class entries."
      });
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
      input
    );
  }

  private async validateMixinSingle(input: ValidateMixinSingleInput): Promise<MixinValidationResult> {
    let version = input.version.trim();
    if (!version) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
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
            ` ${err instanceof Error ? err.message : String(err)}`
        });
      }
    } else {
      source = input.source ?? "";
    }
    if (!source.trim()) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "source must be non-empty." });
    }

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
    let scopeFallback: { requested: string; applied: string; reason: string } | undefined;
    if (input.scope && input.scope !== "vanilla" && input.projectPath) {
      try {
        const resolved = await this.resolveArtifact({
          target: { kind: "version", value: version },
          mapping: requestedMapping,
          sourcePriority: input.sourcePriority,
          projectPath: input.projectPath,
          scope: input.scope,
          preferProjectVersion: false
        });
        jarPath = resolved.binaryJarPath ?? (await this.versionService.resolveVersionJar(version)).jarPath;
        warnings.push(...resolved.warnings);
        mappingApplied = resolved.mappingApplied;
        if (resolved.version) {
          version = resolved.version;
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
      scopeFallback = {
        requested: input.scope ?? "vanilla",
        applied: "vanilla",
        reason: "Resolved jar was a sources jar, not a binary class jar."
      };
    }

    // Health check: probe mapping infrastructure
    let healthReport: MappingHealthReport | undefined;
    try {
      const health = await this.mappingService.checkMappingHealth({
        version,
        requestedMapping,
        sourcePriority: input.sourcePriority
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
    } catch {
      // Health check failed — proceed without it
    }

    const parsed = parseMixinSource(source);

    const targetMembers = new Map<string, ResolvedTargetMembers>();
    const mappingFailedTargets = new Set<string>();
    const remapFailedMembers = new Map<string, Set<string>>();
    const signatureFailedTargets = new Set<string>();
    const symbolExistsButSignatureFailed = new Set<string>();
    const resolutionTrace: MixinValidationProvenance["resolutionTrace"] = input.explain ? [] : undefined;

    for (const target of parsed.targets) {
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

      if (requestedMapping !== "obfuscated") {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: resolvedClassName,
            sourceMapping: requestedMapping,
            targetMapping: "obfuscated",
            sourcePriority: input.sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            obfuscatedName = mapped.resolvedSymbol.name;
            resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: true });
          } else {
            warnings.push(`Could not map class "${resolvedClassName}" from ${requestedMapping} to obfuscated; using "${obfuscatedName}" for lookup.`);
            mappingFailedTargets.add(target.className);
            resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: "No mapping found" });
          }
        } catch (mapErr) {
          warnings.push(`Mapping lookup failed for class "${resolvedClassName}"; using "${obfuscatedName}" for lookup.`);
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

        if (requestedMapping !== "obfuscated") {
          try {
            const [ctorResult, methodResult, fieldResult] = await Promise.all([
              this.remapSignatureMembers(sig.constructors, "method", version, "obfuscated", requestedMapping, input.sourcePriority, warnings),
              this.remapSignatureMembers(sig.methods, "method", version, "obfuscated", requestedMapping, input.sourcePriority, warnings),
              this.remapSignatureMembers(sig.fields, "field", version, "obfuscated", requestedMapping, input.sourcePriority, warnings)
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
            warnings.push(`Member remapping failed for "${resolvedClassName}"; falling back to obfuscated names. Member names shown may be in the obfuscated runtime namespace.`);
            mappingApplied = "obfuscated";
            resolutionTrace?.push({ target: target.className, step: "remap", input: resolvedClassName, output: "obfuscated fallback", success: false, detail: remapErr instanceof Error ? remapErr.message : String(remapErr) });
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
        signatureFailedTargets.add(target.className);
        resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: "CLASS_NOT_FOUND", success: false, detail: sigErr instanceof Error ? sigErr.message : String(sigErr) });

        // Fallback: check if the symbol exists in the mapping graph even though getSignature failed
        try {
          const existenceCheck = await this.mappingService.checkSymbolExists({
            version, kind: "class", name: resolvedClassName,
            sourceMapping: requestedMapping, nameMode: "auto"
          });
          if (existenceCheck.resolved) {
            signatureFailedTargets.delete(target.className);
            symbolExistsButSignatureFailed.add(target.className);
            resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "exists in mapping graph", success: true });
          } else {
            resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "not found", success: false });
          }
        } catch {
          // Fallback check failed — keep as signatureFailedTarget
          resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "check failed", success: false });
        }
      }
    }

    // Fix toolHealth accuracy: reflect actual failures after target resolution
    if (healthReport) {
      const hasFailures = signatureFailedTargets.size > 0 || mappingFailedTargets.size > 0;
      if (hasFailures && healthReport.overallHealthy) {
        healthReport.overallHealthy = false;
        healthReport.degradations.push(
          `${mappingFailedTargets.size} mapping failure(s), ${signatureFailedTargets.size} signature failure(s).`
        );
      }
    }

    const resolutionNotes: string[] = [];
    if (requestedMapping !== mappingApplied) {
      resolutionNotes.push(
        `Mapping fallback: requested "${requestedMapping}" but applied "${mappingApplied}" due to remapping failure.`
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
    if (requestedMapping !== "obfuscated") {
      mappingChain.push(`${requestedMapping} → obfuscated`);
      if (mappingApplied !== requestedMapping) {
        mappingChain.push(`fallback to ${mappingApplied}`);
      }
    }

    const provenance: MixinValidationProvenance = {
      version,
      jarPath,
      requestedMapping,
      mappingApplied,
      resolutionNotes: resolutionNotes.length > 0 ? resolutionNotes : undefined,
      jarType: scopeFallback ? "vanilla-client" : (input.scope && input.scope !== "vanilla" && input.projectPath) ? "merged" : "vanilla-client",
      mappingChain: mappingChain.length > 0 ? mappingChain : undefined,
      remapFailures: remapFailures > 0 ? remapFailures : undefined,
      mappingAutoDetected: mappingAutoDetected || undefined,
      scopeFallback,
      resolutionTrace: resolutionTrace && resolutionTrace.length > 0 ? resolutionTrace : undefined
    };

    const result = validateParsedMixin(
      parsed, targetMembers, warnings, provenance, confidence, mappingFailedTargets, input.explain,
      remapFailedMembers, signatureFailedTargets,
      input.explain ? { scope: input.scope, sourcePriority: input.sourcePriority, projectPath: input.projectPath, mapping: requestedMapping } : undefined,
      input.warningMode,
      healthReport,
      symbolExistsButSignatureFailed.size > 0 ? symbolExistsButSignatureFailed : undefined
    );

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
      result.valid = filteredDefiniteErrors === 0;
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
      result.valid = catDefiniteErrors === 0;
    }

    // Apply treatInfoAsWarning filter
    if (input.treatInfoAsWarning === false && result.structuredWarnings) {
      result.structuredWarnings = result.structuredWarnings.filter((sw) => sw.severity !== "info");
      if (result.structuredWarnings.length === 0) result.structuredWarnings = undefined;
    }

    // Apply compact report mode
    if (input.reportMode === "compact") {
      result.resolvedMembers = undefined;
      result.structuredWarnings = undefined;
      result.aggregatedWarnings = undefined;
      result.toolHealth = undefined;
      if (result.provenance) {
        result.provenance.resolutionTrace = undefined;
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

  private async resolveMixinConfigSources(input: ValidateMixinInput): Promise<ValidateMixinConfigSource[]> {
    if (input.input.mode !== "config") {
      return [];
    }

    const results: ValidateMixinConfigSource[] = [];

    for (const rawConfigPath of input.input.configPaths) {
      const resolvedConfigPath = this.resolveMixinInputPath(rawConfigPath, "configPath");
      let configJson: { package?: string; mixins?: string[]; client?: string[]; server?: string[] };
      try {
        const raw = await readFile(resolvedConfigPath, "utf-8");
        configJson = JSON.parse(raw);
      } catch (err) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Could not read/parse mixin config "${rawConfigPath}": ${err instanceof Error ? err.message : String(err)}`
        });
      }

      const pkg = configJson.package ?? "";
      const classNames = [
        ...(configJson.mixins ?? []),
        ...(configJson.client ?? []),
        ...(configJson.server ?? [])
      ];
      if (classNames.length === 0) {
        continue;
      }

      const projectBase = input.projectPath
        ? (isAbsolute(input.projectPath) ? input.projectPath : resolvePath(process.cwd(), input.projectPath))
        : dirname(resolvedConfigPath);

      let sourceRootCandidates: string[];
      if (input.sourceRoots && input.sourceRoots.length > 0) {
        sourceRootCandidates = input.sourceRoots;
      } else {
        const detected = COMMON_SOURCE_ROOTS.filter((candidateRoot) => classNames.some((className) => {
          const fqcn = pkg ? `${pkg}.${className}` : className;
          const relative = fqcn.replace(/\./g, "/") + ".java";
          return existsSync(resolvePath(projectBase, candidateRoot, relative));
        }));
        sourceRootCandidates = detected.length > 0 ? detected : ["src/main/java"];
      }

      for (const cls of classNames) {
        const fqcn = pkg ? `${pkg}.${cls}` : cls;
        const relativePath = fqcn.replace(/\./g, "/") + ".java";
        let sourcePath = resolvePath(projectBase, sourceRootCandidates[0], relativePath);
        for (const root of sourceRootCandidates) {
          const candidate = resolvePath(projectBase, root, relativePath);
          if (existsSync(candidate)) {
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

    return results;
  }

  private async validateMixinMany(
    mode: "paths" | "config",
    entries: Array<{ source: ValidateMixinResultSource; sourcePath: string }>,
    input: ValidateMixinInput
  ): Promise<ValidateMixinOutput> {
    const results: ValidateMixinBatchResult[] = [];
    const batchWarningMode = input.warningMode ?? "aggregated";
    const { input: _discardedInput, ...sharedInput } = input;

    for (const entry of entries) {
      try {
        const singleResult = await this.validateMixinSingle({
          ...sharedInput,
          sourcePath: entry.sourcePath,
          warningMode: batchWarningMode
        });
        results.push({
          source: entry.source,
          result: singleResult
        });
      } catch (err) {
        results.push({
          source: entry.source,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return this.buildValidateMixinOutput(mode, results);
  }

  private buildValidateMixinOutput(
    mode: ValidateMixinOutput["mode"],
    results: ValidateMixinBatchResult[]
  ): ValidateMixinOutput {
    let valid = 0;
    let invalid = 0;
    let processingErrors = 0;
    let totalValidationErrors = 0;
    let totalValidationWarnings = 0;
    const warningSet = new Set<string>();
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

      totalValidationErrors += entry.result.summary.errors;
      totalValidationWarnings += entry.result.summary.warnings;

      for (const warning of entry.result.warnings) {
        warningSet.add(warning);
      }

      for (const issue of entry.result.issues) {
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
        invalid,
        processingErrors,
        totalValidationErrors,
        totalValidationWarnings
      },
      issueSummary,
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
    const { jarPath } = await this.versionService.resolveVersionJar(version);
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
    const needsMapping = awNamespace !== "obfuscated";

    // Collect unique class FQNs from entries
    const classFqns = new Set<string>();
    for (const entry of parsed.entries) {
      const fqn = entry.target.replace(/\//g, ".");
      classFqns.add(fqn);
    }

    const membersByClass = new Map<string, ResolvedTargetMembers>();
    for (const fqn of classFqns) {
      let obfuscatedFqn = fqn;

      if (needsMapping) {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: fqn,
            sourceMapping: awNamespace,
            targetMapping: "obfuscated",
            sourcePriority: input.sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            obfuscatedFqn = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${fqn}" from ${awNamespace} to obfuscated.`);
          }
        } catch {
          warnings.push(`Mapping lookup failed for class "${fqn}".`);
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: obfuscatedFqn,
          jarPath,
          access: "all"
        });
        warnings.push(...sig.warnings);
        membersByClass.set(fqn, {
          className: fqn,
          constructors: sig.constructors,
          methods: sig.methods,
          fields: sig.fields
        });
      } catch {
        warnings.push(`Could not load signature for class "${obfuscatedFqn}".`);
      }
    }

    return validateParsedAccessWidener(parsed, membersByClass, warnings);
  }

  getRuntimeMetrics(): RuntimeMetricSnapshot {
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
    const filePaths = this.loadScopedFilePaths(artifactId, scope);
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);

    for (const chunk of chunkArray(filePaths, pageSize)) {
      const rows = this.filesRepo.getFileContentsByPaths(artifactId, chunk);
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(rows.length);

      for (const row of rows) {
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
    const filePaths = this.loadScopedFilePaths(artifactId, scope);
    const matching = filePaths.flatMap((filePath) => {
      const pathIndex =
        match === "regex"
          ? matchRegexIndex(filePath, regexPattern as RegExp)
          : findMatchIndex(filePath, query, match);
      if (pathIndex < 0) {
        return [];
      }
      return [{ filePath, pathIndex }];
    });
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);

    for (const chunk of chunkArray(matching, pageSize)) {
      for (const candidate of chunk) {
        onHit({
          filePath: candidate.filePath,
          score: scorePathMatch(match, candidate.pathIndex),
          matchedIn: "path",
          reasonCodes: ["path_match", `path_${match}`]
        });
      }
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

    for (const symbol of candidates) {
      if (!checkPackagePrefix(symbol.filePath, scope?.packagePrefix)) {
        continue;
      }

      if (scope?.fileGlob) {
        const glob = buildGlobRegex(normalizePathStyle(scope.fileGlob));
        if (!glob.test(symbol.filePath)) {
          continue;
        }
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

  private loadScopedFilePaths(
    artifactId: string,
    scope: SearchScope | undefined
  ): string[] {
    const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;

    const result: string[] = [];
    let cursor: string | undefined = undefined;
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);

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
        result.push(filePath);
      }

      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
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

    for (const candidate of candidates) {
      const row = this.filesRepo.getFileContent(artifactId, candidate);
      if (row) {
        return row.filePath;
      }
    }

    const simpleName = normalizedClassName.split(/[.$]/).at(-1);
    if (!simpleName) {
      return undefined;
    }
    const classPathBySymbol = this.symbolsRepo.findBestClassFilePath(
      artifactId,
      normalizedClassName,
      simpleName
    );
    if (classPathBySymbol && isPackageCompatible(classPathBySymbol, classPath)) {
      return classPathBySymbol;
    }

    const byName = this.filesRepo.findFirstFilePathByName(artifactId, `${simpleName}.java`);
    if (byName && isPackageCompatible(byName, classPath)) {
      return byName;
    }
    return undefined;
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
      fallbackResolved.qualityFlags = [
        ...new Set([...(fallbackResolved.qualityFlags ?? []), ...input.qualityFlags, "binary-fallback"])
      ];
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
      const mapped = await this.mappingService.findMapping({
        version,
        kind,
        name,
        owner: ownerInSourceMapping,
        descriptor,
        sourceMapping: mapping,
        targetMapping: "obfuscated",
        sourcePriority
      });
      if (mapped.resolved && mapped.resolvedSymbol) {
        return {
          name: mapped.resolvedSymbol.name,
          descriptor: kind === "method" ? mapped.resolvedSymbol.descriptor ?? descriptor : undefined
        };
      }
      warnings.push(`Could not map ${kind} "${name}" from ${mapping} to obfuscated.`);
    } catch {
      warnings.push(`Mapping lookup failed for ${kind} "${name}".`);
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
    warnings: string[]
  ): Promise<{ members: SignatureMember[]; failedNames: Set<string> }> {
    const failedNames = new Set<string>();
    if (sourceMapping === targetMapping) {
      return { members, failedNames };
    }

    // Build deduplicated lookup tables for member names and owner FQNs
    const memberKeyToRemapped = new Map<string, string>();
    const ownerToRemapped = new Map<string, string>();

    for (const member of members) {
      const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
      if (!memberKeyToRemapped.has(memberKey)) {
        memberKeyToRemapped.set(memberKey, member.name); // default = obfuscated name
      }
      if (!ownerToRemapped.has(member.ownerFqn)) {
        ownerToRemapped.set(member.ownerFqn, member.ownerFqn); // default = obfuscated FQN
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
            sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            ownerToRemapped.set(obfuscatedFqn, mapped.resolvedSymbol.name);
          }
        } catch {
          // keep obfuscated FQN as fallback
        }
      })
    );

    // Phase 2: Remap member names using resolved owners for disambiguation
    const memberEntries = [...memberKeyToRemapped.entries()];
    await Promise.all(
      memberEntries.map(async ([key, _obfuscatedName]) => {
        const [ownerFqn, name, descriptor] = key.split("\0");
        try {
          const targetOwner = ownerToRemapped.get(ownerFqn!) ?? ownerFqn;
          const mapped = await this.mappingService.findMapping({
            version,
            kind,
            name,
            owner: ownerFqn,
            descriptor: kind === "method" ? descriptor : undefined,
            sourceMapping,
            targetMapping,
            sourcePriority,
            disambiguation: { ownerHint: targetOwner }
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            memberKeyToRemapped.set(key, mapped.resolvedSymbol.name);
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

    return {
      members: members.map((member) => {
        const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
        return {
          ...member,
          name: memberKeyToRemapped.get(memberKey) ?? member.name,
          ownerFqn: ownerToRemapped.get(member.ownerFqn) ?? member.ownerFqn
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
      const vineflowerPath = await resolveVineflowerJar(
        this.config.cacheDir,
        this.config.vineflowerJarPath
      );
      const decompileStartedAt = Date.now();
      try {
        const decompileResult = await decompileBinaryJar(resolved.binaryJarPath, this.config.cacheDir, {
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
      indexDurationMs: Date.now() - indexStartedAt
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
      this.metrics.recordArtifactCacheHit();
      this.artifactsRepo.touchArtifact(resolved.artifactId, new Date().toISOString());
      this.refreshCacheMetrics();
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
    this.refreshCacheMetrics();
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

  private enforceCacheLimits(): void {
    let artifactCount = this.artifactsRepo.countArtifacts();
    let totalBytes = this.artifactsRepo.totalContentBytes();
    if (artifactCount <= this.config.maxArtifacts && totalBytes <= this.config.maxCacheBytes) {
      return;
    }

    const candidates = this.artifactsRepo.listArtifactsByLruWithContentBytes(Math.max(artifactCount, 1));
    for (const candidate of candidates) {
      const shouldEvict = artifactCount > this.config.maxArtifacts || totalBytes > this.config.maxCacheBytes;
      if (!shouldEvict || artifactCount <= 1) {
        return;
      }

      const artifactCountBefore = artifactCount;
      const totalBytesBefore = totalBytes;
      this.filesRepo.deleteFilesForArtifact(candidate.artifactId);
      this.artifactsRepo.deleteArtifact(candidate.artifactId);
      artifactCount = Math.max(0, artifactCount - 1);
      totalBytes = Math.max(0, totalBytes - candidate.totalContentBytes);
      this.metrics.recordCacheEviction();
      log("warn", "cache.evict", {
        artifactId: candidate.artifactId,
        artifactCountBefore,
        totalBytesBefore,
        artifactBytes: candidate.totalContentBytes
      });
    }
  }

  private refreshCacheMetrics(): void {
    const cacheEntries = this.artifactsRepo.countArtifacts();
    const totalContentBytes = this.artifactsRepo.totalContentBytes();
    const lruAccounting = this.artifactsRepo
      .listArtifactsByLruWithContentBytes(Math.max(cacheEntries, 1))
      .map((row) => ({
        artifact_id: row.artifactId,
        content_bytes: row.totalContentBytes,
        updated_at: row.updatedAt
      }));
    this.metrics.setCacheEntries(cacheEntries);
    this.metrics.setCacheTotalContentBytes(totalContentBytes);
    this.metrics.setCacheArtifactByteAccounting(lruAccounting);
  }
}
