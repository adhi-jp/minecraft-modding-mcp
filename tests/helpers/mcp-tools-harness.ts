/**
 * Shared MCP request-handler harness for the mcp-tools integration test slices.
 * Factored out of tests/mcp-tools.integration.test.ts when that file was split
 * into per-feature slices. The module-level MCP_CACHE_DIR assignment MUST run
 * before ../src/index.ts is first imported, so it lives at the top of this shared
 * module and every split file inherits it transitively via import.
 *
 * getRequestHandler dynamically imports the ../src/index.ts server singleton and
 * reads the same _requestHandlers map; all split files share that singleton at
 * runtime, which is why this harness must remain a single shared module rather
 * than being duplicated per file.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-tools-integration-cache");

export type RequestHandler = (
  request: { jsonrpc: string; id: number; method: string; params: Record<string, unknown> },
  extra: Record<string, unknown>
) => Promise<unknown>;

export type ToolSchema = {
  name: string;
  inputSchema: Record<string, unknown>;
};

export async function getRequestHandler(method: "tools/list" | "tools/call"): Promise<RequestHandler> {
  const { server } = await import("../../src/index.ts");
  const handler = (server.server as { _requestHandlers: Map<string, RequestHandler> })._requestHandlers.get(method);

  assert.ok(handler);
  return handler!;
}

export async function listTools(): Promise<ToolSchema[]> {
  const handler = await getRequestHandler("tools/list");
  const response = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {}
  ) as { tools: ToolSchema[] };

  return response.tools;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = await getRequestHandler("tools/call");
  return handler(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    },
    {}
  );
}
