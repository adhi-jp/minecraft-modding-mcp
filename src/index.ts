import { readFileSync } from "node:fs";

import { MCPServer, object, type TypedCallToolResult } from "mcp-use/server";
import { ZodError, z } from "zod";

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
import type { MappingSourcePriority, SourceMapping, SourceTargetInput } from "./types.js";

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

type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  fieldErrors?: ProblemFieldError[];
  hints?: string[];
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

const listVersionsSchema = z.object({
  includeSnapshots: z.boolean().optional(),
  limit: optionalPositiveInt
});

const resolveArtifactSchema = z.object({
  targetKind: targetKindSchema,
  targetValue: nonEmptyString,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  allowDecompile: z.boolean().optional()
});

const getClassSourceSchema = z
  .object({
    className: nonEmptyString,
    artifactId: optionalNonEmptyString,
    targetKind: targetKindSchema.optional(),
    targetValue: optionalNonEmptyString,
    mapping: sourceMappingSchema.optional(),
    sourcePriority: mappingSourcePrioritySchema.optional(),
    allowDecompile: z.boolean().optional(),
    startLine: optionalPositiveInt,
    endLine: optionalPositiveInt,
    maxLines: optionalPositiveInt
  })
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

const getClassMembersSchema = z
  .object({
    className: nonEmptyString,
    artifactId: optionalNonEmptyString,
    targetKind: targetKindSchema.optional(),
    targetValue: optionalNonEmptyString,
    mapping: sourceMappingSchema.optional(),
    sourcePriority: mappingSourcePrioritySchema.optional(),
    allowDecompile: z.boolean().optional(),
    access: memberAccessSchema.optional(),
    includeSynthetic: z.boolean().optional(),
    includeInherited: z.boolean().optional(),
    memberPattern: optionalNonEmptyString,
    maxMembers: optionalPositiveInt
  })
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

const searchClassSourceSchema = z.object({
  artifactId: nonEmptyString,
  query: nonEmptyString,
  intent: searchIntentSchema.optional(),
  match: searchMatchSchema.optional(),
  packagePrefix: optionalNonEmptyString,
  fileGlob: optionalNonEmptyString,
  symbolKind: searchSymbolKindSchema.optional(),
  snippetLines: optionalPositiveInt,
  includeDefinition: z.boolean().optional(),
  includeOneHop: z.boolean().optional(),
  limit: optionalPositiveInt,
  cursor: optionalNonEmptyString
});

const getArtifactFileSchema = z.object({
  artifactId: nonEmptyString,
  filePath: nonEmptyString,
  maxBytes: optionalPositiveInt
});

const listArtifactFilesSchema = z.object({
  artifactId: nonEmptyString,
  prefix: optionalNonEmptyString,
  limit: optionalPositiveInt,
  cursor: optionalNonEmptyString
});

const traceSymbolLifecycleSchema = z.object({
  symbol: nonEmptyString,
  descriptor: optionalNonEmptyString,
  fromVersion: optionalNonEmptyString,
  toVersion: optionalNonEmptyString,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional(),
  includeSnapshots: z.boolean().optional(),
  maxVersions: optionalPositiveInt,
  includeTimeline: z.boolean().optional()
});

const diffClassSignaturesSchema = z.object({
  className: nonEmptyString,
  fromVersion: nonEmptyString,
  toVersion: nonEmptyString,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional()
});

