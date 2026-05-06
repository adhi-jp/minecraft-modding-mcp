import { readFileSync } from "node:fs";
import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeStageEmitter, type StageEmitterExtra } from "./stage-emitter.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, z } from "zod";
import { CompatStdioServerTransport } from "./compat-stdio-transport.js";

import { objectResult } from "./mcp-helpers.js";
import { prepareToolInput } from "./tool-input.js";
import {
  isCompactEnabled,
  COMPACT_MAPPING_TOOL_NAMES,
  COMPACT_SOURCE_TOOL_NAMES,
  COMPACT_MEMBERS_TOOL_NAMES,
  COMPACT_LIGHT_TOOL_NAMES,
  TOOL_PRESERVE_PAYLOAD_KEYS,
  compactResponse,
  compactArtifactResponse,
  compactMappingResponse,
  compactSourceResponse,
  compactMembersResponse,
  compactLightResponse
} from "./response-utils.js";

import { loadConfig } from "./config.js";
import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { log } from "./logger.js";
import {
  applyNbtJsonPatch,
  nbtBase64ToTypedJson,
  typedJsonToNbtBase64,
  type DecodeCompression,
  type EncodeCompression
} from "./nbt/pipeline.js";
import { analyzeModJar } from "./mod-analyzer.js";
import { remapModJar } from "./mod-remap-service.js";
import { registerResources } from "./resources.js";
import { SourceService } from "./source-service.js";
import { ToolExecutionGate } from "./tool-execution-gate.js";
import type { ArtifactScope, MappingSourcePriority, SourceMapping, SourceTargetInput } from "./types.js";
import { WorkspaceMappingService } from "./workspace-mapping-service.js";
import {
  InspectMinecraftService,
  inspectMinecraftSchema,
  inspectMinecraftShape
} from "./entry-tools/inspect-minecraft-service.js";
import {
  AnalyzeSymbolService,
  analyzeSymbolSchema,
  analyzeSymbolShape
} from "./entry-tools/analyze-symbol-service.js";
import {
  CompareMinecraftService,
  compareMinecraftSchema,
  compareMinecraftShape
} from "./entry-tools/compare-minecraft-service.js";
import {
  AnalyzeModService,
  analyzeModSchema,
  analyzeModShape
} from "./entry-tools/analyze-mod-service.js";
import {
  ValidateProjectService,
  validateProjectSchema,
  validateProjectShape,
  discoverWorkspaceAccessTransformers,
  discoverWorkspaceAccessWideners,
  discoverWorkspaceMixins
} from "./entry-tools/validate-project-service.js";
import {
  ManageCacheService,
  manageCacheSchema,
  manageCacheShape
} from "./entry-tools/manage-cache-service.js";
import {
  VerifyMixinTargetService,
  VERIFY_MIXIN_TARGET_OFF
} from "./entry-tools/verify-mixin-target-service.js";
import { BATCH_TOOLS_OFF } from "./entry-tools/batch-runner.js";
import { BatchClassSourceService } from "./entry-tools/batch-class-source-service.js";
import { BatchClassMembersService } from "./entry-tools/batch-class-members-service.js";
import { BatchSymbolExistsService } from "./entry-tools/batch-symbol-exists-service.js";
import { BatchMappingsService } from "./entry-tools/batch-mappings-service.js";
import { createCacheRegistry } from "./cache-registry.js";
import { buildEntryToolMeta } from "./entry-tools/response-contract.js";
import { registerToolSchema } from "./tool-schema-registry.js";
import { buildSuggestedCall } from "./build-suggested-call.js";
import {
  statusForErrorCode,
  type ExampleCall,
  type ProblemDetails,
  type ProblemFieldError,
  type SuggestedCall
} from "./error-mapping.js";

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

type SearchIntent = "symbol" | "text" | "path";
type SearchMatch = "exact" | "prefix" | "contains" | "regex";
type SearchSymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
type MemberAccess = "public" | "all";
type WorkspaceSymbolKind = "class" | "field" | "method";


type ToolMeta = {
  requestId: string;
  tool: string;
  durationMs: number;
  warnings: string[];
  detailApplied?: "summary" | "standard" | "full";
  includeApplied?: string[];
  truncated?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
  /** Set to `true` on ERR_STAGE_BUDGET_PRE_PARSE error envelopes to signal a budget-driven failure. */
  stageBudgetExhausted?: boolean;
  /** Stage budget (ms) that was exceeded; populated alongside `stageBudgetExhausted`. */
  budgetMs?: number;
  /** Actual stage elapsed time (ms); populated alongside `stageBudgetExhausted`. */
  elapsedMs?: number;
};

const SOURCE_MAPPINGS = ["obfuscated", "mojang", "intermediary", "yarn"] as const;
const SOURCE_PRIORITIES = ["loom-first", "maven-first"] as const;
const TARGET_KINDS = ["version", "jar", "coordinate"] as const;
const SEARCH_INTENTS = ["symbol", "text", "path"] as const;
const SEARCH_MATCHES = ["exact", "prefix", "contains", "regex"] as const;
const SEARCH_SYMBOL_KINDS = ["class", "interface", "enum", "record", "method", "field"] as const;
const MEMBER_ACCESS = ["public", "all"] as const;
const WORKSPACE_SYMBOL_KINDS = ["class", "field", "method"] as const;
const CLASS_NAME_MODES = ["fqcn", "auto"] as const;
const SOURCE_MODES = ["metadata", "snippet", "full"] as const;
const ARTIFACT_SCOPES = ["vanilla", "merged", "loader"] as const;
const DECODE_COMPRESSIONS = ["none", "gzip", "auto"] as const;
const ENCODE_COMPRESSIONS = ["none", "gzip"] as const;
const HEAVY_TOOL_NAMES = new Set([
  "trace-symbol-lifecycle",
  "diff-class-signatures",
  "compare-versions",
  "find-mapping",
  "resolve-method-mapping-exact",
  "get-class-api-matrix",
  "get-registry-data"
]);
const ENTRY_TOOL_NAMES = new Set([
  "inspect-minecraft",
  "analyze-symbol",
  "compare-minecraft",
  "analyze-mod",
  "validate-project",
  "manage-cache"
]);
const heavyToolExecutionGate = new ToolExecutionGate({ maxConcurrent: 1, maxQueue: 2 });

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = z.string().trim().min(1).optional();
const optionalPositiveInt = z.number().int().positive().optional();

// Optional descriptor: "" and whitespace-only strings are normalized to undefined so that
// tools with signatureMode="name-only" can accept "caller omitted descriptor" inputs whether
// the caller passed an empty string or omitted the field entirely. Malformed descriptors are
// still rejected downstream by normalizeMethodDescriptor in mapping-service.
const optionalDescriptorString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

const sourceMappingSchema = z.enum(SOURCE_MAPPINGS);
const mappingSourcePrioritySchema = z.enum(SOURCE_PRIORITIES);
const targetKindSchema = z.enum(TARGET_KINDS);
const searchIntentSchema = z.enum(SEARCH_INTENTS);
const searchMatchSchema = z.enum(SEARCH_MATCHES);
const searchSymbolKindSchema = z.enum(SEARCH_SYMBOL_KINDS);
const memberAccessSchema = z.enum(MEMBER_ACCESS);
const workspaceSymbolKindSchema = z.enum(WORKSPACE_SYMBOL_KINDS);
const classNameModeSchema = z.enum(CLASS_NAME_MODES);
const sourceModeSchema = z.enum(SOURCE_MODES);
const artifactScopeSchema = z.enum(ARTIFACT_SCOPES);
const decodeCompressionSchema = z.enum(DECODE_COMPRESSIONS);
const encodeCompressionSchema = z.enum(ENCODE_COMPRESSIONS);

type ResolveArtifactTargetInput =
  | {
      kind: SourceTargetInput["kind"];
      value: string;
    }
  | {
      kind: "workspace";
      scope?: "vanilla" | "merged" | "loader";
      strict?: boolean;
    }
  | {
      kind: "dependency";
      group: string;
      name: string;
      version?: string;
      versionFromProject?: boolean;
    };

type SourceLookupTargetInput =
  | {
      type: "artifact";
      artifactId: string;
    }
  | ({
      type: "resolve";
    } & ResolveArtifactTargetInput);

const workspaceTargetSchema = z.object({
  kind: z.literal("workspace"),
  scope: artifactScopeSchema.optional(),
  strict: z.boolean().optional()
});

const dependencyTargetSchema = z.object({
  kind: z.literal("dependency"),
  group: nonEmptyString,
  name: nonEmptyString,
  version: z.string().trim().min(1).optional(),
  versionFromProject: z.boolean().optional()
});

const resolveArtifactTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  z.object({ kind: z.literal("jar"), value: nonEmptyString }),
  z.object({ kind: z.literal("coordinate"), value: nonEmptyString }),
  workspaceTargetSchema,
  dependencyTargetSchema
]);

const sourceLookupTargetSchema = z.union([
  z.object({
    type: z.literal("artifact"),
    artifactId: nonEmptyString
  }),
  z.object({ type: z.literal("resolve"), kind: z.literal("version"), value: nonEmptyString }),
  z.object({ type: z.literal("resolve"), kind: z.literal("jar"), value: nonEmptyString }),
  z.object({ type: z.literal("resolve"), kind: z.literal("coordinate"), value: nonEmptyString }),
  z.object({
    type: z.literal("resolve"),
    kind: z.literal("workspace"),
    scope: artifactScopeSchema.optional(),
    strict: z.boolean().optional()
  }),
  z.object({
    type: z.literal("resolve"),
    kind: z.literal("dependency"),
    group: nonEmptyString,
    name: nonEmptyString,
    version: z.string().trim().min(1).optional(),
    versionFromProject: z.boolean().optional()
  })
]);

const RESOLVE_ARTIFACT_TARGET_DESCRIPTION =
  'Object with kind. Examples: {"kind":"version","value":"1.21.10"}, {"kind":"workspace"} (uses projectPath), or {"kind":"dependency","group":"dev.architectury","name":"architectury"}. Must be an object, not a string.';
const SOURCE_LOOKUP_TARGET_DESCRIPTION =
  'Object: {"type":"resolve","kind":"version","value":"1.21.10"} or {"type":"resolve","kind":"workspace"} or {"type":"resolve","kind":"dependency","group":"...","name":"..."} or {"type":"artifact","artifactId":"..."}. Must be an object, not a string.';
const SOURCE_SCOPE_DESCRIPTION =
  "vanilla = Mojang client jar only; merged = source-oriented merged runtime discovery; loader = loader/runtime artifact discovery when the workspace exposes transformed runtime jars.";
const SUGGESTED_CALL_DEFAULTS = {
  allowDecompile: true,
  preferProjectVersion: false,
  strictVersion: false,
  mode: "metadata",
  access: "public",
  includeSynthetic: false,
  includeInherited: false,
  hideUncertain: false,
  explain: false,
  preferProjectMapping: false,
  minSeverity: "all",
  reportMode: "full",
  treatInfoAsWarning: true,
  includeIssues: true
} as const;

function isSuggestedCallDefault(
  field: keyof typeof SUGGESTED_CALL_DEFAULTS,
  value: unknown
): boolean {
  return value === SUGGESTED_CALL_DEFAULTS[field];
}

const ANALYZE_MOD_INCLUDE_GROUPS = ["warnings", "files", "source", "samples", "timings"] as const;
const ANALYZE_MOD_LEGACY_METADATA_INCLUDES = ["metadata", "entrypoints", "mixins", "dependencies"] as const;
const VALIDATE_PROJECT_INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;
const VALIDATE_PROJECT_LEGACY_WORKSPACE_INCLUDES = ["detectedConfig", "mixins", "accessWideners"] as const;

