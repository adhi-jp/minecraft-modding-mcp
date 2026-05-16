import { loadConfig } from "./config.js";
import {
  MinecraftExplorerService,
  type ResponseContext as ExplorerResponseContext,
  type SignatureMember
} from "./minecraft-explorer-service.js";
import {
  type MixinValidationResult,
  type MixinValidationProvenance,
  type MappingHealthReport,
  type AccessWidenerValidationResult,
  type AccessTransformerValidationResult,
  type MixinStageBudgets
} from "./mixin-validator.js";
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
import { openDatabase } from "./storage/db.js";
import { ArtifactsRepo } from "./storage/artifacts-repo.js";
import { FilesRepo } from "./storage/files-repo.js";
import { IndexMetaRepo } from "./storage/index-meta-repo.js";
import { SymbolsRepo } from "./storage/symbols-repo.js";
import { RuntimeMetrics, type RuntimeMetricSnapshot } from "./observability.js";
import { SourceServiceState } from "./source/state.js";
import * as cacheMetrics from "./source/cache-metrics.js";
import * as indexer from "./source/indexer.js";
import * as search from "./source/search.js";
import * as lifecycle from "./source/lifecycle.js";
import * as workspaceTarget from "./source/workspace-target.js";
import * as accessValidate from "./source/access-validate.js";
import * as validateMixinModule from "./source/validate-mixin.js";
import * as artifactResolver from "./source/artifact-resolver.js";
import * as classSource from "./source/class-source.js";
import * as symbolResolver from "./source/symbol-resolver.js";
import * as fileAccess from "./source/file-access.js";
import { type StageEmitter } from "./stage-emitter.js";
import {
  WorkspaceMappingService,
  type WorkspaceCompileMappingOutput,
  type WorkspaceProjectLoader
} from "./workspace-mapping-service.js";
import {
  getProcessWorkspaceContextCache,
  type WorkspaceContextCache
} from "./workspace-context-cache.js";
import type {
  AccessTransformerNamespace,
  ArtifactProvenance,
  ArtifactRow,
  ArtifactScope,
  Config,
  MappingSourcePriority,
  ResolveArtifactTargetInput,
  ResolvedSourceArtifact,
  RuntimeValidationProvenance,
  SourceMapping
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
  target: ResolveArtifactTargetInput;
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  allowDecompile?: boolean;
  projectPath?: string;
  gradleUserHome?: string;
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

export type ProbeMinecraftArtifactInput = {
  target: { kind: "version"; value: string };
  mapping?: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
};

export type ProbeMinecraftArtifactOutput = {
  artifactId: string;
  mappingApplied: SourceMapping;
  warnings?: string[];
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
  maxCandidates?: number;
};

export type ResolveWorkspaceSymbolOutput = MappingSymbolResolutionOutput & {
  workspaceDetection: WorkspaceCompileMappingOutput;
};

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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
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
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
};

export type ValidateAccessTransformerOutput = AccessTransformerValidationResult;

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

  async probeMinecraftArtifact(input: ProbeMinecraftArtifactInput): Promise<ProbeMinecraftArtifactOutput> {
    return artifactResolver.probeMinecraftArtifact(this, input);
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
    gradleUserHome?: string;
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
    gradleUserHome?: string;
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
    gradleUserHome?: string;
  }): ReturnType<typeof artifactResolver.discoverVersionSourceJar> {
    return artifactResolver.discoverVersionSourceJar(this, input);
  }

  async discoverAccessWidenerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    gradleUserHome?: string;
    requestedScope: ArtifactScope;
  }): ReturnType<typeof artifactResolver.discoverAccessWidenerRuntimeCandidates> {
    return artifactResolver.discoverAccessWidenerRuntimeCandidates(this, input);
  }

  async discoverAccessTransformerRuntimeCandidates(input: {
    version: string;
    projectPath?: string;
    gradleUserHome?: string;
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
    projectPath?: string,
    gradleUserHome?: string
  ): Promise<{ members: SignatureMember[]; failedNames: Set<string> }> {
    return lifecycle.remapSignatureMembers(this, members, kind, version, sourceMapping, targetMapping, sourcePriority, warnings, projectPath, gradleUserHome);
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

  async resolveClassNameForLookup(input: {
    className: string;
    version?: string;
    sourceMapping: SourceMapping;
    targetMapping: SourceMapping;
    sourcePriority: MappingSourcePriority | undefined;
    gradleUserHome?: string;
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

  getArtifact(artifactId: string): ArtifactRow {
    return indexer.getArtifact(this, artifactId);
  }

  async ingestIfNeeded(resolved: ResolvedSourceArtifact): Promise<void> {
    return indexer.ingestIfNeeded(this, resolved);
  }

  private refreshCacheMetrics(): void {
    cacheMetrics.refreshCacheMetrics(this);
  }

  private snapshotLruAccounting(): void {
    cacheMetrics.snapshotLruAccounting(this);
  }
}

/* descriptor utils extracted to src/source/descriptor-utils.ts */
