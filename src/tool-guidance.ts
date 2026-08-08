import { ZodError } from "zod";

import { buildSuggestedCall } from "./build-suggested-call.js";
import type { WarningDetail } from "./warning-details.js";
import {
  ERROR_CODES,
  isAppError
} from "./errors.js";
import {
  extractAllowlistedContext,
  extractDidYouMean,
  issueOriginForErrorCode,
  retryClassForErrorCode,
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
  /** Omitted entirely when there are no warnings (token efficiency). */
  warnings?: string[];
  /** Structured companion to `warnings`: one classified entry per warning string, referencing its text via `warnings[detail.index]`. */
  warningDetails?: WarningDetail[];
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
  reportMode: "summary-first",
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

// ---------------------------------------------------------------------------
// zod3-parity ProblemDetails formatting layer
//
// The public `fieldErrors` bytes are a frozen contract pinned by
// tests/fixtures/premigration/problemdetails/*.json, captured under zod 3.
// zod 4 renamed codes (invalid_enum_value -> invalid_value, discriminated
// invalid_union_discriminator -> invalid_union) and rewrote every default
// message. This layer reconstructs the zod3 code names and default message
// texts from zod4's STRUCTURED issue fields, as a pure function of the issue
// objects plus the (explicitly passed) original parse input. Custom messages
// (anything not matching a zod4 default pattern) pass through unchanged, the
// same way zod3 surfaced them.
// ---------------------------------------------------------------------------

type Zod4Issue = {
  code?: string;
  message: string;
  path: PropertyKey[];
  expected?: string;
  values?: unknown[];
  keys?: string[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  exact?: boolean;
  note?: string;
  options?: unknown[];
  divisor?: number;
  format?: string;
  prefix?: string;
  suffix?: string;
  includes?: string;
  input?: unknown;
};

/** zod3's getParsedType vocabulary for `received` words. */
function zod3ParsedType(data: unknown): string {
  switch (typeof data) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (data === null) return "null";
      if (Array.isArray(data)) return "array";
      if (typeof (data as { then?: unknown }).then === "function") return "promise";
      if (data instanceof Map) return "map";
      if (data instanceof Set) return "set";
      if (data instanceof Date) return "date";
      return "object";
    default:
      return "unknown";
  }
}

/** zod3's util.joinValues: single-quote strings, stringify the rest. */
function zod3JoinValues(values: unknown[], separator = " | "): string {
  return values
    .map((value) => (typeof value === "string" ? `'${value}'` : String(value)))
    .join(separator);
}

function valueAtPath(root: unknown, path: PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function zod3SizeMessage(issue: Zod4Issue, kind: "small" | "big"): string | undefined {
  const origin = issue.origin === "int" ? "number" : issue.origin;
  const limit = kind === "small" ? issue.minimum : issue.maximum;
  if (limit === undefined) return undefined;
  const inclusive = issue.inclusive !== false;
  const exact = issue.exact === true;
  switch (origin) {
    case "array":
    case "set":
      return kind === "small"
        ? `Array must contain ${exact ? "exactly" : inclusive ? "at least" : "more than"} ${limit} element(s)`
        : `Array must contain ${exact ? "exactly" : inclusive ? "at most" : "less than"} ${limit} element(s)`;
    case "string":
      return kind === "small"
        ? `String must contain ${exact ? "exactly" : inclusive ? "at least" : "over"} ${limit} character(s)`
        : `String must contain ${exact ? "exactly" : inclusive ? "at most" : "under"} ${limit} character(s)`;
    case "number":
      return kind === "small"
        ? `Number must be ${exact ? "exactly equal to" : inclusive ? "greater than or equal to" : "greater than"} ${limit}`
        : `Number must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${limit}`;
    case "bigint":
      return kind === "small"
        ? `BigInt must be ${exact ? "exactly equal to" : inclusive ? "greater than or equal to" : "greater than"} ${limit}`
        : `BigInt must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${limit}`;
    case "date":
      return kind === "small"
        ? `Date must be ${exact ? "exactly equal to" : inclusive ? "greater than or equal to" : "greater than"} ${new Date(Number(limit))}`
        : `Date must be ${exact ? "exactly" : inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(limit))}`;
    default:
      return undefined;
  }
}

const ZOD4_INVALID_TYPE_RE = /^Invalid input: expected (\S+), received (.+)$/;
const ZOD4_ENUM_RE = /^Invalid option: expected one of /;
const ZOD4_LITERAL_RE = /^Invalid input: expected \S+$/;
const ZOD4_TOO_SMALL_RE = /^Too small: /;
const ZOD4_TOO_BIG_RE = /^Too big: /;
const ZOD4_UNRECOGNIZED_RE = /^Unrecognized keys?: /;

/**
 * Maps one zod4 issue to its zod3-era {code, message}. Issues whose message
 * does not match the zod4 default pattern carry app-supplied custom text and
 * pass through unchanged (zod3 surfaced custom messages verbatim too).
 * `hasInput`/`rawInput` supply the original parse input for the `received`
 * clauses zod4 no longer records on the issue.
 */
function toZod3ParityIssue(
  issue: Zod4Issue,
  rawInput: unknown,
  hasInput: boolean
): { code: string; message: string } {
  const code = issue.code ?? "custom";
  const receivedValue = (): { known: boolean; value: unknown } => {
    if ("input" in issue) return { known: true, value: issue.input };
    if (hasInput) return { known: true, value: valueAtPath(rawInput, issue.path) };
    return { known: false, value: undefined };
  };

  switch (code) {
    case "invalid_type": {
      const match = ZOD4_INVALID_TYPE_RE.exec(issue.message);
      if (!match) return { code, message: issue.message };
      const received = receivedValue();
      const receivedWord = received.known
        ? zod3ParsedType(received.value)
        : match[2] === "NaN"
          ? "nan"
          : match[2];
      if (receivedWord === "undefined") {
        return { code, message: "Required" };
      }
      // zod3's .int() check emitted the hardcoded pair "integer"/"float"
      // (ZodNumber._parse), not the parsed-type vocabulary. zod4 reports
      // expected "int" and a plain "number" received.
      if ((issue.expected ?? match[1]) === "int") {
        const isNonIntegerNumber =
          received.known && typeof received.value === "number" && !Number.isInteger(received.value);
        if (isNonIntegerNumber || (!received.known && match[2] === "number")) {
          return { code, message: "Expected integer, received float" };
        }
        return { code, message: `Expected integer, received ${receivedWord}` };
      }
      return { code, message: `Expected ${issue.expected ?? match[1]}, received ${receivedWord}` };
    }
    case "invalid_value": {
      const values = issue.values ?? [];
      // zod3 reported a MISSING enum/literal field as invalid_type/"Required"
      // (the type check on `undefined` fired before value matching); zod4
      // folds it into invalid_value. Restore the zod3 classification.
      const missing = receivedValue();
      if (missing.known && missing.value === undefined) {
        return { code: "invalid_type", message: "Required" };
      }
      // zod3's ZodEnum type-checked BEFORE value matching: a non-string
      // received value produced invalid_type with the joined options as the
      // "expected" word and the parsed type as "received".
      if (values.length > 1 && missing.known && typeof missing.value !== "string") {
        return {
          code: "invalid_type",
          message: `Expected ${zod3JoinValues(values)}, received ${zod3ParsedType(missing.value)}`
        };
      }
      if (values.length > 1 && ZOD4_ENUM_RE.test(issue.message)) {
        const received = receivedValue();
        return {
          code: "invalid_enum_value",
          message: `Invalid enum value. Expected ${zod3JoinValues(values)}, received '${String(received.value)}'`
        };
      }
      if (values.length === 1 && ZOD4_LITERAL_RE.test(issue.message)) {
        return {
          code: "invalid_literal",
          message: `Invalid literal value, expected ${JSON.stringify(values[0])}`
        };
      }
      return { code: values.length > 1 ? "invalid_enum_value" : "invalid_literal", message: issue.message };
    }
    case "invalid_union": {
      if (issue.note === "No matching discriminator") {
        return {
          code: "invalid_union_discriminator",
          message: Array.isArray(issue.options)
            ? `Invalid discriminator value. Expected ${zod3JoinValues(issue.options)}`
            : issue.message
        };
      }
      return { code, message: issue.message === "Invalid input" ? "Invalid input" : issue.message };
    }
    case "too_small": {
      if (!ZOD4_TOO_SMALL_RE.test(issue.message)) return { code, message: issue.message };
      return { code, message: zod3SizeMessage(issue, "small") ?? issue.message };
    }
    case "too_big": {
      if (!ZOD4_TOO_BIG_RE.test(issue.message)) return { code, message: issue.message };
      return { code, message: zod3SizeMessage(issue, "big") ?? issue.message };
    }
    case "unrecognized_keys": {
      if (!ZOD4_UNRECOGNIZED_RE.test(issue.message)) return { code, message: issue.message };
      const keys = issue.keys ?? [];
      return {
        code,
        message: `Unrecognized key(s) in object: ${zod3JoinValues(keys, ", ")}`
      };
    }
    case "not_multiple_of": {
      return {
        code,
        message: issue.divisor === undefined
          ? issue.message
          : `Number must be a multiple of ${issue.divisor}`
      };
    }
    case "invalid_format": {
      if (!issue.message.startsWith("Invalid ")) return { code: "invalid_string", message: issue.message };
      switch (issue.format) {
        case "regex":
          return { code: "invalid_string", message: "Invalid" };
        case "starts_with":
          return { code: "invalid_string", message: `Invalid input: must start with "${issue.prefix ?? ""}"` };
        case "ends_with":
          return { code: "invalid_string", message: `Invalid input: must end with "${issue.suffix ?? ""}"` };
        case "includes":
          return { code: "invalid_string", message: `Invalid input: must include "${issue.includes ?? ""}"` };
        default:
          return { code: "invalid_string", message: `Invalid ${issue.format ?? "string"}` };
      }
    }
    case "custom":
      return { code, message: issue.message };
    default:
      return { code, message: issue.message };
  }
}

export function toFieldErrorsFromZod(error: ZodError, ...rawInput: [unknown?]): ProblemFieldError[] {
  const hasInput = rawInput.length > 0;
  const input = rawInput[0];
  return error.issues.map((issue) => {
    const parity = toZod3ParityIssue(issue as unknown as Zod4Issue, input, hasInput);
    return {
      path: issue.path.join(".") || "$",
      message: parity.message,
      code: parity.code
    };
  });
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
      // Re-validate through the example path, not the primary path: example
      // calls are templates and MAY carry placeholder sentinels (e.g.
      // "<version>"), which the primary gate intentionally rejects.
      const result = buildSuggestedCall({
        tool: ex.tool,
        params: undefined,
        examples: [{ params: ex.params as Record<string, unknown>, reason: ex.reason }]
      });
      const validatedExample = result.exampleCalls?.[0];
      if (validatedExample) {
        validated.push({
          tool: ex.tool,
          params: validatedExample.params,
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

  if (inputRecord?.mode === "project") {
    const projectInputPath = asNonEmptyString(inputRecord.path);
    if (projectInputPath) {
      return {
        ...shared,
        input: {
          mode: "project",
          path: projectInputPath
        },
        version
      };
    }
  }

  const path =
    (inputRecord?.mode === "path" || inputRecord?.mode === undefined
      ? asNonEmptyString(inputRecord?.path)
      : undefined) ??
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
        kind: inferTargetKindFromString(targetValue),
        value: targetValue
      }
    : {
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
  if (task === "access-transformer") {
    result.subject = {
      kind: "access-transformer",
      input: inputRecord ?? {
        mode: "inline",
        content: "<access transformer contents>"
      }
    };
    return result;
  }
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
  // Pass the reconstructed params as both the primary and a fallback example.
  // When they are fully executable they become `suggestedCall`; when they still
  // carry `<…>` placeholders (e.g. a missing version) the gate drops the
  // primary and surfaces the same shape as an `exampleCalls` template instead
  // of emitting a non-callable suggestedCall.
  const validated = buildSuggestedCall({
    tool,
    params,
    examples: [
      {
        params,
        reason: `Example ${tool} call shape — replace any <…> placeholder values before sending.`
      }
    ]
  });
  return {
    hints,
    ...validated,
    primaryDropped: !validated.suggestedCall
  };
}

function buildInspectWorkspaceSubject(source: Record<string, unknown>): Record<string, unknown> {
  const subject: Record<string, unknown> = {
    kind: "workspace",
    projectPath: asNonEmptyString(source.projectPath) ?? "<workspace-path>"
  };
  if (
    typeof source.mapping === "string" &&
    ["obfuscated", "mojang", "intermediary", "yarn"].includes(source.mapping)
  ) {
    subject.mapping = source.mapping;
  }
  if (
    typeof source.scope === "string" &&
    ["vanilla", "merged", "loader"].includes(source.scope)
  ) {
    subject.scope = source.scope;
  }
  const gradleUserHome = asNonEmptyString(source.gradleUserHome);
  if (gradleUserHome) {
    subject.gradleUserHome = gradleUserHome;
  }
  if (typeof source.preferProjectVersion === "boolean") {
    subject.preferProjectVersion = source.preferProjectVersion;
  }
  if (typeof source.strictVersion === "boolean") {
    subject.strictVersion = source.strictVersion;
  }
  return subject;
}

function inspectTaskForFocus(task: string | undefined, focusKind: "class" | "search" | "file"): string {
  if (
    focusKind === "class" &&
    (task === "auto" || task === "class-overview" || task === "class-source" || task === "class-members")
  ) {
    return task;
  }
  if (focusKind === "search" && (task === "auto" || task === "search")) {
    return task;
  }
  if (focusKind === "file" && (task === "auto" || task === "file")) {
    return task;
  }
  return "auto";
}

function buildInspectMinecraftInvalidFocusGuidance(normalizedInput: unknown): InvalidInputGuidance | undefined {
  const input = asObjectRecord(normalizedInput);
  const originalSubject = asObjectRecord(input?.subject);
  if (
    originalSubject?.kind !== "workspace" ||
    originalSubject.focus === undefined ||
    asObjectRecord(originalSubject.focus)
  ) {
    return undefined;
  }

  const requestedTask = asNonEmptyString(input?.task);
  const workspaceSubject = buildInspectWorkspaceSubject(originalSubject);
  const examples = [
    {
      params: {
        task: inspectTaskForFocus(requestedTask, "class"),
        subject: {
          ...workspaceSubject,
          focus: { kind: "class", className: "<fully-qualified-class-name>" }
        }
      },
      reason: "Use class focus for class overview, source, or member inspection."
    },
    {
      params: {
        task: inspectTaskForFocus(requestedTask, "search"),
        subject: {
          ...workspaceSubject,
          focus: { kind: "search", query: "<search-query>" }
        }
      },
      reason: "Use search focus for symbol, text, or path search."
    },
    {
      params: {
        task: inspectTaskForFocus(requestedTask, "file"),
        subject: {
          ...workspaceSubject,
          focus: { kind: "file", filePath: "<artifact-relative-file-path>" }
        }
      },
      reason: "Use file focus for an artifact-relative file read."
    }
  ];
  const validated = buildSuggestedCall({
    tool: "inspect-minecraft",
    params: undefined,
    examples
  });
  return {
    hints: [
      "inspect-minecraft subject.focus must be a structured object, not a string.",
      "Choose focus.kind=class with className, search with query, or file with filePath; task=auto dispatches from that kind and does not interpret prose."
    ],
    ...(validated.exampleCalls ? { exampleCalls: validated.exampleCalls } : {})
  };
}

export function buildInvalidInputGuidance(
  tool: string,
  normalizedInput: unknown
): InvalidInputGuidance | undefined {
  if (tool === "inspect-minecraft") {
    return buildInspectMinecraftInvalidFocusGuidance(normalizedInput);
  }

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
        `${tool}.target must be an object: {"kind":"version|jar|coordinate","value":"..."}, {"kind":"workspace"}, {"kind":"dependency","group":"...","name":"...","versionFromProject":true} (inspect a Fabric/loader dependency like vanilla), or {"kind":"artifact","artifactId":"..."} (same shape as resolve-artifact).`,
        "Bare string targets are not accepted; wrap the value under target.kind/target.value."
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
      retryClass: retryClassForErrorCode(ERROR_CODES.INVALID_INPUT),
      issueOrigin: issueOriginForErrorCode(ERROR_CODES.INVALID_INPUT),
      fieldErrors: toFieldErrorsFromZod(caughtError, context?.normalizedInput),
      hints: hintsWithFallback,
      ...(guidance?.suggestedCall ? { suggestedCall: guidance.suggestedCall } : {}),
      ...(guidance?.exampleCalls ? { exampleCalls: guidance.exampleCalls } : {}),
      ...(context?.tool === "validate-mixin" ? { failedStage: "input-validation" } : {})
    };
  }

  if (isAppError(caughtError)) {
    const { suggestedCall, exampleCalls, primaryDropped } =
      extractValidatedSuggestionAndExamples(caughtError.details);
    const invalidInputGuidance =
      context?.tool === "inspect-minecraft" && caughtError.code === ERROR_CODES.INVALID_INPUT
        ? buildInvalidInputGuidance(context.tool, context.normalizedInput)
        : undefined;
    const effectiveSuggestedCall = invalidInputGuidance
      ? invalidInputGuidance.suggestedCall
      : suggestedCall;
    const effectiveExampleCalls = invalidInputGuidance?.exampleCalls ?? exampleCalls;
    const sanitizedContext = extractAllowlistedContext(caughtError.details);
    const extractedDidYouMean = extractDidYouMean(caughtError.details);
    let failedStage = extractFailedStageFromDetails(caughtError.details);
    if (
      !failedStage
      && context?.tool === "validate-mixin"
      && caughtError.code === ERROR_CODES.INVALID_INPUT
    ) {
      failedStage = "input-validation";
    }
    const baseHints = [
      ...(toHints(caughtError.details) ?? []),
      ...(invalidInputGuidance?.hints ?? [])
    ];
    const hintsWithFallback =
      primaryDropped && !effectiveSuggestedCall
        ? [...baseHints, VALIDATION_FALLBACK_HINT]
        : baseHints.length > 0 ? baseHints : undefined;
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance: requestId,
      retryClass: retryClassForErrorCode(caughtError.code),
      issueOrigin: issueOriginForErrorCode(caughtError.code),
      fieldErrors: extractFieldErrorsFromDetails(caughtError.details),
      hints: hintsWithFallback,
      ...(effectiveSuggestedCall ? { suggestedCall: effectiveSuggestedCall } : {}),
      ...(effectiveExampleCalls ? { exampleCalls: effectiveExampleCalls } : {}),
      ...(extractedDidYouMean ? { didYouMean: extractedDidYouMean } : {}),
      ...(failedStage ? { failedStage } : {}),
      ...(sanitizedContext ? { context: sanitizedContext } : {})
    };
  }

  return {
    type: "https://minecraft-modding-mcp.dev/problems/internal",
    title: "Internal server error",
    detail: "Unexpected server error.",
    status: 500,
    code: ERROR_CODES.INTERNAL,
    instance: requestId,
    retryClass: retryClassForErrorCode(ERROR_CODES.INTERNAL),
    issueOrigin: issueOriginForErrorCode(ERROR_CODES.INTERNAL)
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
