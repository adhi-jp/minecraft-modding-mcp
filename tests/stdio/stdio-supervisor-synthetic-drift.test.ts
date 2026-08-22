import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";

import { buildWorkerRestartReply } from "../../src/stdio-supervisor.ts";
import { decorateSyntheticReply } from "../../src/synthetic-decorator.ts";
import { SERVER_IDENTITY } from "../../src/server-identity.ts";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

/**
 * Live-SDK structural drift guard.
 *
 * Captures a LIVE SDK-produced modern result (real supervisor + real worker,
 * modern tools/call list-versions) and STRUCTURALLY compares it with the
 * decorator's synthetic structured output for the same method class:
 *  - the modern result-envelope key set the SDK adds beyond the tool payload
 *    (resultType, _meta) must match the decorator's,
 *  - resultType must be "complete" on both,
 *  - the _meta key set must match, and
 *  - the live `_meta[SERVER_INFO_META_KEY]` must deep-equal the canonical
 *    identity module's value (identity unification end-to-end).
 * Drift in the SDK's envelope shape fails this test.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Payload keys owned by the CallToolResult itself, not the modern envelope. */
const CALL_TOOL_PAYLOAD_KEYS = new Set(["content", "structuredContent", "isError"]);

type Frame = Record<string, unknown> & { id?: unknown };

function startSupervisor(root: string): {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  send: (message: object) => void;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  const frames: Frame[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as Frame);
      } catch {
        // Ignore non-JSON stdout noise.
      }
    }
  });

  return {
    child,
    frames,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function envelopeKeys(result: Record<string, unknown>): string[] {
  return Object.keys(result).filter((key) => !CALL_TOOL_PAYLOAD_KEYS.has(key)).sort();
}

test("wire drift guard: a live modern SDK result and the synthetic decorator share the modern envelope shape and the canonical identity", { timeout: 120_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "synthetic-drift-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "list-versions",
      arguments: {}
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 90_000, "live modern tools/call result");
  const live = session.frames.find((frame) => frame.id === 1) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
  assert.equal(live.error, undefined, "the live modern tools/call must produce a RESULT envelope (success or in-band tool error)");
  assert.ok(live.result, "the live modern tools/call must carry a result");
  const liveResult = live.result;

  // Synthetic structured output for the same method class (tools/call),
  // decorated for the modern era.
  const { reply } = buildWorkerRestartReply(
    {
      id: 1,
      method: "tools/call",
      toolName: "list-versions",
      startedAt: 0,
      era: "modern"
    },
    { code: null, signal: "SIGKILL" },
    10,
    []
  );
  const synthetic = decorateSyntheticReply(reply, "modern") as unknown as {
    result?: Record<string, unknown>;
  };
  assert.ok(synthetic.result, "the decorated synthetic reply must carry a result");
  const syntheticResult = synthetic.result;

  // Envelope key set beyond the CallToolResult payload must match exactly.
  assert.deepEqual(
    envelopeKeys(liveResult),
    envelopeKeys(syntheticResult),
    "SDK modern result-envelope drift: the live envelope key set no longer matches the synthetic decoration"
  );
  assert.deepEqual(envelopeKeys(liveResult), ["_meta", "resultType"], "the modern envelope must consist of exactly _meta and resultType");

  assert.equal(liveResult.resultType, "complete", "the live SDK result must carry resultType complete");
  assert.equal(syntheticResult.resultType, "complete", "the synthetic result must carry resultType complete");

  const liveMeta = liveResult._meta as Record<string, unknown>;
  const syntheticMeta = syntheticResult._meta as Record<string, unknown>;
  assert.ok(liveMeta, "the live SDK result must carry _meta");
  assert.ok(syntheticMeta, "the synthetic result must carry _meta");
  assert.deepEqual(
    Object.keys(liveMeta).sort(),
    Object.keys(syntheticMeta).sort(),
    "SDK _meta drift: the live _meta key set no longer matches the synthetic decoration"
  );
  assert.deepEqual(Object.keys(liveMeta), [SERVER_INFO_META_KEY], "the modern _meta must consist of exactly the serverInfo key");

  // Identity unification end-to-end: the SDK stamped the SAME Implementation
  // the canonical module defines.
  assert.deepEqual(
    liveMeta[SERVER_INFO_META_KEY],
    { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version },
    "the live serverInfo identity must deep-equal the canonical identity module's value"
  );
  assert.deepEqual(syntheticMeta[SERVER_INFO_META_KEY], liveMeta[SERVER_INFO_META_KEY]);

  // Cache fields belong only to the cacheable list/read/discover methods and
  // must appear on NEITHER envelope for tools/call.
  for (const [label, result] of [["live", liveResult], ["synthetic", syntheticResult]] as const) {
    assert.equal("ttlMs" in result, false, `${label}: tools/call results must not carry ttlMs`);
    assert.equal("cacheScope" in result, false, `${label}: tools/call results must not carry cacheScope`);
  }

  // Discover-identity closure: the live DiscoverResult reports the SAME
  // canonical identity. On the wire it surfaces in the result's
  // _meta[SERVER_INFO_META_KEY] (the modern encode seam stamps every outbound
  // result); the DiscoverResult body itself carries no serverInfo field —
  // both pinned here.
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "server/discover",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "live modern discover result");
  const discover = session.frames.find((frame) => frame.id === 2) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
  assert.equal(discover.error, undefined, "the modern discover must be served");
  assert.ok(discover.result, "the discover must carry a result");
  const discoverMeta = discover.result._meta as Record<string, unknown> | undefined;
  assert.ok(discoverMeta, "the discover result must carry _meta");
  assert.deepEqual(
    discoverMeta[SERVER_INFO_META_KEY],
    { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version },
    "the discover-reported identity must deep-equal the canonical identity module's value"
  );
  assert.equal("serverInfo" in discover.result, false, "pin the surface: the identity lives in _meta, not in a result body field");
});
