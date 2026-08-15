/**
 * Smoke tests for compact mode response sizes.
 *
 * These tests require network access (live artifact resolution).
 * NOT included in `npm test` — run manually:
 *
 *   node --test --import tsx tests/smoke/compact-size.smoke.ts
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-smoke-cache");

/**
 * Live artifact resolution can legitimately take minutes on a cold cache, so
 * tool replies are polled from the session frame log directly with a generous
 * deadline instead of going through session.request()'s 30s deadline.
 */
const LIVE_REPLY_DEADLINE_MS = 600_000;

let sessionPromise: Promise<InProcessSession> | undefined;
let nextRequestId = 0;

async function smokeSession(): Promise<InProcessSession> {
  sessionPromise ??= (async () => {
    const session = await startInProcessSession();
    const handshake = await legacyHandshake(session, undefined, "smoke-init");
    if (handshake.error !== undefined || handshake.result === undefined) {
      // Surface the root cause here instead of deferring it to a later
      // tool-call error or timeout on the cached session.
      throw new Error(`compact-size smoke: legacy handshake failed: ${JSON.stringify(handshake)}`);
    }
    return session;
  })();
  return sessionPromise;
}

after(async () => {
  if (sessionPromise !== undefined) {
    await (await sessionPromise).close();
  }
});

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const session = await smokeSession();
  nextRequestId += 1;
  const id = `smoke-${nextRequestId}`;
  await session.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const deadline = Date.now() + LIVE_REPLY_DEADLINE_MS;
  for (;;) {
    const frame = session.frames.find((candidate) => candidate.id === id);
    if (frame !== undefined) {
      if (frame.error !== undefined) {
        throw new Error(
          `unexpected JSON-RPC error frame for tools/call ${name}: ` +
            `code ${String(frame.error.code)}: ${String(frame.error.message)}`
        );
      }
      return frame.result;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for live tools/call reply id ${id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function responseBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify(result.structuredContent ?? {}), "utf8");
}

// ---------------------------------------------------------------------------
// resolve-artifact: compact vs full size bound
// ---------------------------------------------------------------------------

test("resolve-artifact compact response is bounded (live)", async () => {
  const result = await callTool("resolve-artifact", {
    target: { kind: "version", value: "1.21.4" },
    mapping: "mojang",
    detail: "summary"
  }) as ToolResult;

  assert.notEqual(result.isError, true, "resolve-artifact should not error");
  assert.ok(result.structuredContent, "expected structuredContent in response");
  const bytes = responseBytes(result);
  assert.ok(bytes < 1000, `resolve-artifact compact too large: ${bytes} bytes`);
});

test("resolve-artifact compact is significantly smaller than full (live)", async () => {
  const [compact, full] = await Promise.all([
    callTool("resolve-artifact", {
      target: { kind: "version", value: "1.21.4" },
      mapping: "mojang",
      detail: "summary"
    }) as Promise<ToolResult>,
    callTool("resolve-artifact", {
      target: { kind: "version", value: "1.21.4" },
      mapping: "mojang",
      detail: "full"
    }) as Promise<ToolResult>
  ]);

  assert.notEqual(compact.isError, true);
  assert.notEqual(full.isError, true);
  assert.ok(compact.structuredContent, "expected structuredContent in compact response");
  assert.ok(full.structuredContent, "expected structuredContent in full response");

  const compactBytes = responseBytes(compact);
  const fullBytes = responseBytes(full);
  assert.ok(
    compactBytes < fullBytes * 0.6,
    `compact (${compactBytes}B) should be < 60% of full (${fullBytes}B)`
  );
});

// ---------------------------------------------------------------------------
// find-mapping: compact vs full size bound
// ---------------------------------------------------------------------------

test("find-mapping compact omits candidates for resolved identity match (live)", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.4",
    kind: "class",
    name: "net.minecraft.world.level.Level",
    sourceMapping: "mojang",
    targetMapping: "mojang",
    detail: "summary"
  }) as ToolResult;

  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent, "expected structuredContent in response");
  const res = (result.structuredContent as { result?: Record<string, unknown> })?.result;
  assert.ok(res);
  assert.equal(res.resolved, true);
  assert.equal("candidates" in res, false, "compact must omit candidates for exact identity match");
  assert.ok("candidateCount" in res);
});
