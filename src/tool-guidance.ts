import { ZodError } from "zod";

import { buildSuggestedCall } from "./build-suggested-call.js";
import {
  ERROR_CODES,
  isAppError
} from "./errors.js";
import {
  statusForErrorCode,
  type ExampleCall,
  type ProblemDetails,
  type ProblemFieldError,
  type SuggestedCall
} from "./error-mapping.js";
import type { SourceTargetInput } from "./types.js";

export type ToolMeta = {
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

export const SUGGESTED_CALL_DEFAULTS = {
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

export function isSuggestedCallDefault(
  field: keyof typeof SUGGESTED_CALL_DEFAULTS,
  value: unknown
): boolean {
  return value === SUGGESTED_CALL_DEFAULTS[field];
}

export const ANALYZE_MOD_INCLUDE_GROUPS = ["warnings", "files", "source", "samples", "timings"] as const;
export const ANALYZE_MOD_LEGACY_METADATA_INCLUDES = ["metadata", "entrypoints", "mixins", "dependencies"] as const;
export const VALIDATE_PROJECT_INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;
export const VALIDATE_PROJECT_LEGACY_WORKSPACE_INCLUDES = ["detectedConfig", "mixins", "accessWideners"] as const;

export const VALIDATION_FALLBACK_HINT =
  "suggested call payload failed schema validation; using fallback examples";

export function toFieldErrorsFromZod(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "$",
    message: issue.message,
    code: issue.code
  }));
}

export function toHints(details: unknown): string[] | undefined {
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

export function extractValidatedSuggestionAndExamples(details: unknown): {
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

export function extractFailedStageFromDetails(details: unknown): string | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }
  const maybeStage = (details as Record<string, unknown>).failedStage;
  if (typeof maybeStage === "string" && maybeStage.trim().length > 0) {
    return maybeStage;
  }
  return undefined;
}

export function extractFieldErrorsFromDetails(details: unknown): ProblemFieldError[] | undefined {
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

export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())
    ? value as string[]
    : undefined;
}

export function truncateSuggestionText(value: string, maxLength = 500): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}...`
    : value;
}

export function parseJsonObjectString(value: string): Record<string, unknown> | undefined {
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

export function inferTargetKindFromString(value: string): SourceTargetInput["kind"] {
  if (/[\\/]/.test(value) || /\.jar$/i.test(value)) {
    return "jar";
  }
  if (value.split(":").length >= 3) {
    return "coordinate";
  }
  return "version";
}

export function copySourceLookupSuggestionFields(
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

export function copyValidateMixinSharedParams(source: Record<string, unknown>): Record<string, unknown> {
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

export function buildValidateMixinSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
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

export function buildResolveArtifactSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
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

export function buildSourceLookupSuggestedParams(
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

export function filterAllowedIncludeValues(
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

export function buildAnalyzeModSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
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

export function buildValidateProjectSuggestedParams(normalizedInput: unknown): Record<string, unknown> {
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

export function buildInvalidInputGuidance(
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