const findMappingSchema = z.object({
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema,
  name: nonEmptyString,
  owner: optionalNonEmptyString,
  descriptor: optionalNonEmptyString,
  sourceMapping: sourceMappingSchema,
  targetMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional()
}).superRefine((value, ctx) => {
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

const resolveMethodMappingExactSchema = z
  .object({
    version: nonEmptyString,
    kind: workspaceSymbolKindSchema,
    name: nonEmptyString,
    owner: optionalNonEmptyString,
    descriptor: optionalNonEmptyString,
    sourceMapping: sourceMappingSchema,
    targetMapping: sourceMappingSchema,
    sourcePriority: mappingSourcePrioritySchema.optional()
  })
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

const getClassApiMatrixSchema = z.object({
  version: nonEmptyString,
  className: nonEmptyString,
  classNameMapping: sourceMappingSchema,
  includeKinds: classApiKindsSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional()
});

const resolveWorkspaceSymbolSchema = z
  .object({
    projectPath: nonEmptyString,
    version: nonEmptyString,
    kind: workspaceSymbolKindSchema,
    name: nonEmptyString,
    owner: optionalNonEmptyString,
    descriptor: optionalNonEmptyString,
    sourceMapping: sourceMappingSchema,
    sourcePriority: mappingSourcePrioritySchema.optional()
  })
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

const checkSymbolExistsSchema = z.object({
  version: nonEmptyString,
  kind: workspaceSymbolKindSchema,
  owner: optionalNonEmptyString,
  name: nonEmptyString,
  descriptor: optionalNonEmptyString,
  sourceMapping: sourceMappingSchema,
  sourcePriority: mappingSourcePrioritySchema.optional()
}).superRefine((value, ctx) => {
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

const nbtToJsonSchema = z.object({
  nbtBase64: nonEmptyString,
  compression: decodeCompressionSchema.optional()
});

const nbtPatchOperationSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "test"]),
    path: nonEmptyString,
    value: z.unknown().optional()
  })
  .passthrough();

const nbtApplyJsonPatchSchema = z.object({
  typedJson: z.unknown(),
  patch: z.array(nbtPatchOperationSchema)
});

const jsonToNbtSchema = z.object({
  typedJson: z.unknown(),
  compression: encodeCompressionSchema.optional()
});

const indexArtifactSchema = z.object({
  artifactId: nonEmptyString,
  force: z.boolean().optional()
});

const validateMixinSchema = z.object({
  source: nonEmptyString,
  version: nonEmptyString,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional()
});

const validateAccessWidenerSchema = z.object({
  content: nonEmptyString,
  version: nonEmptyString,
  mapping: sourceMappingSchema.optional(),
  sourcePriority: mappingSourcePrioritySchema.optional()
});

const analyzeModJarSchema = z.object({
  jarPath: nonEmptyString,
  includeClasses: z.boolean().optional()
});

const getRegistryDataSchema = z.object({
  version: nonEmptyString,
  registry: optionalNonEmptyString
});

const COMPARE_VERSIONS_CATEGORIES = ["classes", "registry", "all"] as const;
const compareVersionsCategorySchema = z.enum(COMPARE_VERSIONS_CATEGORIES);

const compareVersionsSchema = z.object({
  fromVersion: nonEmptyString,
  toVersion: nonEmptyString,
  category: compareVersionsCategorySchema.optional(),
  packageFilter: optionalNonEmptyString,
  maxClassResults: optionalPositiveInt
});

const decompileModJarSchema = z.object({
  jarPath: nonEmptyString,
  className: optionalNonEmptyString
});

const getModClassSourceSchema = z.object({
  jarPath: nonEmptyString,
  className: nonEmptyString
});

const MOD_SEARCH_TYPES = ["class", "method", "field", "content", "all"] as const;
const modSearchTypeSchema = z.enum(MOD_SEARCH_TYPES);

const searchModSourceSchema = z.object({
  jarPath: nonEmptyString,
  query: nonEmptyString,
  searchType: modSearchTypeSchema.optional(),
  limit: optionalPositiveInt
});

const REMAP_TARGETS = ["yarn", "mojang"] as const;
const remapTargetSchema = z.enum(REMAP_TARGETS);

const remapModJarSchema = z.object({
  inputJar: nonEmptyString,
  outputJar: optionalNonEmptyString,
  mcVersion: optionalNonEmptyString,
  targetMapping: remapTargetSchema
});

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

const server = new MCPServer({
  name: "@adhisang/minecraft-modding-mcp",
  version: SERVER_VERSION
});

