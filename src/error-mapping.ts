import { ERROR_CODES, isAppError, type ErrorCode } from "./errors.js";
import { log } from "./logger.js";

export type ProblemFieldError = {
  path: string;
  message: string;
  code?: string;
};

export type SuggestedCall = {
  tool: string;
  params: Record<string, unknown>;
};

export type ExampleCall = {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
};

/**
 * Whether retrying the same call can help, and why if not:
 * - `transient`: a temporary failure (network, rate limit, timeout); retrying
 *   the same call later may succeed.
 * - `permanent`: the requested thing does not exist or cannot be produced;
 *   retrying the same call will keep failing.
 * - `environment`: the server lacks a capability (Java, decompiler, remapper);
 *   retrying will not help until the environment is fixed.
 * - `input`: the caller's input is wrong; fix the input, then retry.
 */
export type RetryClass = "transient" | "permanent" | "environment" | "input";

export type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  retryClass: RetryClass;
  fieldErrors?: ProblemFieldError[];
  hints?: string[];
  suggestedCall?: SuggestedCall;
  exampleCalls?: ExampleCall[];
  failedStage?: string;
};

export function statusForErrorCode(code: string): number {
  if (code === ERROR_CODES.BATCH_ABORTED) {
    return 412;
  }

  if (code === ERROR_CODES.STAGE_BUDGET_PRE_PARSE) {
    // 408 (Request Timeout): caller-recoverable stage-budget exhaustion,
    // not an internal server failure.
    return 408;
  }

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
    code === ERROR_CODES.REMAP_FAILED ||
    code === ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED ||
    code === ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED
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

const RETRY_CLASS_INPUT = new Set<string>([
  ERROR_CODES.INVALID_INPUT,
  ERROR_CODES.COORDINATE_PARSE_FAILED,
  ERROR_CODES.INVALID_LINE_RANGE,
  ERROR_CODES.NBT_PARSE_FAILED,
  ERROR_CODES.NBT_INVALID_TYPED_JSON,
  ERROR_CODES.JSON_PATCH_INVALID,
  ERROR_CODES.JSON_PATCH_CONFLICT,
  ERROR_CODES.NBT_ENCODE_FAILED,
  ERROR_CODES.NBT_UNSUPPORTED_FEATURE,
  ERROR_CODES.NAMESPACE_MISMATCH,
  ERROR_CODES.CONTEXT_UNRESOLVED,
  ERROR_CODES.MIXIN_PARSE_FAILED
]);

const RETRY_CLASS_PERMANENT = new Set<string>([
  ERROR_CODES.SOURCE_NOT_FOUND,
  ERROR_CODES.FILE_NOT_FOUND,
  ERROR_CODES.JAR_NOT_FOUND,
  ERROR_CODES.VERSION_NOT_FOUND,
  ERROR_CODES.CLASS_NOT_FOUND,
  ERROR_CODES.MAPPING_NOT_APPLIED,
  ERROR_CODES.MAPPING_UNAVAILABLE,
  ERROR_CODES.DECOMPILE_DISABLED,
  ERROR_CODES.REMAP_FAILED,
  ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
  ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
  ERROR_CODES.PROVENANCE_INCOMPLETE,
  ERROR_CODES.BATCH_ABORTED
]);

const RETRY_CLASS_ENVIRONMENT = new Set<string>([
  ERROR_CODES.JAVA_UNAVAILABLE,
  ERROR_CODES.DECOMPILER_UNAVAILABLE,
  ERROR_CODES.DECOMPILER_FAILED,
  ERROR_CODES.REMAPPER_UNAVAILABLE,
  ERROR_CODES.REGISTRY_GENERATION_FAILED
]);

/**
 * Single source of truth mapping an error code to its {@link RetryClass}. Used
 * by every public problem builder so callers can branch on recovery strategy
 * without parsing prose. Codes not explicitly classified (including
 * `ERR_INTERNAL` and unknown codes) default to `transient`: a generic server
 * failure where one retry is reasonable.
 */
export function retryClassForErrorCode(code: string): RetryClass {
  if (RETRY_CLASS_INPUT.has(code)) {
    return "input";
  }
  if (RETRY_CLASS_PERMANENT.has(code)) {
    return "permanent";
  }
  if (RETRY_CLASS_ENVIRONMENT.has(code)) {
    return "environment";
  }
  return "transient";
}

function extractFieldErrors(details: unknown): ProblemFieldError[] | undefined {
  if (typeof details !== "object" || details == null) return undefined;
  const raw = (details as Record<string, unknown>).fieldErrors;
  if (!Array.isArray(raw)) return undefined;
  const out: ProblemFieldError[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry == null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.path !== "string" || typeof rec.message !== "string") continue;
    out.push({
      path: rec.path,
      message: rec.message,
      ...(typeof rec.code === "string" ? { code: rec.code } : {})
    });
  }
  return out.length > 0 ? out : undefined;
}

function extractHints(details: unknown): string[] | undefined {
  if (typeof details !== "object" || details == null) return undefined;
  const next = (details as Record<string, unknown>).nextAction;
  if (typeof next !== "string" || !next.trim()) return undefined;
  return [next.trim()];
}

/**
 * Per-entry subset of `mapErrorToProblem` for batch tools. ZodErrors are not
 * handled here (per-entry input has already cleared the batch tool's schema
 * gate); the optional `suggestedCall` is attached as-is for the caller's
 * synthesized retry payload.
 */
export function errorToBatchEntryProblem(
  caughtError: unknown,
  instance: string,
  options?: { suggestedCall?: SuggestedCall }
): ProblemDetails {
  if (isAppError(caughtError)) {
    const baseHints = extractHints(caughtError.details);
    const fieldErrors = extractFieldErrors(caughtError.details);
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance,
      retryClass: retryClassForErrorCode(caughtError.code),
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(baseHints ? { hints: baseHints } : {}),
      ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {})
    };
  }

  // Generic-error sanitization: fixed public detail, raw message logged
  // server-side keyed by `instance`. Mirrors `mapErrorToProblem` so the
  // public envelope cannot leak filesystem paths, parser internals, or
  // assertion text on a non-AppError path.
  const rawMessage =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  log("error", "batch.entry.unhandled", {
    instance,
    reason: rawMessage
  });
  return {
    type: "https://minecraft-modding-mcp.dev/problems/internal",
    title: "Internal server error",
    detail: "Unexpected server error.",
    status: 500,
    code: ERROR_CODES.INTERNAL,
    instance,
    retryClass: retryClassForErrorCode(ERROR_CODES.INTERNAL),
    ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {})
  };
}

export function buildBatchAbortedProblem(instance: string): ProblemDetails {
  return {
    type: `https://minecraft-modding-mcp.dev/problems/${ERROR_CODES.BATCH_ABORTED.toLowerCase()}`,
    title: "Batch aborted",
    detail: "Earlier entry failed and failFast=true.",
    status: 412,
    code: ERROR_CODES.BATCH_ABORTED,
    instance,
    retryClass: retryClassForErrorCode(ERROR_CODES.BATCH_ABORTED)
  };
}

export type { ErrorCode };
