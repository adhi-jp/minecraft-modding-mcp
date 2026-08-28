import { ResourceNotFoundError } from "@modelcontextprotocol/server";
import type { CallToolResult, ReadResourceResult, ServerContext } from "@modelcontextprotocol/server";
import { PROBLEM_DETAILS_READ_CACHE_FIELDS } from "./cache-policy.js";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "./era-classifier.js";
import { ERROR_CODES, type ErrorCode } from "./errors.js";
import {
  problemClassification,
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

function isResourceNotFoundErrorCode(code: ErrorCode): boolean {
  return (
    code === ERROR_CODES.FILE_NOT_FOUND ||
    code === ERROR_CODES.SOURCE_NOT_FOUND ||
    code === ERROR_CODES.CLASS_NOT_FOUND ||
    code === ERROR_CODES.VERSION_NOT_FOUND ||
    code === ERROR_CODES.JAR_NOT_FOUND
  );
}

function statusForResourceErrorCode(code: ErrorCode): number {
  if (code === ERROR_CODES.INVALID_INPUT) {
    return 400;
  }
  if (isResourceNotFoundErrorCode(code)) {
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

/** Shallow plain-object check, mirroring era-classifier's canonical helper. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the request being handled carries the FULL shallow modern
 * (2026-07-28) era signal in its lifted `_meta` envelope: a string
 * protocol-version AND a plain-object clientCapabilities — the same shallow
 * modern-signal check era-classifier's `classifyEraSignal` applies at
 * supervisor admission (kept in lockstep; that module is the canonical
 * definition). The version key ALONE is not enough: a claim-shaped-INVALID
 * request (version present, capabilities missing/invalid) is
 * legacy-permissively forwarded on a legacy-locked connection, the SDK's
 * era-blind lift still surfaces the key at `ctx.mcpReq.envelope`, and the
 * reply is encoded by the LEGACY codec — which serializes handler-returned
 * fields verbatim. Shallow-VALID envelopes, by contrast, are answered by the
 * 2026 codec (the SDK rejects envelope-less modern requests -32602
 * pre-handler, and era-conflict admission keeps modern claims off legacy
 * connections). Reads only public context surface (`ctx.mcpReq.envelope`).
 */
export function isModernEraRequest(ctx: Pick<ServerContext, "mcpReq"> | undefined): boolean {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  return (
    typeof envelope?.[PROTOCOL_VERSION_META_KEY] === "string" &&
    isPlainObject(envelope[CLIENT_CAPABILITIES_META_KEY])
  );
}

export function errorResource(
  uri: string,
  error: string | { message: string; code?: ErrorCode; details?: unknown },
  ctx?: Pick<ServerContext, "mcpReq">
): ReadResourceResult {
  const isStr = typeof error === "string";
  const detail = isStr ? error : error.message;
  const code = isStr ? ERROR_CODES.INVALID_INPUT : error.code ?? ERROR_CODES.INTERNAL;
  if (!isStr && isModernEraRequest(ctx) && isResourceNotFoundErrorCode(code)) {
    throw new ResourceNotFoundError(uri, detail);
  }
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
    // ProblemDetails-read cache override (adopted policy): STRUCTURAL
    // identification — this constructor IS the error-resource path, so the
    // override never re-infers from serialized text. Emitted as
    // handler-returned result fields (SDK precedence rank 1, beating the
    // resource's configured class-row hint) and gated to modern-era requests
    // because the 2025 codec serializes handler-returned fields verbatim —
    // legacy replies must stay byte-identical to the frozen golden surfaces.
    ...(isModernEraRequest(ctx) ? PROBLEM_DETAILS_READ_CACHE_FIELDS : {}),
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
            // Shared with the tool path via the one classification builder, so
            // a throw site that classified itself (e.g. a tool-resolved
            // artifact with no binary jar) is not silently re-labelled
            // caller-fixable just because the caller used a resource URI.
            ...problemClassification(code, details),
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