const config = loadConfig();
const nbtLimits = {
  maxInputBytes: config.maxNbtInputBytes,
  maxInflatedBytes: config.maxNbtInflatedBytes,
  maxResponseBytes: config.maxNbtResponseBytes
};
const sourceService = new SourceService(config);
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
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance: requestId,
      fieldErrors: extractFieldErrorsFromDetails(caughtError.details),
      hints: toHints(caughtError.details)
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
): Promise<TypedCallToolResult<Record<string, unknown>>> {
  const requestId = buildRequestId();
  const startedAt = Date.now();

  try {
    const parsedInput = schema.parse(rawInput);
    const payload = await action(parsedInput);
    const { result, warnings } = splitWarnings(payload);

    return object({
      result,
      meta: {
        requestId,
        tool,
        durationMs: Date.now() - startedAt,
        warnings
      } satisfies ToolMeta
    }) as TypedCallToolResult<Record<string, unknown>>;
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

    return object({
      error: problem,
      meta: {
        requestId,
        tool,
        durationMs: Date.now() - startedAt,
        warnings: []
      } satisfies ToolMeta
    }) as TypedCallToolResult<Record<string, unknown>>;
  }
}

server.tool(
  {
    name: "list-versions",
    description: "List available Minecraft versions from Mojang manifest and locally cached version jars.",
    inputs: [
      { name: "includeSnapshots", type: "boolean", description: "default false" },
      { name: "limit", type: "number", description: "default 20, max 200" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("list-versions", rawInput, listVersionsSchema, async (input) =>
      sourceService.listVersions({
        includeSnapshots: input.includeSnapshots,
        limit: input.limit
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "resolve-artifact",
    description:
      "Resolve source artifact from version, jar path, or Maven coordinate and return artifact metadata. For targetKind=jar, only <basename>-sources.jar is auto-adopted; other adjacent *-sources.jar files are informational.",
    inputs: [
      { name: "targetKind", type: "string", required: true, description: "version | jar | coordinate" },
      { name: "targetValue", type: "string", required: true },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" },
      { name: "allowDecompile", type: "boolean", description: "default true" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("resolve-artifact", rawInput, resolveArtifactSchema, async (input) =>
      sourceService.resolveArtifact({
        target: {
          kind: input.targetKind,
          value: input.targetValue
        },
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        allowDecompile: input.allowDecompile
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "get-class-source",
    description:
      "Get Java source for a class by artifactId or by resolving target (version/jar/coordinate), with optional line-range filtering.",
    inputs: [
      { name: "className", type: "string", required: true },
      { name: "artifactId", type: "string" },
      { name: "targetKind", type: "string", description: "version | jar | coordinate" },
      { name: "targetValue", type: "string" },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" },
      { name: "allowDecompile", type: "boolean", description: "default true" },
      { name: "startLine", type: "number" },
      { name: "endLine", type: "number" },
      { name: "maxLines", type: "number" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-class-source", rawInput, getClassSourceSchema, async (input) =>
      sourceService.getClassSource({
        className: input.className,
        artifactId: input.artifactId,
        target: buildTarget(input.targetKind, input.targetValue),
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        allowDecompile: input.allowDecompile,
        startLine: input.startLine,
        endLine: input.endLine,
        maxLines: input.maxLines
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "get-class-members",
    description:
      "Get fields/methods/constructors for one class from binary bytecode by artifactId or by resolving target (version/jar/coordinate).",
    inputs: [
      { name: "className", type: "string", required: true },
      { name: "artifactId", type: "string" },
      { name: "targetKind", type: "string", description: "version | jar | coordinate" },
      { name: "targetValue", type: "string" },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn (default official)" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" },
      { name: "allowDecompile", type: "boolean", description: "default true" },
      { name: "access", type: "string", description: "public | all (default public)" },
      { name: "includeSynthetic", type: "boolean", description: "default false" },
      { name: "includeInherited", type: "boolean", description: "default false" },
      { name: "memberPattern", type: "string" },
      { name: "maxMembers", type: "number", description: "default 500, max 5000" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-class-members", rawInput, getClassMembersSchema, async (input) =>
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
        maxMembers: input.maxMembers
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "search-class-source",
    description:
      "Search indexed class source files for one artifact with symbol/text/path intent and optional one-hop relation expansion.",
    inputs: [
      { name: "artifactId", type: "string", required: true },
      { name: "query", type: "string", required: true },
      { name: "intent", type: "string", description: "symbol | text | path" },
      { name: "match", type: "string", description: "exact | prefix | contains | regex" },
      { name: "packagePrefix", type: "string" },
      { name: "fileGlob", type: "string" },
      { name: "symbolKind", type: "string", description: "class | interface | enum | record | method | field" },
      { name: "snippetLines", type: "number", description: "default 8, clamp 1..80" },
      { name: "includeDefinition", type: "boolean", description: "default false" },
      { name: "includeOneHop", type: "boolean", description: "default false" },
      { name: "limit", type: "number", description: "default 20" },
      { name: "cursor", type: "string" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("search-class-source", rawInput, searchClassSourceSchema, async (input) => {
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
    });
  }
);

server.tool(
  {
    name: "get-artifact-file",
    description: "Get full source file content by artifactId and file path.",
    inputs: [
      { name: "artifactId", type: "string", required: true },
      { name: "filePath", type: "string", required: true },
      { name: "maxBytes", type: "number" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-artifact-file", rawInput, getArtifactFileSchema, async (input) =>
      sourceService.getArtifactFile({
        artifactId: input.artifactId,
        filePath: input.filePath,
        maxBytes: input.maxBytes
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "list-artifact-files",
    description: "List source file paths in an artifact with optional prefix filter and cursor-based pagination.",
    inputs: [
      { name: "artifactId", type: "string", required: true },
      { name: "prefix", type: "string" },
      { name: "limit", type: "number" },
      { name: "cursor", type: "string" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("list-artifact-files", rawInput, listArtifactFilesSchema, async (input) =>
      sourceService.listArtifactFiles(input) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "trace-symbol-lifecycle",
    description:
      "Trace which Minecraft versions contain a specific class method and report first/last seen versions.",
    inputs: [
      { name: "symbol", type: "string", required: true, description: "fully.qualified.Class.method" },
      { name: "descriptor", type: "string", description: 'optional JVM descriptor, e.g. "(I)V"' },
      { name: "fromVersion", type: "string" },
      { name: "toVersion", type: "string" },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn (default official)" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" },
      { name: "includeSnapshots", type: "boolean", description: "default false" },
      { name: "maxVersions", type: "number", description: "default 120, max 400" },
      { name: "includeTimeline", type: "boolean", description: "default false" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("trace-symbol-lifecycle", rawInput, traceSymbolLifecycleSchema, async (input) =>
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
    );
  }
);

server.tool(
  {
    name: "diff-class-signatures",
    description:
      "Compare one class signature between two Minecraft versions and report added/removed/modified constructors, methods, and fields.",
    inputs: [
      { name: "className", type: "string", required: true },
      { name: "fromVersion", type: "string", required: true },
      { name: "toVersion", type: "string", required: true },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn (default official)" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("diff-class-signatures", rawInput, diffClassSignaturesSchema, async (input) =>
      sourceService.diffClassSignatures({
        className: input.className,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "find-mapping",
    description:
      "Find symbol mapping candidates between namespaces using structured symbol inputs for a specific Minecraft version.",
    inputs: [
      { name: "version", type: "string", required: true },
      { name: "kind", type: "string", required: true, description: "class | field | method" },
      { name: "name", type: "string", required: true },
      { name: "owner", type: "string" },
      { name: "descriptor", type: "string" },
      { name: "sourceMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "targetMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("find-mapping", rawInput, findMappingSchema, async (input) =>
      sourceService.findMapping({
        version: input.version,
        kind: input.kind,
        name: input.name,
        owner: input.owner,
        descriptor: input.descriptor,
        sourceMapping: input.sourceMapping,
        targetMapping: input.targetMapping,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "resolve-method-mapping-exact",
    description:
      "Resolve one method mapping exactly by owner+name+descriptor between namespaces and report resolved/not_found/ambiguous.",
    inputs: [
      { name: "version", type: "string", required: true },
      { name: "kind", type: "string", required: true, description: "class | field | method" },
      { name: "name", type: "string", required: true },
      { name: "owner", type: "string" },
      { name: "descriptor", type: "string", description: "required for kind=method" },
      { name: "sourceMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "targetMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("resolve-method-mapping-exact", rawInput, resolveMethodMappingExactSchema, async (input) =>
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
    );
  }
);

server.tool(
  {
    name: "get-class-api-matrix",
    description:
      "List class/member API rows across official/mojang/intermediary/yarn mappings for one class and Minecraft version.",
    inputs: [
      { name: "version", type: "string", required: true },
      { name: "className", type: "string", required: true },
      { name: "classNameMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "includeKinds", type: "string", description: "comma-separated: class,field,method" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-class-api-matrix", rawInput, getClassApiMatrixSchema, async (input) =>
      sourceService.getClassApiMatrix({
        version: input.version,
        className: input.className,
        classNameMapping: input.classNameMapping,
        includeKinds: parseClassApiKinds(input.includeKinds),
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "resolve-workspace-symbol",
    description:
      "Resolve class/field/method names as seen at compile time for a workspace by reading Gradle Loom mapping settings.",
    inputs: [
      { name: "projectPath", type: "string", required: true },
      { name: "version", type: "string", required: true },
      { name: "kind", type: "string", required: true, description: "class | field | method" },
      { name: "name", type: "string", required: true },
      { name: "owner", type: "string" },
      { name: "descriptor", type: "string" },
      { name: "sourceMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("resolve-workspace-symbol", rawInput, resolveWorkspaceSymbolSchema, async (input) =>
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
    );
  }
);

server.tool(
  {
    name: "check-symbol-exists",
    description:
      "Check whether a class/field/method symbol exists in a specific mapping namespace for one Minecraft version.",
    inputs: [
      { name: "version", type: "string", required: true },
      { name: "kind", type: "string", required: true, description: "class | field | method" },
      { name: "owner", type: "string" },
      { name: "name", type: "string", required: true },
      { name: "descriptor", type: "string", description: "required for kind=method" },
      { name: "sourceMapping", type: "string", required: true, description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("check-symbol-exists", rawInput, checkSymbolExistsSchema, async (input) =>
      sourceService.checkSymbolExists({
        version: input.version,
        kind: input.kind,
        owner: input.owner,
        name: input.name,
        descriptor: input.descriptor,
        sourceMapping: input.sourceMapping,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "nbt-to-json",
    description: "Decode Java Edition NBT binary payload (base64) into typed JSON.",
    inputs: [
      { name: "nbtBase64", type: "string", required: true },
      { name: "compression", type: "string", description: "none | gzip | auto (default auto)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("nbt-to-json", rawInput, nbtToJsonSchema, async (input) =>
      Promise.resolve(
        nbtBase64ToTypedJson({
          nbtBase64: input.nbtBase64,
          compression: input.compression as DecodeCompression | undefined
        }, nbtLimits) as unknown as Record<string, unknown>
      )
    );
  }
);

server.tool(
  {
    name: "nbt-apply-json-patch",
    description: "Apply RFC6902 add/remove/replace/test operations to typed NBT JSON.",
    inputs: [
      { name: "typedJson", type: "object", required: true },
      {
        name: "patch",
        type: "array",
        required: true,
        description: "RFC6902 operation array (add/remove/replace/test)"
      }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("nbt-apply-json-patch", rawInput, nbtApplyJsonPatchSchema, async (input) =>
      Promise.resolve(
        applyNbtJsonPatch({
          typedJson: input.typedJson,
          patch: input.patch
        }, nbtLimits) as unknown as Record<string, unknown>
      )
    );
  }
);

server.tool(
  {
    name: "json-to-nbt",
    description: "Encode typed NBT JSON to Java Edition NBT binary payload (base64).",
    inputs: [
      { name: "typedJson", type: "object", required: true },
      { name: "compression", type: "string", description: "none | gzip (default none)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("json-to-nbt", rawInput, jsonToNbtSchema, async (input) =>
      Promise.resolve(
        typedJsonToNbtBase64({
          typedJson: input.typedJson,
          compression: input.compression as EncodeCompression | undefined
        }, nbtLimits) as unknown as Record<string, unknown>
      )
    );
  }
);

server.tool(
  {
    name: "index-artifact",
    description:
      "Rebuild indexed files/symbols metadata for an existing artifactId. Does not resolve new artifacts.",
    inputs: [
      { name: "artifactId", type: "string", required: true },
      { name: "force", type: "boolean", description: "default false" }
    ]
  },
  async (rawInput) => {
    return runTool("index-artifact", rawInput, indexArtifactSchema, async (input) =>
      sourceService.indexArtifact({
        artifactId: input.artifactId,
        force: input.force
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "get-runtime-metrics",
    description: "Get runtime service counters and latency snapshots for cache/search/index diagnostics.",
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-runtime-metrics", rawInput, emptySchema, async () =>
      Promise.resolve(sourceService.getRuntimeMetrics() as unknown as Record<string, unknown>)
    );
  }
);

server.tool(
  {
    name: "validate-mixin",
    description: "Validate Mixin source against Minecraft bytecode signatures for a given version.",
    inputs: [
      { name: "source", type: "string", required: true, description: "Mixin Java source text" },
      { name: "version", type: "string", required: true, description: "Minecraft version" },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("validate-mixin", rawInput, validateMixinSchema, async (input) =>
      sourceService.validateMixin({
        source: input.source,
        version: input.version,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "validate-access-widener",
    description: "Validate Access Widener file entries against Minecraft bytecode signatures for a given version.",
    inputs: [
      { name: "content", type: "string", required: true, description: "Access Widener file content" },
      { name: "version", type: "string", required: true, description: "Minecraft version" },
      { name: "mapping", type: "string", description: "official | mojang | intermediary | yarn" },
      { name: "sourcePriority", type: "string", description: "loom-first | maven-first" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("validate-access-widener", rawInput, validateAccessWidenerSchema, async (input) =>
      sourceService.validateAccessWidener({
        content: input.content,
        version: input.version,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "analyze-mod-jar",
    description:
      "Analyze a Minecraft mod JAR to extract loader type, metadata, entrypoints, mixins, and dependencies.",
    inputs: [
      { name: "jarPath", type: "string", required: true, description: "Local path to the mod JAR file" },
      { name: "includeClasses", type: "boolean", description: "Include full class listing (default false)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("analyze-mod-jar", rawInput, analyzeModJarSchema, async (input) => {
      const result = await analyzeModJar(input.jarPath, {
        includeClasses: input.includeClasses ?? false
      });
      return result as unknown as Record<string, unknown>;
    });
  }
);

server.tool(
  {
    name: "get-registry-data",
    description:
      "Get Minecraft registry data (blocks, items, biomes, etc.) for a specific version by running the server data generator.",
    inputs: [
      { name: "version", type: "string", required: true, description: "Minecraft version (e.g. 1.21)" },
      {
        name: "registry",
        type: "string",
        description: 'Optional registry name (e.g. "block", "item", "minecraft:biome"). Omit to list all registries.'
      }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-registry-data", rawInput, getRegistryDataSchema, async (input) =>
      sourceService.getRegistryData({
        version: input.version,
        registry: input.registry
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "compare-versions",
    description:
      "Compare two Minecraft versions to find added/removed classes and registry entry changes. Useful for understanding what changed between versions during mod migration.",
    inputs: [
      { name: "fromVersion", type: "string", required: true, description: "Older Minecraft version (e.g. 1.20.4)" },
      { name: "toVersion", type: "string", required: true, description: "Newer Minecraft version (e.g. 1.21)" },
      {
        name: "category",
        type: "string",
        description: "classes | registry | all (default all)"
      },
      { name: "packageFilter", type: "string", description: "Filter classes to a package prefix (e.g. net.minecraft.world.item)" },
      { name: "maxClassResults", type: "number", description: "Max class results per direction (default 500, max 5000)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("compare-versions", rawInput, compareVersionsSchema, async (input) =>
      sourceService.compareVersions({
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        category: input.category,
        packageFilter: input.packageFilter,
        maxClassResults: input.maxClassResults
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "decompile-mod-jar",
    description:
      "Decompile a Minecraft mod JAR using Vineflower and list available classes, or view a specific class source. Builds on analyze-mod-jar by exposing the actual source code.",
    inputs: [
      { name: "jarPath", type: "string", required: true, description: "Local path to the mod JAR file" },
      {
        name: "className",
        type: "string",
        description: "Optional fully-qualified class name to view source. Omit to list all classes."
      }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("decompile-mod-jar", rawInput, decompileModJarSchema, async (input) =>
      sourceService.decompileModJar({
        jarPath: input.jarPath,
        className: input.className
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "get-mod-class-source",
    description:
      "Get decompiled source code for a specific class in a mod JAR. The mod JAR will be decompiled if not already cached.",
    inputs: [
      { name: "jarPath", type: "string", required: true, description: "Local path to the mod JAR file" },
      { name: "className", type: "string", required: true, description: "Fully-qualified class name (e.g. com.example.MyMixin)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("get-mod-class-source", rawInput, getModClassSourceSchema, async (input) =>
      sourceService.getModClassSource({
        jarPath: input.jarPath,
        className: input.className
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "search-mod-source",
    description:
      "Search through decompiled mod JAR source code by class name, method, field, or content pattern. The mod JAR will be decompiled automatically if not already cached.",
    inputs: [
      { name: "jarPath", type: "string", required: true, description: "Local path to the mod JAR file" },
      { name: "query", type: "string", required: true, description: "Search pattern (regex or literal string)" },
      {
        name: "searchType",
        type: "string",
        description: "class | method | field | content | all (default all)"
      },
      { name: "limit", type: "number", description: "Max results (default 50, max 200)" }
    ],
    annotations: {
      readOnlyHint: true
    }
  },
  async (rawInput) => {
    return runTool("search-mod-source", rawInput, searchModSourceSchema, async (input) =>
      sourceService.searchModSource({
        jarPath: input.jarPath,
        query: input.query,
        searchType: input.searchType,
        limit: input.limit
      }) as Promise<Record<string, unknown>>
    );
  }
);

server.tool(
  {
    name: "remap-mod-jar",
    description:
      "Remap a Fabric mod JAR from intermediary to yarn/mojang names. Requires Java to be installed.",
    inputs: [
      { name: "inputJar", type: "string", required: true, description: "Path to the mod JAR file" },
      { name: "outputJar", type: "string", description: "Output path for remapped JAR (auto-generated if omitted)" },
      {
        name: "mcVersion",
        type: "string",
        description: "Minecraft version (auto-detected from mod metadata if omitted)"
      },
      { name: "targetMapping", type: "string", required: true, description: "yarn | mojang" }
    ],
    annotations: {
      readOnlyHint: false
    }
  },
  async (rawInput) => {
    return runTool("remap-mod-jar", rawInput, remapModJarSchema, async (input) => {
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
    });
  }
);

export function startServer(): void {
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
  server.listen();
  serverStarted = true;
}

export { server, sourceService, config, SERVER_VERSION };
