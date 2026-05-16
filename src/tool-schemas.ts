import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";

import { z } from "zod";

import type { SourceTargetInput } from "./types.js";

export type SearchIntent = "symbol" | "text" | "path";
export type SearchMatch = "exact" | "prefix" | "contains" | "regex";
export type SearchSymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
export type MemberAccess = "public" | "all";
export type WorkspaceSymbolKind = "class" | "field" | "method";

export const SOURCE_MAPPINGS = ["obfuscated", "mojang", "intermediary", "yarn"] as const;
export const SOURCE_PRIORITIES = ["loom-first", "maven-first"] as const;
export const TARGET_KINDS = ["version", "jar", "coordinate"] as const;
export const SEARCH_INTENTS = ["symbol", "text", "path"] as const;
export const SEARCH_MATCHES = ["exact", "prefix", "contains", "regex"] as const;
export const SEARCH_SYMBOL_KINDS = ["class", "interface", "enum", "record", "method", "field"] as const;
export const MEMBER_ACCESS = ["public", "all"] as const;
export const WORKSPACE_SYMBOL_KINDS = ["class", "field", "method"] as const;
export const CLASS_NAME_MODES = ["fqcn", "auto"] as const;
export const SOURCE_MODES = ["metadata", "snippet", "full"] as const;
export const ARTIFACT_SCOPES = ["vanilla", "merged", "loader"] as const;
export const DECODE_COMPRESSIONS = ["none", "gzip", "auto"] as const;
export const ENCODE_COMPRESSIONS = ["none", "gzip"] as const;

export const nonEmptyString = z.string().trim().min(1);
export const optionalNonEmptyString = z.string().trim().min(1).optional();
export const optionalPositiveInt = z.number().int().positive().optional();
export const gradleUserHomeSchema = optionalNonEmptyString.describe(
  "Gradle User Home to use for Loom/Gradle cache lookups instead of the MCP process GRADLE_USER_HOME."
);

// Optional descriptor: "" and whitespace-only strings are normalized to undefined so that
// tools with signatureMode="name-only" can accept "caller omitted descriptor" inputs whether
// the caller passed an empty string or omitted the field entirely. Malformed descriptors are
// still rejected downstream by normalizeMethodDescriptor in mapping-service.
export const optionalDescriptorString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

export const sourceMappingSchema = z.enum(SOURCE_MAPPINGS);
export const mappingSourcePrioritySchema = z.enum(SOURCE_PRIORITIES);
export const targetKindSchema = z.enum(TARGET_KINDS);
export const searchIntentSchema = z.enum(SEARCH_INTENTS);
export const searchMatchSchema = z.enum(SEARCH_MATCHES);
export const searchSymbolKindSchema = z.enum(SEARCH_SYMBOL_KINDS);
export const memberAccessSchema = z.enum(MEMBER_ACCESS);
export const workspaceSymbolKindSchema = z.enum(WORKSPACE_SYMBOL_KINDS);
export const classNameModeSchema = z.enum(CLASS_NAME_MODES);
export const sourceModeSchema = z.enum(SOURCE_MODES);
export const artifactScopeSchema = z.enum(ARTIFACT_SCOPES);
export const decodeCompressionSchema = z.enum(DECODE_COMPRESSIONS);
export const encodeCompressionSchema = z.enum(ENCODE_COMPRESSIONS);

export type ResolveArtifactTargetInput =
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

export type SourceLookupTargetInput =
  | {
      type: "artifact";
      artifactId: string;
    }
  | ({
      type: "resolve";
    } & ResolveArtifactTargetInput);

export const workspaceTargetSchema = z.object({
  kind: z.literal("workspace"),
  scope: artifactScopeSchema.optional(),
  strict: z.boolean().optional()
});

export const dependencyTargetSchema = z.object({
  kind: z.literal("dependency"),
  group: nonEmptyString,
  name: nonEmptyString,
  version: z.string().trim().min(1).optional(),
  versionFromProject: z.boolean().optional()
});

export const resolveArtifactTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  z.object({ kind: z.literal("jar"), value: nonEmptyString }),
  z.object({ kind: z.literal("coordinate"), value: nonEmptyString }),
  workspaceTargetSchema,
  dependencyTargetSchema
]);