const listVersionsShape = {
  includeSnapshots: z.boolean().default(false),
  limit: optionalPositiveInt.default(20).describe("max 200")
};
const listVersionsSchema = z.object(listVersionsShape);

const resolveArtifactShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false."),
  compact: z.boolean().default(true).describe(
    "Return minimal fields (artifactId, origin, isDecompiled, version, requestedMapping, mappingApplied, qualityFlags). "
    + "Omit provenance, artifactContents, sampleEntries, adjacentSourceCandidates, binaryJarPath, coordinate, repoUrl, resolvedSourceJarPath. "
    + "Enabled by default; set to false for full output."
  )
};
const resolveArtifactSchema = z.object(resolveArtifactShape);

const getClassSourceShape = {
  className: nonEmptyString,
  mode: sourceModeSchema.default("metadata").describe("metadata = symbol outline only; snippet = source with default maxLines=200; full = entire source"),
  target: sourceLookupTargetSchema.describe(SOURCE_LOOKUP_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false."),
  startLine: optionalPositiveInt,
  endLine: optionalPositiveInt,
  maxLines: optionalPositiveInt,
  maxChars: optionalPositiveInt.describe("Hard character limit on sourceText; truncates if exceeded"),
  outputFile: optionalNonEmptyString.describe("Write source to this file path and return metadata-only response"),
  compact: z.boolean().default(false).describe(
    "When true, strip debug metadata (provenance, artifactContents, qualityFlags) and empty fields from the response. Default false."
  )
};
const getClassSourceSchema = z
  .object(getClassSourceShape)
  .superRefine((value, ctx) => {
    if (
      value.startLine !== undefined &&
      value.endLine !== undefined &&
      value.startLine > value.endLine
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startLine must be less than or equal to endLine.",
        path: ["startLine"]
      });
    }
  });

const getClassMembersShape = {
  className: nonEmptyString,
  target: sourceLookupTargetSchema.describe(SOURCE_LOOKUP_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn (default obfuscated)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().default(true),
  access: memberAccessSchema.default("public").describe("public | all"),
  includeSynthetic: z.boolean().default(false),
  includeInherited: z.boolean().default(false),
  memberPattern: optionalNonEmptyString,
  maxMembers: optionalPositiveInt.describe("default 500, max 5000"),
  projectPath: optionalNonEmptyString,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override version"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false."),
  compact: z.boolean().default(false).describe(
    "When true, strip debug metadata (provenance, artifactContents, qualityFlags, context) and empty fields from the response. Default false."
  )
};
const getClassMembersSchema = z.object(getClassMembersShape);

const verifyMixinTargetMemberSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("method"),
    name: nonEmptyString,
    descriptor: z.string().trim().min(1).optional()
  }),
  z.object({
    kind: z.literal("field"),
    name: nonEmptyString,
    descriptor: z.string().trim().min(1).optional()
  })
]);

const verifyMixinTargetShape = {
  owner: nonEmptyString.describe("Fully-qualified class name of the target owner (e.g. net.minecraft.world.entity.LivingEntity)."),
  member: verifyMixinTargetMemberSchema.describe(
    'Member to verify. Object with kind. Examples: {"kind":"method","name":"tick","descriptor":"()V"} or {"kind":"field","name":"airSupply"}.'
  ),
  mixinMemberName: optionalNonEmptyString.describe(
    "Optional caller-authored mixin field/method name. Drives @Accessor (getXxx/setXxx) and @Invoker (invokeXxx/callXxx) advice when the target is private."
  ),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  projectPath: optionalNonEmptyString.describe("Workspace root path for target.kind=workspace and Loom cache assistance."),
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false.")
};
const verifyMixinTargetSchema = z.object(verifyMixinTargetShape);

const batchSymbolKindSchema = z.enum(["class", "field", "method"]);

const batchClassSourceEntrySchema = z.object({
  className: nonEmptyString,
  mode: sourceModeSchema.optional(),
  startLine: optionalPositiveInt,
  endLine: optionalPositiveInt,
  maxLines: optionalPositiveInt,
  maxChars: optionalPositiveInt,
  outputFile: optionalNonEmptyString
});

const batchClassSourceShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional().describe("1..8, default 4"),
  failFast: z.boolean().optional().describe("default false"),
  compact: z.boolean().optional().describe("default true"),
  entries: z
    .array(batchClassSourceEntrySchema)
    .min(1)
    .max(50)
    .describe("1..50 entries; each shares the resolved target artifact.")
};
const batchClassSourceSchema = z.object(batchClassSourceShape).superRefine((value, ctx) => {
  // Per-entry `outputFile` is forwarded into the concurrently-dispatched
  // `getClassSource` calls; two entries resolving to the same physical file
  // would race on `writeFile`. Normalize via `path.resolve` so aliases like
  // `out.java` / `./out.java` / `dir/../out.java` collide as expected,
  // matching the writer's `isAbsolute(p) ? p : resolvePath(p)` rule.
  const seen = new Map<string, { index: number; raw: string }>();
  for (let i = 0; i < value.entries.length; i += 1) {
    const entry = value.entries[i];
    if (!entry || entry.outputFile === undefined) continue;
    const trimmed = entry.outputFile.trim();
    if (trimmed.length === 0) continue;
    const canonical = pathIsAbsolute(trimmed) ? trimmed : pathResolve(trimmed);
    const previous = seen.get(canonical);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", i, "outputFile"],
        message: `Duplicate outputFile (resolves to "${canonical}") with entry ${previous.index} (raw "${previous.raw}"); concurrent batch writes to the same file would race. Each entry's outputFile must resolve to a unique path.`
      });
    } else {
      seen.set(canonical, { index: i, raw: trimmed });
    }
  }
});

const batchClassMembersEntrySchema = z.object({
  className: nonEmptyString,
  access: memberAccessSchema.optional(),
  includeSynthetic: z.boolean().optional(),
  includeInherited: z.boolean().optional(),
  memberPattern: optionalNonEmptyString,
  maxMembers: optionalPositiveInt
});

const batchClassMembersShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchClassMembersEntrySchema).min(1).max(50)
};
const batchClassMembersSchema = z.object(batchClassMembersShape);

const batchSymbolExistsTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  workspaceTargetSchema
]).describe(
  'Object with kind. Only kind="version" or kind="workspace" is accepted; dependency/jar/coordinate targets carry library versions, not Minecraft versions, and would corrupt the mapping query.'
);

const batchSymbolExistsEntrySchema = z.object({
  kind: batchSymbolKindSchema,
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString,
  nameMode: classNameModeSchema.optional(),
  signatureMode: z.enum(["exact", "name-only"]).optional(),
  maxCandidates: optionalPositiveInt
});

const batchSymbolExistsShape = {
  target: batchSymbolExistsTargetSchema,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchSymbolExistsEntrySchema).min(1).max(50)
};
const batchSymbolExistsSchema = z.object(batchSymbolExistsShape);

const batchMappingsEntrySchema = z
  .object({
    kind: batchSymbolKindSchema,
    name: nonEmptyString,
    owner: optionalNonEmptyString,
    descriptor: optionalDescriptorString,
    sourceMapping: sourceMappingSchema,
    targetMapping: sourceMappingSchema,
    signatureMode: z.enum(["exact", "name-only"]).optional(),
    disambiguation: z
      .object({
        ownerHint: optionalNonEmptyString,
        descriptorHint: optionalNonEmptyString
      })
      .partial()
      .optional(),
    maxCandidates: optionalPositiveInt
  })
  .strict();

const batchMappingsShape = {
  version: nonEmptyString.describe(
    "Minecraft version shared by every entry. Per-entry version is rejected; this batch shape is intentionally single-version."
  ),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  projectPath: optionalNonEmptyString,
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchMappingsEntrySchema).min(1).max(50)
};
const batchMappingsSchema = z.object(batchMappingsShape);

const searchClassSourceShape = {
  artifactId: nonEmptyString,
  query: nonEmptyString,
  intent: searchIntentSchema.optional().describe("symbol | text | path"),
  match: searchMatchSchema.optional().describe("exact | prefix | contains | regex"),
  packagePrefix: optionalNonEmptyString,
  fileGlob: optionalNonEmptyString,
  symbolKind: searchSymbolKindSchema.optional().describe("class | interface | enum | record | method | field"),
  queryMode: z.enum(["auto", "token", "literal"]).default("auto").describe("auto: indexed search, including separator queries like foo.bar; token: indexed-only; literal: explicit substring scan only"),
  limit: optionalPositiveInt.default(20),
  cursor: optionalNonEmptyString,
  queryNamespace: sourceMappingSchema.optional().describe(
    "Namespace of the query. When set and intent='symbol' with a fully-qualified class name, the query is translated through find-mapping before searching the artifact namespace. Ignored for text/path intents (warning surfaced)."
  ),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first. Used only when queryNamespace triggers translation."),
  compact: z.boolean().default(false).describe(
    "When true, strip the artifactContents summary and empty fields from the response. Default false."
  )
};
const searchClassSourceSchema = z.object(searchClassSourceShape).superRefine((value, ctx) => {
  if (value.symbolKind && value.intent && value.intent !== "symbol") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["symbolKind"],
      message: 'symbolKind filter is only supported when intent="symbol".'
    });
  }
});

const getArtifactFileShape = {
  artifactId: nonEmptyString,
  filePath: nonEmptyString,
  maxBytes: optionalPositiveInt
};
const getArtifactFileSchema = z.object(getArtifactFileShape);

const listArtifactFilesShape = {
  artifactId: nonEmptyString,
  prefix: optionalNonEmptyString,
  limit: optionalPositiveInt,
  cursor: optionalNonEmptyString,
  compact: z.boolean().default(false).describe(
    "When true, strip the artifactContents summary and empty fields from the response. Default false."
  )
};
const listArtifactFilesSchema = z.object(listArtifactFilesShape);

const traceSymbolLifecycleShape = {
  symbol: nonEmptyString.describe("fully.qualified.Class.method"),
  descriptor: optionalDescriptorString.describe('optional JVM descriptor, e.g. "(I)V". Empty strings are treated as omitted.'),
  fromVersion: optionalNonEmptyString,
  toVersion: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn (default obfuscated)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  includeSnapshots: z.boolean().default(false),
  maxVersions: optionalPositiveInt.default(120).describe("max 400"),
  includeTimeline: z.boolean().default(false)
};
const traceSymbolLifecycleSchema = z.object(traceSymbolLifecycleShape);

const diffClassSignaturesShape = {
  className: nonEmptyString,
  fromVersion: nonEmptyString,
  toVersion: nonEmptyString,
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn (default obfuscated)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  includeFullDiff: z.boolean().default(true).describe("When false, omit from/to snapshots from modified entries and keep only key+changed")
};
const diffClassSignaturesSchema = z.object(diffClassSignaturesShape);

const findMappingShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor. Optional when signatureMode='name-only' (default). Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  signatureMode: z.enum(["exact", "name-only"]).default("name-only")
    .describe("exact: descriptor required for kind=method; name-only (default): match by owner+name only"),
  disambiguation: z
    .object({
      ownerHint: optionalNonEmptyString,
      descriptorHint: optionalNonEmptyString
    })
    .partial()
    .optional(),
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
const findMappingSchema = z.object(findMappingShape).superRefine((value, ctx) => {
  if (value.kind === "class") {
    if (value.owner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "owner is not allowed when kind=class.",
        path: ["owner"]
      });
    }
    if (value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is not allowed when kind=class.",
        path: ["descriptor"]
      });
    }
    if (value.sourceMapping !== "obfuscated" && !value.name.includes(".")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name must be fully-qualified class name when kind=class.",
        path: ["name"]
      });
    }
    return;
  }

  if (!value.owner) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "owner is required when kind is field or method.",
      path: ["owner"]
    });
  }
  if (/[\s./()]/.test(value.name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "name must be a simple member name when kind is field or method.",
      path: ["name"]
    });
  }

  if (value.kind === "field") {
    if (value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is not allowed when kind=field.",
        path: ["descriptor"]
      });
    }
    return;
  }

  if (!value.descriptor && value.signatureMode !== "name-only") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "descriptor is required when kind=method (use signatureMode='name-only' to match by name only).",
      path: ["descriptor"]
    });
  }
});

