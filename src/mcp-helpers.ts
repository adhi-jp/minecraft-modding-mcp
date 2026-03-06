import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES, type ErrorCode } from "./errors.js";

export function objectResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
  error: string | { message: string; code?: ErrorCode }
): ReadResourceResult {
  const detail = typeof error === "string" ? error : error.message;
  const code = typeof error === "string" ? ERROR_CODES.INVALID_INPUT : error.code ?? ERROR_CODES.INTERNAL;
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          error: {
            type: "https://minecraft-modding-mcp.dev/problems/resource",
            title: "Resource read failed",
            detail,
            status: statusForResourceErrorCode(code),
            code,
            instance: uri
          },
          meta: { uri }
        })
      }
    ]
  };
}
