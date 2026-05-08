import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fastGlob from "fast-glob";

import { buildSuggestedCall } from "./build-suggested-call.js";
import { createError, ERROR_CODES } from "./errors.js";
import { buildVersionSourceSearchRoots, normalizeOptionalProjectPath } from "./gradle-paths.js";
import { defaultDownloadPath, downloadToCache } from "./repo-downloader.js";
import { collectMatchedJarEntriesAsUtf8, readJarEntryAsUtf8 } from "./source-jar-reader.js";
import type { Config, MappingSourcePriority, SourceMapping } from "./types.js";
import { VersionService, isUnobfuscatedVersion, type ResolvedVersionMappings } from "./version-service.js";
import type {
  DirectionIndex,
  MappingLookupSource,
  MappingSymbolKind,
  MappingSymbolRecord,
  PairKey,
  PairRecord
} from "./mapping/internal-types.js";
import {
  addLookupEntries,
  addToSetMap,
  buildSymbolKey,
  classNameParts,
  createClassSymbolRecord,
  createDirectionIndex,
  createFieldSymbolRecord,
  createMethodSymbolRecord,
  exactLookupKeys,
  mergeDirectionIndexes,
  normalizedVariants,
  normalizeMappedSymbolOutput,
  parseFieldName,
  parseInputSymbol,
  parseMethodName,
  registerRecord,
  simpleLookupKeys,
  simpleName,
  splitOwnerAndName,
  stripLineInfo
} from "./mapping/parsers/symbol-records.js";
import {
  buildAdjacency,
  buildTargetRecordIndex,
  ensurePairIndex,
  pairKey,
  parsePairKey
} from "./mapping/parsers/normalize.js";
import {
  PROGUARD_PRIMITIVES,
  parseClientMappings,
  parseProguardMethod,
  proguardTypeToJvm
} from "./mapping/parsers/proguard.js";
import {
  addPairRecords,
  normalizeTinyNamespace,
  parseTinyMappings
} from "./mapping/parsers/tiny.js";
import type {
  CandidateAccumulator,
  GraphLoadMode,
  LoadedGraph,
  MatchRankKey
} from "./mapping/internal-types.js";
import {
  DESCRIPTOR_FALLBACK_CONFIDENCE,
  MATCH_RANK,
  MAX_CANDIDATES
} from "./mapping/internal-types.js";
import {
  addCandidates,
  applyDisambiguationHints,
  clampCandidateLimit,
  clampRowLimit,
  collectTargetRecords,
  consumeFieldType,
  effectiveLoomSearchProjectPath,
  inferAmbiguityReasons,
  invalidInputError,
  isValidMethodDescriptor,
  limitResolutionCandidates,
  lookupCandidates,
  mappingPriorityFromInput,
  mappingSourceOrder,
  namespacePath,
  normalizeDescriptorHint,
  normalizeIncludedKinds,
  normalizeMemberName,
  normalizeMethodDescriptor,
  normalizeOwnerHint,
  normalizeQuerySymbol,
  pathToTransformChain,
  pathUsesSource,
  projectLookupCandidateDescriptor,
  requiresOnlyObfuscatedMojangGraph,
  toLookupCandidate,
  toResolutionCandidate,
  toSymbolReference
} from "./mapping/lookup.js";
import type {
  ClassApiMatrixEntry,
  ClassApiMatrixInput,
  ClassApiMatrixKind,
  ClassApiMatrixOutput,
  ClassApiMatrixRow,
  DescriptorProjection,
  EnsureMappingAvailableInput,
  EnsureMappingAvailableOutput,
  FindMappingInput,
  FindMappingOutput,
  MappingLookupCandidate,
  MappingLookupProvenance,
  MappingMatchKind,
  ResolveMethodMappingExactInput,
  ResolveMethodMappingExactOutput,
  ResolutionCandidate,
  SymbolExistenceInput,
  SymbolExistenceOutput,
  SymbolQueryInput,
  SymbolQueryKind,
  SymbolReference,
  SymbolResolutionOutput,
  SymbolResolutionStatus
} from "./mapping/types.js";

export type {
  ClassApiMatrixEntry,
  ClassApiMatrixInput,
  ClassApiMatrixKind,
  ClassApiMatrixOutput,
  ClassApiMatrixRow,
  EnsureMappingAvailableInput,
  EnsureMappingAvailableOutput,
  FindMappingInput,
  FindMappingOutput,
  MappingLookupCandidate,
  MappingLookupProvenance,
  MappingMatchKind,
  ResolveMethodMappingExactInput,
  ResolveMethodMappingExactOutput,
  SymbolExistenceInput,
  SymbolExistenceOutput,
  SymbolQueryInput,
  SymbolQueryKind,
  SymbolReference,
  SymbolResolutionOutput,
  SymbolResolutionStatus
} from "./mapping/types.js";

const SUPPORTED_MAPPINGS: ReadonlySet<SourceMapping> = new Set([
  "obfuscated",
  "mojang",
  "intermediary",
  "yarn"
]);

const GLOB_SPECIAL_CHARS = /[\\!*+?()[\]{}@|]/g;

type VersionMappingsResolver = Pick<VersionService, "resolveVersionMappings">;


/* parsers extracted to src/mapping/parsers/{symbol-records,normalize,proguard,tiny}.ts */


export class MappingService {
  private readonly config: Config;
  private readonly versionService: VersionMappingsResolver;
  private readonly fetchFn: typeof fetch;
  private readonly graphCache = new Map<string, LoadedGraph>();
  private readonly buildLocks = new Map<string, Promise<LoadedGraph>>();
  private readonly resolutionCache = new Map<string, { result: FindMappingOutput; cachedAt: number }>();
  private static readonly RESOLUTION_CACHE_MAX = 512;
  private static readonly RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
  private resolutionCacheHits = 0;
  private resolutionCacheMisses = 0;

  get resolutionCacheStats() {
    return {
      hits: this.resolutionCacheHits,
      misses: this.resolutionCacheMisses,
      size: this.resolutionCache.size
    };
  }

  constructor(
    config: Config,
    versionService: VersionMappingsResolver = new VersionService(config),
    fetchFn: typeof fetch = globalThis.fetch
  ) {
    this.config = config;
    this.versionService = versionService;
    this.fetchFn = fetchFn;
  }