const resolveMethodMappingExactShape = {
  version: nonEmptyString,
  name: nonEmptyString,
  owner: nonEmptyString,
  descriptor: nonEmptyString.describe("required JVM descriptor"),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
const resolveMethodMappingExactSchema = z
  .object(resolveMethodMappingExactShape)
  .superRefine((value, ctx) => {
    if (/[\s./()]/.test(value.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name must be a simple method name.",
        path: ["name"]
      });
    }
  });

const classApiKindsSchema = z.string().superRefine((value, ctx) => {
  const tokens = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (tokens.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "includeKinds must include at least one of class, field, method."
    });
    return;
  }

  const invalidTokens = tokens.filter(
    (entry) => entry !== "class" && entry !== "field" && entry !== "method"
  );
  if (invalidTokens.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `includeKinds contains invalid values: ${invalidTokens.join(", ")}. Allowed values are class, field, method.`
    });
  }
});

const getClassApiMatrixShape = {
  version: nonEmptyString,
  className: nonEmptyString,
  classNameMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  includeKinds: classApiKindsSchema.optional().describe("comma-separated: class,field,method"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  maxRows: optionalPositiveInt.describe("Limit returned rows (max 5000)")
};
const getClassApiMatrixSchema = z.object(getClassApiMatrixShape);

const resolveWorkspaceSymbolShape = {
  projectPath: nonEmptyString,
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor. Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates for field/method lookups (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
const resolveWorkspaceSymbolSchema = z
  .object(resolveWorkspaceSymbolShape)
  .superRefine((value, ctx) => {
    if (value.kind === "class") {
      if (value.owner) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "owner is not allowed when kind=class.",
          path: ["owner"]
        });
      }
      if (value.descriptor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "descriptor is not allowed when kind=class.",
          path: ["descriptor"]
        });
      }
      if (!value.name.includes(".")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "name must be fully-qualified class name when kind=class.",
          path: ["name"]
        });
      }
      return;
    }
    if (!value.owner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "owner is required when kind is field or method.",
        path: ["owner"]
      });
    }
    if (/[\s./()]/.test(value.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name must be a simple member name when kind is field or method.",
        path: ["name"]
      });
    }
    if (value.kind === "field") {
      if (value.descriptor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "descriptor is not allowed when kind=field.",
          path: ["descriptor"]
        });
      }
      return;
    }
    if (!value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is required when kind=method.",
        path: ["descriptor"]
      });
    }
  });

const checkSymbolExistsShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  owner: optionalNonEmptyString,
  name: nonEmptyString,
  descriptor: optionalDescriptorString.describe("required for kind=method unless signatureMode=name-only. Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  nameMode: classNameModeSchema.default("fqcn").describe("fqcn | auto"),
  signatureMode: z.enum(["exact", "name-only"]).default("exact")
    .describe("exact: require descriptor for methods; name-only: match by owner+name only"),
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
const checkSymbolExistsSchema = z.object(checkSymbolExistsShape).superRefine((value, ctx) => {
  if (value.kind === "class") {
    if (value.owner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "owner is not allowed when kind=class.",
        path: ["owner"]
      });
    }
    if (value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is not allowed when kind=class.",
        path: ["descriptor"]
      });
    }
    if (value.nameMode !== "auto" && !value.name.includes(".")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name must be fully-qualified class name when kind=class.",
        path: ["name"]
      });
    }
    return;
  }

  if (!value.owner) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "owner is required when kind is field or method.",
      path: ["owner"]
    });
  }
  if (/[\s./()]/.test(value.name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "name must be a simple member name when kind is field or method.",
      path: ["name"]
    });
  }
  if (value.kind === "field") {
    if (value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is not allowed when kind=field.",
        path: ["descriptor"]
      });
    }
    return;
  }
  if (!value.descriptor && value.signatureMode !== "name-only") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "descriptor is required when kind=method (use signatureMode='name-only' to match by name only).",
      path: ["descriptor"]
    });
  }
});

const nbtToJsonShape = {
  nbtBase64: nonEmptyString,
  compression: decodeCompressionSchema.default("auto").describe("none | gzip | auto")
};
const nbtToJsonSchema = z.object(nbtToJsonShape);

const nbtPatchOperationSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "test"]),
    path: nonEmptyString,
    value: z.unknown().optional()
  })
  .passthrough();

const nbtApplyJsonPatchShape = {
  typedJson: z.unknown(),
  patch: z.array(nbtPatchOperationSchema).describe("RFC6902 operation array (add/remove/replace/test)")
};
const nbtApplyJsonPatchSchema = z.object(nbtApplyJsonPatchShape);

const jsonToNbtShape = {
  typedJson: z.unknown(),
  compression: encodeCompressionSchema.default("none").describe("none | gzip")
};
const jsonToNbtSchema = z.object(jsonToNbtShape);

const indexArtifactShape = {
  artifactId: nonEmptyString,
  force: z.boolean().default(false)
};
const indexArtifactSchema = z.object(indexArtifactShape);

const validateMixinShape = {
  input: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("inline"),
      source: nonEmptyString.describe("Mixin Java source text")
    }),
    z.object({
      mode: z.literal("path"),
      path: nonEmptyString.describe("Path to a Mixin .java file")
    }),
    z.object({
      mode: z.literal("paths"),
      paths: z.array(nonEmptyString).min(1).describe("Array of Mixin .java file paths for batch validation")
    }),
    z.object({
      mode: z.literal("config"),
      configPaths: z.array(nonEmptyString).min(1).describe("Path array to mixin config JSON files (e.g. modid.mixins.json)")
    }),
    z.object({
      mode: z.literal("project"),
      path: nonEmptyString.describe("Workspace root path used to discover *.mixins.json files automatically")
    })
  ]).describe("One of { mode: 'inline', source }, { mode: 'path', path }, { mode: 'paths', paths[] }, { mode: 'config', configPaths[] }, or { mode: 'project', path }."),
  sourceRoots: z.array(z.string().min(1)).optional()
    .describe("Array of source roots for multi-module projects (e.g. ['common/src/main/java', 'neoforge/src/main/java'])"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override version"),
  minSeverity: z.enum(["error", "warning", "all"]).default("all")
    .describe("'error'=errors only, 'warning'=errors+warnings, 'all'=everything"),
  hideUncertain: z.boolean().default(false)
    .describe("Omit issues with confidence='uncertain'"),
  explain: z.boolean().default(false)
    .describe("When true, enrich each issue with explanation and suggestedCall for agent recovery"),
  warningMode: z.enum(["full", "aggregated"]).optional()
    .describe("'full'=all warnings; 'aggregated'=group warnings by category with counts and samples. Single validation uses the provided value as-is; batch validation defaults to 'aggregated'"),
  preferProjectMapping: z.boolean().default(false)
    .describe("When true, auto-detect mapping from project config even if mapping is explicitly provided"),
  reportMode: z.enum(["compact", "full", "summary-first"]).default("full")
    .describe("'compact' omits heavy per-result detail, 'summary-first' hoists shared provenance/warnings/incomplete reasons, 'full'=everything"),
  warningCategoryFilter: z.array(z.enum(["mapping", "configuration", "validation", "resolution", "parse"])).optional()
    .describe("Only include warnings/issues matching these categories (default: all)"),
  treatInfoAsWarning: z.boolean().default(true)
    .describe("When false, suppress info-severity structured warnings from output"),
  includeIssues: z.boolean().default(true)
    .describe("When false, keep summary fields but omit per-result issues[] payloads")
};
const validateMixinSchema = z.object(validateMixinShape);

const validateAccessWidenerShape = {
  content: nonEmptyString.describe("Access Widener file content"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted runtime validation"),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().default(false)
    .describe("When true, detect MC version from gradle.properties and override version")
};
const validateAccessWidenerSchema = z.object(validateAccessWidenerShape);

const validateAccessTransformerShape = {
  content: nonEmptyString.describe("Access Transformer file content"),
  version: nonEmptyString.describe("Minecraft version"),
  atNamespace: z.enum(["srg", "mojang", "obfuscated"]).optional().describe("srg | mojang | obfuscated"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Forge/NeoForge runtime validation"),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().default(false)
    .describe("When true, detect MC version from gradle.properties and override version")
};
const validateAccessTransformerSchema = z.object(validateAccessTransformerShape);

const analyzeModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  includeClasses: z.boolean().default(false).describe("Include full class listing")
};
const analyzeModJarSchema = z.object(analyzeModJarShape);

const getRegistryDataShape = {
  version: nonEmptyString.describe("Minecraft version (e.g. 1.21)"),
  registry: optionalNonEmptyString.describe('Optional registry name (e.g. "block", "item", "minecraft:biome"). Omit to list all registries.'),
  includeData: z.boolean().default(true).describe("When false, return registry names/counts without full entry bodies"),
  maxEntriesPerRegistry: optionalPositiveInt.describe("Limit returned entries per registry body")
};
const getRegistryDataSchema = z.object(getRegistryDataShape);

const COMPARE_VERSIONS_CATEGORIES = ["classes", "registry", "all"] as const;
const compareVersionsCategorySchema = z.enum(COMPARE_VERSIONS_CATEGORIES);

const compareVersionsShape = {
  fromVersion: nonEmptyString.describe("Older Minecraft version (e.g. 1.20.4)"),
  toVersion: nonEmptyString.describe("Newer Minecraft version (e.g. 1.21)"),
  category: compareVersionsCategorySchema.default("all").describe("classes | registry | all"),
  packageFilter: optionalNonEmptyString.describe("Filter classes to a package prefix (e.g. net.minecraft.world.item)"),
  maxClassResults: optionalPositiveInt.default(500).describe("Max class results per direction (max 5000)")
};
const compareVersionsSchema = z.object(compareVersionsShape);

const decompileModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: optionalNonEmptyString.describe("Optional fully-qualified class name to view source. Omit to list all classes."),
  includeFiles: z.boolean().default(true).describe("When false, omit the full class list and return counts only"),
  maxFiles: optionalPositiveInt.describe("Limit returned class names when files are included")
};
const decompileModJarSchema = z.object(decompileModJarShape);

const getModClassSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: nonEmptyString.describe("Fully-qualified class name (e.g. com.example.MyMixin)"),
  maxLines: optionalPositiveInt.describe("Max lines to return"),
  maxChars: optionalPositiveInt.describe("Hard character limit; truncates if exceeded"),
  outputFile: optionalNonEmptyString.describe("Write full source to file, return placeholder in content")
};
const getModClassSourceSchema = z.object(getModClassSourceShape);

const MOD_SEARCH_TYPES = ["class", "method", "field", "content", "all"] as const;
const modSearchTypeSchema = z.enum(MOD_SEARCH_TYPES);

const searchModSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  query: nonEmptyString.describe("Search pattern (regex or literal string)"),
  searchType: modSearchTypeSchema.default("all").describe("class | method | field | content | all"),
  limit: optionalPositiveInt.default(50).describe("Max results (max 200)")
};
const searchModSourceSchema = z.object(searchModSourceShape);

const REMAP_TARGETS = ["yarn", "mojang"] as const;
const remapTargetSchema = z.enum(REMAP_TARGETS);

const remapModJarShape = {
  inputJar: nonEmptyString.describe("Path to the mod JAR file"),
  outputJar: optionalNonEmptyString.describe("Output path for remapped JAR (auto-generated if omitted)"),
  mcVersion: optionalNonEmptyString.describe("Minecraft version (auto-detected from mod metadata if omitted)"),
  targetMapping: remapTargetSchema.describe("yarn | mojang")
};
const remapModJarSchema = z.object(remapModJarShape);

