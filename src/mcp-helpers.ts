import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

export function objectResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function textResource(uri: string, value: string): ReadResourceResult {
  return { contents: [{ uri, text: value }] };
}

export function objectResource(uri: string, data: Record<string, unknown>): ReadResourceResult {
  return { contents: [{ uri, text: JSON.stringify(data) }] };
}

export function errorResource(uri: string, message: string): ReadResourceResult {
  return { contents: [{ uri, text: JSON.stringify({ error: message }) }] };
}
