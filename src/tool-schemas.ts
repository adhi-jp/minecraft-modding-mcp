import { resolve as pathResolve } from "node:path";

import { z } from "zod";

import type { SourceTargetInput } from "./types.js";
import { DETAIL_LEVELS, CANONICAL_INCLUDE_GROUPS } from "./entry-tools/response-contract.js";

// Shared response-shape controls for the expert + batch tools (replacing the old
// per-tool `compact` boolean). detail: summary|standard|full + include[] mirrors the
// entry-tool contract. Defaults are per-tool (see DEFAULT_DETAIL_BY_TOOL in response-utils):
// resolution/mapping tools + batch default "summary"; source/file tools default "standard".
const DETAIL_DESCRIPTION =
  "summary = terse (drops diagnostics/empties, slims candidates); standard = keeps fields, drops heavy diagnostics; full = everything.";
const RESPONSE_INCLUDE_DESCRIPTION =
  'Field groups to include regardless of detail, e.g. ["provenance"].';
function detailParam(defaultLevel: (typeof DETAIL_LEVELS)[number]) {
  return z.enum(DETAIL_LEVELS).default(defaultLevel).describe(DETAIL_DESCRIPTION);
}
const responseIncludeParam = z
  .array(z.enum(CANONICAL_INCLUDE_GROUPS))
  .optional()
  .describe(RESPONSE_INCLUDE_DESCRIPTION);

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
  "Gradle user home for Loom cache lookups (overrides GRADLE_USER_HOME)."
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
      kind: "artifact";
      artifactId: string;
    }
  | ResolveArtifactTargetInput;

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

// Extended target schema for the source-lookup tools (get-class-source / get-class-members):
// the same kind-based shape as resolveArtifactTargetSchema, PLUS a `kind:"artifact"` variant
// that short-circuits resolution by reusing an already-resolved artifactId. The shared
// resolveArtifactTargetSchema is intentionally NOT widened — the artifact kind has no
// resolution meaning for resolve-artifact / verify-mixin-target / the batch tools.
export const sourceLookupTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  z.object({ kind: z.literal("jar"), value: nonEmptyString }),
  z.object({ kind: z.literal("coordinate"), value: nonEmptyString }),
  workspaceTargetSchema,
  dependencyTargetSchema,
  z.object({ kind: z.literal("artifact"), artifactId: nonEmptyString })
]);

export const RESOLVE_ARTIFACT_TARGET_DESCRIPTION =
  'Object, not string. e.g. {"kind":"version","value":"1.21.10"}, {"kind":"workspace"}, {"kind":"dependency","group":"g","name":"n"}.';
export const SOURCE_LOOKUP_TARGET_DESCRIPTION =
  'Same shape as resolve-artifact target, plus {"kind":"artifact","artifactId":"..."} to reuse a resolved artifact. Object, not string.';
export const SOURCE_SCOPE_DESCRIPTION =
  "vanilla = Mojang client jar only; merged = merged runtime discovery; loader = loader-transformed runtime jars.";

// Shared describe() text reused by every symbol-lookup tool so the contract reads
// identically on find-mapping and check-symbol-exists (and any future sibling).
export const MEMBER_PATTERN_DESCRIPTION =
  'Case-insensitive substring filter on member names. Use "|" for OR alternatives, e.g. "getStateForPlacement|canSurvive|setPlacedBy" (each token is matched as a substring, not a regex).';

export const memberProjectionSchema = z.enum(["names", "signatures", "full"]);
export const MEMBER_PROJECTION_DESCRIPTION =
  'Per-member field projection: "names" (member name only), "signatures" (name + javaSignature, no jvmDescriptor), or "full" (default; complete member shape). Use "names"/"signatures" to cut response tokens for existence/signature checks.';

export const SIGNATURE_MODE_DESCRIPTION =
  "exact: descriptor required for kind=method; name-only (default): match by owner+name only.";
export const NAME_MODE_DESCRIPTION =
  "auto (default): FQCN, or dotless name where allowed; fqcn: require FQCN.";

export const listVersionsShape = {
  includeSnapshots: z.boolean().default(false),
  limit: optionalPositiveInt.default(20).describe("max 200")
};
export const listVersionsSchema = z.object(listVersionsShape);

