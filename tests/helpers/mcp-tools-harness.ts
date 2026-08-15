/**
 * Shared MCP wire harness for the mcp-tools integration test slices.
 * Factored out of tests/mcp-tools.integration.test.ts when that file was split
 * into per-feature slices. The module-level MCP_CACHE_DIR assignment MUST run
 * before ../../src/index.ts is first imported, so it lives at the top of this
 * shared module and every split file inherits it transitively via import.
 *
 * The harness drives the REAL production factory through the public
 * in-process transport (tests/stdio/inprocess-era-serve.ts): one lazily
 * started legacy-era session per process, shared by every split file. Node's
 * test runner executes each test file in its own process, so the shared
 * session never crosses file boundaries. src/index.ts is imported dynamically
 * inside the first listTools()/callTool() call, which is why per-file env
 * assignments (MCP_CACHE_DIR, MCP_LOCAL_M2, ...) made at test-module top
 * still take effect.
 *
 * The session is intentionally never closed: the in-process transport holds
 * no OS handles or timers, so the test process exits cleanly on its own
 * (verified empirically; the spawned-subprocess call sites rely on this).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-tools-integration-cache");

export type ToolSchema = {
  name: string;
  inputSchema: Record<string, unknown>;
};

let sessionPromise: Promise<InProcessSession> | undefined;
let nextRequestId = 0;

async function sharedSession(): Promise<InProcessSession> {
  sessionPromise ??= (async () => {
    const session = await startInProcessSession();
    const handshake = await legacyHandshake(session, undefined, "mcp-tools-harness-init");
    // Every split file shares this one session: a silently failed handshake
    // would poison all of them with confusing downstream errors, so fail
    // loudly here with the offending frame.
    if (handshake.error !== undefined || handshake.result === undefined) {
      throw new Error(
        "mcp-tools-harness: shared legacy handshake failed — expected a successful initialize " +
          "result negotiating the default legacy protocolVersion 2025-06-18, got frame: " +
          JSON.stringify(handshake)
      );
    }
    return session;
  })();
  return sessionPromise;
}

async function requestResult(
  method: "tools/list" | "tools/call",
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const session = await sharedSession();
  nextRequestId += 1;
  const frame = await session.request({
    jsonrpc: "2.0",
    id: `mcp-tools-harness-${nextRequestId}`,
    method,
    params
  });
  if (frame.error !== undefined) {
    throw new Error(
      `unexpected JSON-RPC error frame for ${method}: ` +
        `code ${String(frame.error.code)}: ${String(frame.error.message)}`
    );
  }
  if (frame.result === undefined) {
    throw new Error(`JSON-RPC reply frame for ${method} carries no result`);
  }
  return frame.result;
}

export async function listTools(): Promise<ToolSchema[]> {
  const result = await requestResult("tools/list", {});
  return result.tools as ToolSchema[];
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return requestResult("tools/call", { name, arguments: args });
}
