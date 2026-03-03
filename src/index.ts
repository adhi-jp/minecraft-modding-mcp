import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, z } from "zod";
import { CompatStdioServerTransport } from "./compat-stdio-transport.js";

import { objectResult } from "./mcp-helpers.js";

import { loadConfig } from "./config.js";
import { ERROR_CODES, isAppError } from "./errors.js";
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
import type { ArtifactScope, MappingSourcePriority, SourceMapping, SourceTargetInput } from "./types.js";

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

type SearchIntent = "symbol" | "text" | "path";
type SearchMatch = "exact" | "prefix" | "contains" | "regex";
type SearchSymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";
type MemberAccess = "public" | "all";
type WorkspaceSymbolKind = "class" | "field" | "method";

type ProblemFieldError = {
  path: string;
  message: string;
  code?: string;
};

type SuggestedCall = {
  tool: string;
  params: Record<string, unknown>;
};

type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  fieldErrors?: ProblemFieldError[];
  hints?: string[];
  suggestedCall?: SuggestedCall;
};

type ToolMeta = {
  requestId: string;
  tool: string;
  durationMs: number;
  warnings: string[];
};

const SOURCE_MAPPINGS = ["official", "mojang", "intermediary", "yarn"] as const;
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

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = z.string().trim().min(1).optional();
const optionalPositiveInt = z.number().int().positive().optional();

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

function validateTargetPair(
  value: {
    artifactId?: string;
    targetKind?: SourceTargetInput["kind"];
    targetValue?: string;
  },
  ctx: z.RefinementCtx
): void {
  const hasArtifactId = Boolean(value.artifactId);
  const hasTargetKind = value.targetKind !== undefined;
  const hasTargetValue = value.targetValue !== undefined;

  if (hasArtifactId && (hasTargetKind || hasTargetValue)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "artifactId and targetKind/targetValue are mutually exclusive.",
      path: ["artifactId"]
    });
    return;
  }

  if (hasTargetKind !== hasTargetValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "targetKind and targetValue must be provided together.",
      path: [hasTargetKind ? "targetValue" : "targetKind"]
    });
    return;
  }

  if (!hasArtifactId && !hasTargetKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either artifactId or targetKind+targetValue must be provided.",
      path: ["artifactId"]
    });
  }
}

const listVersionsShape = {
  includeSnapshots: z.boolean().optional().describe("default false"),
  limit: optionalPositiveInt.describe("default 20, max 200")
};
const listVersionsSchema = z.object(listVersionsShape);