const emptySchema = z.object({}).passthrough();

function getServerVersionFromPackageJson(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // ignore and fallback
  }
  return "0.3.0";
}

const SERVER_VERSION = getServerVersionFromPackageJson();

const server = new McpServer({
  name: "@adhisang/minecraft-modding-mcp",
  version: SERVER_VERSION
});

// The SDK validates tool args before invoking handlers and returns generic InvalidParams text.
// Bypass that layer so runTool() remains the single source of truth for validation and error envelopes.
(
  server as unknown as {
    validateToolInput: (_tool: unknown, args: unknown, _toolName: string) => Promise<unknown>;
  }
).validateToolInput = async (_tool: unknown, args: unknown) => args;

const config = loadConfig();
const nbtLimits = {
  maxInputBytes: config.maxNbtInputBytes,
  maxInflatedBytes: config.maxNbtInflatedBytes,
  maxResponseBytes: config.maxNbtResponseBytes
};

let sourceServiceInstance: SourceService | undefined;

function getSourceService(): SourceService {
  sourceServiceInstance ??= new SourceService(config);
  return sourceServiceInstance;
}

const sourceService = new Proxy({} as SourceService, {
  get(_target, property, _receiver) {
    const service = getSourceService();
    const value = Reflect.get(service, property, service);
    return typeof value === "function" ? value.bind(service) : value;
  }
});
const workspaceMappingService = new WorkspaceMappingService();
const inspectMinecraftService = new InspectMinecraftService({
  listVersions: (input) => sourceService.listVersions(input),
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  findClass: (input) => Promise.resolve(sourceService.findClass(input)),
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input),
  getClassSource: (input) => sourceService.getClassSource(input),
  getClassMembers: (input) => sourceService.getClassMembers(input),
  searchClassSource: (input) => sourceService.searchClassSource(input),
  getArtifactFile: (input) => sourceService.getArtifactFile(input),
  listArtifactFiles: (input) => sourceService.listArtifactFiles(input),
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath)
});
const analyzeSymbolService = new AnalyzeSymbolService({
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input),
  findMapping: (input) => sourceService.findMapping(input),
  resolveMethodMappingExact: (input) => sourceService.resolveMethodMappingExact(input),
  traceSymbolLifecycle: (input) => sourceService.traceSymbolLifecycle(input),
  resolveWorkspaceSymbol: (input) => sourceService.resolveWorkspaceSymbol(input),
  getClassApiMatrix: (input) => sourceService.getClassApiMatrix(input)
});
const compareMinecraftService = new CompareMinecraftService({
  compareVersions: (input) => sourceService.compareVersions(input),
  diffClassSignatures: (input) => sourceService.diffClassSignatures(input),
  getRegistryData: (input) => sourceService.getRegistryData(input)
});
const analyzeModService = new AnalyzeModService({
  analyzeModJar: (jarPath, options) => analyzeModJar(jarPath, options),
  decompileModJar: (input) => sourceService.decompileModJar(input),
  getModClassSource: (input) => sourceService.getModClassSource(input),
  searchModSource: (input) => sourceService.searchModSource(input),
  remapModJar: (input) => remapModJar(input, config) as unknown as Promise<Record<string, unknown> & { warnings?: string[] }>
});
const validateProjectService = new ValidateProjectService({
  validateMixin: (input) => sourceService.validateMixin(input as any) as Promise<Record<string, unknown> & { warnings?: string[] }>,
  validateAccessWidener: (input) => sourceService.validateAccessWidener(input),
  validateAccessTransformer: (input) => sourceService.validateAccessTransformer(input),
  discoverMixins: discoverWorkspaceMixins,
  discoverAccessWideners: discoverWorkspaceAccessWideners,
  discoverAccessTransformers: discoverWorkspaceAccessTransformers,
  detectProjectMinecraftVersion: (projectPath) =>
    workspaceMappingService.detectProjectMinecraftVersion(projectPath),
  resolveArtifact: async (input) => {
    const output = await sourceService.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      warnings: output.warnings
    };
  }
});
const manageCacheService = new ManageCacheService({
  registry: createCacheRegistry({
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath
  })
});
const verifyMixinTargetService = new VerifyMixinTargetService({
  resolveArtifact: async (input) => {
    const output = await sourceService.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    return {
      artifactId: output.artifactId,
      mappingApplied: output.mappingApplied,
      binaryJarPath: output.binaryJarPath,
      provenance: output.provenance,
      warnings: output.warnings
    };
  },
  getSignature: (input) =>
    (sourceService as unknown as {
      explorerService: {
        getSignature: (input: Record<string, unknown>) => Promise<{
          classAccessFlags?: number;
          constructors: Array<Record<string, unknown>>;
          methods: Array<Record<string, unknown>>;
          fields: Array<Record<string, unknown>>;
          warnings: string[];
        }>;
      };
    }).explorerService.getSignature(input) as Promise<{
      classAccessFlags?: number;
      constructors: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      methods: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      fields: Array<{
        ownerFqn: string;
        name: string;
        javaSignature: string;
        jvmDescriptor: string;
        accessFlags: number;
        isSynthetic: boolean;
        sourceLine?: number;
      }>;
      warnings: string[];
    }>
});

const batchClassSourceService = new BatchClassSourceService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  getClassSource: (input) => sourceService.getClassSource(input)
});
const batchClassMembersService = new BatchClassMembersService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  getClassMembers: (input) => sourceService.getClassMembers(input)
});
const batchSymbolExistsService = new BatchSymbolExistsService({
  resolveArtifact: (input) => sourceService.resolveArtifact(input),
  checkSymbolExists: (input) => sourceService.checkSymbolExists(input)
});
const batchMappingsService = new BatchMappingsService({
  findMapping: (input) => sourceService.findMapping(input)
});

registerResources(server, sourceService);

let processHandlersAttached = false;
let serverStarted = false;

function attachProcessErrorHandlers(): void {
  if (processHandlersAttached) {
    return;
  }
  processHandlersAttached = true;

  process.on("uncaughtException", (caughtError) => {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
    log("error", "process.uncaught_exception", {
      message: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    log("error", "process.unhandled_rejection", {
      message: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  });
}

function buildRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSourceLookupTarget(
  target: SourceLookupTargetInput
): {
  artifactId?: string;
  target?: ResolveArtifactTargetInput;
} {
  if (target.type === "artifact") {
    return { artifactId: target.artifactId };
  }
  const { type: _type, ...rest } = target;
  return { target: rest as ResolveArtifactTargetInput };
}

function parseClassApiKinds(value: string | undefined): WorkspaceSymbolKind[] | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(
      (entry): entry is WorkspaceSymbolKind =>
        entry === "class" || entry === "field" || entry === "method"
    );

  if (normalized.length === 0) {
    return undefined;
  }

  return [...new Set(normalized)];
}

function toFieldErrorsFromZod(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "$",
    message: issue.message,
    code: issue.code
  }));
}

function toHints(details: unknown): string[] | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }

  const hints: string[] = [];
  const maybeNextAction = (details as Record<string, unknown>).nextAction;
  if (typeof maybeNextAction === "string" && maybeNextAction.trim()) {
    hints.push(maybeNextAction.trim());
  }

  if (hints.length === 0) {
    return undefined;
  }
  return hints;
}

const VALIDATION_FALLBACK_HINT =
  "suggested call payload failed schema validation; using fallback examples";

function extractValidatedSuggestionAndExamples(details: unknown): {
  suggestedCall?: SuggestedCall;
  exampleCalls?: ExampleCall[];
  primaryDropped: boolean;
} {
  if (typeof details !== "object" || details == null) {
    return { primaryDropped: false };
  }
  const record = details as Record<string, unknown>;
  let primaryDropped = record._suggestedCallPrimaryDropped === true;
  let suggestedCall: SuggestedCall | undefined;

  const rawSuggested = record.suggestedCall;
  if (rawSuggested !== undefined) {
    if (
      typeof rawSuggested === "object" &&
      rawSuggested !== null &&
      !Array.isArray(rawSuggested)
    ) {
      const call = rawSuggested as { tool?: unknown; params?: unknown };
      if (
        typeof call.tool === "string" &&
        typeof call.params === "object" &&
        call.params !== null &&
        !Array.isArray(call.params)
      ) {
        const validated = buildSuggestedCall({
          tool: call.tool,
          params: call.params as Record<string, unknown>
        });
        if (validated.suggestedCall) {
          suggestedCall = validated.suggestedCall;
        } else {
          primaryDropped = true;
        }
      } else {
        primaryDropped = true;
      }
    } else {
      primaryDropped = true;
    }
  }

  let exampleCalls: ExampleCall[] | undefined;
  const rawExamples = record.exampleCalls;
  if (Array.isArray(rawExamples)) {
    const validated: ExampleCall[] = [];
    for (const entry of rawExamples) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const ex = entry as { tool?: unknown; params?: unknown; reason?: unknown };
      if (
        typeof ex.tool !== "string" ||
        typeof ex.params !== "object" ||
        ex.params === null ||
        Array.isArray(ex.params) ||
        typeof ex.reason !== "string"
      ) {
        continue;
      }
      const result = buildSuggestedCall({
        tool: ex.tool,
        params: ex.params as Record<string, unknown>
      });
      if (result.suggestedCall) {
        validated.push({
          tool: ex.tool,
          params: result.suggestedCall.params,
          reason: ex.reason
        });
      }
    }
    if (validated.length > 0) {
      exampleCalls = validated;
    }
  }

  return { suggestedCall, exampleCalls, primaryDropped };
}

function extractFailedStageFromDetails(details: unknown): string | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }
  const maybeStage = (details as Record<string, unknown>).failedStage;
  if (typeof maybeStage === "string" && maybeStage.trim().length > 0) {
    return maybeStage;
  }
  return undefined;
}

function extractFieldErrorsFromDetails(details: unknown): ProblemFieldError[] | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }

  const maybeFieldErrors = (details as Record<string, unknown>).fieldErrors;
  if (!Array.isArray(maybeFieldErrors)) {
    return undefined;
  }

  const normalized = maybeFieldErrors
    .map((entry) => {
      if (typeof entry !== "object" || entry == null) {
        return undefined;
      }
      const asRecord = entry as Record<string, unknown>;
      const path = asRecord.path;
      const message = asRecord.message;
      const code = asRecord.code;
      if (typeof path !== "string" || typeof message !== "string") {
        return undefined;
      }
      return {
        path,
        message,
        code: typeof code === "string" ? code : undefined
      };
    })
    .filter(
      (entry): entry is { path: string; message: string; code: string | undefined } =>
        entry != null
    );

  return normalized.length > 0 ? normalized : undefined;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())
    ? value as string[]
    : undefined;
}