  async findMapping(input: FindMappingInput): Promise<FindMappingOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }

    // Normalize the effective signatureMode exactly once so every downstream path — query
    // symbol normalization, the strict-overload filter, the cache key, and warning text —
    // sees the same value. The public tool schema defaults to "name-only", so an omitted
    // signatureMode reaching the service (e.g. internal callers, MCP resource handlers, the
    // resolution cache) must default to "name-only" too, otherwise the service contradicts
    // the advertised default and silently reverts to the old descriptor-required path.
    // Callers that genuinely need strict descriptor matching pass `signatureMode: "exact"`
    // explicitly.
    const effectiveSignatureMode: "exact" | "name-only" = input.signatureMode ?? "name-only";

    const { record: queryRecord, querySymbol } = normalizeQuerySymbol(input, effectiveSignatureMode, {
      allowShortClassName: input.kind === "class" && input.sourceMapping === "obfuscated"
    });

    const cacheKey = this.buildResolutionCacheKey(version, input, querySymbol, effectiveSignatureMode);
    const cached = this.resolutionCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < MappingService.RESOLUTION_CACHE_TTL_MS) {
      this.resolutionCacheHits += 1;
      return cached.result;
    }
    this.resolutionCacheMisses += 1;

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair for lookup.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      targetMapping,
      sourcePriorityApplied: priority
    } satisfies FindMappingOutput["mappingContext"];

    if (sourceMapping === targetMapping) {
      const identity = toResolutionCandidate({
        ...toLookupCandidate(queryRecord),
        matchKind: "exact",
        confidence: 1
      });
      const limited = limitResolutionCandidates([identity], input.maxCandidates);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: querySymbol,
        candidates: limited.candidates,
        candidateCount: limited.candidateCount,
        candidatesTruncated: limited.candidatesTruncated,
        warnings: []
      };
    }

    const graph = await this.loadGraph(
      version,
      priority,
      requiresOnlyObfuscatedMojangGraph(sourceMapping, targetMapping) ? "obfuscated-mojang-only" : "full",
      input.projectPath
    );
    const path = namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: [
          `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`
        ]
      };
    }

    const descriptorProjection =
      queryRecord.kind === "method" && queryRecord.descriptor
        ? this.projectMethodDescriptorToTarget(graph, path, queryRecord.descriptor)
        : undefined;
    // Partial projections are still useful for comparison: projectMethodDescriptorToTarget
    // leaves unmapped `L...;` references unchanged, so JDK / external classes pass through
    // while Minecraft class references get rewritten to the target namespace. Using the
    // projected descriptor even when `complete === false` produces descriptors shaped like
    // the stored records (`(Lnet/minecraft/class_1799;Ljava/lang/String;)V`) and avoids
    // false negatives for the very common mixed MC + JDK descriptor shape.
    const projectedDescriptor =
      descriptorProjection?.hadClassReferences ? descriptorProjection.descriptor : undefined;
    let rawCandidates = this
      .mapCandidatesAlongPath(graph, path, queryRecord)
      .map((candidate) =>
        queryRecord.kind === "method" && queryRecord.descriptor
          ? projectLookupCandidateDescriptor(candidate, queryRecord.descriptor, projectedDescriptor)
          : candidate
      );
    const warnings: string[] = [];
    // signatureMode="exact" on kind=method must not return descriptorless fallback candidates
    // (lookupCandidates adds owner+name fallbacks by design for the loose path). Without this
    // filter a caller who supplied `foo(I)V` could be told `foo(Z)V` is the exact mapping,
    // which would be wrong for migration tooling. Mirror resolveMethodMappingExact's strict
    // behavior: keep only candidates whose descriptor equals the (projected) requested
    // descriptor. If nothing passes, the normal "candidates.length === 0 -> not_found" path
    // takes over. Partial projection is accepted here for the same reason as above — we do
    // not reject mixed MC + JDK descriptors as mapping_unavailable just because the JDK
    // class reference was not in the mapping graph.
    if (
      queryRecord.kind === "method" &&
      queryRecord.descriptor &&
      effectiveSignatureMode === "exact"
    ) {
      // Tiny v2 stores a single descriptor per method entry (typically in the obfuscated
      // namespace) and shares it across every column, while client mappings attach a mojang
      // descriptor on the mojang side and an obfuscated descriptor on the obfuscated side.
      // In multi-hop paths (e.g. mojang -> obfuscated -> intermediary -> yarn) the final
      // candidate's owner and name live in the target namespace but its descriptor can still
      // be the obfuscated form that rode along the Tiny hop. A strict filter that compared
      // only against the fully projected target descriptor dropped those valid candidates
      // and produced false `not_found` for common Mojang -> Yarn lookups. Accept any
      // candidate whose descriptor matches the caller's descriptor, the target-space
      // projection, or the obfuscated-space projection — the three forms that actually
      // appear in the mapping graph.
      const strictDescriptor = projectedDescriptor ?? queryRecord.descriptor;
      const acceptedDescriptors = new Set<string>([queryRecord.descriptor, strictDescriptor]);
      const toObfuscatedPath = namespacePath(graph, sourceMapping, "obfuscated");
      if (toObfuscatedPath) {
        const obfuscatedProjection = this.projectMethodDescriptorToTarget(
          graph,
          toObfuscatedPath,
          queryRecord.descriptor
        );
        acceptedDescriptors.add(obfuscatedProjection.descriptor);
      }
      rawCandidates = rawCandidates.filter(
        (candidate) =>
          candidate.descriptor !== undefined && acceptedDescriptors.has(candidate.descriptor)
      );
    }
    const disambiguatedCandidates = applyDisambiguationHints(rawCandidates, input.disambiguation);
    if (rawCandidates.length > disambiguatedCandidates.length) {
      warnings.push(
        `Disambiguation hints narrowed candidates from ${rawCandidates.length} to ${disambiguatedCandidates.length}.`
      );
    }
    const candidates = disambiguatedCandidates.map(toResolutionCandidate);
    const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);
    if (
      queryRecord.kind === "method" &&
      queryRecord.descriptor &&
      pathUsesSource(graph.pairs, path, "mojang-client-mappings") &&
      candidates.length !== 1
    ) {
      warnings.push(
        "Method descriptor could not be preserved through mojang-client-mappings and may have used name-based fallback."
      );
    }
    if (candidates.length === 0) {
      warnings.push("No mapping candidate matched the input symbol.");
    } else if (candidates.length > 1) {
      warnings.push(
        `Ambiguous mapping: ${candidates.length} candidates matched. Provide a stricter symbol input or disambiguation hints.`
      );
      if (queryRecord.kind === "method") {
        // find-mapping defaults to signatureMode="name-only", which discards any supplied
        // descriptor. Telling the caller to "add descriptor" would be ineffective unless they
        // also switch mode, so we point to the exact alternatives instead.
        warnings.push(
          "Retry with signatureMode=\"exact\" plus a JVM descriptor, or pass disambiguation.descriptorHint, or raise maxCandidates up to 200 to inspect the full candidate list."
        );
      } else {
        warnings.push(
          "Raise maxCandidates up to 200 to inspect the full candidate list, or use disambiguation.ownerHint to narrow the search."
        );
      }
    }

    const status: SymbolResolutionStatus =
      candidates.length === 0 ? "not_found" : candidates.length === 1 ? "resolved" : "ambiguous";

    const ambiguityReasons =
      candidates.length > 1
        ? inferAmbiguityReasons(candidates, pathUsesSource(graph.pairs, path, "mojang-client-mappings"))
        : undefined;

    const output: FindMappingOutput = {
      querySymbol,
      mappingContext,
      resolved: status === "resolved",
      status,
      resolvedSymbol: status === "resolved" ? candidates[0] : undefined,
      candidates: limitedCandidates.candidates,
      candidateCount: limitedCandidates.candidateCount,
      candidatesTruncated: limitedCandidates.candidatesTruncated,
      warnings,
      provenance: this.provenanceForPath(graph, path),
      ambiguityReasons
    };
    this.resolutionCache.set(cacheKey, { result: output, cachedAt: Date.now() });
    this.trimResolutionCache();
    return output;
  }

  async ensureMappingAvailable(input: EnsureMappingAvailableInput): Promise<EnsureMappingAvailableOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    if (sourceMapping === targetMapping) {
      return {
        transformChain: [`mapping:${sourceMapping}->${targetMapping}`],
        warnings: []
      };
    }

    const graph = await this.loadGraph(
      version,
      priority,
      requiresOnlyObfuscatedMojangGraph(sourceMapping, targetMapping) ? "obfuscated-mojang-only" : "full",
      input.projectPath
    );
    const path = namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`,
        details: {
          version,
          sourceMapping,
          targetMapping,
          sourcePriority: priority,
          nextAction: "Try mapping=obfuscated which is always available.",
          ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
        }
      });
    }

    const provenance = this.provenanceForPath(graph, path);
    const transformChain = [
      provenance ? `mapping-source:${provenance.source}` : undefined,
      ...pathToTransformChain(path)
    ].filter((entry): entry is string => Boolean(entry));

    return {
      transformChain,
      warnings: [...graph.warnings],
      provenance
    };
  }

  async resolveMethodMappingExact(
    input: ResolveMethodMappingExactInput
  ): Promise<ResolveMethodMappingExactOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }
    const { record: queryRecord, querySymbol } = normalizeQuerySymbol({
      ...input,
      kind: "method"
    });
    const owner = queryRecord.owner as string;
    const method = queryRecord.name;
    const descriptor = queryRecord.descriptor as string;

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair for exact method resolution.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      targetMapping,
      sourcePriorityApplied: priority
    } satisfies ResolveMethodMappingExactOutput["mappingContext"];

    if (sourceMapping === targetMapping) {
      const resolvedCandidate = toResolutionCandidate({
        ...toLookupCandidate(queryRecord),
        matchKind: "exact",
        confidence: 1
      });
      const limited = limitResolutionCandidates([resolvedCandidate], input.maxCandidates);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: resolvedCandidate,
        candidates: limited.candidates,
        candidateCount: limited.candidateCount,
        candidatesTruncated: limited.candidatesTruncated,
        warnings: []
      };
    }

    const graph = await this.loadGraph(
      version,
      priority,
      requiresOnlyObfuscatedMojangGraph(sourceMapping, targetMapping) ? "obfuscated-mojang-only" : "full",
      input.projectPath
    );
    const path = namespacePath(graph, sourceMapping, targetMapping);

    if (!path) {
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: [
          `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`
        ]
      };
    }

    const warnings: string[] = [];
    const descriptorProjection = this.projectMethodDescriptorToTarget(graph, path, descriptor);
    const projectedDescriptor =
      descriptorProjection.complete ? descriptorProjection.descriptor : undefined;
    const rawCandidates = this
      .mapCandidatesAlongPath(graph, path, queryRecord)
      .filter((candidate) => candidate.kind === "method")
      .map((candidate) => projectLookupCandidateDescriptor(candidate, descriptor, projectedDescriptor));
    const candidates = rawCandidates.map(toResolutionCandidate);
    const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);

    const strictDescriptor = projectedDescriptor ?? descriptor;
    const strictCandidates = rawCandidates.filter((candidate) => candidate.descriptor === strictDescriptor);
    if (strictCandidates.length === 1) {
      const resolved = toResolutionCandidate(strictCandidates[0]!);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: resolved,
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    if (strictCandidates.length > 1) {
      warnings.push("Exact method mapping is ambiguous for owner+method+descriptor.");
      if (limitedCandidates.candidatesTruncated) {
        warnings.push(
          "Raise maxCandidates up to 200 to inspect the full candidate list, or narrow the lookup via find-mapping disambiguation hints."
        );
      }
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "ambiguous",
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    if (descriptorProjection.hadClassReferences && !descriptorProjection.complete) {
      warnings.push(
        pathUsesSource(graph.pairs, path, "mojang-client-mappings")
          ? "Method descriptor could not be preserved through mojang-client-mappings and exact resolution is unavailable."
          : "Method descriptor could not be fully remapped across the mapping path and exact resolution is unavailable."
      );
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    return {
      querySymbol,
      mappingContext,
      resolved: false,
      status: "not_found",
      candidates: limitedCandidates.candidates,
      candidateCount: limitedCandidates.candidateCount,
      candidatesTruncated: limitedCandidates.candidatesTruncated,
      warnings,
      provenance: this.provenanceForPath(graph, path)
    };
  }

  async getClassApiMatrix(input: ClassApiMatrixInput): Promise<ClassApiMatrixOutput> {
    const version = input.version.trim();
    const className = normalizeMappedSymbolOutput(input.className.trim());
    if (!version || !className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version and className must be non-empty strings.",
        details: {
          version: input.version,
          className: input.className
        }
      });
    }

    const classNameMapping = input.classNameMapping;
    if (!SUPPORTED_MAPPINGS.has(classNameMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported classNameMapping.",
        details: {
          classNameMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const graph = await this.loadGraph(version, priority, "full");
    const warnings = [...graph.warnings];
    const includeKinds = normalizeIncludedKinds(input.includeKinds);
    const pathCache = new Map<PairKey, SourceMapping[] | undefined>();
    const resolvePath = (
      sourceMapping: SourceMapping,
      targetMapping: SourceMapping
    ): SourceMapping[] | undefined => {
      if (sourceMapping === targetMapping) {
        return [sourceMapping];
      }
      const key = pairKey(sourceMapping, targetMapping);
      if (pathCache.has(key)) {
        return pathCache.get(key);
      }
      const path = namespacePath(graph, sourceMapping, targetMapping);
      pathCache.set(key, path);
      return path;
    };

    const classByMapping: Partial<Record<SourceMapping, MappingSymbolRecord>> = {
      [classNameMapping]: createClassSymbolRecord(className)
    };

    for (const mapping of SUPPORTED_MAPPINGS) {
      if (mapping === classNameMapping) {
        continue;
      }
      const mapped = this.mapRecordBetweenMappings(
        graph,
        classNameMapping,
        mapping,
        classByMapping[classNameMapping] as MappingSymbolRecord,
        resolvePath(classNameMapping, mapping)
      );
      if (mapped.length > 1) {
        const competing = mapped.slice(0, 5).map((c) => c.symbol);
        warnings.push(`Class identity mapping to ${mapping} is ambiguous for "${className}": competing=[${competing.join(", ")}].`);
      }
      if (mapped.length > 0) {
        classByMapping[mapping] = mapped[0];
      }
    }

    const baseMapping: SourceMapping = classNameMapping;
    const baseClass = classByMapping[baseMapping];
    if (!baseClass) {
      return {
        version,
        className,
        classNameMapping,
        classIdentity: {
          obfuscated: classByMapping.obfuscated?.symbol,
          mojang: classByMapping.mojang?.symbol,
          intermediary: classByMapping.intermediary?.symbol,
          yarn: classByMapping.yarn?.symbol
        },
        rows: [],
        rowCount: 0,
        warnings
      };
    }

    const baseRecords = collectTargetRecords(graph, baseMapping).filter((record) => {
      if (record.kind === "class") {
        return includeKinds.has("class") && record.symbol === baseClass.symbol;
      }
      if (record.owner !== baseClass.symbol) {
        return false;
      }
      if (record.kind === "field") {
        return includeKinds.has("field");
      }
      return includeKinds.has("method");
    });

    const rows: ClassApiMatrixRow[] = [];
    let ambiguousRowCount = 0;
    const rowSeen = new Set<string>();
    const rowKindOrder: Record<ClassApiMatrixKind, number> = {
      class: 0,
      field: 1,
      method: 2
    };
    const sortedBase = [...baseRecords].sort((left, right) => {
      const leftKind = rowKindOrder[left.kind];
      const rightKind = rowKindOrder[right.kind];
      if (leftKind !== rightKind) {
        return leftKind - rightKind;
      }
      if ((left.descriptor ?? "") !== (right.descriptor ?? "")) {
        return (left.descriptor ?? "").localeCompare(right.descriptor ?? "");
      }
      return left.symbol.localeCompare(right.symbol);
    });

    for (const baseRecord of sortedBase) {
      const key = buildSymbolKey(baseRecord);
      if (rowSeen.has(key)) {
        continue;
      }
      rowSeen.add(key);
      let rowHadAmbiguity = false;

      const row: ClassApiMatrixRow = {
        kind: baseRecord.kind,
        descriptor: baseRecord.descriptor,
        completeness: false
      };

      for (const mapping of SUPPORTED_MAPPINGS) {
        const classIdentity = classByMapping[mapping];
        let resolved: MappingSymbolRecord | undefined;
        if (mapping === baseMapping) {
          resolved = baseRecord;
        } else {
          const mapped = this.mapRecordBetweenMappings(
            graph,
            baseMapping,
            mapping,
            baseRecord,
            resolvePath(baseMapping, mapping)
          );
          let filtered = mapped;
          if (baseRecord.kind !== "class" && classIdentity) {
            filtered = filtered.filter((candidate) => candidate.owner === classIdentity.symbol);
          }
          if (baseRecord.kind === "method" && baseRecord.descriptor) {
            const descriptorMatched = filtered.filter(
              (candidate) => candidate.descriptor === baseRecord.descriptor
            );
            if (descriptorMatched.length > 0) {
              filtered = descriptorMatched;
            }
          }
          if (filtered.length > 1) {
            const competing = filtered.slice(0, 5).map((c) => c.symbol);
            warnings.push(
              `Row mapping to ${mapping} is ambiguous for "${baseRecord.symbol}": competing=[${competing.join(", ")}]. Using highest-ranked candidate.`
            );
            rowHadAmbiguity = true;
          }
          resolved = filtered[0];
        }

        if (!resolved) {
          continue;
        }

        const entry: ClassApiMatrixEntry = {
          symbol: resolved.symbol,
          owner: resolved.owner,
          name: resolved.name,
          descriptor: resolved.descriptor
        };
        row[mapping] = entry;
      }

      row.completeness = Boolean(row.obfuscated && row.mojang && row.intermediary && row.yarn);
      rows.push(row);
      if (rowHadAmbiguity) {
        ambiguousRowCount += 1;
      }
    }

    const rowCount = rows.length;
    const rowLimit = clampRowLimit(input.maxRows);
    const limitedRows = rowLimit != null && rowCount > rowLimit ? rows.slice(0, rowLimit) : rows;

    return {
      version,
      className,
      classNameMapping,
      classIdentity: {
        obfuscated: classByMapping.obfuscated?.symbol,
        mojang: classByMapping.mojang?.symbol,
        intermediary: classByMapping.intermediary?.symbol,
        yarn: classByMapping.yarn?.symbol
      },
      rows: limitedRows,
      rowCount,
      rowsTruncated: limitedRows.length < rowCount ? true : undefined,
      warnings,
      ambiguousRowCount: ambiguousRowCount > 0 ? ambiguousRowCount : undefined
    };
  }

  async checkSymbolExists(input: SymbolExistenceInput): Promise<SymbolExistenceOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }
    const sourceMapping = input.sourceMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping namespace for existence check.",
        details: {
          sourceMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      sourcePriorityApplied: priority
    } satisfies SymbolExistenceOutput["mappingContext"];

    const classNameMode = input.nameMode === "auto" ? "auto" : "fqcn";
    const normalizedQuery:
      | {
          mode: "auto-class";
          className: string;
          querySymbol: SymbolReference;
        }
      | {
          mode: "strict";
          queryRecord: MappingSymbolRecord;
          querySymbol: SymbolReference;
        } =
      input.kind === "class" && classNameMode === "auto"
        ? (() => {
            const owner = input.owner?.trim();
            if (owner) {
              throw invalidInputError("owner is not allowed when kind=class. Use name as FQCN.", {
                owner: input.owner,
                nextAction: 'Provide class as name, e.g. "net.minecraft.server.Main".'
              });
            }
            if (input.descriptor?.trim()) {
              throw invalidInputError("descriptor is not allowed when kind=class.", {
                descriptor: input.descriptor
              });
            }
            const autoClassName = normalizeMappedSymbolOutput(input.name.trim());
            if (!autoClassName) {
              throw invalidInputError("name must be a non-empty string.", {
                name: input.name
              });
            }
            return {
              mode: "auto-class",
              className: autoClassName,
              querySymbol: {
                kind: "class",
                name: autoClassName,
                symbol: autoClassName
              }
            };
          })()
        : (() => {
            const { record: queryRecord, querySymbol } = normalizeQuerySymbol(input, input.signatureMode);
            return {
              mode: "strict",
              queryRecord,
              querySymbol
            };
          })();

    const graph = await this.loadGraph(
      version,
      priority,
      sourceMapping === "mojang" ? "obfuscated-mojang-only" : "full"
    );
    const warnings = [...graph.warnings];
    const records = collectTargetRecords(graph, sourceMapping);
    if (records.length === 0) {
      return {
        querySymbol: normalizedQuery.querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings
      };
    }

    const buildOutput = (
      querySymbol: SymbolReference,
      matched: MappingSymbolRecord[],
      status: SymbolResolutionStatus
    ): SymbolExistenceOutput => {
      const candidates = matched.map((record) => toResolutionCandidate(toLookupCandidate(record)));
      const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);
      if (status === "ambiguous" && limitedCandidates.candidatesTruncated) {
        warnings.push(
          "Raise maxCandidates up to 200 to inspect the full candidate list."
        );
      }
      return {
        querySymbol,
        mappingContext,
        resolved: status === "resolved",
        status,
        resolvedSymbol: status === "resolved" ? candidates[0] : undefined,
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings
      };
    };

    if (normalizedQuery.mode === "auto-class") {
      const autoClassName = normalizedQuery.className;
      if (autoClassName.includes(".")) {
        const matched = records.filter(
          (record) => record.kind === "class" && record.symbol === autoClassName
        );
        const status: SymbolResolutionStatus =
          matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
        return buildOutput(normalizedQuery.querySymbol, matched, status);
      }

      const matched = records.filter(
        (record) => record.kind === "class" && record.name === autoClassName
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      if (status === "ambiguous") {
        warnings.push(
          `Multiple class symbols matched short name "${autoClassName}". Provide fully-qualified class name.`
        );
      }
      return buildOutput(normalizedQuery.querySymbol, matched, status);
    }

    const { queryRecord, querySymbol } = normalizedQuery;

    if (queryRecord.kind === "class") {
      const matched = records.filter(
        (record) => record.kind === "class" && record.symbol === queryRecord.symbol
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      return buildOutput(querySymbol, matched, status);
    }

    if (queryRecord.kind === "field") {
      const matched = records.filter(
        (record) =>
          record.kind === "field" && record.owner === queryRecord.owner && record.name === queryRecord.name
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      return buildOutput(querySymbol, matched, status);
    }

    const methodCandidates = records.filter(
      (record) =>
        record.kind === "method" && record.owner === queryRecord.owner && record.name === queryRecord.name
    );

    // name-only mode: skip descriptor matching, resolve by owner+name
    if (input.signatureMode === "name-only") {
      const status: SymbolResolutionStatus =
        methodCandidates.length === 1 ? "resolved" : methodCandidates.length > 1 ? "ambiguous" : "not_found";
      if (status === "ambiguous") {
        // name-only discards any supplied descriptor, so telling the caller to "provide
        // descriptor" would not disambiguate — they need to switch to signatureMode="exact".
        warnings.push(
          `Multiple method overloads matched name "${queryRecord.name}" in owner "${queryRecord.owner}". Retry with signatureMode="exact" plus a JVM descriptor to pick one overload.`
        );
      }
      return buildOutput(querySymbol, methodCandidates, status);
    }

    // Tiny parsing stores a single descriptor per method entry (typically in the obfuscated
    // namespace) and copies it into every namespace at load time. That means a descriptor
    // supplied in `sourceMapping` coordinates will not string-compare equal to the record
    // for any method whose descriptor references remapped Minecraft classes. Project the
    // caller's descriptor to obfuscated coordinates first so class references line up with
    // the stored record descriptors. The projection is accepted even when
    // `projection.complete` is false: `projectMethodDescriptorToTarget` leaves every
    // unresolvable `L...;` reference unchanged (JDK/external classes like
    // `Ljava/lang/String;` are never in the mapping graph and pass through by design), so a
    // partial projection still aligns the Minecraft class refs with the stored descriptor
    // form while leaving external class refs identical to the user input. Falling back to
    // verbatim comparison on `complete === false` would send mixed descriptors like
    // `(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V` down the raw-compare path
    // and produce false negatives in the most common lookup shape. When no class references
    // exist at all (primitives-only descriptors such as `(I)V`) the projector marks
    // `hadClassReferences === false` and we simply reuse the original descriptor.
    const queryDescriptor = queryRecord.descriptor as string;
    let effectiveDescriptor = queryDescriptor;
    if (sourceMapping !== "obfuscated") {
      const projectionPath = namespacePath(graph, sourceMapping, "obfuscated");
      if (projectionPath) {
        const projection = this.projectMethodDescriptorToTarget(
          graph,
          projectionPath,
          queryDescriptor
        );
        if (projection.hadClassReferences) {
          effectiveDescriptor = projection.descriptor;
        }
      }
    }
    const descriptorMatched = methodCandidates.filter(
      (record) => record.descriptor === effectiveDescriptor || record.descriptor === queryDescriptor
    );
    if (descriptorMatched.length === 1) {
      return buildOutput(querySymbol, descriptorMatched, "resolved");
    }
    if (descriptorMatched.length > 1) {
      return buildOutput(querySymbol, descriptorMatched, "ambiguous");
    }

    if (methodCandidates.some((candidate) => candidate.descriptor == null)) {
      warnings.push("Descriptor-level existence checks are unavailable for descriptorless mapping entries.");
      return buildOutput(querySymbol, methodCandidates, "mapping_unavailable");
    }

    return buildOutput(querySymbol, [], "not_found");
  }

  private mapRecordBetweenMappings(
    graph: LoadedGraph,
    sourceMapping: SourceMapping,
    targetMapping: SourceMapping,
    record: MappingSymbolRecord,
    resolvedPath?: SourceMapping[]
  ): MappingSymbolRecord[] {
    if (sourceMapping === targetMapping) {
      return [record];
    }
    const path = resolvedPath ?? namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      return [];
    }

    let mapped = this
      .mapCandidatesAlongPath(graph, path, record)
      .filter((candidate) => candidate.kind === record.kind)
      .map((candidate) => ({
        kind: candidate.kind,
        symbol: candidate.symbol,
        owner: candidate.owner,
        name: candidate.name,
        descriptor: candidate.descriptor
      }));

    if (record.kind === "method" && record.descriptor) {
      const descriptorMatched = mapped.filter((candidate) => candidate.descriptor === record.descriptor);
      if (descriptorMatched.length > 0) {
        mapped = descriptorMatched;
      }
    }

    const deduped = new Map<string, MappingSymbolRecord>();
    for (const candidate of mapped) {
      deduped.set(buildSymbolKey(candidate), candidate);
    }
    return [...deduped.values()];
  }

  private mapCandidatesAlongPath(
    graph: LoadedGraph,
    path: SourceMapping[],
    query: MappingSymbolRecord
  ): MappingLookupCandidate[] {
    const queryKey = buildSymbolKey(query);
    let current = new Map<string, CandidateAccumulator>([
      [
        queryKey,
        {
          key: queryKey,
          record: query,
          matchKind: "exact",
          confidence: 1,
          rank: MATCH_RANK.exact
        }
      ]
    ]);

    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index];
      const to = path[index + 1];
      const record = graph.pairs.get(pairKey(from, to));
      if (!record) {
        return [];
      }

      const next = new Map<string, CandidateAccumulator>();
      for (const candidate of current.values()) {
        const mapped = lookupCandidates(record.index, candidate.record);
        for (const item of mapped) {
          const mappedRecord: MappingSymbolRecord = {
            kind: item.kind,
            symbol: item.symbol,
            owner: item.owner,
            name: item.name,
            descriptor: item.descriptor
          };
          const mappedKey = buildSymbolKey(mappedRecord);
          const rank = MATCH_RANK[item.matchKind];
          const composedConfidence = candidate.confidence * item.confidence;
          const existing = next.get(mappedKey);
          if (
            !existing ||
            composedConfidence > existing.confidence ||
            (composedConfidence === existing.confidence && rank > existing.rank)
          ) {
            next.set(mappedKey, {
              key: mappedKey,
              record: mappedRecord,
              matchKind: item.matchKind,
              confidence: composedConfidence,
              rank
            });
          }
        }
      }

      current = next;
      if (current.size === 0) {
        return [];
      }
    }

    return [...current.values()]
      .sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        if (right.rank !== left.rank) {
          return right.rank - left.rank;
        }
        return left.record.symbol.localeCompare(right.record.symbol);
      })
      .slice(0, MAX_CANDIDATES)
      .map((item) => ({
        symbol: item.record.symbol,
        matchKind: item.matchKind,
        confidence: Number(item.confidence.toFixed(6)),
        kind: item.record.kind,
        owner: item.record.owner,
        name: item.record.name,
        descriptor: item.record.descriptor
      }));
  }

  private projectMethodDescriptorToTarget(
    graph: LoadedGraph,
    path: SourceMapping[],
    descriptor: string
  ): DescriptorProjection {
    let hadClassReferences = false;
    let complete = true;
    const classProjectionCache = new Map<string, string>();

    const projectedDescriptor = descriptor.replace(/L([^;]+);/g, (fullMatch, internalName: string) => {
      hadClassReferences = true;
      const cached = classProjectionCache.get(internalName);
      if (cached) {
        return `L${cached};`;
      }

      const projectedClassCandidates = this
        .mapCandidatesAlongPath(graph, path, createClassSymbolRecord(internalName.replace(/\//g, ".")))
        .filter((candidate) => candidate.kind === "class");
      if (projectedClassCandidates.length !== 1) {
        complete = false;
        return fullMatch;
      }

      const projectedInternalName = projectedClassCandidates[0]!.symbol.replace(/\./g, "/");
      classProjectionCache.set(internalName, projectedInternalName);
      return `L${projectedInternalName};`;
    });

    return {
      descriptor: projectedDescriptor,
      hadClassReferences,
      complete
    };
  }

  private provenanceForPath(
    graph: LoadedGraph,
    path: SourceMapping[]
  ): MappingLookupProvenance | undefined {
    if (path.length <= 1) {
      return undefined;
    }
    const first = graph.pairs.get(pairKey(path[0], path[1]));
    if (!first) {
      return undefined;
    }
    return {
      source: first.source,
      mappingArtifact: first.mappingArtifact,
      version: graph.version,
      priority: graph.priority
    };
  }

  /**
   * Probe the mapping graph health for a given version.
   * Returns availability of mojang mappings, tiny mappings, and member remap paths.
   */
  async checkMappingHealth(input: {
    version: string;
    requestedMapping: SourceMapping;
    sourcePriority?: MappingSourcePriority;
  }): Promise<{
    mojangMappingsAvailable: boolean;
    tinyMappingsAvailable: boolean;
    memberRemapAvailable: boolean;
    degradations: string[];
  }> {
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const degradations: string[] = [];

    if (isUnobfuscatedVersion(input.version)) {
      const requestFulfillable =
        input.requestedMapping === "obfuscated" || input.requestedMapping === "mojang";
      if (!requestFulfillable) {
        degradations.push(
          `Version ${input.version} is unobfuscated; ${input.requestedMapping} mappings are not applicable.`
        );
      }
      return {
        mojangMappingsAvailable: true,
        tinyMappingsAvailable: false,
        memberRemapAvailable: requestFulfillable,
        degradations
      };
    }

    let graph: LoadedGraph;
    try {
      graph = await this.loadGraph(input.version, priority, "full");
    } catch {
      return {
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        degradations: ["Mapping graph could not be loaded."]
      };
    }

    // Check for mojang-client-mappings pairs
    let mojangAvailable = false;
    let tinyAvailable = false;
    for (const [, record] of graph.pairs) {
      if (record.source === "mojang-client-mappings") mojangAvailable = true;
      if (record.source === "loom-cache" || record.source === "maven") tinyAvailable = true;
    }

    if (!mojangAvailable) {
      degradations.push("Mojang client mappings are not available for this version.");
    }
    if (!tinyAvailable) {
      degradations.push("No intermediary/yarn tiny mappings were found for this version.");
    }

    // Check if member remap path exists (requestedMapping → obfuscated)
    let memberRemapAvailable = false;
    if (input.requestedMapping === "obfuscated") {
      memberRemapAvailable = true;
    } else {
      const path = namespacePath(graph, input.requestedMapping, "obfuscated");
      memberRemapAvailable = path != null && path.length > 1;
      if (!memberRemapAvailable) {
        degradations.push(`No mapping path from ${input.requestedMapping} to obfuscated; member remap will fail.`);
      }
    }

    return {
      mojangMappingsAvailable: mojangAvailable,
      tinyMappingsAvailable: tinyAvailable,
      memberRemapAvailable,
      degradations
    };
  }

  private async loadGraph(
    version: string,
    priority: MappingSourcePriority,
    mode: GraphLoadMode,
    projectPath?: string
  ): Promise<LoadedGraph> {
    const effectiveProjectPath = effectiveLoomSearchProjectPath(projectPath);
    const cacheKey = `${version}|${priority}|${mode}|${effectiveProjectPath ?? ""}`;
    const cached = this.graphCache.get(cacheKey);
    if (cached) {
      this.graphCache.delete(cacheKey);
      this.graphCache.set(cacheKey, cached);
      return cached;
    }

    const existingLock = this.buildLocks.get(cacheKey);
    if (existingLock) {
      return existingLock;
    }

    const buildPromise = this.buildGraph(version, priority, mode, effectiveProjectPath);
    this.buildLocks.set(cacheKey, buildPromise);
    try {
      const built = await buildPromise;
      this.graphCache.set(cacheKey, built);
      this.trimGraphCache();
      return built;
    } finally {
      this.buildLocks.delete(cacheKey);
    }
  }

  private async buildGraph(
    version: string,
    priority: MappingSourcePriority,
    mode: GraphLoadMode,
    projectPath?: string
  ): Promise<LoadedGraph> {
    if (isUnobfuscatedVersion(version)) {
      return {
        version,
        priority,
        mode,
        pairs: new Map(),
        adjacency: new Map(),
        pathCache: new Map(),
        recordsByTarget: new Map(),
        warnings: [
          `Version ${version} is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names.`
        ]
      };
    }

    const graph: LoadedGraph = {
      version,
      priority,
      mode,
      pairs: new Map(),
      adjacency: new Map(),
      pathCache: new Map(),
      recordsByTarget: new Map(),
      warnings: []
    };

    const mojangLoad = await this.loadMojangPairs(version);
    graph.warnings.push(...mojangLoad.warnings);
    this.mergePairs(graph.pairs, mojangLoad.pairs, "mojang-client-mappings", mojangLoad.mappingArtifact);

    if (mode === "full") {
      let tinyLoaded = false;
      const deferredTinyWarnings: string[] = [];
      for (const source of mappingSourceOrder(priority)) {
        const tinyLoad =
          source === "loom-cache"
            ? await this.loadTinyPairsFromLoom(version, projectPath)
            : await this.loadTinyPairsFromMaven(version);
        if (tinyLoad.pairs.size === 0) {
          deferredTinyWarnings.push(...tinyLoad.warnings);
          continue;
        }

        tinyLoaded = true;
        this.mergePairs(graph.pairs, tinyLoad.pairs, source, tinyLoad.mappingArtifact);
        graph.warnings.push(...tinyLoad.warnings);
        if (deferredTinyWarnings.length > 0) {
          graph.warnings.push(
            `Used ${source === "maven" ? "Maven" : "Loom cache"} tiny mappings for "${version}" after an earlier source lookup returned no data.`
          );
        }
        break;
      }

      if (!tinyLoaded) {
        graph.warnings.push(...deferredTinyWarnings);
        graph.warnings.push("No intermediary/yarn tiny mappings were found for this version.");
      }
    }

    graph.adjacency = buildAdjacency(graph.pairs);
    graph.recordsByTarget = buildTargetRecordIndex(graph.pairs);

    return graph;
  }

  private mergePairs(
    target: Map<PairKey, PairRecord>,
    source: Map<PairKey, DirectionIndex>,
    pairSource: MappingLookupSource,
    mappingArtifact: string
  ): void {
    for (const [key, incoming] of source.entries()) {
      const existing = target.get(key);
      if (!existing) {
        target.set(key, {
          index: incoming,
          source: pairSource,
          mappingArtifact
        });
        continue;
      }
      if (existing.source !== pairSource) {
        continue;
      }
      mergeDirectionIndexes(existing.index, incoming);
    }
  }

  private async loadMojangPairs(version: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const warnings: string[] = [];
    let metadata: ResolvedVersionMappings;
    try {
      metadata = await this.versionService.resolveVersionMappings(version);
    } catch (caughtError) {
      return {
        pairs: new Map(),
        warnings: [
          `Failed to resolve version metadata for "${version}": ${
            caughtError instanceof Error ? caughtError.message : String(caughtError)
          }`
        ],
        mappingArtifact: `version:${version}`
      };
    }

    const clientMappingsUrl = metadata.clientMappingsUrl ?? metadata.mappingsUrl;
    if (!clientMappingsUrl) {
      warnings.push(`Minecraft version "${version}" does not expose client mappings URL.`);
      return {
        pairs: new Map(),
        warnings,
        mappingArtifact: metadata.versionDetailUrl
      };
    }

    const mappingsPath = join(this.config.cacheDir, "mappings", version, "client_mappings.txt");
    if (!existsSync(mappingsPath)) {
      await mkdir(dirname(mappingsPath), { recursive: true });
      const downloaded = await downloadToCache(clientMappingsUrl, mappingsPath, {
        fetchFn: this.fetchFn,
        retries: this.config.fetchRetries,
        timeoutMs: this.config.fetchTimeoutMs
      });
      if (!downloaded.ok || !downloaded.path) {
        warnings.push(
          `Failed to download client mappings from "${clientMappingsUrl}" (status: ${downloaded.statusCode ?? "unknown"}).`
        );
        return {
          pairs: new Map(),
          warnings,
          mappingArtifact: clientMappingsUrl
        };
      }
    }

    try {
      const content = await readFile(mappingsPath, "utf8");
      return {
        pairs: parseClientMappings(content),
        warnings,
        mappingArtifact: clientMappingsUrl
      };
    } catch (caughtError) {
      warnings.push(
        `Failed to parse client mappings for "${version}": ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`
      );
      return {
        pairs: new Map(),
        warnings,
        mappingArtifact: clientMappingsUrl
      };
    }
  }

  private async loadTinyPairsFromLoom(version: string, projectPath?: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const searchRoots = buildVersionSourceSearchRoots(effectiveLoomSearchProjectPath(projectPath));
    const merged = new Map<PairKey, DirectionIndex>();
    const discoveredPaths = new Set<string>();

    for (const root of searchRoots) {
      let discovered: string[] = [];
      const versionRoot = join(root, version);
      try {
        discovered = existsSync(versionRoot)
          ? await fastGlob.glob(["**/*.tiny", "**/*.tinyv2"], {
              cwd: versionRoot,
              absolute: true,
              onlyFiles: true
            })
          : await fastGlob.glob([`${version.replace(GLOB_SPECIAL_CHARS, "\\$&")}/**/*.tiny`, `${version.replace(GLOB_SPECIAL_CHARS, "\\$&")}/**/*.tinyv2`], {
              cwd: root,
              absolute: true,
              onlyFiles: true
            });
      } catch {
        continue;
      }
      const byVersion = discovered
        .filter((path) => path.replaceAll("\\", "/").includes(`/${version}/`))
        .sort((left, right) => left.localeCompare(right));
      if (byVersion.length === 0) {
        continue;
      }

      for (const path of byVersion) {
        discoveredPaths.add(path);
        try {
          const content = await readFile(path, "utf8");
          const parsed = parseTinyMappings(content);
          for (const [key, index] of parsed.entries()) {
            const existing = merged.get(key);
            if (!existing) {
              merged.set(key, index);
            } else {
              mergeDirectionIndexes(existing, index);
            }
          }
        } catch {
          // best effort: skip unreadable or invalid files
        }
      }
    }

    const orderedPaths = [...discoveredPaths].sort((left, right) => left.localeCompare(right));
    if (orderedPaths.length > 0) {
      return {
        pairs: merged,
        warnings: [],
        mappingArtifact: orderedPaths[0]!
      };
    }

    return {
      pairs: new Map(),
      warnings: [`No Loom tiny mapping files matched version "${version}".`],
      mappingArtifact: "loom-cache:none"
    };
  }

  private async loadTinyPairsFromMaven(version: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const warnings: string[] = [];
    const merged = new Map<PairKey, DirectionIndex>();

    const repos = this.config.sourceRepos;
    const intermediaryUrls: string[] = [];
    const yarnUrls: string[] = [];

    const repoBases = repos.map((repo) => repo.replace(/\/+$/, ""));
    const yarnCoordinatesByRepo = await Promise.all(
      repoBases.map(async (base) => ({
        base,
        yarnCoordinates: await this.fetchYarnCoordinates(base, version)
      }))
    );

    for (const { base, yarnCoordinates } of yarnCoordinatesByRepo) {
      intermediaryUrls.push(
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`,
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`
      );

      for (const coordinate of yarnCoordinates) {
        yarnUrls.push(
          `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}-v2.jar`,
          `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}.jar`
        );
      }
    }

    const allUrls = [...intermediaryUrls, ...yarnUrls];
    const parsedResults = await Promise.allSettled(
      allUrls.map(async (url) => {
        const downloaded = await downloadToCache(url, defaultDownloadPath(this.config.cacheDir, url), {
          fetchFn: this.fetchFn,
          retries: this.config.fetchRetries,
          timeoutMs: this.config.fetchTimeoutMs
        });
        if (!downloaded.ok || !downloaded.path) {
          return undefined;
        }

        return this.parseTinyFromJar(downloaded.path);
      })
    );

    for (const result of parsedResults) {
      if (result.status !== "fulfilled" || !result.value) {
        continue;
      }
      for (const [key, index] of result.value.entries()) {
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, index);
        } else {
          mergeDirectionIndexes(existing, index);
        }
      }
    }

    if (merged.size === 0) {
      warnings.push(`No Maven tiny mappings could be loaded for "${version}".`);
    }

    return {
      pairs: merged,
      warnings,
      mappingArtifact: allUrls[0] ?? "maven:none"
    };
  }

  private async parseTinyFromJar(jarPath: string): Promise<Map<PairKey, DirectionIndex>> {
    const tinyEntries = (await collectMatchedJarEntriesAsUtf8(
      jarPath,
      (entry) => entry.toLowerCase().endsWith(".tiny") || entry.toLowerCase().endsWith(".tinyv2"),
      { continueOnError: true }
    )).sort((left, right) => left.filePath.localeCompare(right.filePath));

    const merged = new Map<PairKey, DirectionIndex>();
    for (const entry of tinyEntries) {
      try {
        const parsed = parseTinyMappings(entry.content);
        for (const [key, index] of parsed.entries()) {
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, index);
          } else {
            mergeDirectionIndexes(existing, index);
          }
        }
      } catch {
        // skip malformed tiny entries
      }
    }

    return merged;
  }

  private async fetchYarnCoordinates(repoBase: string, version: string): Promise<string[]> {
    const metadataUrl = `${repoBase}/net/fabricmc/yarn/maven-metadata.xml`;
    try {
      const response = await this.fetchFn(metadataUrl);
      if (!response.ok) {
        return [];
      }
      const xml = await response.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map((match) => match[1]?.trim() ?? "")
        .filter((value) => value.startsWith(`${version}+build.`));

      const sorted = versions.sort((left, right) => {
        const leftBuild = Number.parseInt(left.split("+build.")[1] ?? "0", 10);
        const rightBuild = Number.parseInt(right.split("+build.")[1] ?? "0", 10);
        return rightBuild - leftBuild;
      });

      if (sorted.length > 0) {
        return sorted.slice(0, 3);
      }
      return [version];
    } catch {
      return [version];
    }
  }

  private trimGraphCache(): void {
    const maxEntries = Math.max(1, this.config.maxMappingGraphCache ?? 16);
    while (this.graphCache.size > maxEntries) {
      const oldestKey = this.graphCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.graphCache.delete(oldestKey);
    }
  }

  // Note: in-flight buildLocks may re-populate graphCache after release.
  // Resolution cache entries created by concurrent findMapping() calls may also
  // survive this invalidation. Both are bounded by TTL (5 min) and will expire
  // naturally. A full epoch-based invalidation would add complexity for a rare
  // user-initiated operation (manage-cache).
  releaseGraphCacheEntry(version: string, sourcePriority?: MappingSourcePriority): void {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
      return;
    }
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, sourcePriority);
    const prefix = `${normalizedVersion}|${priority}|`;
    for (const key of this.graphCache.keys()) {
      if (key.startsWith(prefix)) {
        this.graphCache.delete(key);
      }
    }
    const resolutionPrefix = `${normalizedVersion}\0`;
    for (const key of this.resolutionCache.keys()) {
      if (key.startsWith(resolutionPrefix)) {
        this.resolutionCache.delete(key);
      }
    }
  }

  private buildResolutionCacheKey(
    version: string,
    input: FindMappingInput,
    querySymbol: SymbolReference,
    effectiveSignatureMode: "exact" | "name-only"
  ): string {
    return [
      version,
      input.kind,
      querySymbol.symbol,
      querySymbol.descriptor ?? "",
      input.sourceMapping,
      input.targetMapping,
      input.sourcePriority ?? "",
      effectiveLoomSearchProjectPath(input.projectPath) ?? "",
      effectiveSignatureMode,
      String(input.maxCandidates ?? ""),
      JSON.stringify(input.disambiguation ?? "")
    ].join("\0");
  }

  private trimResolutionCache(): void {
    if (this.resolutionCache.size <= MappingService.RESOLUTION_CACHE_MAX) return;
    const now = Date.now();
    for (const [key, entry] of this.resolutionCache) {
      if (now - entry.cachedAt > MappingService.RESOLUTION_CACHE_TTL_MS) {
        this.resolutionCache.delete(key);
      }
    }
    while (this.resolutionCache.size > MappingService.RESOLUTION_CACHE_MAX) {
      const firstKey = this.resolutionCache.keys().next().value;
      if (firstKey !== undefined) this.resolutionCache.delete(firstKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone: Tiny v2 mapping file resolution for remapping
// ---------------------------------------------------------------------------

const FABRIC_MAVEN = "https://maven.fabricmc.net";

async function fetchYarnCoordinatesStandalone(
  version: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<string[]> {
  const metadataUrl = `${FABRIC_MAVEN}/net/fabricmc/yarn/maven-metadata.xml`;
  try {
    const response = await fetchFn(metadataUrl);
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((value) => value.startsWith(`${version}+build.`));

    const sorted = versions.sort((left, right) => {
      const leftBuild = Number.parseInt(left.split("+build.")[1] ?? "0", 10);
      const rightBuild = Number.parseInt(right.split("+build.")[1] ?? "0", 10);
      return rightBuild - leftBuild;
    });

    return sorted.length > 0 ? sorted.slice(0, 3) : [];
  } catch {
    return [];
  }
}

async function extractTinyFromJar(
  jarPath: string,
  outputPath: string
): Promise<boolean> {
  const matchedEntries = await collectMatchedJarEntriesAsUtf8(
    jarPath,
    (entry) => entry === "mappings/mappings.tiny" || entry.toLowerCase().endsWith(".tiny"),
    { maxEntries: 1 }
  );
  const tinyEntry = matchedEntries[0];
  if (!tinyEntry) {
    return false;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, tinyEntry.content, "utf8");
  return true;
}

/**
 * Resolve and cache a Tiny v2 mapping file for the given Minecraft version.
 *
 * @param version - Minecraft version (e.g. "1.20.4")
 * @param mapping - "intermediary" or "yarn"
 * @param cacheDir - The application cache directory
 * @param fetchFn - Optional fetch implementation for testing
 * @returns Path to the extracted Tiny v2 file
 */
export async function resolveTinyMappingFile(
  version: string,
  mapping: "intermediary" | "yarn",
  cacheDir: string,
  fetchFn?: typeof fetch
): Promise<string> {
  const cachedTiny = join(cacheDir, "mappings", `${version}-${mapping}.tiny`);

  if (existsSync(cachedTiny)) {
    return cachedTiny;
  }

  const effectiveFetch = fetchFn ?? globalThis.fetch;

  if (mapping === "intermediary") {
    const url = `${FABRIC_MAVEN}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`;
    const jarDest = defaultDownloadPath(cacheDir, url);
    const downloaded = await downloadToCache(url, jarDest, {
      fetchFn: effectiveFetch,
      retries: 2,
      timeoutMs: 30_000
    });

    if (!downloaded.ok || !downloaded.path) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `Failed to download intermediary mappings for ${version}.`,
        details: { version, url }
      });
    }

    const extracted = await extractTinyFromJar(downloaded.path, cachedTiny);
    if (!extracted) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `No tiny mapping found in intermediary JAR for ${version}.`,
        details: { version, jarPath: downloaded.path }
      });
    }

    return cachedTiny;
  }

  // yarn
  const yarnCoordinates = await fetchYarnCoordinatesStandalone(version, effectiveFetch);
  if (yarnCoordinates.length === 0) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `No yarn builds found for Minecraft ${version}.`,
      details: { version }
    });
  }

  for (const coordinate of yarnCoordinates) {
    const url = `${FABRIC_MAVEN}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}-v2.jar`;
    const jarDest = defaultDownloadPath(cacheDir, url);
    const downloaded = await downloadToCache(url, jarDest, {
      fetchFn: effectiveFetch,
      retries: 2,
      timeoutMs: 30_000
    });

    if (!downloaded.ok || !downloaded.path) {
      continue;
    }

    const extracted = await extractTinyFromJar(downloaded.path, cachedTiny);
    if (extracted) {
      return cachedTiny;
    }
  }

  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Failed to download yarn mappings for ${version}.`,
    details: { version, triedCoordinates: yarnCoordinates }
  });
}