const resolveArtifactShape = {
  targetKind: targetKindSchema.describe("version | jar | coordinate"),
  targetValue: nonEmptyString,
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().optional().describe("default true"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  scope: artifactScopeSchema.optional().describe("vanilla = Mojang client jar only; merged = Loom cache discovery (default); loader = loader-specific"),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override targetValue")
};
const resolveArtifactSchema = z.object(resolveArtifactShape);

const getClassSourceShape = {
  className: nonEmptyString,
  mode: sourceModeSchema.optional().describe("metadata (default) = symbol outline only; snippet = source with default maxLines=200; full = entire source"),
  artifactId: optionalNonEmptyString,
  targetKind: targetKindSchema.optional().describe("version | jar | coordinate"),
  targetValue: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().optional().describe("default true"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  scope: artifactScopeSchema.optional().describe("vanilla = Mojang client jar only; merged = Loom cache discovery (default); loader = loader-specific"),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override targetValue"),
  startLine: optionalPositiveInt,
  endLine: optionalPositiveInt,
  maxLines: optionalPositiveInt,
  maxChars: optionalPositiveInt.describe("Hard character limit on sourceText; truncates if exceeded"),
  outputFile: optionalNonEmptyString.describe("Write source to this file path and return metadata-only response")
};
const getClassSourceSchema = z
  .object(getClassSourceShape)
  .superRefine((value, ctx) => {
    validateTargetPair(
      {
        artifactId: value.artifactId,
        targetKind: value.targetKind,
        targetValue: value.targetValue
      },
      ctx
    );

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
  artifactId: optionalNonEmptyString,
  targetKind: targetKindSchema.optional().describe("version | jar | coordinate"),
  targetValue: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn (default official)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  allowDecompile: z.boolean().optional().describe("default true"),
  access: memberAccessSchema.optional().describe("public | all (default public)"),
  includeSynthetic: z.boolean().optional().describe("default false"),
  includeInherited: z.boolean().optional().describe("default false"),
  memberPattern: optionalNonEmptyString,
  maxMembers: optionalPositiveInt.describe("default 500, max 5000"),
  projectPath: optionalNonEmptyString,
  scope: artifactScopeSchema.optional().describe("vanilla | merged | loader"),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override version")
};
const getClassMembersSchema = z
  .object(getClassMembersShape)
  .superRefine((value, ctx) => {
    validateTargetPair(
      {
        artifactId: value.artifactId,
        targetKind: value.targetKind,
        targetValue: value.targetValue
      },
      ctx
    );
  });

const searchClassSourceShape = {
  artifactId: nonEmptyString,
  query: nonEmptyString,
  intent: searchIntentSchema.optional().describe("symbol | text | path"),
  match: searchMatchSchema.optional().describe("exact | prefix | contains | regex"),
  packagePrefix: optionalNonEmptyString,
  fileGlob: optionalNonEmptyString,
  symbolKind: searchSymbolKindSchema.optional().describe("class | interface | enum | record | method | field"),
  snippetLines: optionalPositiveInt.describe("default 8, clamp 1..80"),
  includeDefinition: z.boolean().optional().describe("default false"),
  includeOneHop: z.boolean().optional().describe("default false"),
  limit: optionalPositiveInt.describe("default 20"),
  cursor: optionalNonEmptyString
};
const searchClassSourceSchema = z.object(searchClassSourceShape);

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
  cursor: optionalNonEmptyString
};
const listArtifactFilesSchema = z.object(listArtifactFilesShape);

const traceSymbolLifecycleShape = {
  symbol: nonEmptyString.describe("fully.qualified.Class.method"),
  descriptor: optionalNonEmptyString.describe('optional JVM descriptor, e.g. "(I)V"'),
  fromVersion: optionalNonEmptyString,
  toVersion: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn (default official)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  includeSnapshots: z.boolean().optional().describe("default false"),
  maxVersions: optionalPositiveInt.describe("default 120, max 400"),
  includeTimeline: z.boolean().optional().describe("default false")
};
const traceSymbolLifecycleSchema = z.object(traceSymbolLifecycleShape);

const diffClassSignaturesShape = {
  className: nonEmptyString,
  fromVersion: nonEmptyString,
  toVersion: nonEmptyString,
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn (default official)"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first")
};
const diffClassSignaturesSchema = z.object(diffClassSignaturesShape);

const findMappingShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalNonEmptyString,
  sourceMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  disambiguation: z
    .object({
      ownerHint: optionalNonEmptyString,
      descriptorHint: optionalNonEmptyString
    })
    .partial()
    .optional()
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

const resolveMethodMappingExactShape = {
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalNonEmptyString.describe("required for kind=method"),
  sourceMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  targetMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first")
};
const resolveMethodMappingExactSchema = z
  .object(resolveMethodMappingExactShape)
  .superRefine((value, ctx) => {
    if (value.kind !== "method") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resolve-method-mapping-exact requires kind=method.",
        path: ["kind"]
      });
    }
    if (!value.owner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "owner is required when kind=method.",
        path: ["owner"]
      });
    }
    if (!value.descriptor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "descriptor is required when kind=method.",
        path: ["descriptor"]
      });
    }
    if (/[\s./()]/.test(value.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name must be a simple method name when kind=method.",
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
  classNameMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  includeKinds: classApiKindsSchema.optional().describe("comma-separated: class,field,method"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first")
};
const getClassApiMatrixSchema = z.object(getClassApiMatrixShape);

const resolveWorkspaceSymbolShape = {
  projectPath: nonEmptyString,
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema.describe("class | field | method"),
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalNonEmptyString,
  sourceMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first")
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
  descriptor: optionalNonEmptyString.describe("required for kind=method unless signatureMode=name-only"),
  sourceMapping: sourceMappingSchema.describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  nameMode: classNameModeSchema.optional().describe("fqcn | auto (default fqcn)"),
  signatureMode: z.enum(["exact", "name-only"]).optional()
    .describe("exact (default): require descriptor for methods; name-only: match by owner+name only")
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
  compression: decodeCompressionSchema.optional().describe("none | gzip | auto (default auto)")
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
  compression: encodeCompressionSchema.optional().describe("none | gzip (default none)")
};
const jsonToNbtSchema = z.object(jsonToNbtShape);

const indexArtifactShape = {
  artifactId: nonEmptyString,
  force: z.boolean().optional().describe("default false")
};
const indexArtifactSchema = z.object(indexArtifactShape);

const validateMixinShape = {
  source: optionalNonEmptyString.describe("Mixin Java source text (mutually exclusive with sourcePath/sourcePaths)"),
  sourcePath: optionalNonEmptyString.describe("Path to Mixin .java file (alternative to source/sourcePaths)"),
  sourcePaths: z.array(z.string().min(1)).optional().describe("Array of Mixin .java file paths for batch validation"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first"),
  scope: artifactScopeSchema.optional().describe("vanilla | merged | loader"),
  projectPath: optionalNonEmptyString.describe("Optional workspace root path for Loom cache-assisted source resolution"),
  preferProjectVersion: z.boolean().optional().describe("When true, detect MC version from gradle.properties and override version"),
  minSeverity: z.enum(["error", "warning", "all"]).optional()
    .describe("'error'=errors only, 'warning'=errors+warnings, 'all'=everything (default 'all')"),
  hideUncertain: z.boolean().optional()
    .describe("Omit issues with confidence='uncertain' (default false)"),
  explain: z.boolean().optional()
    .describe("When true, enrich each issue with explanation and suggestedCall for agent recovery (default false)")
};
const validateMixinSchema = z.object(validateMixinShape).refine(
  (d) => {
    const hasSource = d.source != null;
    const hasSourcePath = d.sourcePath != null;
    const hasSourcePaths = d.sourcePaths != null && d.sourcePaths.length > 0;
    // Exactly one of the three must be provided
    return [hasSource, hasSourcePath, hasSourcePaths].filter(Boolean).length === 1;
  },
  { message: "Exactly one of 'source', 'sourcePath', or 'sourcePaths' must be provided." }
);

const validateAccessWidenerShape = {
  content: nonEmptyString.describe("Access Widener file content"),
  version: nonEmptyString.describe("Minecraft version"),
  mapping: sourceMappingSchema.optional().describe("official | mojang | intermediary | yarn"),
  sourcePriority: mappingSourcePrioritySchema.optional().describe("loom-first | maven-first")
};
const validateAccessWidenerSchema = z.object(validateAccessWidenerShape);

const analyzeModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  includeClasses: z.boolean().optional().describe("Include full class listing (default false)")
};
const analyzeModJarSchema = z.object(analyzeModJarShape);

const getRegistryDataShape = {
  version: nonEmptyString.describe("Minecraft version (e.g. 1.21)"),
  registry: optionalNonEmptyString.describe('Optional registry name (e.g. "block", "item", "minecraft:biome"). Omit to list all registries.')
};
const getRegistryDataSchema = z.object(getRegistryDataShape);

const COMPARE_VERSIONS_CATEGORIES = ["classes", "registry", "all"] as const;
const compareVersionsCategorySchema = z.enum(COMPARE_VERSIONS_CATEGORIES);

const compareVersionsShape = {
  fromVersion: nonEmptyString.describe("Older Minecraft version (e.g. 1.20.4)"),
  toVersion: nonEmptyString.describe("Newer Minecraft version (e.g. 1.21)"),
  category: compareVersionsCategorySchema.optional().describe("classes | registry | all (default all)"),
  packageFilter: optionalNonEmptyString.describe("Filter classes to a package prefix (e.g. net.minecraft.world.item)"),
  maxClassResults: optionalPositiveInt.describe("Max class results per direction (default 500, max 5000)")
};
const compareVersionsSchema = z.object(compareVersionsShape);

const decompileModJarShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: optionalNonEmptyString.describe("Optional fully-qualified class name to view source. Omit to list all classes.")
};
const decompileModJarSchema = z.object(decompileModJarShape);

const getModClassSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  className: nonEmptyString.describe("Fully-qualified class name (e.g. com.example.MyMixin)")
};
const getModClassSourceSchema = z.object(getModClassSourceShape);

