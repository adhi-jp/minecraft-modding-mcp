/**
 * In-process MCP session over the production factory with an explicit catalog
 * spec list (helper module, not a test file). It serves `buildServer(ctx,
 * specs)` through the SDK stdio entry over an in-memory transport, so the
 * listing and calls go through the real registration and runner.
 *
 * Callers set MCP_CACHE_DIR / MCP_SQLITE_PATH before the first session:
 * src/index.ts is imported lazily here.
 */
import { InMemoryTransport, type JSONRPCMessage, type McpRequestContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import type { CatalogToolSpec } from "../../src/tools/types.ts";
import { MODERN_META } from "../stdio/inprocess-era-serve.ts";

export type SessionFrame = {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

export type CatalogSession = {
  request(method: string, params?: Record<string, unknown>): Promise<SessionFrame>;
  listToolNames(): Promise<string[]>;
  listTools(): Promise<Array<Record<string, unknown> & { name: string }>>;
  callTool(name: string, args: unknown): Promise<SessionFrame>;
  close(): Promise<void>;
};

let nextId = 0;

export async function startCatalogSession(
  specs: readonly CatalogToolSpec[],
  era: "legacy" | "modern" = "legacy"
): Promise<CatalogSession> {
  const { buildServer } = await import("../../src/index.ts");
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const frames: SessionFrame[] = [];
  clientEnd.onmessage = (message) => {
    frames.push(message as SessionFrame);
  };
  const handle = serveStdio((ctx: McpRequestContext) => buildServer(ctx, specs), { transport: serverEnd });
  await clientEnd.start();

  const send = (message: object): Promise<void> => clientEnd.send(message as JSONRPCMessage);
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<SessionFrame> => {
    nextId += 1;
    const id = `catalog-session-${nextId}`;
    await send({
      jsonrpc: "2.0",
      id,
      method,
      params: era === "modern" ? { ...params, _meta: MODERN_META } : params
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const frame = frames.find((candidate) => candidate.id === id);
      if (frame !== undefined) return frame;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${method} reply ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  if (era === "legacy") {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "catalog-session", version: "0.0.0" }
    });
    if (init.error !== undefined) {
      throw new Error(`legacy handshake failed: ${JSON.stringify(init)}`);
    }
    await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  const listTools = async () => {
    const frame = await request("tools/list");
    // Wire-equivalent entries: undefined-valued own properties are dropped.
    return JSON.parse(JSON.stringify(frame.result?.tools ?? [])) as Array<Record<string, unknown> & { name: string }>;
  };

  return {
    request,
    listTools,
    listToolNames: async () => (await listTools()).map((tool) => tool.name),
    callTool: (name, args) => request("tools/call", { name, arguments: args }),
    close: () => handle.close()
  };
}
