/**
 * In-process dual-era wire harness (helper module, not a test file).
 *
 * Serves the REAL production factory (src/index.ts buildServer) through the
 * REAL SDK stdio entry (`serveStdio`) over an `InMemoryTransport` linked pair,
 * so tests observe genuine era-encoded wire frames (resultType, cache fields,
 * _meta serverInfo stamping, negotiation) without spawning processes and
 * without the supervisor layer. Supervisor-owned paths (era conflicts, queue
 * overflow, restart synthesis) are NOT reachable through this harness — the
 * committed supervisor suites cover those.
 *
 * Callers MUST set MCP_CACHE_DIR / MCP_SQLITE_PATH (and any other env the
 * production module reads, e.g. MCP_VERSION_MANIFEST_URL) BEFORE the first
 * session starts: src/index.ts is imported dynamically inside
 * startInProcessSession(), so module-top env assignments in the test file are
 * honored on first import.
 */
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Minimal valid modern per-request `_meta` envelope (protocol 2026-07-28). */
export const MODERN_META: Readonly<Record<string, unknown>> = Object.freeze({
  [PROTOCOL_VERSION_KEY]: "2026-07-28",
  [CLIENT_CAPABILITIES_KEY]: {}
});

export type Frame = {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
};

export type InProcessSession = {
  /** Every frame the server wrote to the client end, in arrival order. */
  frames: Frame[];
  send(message: object): Promise<void>;
  /** Sends a request frame and resolves with the reply frame carrying its id. */
  request(message: { id: number | string } & object): Promise<Frame>;
  close(): Promise<void>;
};

export async function startInProcessSession(): Promise<InProcessSession> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const frames: Frame[] = [];
  clientEnd.onmessage = (message) => {
    frames.push(message as Frame);
  };
  const { buildServer } = await import("../../src/index.ts");
  const handle = serveStdio(buildServer, { transport: serverEnd, maxSubscriptions: 0 });
  await clientEnd.start();

  const send = (message: object): Promise<void> => clientEnd.send(message as JSONRPCMessage);
  const request = async (message: { id: number | string } & object): Promise<Frame> => {
    await send(message);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const frame = frames.find((candidate) => candidate.id === message.id);
      if (frame !== undefined) return frame;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for in-process reply id ${String(message.id)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    frames,
    send,
    request,
    close: () => handle.close()
  };
}

/**
 * Performs the 2025-era opening on a fresh session: initialize with the given
 * protocolVersion followed by notifications/initialized. Returns the
 * initialize reply frame (negotiation result).
 */
export async function legacyHandshake(
  session: InProcessSession,
  protocolVersion = "2025-06-18",
  id: number | string = "p3-init"
): Promise<Frame> {
  const reply = await session.request({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "p3-inprocess-harness", version: "0.0.0" }
    }
  });
  await session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return reply;
}

/** Parses the single-content JSON envelope of an app resource read. */
export function parseResourceEnvelope(frame: Frame): Record<string, unknown> {
  const contents = frame.result?.contents as Array<{ text?: string }> | undefined;
  const text = contents?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`resource read frame carries no text content: ${JSON.stringify(frame)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