const MOD_SEARCH_TYPES = ["class", "method", "field", "content", "all"] as const;
const modSearchTypeSchema = z.enum(MOD_SEARCH_TYPES);

const searchModSourceShape = {
  jarPath: nonEmptyString.describe("Local path to the mod JAR file"),
  query: nonEmptyString.describe("Search pattern (regex or literal string)"),
  searchType: modSearchTypeSchema.optional().describe("class | method | field | content | all (default all)"),
  limit: optionalPositiveInt.describe("Max results (default 50, max 200)")
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

function buildTarget(
  kind: SourceTargetInput["kind"] | undefined,
  value: string | undefined
): SourceTargetInput | undefined {
  if (!kind || !value) {
    return undefined;
  }
  return { kind, value };
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

function toSuggestedCall(details: unknown): SuggestedCall | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }
  const maybe = (details as Record<string, unknown>).suggestedCall;
  if (typeof maybe !== "object" || maybe == null) {
    return undefined;
  }
  const call = maybe as Record<string, unknown>;
  if (typeof call.tool !== "string" || typeof call.params !== "object" || call.params == null) {
    return undefined;
  }
  return { tool: call.tool, params: call.params as Record<string, unknown> };
}

function statusForErrorCode(code: string): number {
  if (
    code === ERROR_CODES.INVALID_INPUT ||
    code === ERROR_CODES.COORDINATE_PARSE_FAILED ||
    code === ERROR_CODES.INVALID_LINE_RANGE ||
    code === ERROR_CODES.NBT_PARSE_FAILED ||
    code === ERROR_CODES.NBT_INVALID_TYPED_JSON ||
    code === ERROR_CODES.JSON_PATCH_INVALID ||
    code === ERROR_CODES.NBT_ENCODE_FAILED ||
    code === ERROR_CODES.NBT_UNSUPPORTED_FEATURE
  ) {
    return 400;
  }

  if (code === ERROR_CODES.JSON_PATCH_CONFLICT || code === ERROR_CODES.CONTEXT_UNRESOLVED) {
    return 409;
  }

  if (
    code === ERROR_CODES.SOURCE_NOT_FOUND ||
    code === ERROR_CODES.FILE_NOT_FOUND ||
    code === ERROR_CODES.JAR_NOT_FOUND ||
    code === ERROR_CODES.VERSION_NOT_FOUND ||
    code === ERROR_CODES.CLASS_NOT_FOUND
  ) {
    return 404;
  }

  if (
    code === ERROR_CODES.MAPPING_NOT_APPLIED ||
    code === ERROR_CODES.MAPPING_UNAVAILABLE ||
    code === ERROR_CODES.NAMESPACE_MISMATCH ||
    code === ERROR_CODES.DECOMPILE_DISABLED ||
    code === ERROR_CODES.REMAP_FAILED
  ) {
    return 422;
  }

  if (
    code === ERROR_CODES.REMAPPER_UNAVAILABLE ||
    code === ERROR_CODES.JAVA_PROCESS_FAILED
  ) {
    return 503;
  }

  if (code === ERROR_CODES.LIMIT_EXCEEDED) {
    return 413;
  }

  if (code === ERROR_CODES.REPO_FETCH_FAILED) {
    return 502;
  }

  if (
    code === ERROR_CODES.DECOMPILER_UNAVAILABLE ||
    code === ERROR_CODES.DECOMPILER_FAILED ||
    code === ERROR_CODES.JAVA_UNAVAILABLE ||
    code === ERROR_CODES.REGISTRY_GENERATION_FAILED
  ) {
    return 503;
  }

  return 500;
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

function mapErrorToProblem(caughtError: unknown, requestId: string): ProblemDetails {
  if (caughtError instanceof ZodError) {
    return {
      type: "https://minecraft-modding-mcp.dev/problems/invalid-input",
      title: "Invalid input",
      detail: "Request validation failed.",
      status: 400,
      code: ERROR_CODES.INVALID_INPUT,
      instance: requestId,
      fieldErrors: toFieldErrorsFromZod(caughtError),
      hints: ["Check fieldErrors and submit a valid tool argument payload."]
    };
  }

  if (isAppError(caughtError)) {
    const suggestedCall = toSuggestedCall(caughtError.details);
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance: requestId,
      fieldErrors: extractFieldErrorsFromDetails(caughtError.details),
      hints: toHints(caughtError.details),
      ...(suggestedCall ? { suggestedCall } : {})
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
} {
  const result = { ...data };
  const maybeWarnings = result.warnings;
  if (!Array.isArray(maybeWarnings)) {
    return {
      result,
      warnings: []
    };
  }

  const warnings = maybeWarnings.filter((entry): entry is string => typeof entry === "string");
  delete result.warnings;

  return {
    result,
    warnings
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

  try {
    const parsedInput = schema.parse(rawInput);
    const payload = await action(parsedInput);
    const { result, warnings } = splitWarnings(payload);

    return objectResult({
      result,
      meta: {
        requestId,
        tool,
        durationMs: Date.now() - startedAt,
        warnings
      } satisfies ToolMeta
    });
  } catch (caughtError) {
    const problem = mapErrorToProblem(caughtError, requestId);

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

    return objectResult({
      error: problem,
      meta: {
        requestId,
        tool,
        durationMs: Date.now() - startedAt,
        warnings: []
      } satisfies ToolMeta
    });
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

server.tool("resolve-artifact",
  "Resolve source artifact from version, jar path, or Maven coordinate and return artifact metadata. For targetKind=jar, only <basename>-sources.jar is auto-adopted; other adjacent *-sources.jar files are informational.",
  resolveArtifactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-artifact", args, resolveArtifactSchema, async (input) =>
    sourceService.resolveArtifact({
      target: {
        kind: input.targetKind,
        value: input.targetValue
      },
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);

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

server.tool("get-class-source",
  "Get Java source for a class by artifactId or by resolving target (version/jar/coordinate). Default mode=metadata returns symbol outline only; use mode=snippet for bounded excerpts or mode=full for entire source.",
  getClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-source", args, getClassSourceSchema, async (input) =>
    sourceService.getClassSource({
      className: input.className,
      mode: input.mode,
      artifactId: input.artifactId,
      target: buildTarget(input.targetKind, input.targetValue),
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      startLine: input.startLine,
      endLine: input.endLine,
      maxLines: input.maxLines,
      maxChars: input.maxChars,
      outputFile: input.outputFile
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("get-class-members",
  "Get fields/methods/constructors for one class from binary bytecode by artifactId or by resolving target (version/jar/coordinate).",
  getClassMembersShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-members", args, getClassMembersSchema, async (input) =>
    sourceService.getClassMembers({
      className: input.className,
      artifactId: input.artifactId,
      target: buildTarget(input.targetKind, input.targetValue),
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
      preferProjectVersion: input.preferProjectVersion
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("search-class-source",
  "Search indexed class source files for one artifact with symbol/text/path intent and optional one-hop relation expansion.",
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

      const include =
        input.snippetLines !== undefined ||
        input.includeDefinition !== undefined ||
        input.includeOneHop !== undefined
          ? {
              snippetLines: input.snippetLines,
              includeDefinition: input.includeDefinition,
              includeOneHop: input.includeOneHop
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
        include,
        limit: input.limit,
        cursor: input.cursor
      }) as Promise<Record<string, unknown>>;
    })
);

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

server.tool("list-artifact-files",
  "List source file paths in an artifact with optional prefix filter and cursor-based pagination.",
  listArtifactFilesShape,
  { readOnlyHint: true },
  async (args) => runTool("list-artifact-files", args, listArtifactFilesSchema, async (input) =>
    sourceService.listArtifactFiles(input) as Promise<Record<string, unknown>>
  )
);

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
      sourcePriority: input.sourcePriority
    }) as Promise<Record<string, unknown>>
  )
);

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
      disambiguation: input.disambiguation
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("resolve-method-mapping-exact",
  "Resolve one method mapping exactly by owner+name+descriptor between namespaces and report resolved/not_found/ambiguous.",
  resolveMethodMappingExactShape,
  { readOnlyHint: true },
  async (args) => runTool("resolve-method-mapping-exact", args, resolveMethodMappingExactSchema, async (input) =>
    sourceService.resolveMethodMappingExact({
      version: input.version,
      kind: input.kind,
      name: input.name,
      owner: input.owner,
      descriptor: input.descriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("get-class-api-matrix",
  "List class/member API rows across official/mojang/intermediary/yarn mappings for one class and Minecraft version.",
  getClassApiMatrixShape,
  { readOnlyHint: true },
  async (args) => runTool("get-class-api-matrix", args, getClassApiMatrixSchema, async (input) =>
    sourceService.getClassApiMatrix({
      version: input.version,
      className: input.className,
      classNameMapping: input.classNameMapping,
      includeKinds: parseClassApiKinds(input.includeKinds),
      sourcePriority: input.sourcePriority
    }) as Promise<Record<string, unknown>>
  )
);

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
      sourcePriority: input.sourcePriority
    }) as Promise<Record<string, unknown>>
  )
);

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
      signatureMode: input.signatureMode
    }) as Promise<Record<string, unknown>>
  )
);

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

server.tool("get-runtime-metrics",
  "Get runtime service counters and latency snapshots for cache/search/index diagnostics.",
  { readOnlyHint: true },
  async (args) => runTool("get-runtime-metrics", args, emptySchema, async () =>
    Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
  )
);

server.tool("validate-mixin",
  "Validate Mixin source against Minecraft bytecode signatures for a given version.",
  validateMixinShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-mixin", args, validateMixinSchema, async (input) =>
    sourceService.validateMixin({
      source: input.source,
      sourcePath: input.sourcePath,
      sourcePaths: input.sourcePaths,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope as ArtifactScope | undefined,
      projectPath: input.projectPath,
      preferProjectVersion: input.preferProjectVersion,
      minSeverity: input.minSeverity,
      hideUncertain: input.hideUncertain,
      explain: input.explain
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("validate-access-widener",
  "Validate Access Widener file entries against Minecraft bytecode signatures for a given version.",
  validateAccessWidenerShape,
  { readOnlyHint: true },
  async (args) => runTool("validate-access-widener", args, validateAccessWidenerSchema, async (input) =>
    sourceService.validateAccessWidener({
      content: input.content,
      version: input.version,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority
    }) as Promise<Record<string, unknown>>
  )
);

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

server.tool("get-registry-data",
  "Get Minecraft registry data (blocks, items, biomes, etc.) for a specific version by running the server data generator.",
  getRegistryDataShape,
  { readOnlyHint: true },
  async (args) => runTool("get-registry-data", args, getRegistryDataSchema, async (input) =>
    sourceService.getRegistryData({
      version: input.version,
      registry: input.registry
    }) as Promise<Record<string, unknown>>
  )
);

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

server.tool("decompile-mod-jar",
  "Decompile a Minecraft mod JAR using Vineflower and list available classes, or view a specific class source. Builds on analyze-mod-jar by exposing the actual source code.",
  decompileModJarShape,
  { readOnlyHint: true },
  async (args) => runTool("decompile-mod-jar", args, decompileModJarSchema, async (input) =>
    sourceService.decompileModJar({
      jarPath: input.jarPath,
      className: input.className
    }) as Promise<Record<string, unknown>>
  )
);

server.tool("get-mod-class-source",
  "Get decompiled source code for a specific class in a mod JAR. The mod JAR will be decompiled if not already cached.",
  getModClassSourceShape,
  { readOnlyHint: true },
  async (args) => runTool("get-mod-class-source", args, getModClassSourceSchema, async (input) =>
    sourceService.getModClassSource({
      jarPath: input.jarPath,
      className: input.className
    }) as Promise<Record<string, unknown>>
  )
);

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
