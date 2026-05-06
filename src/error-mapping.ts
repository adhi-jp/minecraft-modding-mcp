import { ERROR_CODES, isAppError, type ErrorCode } from "./errors.js";

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

export type ProblemDetails = {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: string;
  instance: string;
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
 * Convert an error caught during a batch entry's underlying service call into the
 * ProblemDetails shape that single-tool callers see. This is a per-entry-only
 * subset of `mapErrorToProblem` — it does not handle ZodErrors (the per-entry
 * input is a typed sub-object that has already passed the batch tool's schema
 * gate, so runtime errors are AppError or generic Error) and does not call
 * `buildInvalidInputGuidance`. Callers that need a synthesized retry payload
 * pass it via the optional `suggestedCall` parameter; this helper only attaches
 * it after coercing the value to the expected shape.
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
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(baseHints ? { hints: baseHints } : {}),
      ...(options?.suggestedCall ? { suggestedCall: options.suggestedCall } : {})
    };
  }

  const message =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  return {
    type: "https://minecraft-modding-mcp.dev/problems/internal",
    title: "Internal server error",
    detail: message || "Unexpected server error.",
    status: 500,
    code: ERROR_CODES.INTERNAL,
    instance,
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
    instance
  };
}

export type { ErrorCode };
