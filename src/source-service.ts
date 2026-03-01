import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES, isAppError } from "./errors.js";
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
  type ResolvedTargetMembers,
  type MixinValidationResult,
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
  warnings: string[];
};

type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
type SearchIntent = "symbol" | "text" | "path";
type SearchMatch = "exact" | "prefix" | "contains" | "regex";

export type SearchScope = {
  packagePrefix?: string;
  fileGlob?: string;
  symbolKind?: SymbolKind;
};

export type SearchInclude = {
  snippetLines?: number;
  includeDefinition?: boolean;
  includeOneHop?: boolean;
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
  startLine: number;
  endLine: number;
  snippet: string;
  reasonCodes: string[];
  symbol?: SearchResultSymbol;
};

export type SearchRelation = {
  fromSymbol: {
    symbolKind: SymbolKind;
    symbolName: string;
    filePath: string;
    line: number;
  };
  toSymbol: {
    symbolKind: SymbolKind;
    symbolName: string;
    filePath: string;
    line: number;
  };
  relation: "calls" | "uses-type" | "imports";
};

export type SearchClassSourceInput = {
  artifactId: string;
  query: string;
  intent?: SearchIntent;
  match?: SearchMatch;
  scope?: SearchScope;
  include?: SearchInclude;
  limit?: number;
  cursor?: string;
};

export type SearchClassSourceOutput = {
  hits: SearchSourceHit[];
  relations?: SearchRelation[];
  nextCursor?: string;
  totalApprox: number;
  mappingApplied: SourceMapping;
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

export type GetClassSourceInput = {
  artifactId?: string;
  target?: SourceTargetInput;
  className: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
};

export type GetClassSourceOutput = {
  className: string;
  sourceText: string;
  totalLines: number;
  returnedRange: {
    start: number;
    end: number;
  };
  truncated: boolean;
  origin: ResolvedSourceArtifact["origin"];
  artifactId: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  provenance: ArtifactProvenance;
  qualityFlags: string[];
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
  provenance: ArtifactProvenance;
  qualityFlags: string[];
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
  source: string;
  version: string;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
};

export type ValidateMixinOutput = MixinValidationResult;

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

type SnippetWindow = {
  before: number;
  after: number;
};

type SnippetBuildResult = {
  startLine: number;
  endLine: number;
  snippet: string;
  truncated: boolean;
};

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
};

