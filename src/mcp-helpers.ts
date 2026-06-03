import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES, type ErrorCode } from "./errors.js";
import {
  retryClassForErrorCode,
  issueOriginForErrorCode,
  extractAllowlistedContext
} from "./error-mapping.js";
import {
  toHints,
  extractValidatedSuggestionAndExamples,
  extractFieldErrorsFromDetails
} from "./tool-guidance.js";

type ObjectResultOptions = {
  isError?: boolean;
};

export function objectResult<T extends Record<string, unknown>>(
  data: T,
  options: ObjectResultOptions = {}
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(options.isError ? { isError: true } : {})
  };
}

export function textResource(uri: string, value: string): ReadResourceResult {
  return { contents: [{ uri, text: value }] };
}

export function objectResource(uri: string, data: Record<string, unknown>): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          result: data,
          meta: { uri }
        })
      }
    ]
  };
}

function statusForResourceErrorCode(code: ErrorCode): number {
  if (code === ERROR_CODES.INVALID_INPUT) {
    return 400;
  }
  if (
    code === ERROR_CODES.FILE_NOT_FOUND ||
    code === ERROR_CODES.SOURCE_NOT_FOUND ||
    code === ERROR_CODES.CLASS_NOT_FOUND ||
    code === ERROR_CODES.VERSION_NOT_FOUND ||
    code === ERROR_CODES.JAR_NOT_FOUND
  ) {
    return 404;
  }
  if (
    code === ERROR_CODES.MAPPING_UNAVAILABLE ||
    code === ERROR_CODES.MAPPING_NOT_APPLIED ||
    code === ERROR_CODES.NAMESPACE_MISMATCH
  ) {
    return 422;
  }
  return 500;
}

export function errorResource(
  uri: string,
  error: string | { message: string; code?: ErrorCode; details?: unknown }
): ReadResourceResult {
  const isStr = typeof error === "string";
  const detail = isStr ? error : error.message;
  const code = isStr ? ERROR_CODES.INVALID_INPUT : error.code ?? ERROR_CODES.INTERNAL;
  // Resource reads carry the same AppError as the equivalent tool call, so they
  // get the same recovery metadata. Classifiers are always present; the rest is
  // extracted from the AppError details (reusing the tool-error helpers as-is so
  // the suggestedCall is validated through the single buildSuggestedCall gate).
  const details = isStr ? undefined : error.details;
  const hints = toHints(details);
  const { suggestedCall, exampleCalls } = extractValidatedSuggestionAndExamples(details);
  const fieldErrors = extractFieldErrorsFromDetails(details);
  const context = extractAllowlistedContext(details);
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          error: {
            // Keep the generic resource type/title (asserted by tests and
            // intentionally distinct from the per-code tool ProblemDetails) so
            // the two access paths stay distinguishable.
            type: "https://minecraft-modding-mcp.dev/problems/resource",
            title: "Resource read failed",
            detail,
            status: statusForResourceErrorCode(code),
            code,
            instance: uri,
            retryClass: retryClassForErrorCode(code),
            issueOrigin: issueOriginForErrorCode(code),
            ...(fieldErrors ? { fieldErrors } : {}),
            ...(hints ? { hints } : {}),
            ...(suggestedCall ? { suggestedCall } : {}),
            ...(exampleCalls ? { exampleCalls } : {}),
            ...(context ? { context } : {})
          },
          meta: { uri }
        })
      }
    ]
  };
}
