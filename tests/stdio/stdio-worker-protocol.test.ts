import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Worker-level protocol tests: spawn the REAL worker directly
 * (MCP_STDIO_WORKER_MODE=1, no supervisor) and speak newline-delimited
 * JSON-RPC on its stdio.
 *
 * - serveStdio calls its factory PER INSTANCE: a modern `server/discover`
 *   opening builds a probe instance that a following legacy `initialize`
 *   discards and replaces via a SECOND factory call. The probe path mutates
 *   its instance (modern-only handlers + "2026-07-28" support), so a factory
 *   returning a module singleton leaks those mutations onto the re-pinned
 *   legacy instance (observed against the pre-fix singleton: the legacy
 *   initialize answered -32601 Method not found). The regression test pins
 *   the negotiate-down contract end to end.
 * - $/stageUpdate: the worker must emit stage-progress NOTIFICATIONS (no id)
 *   carrying the originating request's JSON-RPC id in params.requestId; the
 *   supervisor consumes them as per-request progress.
 */

type Frame = Record<string, unknown> & { id?: unknown; method?: unknown };

const ENVELOPE_PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const ENVELOPE_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

async function canUseNativeStdioPipes(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(42));setTimeout(()=>process.exit(0),150);"],
      { stdio: ["pipe", "ignore", "ignore"] }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

function startWorker(root: string): {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  ready: () => boolean;
  send: (message: object) => void;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_STDIO_WORKER_MODE: "1",
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db"),
      // Stage progress must be ON for the $/stageUpdate assertion.
      MIXIN_STAGE_PROGRESS_OFF: ""
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

  let workerReady = false;
  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.includes("__MCP_STDIO_WORKER_READY__")) workerReady = true;
  });

  return {
    child,
    frames,
    ready: () => workerReady,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("worker builds a fresh server per serveStdio instance: legacy initialize after a modern server/discover negotiates down", { timeout: 60_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "worker-protocol-r5-"));
  const worker = startWorker(root);
  t.after(async () => {
    worker.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(worker.ready, 30_000, "worker READY marker");

  // Modern-enveloped server/discover: serveStdio builds a PROBE instance.
  worker.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        [ENVELOPE_PROTOCOL_KEY]: "2026-07-28",
        [ENVELOPE_CAPABILITIES_KEY]: {}
      }
    }
  });
  await waitFor(() => worker.frames.some((f) => f.id === 1), 15_000, "server/discover reply");
  const discover = worker.frames.find((f) => f.id === 1) as { result?: { supportedVersions?: unknown } };
  assert.ok(discover.result, "server/discover must succeed on the probe instance");
  assert.deepEqual(discover.result?.supportedVersions, ["2026-07-28"]);

  // Legacy-SHAPED initialize claiming the modern revision: the probe is
  // discarded, the factory is called again, and the FRESH legacy instance
  // must negotiate DOWN to its latest legacy revision — probe mutations
  // (modern-only handlers, "2026-07-28" support) must not leak.
  worker.send({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "worker-protocol-test", version: "1.0.0" }
    }
  });
  await waitFor(() => worker.frames.some((f) => f.id === 2), 15_000, "initialize reply");
  const initialize = worker.frames.find((f) => f.id === 2) as {
    result?: { protocolVersion?: unknown };
    error?: unknown;
  };
  assert.equal(initialize.error, undefined, "legacy initialize must not error after a probe discard");
  assert.equal(initialize.result?.protocolVersion, "2025-11-25");
});

test("worker emits $/stageUpdate notifications carrying the originating JSON-RPC request id", { timeout: 90_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "worker-protocol-r8-"));
  const worker = startWorker(root);
  t.after(async () => {
    worker.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(worker.ready, 30_000, "worker READY marker");

  worker.send({
    jsonrpc: "2.0",
    id: 10,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "worker-protocol-test", version: "1.0.0" }
    }
  });
  await waitFor(() => worker.frames.some((f) => f.id === 10), 15_000, "initialize reply");
  worker.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // validate-mixin's pipeline enters its first stage ("resolve") before any
  // heavy work, so the first $/stageUpdate arrives long before the reply.
  worker.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "validate-mixin",
      arguments: {
        input: { mode: "inline", source: "@Mixin(net.minecraft.server.MinecraftServer.class)\nclass M {}" },
        version: "1.21.10"
      }
    }
  });

  await waitFor(
    () => worker.frames.some((f) => f.method === "$/stageUpdate"),
    60_000,
    "$/stageUpdate frame"
  );
  const stageFrame = worker.frames.find((f) => f.method === "$/stageUpdate") as {
    jsonrpc?: unknown;
    params?: { stage?: unknown; requestId?: unknown };
  } & Frame;
  assert.equal(stageFrame.jsonrpc, "2.0");
  // A notification must carry NO id — a stage frame with an id could be
  // mistaken for a response by strict clients.
  assert.equal("id" in stageFrame, false, "$/stageUpdate must be a notification (no id)");
  assert.equal(typeof stageFrame.params?.stage, "string");
  assert.equal(
    stageFrame.params?.requestId,
    11,
    "$/stageUpdate params.requestId must be the originating request's JSON-RPC id"
  );
});