function normalizePathStyle(path: string): string {
  return path.replaceAll("\\", "/");
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

function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
  if (mapping == null) {
    return "official";
  }
  if (
    mapping === "official" ||
    mapping === "mojang" ||
    mapping === "intermediary" ||
    mapping === "yarn"
  ) {
    return mapping;
  }
  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Unsupported mapping "${mapping}".`,
    details: { mapping }
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
    normalized === "official" ||
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

  // fileGlob and symbolKind are now applied as post-filters on indexed candidates
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

function buildSnippetWindow(lines: number | undefined): SnippetWindow {
  const totalLines = clampLimit(lines, 8, 80);
  const before = Math.floor((totalLines - 1) / 2);
  return {
    before,
    after: Math.max(0, totalLines - 1 - before)
  };
}

function buildSearchCursorContext(input: {
  artifactId: string;
  query: string;
  intent: SearchIntent;
  match: SearchMatch;
  scope: SearchScope | undefined;
  includeDefinition: boolean;
}): string {
  return JSON.stringify({
    artifactId: input.artifactId,
    query: input.query,
    intent: input.intent,
    match: input.match,
    includeDefinition: input.includeDefinition,
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

function indexToLine(content: string, index: number): number {
  if (index <= 0) {
    return 1;
  }
  return content.slice(0, index).split(/\r?\n/).length;
}

function lineToSymbol(symbol: SymbolRow): SearchResultSymbol | undefined {
  if (!isSymbolKind(symbol.symbolKind)) {
    return undefined;
  }

  return {
    symbolKind: symbol.symbolKind,
    symbolName: symbol.symbolName,
    qualifiedName: symbol.qualifiedName,
    line: symbol.line
  };
}

function toContextSnippet(
  content: string,
  centerLineInput: number,
  beforeLines: number,
  afterLines: number,
  withLineNumbers: boolean
): SnippetBuildResult {
  const lines = content.split(/\r?\n/);
  const centerLine = Math.min(Math.max(1, centerLineInput), Math.max(lines.length, 1));
  const requestedStart = Math.max(1, centerLine - beforeLines);
  const requestedEnd = centerLine + afterLines;
  const startLine = Math.min(requestedStart, Math.max(lines.length, 1));
  const endLine = Math.min(requestedEnd, Math.max(lines.length, 1));
  const snippetLines = lines.slice(startLine - 1, endLine);
  const snippet = withLineNumbers
    ? snippetLines.map((line, index) => `${startLine + index}: ${line}`).join("\n")
    : snippetLines.join("\n");

  return {
    startLine,
    endLine,
    snippet,
    truncated: requestedStart !== startLine || requestedEnd !== endLine
  };
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
      .map((candidate) => `${candidate.jarPath}#java=${candidate.javaEntryCount}`);

    return {
      searchedPaths,
      candidateArtifacts,
      selectedSourceJarPath: selected?.jarPath
    };
  }

  private buildVersionSourceRecoveryCommand(projectPath?: string): string {
    const normalizedProjectPath = normalizeOptionalProjectPath(projectPath);
    const prefix = normalizedProjectPath
      ? `cd ${JSON.stringify(normalizedProjectPath)} && `
      : "";
    return `${prefix}./gradlew genSources --no-daemon`;
  }

  async resolveArtifact(input: ResolveArtifactInput): Promise<ResolveArtifactOutput> {
    const kind = input.target.kind;
    const value = input.target.value?.trim();
    const mapping = normalizeMapping(input.mapping);
    const warnings: string[] = [];
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

      // Unobfuscated versions (MC 26.1+) ship with official names; intermediary/yarn are not applicable.
      let effectiveMapping: SourceMapping = mapping;
      if (
        (mapping === "intermediary" || mapping === "yarn") &&
        resolvedVersion &&
        isUnobfuscatedVersion(resolvedVersion)
      ) {
        warnings.push(
          `Version ${resolvedVersion} is unobfuscated; ${mapping} mappings are not applicable. Using official names.`
        );
        effectiveMapping = "official";
      }

      if (kind === "version" && resolvedVersion && effectiveMapping === "mojang") {
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
          throw createError({
            code: ERROR_CODES.MAPPING_NOT_APPLIED,
            message: caughtError.message,
            details: {
              ...(caughtError.details ?? {}),
              searchedPaths: versionSourceDiscovery?.searchedPaths ?? [],
              candidateArtifacts:
                versionSourceDiscovery?.candidateArtifacts ?? resolved.adjacentSourceCandidates ?? [],
              recommendedCommand: this.buildVersionSourceRecoveryCommand(input.projectPath)
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
                "Use targetKind=version or a versioned Maven coordinate so mapping artifacts can be resolved."
            }
          });
        }

        const mappingAvailability = await this.mappingService.ensureMappingAvailable({
          version: resolved.version,
          sourceMapping: "official",
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
      }
      resolved.qualityFlags = [...new Set(resolved.qualityFlags)];
      await this.ingestIfNeeded(resolved);

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
        warnings
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
          totalApprox: 0,
          mappingApplied: artifact.mappingApplied ?? "official"
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
      const limit = clampLimit(input.limit, 20, searchLimitCap);
      const includeDefinition = input.include?.includeDefinition ?? false;
      const includeOneHop = input.include?.includeOneHop ?? false;
      const snippetWindow = buildSnippetWindow(input.include?.snippetLines);
      const regexPattern = match === "regex" ? compileRegex(query) : undefined;
      const scope = input.scope;
      const cursorContext = buildSearchCursorContext({
        artifactId: artifact.artifactId,
        query,
        intent,
        match,
        scope,
        includeDefinition
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
      if (intent === "symbol") {
        this.searchSymbolIntent(
          artifact.artifactId,
          query,
          match,
          scope,
          snippetWindow,
          regexPattern,
          recordHit
        );
        // WS4: Use repo-level COUNT for symbol totalApprox when not regex
        if (match !== "regex") {
          const approxCount = this.symbolsRepo.countScopedSymbols({
            artifactId: artifact.artifactId,
            query,
            match,
            symbolKind: scope?.symbolKind,
            packagePrefix: scope?.packagePrefix
          });
          accumulator.setTotalApproxOverride(approxCount);
        }
      } else if (!indexedSearchEnabled) {
        this.metrics.recordIndexedDisabled();
        this.metrics.recordSearchFallback();
        if (intent === "path") {
          this.searchPathIntent(
            artifact.artifactId,
            query,
            match,
            scope,
            includeDefinition,
            snippetWindow,
            regexPattern,
            recordHit
          );
        } else {
          this.searchTextIntent(
            artifact.artifactId,
            query,
            match,
            scope,
            includeDefinition,
            snippetWindow,
            regexPattern,
            recordHit
          );
        }
      } else if (canUseIndexedSearchPath(indexedSearchEnabled, intent, match, scope)) {
        try {
          if (intent === "path") {
            this.searchPathIntentIndexed(
              artifact.artifactId,
              query,
              match,
              scope,
              includeDefinition,
              snippetWindow,
              recordHit
            );
            // WS4: Use repo-level COUNT for totalApprox instead of accumulator count
            const approxCount = this.filesRepo.countPathCandidates(artifact.artifactId, query);
            accumulator.setTotalApproxOverride(approxCount);
          } else {
            this.searchTextIntentIndexed(
              artifact.artifactId,
              query,
              match,
              scope,
              includeDefinition,
              snippetWindow,
              recordHit
            );
            // WS4: Use repo-level COUNT for totalApprox instead of accumulator count
            const approxCount = this.filesRepo.countTextCandidates(artifact.artifactId, query);
            accumulator.setTotalApproxOverride(approxCount);
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
          if (intent === "path") {
            this.searchPathIntent(
              artifact.artifactId,
              query,
              match,
              scope,
              includeDefinition,
              snippetWindow,
              regexPattern,
              recordHit
            );
          } else {
            this.searchTextIntent(
              artifact.artifactId,
              query,
              match,
              scope,
              includeDefinition,
              snippetWindow,
              regexPattern,
              recordHit
            );
          }
        }
      } else {
        this.metrics.recordSearchFallback();
        if (intent === "path") {
          this.searchPathIntent(
            artifact.artifactId,
            query,
            match,
            scope,
            includeDefinition,
            snippetWindow,
            regexPattern,
            recordHit
          );
        } else {
          this.searchTextIntent(
            artifact.artifactId,
            query,
            match,
            scope,
            includeDefinition,
            snippetWindow,
            regexPattern,
            recordHit
          );
        }
      }
      this.metrics.recordSearchIntentDuration(intent, Date.now() - intentStartedAt);

      const finalizedHits = accumulator.finalize();
      const page = finalizedHits.page;
      this.metrics.recordSearchRowsReturned(page.length);
      const nextCursor = finalizedHits.nextCursorHit
        ? encodeSearchCursor(finalizedHits.nextCursorHit, cursorContext)
        : undefined;

      const relations = includeOneHop
        ? this.buildOneHopRelations(
            artifact.artifactId,
            page.flatMap((hit) =>
              hit.symbol && isSymbolKind(hit.symbol.symbolKind)
                ? [
                    {
                      symbolKind: hit.symbol.symbolKind,
                      symbolName: hit.symbol.symbolName,
                      filePath: hit.filePath,
                      line: hit.symbol.line
                    }
                  ]
                : []
            ),
            10
          )
        : undefined;

      if (relations?.length) {
        this.metrics.recordOneHopExpansion(relations.length);
      }
      this.metrics.recordSearchTokenBytesReturned(
        Buffer.byteLength(JSON.stringify({ hits: page, relations }), "utf8")
      );

      return {
        hits: page,
        relations: relations && relations.length > 0 ? relations : undefined,
        nextCursor,
        totalApprox: finalizedHits.totalApprox,
        mappingApplied: artifact.mappingApplied ?? "official"
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
      const content = truncated
        ? Buffer.from(row.content, "utf8").slice(0, maxBytes).toString("utf8")
        : row.content;

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
        mappingApplied: artifact.mappingApplied ?? "official"
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
      const page = this.filesRepo.listFiles(artifact.artifactId, {
        limit,
        cursor: input.cursor,
        prefix: input.prefix
      });
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        mappingApplied: artifact.mappingApplied ?? "official"
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
      const exact = await this.mappingService.resolveMethodMappingExact({
        version,
        kind: "method",
        owner,
        name,
        descriptor: descriptor as string,
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
        details: { includeSnapshots }
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
        details: { fromVersion: requestedFrom }
      });
    }
    if (toIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `toVersion "${requestedTo}" was not found in manifest.`,
        details: { toVersion: requestedTo }
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
          const [officialClassName, officialMethod] = await Promise.all([
            this.resolveToOfficialClassName(
              userClassName,
              version,
              mapping,
              input.sourcePriority,
              warnings
            ),
            this.resolveToOfficialMemberName(
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
            className: officialClassName,
            methodName: officialMethod.name,
            methodDescriptor: officialMethod.descriptor
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
        message: "No Minecraft versions were returned by manifest."
      });
    }

    const chronological = [...manifestOrder].reverse();
    const fromIndex = chronological.indexOf(fromVersion);
    const toIndex = chronological.indexOf(toVersion);

    if (fromIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `fromVersion "${fromVersion}" was not found in manifest.`,
        details: { fromVersion }
      });
    }
    if (toIndex < 0) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `toVersion "${toVersion}" was not found in manifest.`,
        details: { toVersion }
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
    const officialFromClassName = await this.resolveToOfficialClassName(
      className,
      fromVersion,
      mapping,
      input.sourcePriority,
      mappingWarnings
    );
    const officialToClassName =
      fromVersion === toVersion
        ? officialFromClassName
        : await this.resolveToOfficialClassName(
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
      officialClassName: string
    ): Promise<SignatureSnapshot | undefined> => {
      try {
        const signature = await this.explorerService.getSignature({
          fqn: officialClassName,
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
      loadSignature(fromVersion, fromResolved.jarPath, officialFromClassName),
      loadSignature(toVersion, toResolved.jarPath, officialToClassName)
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

    // Remap diff delta members for non-official mappings
    const remapDelta = async (
      delta: DiffClassMemberDelta,
      kind: "field" | "method"
    ): Promise<DiffClassMemberDelta> => {
      const [remappedAdded, remappedRemoved] = await Promise.all([
        this.remapSignatureMembers(delta.added, kind, toVersion, mapping, input.sourcePriority, warnings),
        this.remapSignatureMembers(delta.removed, kind, fromVersion, mapping, input.sourcePriority, warnings)
      ]);
      const remappedModified = await Promise.all(
        delta.modified.map(async (change) => {
          const [fromArr, toArr] = await Promise.all([
            this.remapSignatureMembers([change.from], kind, fromVersion, mapping, input.sourcePriority, warnings),
            this.remapSignatureMembers([change.to], kind, toVersion, mapping, input.sourcePriority, warnings)
          ]);
          return { ...change, from: fromArr[0], to: toArr[0] };
        })
      );
      return { added: remappedAdded, removed: remappedRemoved, modified: remappedModified };
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

  async getClassSource(input: GetClassSourceInput): Promise<GetClassSourceOutput> {
    const className = input.className.trim();
    if (!className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className must be non-empty."
      });
    }

    const startLine = normalizeStrictPositiveInt(input.startLine, "startLine");
    const endLine = normalizeStrictPositiveInt(input.endLine, "endLine");
    const maxLines = normalizeStrictPositiveInt(input.maxLines, "maxLines");
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
        message: "artifactId and targetKind/targetValue are mutually exclusive.",
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
        projectPath: input.projectPath
      });
      artifactId = resolved.artifactId;
      origin = resolved.origin;
      warnings = [...resolved.warnings];
      requestedMapping = resolved.requestedMapping;
      mappingApplied = resolved.mappingApplied;
      provenance = resolved.provenance;
      qualityFlags = [...resolved.qualityFlags];
    } else {
      const artifact = this.getArtifact(artifactId);
      origin = artifact.origin;
      requestedMapping = artifact.requestedMapping ?? requestedMapping;
      mappingApplied = artifact.mappingApplied ?? requestedMapping;
      provenance = artifact.provenance;
      qualityFlags = artifact.qualityFlags;
    }

    const filePath = this.resolveClassFilePath(artifactId, className);
    if (!filePath) {
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: `Source for class "${className}" was not found.`,
        details: {
          artifactId,
          className
        }
      });
    }

    const row = this.filesRepo.getFileContent(artifactId, filePath);
    if (!row) {
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: `Source for class "${className}" was not found.`,
        details: {
          artifactId,
          className,
          filePath
        }
      });
    }

    const lines = row.content.split(/\r?\n/);
    const totalLines = lines.length;
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

    const returnedEnd = normalizedStart + Math.max(0, selectedLines.length - 1);
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
      sourceText: selectedLines.join("\n"),
      totalLines,
      returnedRange: {
        start: normalizedStart,
        end: returnedEnd
      },
      truncated: clippedByRange || clippedByMax,
      origin,
      artifactId,
      requestedMapping,
      mappingApplied,
      provenance: normalizedProvenance,
      qualityFlags,
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
        message: "artifactId and targetKind/targetValue are mutually exclusive.",
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
        allowDecompile: input.allowDecompile
      });
      artifactId = resolved.artifactId;
      origin = resolved.origin;
      warnings.push(...resolved.warnings);
      mappingApplied = resolved.mappingApplied;
      provenance = resolved.provenance;
      qualityFlags = [...resolved.qualityFlags];
      binaryJarPath = resolved.binaryJarPath;
      version = resolved.version;
    } else {
      const artifact = this.getArtifact(artifactId);
      origin = artifact.origin;
      mappingApplied = artifact.mappingApplied ?? requestedMapping;
      provenance = artifact.provenance;
      qualityFlags = artifact.qualityFlags;
      binaryJarPath = artifact.binaryJarPath;
      version = artifact.version;
    }

    if (requestedMapping !== "official" && !version) {
      throw createError({
        code: ERROR_CODES.MAPPING_NOT_APPLIED,
        message: `Non-official mapping "${requestedMapping}" requires a version, but none was resolved.`,
        details: {
          mapping: requestedMapping,
          nextAction: "Resolve with targetKind=version or specify a versioned coordinate."
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
            "Resolve with targetKind=jar or targetKind=version, or use an artifact that has a binary jar."
        }
      });
    }

    const officialClassName =
      version != null
        ? await this.resolveToOfficialClassName(className, version, requestedMapping, input.sourcePriority, warnings)
        : className;

    const signature = await this.explorerService.getSignature({
      fqn: officialClassName,
      jarPath: binaryJarPath,
      access,
      includeSynthetic,
      includeInherited,
      memberPattern: requestedMapping === "official" ? memberPattern : undefined
    });
    warnings.push(...signature.warnings);

    let remappedConstructors =
      version != null
        ? await this.remapSignatureMembers(signature.constructors, "method", version, requestedMapping, input.sourcePriority, warnings)
        : signature.constructors;
    let remappedFields =
      version != null
        ? await this.remapSignatureMembers(signature.fields, "field", version, requestedMapping, input.sourcePriority, warnings)
        : signature.fields;
    let remappedMethods =
      version != null
        ? await this.remapSignatureMembers(signature.methods, "method", version, requestedMapping, input.sourcePriority, warnings)
        : signature.methods;

    // Apply memberPattern post-remap for non-official mappings
    if (requestedMapping !== "official" && memberPattern) {
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
      provenance: normalizedProvenance,
      qualityFlags,
      warnings
    };
  }

  async validateMixin(input: ValidateMixinInput): Promise<ValidateMixinOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
    }
    const source = input.source;
    if (!source.trim()) {
      throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "source must be non-empty." });
    }

    const warnings: string[] = [];
    const requestedMapping = normalizeMapping(input.mapping);

    const { jarPath } = await this.versionService.resolveVersionJar(version);
    const parsed = parseMixinSource(source);

    const targetMembers = new Map<string, ResolvedTargetMembers>();
    for (const target of parsed.targets) {
      let officialName = target.className;

      if (requestedMapping !== "official") {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: target.className,
            sourceMapping: requestedMapping,
            targetMapping: "official",
            sourcePriority: input.sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            officialName = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${target.className}" from ${requestedMapping} to official.`);
          }
        } catch {
          warnings.push(`Mapping lookup failed for class "${target.className}".`);
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: officialName,
          jarPath,
          access: "all"
        });
        warnings.push(...sig.warnings);
        targetMembers.set(target.className, {
          className: target.className,
          constructors: sig.constructors,
          methods: sig.methods,
          fields: sig.fields
        });
      } catch {
        warnings.push(`Could not load signature for class "${officialName}".`);
      }
    }

    return validateParsedMixin(parsed, targetMembers, warnings);
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
    const needsMapping = awNamespace !== "official";

    // Collect unique class FQNs from entries
    const classFqns = new Set<string>();
    for (const entry of parsed.entries) {
      const fqn = entry.target.replace(/\//g, ".");
      classFqns.add(fqn);
    }

    const membersByClass = new Map<string, ResolvedTargetMembers>();
    for (const fqn of classFqns) {
      let officialFqn = fqn;

      if (needsMapping) {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: fqn,
            sourceMapping: awNamespace,
            targetMapping: "official",
            sourcePriority: input.sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            officialFqn = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${fqn}" from ${awNamespace} to official.`);
          }
        } catch {
          warnings.push(`Mapping lookup failed for class "${fqn}".`);
        }
      }

      try {
        const sig = await this.explorerService.getSignature({
          fqn: officialFqn,
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
        warnings.push(`Could not load signature for class "${officialFqn}".`);
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
        mappingApplied: artifact.mappingApplied ?? "official"
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
      mappingApplied: artifact.mappingApplied ?? "official"
    };
  }

  private searchSymbolIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    snippetWindow: SnippetWindow,
    regexPattern: RegExp | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const matchedSymbols = this.findSymbolHits(artifactId, query, match, scope, regexPattern);
    const filePaths = [...new Set(matchedSymbols.map((item) => item.symbol.filePath))];
    const rows = this.filesRepo.getFileContentsByPaths(artifactId, filePaths);
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(rows.length);
    const rowsByPath = new Map(rows.map((row) => [row.filePath, row]));

    for (const item of matchedSymbols) {
      const row = rowsByPath.get(item.symbol.filePath);
      const snippet = row
        ? toContextSnippet(row.content, item.symbol.line, snippetWindow.before, snippetWindow.after, true)
        : {
            startLine: item.symbol.line,
            endLine: item.symbol.line,
            snippet: "",
            truncated: false
          };

      onHit({
        filePath: item.symbol.filePath,
        score: item.score,
        matchedIn: "symbol",
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        snippet: snippet.snippet,
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
    includeDefinition: boolean,
    snippetWindow: SnippetWindow,
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

    const candidateRows: Array<{ filePath: string; content: string; line: number; contentIndex: number }> = [];

    for (const candidate of candidateContentRows) {
      const contentIndex = findContentMatchIndex(candidate.content, query, match);
      if (contentIndex < 0) {
        continue;
      }

      const line = indexToLine(candidate.content, contentIndex);
      candidateRows.push({
        filePath: candidate.filePath,
        content: candidate.content,
        line,
        contentIndex
      });
    }

    const needSymbols = includeDefinition || !!scope?.symbolKind;
    const symbolsByFile = needSymbols
      ? this.symbolsRepo.listSymbolsForFiles(
          artifactId,
          candidateRows.map((candidate) => candidate.filePath),
          scope?.symbolKind
        )
      : new Map<string, SymbolRow[]>();
    if (needSymbols) {
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(
        [...symbolsByFile.values()].reduce((acc, symbols) => acc + symbols.length, 0)
      );
    }

    for (const candidate of candidateRows) {
      // When symbolKind filter is set, skip files that have no symbols of that kind
      if (scope?.symbolKind && !symbolsByFile.has(candidate.filePath)) {
        continue;
      }

      const snippet = toContextSnippet(candidate.content, candidate.line, snippetWindow.before, snippetWindow.after, true);
      const definition = includeDefinition
        ? this.findNearestSymbolFromList(symbolsByFile.get(candidate.filePath) ?? [], candidate.line)
        : undefined;
      const resolvedSymbol = definition ? lineToSymbol(definition) : undefined;

      onHit({
        filePath: candidate.filePath,
        score: scoreTextMatch(match, candidate.contentIndex) + (resolvedSymbol ? 20 : 0),
        matchedIn: "content",
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        snippet: snippet.snippet,
        reasonCodes: ["content_match", `text_${match}`, "indexed"],
        symbol: resolvedSymbol
      });
    }
  }

  private searchPathIntentIndexed(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    includeDefinition: boolean,
    snippetWindow: SnippetWindow,
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

    const candidateContentRows = this.filesRepo.getFileContentsByPaths(
      artifactId,
      candidateRows.map((candidate) => candidate.filePath)
    );
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(candidateContentRows.length);
    const contentByPath = new Map(candidateContentRows.map((row) => [row.filePath, row.content]));

    const needSymbols = includeDefinition || !!scope?.symbolKind;
    const symbolsByFile = needSymbols
      ? this.symbolsRepo.listSymbolsForFiles(
          artifactId,
          candidateRows.map((candidate) => candidate.filePath),
          scope?.symbolKind
        )
      : new Map<string, SymbolRow[]>();
    if (needSymbols) {
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(
        [...symbolsByFile.values()].reduce((acc, symbols) => acc + symbols.length, 0)
      );
    }

    for (const candidate of candidateRows) {
      const content = contentByPath.get(candidate.filePath);
      if (!content) {
        continue;
      }
      // When symbolKind filter is set, skip files that have no symbols of that kind
      if (scope?.symbolKind && !symbolsByFile.has(candidate.filePath)) {
        continue;
      }
      const definition = includeDefinition
        ? this.findNearestSymbolFromList(symbolsByFile.get(candidate.filePath) ?? [], 1)
        : undefined;
      const centerLine = definition?.line ?? 1;
      const snippet = toContextSnippet(content, centerLine, snippetWindow.before, snippetWindow.after, true);
      const resolvedSymbol = definition ? lineToSymbol(definition) : undefined;

      onHit({
        filePath: candidate.filePath,
        score: scorePathMatch(match, candidate.pathIndex) + (resolvedSymbol ? 10 : 0),
        matchedIn: "path",
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        snippet: snippet.snippet,
        reasonCodes: ["path_match", `path_${match}`, "indexed"],
        symbol: resolvedSymbol
      });
    }
  }

  private searchTextIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    includeDefinition: boolean,
    snippetWindow: SnippetWindow,
    regexPattern: RegExp | undefined,
    onHit: (hit: SearchSourceHit) => void
  ): void {
    const filePaths = this.loadScopedFilePaths(artifactId, scope);
    const pageSize = Math.max(1, this.config.searchScanPageSize ?? 250);

    for (const chunk of chunkArray(filePaths, pageSize)) {
      const rows = this.filesRepo.getFileContentsByPaths(artifactId, chunk);
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(rows.length);

      const symbolsByFile = includeDefinition
        ? this.symbolsRepo.listSymbolsForFiles(
            artifactId,
            rows.map((row) => row.filePath),
            scope?.symbolKind
          )
        : new Map<string, SymbolRow[]>();
      if (includeDefinition) {
        this.metrics.recordSearchDbRoundtrip();
        this.metrics.recordSearchRowsScanned(
          [...symbolsByFile.values()].reduce((acc, symbols) => acc + symbols.length, 0)
        );
      }

      for (const row of rows) {
        const contentIndex =
          match === "regex"
            ? matchRegexIndex(row.content, regexPattern as RegExp)
            : findContentMatchIndex(row.content, query, match);
        if (contentIndex < 0) {
          continue;
        }

        const line = indexToLine(row.content, contentIndex);
        const snippet = toContextSnippet(row.content, line, snippetWindow.before, snippetWindow.after, true);
        const definition = includeDefinition
          ? this.findNearestSymbolFromList(symbolsByFile.get(row.filePath) ?? [], line)
          : undefined;
        const resolvedSymbol = definition ? lineToSymbol(definition) : undefined;

        onHit({
          filePath: row.filePath,
          score: scoreTextMatch(match, contentIndex) + (resolvedSymbol ? 20 : 0),
          matchedIn: "content",
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          snippet: snippet.snippet,
          reasonCodes: ["content_match", `text_${match}`],
          symbol: resolvedSymbol
        });
      }
    }
  }

  private searchPathIntent(
    artifactId: string,
    query: string,
    match: SearchMatch,
    scope: SearchScope | undefined,
    includeDefinition: boolean,
    snippetWindow: SnippetWindow,
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
      const rows = this.filesRepo.getFileContentsByPaths(
        artifactId,
        chunk.map((item) => item.filePath)
      );
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(rows.length);
      const contentByPath = new Map(rows.map((row) => [row.filePath, row.content]));

      const symbolsByFile = includeDefinition
        ? this.symbolsRepo.listSymbolsForFiles(
            artifactId,
            chunk.map((item) => item.filePath),
            scope?.symbolKind
          )
        : new Map<string, SymbolRow[]>();
      if (includeDefinition) {
        this.metrics.recordSearchDbRoundtrip();
        this.metrics.recordSearchRowsScanned(
          [...symbolsByFile.values()].reduce((acc, symbols) => acc + symbols.length, 0)
        );
      }

      for (const candidate of chunk) {
        const content = contentByPath.get(candidate.filePath);
        if (!content) {
          continue;
        }

        const definition = includeDefinition
          ? this.findNearestSymbolFromList(symbolsByFile.get(candidate.filePath) ?? [], 1)
          : undefined;
        const centerLine = definition?.line ?? 1;
        const snippet = toContextSnippet(content, centerLine, snippetWindow.before, snippetWindow.after, true);
        const resolvedSymbol = definition ? lineToSymbol(definition) : undefined;

        onHit({
          filePath: candidate.filePath,
          score: scorePathMatch(match, candidate.pathIndex) + (resolvedSymbol ? 10 : 0),
          matchedIn: "path",
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          snippet: snippet.snippet,
          reasonCodes: ["path_match", `path_${match}`],
          symbol: resolvedSymbol
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
    const scopedFilesBySymbolKind = scope?.symbolKind
      ? new Set(this.symbolsRepo.listDistinctFilePathsByKind(artifactId, scope.symbolKind))
      : undefined;
    if (scopedFilesBySymbolKind) {
      this.metrics.recordSearchDbRoundtrip();
      this.metrics.recordSearchRowsScanned(scopedFilesBySymbolKind.size);
    }

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
        if (scopedFilesBySymbolKind && !scopedFilesBySymbolKind.has(filePath)) {
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

  private findNearestSymbolForLine(
    artifactId: string,
    filePath: string,
    line: number,
    symbolKind?: SymbolKind
  ): SymbolRow | undefined {
    const symbols = this.symbolsRepo
      .listSymbolsForFile(artifactId, filePath)
      .filter((symbol) => (symbolKind ? symbol.symbolKind === symbolKind : true));
    return this.findNearestSymbolFromList(symbols, line);
  }

  private findNearestSymbolFromList(symbols: SymbolRow[], line: number): SymbolRow | undefined {
    let best: SymbolRow | undefined;
    for (const symbol of symbols) {
      if (symbol.line > line) {
        continue;
      }
      if (!best || symbol.line >= best.line) {
        best = symbol;
      }
    }

    return best ?? symbols[0];
  }

  private buildOneHopRelations(
    artifactId: string,
    roots: Array<{
      symbolKind: SymbolKind;
      symbolName: string;
      filePath: string;
      line: number;
    }>,
    maxRelations: number
  ): SearchRelation[] {
    if (roots.length === 0 || maxRelations <= 0) {
      return [];
    }

    const rootRows = this.filesRepo.getFileContentsByPaths(
      artifactId,
      roots.map((root) => root.filePath)
    );
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(rootRows.length);
    const rootRowsByPath = new Map(rootRows.map((row) => [row.filePath, row]));

    const rootTokens = roots.map((root) => {
      const contentRow = rootRowsByPath.get(root.filePath);
      if (!contentRow) {
        return {
          root,
          calls: [] as string[],
          types: [] as string[],
          imports: [] as string[]
        };
      }
      const aroundRoot = toContextSnippet(contentRow.content, root.line, 2, 3, false).snippet;
      return {
        root,
        calls: Array.from(aroundRoot.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g))
          .map((match) => match[1])
          .filter((token): token is string => Boolean(token)),
        types: Array.from(aroundRoot.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g))
          .map((match) => match[1])
          .filter((token): token is string => Boolean(token)),
        imports: Array.from(aroundRoot.matchAll(/import\s+([\w.$]+);/g))
          .map((match) => match[1]?.split(".").at(-1))
          .filter((token): token is string => Boolean(token))
      };
    });

    const tokenSet = new Set<string>();
    for (const entry of rootTokens) {
      for (const token of entry.calls) {
        tokenSet.add(toLower(token));
      }
      for (const token of entry.types) {
        tokenSet.add(toLower(token));
      }
      for (const token of entry.imports) {
        tokenSet.add(toLower(token));
      }
    }

    const matchedSymbols = this.symbolsRepo
      .findBySymbolNames(artifactId, [...tokenSet])
      .filter((symbol) => isSymbolKind(symbol.symbolKind));
    this.metrics.recordSearchDbRoundtrip();
    this.metrics.recordSearchRowsScanned(matchedSymbols.length);

    const symbolMap = new Map<string, SymbolRow[]>();
    for (const symbol of matchedSymbols) {
      const key = toLower(symbol.symbolName);
      const bucket = symbolMap.get(key) ?? [];
      bucket.push(symbol);
      symbolMap.set(key, bucket);
    }

    const dedupe = new Set<string>();
    const relations: SearchRelation[] = [];

    for (const entry of rootTokens) {
      const root = entry.root;
      const attach = (
        token: string,
        relationKind: SearchRelation["relation"]
      ): void => {
        const matches = symbolMap.get(toLower(token)) ?? [];
        for (const target of matches) {
          if (!isSymbolKind(target.symbolKind)) {
            continue;
          }
          if (
            target.filePath === root.filePath &&
            target.line === root.line &&
            target.symbolName === root.symbolName &&
            target.symbolKind === root.symbolKind
          ) {
            continue;
          }

          const key = `${root.symbolKind}:${root.symbolName}:${root.filePath}:${root.line}->${target.symbolKind}:${target.symbolName}:${target.filePath}:${target.line}:${relationKind}`;
          if (dedupe.has(key)) {
            continue;
          }
          dedupe.add(key);

          relations.push({
            fromSymbol: {
              symbolKind: root.symbolKind,
              symbolName: root.symbolName,
              filePath: root.filePath,
              line: root.line
            },
            toSymbol: {
              symbolKind: target.symbolKind,
              symbolName: target.symbolName,
              filePath: target.filePath,
              line: target.line
            },
            relation: relationKind
          });

          if (relations.length >= maxRelations) {
            return;
          }
        }
      };

      for (const token of entry.calls) {
        attach(token, "calls");
        if (relations.length >= maxRelations) {
          return relations;
        }
      }

      for (const token of entry.types) {
        attach(token, "uses-type");
        if (relations.length >= maxRelations) {
          return relations;
        }
      }

      for (const token of entry.imports) {
        attach(token, "imports");
        if (relations.length >= maxRelations) {
          return relations;
        }
      }
    }

    return relations;
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

  private async resolveToOfficialClassName(
    className: string,
    version: string,
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<string> {
    if (mapping === "official") {
      return className;
    }
    try {
      const mapped = await this.mappingService.findMapping({
        version,
        kind: "class",
        name: className,
        sourceMapping: mapping,
        targetMapping: "official",
        sourcePriority
      });
      if (mapped.resolved && mapped.resolvedSymbol) {
        return mapped.resolvedSymbol.name;
      }
      warnings.push(`Could not map class "${className}" from ${mapping} to official.`);
    } catch {
      warnings.push(`Mapping lookup failed for class "${className}".`);
    }
    return className;
  }

  private async resolveToOfficialMemberName(
    name: string,
    ownerInSourceMapping: string,
    descriptor: string | undefined,
    kind: "field" | "method",
    version: string,
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<{ name: string; descriptor?: string }> {
    if (mapping === "official") {
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
        targetMapping: "official",
        sourcePriority
      });
      if (mapped.resolved && mapped.resolvedSymbol) {
        return {
          name: mapped.resolvedSymbol.name,
          descriptor: kind === "method" ? mapped.resolvedSymbol.descriptor ?? descriptor : undefined
        };
      }
      warnings.push(`Could not map ${kind} "${name}" from ${mapping} to official.`);
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
    mapping: SourceMapping,
    sourcePriority: MappingSourcePriority | undefined,
    warnings: string[]
  ): Promise<SignatureMember[]> {
    if (mapping === "official") {
      return members;
    }

    // Build deduplicated lookup tables for member names and owner FQNs
    const memberKeyToRemapped = new Map<string, string>();
    const ownerToRemapped = new Map<string, string>();

    for (const member of members) {
      const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
      if (!memberKeyToRemapped.has(memberKey)) {
        memberKeyToRemapped.set(memberKey, member.name); // default = official name
      }
      if (!ownerToRemapped.has(member.ownerFqn)) {
        ownerToRemapped.set(member.ownerFqn, member.ownerFqn); // default = official FQN
      }
    }

    // Remap unique member names
    const memberEntries = [...memberKeyToRemapped.entries()];
    await Promise.all(
      memberEntries.map(async ([key, _officialName]) => {
        const [ownerFqn, name, descriptor] = key.split("\0");
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind,
            name,
            owner: ownerFqn,
            descriptor: kind === "method" ? descriptor : undefined,
            sourceMapping: "official",
            targetMapping: mapping,
            sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            memberKeyToRemapped.set(key, mapped.resolvedSymbol.name);
          } else {
            warnings.push(`Could not remap ${kind} "${name}" to ${mapping}.`);
          }
        } catch {
          warnings.push(`Remap failed for ${kind} "${name}".`);
        }
      })
    );

    // Remap unique owner FQNs
    const ownerEntries = [...ownerToRemapped.entries()];
    await Promise.all(
      ownerEntries.map(async ([officialFqn]) => {
        try {
          const mapped = await this.mappingService.findMapping({
            version,
            kind: "class",
            name: officialFqn,
            sourceMapping: "official",
            targetMapping: mapping,
            sourcePriority
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            ownerToRemapped.set(officialFqn, mapped.resolvedSymbol.name);
          }
        } catch {
          // keep official FQN as fallback
        }
      })
    );

    return members.map((member) => {
      const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
      return {
        ...member,
        name: memberKeyToRemapped.get(memberKey) ?? member.name,
        ownerFqn: ownerToRemapped.get(member.ownerFqn) ?? member.ownerFqn
      };
    });
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
        details: { artifactId: resolved.artifactId }
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
        details: { artifactId }
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