export const sourceLookupTargetSchema = z.union([
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

export const RESOLVE_ARTIFACT_TARGET_DESCRIPTION =
  'Object with kind. Examples: {"kind":"version","value":"1.21.10"}, {"kind":"workspace"} (uses projectPath), or {"kind":"dependency","group":"dev.architectury","name":"architectury"}. Must be an object, not a string.';
export const SOURCE_LOOKUP_TARGET_DESCRIPTION =
  'Object: {"type":"resolve","kind":"version","value":"1.21.10"} or {"type":"resolve","kind":"workspace"} or {"type":"resolve","kind":"dependency","group":"...","name":"..."} or {"type":"artifact","artifactId":"..."}. Must be an object, not a string.';
export const SOURCE_SCOPE_DESCRIPTION =
  "vanilla = Mojang client jar only; merged = source-oriented merged runtime discovery; loader = loader/runtime artifact discovery when the workspace exposes transformed runtime jars.";

export const listVersionsShape = {
  includeSnapshots: z.boolean().default(false),
  limit: optionalPositiveInt.default(20).describe("max 200")
};
export const listVersionsSchema = z.object(listVersionsShape);

export const resolveArtifactShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false."),
  compact: z.boolean().default(true).describe(
    "Return minimal fields (artifactId, origin, isDecompiled, version, requestedMapping, mappingApplied, qualityFlags). "
    + "Omit provenance, artifactContents, sampleEntries, adjacentSourceCandidates, binaryJarPath, coordinate, repoUrl, resolvedSourceJarPath. "
    + "Enabled by default; set to false for full output."
  )
};
export const resolveArtifactSchema = z.object(resolveArtifactShape);

export const getClassSourceShape = {
  className: nonEmptyString,
  mode: sourceModeSchema.default("metadata").describe("metadata = symbol outline only; snippet = source with default maxLines=200; full = entire source"),
  target: sourceLookupTargetSchema.describe(SOURCE_LOOKUP_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  gradleUserHome: gradleUserHomeSchema,
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
export const getClassSourceSchema = z
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

export const getClassMembersShape = {
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
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override version"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false."),
  compact: z.boolean().default(false).describe(
    "When true, strip debug metadata (provenance, artifactContents, qualityFlags, context) and empty fields from the response. Default false."
  )
};
export const getClassMembersSchema = z.object(getClassMembersShape);

export const verifyMixinTargetMemberSchema = z.discriminatedUnion("kind", [
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

export const verifyMixinTargetShape = {
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
  gradleUserHome: gradleUserHomeSchema,
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("When true, reject version-approximated results instead of returning them. Default false.")
};
export const verifyMixinTargetSchema = z.object(verifyMixinTargetShape);

export const batchSymbolKindSchema = z.enum(["class", "field", "method"]);

export const batchClassSourceEntrySchema = z.object({
  className: nonEmptyString,
  mode: sourceModeSchema.optional(),
  startLine: optionalPositiveInt,
  endLine: optionalPositiveInt,
  maxLines: optionalPositiveInt,
  maxChars: optionalPositiveInt,
  outputFile: optionalNonEmptyString
});

export const batchClassSourceShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
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
export const batchClassSourceSchema = z.object(batchClassSourceShape).superRefine((value, ctx) => {
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

export const batchClassMembersEntrySchema = z.object({
  className: nonEmptyString,
  access: memberAccessSchema.optional(),
  includeSynthetic: z.boolean().optional(),
  includeInherited: z.boolean().optional(),
  memberPattern: optionalNonEmptyString,
  maxMembers: optionalPositiveInt
});

export const batchClassMembersShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchClassMembersEntrySchema).min(1).max(50)
};
export const batchClassMembersSchema = z.object(batchClassMembersShape);

export const batchSymbolExistsTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  workspaceTargetSchema
]).describe(
  'Object with kind. Only kind="version" or kind="workspace" is accepted; dependency/jar/coordinate targets carry library versions, not Minecraft versions, and would corrupt the mapping query.'
);

export const batchSymbolExistsEntrySchema = z.object({
  kind: batchSymbolKindSchema,
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString,
  nameMode: classNameModeSchema.optional(),
  signatureMode: z.enum(["exact", "name-only"]).optional(),
  maxCandidates: optionalPositiveInt
});

export const batchSymbolExistsShape = {
  target: batchSymbolExistsTargetSchema,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchSymbolExistsEntrySchema).min(1).max(50)
};
export const batchSymbolExistsSchema = z.object(batchSymbolExistsShape);

export const batchMappingsEntrySchema = z
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

export const batchMappingsShape = {
  version: nonEmptyString.describe(
    "Minecraft version shared by every entry. Per-entry version is rejected; this batch shape is intentionally single-version."
  ),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  compact: z.boolean().optional(),
  entries: z.array(batchMappingsEntrySchema).min(1).max(50)
};
export const batchMappingsSchema = z.object(batchMappingsShape);

export const searchClassSourceShape = {
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
  gradleUserHome: gradleUserHomeSchema,
  compact: z.boolean().default(false).describe(
    "When true, strip the artifactContents summary and empty fields from the response. Default false."
  )
};
export const searchClassSourceSchema = z.object(searchClassSourceShape).superRefine((value, ctx) => {
  if (value.symbolKind && value.intent && value.intent !== "symbol") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["symbolKind"],
      message: 'symbolKind filter is only supported when intent="symbol".'
    });
  }
});

