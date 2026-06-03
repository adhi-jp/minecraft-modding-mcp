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
 * - `server`: a non-recoverable internal server fault (programming bug, DB
 *   corruption); retrying the identical call cannot help. Distinct from
 *   `permanent`, which is about an absent/unproducible target rather than a
 *   server defect. Treat like `permanent` for retry posture (do not retry).
 * - `environment`: the server lacks a capability (Java, decompiler, remapper);
 *   retrying will not help until the environment is fixed.
 * - `input`: the caller's input is wrong; fix the input, then retry.
 */
export type RetryClass = "transient" | "permanent" | "server" | "environment" | "input";

/**
 * Where the failure originates, so an agent knows whether to fix its own
 * request or stop retrying this tool:
 * - `code_issue`: the caller's input is wrong or names something that does not
 *   exist; fix the request.
 * - `tool_issue`: the tool could not produce a result for valid input (mapping
 *   gap, upstream fetch, internal limit).
 * - `environment`: a server capability is missing (Java, decompiler, remapper).
 */
export type IssueOrigin = "code_issue" | "tool_issue" | "environment";

export type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
  retryClass: RetryClass;
  issueOrigin: IssueOrigin;
  fieldErrors?: ProblemFieldError[];
  hints?: string[];
  suggestedCall?: SuggestedCall;
  exampleCalls?: ExampleCall[];
  failedStage?: string;
  context?: Record<string, string | number | boolean>;
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

// Non-recoverable internal server faults: a deterministic defect where retrying
// the identical call cannot help. ERR_INTERNAL covers sanitized programming
// bugs / unexpected throws; ERR_DB_FAILURE covers SQLite integrity/migration
// failures (the open-failure path can be a transient file lock, but corruption
// and migration failures dominate, so it is classified server by default).
const RETRY_CLASS_SERVER = new Set<string>([
  ERROR_CODES.INTERNAL,
  ERROR_CODES.DB_FAILURE
]);

/**
 * Single source of truth mapping an error code to its {@link RetryClass}. Used
 * by every public problem builder so callers can branch on recovery strategy
 * without parsing prose. Non-recoverable server faults (`ERR_INTERNAL`,
 * `ERR_DB_FAILURE`) classify as `server`. Codes not explicitly classified
 * (genuinely-transient failures such as `ERR_REPO_FETCH_FAILED` and unknown
 * codes) default to `transient`: a temporary failure where one retry is
 * reasonable.
 */
export function retryClassForErrorCode(code: string): RetryClass {
  if (RETRY_CLASS_INPUT.has(code)) {
    return "input";
  }
  if (RETRY_CLASS_PERMANENT.has(code)) {
    return "permanent";
  }
  if (RETRY_CLASS_SERVER.has(code)) {
    return "server";
  }
  if (RETRY_CLASS_ENVIRONMENT.has(code)) {
    return "environment";
  }
  return "transient";
}

// "Your request is wrong or names something absent" — the caller can fix it.
const ISSUE_ORIGIN_CODE = new Set<string>([
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
  ERROR_CODES.MIXIN_PARSE_FAILED,
  ERROR_CODES.CLASS_NOT_FOUND,
  ERROR_CODES.SOURCE_NOT_FOUND,
  ERROR_CODES.FILE_NOT_FOUND,
  ERROR_CODES.JAR_NOT_FOUND,
  ERROR_CODES.VERSION_NOT_FOUND,
  ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
  ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED
]);

/**
 * Single source of truth mapping an error code to its {@link IssueOrigin}.
 * Environment failures reuse the retry classifier; the input-family above is
 * `code_issue`; everything else is a `tool_issue` (valid input the tool could
 * not satisfy).
 */
export function issueOriginForErrorCode(code: string): IssueOrigin {
  if (RETRY_CLASS_ENVIRONMENT.has(code)) {
    return "environment";
  }
  if (ISSUE_ORIGIN_CODE.has(code)) {
    return "code_issue";
  }
  return "tool_issue";
}

// Non-sensitive AppError.details fields that are safe to echo to callers as
// machine-readable repair context. Filesystem paths and free-form text are
// intentionally excluded.
const CONTEXT_ALLOWLIST = new Set<string>([
  "queryLength",
  "maxLength",
  "artifactId",
  "registry",
  "registryName",
  "stage",
  "version",
  "mapping",
  "namespace",
  "kind",
  "owner",
  "limit",
  "count",
  "maxMembers",
  "candidateCount",
  "candidatesSeen",
  "ambiguous"
]);

/**
 * Pick the allowlisted, primitive-valued fields out of an AppError's `details`
 * so the public envelope can carry structured repair context without leaking
 * paths, parser internals, or other sensitive data.
 */
export function extractAllowlistedContext(
  details: unknown
): Record<string, string | number | boolean> | undefined {
  if (typeof details !== "object" || details == null) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const key of CONTEXT_ALLOWLIST) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const context = extractAllowlistedContext(caughtError.details);
    return {
      type: `https://minecraft-modding-mcp.dev/problems/${caughtError.code.toLowerCase()}`,
      title: "Tool execution error",
      detail: caughtError.message,
      status: statusForErrorCode(caughtError.code),
      code: caughtError.code,
      instance,
      retryClass: retryClassForErrorCode(caughtError.code),
      issueOrigin: issueOriginForErrorCode(caughtError.code),
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(baseHints ? { hints: baseHints } : {}),
      ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {}),
      ...(context ? { context } : {})
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
    issueOrigin: issueOriginForErrorCode(ERROR_CODES.INTERNAL),
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
    retryClass: retryClassForErrorCode(ERROR_CODES.BATCH_ABORTED),
    issueOrigin: issueOriginForErrorCode(ERROR_CODES.BATCH_ABORTED)
  };
}

export type { ErrorCode };