function truncateSuggestionText(value: string, maxLength = 500): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}...`
    : value;
}

function parseJsonObjectString(value: string): Record<string, unknown> | undefined {
  if (!value.trim().startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return asObjectRecord(parsed);
  } catch {
    return undefined;
  }
}

function inferTargetKindFromString(value: string): SourceTargetInput["kind"] {
  if (/[\\/]/.test(value) || /\.jar$/i.test(value)) {
    return "jar";
  }
  if (value.split(":").length >= 3) {
    return "coordinate";
  }
  return "version";
}

function copySourceLookupSuggestionFields(
  tool: "get-class-source" | "get-class-members",
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const stringFields = tool === "get-class-source"
    ? ["className", "mode", "mapping", "sourcePriority", "projectPath", "scope", "outputFile"] as const
    : ["className", "mapping", "sourcePriority", "projectPath", "scope", "access", "memberPattern"] as const;
  for (const field of stringFields) {
    const value = source[field];
    if (
      typeof value === "string" &&
      value.trim() &&
      (!Object.prototype.hasOwnProperty.call(SUGGESTED_CALL_DEFAULTS, field) ||
        !isSuggestedCallDefault(field as keyof typeof SUGGESTED_CALL_DEFAULTS, value))
    ) {
      result[field] = value;
    }
  }

  const numericFields = tool === "get-class-source"
    ? ["startLine", "endLine", "maxLines", "maxChars"] as const
    : ["maxMembers"] as const;
  for (const field of numericFields) {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[field] = value;
    }
  }

  const booleanFields = tool === "get-class-source"
    ? ["allowDecompile", "preferProjectVersion", "strictVersion"] as const
    : ["allowDecompile", "preferProjectVersion", "strictVersion", "includeSynthetic", "includeInherited"] as const;
  for (const field of booleanFields) {
    const value = source[field];
    if (
      typeof value === "boolean" &&
      (!Object.prototype.hasOwnProperty.call(SUGGESTED_CALL_DEFAULTS, field) ||
        !isSuggestedCallDefault(field as keyof typeof SUGGESTED_CALL_DEFAULTS, value))
    ) {
      result[field] = value;
    }
  }

  return result;
}

function copyValidateMixinSharedParams(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const stringFields = [
    "version",
    "mapping",
    "sourcePriority",
    "scope",
    "projectPath",
    "minSeverity",
    "warningMode",
    "reportMode"
  ] as const;
  for (const field of stringFields) {
    const value = source[field];
    if (
      typeof value === "string" &&
      value.trim() &&
      (!Object.prototype.hasOwnProperty.call(SUGGESTED_CALL_DEFAULTS, field) ||
        !isSuggestedCallDefault(field as keyof typeof SUGGESTED_CALL_DEFAULTS, value))
    ) {
      result[field] = value;
    }
  }

  const booleanFields = [
    "preferProjectVersion",
    "hideUncertain",
    "explain",
    "preferProjectMapping",
    "treatInfoAsWarning",
    "includeIssues"
  ] as const;
  for (const field of booleanFields) {
    const value = source[field];
    if (
      typeof value === "boolean" &&
      (!Object.prototype.hasOwnProperty.call(SUGGESTED_CALL_DEFAULTS, field) ||
        !isSuggestedCallDefault(field as keyof typeof SUGGESTED_CALL_DEFAULTS, value))
    ) {
      result[field] = value;
    }
  }

  const sourceRoots = asStringArray(source.sourceRoots);
  if (sourceRoots) {
    result.sourceRoots = sourceRoots;
  }

  const warningCategoryFilter = asStringArray(source.warningCategoryFilter);
  if (warningCategoryFilter) {
    result.warningCategoryFilter = warningCategoryFilter;
  }

  return result;
}

function buildValidateMixinSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
  const record = asObjectRecord(normalizedInput);
  if (!record) {
    return {
      input: {
        mode: "inline",
        source: "<Mixin Java source>"
      },
      version: "<minecraft-version>"
    };
  }

  const inputRecord = asObjectRecord(record.input);
  const shared = copyValidateMixinSharedParams(record);
  const version = asNonEmptyString(record.version) ?? "<minecraft-version>";

  const inlineSource =
    asNonEmptyString(record.input) ??
    asNonEmptyString(inputRecord?.source) ??
    asNonEmptyString(record.source);
  if (inlineSource) {
    const parsedInlineObject = parseJsonObjectString(inlineSource);
    if (parsedInlineObject && typeof parsedInlineObject.mode === "string") {
      return {
        ...shared,
        input: parsedInlineObject,
        version
      };
    }

    return {
      ...shared,
      input: {
        mode: "inline",
        source: truncateSuggestionText(inlineSource)
      },
      version
    };
  }

  const path =
    asNonEmptyString(inputRecord?.path) ??
    asNonEmptyString(record.sourcePath);
  if (path) {
    return {
      ...shared,
      input: {
        mode: "path",
        path
      },
      version
    };
  }

  const paths =
    asStringArray(inputRecord?.paths) ??
    asStringArray(record.sourcePaths);
  if (paths) {
    return {
      ...shared,
      input: {
        mode: "paths",
        paths
      },
      version
    };
  }

  const configPaths =
    asStringArray(inputRecord?.configPaths) ??
    (asNonEmptyString(record.mixinConfigPath) ? [record.mixinConfigPath as string] : undefined);
  if (configPaths) {
    return {
      ...shared,
      input: {
        mode: "config",
        configPaths
      },
      version
    };
  }

  const projectPath =
    asNonEmptyString(record.projectPath) ??
    (inputRecord?.mode === "project" ? asNonEmptyString(inputRecord.path) : undefined);
  if (projectPath) {
    return {
      ...shared,
      input: {
        mode: "project",
        path: projectPath
      },
      version
    };
  }

  return {
    ...shared,
    input: {
      mode: "inline",
      source: "<Mixin Java source>"
    },
    version
  };
}

function buildResolveArtifactSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
  const record = asObjectRecord(normalizedInput);
  if (!record) {
    return {
      target: {
        kind: "version",
        value: "<minecraft-version>"
      }
    };
  }

  const targetValue = asNonEmptyString(record.target);
  const result: Record<string, unknown> = {
    target: targetValue
      ? {
          kind: inferTargetKindFromString(targetValue),
          value: targetValue
        }
      : {
          kind: "version",
          value: "<minecraft-version>"
        }
  };

  const stringFields = ["mapping", "sourcePriority", "projectPath", "scope"] as const;
  for (const field of stringFields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      result[field] = value;
    }
  }

  const booleanFields = ["allowDecompile", "preferProjectVersion", "strictVersion"] as const;
  for (const field of booleanFields) {
    const value = record[field];
    if (
      typeof value === "boolean" &&
      !isSuggestedCallDefault(field, value)
    ) {
      result[field] = value;
    }
  }

  return result;
}

function buildSourceLookupSuggestedParams(
  tool: "get-class-source" | "get-class-members",
  normalizedInput: unknown
): Record<string, unknown> {
  const record = asObjectRecord(normalizedInput);
  const result = record ? copySourceLookupSuggestionFields(tool, record) : {};
  const targetValue = asNonEmptyString(record?.target);

  result.target = targetValue
    ? {
        type: "resolve",
        kind: inferTargetKindFromString(targetValue),
        value: targetValue
      }
    : {
        type: "resolve",
        kind: "version",
        value: "<minecraft-version>"
      };

  if (!asNonEmptyString(result.className)) {
    result.className = "<fully-qualified-class-name>";
  }

  return result;
}

function filterAllowedIncludeValues(
  values: string[] | undefined,
  allowed: readonly string[]
): string[] {
  if (!values?.length) {
    return [];
  }
  const allowedSet = new Set(allowed);
  const filtered = values.filter((value) => allowedSet.has(value));
  return [...new Set(filtered)];
}

function buildAnalyzeModSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
  const record = asObjectRecord(normalizedInput);
  if (!record) {
    return {
      task: "summary",
      detail: "standard",
      subject: {
        kind: "jar",
        jarPath: "<mod-jar-path>"
      }
    };
  }

  const task = asNonEmptyString(record.task) ?? "summary";
  const result: Record<string, unknown> = { task };
  const subjectRecord = asObjectRecord(record.subject);
  const include = asStringArray(record.include);
  const canonicalInclude = filterAllowedIncludeValues(include, ANALYZE_MOD_INCLUDE_GROUPS);
  const wantsLegacyMetadata = include?.some((value) =>
    ANALYZE_MOD_LEGACY_METADATA_INCLUDES.includes(value as typeof ANALYZE_MOD_LEGACY_METADATA_INCLUDES[number])
  ) ?? false;
  const detail = asNonEmptyString(record.detail);

  if (task === "summary" && wantsLegacyMetadata) {
    result.detail = detail && detail !== "summary" ? detail : "standard";
  } else if (detail && detail !== "summary") {
    result.detail = detail;
  }

  if (canonicalInclude.length > 0) {
    result.include = canonicalInclude;
  }

  if (task === "class-source") {
    result.subject = {
      kind: "class",
      jarPath: asNonEmptyString(subjectRecord?.jarPath) ?? asNonEmptyString(record.subject) ?? "<mod-jar-path>",
      className: asNonEmptyString(subjectRecord?.className) ?? asNonEmptyString(record.className) ?? "<fully-qualified-class-name>"
    };
  } else {
    result.subject = {
      kind: "jar",
      jarPath: asNonEmptyString(subjectRecord?.jarPath) ?? asNonEmptyString(record.subject) ?? asNonEmptyString(record.jarPath) ?? "<mod-jar-path>"
    };
  }

  const stringFields = ["query", "searchType", "targetMapping", "outputJar", "executionMode"] as const;
  for (const field of stringFields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      result[field] = value;
    }
  }

  const booleanFields = ["includeFiles"] as const;
  for (const field of booleanFields) {
    const value = record[field];
    if (typeof value === "boolean") {
      result[field] = value;
    }
  }

  const numericFields = ["limit", "maxFiles", "maxLines", "maxChars"] as const;
  for (const field of numericFields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[field] = value;
    }
  }

  return result;
}

function buildValidateProjectSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
  const record = asObjectRecord(normalizedInput);
  if (!record) {
    return {
      task: "project-summary",
      subject: {
        kind: "workspace",
        projectPath: "<workspace-path>"
      },
      preferProjectVersion: true
    };
  }

  const task = asNonEmptyString(record.task) ?? "project-summary";
  const result: Record<string, unknown> = { task };
  const subjectRecord = asObjectRecord(record.subject);
  const include = asStringArray(record.include);
  const canonicalInclude = filterAllowedIncludeValues(include, VALIDATE_PROJECT_INCLUDE_GROUPS);
  const wantsWorkspaceInclude = include?.some((value) =>
    VALIDATE_PROJECT_LEGACY_WORKSPACE_INCLUDES.includes(value as typeof VALIDATE_PROJECT_LEGACY_WORKSPACE_INCLUDES[number])
  ) ?? false;
  const detail = asNonEmptyString(record.detail);

  if (detail && detail !== "summary") {
    result.detail = detail;
  }

  const includeSuggestion = wantsWorkspaceInclude
    ? [...new Set([...canonicalInclude, "workspace"])]
    : canonicalInclude;
  if (includeSuggestion.length > 0) {
    result.include = includeSuggestion;
  }

  const stringFields = [
    "version",
    "mapping",
    "sourcePriority",
    "scope",
    "minSeverity",
    "warningMode"
  ] as const;
  for (const field of stringFields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      result[field] = value;
    }
  }

  const booleanFields = [
    "preferProjectVersion",
    "preferProjectMapping",
    "hideUncertain",
    "explain",
    "treatInfoAsWarning",
    "includeIssues"
  ] as const;
  for (const field of booleanFields) {
    const value = record[field];
    if (
      typeof value === "boolean" &&
      (!Object.prototype.hasOwnProperty.call(SUGGESTED_CALL_DEFAULTS, field) ||
        !isSuggestedCallDefault(field as keyof typeof SUGGESTED_CALL_DEFAULTS, value))
    ) {
      result[field] = value;
    }
  }

  const sourceRoots = asStringArray(record.sourceRoots);
  if (sourceRoots?.length) {
    result.sourceRoots = sourceRoots;
  }

  const configPaths = asStringArray(record.configPaths);
  if (configPaths?.length) {
    result.configPaths = configPaths;
  }

  const warningCategoryFilter = asStringArray(record.warningCategoryFilter);
  if (warningCategoryFilter?.length) {
    result.warningCategoryFilter = warningCategoryFilter;
  }

  if (task === "project-summary") {
    const subject: Record<string, unknown> = {
      kind: "workspace",
      projectPath:
        asNonEmptyString(subjectRecord?.projectPath) ??
        asNonEmptyString(record.subject) ??
        asNonEmptyString(record.projectPath) ??
        "<workspace-path>"
    };
    const discover = asStringArray(subjectRecord?.discover);
    if (discover?.length) {
      subject.discover = discover;
    }
    result.subject = subject;
    return result;
  }

  if (task === "mixin") {
    const inputRecord = asObjectRecord(subjectRecord?.input) ?? asObjectRecord(record.input);
    result.subject = {
      kind: "mixin",
      input: inputRecord ?? {
        mode: "inline",
        source: "<Mixin Java source>"
      }
    };
    return result;
  }

  const inputRecord = asObjectRecord(subjectRecord?.input) ?? asObjectRecord(record.input);
  result.subject = {
    kind: "access-widener",
    input: inputRecord ?? {
      mode: "inline",
      content: "<access widener contents>"
    }
  };
  return result;
}

type InvalidInputGuidance = {
  hints?: string[];
  suggestedCall?: SuggestedCall;
  exampleCalls?: ExampleCall[];
  primaryDropped?: boolean;
};

function gatedGuidance(
  tool: string,
  hints: string[],
  params: Record<string, unknown>
): InvalidInputGuidance {
  const validated = buildSuggestedCall({ tool, params });
  return {
    hints,
    ...validated,
    primaryDropped: !validated.suggestedCall
  };
}

function buildInvalidInputGuidance(
  tool: string,
  normalizedInput: unknown
): InvalidInputGuidance | undefined {
  if (tool === "validate-mixin") {
    return gatedGuidance(
      tool,
      [
        "validate-mixin.input must be an object with input.mode = \"inline\" | \"path\" | \"paths\" | \"config\" | \"project\".",
        "Whole-project example: {\"input\":{\"mode\":\"project\",\"path\":\"/workspace\"},\"version\":\"1.21.10\",\"preferProjectVersion\":true,\"preferProjectMapping\":true}.",
        "Legacy top-level source/sourcePath/sourcePaths/mixinConfigPath fields are no longer accepted; wrap them under input.mode instead."
      ],
      buildValidateMixinSuggestedParams(normalizedInput)
    );
  }

  if (tool === "resolve-artifact") {
    return gatedGuidance(
      tool,
      [
        "resolve-artifact.target must be an object: {\"kind\":\"version|jar|coordinate\",\"value\":\"...\"}.",
        "Bare string targets are not accepted; wrap the value under target.kind and target.value."
      ],
      buildResolveArtifactSuggestedParams(normalizedInput)
    );
  }

  if (tool === "get-class-source" || tool === "get-class-members") {
    return gatedGuidance(
      tool,
      [
        `${tool}.target must be an object: {"type":"resolve","kind":"version|jar|coordinate","value":"..."} or {"type":"artifact","artifactId":"..."}.`,
        "Bare string targets are not accepted; wrap the value under target.type/target.kind/target.value."
      ],
      buildSourceLookupSuggestedParams(tool, normalizedInput)
    );
  }

  if (tool === "validate-project") {
    return gatedGuidance(
      tool,
      [
        "validate-project.subject must be an object with subject.kind=workspace|mixin|access-widener|access-transformer.",
        "task=\"project-summary\" uses {\"subject\":{\"kind\":\"workspace\",\"projectPath\":\"/workspace\"}}.",
        "Legacy include names like projectSummary/detectedConfig/validationSummary are not accepted; use include:[\"workspace\"] only when you need discovery details."
      ],
      buildValidateProjectSuggestedParams(normalizedInput)
    );
  }

  if (tool === "analyze-mod") {
    return gatedGuidance(
      tool,
      [
        "analyze-mod.subject must be an object with subject.kind=jar|class.",
        "task=\"summary\" uses {\"subject\":{\"kind\":\"jar\",\"jarPath\":\"/path/to/mod.jar\"}}.",
        "Legacy include names like metadata/entrypoints/mixins/dependencies are not accepted; use detail=\"standard\" to surface the metadata block, and canonical include groups only for warnings/files/source/samples/timings."
      ],
      buildAnalyzeModSuggestedParams(normalizedInput)
    );
  }

  return undefined;
}

export function mapErrorToProblem(
  caughtError: unknown,
  requestId: string,
  context?: { tool?: string; normalizedInput?: unknown }
): ProblemDetails {
  if (caughtError instanceof ZodError) {
    const guidance = context?.tool
      ? buildInvalidInputGuidance(context.tool, context.normalizedInput)
      : undefined;
    const baseHints =
      guidance?.hints ?? ["Check fieldErrors and submit a valid tool argument payload."];
    const hintsWithFallback = guidance?.primaryDropped
      ? [...baseHints, VALIDATION_FALLBACK_HINT]
      : baseHints;
    return {
      type: "https://minecraft-modding-mcp.dev/problems/invalid-input",
      title: "Invalid input",
      detail: "Request validation failed.",
      status: 400,
      code: ERROR_CODES.INVALID_INPUT,
      instance: requestId,
      fieldErrors: toFieldErrorsFromZod(caughtError),
      hints: hintsWithFallback,
      ...(guidance?.suggestedCall ? { suggestedCall: guidance.suggestedCall } : {}),
      ...(guidance?.exampleCalls ? { exampleCalls: guidance.exampleCalls } : {}),
      ...(context?.tool === "validate-mixin" ? { failedStage: "input-validation" } : {})
    };
  }

  if (isAppError(caughtError)) {
    const { suggestedCall, exampleCalls, primaryDropped } =
      extractValidatedSuggestionAndExamples(caughtError.details);
    let failedStage = extractFailedStageFromDetails(caughtError.details);
    if (
      !failedStage
      && context?.tool === "validate-mixin"
      && caughtError.code === ERROR_CODES.INVALID_INPUT
    ) {
      failedStage = "input-validation";
    }
    const baseHints = toHints(caughtError.details);
    const hintsWithFallback =
      primaryDropped && !suggestedCall
        ? [...(baseHints ?? []), VALIDATION_FALLBACK_HINT]
        : baseHints;
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance: requestId,
      fieldErrors: extractFieldErrorsFromDetails(caughtError.details),
      hints: hintsWithFallback,
      ...(suggestedCall ? { suggestedCall } : {}),
      ...(exampleCalls ? { exampleCalls } : {}),
      ...(failedStage ? { failedStage } : {})
    };
  }

  return {
    type: "https://minecraft-modding-mcp.dev/problems/internal",
    title: "Internal server error",
    detail: "Unexpected server error.",
    status: 500,
    code: ERROR_CODES.INTERNAL,
    instance: requestId
  };
}

function splitWarnings(data: Record<string, unknown>): {
  result: Record<string, unknown>;
  warnings: string[];
  meta: Record<string, unknown>;
} {
  const result = { ...data };
  const warnings: string[] = [];
  const maybeWarnings = result.warnings;
  if (Array.isArray(maybeWarnings)) {
    warnings.push(...maybeWarnings.filter((entry): entry is string => typeof entry === "string"));
    delete result.warnings;
  }

  let meta: Record<string, unknown> = {};
  const maybeMeta = result.meta;
  if (maybeMeta && typeof maybeMeta === "object" && !Array.isArray(maybeMeta)) {
    meta = { ...(maybeMeta as Record<string, unknown>) };
    delete result.meta;
    const metaWarnings = meta.warnings;
    if (Array.isArray(metaWarnings)) {
      warnings.push(...metaWarnings.filter((entry): entry is string => typeof entry === "string"));
      delete meta.warnings;
    }
  }

  return {
    result,
    warnings: [...new Set(warnings)],
    meta
  };
}

async function runTool<TInput, TResult extends Record<string, unknown>>(
  tool: string,
  rawInput: unknown,
  schema: z.ZodType<TInput>,
  action: (input: TInput) => Promise<TResult>
): Promise<CallToolResult> {
  const requestId = buildRequestId();
  const startedAt = Date.now();
  let normalizedInput: unknown = rawInput;

  try {
    const preparedInput = prepareToolInput(rawInput);
    normalizedInput = preparedInput.normalizedInput;
    const { removedOfficialPaths, suggestedReplacementInput } = preparedInput;
    if (removedOfficialPaths.length > 0) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `The "official" mapping namespace was removed. Use "obfuscated" instead.`,
        details: {
          fieldErrors: removedOfficialPaths.map((path) => ({
            path,
            message: `"official" is no longer supported for this field. Use "obfuscated".`,
            code: "invalid_enum_value"
          })),
          nextAction: `Replace "official" with "obfuscated" in mapping-related fields and retry.`,
          ...(suggestedReplacementInput
            ? buildSuggestedCall({
                tool,
                params: suggestedReplacementInput as Record<string, unknown>
              })
            : {})
        }
      });
    }

    const parsedInput = schema.parse(normalizedInput);
    const payload = await (
      HEAVY_TOOL_NAMES.has(tool)
        ? heavyToolExecutionGate.run(tool, () => action(parsedInput))
        : action(parsedInput)
    );
    const { result, warnings, meta: resultMeta } = splitWarnings(payload);

    const isCompact = isCompactEnabled(tool, parsedInput);
    let projectedResult = result;
    if (isCompact) {
      if (tool === "resolve-artifact") {
        projectedResult = compactArtifactResponse(projectedResult);
      }
      if (COMPACT_MAPPING_TOOL_NAMES.has(tool)) {
        projectedResult = compactMappingResponse(projectedResult);
      }
      if (COMPACT_SOURCE_TOOL_NAMES.has(tool)) {
        projectedResult = compactSourceResponse(projectedResult);
      }
      if (COMPACT_MEMBERS_TOOL_NAMES.has(tool)) {
        projectedResult = compactMembersResponse(projectedResult);
      }
      if (COMPACT_LIGHT_TOOL_NAMES.has(tool)) {
        projectedResult = compactLightResponse(projectedResult);
      }
      projectedResult = compactResponse(
        projectedResult,
        TOOL_PRESERVE_PAYLOAD_KEYS[tool]
      );
    }

    const entryMeta = ENTRY_TOOL_NAMES.has(tool)
      ? buildEntryToolMeta({
          detail:
            normalizedInput &&
            typeof normalizedInput === "object" &&
            !Array.isArray(normalizedInput) &&
            typeof (normalizedInput as { detail?: unknown }).detail === "string"
              ? (normalizedInput as { detail?: "summary" | "standard" | "full" }).detail ?? "summary"
              : "summary",
          include:
            normalizedInput &&
            typeof normalizedInput === "object" &&
            !Array.isArray(normalizedInput) &&
            Array.isArray((normalizedInput as { include?: unknown }).include)
              ? (normalizedInput as { include?: string[] }).include
              : undefined
        })
      : undefined;

    const durationMs = Date.now() - startedAt;
    sourceService.recordToolCall(tool, durationMs);
    return objectResult({
      result: projectedResult,
      meta: {
        ...(entryMeta ?? {}),
        ...resultMeta,
        requestId,
        tool,
        durationMs,
        warnings
      } satisfies ToolMeta
    });
  } catch (caughtError) {
    const problem = mapErrorToProblem(caughtError, requestId, {
      tool,
      normalizedInput
    });

    if (isAppError(caughtError)) {
      const isSevere =
        caughtError.code === ERROR_CODES.DB_FAILURE ||
        caughtError.code === ERROR_CODES.REPO_FETCH_FAILED ||
        caughtError.code === ERROR_CODES.REGISTRY_GENERATION_FAILED ||
        caughtError.code === ERROR_CODES.JAVA_UNAVAILABLE ||
        caughtError.code.startsWith("ERR_DECOMPILER");
      if (isSevere) {
        log("error", "tool.call.failed", {
          requestId,
          tool,
          code: caughtError.code,
          message: caughtError.message
        });
      } else {
        log("warn", "tool.call.warning", {
          requestId,
          tool,
          code: caughtError.code,
          message: caughtError.message
        });
      }
    } else if (!(caughtError instanceof ZodError)) {
      log("error", "tool.call.unhandled", {
        requestId,
        tool,
        reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
      });
    }

    const errorDurationMs = Date.now() - startedAt;
    sourceService.recordToolCall(tool, errorDurationMs);
    const errorMeta: ToolMeta = {
      requestId,
      tool,
      durationMs: errorDurationMs,
      warnings: []
    };
    applyErrorMetaExtensions(errorMeta, caughtError);
    return objectResult({
      error: problem,
      meta: errorMeta
    }, { isError: true });
  }
}

/**
 * Copy documented error-only meta fields from AppError.details into the
 * public envelope. Scoped to `ERR_STAGE_BUDGET_PRE_PARSE` per
 * docs/tool-reference.md §Meta fields.
 */
export function applyErrorMetaExtensions(meta: ToolMeta, error: unknown): void {
  if (!isAppError(error)) return;
  if (error.code !== ERROR_CODES.STAGE_BUDGET_PRE_PARSE) return;
  const details = error.details as Record<string, unknown> | undefined;
  if (!details) return;
  if (details.stageBudgetExhausted === true) {
    meta.stageBudgetExhausted = true;
  }
  if (typeof details.budgetMs === "number") {
    meta.budgetMs = details.budgetMs;
  }
  if (typeof details.elapsedMs === "number") {
    meta.elapsedMs = details.elapsedMs;
  }
}

server.tool("list-versions",
  "List available Minecraft versions from Mojang manifest and locally cached version jars.",
  listVersionsShape,
  { readOnlyHint: true },
  async (args) => runTool("list-versions", args, listVersionsSchema, async (input) =>
    sourceService.listVersions({
      includeSnapshots: input.includeSnapshots,
      limit: input.limit
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-versions", listVersionsSchema);

server.tool("inspect-minecraft",
  "High-level v3 entry tool for version discovery, artifact resolution, class inspection, source search, file reads, and file listings.",
  inspectMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("inspect-minecraft", args, inspectMinecraftSchema, async (input) =>
    inspectMinecraftService.execute(input as z.infer<typeof inspectMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("inspect-minecraft", inspectMinecraftSchema);

server.tool("analyze-symbol",
  "High-level v3 entry tool for symbol existence, mapping, lifecycle, workspace analysis, and API overview.",
  analyzeSymbolShape,
  { readOnlyHint: true },
  async (args) => runTool("analyze-symbol", args, analyzeSymbolSchema, async (input) =>
    analyzeSymbolService.execute(input as z.infer<typeof analyzeSymbolSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-symbol", analyzeSymbolSchema);

server.tool("compare-minecraft",
  "High-level v3 entry tool for version comparisons, class diffs, registry diffs, and migration overviews.",
  compareMinecraftShape,
  { readOnlyHint: true },
  async (args) => runTool("compare-minecraft", args, compareMinecraftSchema, async (input) =>
    compareMinecraftService.execute(input as z.infer<typeof compareMinecraftSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-minecraft", compareMinecraftSchema);

server.tool("analyze-mod",
  "High-level v3 entry tool for mod metadata inspection, decompile/search flows, class source, and safe remap previews/applies.",
  analyzeModShape,
  { readOnlyHint: false },
  async (args) => runTool("analyze-mod", args, analyzeModSchema, async (input) =>
    analyzeModService.execute(input as z.infer<typeof analyzeModSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("analyze-mod", analyzeModSchema);

server.tool("validate-project",
  "High-level v3 entry tool for project summary, direct mixin validation, and access widener/access transformer validation.",
  validateProjectShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-project", args, validateProjectSchema, async (input) =>
    validateProjectService.execute(input as z.infer<typeof validateProjectSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-project", validateProjectSchema);

server.tool("manage-cache",
  "High-level v3 entry tool for cache summaries, listing, verification, previewed mutation, and explicit apply operations.",
  manageCacheShape,
  { readOnlyHint: false },
  async (args) => runTool("manage-cache", args, manageCacheSchema, async (input) =>
    manageCacheService.execute(input as z.infer<typeof manageCacheSchema>) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("manage-cache", manageCacheSchema);

if (!VERIFY_MIXIN_TARGET_OFF) {
  server.tool("verify-mixin-target",
    "Single-call probe: does this target owner / member exist and which @Shadow / @Accessor / @Invoker should the mixin use? Reuses target.kind workspace/version/coordinate/dependency/jar.",
    verifyMixinTargetShape,
    { readOnlyHint: true },
    async (args) => runTool("verify-mixin-target", args, verifyMixinTargetSchema, async (input) =>
      verifyMixinTargetService.execute({
        owner: input.owner,
        member: input.member,
        mixinMemberName: input.mixinMemberName,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        projectPath: input.projectPath,
        target: input.target as ResolveArtifactTargetInput,
        scope: input.scope,
        preferProjectVersion: input.preferProjectVersion,
        strictVersion: input.strictVersion
      }) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("verify-mixin-target", verifyMixinTargetSchema);
}

if (!BATCH_TOOLS_OFF) {
  server.tool("batch-class-source",
    "Batch lookup: read source for many classes in one call, sharing a single resolved artifact. Returns per-entry { status, result?, error? } plus aggregate summary. Per-entry retry suggestions point at get-class-source.",
    batchClassSourceShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-class-source", args, batchClassSourceSchema, async (input) =>
      batchClassSourceService.execute(input as z.infer<typeof batchClassSourceSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-source", batchClassSourceSchema);

  server.tool("batch-class-members",
    "Batch lookup: list members for many classes in one call, sharing a single resolved artifact. Returns per-entry { status, result?, error? } plus aggregate summary. Per-entry retry suggestions point at get-class-members.",
    batchClassMembersShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-class-members", args, batchClassMembersSchema, async (input) =>
      batchClassMembersService.execute(input as z.infer<typeof batchClassMembersSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-class-members", batchClassMembersSchema);

  server.tool("batch-symbol-exists",
    "Batch existence/mapping query: probe many symbols in one call against a shared Minecraft-version artifact. Accepts target.kind=workspace or version only (other kinds carry library versions, not Minecraft versions). Per-entry retry suggestions point at check-symbol-exists.",
    batchSymbolExistsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-symbol-exists", args, batchSymbolExistsSchema, async (input) =>
      batchSymbolExistsService.execute(input as z.infer<typeof batchSymbolExistsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-symbol-exists", batchSymbolExistsSchema);

  server.tool("batch-mappings",
    "Batch mapping translation: resolve many symbols across mapping namespaces with one shared Minecraft version. Per-entry retry suggestions point at find-mapping.",
    batchMappingsShape,
    { readOnlyHint: true },
    async (args) => runTool("batch-mappings", args, batchMappingsSchema, async (input) =>
      batchMappingsService.execute(input as z.infer<typeof batchMappingsSchema>) as unknown as Promise<Record<string, unknown>>
    )
  );
  registerToolSchema("batch-mappings", batchMappingsSchema);
}

server.tool("resolve-artifact",
  "Resolve source artifact from a target object ({ kind, value }) and return artifact metadata. For target.kind=jar, only <basename>-sources.jar is auto-adopted; other adjacent *-sources.jar files are informational.",
  resolveArtifactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-artifact", args, resolveArtifactSchema, async (input) =>
    sourceService.resolveArtifact({
      target: input.target as ResolveArtifactTargetInput,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      compact: input.compact
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-artifact", resolveArtifactSchema);

const findClassShape = {
  className: nonEmptyString.describe("Simple name (e.g. Blocks) or fully-qualified name (e.g. net.minecraft.world.level.block.Blocks)"),
  artifactId: nonEmptyString,
  limit: optionalPositiveInt.describe("default 20, max 200")
};
const findClassSchema = z.object(findClassShape);

server.tool("find-class",
  "Resolve a simple or qualified class name to fully-qualified class names within an artifact. Use this before get-class-source when you only have a simple name.",
  findClassShape,
  { readOnlyHint: true },
  async (args) => runTool("find-class", args, findClassSchema, async (input) =>
    sourceService.findClass({
      className: input.className,
      artifactId: input.artifactId,
      limit: input.limit
    }) as unknown as Record<string, unknown>
  )
);
registerToolSchema("find-class", findClassSchema);

server.tool("get-class-source",
  "Get Java source for a class by target ({ type: 'artifact', artifactId } or { type: 'resolve', kind, value }). Default mode=metadata returns symbol outline only; use mode=snippet for bounded excerpts or mode=full for entire source.",
  getClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-source", args, getClassSourceSchema, async (input) => {
    const normalizedTarget = normalizeSourceLookupTarget(input.target as SourceLookupTargetInput);
    return (
    sourceService.getClassSource({
      className: input.className,
      mode: input.mode,
      artifactId: normalizedTarget.artifactId,
      target: normalizedTarget.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion,
      startLine: input.startLine,
      endLine: input.endLine,
      maxLines: input.maxLines,
      maxChars: input.maxChars,
      outputFile: input.outputFile
    }) as Promise<Record<string, unknown>>
    );
  })
);
registerToolSchema("get-class-source", getClassSourceSchema);

server.tool("get-class-members",
  "Get fields/methods/constructors for one class from binary bytecode by target ({ type: 'artifact', artifactId } or { type: 'resolve', kind, value }).",
  getClassMembersShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-members", args, getClassMembersSchema, async (input) => {
    const normalizedTarget = normalizeSourceLookupTarget(input.target as SourceLookupTargetInput);
    return (
    sourceService.getClassMembers({
      className: input.className,
      artifactId: normalizedTarget.artifactId,
      target: normalizedTarget.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      access: input.access,
      includeSynthetic: input.includeSynthetic,
      includeInherited: input.includeInherited,
      memberPattern: input.memberPattern,
      maxMembers: input.maxMembers,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    }) as Promise<Record<string, unknown>>
    );
  })
);
registerToolSchema("get-class-members", getClassMembersSchema);

server.tool("search-class-source",
  "Search indexed class source files for one artifact with symbol/text/path intent and compact hit output.",
  searchClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("search-class-source", args, searchClassSourceSchema, async (input) => {
      const scope =
        input.packagePrefix || input.fileGlob || input.symbolKind
          ? {
              packagePrefix: input.packagePrefix,
              fileGlob: input.fileGlob,
              symbolKind: input.symbolKind
            }
          : undefined;

      return sourceService.searchClassSource({
        artifactId: input.artifactId,
        query: input.query,
        intent: input.intent as SearchIntent | undefined,
        match: input.match as SearchMatch | undefined,
        scope: scope as
          | {
              packagePrefix?: string;
              fileGlob?: string;
              symbolKind?: SearchSymbolKind;
            }
          | undefined,
        queryMode: input.queryMode,
        limit: input.limit,
        cursor: input.cursor,
        queryNamespace: input.queryNamespace,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>;
    })
);
registerToolSchema("search-class-source", searchClassSourceSchema);

server.tool("get-artifact-file",
  "Get full source file content by artifactId and file path.",
  getArtifactFileShape,
  { readOnlyHint: true },
  async (args) => runTool("get-artifact-file", args, getArtifactFileSchema, async (input) =>
    sourceService.getArtifactFile({
      artifactId: input.artifactId,
      filePath: input.filePath,
      maxBytes: input.maxBytes
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-artifact-file", getArtifactFileSchema);

server.tool("list-artifact-files",
  "List source file paths in an artifact with optional prefix filter and cursor-based pagination.",
  listArtifactFilesShape,
  { readOnlyHint: true },
  async (args) => runTool("list-artifact-files", args, listArtifactFilesSchema, async (input) =>
    sourceService.listArtifactFiles({
      artifactId: input.artifactId,
      prefix: input.prefix,
      limit: input.limit,
      cursor: input.cursor
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("list-artifact-files", listArtifactFilesSchema);

server.tool("trace-symbol-lifecycle",
  "Trace which Minecraft versions contain a specific class method and report first/last seen versions.",
  traceSymbolLifecycleShape,
  { readOnlyHint: true },
  async (args) => runTool("trace-symbol-lifecycle", args, traceSymbolLifecycleSchema, async (input) =>
    sourceService.traceSymbolLifecycle({
      symbol: input.symbol,
      descriptor: input.descriptor,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      includeSnapshots: input.includeSnapshots,
      maxVersions: input.maxVersions,
      includeTimeline: input.includeTimeline
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("trace-symbol-lifecycle", traceSymbolLifecycleSchema);

server.tool("diff-class-signatures",
  "Compare one class signature between two Minecraft versions and report added/removed/modified constructors, methods, and fields.",
  diffClassSignaturesShape,
  { readOnlyHint: true },
  async (args) => runTool("diff-class-signatures", args, diffClassSignaturesSchema, async (input) =>
    sourceService.diffClassSignatures({
      className: input.className,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      includeFullDiff: input.includeFullDiff
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("diff-class-signatures", diffClassSignaturesSchema);

server.tool("find-mapping",
  "Find symbol mapping candidates between namespaces using structured symbol inputs for a specific Minecraft version.",
  findMappingShape,
  { readOnlyHint: true },
  async (args) => runTool("find-mapping", args, findMappingSchema, async (input) =>
    sourceService.findMapping({
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      signatureMode: input.signatureMode,
      disambiguation: input.disambiguation,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("find-mapping", findMappingSchema);

server.tool("resolve-method-mapping-exact",
  "Resolve one method mapping exactly by owner+name+descriptor between namespaces and report resolved/not_found/ambiguous.",
  resolveMethodMappingExactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-method-mapping-exact", args, resolveMethodMappingExactSchema, async (input) =>
    sourceService.resolveMethodMappingExact({
      version: input.version,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-method-mapping-exact", resolveMethodMappingExactSchema);

server.tool("get-class-api-matrix",
  "List class/member API rows across obfuscated/mojang/intermediary/yarn mappings for one class and Minecraft version.",
  getClassApiMatrixShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-api-matrix", args, getClassApiMatrixSchema, async (input) =>
    sourceService.getClassApiMatrix({
      version: input.version,
      className: input.className,
      classNameMapping: input.classNameMapping,
      includeKinds: parseClassApiKinds(input.includeKinds),
      sourcePriority: input.sourcePriority,
      maxRows: input.maxRows
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-class-api-matrix", getClassApiMatrixSchema);

server.tool("resolve-workspace-symbol",
  "Resolve class/field/method names as seen at compile time for a workspace by reading Gradle Loom mapping settings.",
  resolveWorkspaceSymbolShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-workspace-symbol", args, resolveWorkspaceSymbolSchema, async (input) =>
    sourceService.resolveWorkspaceSymbol({
      projectPath: input.projectPath,
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      sourcePriority: input.sourcePriority,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("resolve-workspace-symbol", resolveWorkspaceSymbolSchema);

server.tool("check-symbol-exists",
  "Check whether a class/field/method symbol exists in a specific mapping namespace for one Minecraft version.",
  checkSymbolExistsShape,
  { readOnlyHint: true },
  async (args) => runTool("check-symbol-exists", args, checkSymbolExistsSchema, async (input) =>
    sourceService.checkSymbolExists({
      version: input.version,
      kind: input.kind,
      owner: input.owner,
      name: input.name,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      sourcePriority: input.sourcePriority,
      nameMode: input.nameMode,
      signatureMode: input.signatureMode,
      maxCandidates: input.maxCandidates
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("check-symbol-exists", checkSymbolExistsSchema);

server.tool("nbt-to-json",
  "Decode Java Edition NBT binary payload (base64) into typed JSON.",
  nbtToJsonShape,
  { readOnlyHint: true },
  async (args) => runTool("nbt-to-json", args, nbtToJsonSchema, async (input) =>
    Promise.resolve(
      nbtBase64ToTypedJson({
        nbtBase64: input.nbtBase64,
        compression: input.compression as DecodeCompression | undefined
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("nbt-to-json", nbtToJsonSchema);

server.tool("nbt-apply-json-patch",
  "Apply RFC6902 add/remove/replace/test operations to typed NBT JSON.",
  nbtApplyJsonPatchShape,
  { readOnlyHint: true },
  async (args) => runTool("nbt-apply-json-patch", args, nbtApplyJsonPatchSchema, async (input) =>
    Promise.resolve(
      applyNbtJsonPatch({
        typedJson: input.typedJson,
        patch: input.patch
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("nbt-apply-json-patch", nbtApplyJsonPatchSchema);

server.tool("json-to-nbt",
  "Encode typed NBT JSON to Java Edition NBT binary payload (base64).",
  jsonToNbtShape,
  { readOnlyHint: true },
  async (args) => runTool("json-to-nbt", args, jsonToNbtSchema, async (input) =>
    Promise.resolve(
      typedJsonToNbtBase64({
        typedJson: input.typedJson,
        compression: input.compression as EncodeCompression | undefined
      }, nbtLimits) as unknown as Record<string, unknown>
    )
  )
);
registerToolSchema("json-to-nbt", jsonToNbtSchema);

server.tool("index-artifact",
  "Rebuild indexed files/symbols metadata for an existing artifactId. Does not resolve new artifacts.",
  indexArtifactShape,
  async (args) => runTool("index-artifact", args, indexArtifactSchema, async (input) =>
    sourceService.indexArtifact({
      artifactId: input.artifactId,
      force: input.force
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("index-artifact", indexArtifactSchema);

server.tool("get-runtime-metrics",
  "Get runtime service counters and latency snapshots for cache/search/index diagnostics.",
  { readOnlyHint: true },
  async (args) => runTool("get-runtime-metrics", args, emptySchema, async () =>
    Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
  )
);
registerToolSchema("get-runtime-metrics", emptySchema);

server.tool("validate-mixin",
  "Validate Mixin source against Minecraft bytecode signatures for a given version.",
  validateMixinShape,
  { readOnlyHint: true },
  async (args, extra) => runTool("validate-mixin", args, validateMixinSchema, async (input) =>
    sourceService.validateMixin({
      input: input.input,
      sourceRoots: input.sourceRoots,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope as ArtifactScope | undefined,
      projectPath: input.projectPath,
      preferProjectVersion: input.preferProjectVersion,
      minSeverity: input.minSeverity,
      hideUncertain: input.hideUncertain,
      explain: input.explain,
      warningMode: input.warningMode,
      preferProjectMapping: input.preferProjectMapping,
      reportMode: input.reportMode,
      warningCategoryFilter: input.warningCategoryFilter,
      treatInfoAsWarning: input.treatInfoAsWarning,
      includeIssues: input.includeIssues
    }, {
      stageEmitter: makeStageEmitter(extra as unknown as StageEmitterExtra)
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-mixin", validateMixinSchema);

server.tool("validate-access-widener",
  "Validate Access Widener file entries against Minecraft bytecode signatures for a given version.",
  validateAccessWidenerShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-access-widener", args, validateAccessWidenerSchema, async (input) =>
    sourceService.validateAccessWidener({
      content: input.content,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-widener", validateAccessWidenerSchema);

server.tool("validate-access-transformer",
  "Validate Access Transformer file entries against Minecraft bytecode signatures for a given version.",
  validateAccessTransformerShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-access-transformer", args, validateAccessTransformerSchema, async (input) =>
    sourceService.validateAccessTransformer({
      content: input.content,
      version: input.version,
      atNamespace: input.atNamespace,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      scope: input.scope as ArtifactScope | undefined,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("validate-access-transformer", validateAccessTransformerSchema);

server.tool("analyze-mod-jar",
  "Analyze a Minecraft mod JAR to extract loader type, metadata, entrypoints, mixins, and dependencies.",
  analyzeModJarShape,
  { readOnlyHint: true },
  async (args) => runTool("analyze-mod-jar", args, analyzeModJarSchema, async (input) => {
    const result = await analyzeModJar(input.jarPath, {
      includeClasses: input.includeClasses ?? false
    });
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("analyze-mod-jar", analyzeModJarSchema);

server.tool("get-registry-data",
  "Get Minecraft registry data (blocks, items, biomes, etc.) for a specific version by running the server data generator.",
  getRegistryDataShape,
  { readOnlyHint: true },
  async (args) => runTool("get-registry-data", args, getRegistryDataSchema, async (input) =>
    sourceService.getRegistryData({
      version: input.version,
      registry: input.registry,
      includeData: input.includeData,
      maxEntriesPerRegistry: input.maxEntriesPerRegistry
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-registry-data", getRegistryDataSchema);

server.tool("compare-versions",
  "Compare two Minecraft versions to find added/removed classes and registry entry changes. Useful for understanding what changed between versions during mod migration.",
  compareVersionsShape,
  { readOnlyHint: true },
  async (args) => runTool("compare-versions", args, compareVersionsSchema, async (input) =>
    sourceService.compareVersions({
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      category: input.category,
      packageFilter: input.packageFilter,
      maxClassResults: input.maxClassResults
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("compare-versions", compareVersionsSchema);

server.tool("decompile-mod-jar",
  "Decompile a Minecraft mod JAR using Vineflower and list available classes, or view a specific class source. Builds on analyze-mod-jar by exposing the actual source code.",
  decompileModJarShape,
  { readOnlyHint: true },
  async (args) => runTool("decompile-mod-jar", args, decompileModJarSchema, async (input) =>
    sourceService.decompileModJar({
      jarPath: input.jarPath,
      className: input.className,
      includeFiles: input.includeFiles,
      maxFiles: input.maxFiles
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("decompile-mod-jar", decompileModJarSchema);

server.tool("get-mod-class-source",
  "Get decompiled source code for a specific class in a mod JAR. The mod JAR will be decompiled if not already cached.",
  getModClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-mod-class-source", args, getModClassSourceSchema, async (input) =>
    sourceService.getModClassSource({
      jarPath: input.jarPath,
      className: input.className,
      maxLines: input.maxLines,
      maxChars: input.maxChars,
      outputFile: input.outputFile
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("get-mod-class-source", getModClassSourceSchema);

server.tool("search-mod-source",
  "Search through decompiled mod JAR source code by class name, method, field, or content pattern. The mod JAR will be decompiled automatically if not already cached.",
  searchModSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("search-mod-source", args, searchModSourceSchema, async (input) =>
    sourceService.searchModSource({
      jarPath: input.jarPath,
      query: input.query,
      searchType: input.searchType,
      limit: input.limit
    }) as Promise<Record<string, unknown>>
  )
);
registerToolSchema("search-mod-source", searchModSourceSchema);

server.tool("remap-mod-jar",
  "Remap a Fabric mod JAR from intermediary to yarn/mojang names. Requires Java to be installed.",
  remapModJarShape,
  { readOnlyHint: false },
  async (args) => runTool("remap-mod-jar", args, remapModJarSchema, async (input) => {
    const result = await remapModJar(
      {
        inputJar: input.inputJar,
        outputJar: input.outputJar,
        mcVersion: input.mcVersion,
        targetMapping: input.targetMapping
      },
      config
    );
    return result as unknown as Record<string, unknown>;
  })
);
registerToolSchema("remap-mod-jar", remapModJarSchema);

export async function startServer(): Promise<void> {
  if (serverStarted) {
    return;
  }
  attachProcessErrorHandlers();
  log("info", "server.start", {
    version: SERVER_VERSION,
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath,
    sourceRepos: config.sourceRepos.length
  });
  const transport = new CompatStdioServerTransport();
  await server.connect(transport);
  // In stdio mode, explicitly resume stdin so JSON-RPC lines are consumed.
  process.stdin.resume();
  serverStarted = true;
}

export { server, sourceService, config, SERVER_VERSION };