export const getArtifactFileShape = {
  artifactId: nonEmptyString,
  filePath: nonEmptyString,
  maxBytes: optionalPositiveInt
};
export const getArtifactFileSchema = z.object(getArtifactFileShape);

export const listArtifactFilesShape = {
  artifactId: nonEmptyString,
  prefix: optionalNonEmptyString,
  limit: optionalPositiveInt,
  cursor: optionalNonEmptyString,
  compact: z.boolean().default(false).describe(
    "When true, strip the artifactContents summary and empty fields from the response. Default false."
  )
};
export const listArtifactFilesSchema = z.object(listArtifactFilesShape);

export const traceSymbolLifecycleShape = {
  symbol: nonEmptyString.describe("fully.qualified.Class.method"),
  descriptor: optionalDescriptorString.describe('optional JVM descriptor, e.g. "(I)V". Empty strings are treated as omitted.'),
  fromVersion: optionalNonEmptyString,
  toVersion: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn (default obfuscated)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
  includeSnapshots: z.boolean().default(false),
  maxVersions: optionalPositiveInt.default(120).describe("max 400"),
  includeTimeline: z.boolean().default(false)
};
export const traceSymbolLifecycleSchema = z.object(traceSymbolLifecycleShape);

export const diffClassSignaturesShape = {
  className: nonEmptyString,
  fromVersion: nonEmptyString,
  toVersion: nonEmptyString,
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn (default obfuscated)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
  includeFullDiff: z.boolean().default(true).describe("When false, omit from/to snapshots from modified entries and keep only key+changed")
};
export const diffClassSignaturesSchema = z.object(diffClassSignaturesShape);