export const resolveArtifactShape = {
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Workspace root for Loom cache-assisted resolution"),
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("Detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("Reject version-approximated results (default false)"),
  detail: detailParam("summary"),
  include: responseIncludeParam
};
export const resolveArtifactSchema = z.object(resolveArtifactShape);

export const getClassSourceShape = {
  className: nonEmptyString,
  mode: sourceModeSchema.default("metadata").describe("metadata = symbol outline only; snippet = source with default maxLines=200; full = entire source"),
  target: sourceLookupTargetSchema.describe(SOURCE_LOOKUP_TARGET_DESCRIPTION),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().default(true),
  projectPath: optionalNonEmptyString.describe("Workspace root for Loom cache-assisted resolution"),
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("Detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("Reject version-approximated results (default false)"),
  startLine: optionalPositiveInt,
  endLine: optionalPositiveInt,
  maxLines: optionalPositiveInt,
  maxChars: optionalPositiveInt.describe("Hard character limit on sourceText; truncates if exceeded"),
  outputFile: optionalNonEmptyString.describe("Write source to this file path and return metadata-only response"),
  detail: detailParam("standard"),
  include: responseIncludeParam,
  includeProvenance: z.boolean().default(false).describe(
    'Alias for include:["provenance"] (diagnostic metadata). Default false.'
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
  mapping: sourceMappingSchema.optional().describe("default obfuscated"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().default(true),
  access: memberAccessSchema.default("public"),
  includeSynthetic: z.boolean().default(false),
  includeInherited: z.boolean().default(false),
  memberPattern: optionalNonEmptyString.describe(MEMBER_PATTERN_DESCRIPTION),
  projection: memberProjectionSchema.optional().describe(MEMBER_PROJECTION_DESCRIPTION),
  maxMembers: optionalPositiveInt.describe("default 150, max 5000. Page beyond the first 150 with cursor."),
  cursor: optionalNonEmptyString.describe("nextCursor from the previous response."),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("Detect MC version from gradle.properties and override version"),
  strictVersion: z.boolean().optional().describe("Reject version-approximated results (default false)"),
  detail: detailParam("standard"),
  include: responseIncludeParam,
  includeProvenance: z.boolean().default(false).describe(
    'Alias for include:["provenance"] (diagnostic metadata). Default false.'
  ),
  includeDescriptors: z.boolean().default(false).describe(
    'Alias for include:["descriptors"]: also emit jvmDescriptor on FIELD members (method/constructor descriptors are always present). Default false.'
  )
};
export const getClassMembersSchema = z.object(getClassMembersShape);

export const verifyMixinTargetMemberSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("method"),
    name: nonEmptyString,
    descriptor: optionalDescriptorString.describe(
      'Optional JVM method descriptor, e.g. "()V". Empty/whitespace strings are treated as omitted.'
    )
  }),
  z.object({
    kind: z.literal("field"),
    name: nonEmptyString,
    descriptor: optionalDescriptorString.describe(
      'Optional JVM field descriptor, e.g. "I". Empty/whitespace strings are treated as omitted.'
    )
  })
]);

export const verifyMixinTargetShape = {
  owner: nonEmptyString.describe("Fully-qualified target owner class name."),
  member: verifyMixinTargetMemberSchema.describe(
    'e.g. {"kind":"method","name":"tick","descriptor":"()V"} or {"kind":"field","name":"airSupply"}.'
  ),
  mixinMemberName: optionalNonEmptyString.describe(
    "Caller-authored mixin member name; drives @Accessor/@Invoker advice when the target is private."
  ),
  mapping: sourceMappingSchema.optional(),
  autoRemap: z.boolean().optional().describe(
    "Translate owner+member via find-mapping when mapping differs from the artifact namespace (requires a version-based target)."
  ),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  projectPath: optionalNonEmptyString.describe("Workspace root path for target.kind=workspace and Loom cache assistance."),
  gradleUserHome: gradleUserHomeSchema,
  target: resolveArtifactTargetSchema.describe(RESOLVE_ARTIFACT_TARGET_DESCRIPTION),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  preferProjectVersion: z.boolean().optional().describe("Detect MC version from gradle.properties and override target.value"),
  strictVersion: z.boolean().optional().describe("Reject version-approximated results (default false)")
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
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  scope: artifactScopeSchema.optional(),
  preferProjectVersion: z.boolean().optional(),
  strictVersion: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional().describe("1..8, default 4"),
  failFast: z.boolean().optional().describe("default false"),
  detail: detailParam("summary"),
  include: responseIncludeParam,
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
  // `out.java` / `./out.java` / `dir/../out.java` / `/tmp/dir/../out.java`
  // collide as expected, covering relative and absolute spellings alike.
  const seen = new Map<string, { index: number; raw: string }>();
  for (let i = 0; i < value.entries.length; i += 1) {
    const entry = value.entries[i];
    if (!entry || entry.outputFile === undefined) continue;
    const trimmed = entry.outputFile.trim();
    if (trimmed.length === 0) continue;
    const canonical = pathResolve(trimmed);
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
  memberPattern: optionalNonEmptyString.describe(MEMBER_PATTERN_DESCRIPTION),
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
  detail: detailParam("summary"),
  projection: memberProjectionSchema.optional().describe(MEMBER_PROJECTION_DESCRIPTION),
  include: responseIncludeParam,
  entries: z.array(batchClassMembersEntrySchema).min(1).max(50)
};
export const batchClassMembersSchema = z.object(batchClassMembersShape);

export const batchSymbolExistsTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), value: nonEmptyString }),
  workspaceTargetSchema
]).describe(
  'Only kind="version" or kind="workspace"; other kinds carry library versions, not MC versions.'
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
  detail: detailParam("summary"),
  include: responseIncludeParam,
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
  version: nonEmptyString.describe("Minecraft version shared by every entry (single-version batch)."),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  projectPath: optionalNonEmptyString,
  gradleUserHome: gradleUserHomeSchema,
  concurrency: z.number().int().min(1).max(8).optional(),
  failFast: z.boolean().optional(),
  detail: detailParam("summary"),
  include: responseIncludeParam,
  entries: z.array(batchMappingsEntrySchema).min(1).max(50)
};
export const batchMappingsSchema = z.object(batchMappingsShape);