export const findMappingShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor. Optional when signatureMode='name-only' (default). Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
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
export const findMappingSchema = z.object(findMappingShape).superRefine((value, ctx) => {
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

export const resolveMethodMappingExactShape = {
  version: nonEmptyString,
  name: nonEmptyString,
  owner: nonEmptyString,
  descriptor: nonEmptyString.describe("required JVM descriptor"),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
export const resolveMethodMappingExactSchema = z
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

export const classApiKindsSchema = z.string().superRefine((value, ctx) => {
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

export const getClassApiMatrixShape = {
  version: nonEmptyString,
  className: nonEmptyString,
  classNameMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  includeKinds: classApiKindsSchema.optional().describe("comma-separated: class,field,method"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
  maxRows: optionalPositiveInt.describe("Limit returned rows (max 5000)")
};
export const getClassApiMatrixSchema = z.object(getClassApiMatrixShape);

export const resolveWorkspaceSymbolShape = {
  projectPath: nonEmptyString,
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor. Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
  maxCandidates: optionalPositiveInt.default(5).describe("Limit returned candidates for field/method lookups (default 5, max 200). Raise when you need the full candidate list."),
  compact: z.boolean().default(true).describe(
    "Omit top-level empty arrays, null/undefined values, and empty objects from the response. "
    + "Also omit redundant candidates array for single full-confidence exact-match resolutions. "
    + "Enabled by default; set to false for full output."
  )
};
export const resolveWorkspaceSymbolSchema = z
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

export const checkSymbolExistsShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  owner: optionalNonEmptyString,
  name: nonEmptyString,
  descriptor: optionalDescriptorString.describe("required for kind=method unless signatureMode=name-only. Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema.describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  gradleUserHome: gradleUserHomeSchema,
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
export const checkSymbolExistsSchema = z.object(checkSymbolExistsShape).superRefine((value, ctx) => {
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

export const nbtToJsonShape = {
  nbtBase64: nonEmptyString,
  compression: decodeCompressionSchema.default("auto").describe("none | gzip | auto")
};
export const nbtToJsonSchema = z.object(nbtToJsonShape);

const nbtPatchOperationSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "test"]),
    path: nonEmptyString,
    value: z.unknown().optional()
  })
  .passthrough();

export const nbtApplyJsonPatchShape = {
  typedJson: z.unknown(),
  patch: z.array(nbtPatchOperationSchema).describe("RFC6902 operation array (add/remove/replace/test)")
};
export const nbtApplyJsonPatchSchema = z.object(nbtApplyJsonPatchShape);

export const jsonToNbtShape = {
  typedJson: z.unknown(),
  compression: encodeCompressionSchema.default("none").describe("none | gzip")
};
export const jsonToNbtSchema = z.object(jsonToNbtShape);

export const indexArtifactShape = {
  artifactId: nonEmptyString,
  force: z.boolean().default(false)
};
export const indexArtifactSchema = z.object(indexArtifactShape);

export const validateMixinShape = {
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
  gradleUserHome: gradleUserHomeSchema,
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
export const validateMixinSchema = z.object(validateMixinShape);

export const validateAccessWidenerShape = {
  content: nonEmptyString.describe("Access Widener file content"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional().describe("obfuscated | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted runtime validation"),
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().default(false)
    .describe("When true, detect MC version from gradle.properties and override version")
};
export const validateAccessWidenerSchema = z.object(validateAccessWidenerShape);

export const validateAccessTransformerShape = {
  content: nonEmptyString.describe("Access Transformer file content"),
  version: nonEmptyString.describe("Minecraft version"),
  atNamespace: z.enum(["srg", "mojang", "obfuscated"]).optional().describe("srg | mojang | obfuscated"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Forge/NeoForge runtime validation"),
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().default(false)
    .describe("When true, detect MC version from gradle.properties and override version")
};
export const validateAccessTransformerSchema = z.object(validateAccessTransformerShape);

export const analyzeModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  includeClasses: z.boolean().default(false).describe("Include full class listing")
};
export const analyzeModJarSchema = z.object(analyzeModJarShape);

export const getRegistryDataShape = {
  version: nonEmptyString.describe("Minecraft version (e.g. 1.21)"),
  registry: optionalNonEmptyString.describe('Optional registry name (e.g. "block", "item", "minecraft:biome"). Omit to list all registries.'),
  includeData: z.boolean().default(true).describe("When false, return registry names/counts without full entry bodies"),
  maxEntriesPerRegistry: optionalPositiveInt.describe("Limit returned entries per registry body")
};
export const getRegistryDataSchema = z.object(getRegistryDataShape);

export const COMPARE_VERSIONS_CATEGORIES = ["classes", "registry", "all"] as const;
export const compareVersionsCategorySchema = z.enum(COMPARE_VERSIONS_CATEGORIES);

export const compareVersionsShape = {
  fromVersion: nonEmptyString.describe("Older Minecraft version (e.g. 1.20.4)"),
  toVersion: nonEmptyString.describe("Newer Minecraft version (e.g. 1.21)"),
  category: compareVersionsCategorySchema.default("all").describe("classes | registry | all"),
  packageFilter: optionalNonEmptyString.describe("Filter classes to a package prefix (e.g. net.minecraft.world.item)"),
  maxClassResults: optionalPositiveInt.default(500).describe("Max class results per direction (max 5000)")
};
export const compareVersionsSchema = z.object(compareVersionsShape);

export const decompileModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: optionalNonEmptyString.describe("Optional fully-qualified class name to view source. Omit to list all classes."),
  includeFiles: z.boolean().default(true).describe("When false, omit the full class list and return counts only"),
  maxFiles: optionalPositiveInt.describe("Limit returned class names when files are included")
};
export const decompileModJarSchema = z.object(decompileModJarShape);

export const getModClassSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: nonEmptyString.describe("Fully-qualified class name (e.g. com.example.MyMixin)"),
  maxLines: optionalPositiveInt.describe("Max lines to return"),
  maxChars: optionalPositiveInt.describe("Hard character limit; truncates if exceeded"),
  outputFile: optionalNonEmptyString.describe("Write full source to file, return placeholder in content")
};
export const getModClassSourceSchema = z.object(getModClassSourceShape);

export const MOD_SEARCH_TYPES = ["class", "method", "field", "content", "all"] as const;
export const modSearchTypeSchema = z.enum(MOD_SEARCH_TYPES);

export const searchModSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  query: nonEmptyString.describe("Search pattern (regex or literal string)"),
  searchType: modSearchTypeSchema.default("all").describe("class | method | field | content | all"),
  limit: optionalPositiveInt.default(50).describe("Max results (max 200)")
};
export const searchModSourceSchema = z.object(searchModSourceShape);

export const REMAP_TARGETS = ["yarn", "mojang"] as const;
export const remapTargetSchema = z.enum(REMAP_TARGETS);

export const remapModJarShape = {
  inputJar: nonEmptyString.describe("Path to the mod JAR file"),
  outputJar: optionalNonEmptyString.describe("Output path for remapped JAR (auto-generated if omitted)"),
  mcVersion: optionalNonEmptyString.describe("Minecraft version (auto-detected from mod metadata if omitted)"),
  targetMapping: remapTargetSchema.describe("yarn | mojang")
};
export const remapModJarSchema = z.object(remapModJarShape);

export const emptySchema = z.object({}).passthrough();