export const searchClassSourceShape = {
  artifactId: nonEmptyString,
  query: nonEmptyString,
  intent: searchIntentSchema.optional(),
  match: searchMatchSchema.optional(),
  packagePrefix: optionalNonEmptyString,
  fileGlob: optionalNonEmptyString,
  symbolKind: searchSymbolKindSchema.optional(),
  queryMode: z.enum(["auto", "token", "literal"]).default("auto").describe("auto: indexed search incl. separator queries like foo.bar; token: indexed-only; literal: substring scan only"),
  limit: optionalPositiveInt.default(20),
  cursor: optionalNonEmptyString,
  queryNamespace: sourceMappingSchema.optional().describe(
    "Query namespace; symbol-intent FQCN queries are translated via find-mapping first. Ignored for text/path intents."
  ),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("Used only when queryNamespace triggers translation."),
  gradleUserHome: gradleUserHomeSchema,
  detail: detailParam("standard"),
  include: responseIncludeParam
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
  detail: detailParam("standard"),
  include: responseIncludeParam
};
export const listArtifactFilesSchema = z.object(listArtifactFilesShape);

export const traceSymbolLifecycleShape = {
  symbol: nonEmptyString.describe("fully.qualified.Class.method"),
  descriptor: optionalDescriptorString.describe('optional JVM descriptor, e.g. "(I)V". Empty strings are treated as omitted.'),
  fromVersion: optionalNonEmptyString,
  toVersion: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("default obfuscated"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
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
  mapping: sourceMappingSchema.optional().describe("default obfuscated"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  includeFullDiff: z.boolean().default(true).describe("When false, omit from/to snapshots from modified entries and keep only key+changed")
};
export const diffClassSignaturesSchema = z.object(diffClassSignaturesShape);

export const findMappingShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema,
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor; optional when signatureMode='name-only'. Empty = omitted."),
  sourceMapping: sourceMappingSchema,
  targetMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  nameMode: classNameModeSchema.default("auto").describe(NAME_MODE_DESCRIPTION),
  signatureMode: z.enum(["exact", "name-only"]).default("name-only").describe(SIGNATURE_MODE_DESCRIPTION),
  disambiguation: z
    .object({
      ownerHint: optionalNonEmptyString,
      descriptorHint: optionalNonEmptyString
    })
    .partial()
    .optional(),
  maxCandidates: optionalPositiveInt.default(5).describe("default 5, max 200"),
  detail: detailParam("summary"),
  include: responseIncludeParam
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

// Strict shortcut for find-mapping(kind=method, signatureMode=exact): identical inputs,
// but requires a COMPLETE descriptor projection and returns mapping_unavailable when the
// descriptor's class references cannot all be projected (find-mapping's exact mode is more
// lenient there). Prefer find-mapping unless you need that strict-completeness guarantee.
export const resolveMethodMappingExactShape = {
  version: nonEmptyString,
  name: nonEmptyString,
  owner: nonEmptyString,
  descriptor: nonEmptyString.describe("required JVM descriptor"),
  sourceMapping: sourceMappingSchema,
  targetMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  maxCandidates: optionalPositiveInt.default(5).describe("default 5, max 200"),
  detail: detailParam("summary"),
  include: responseIncludeParam
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
  classNameMapping: sourceMappingSchema,
  includeKinds: classApiKindsSchema.optional().describe("comma-separated: class,field,method"),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  maxRows: optionalPositiveInt.describe("Limit returned rows (max 5000)"),
  cursor: optionalNonEmptyString.describe("nextCursor from the previous response.")
};
export const getClassApiMatrixSchema = z.object(getClassApiMatrixShape);

export const resolveWorkspaceSymbolShape = {
  projectPath: nonEmptyString,
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema,
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor. Empty strings are treated as omitted."),
  sourceMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  maxCandidates: optionalPositiveInt.default(5).describe("default 5, max 200 (field/method lookups)"),
  detail: detailParam("summary"),
  include: responseIncludeParam
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
  kind: workspaceSymbolKindSchema,
  owner: optionalNonEmptyString,
  name: nonEmptyString,
  descriptor: optionalDescriptorString.describe("JVM descriptor; optional when signatureMode='name-only'. Empty = omitted."),
  sourceMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional(),
  gradleUserHome: gradleUserHomeSchema,
  nameMode: classNameModeSchema.default("auto").describe(NAME_MODE_DESCRIPTION),
  signatureMode: z.enum(["exact", "name-only"]).default("name-only").describe(SIGNATURE_MODE_DESCRIPTION),
  maxCandidates: optionalPositiveInt.default(5).describe("default 5, max 200"),
  detail: detailParam("summary"),
  include: responseIncludeParam
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
  compression: decodeCompressionSchema.default("auto")
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
  compression: encodeCompressionSchema.default("none")
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
  ]).describe("mode = inline | path | paths | config | project"),
  sourceRoots: z.array(z.string().min(1)).optional()
    .describe("Source roots for multi-module projects (e.g. ['common/src/main/java'])"),
  version: optionalNonEmptyString.describe("Minecraft version. Optional when input.mode='project' or preferProjectVersion=true with projectPath; required otherwise."),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  scope: artifactScopeSchema.optional().describe(SOURCE_SCOPE_DESCRIPTION),
  projectPath: optionalNonEmptyString.describe("Workspace root for Loom cache-assisted resolution"),
  gradleUserHome: gradleUserHomeSchema,
  preferProjectVersion: z.boolean().optional().describe("Detect MC version from gradle.properties and override version"),
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
  reportMode: z.enum(["compact", "full", "summary-first"]).default("summary-first")
    .describe("summary-first (default) hoists shared provenance/warnings, drops per-result heavy detail; compact omits heavy per-result detail; full = everything (required for resolvedMembers/toolHealth/resolutionTrace unless explain=true)."),
  warningCategoryFilter: z.array(z.enum(["mapping", "configuration", "validation", "resolution", "parse"])).optional()
    .describe("Only include warnings/issues matching these categories (default: all)"),
  treatInfoAsWarning: z.boolean().default(true)
    .describe("When false, suppress info-severity structured warnings from output"),
  includeIssues: z.boolean().default(true)
    .describe("When false, keep summary fields but omit per-result issues[] payloads")
};
export const validateMixinSchema = z.object(validateMixinShape).superRefine((value, ctx) => {
  if (value.version) {
    return;
  }
  const canDetectVersion =
    value.input?.mode === "project" || (value.preferProjectVersion === true && Boolean(value.projectPath));
  if (!canDetectVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message:
        "version is required unless input.mode='project' or preferProjectVersion=true with projectPath set (so the Minecraft version can be detected from gradle.properties)."
    });
  }
});

export const validateAccessWidenerShape = {
  content: nonEmptyString.describe("Access Widener file content"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
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
  atNamespace: z.enum(["srg", "mojang", "obfuscated"]).optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
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
  includeData: z.boolean().default(true).describe("false = registry names/counts only (cheap discovery); true (default) = full entry bodies."),
  maxEntriesPerRegistry: optionalPositiveInt.describe("Limit returned entries per registry body")
};
export const getRegistryDataSchema = z.object(getRegistryDataShape);

export const COMPARE_VERSIONS_CATEGORIES = ["classes", "registry", "all"] as const;
export const compareVersionsCategorySchema = z.enum(COMPARE_VERSIONS_CATEGORIES);

export const compareVersionsShape = {
  fromVersion: nonEmptyString.describe("Older Minecraft version (e.g. 1.20.4)"),
  toVersion: nonEmptyString.describe("Newer Minecraft version (e.g. 1.21)"),
  category: compareVersionsCategorySchema.default("all"),
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
  searchType: modSearchTypeSchema.default("all"),
  limit: optionalPositiveInt.default(50).describe("Max results (max 200)")
};
export const searchModSourceSchema = z.object(searchModSourceShape);

export const REMAP_TARGETS = ["yarn", "mojang"] as const;
export const remapTargetSchema = z.enum(REMAP_TARGETS);

export const remapModJarShape = {
  inputJar: nonEmptyString.describe("Path to the mod JAR file"),
  outputJar: optionalNonEmptyString.describe("Output path for remapped JAR (auto-generated if omitted)"),
  mcVersion: optionalNonEmptyString.describe("Minecraft version (auto-detected from mod metadata if omitted)"),
  targetMapping: remapTargetSchema,
  forceRemap: z
    .boolean()
    .optional()
    .describe("Skip the cache and re-resolve the newest yarn build (busts a stale remap)")
};
export const remapModJarSchema = z.object(remapModJarShape);

export const emptySchema = z.object({}).passthrough();
