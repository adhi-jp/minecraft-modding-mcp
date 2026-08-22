import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

/**
 * Client-notification hygiene, both eras:
 *
 *  - $/stageUpdate is a WORKER→SUPERVISOR progress channel: the supervisor
 *    consumes every "$/"-prefixed worker notification as per-request progress
 *    and must never forward one onto the client stream, in either era.
 *  - notifications/message: this server registers NO logging capability and
 *    must never emit an MCP log-message notification — including when a
 *    modern request carries the legitimate optional
 *    "io.modelcontextprotocol/logLevel" _meta key (the supervisor's shallow
 *    era check ignores extra keys, so the request must still succeed).
 *
 * Emission control: the $/stageUpdate-triggering recipe is the inline
 * validate-mixin call from tests/stdio/stdio-worker-protocol.test.ts
 * ("worker emits $/stageUpdate notifications carrying the originating
 * JSON-RPC request id") — re-proven here on a DIRECT worker session under
 * this suite's exact env, so the wire-suppression scans below can never pass
 * vacuously against a recipe that stopped emitting.
 */

// Env for the in-process leg must be set before the harness's first
// src/index.ts import (the wire legs spawn children with their own env).
const inProcessRoot = mkdtempSync(join(tmpdir(), "notif-hygiene-inproc-"));
process.env.MCP_CACHE_DIR = join(inProcessRoot, "cache");
process.env.MCP_SQLITE_PATH = join(inProcessRoot, "cache", "source-cache.db");

import {
  CLIENT_CAPABILITIES_KEY,
  MODERN_META,
  PROTOCOL_VERSION_KEY,
  startInProcessSession
} from "./inprocess-era-serve.ts";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";
import { stopSupervisor } from "../helpers/stdio-child-lifecycle.ts";

// inprocess-era-serve.ts exports no logLevel key, so this literal stays local.
const LOG_LEVEL_KEY = "io.modelcontextprotocol/logLevel";

type Frame = Record<string, unknown> & { id?: unknown; method?: unknown };

/**
 * Scan predicate shared by every absence assertion in this file. Each test
 * self-checks it against a crafted frame carrying the forbidden method, so a
 * broken predicate can never make the zero-count assertions pass vacuously.
 */
function framesWithMethod(frames: Frame[], method: string): Frame[] {
  return frames.filter((frame) => frame.method === method);
}

/**
 * The stage-emitting recipe from tests/stdio/stdio-worker-protocol.test.ts:
 * validate-mixin enters its first pipeline stage ("resolve") before any heavy
 * work, so a $/stageUpdate is emitted before version resolution fails fast
 * against this suite's local empty version manifest.
 */
const VALIDATE_MIXIN_ARGUMENTS = {
  input: {
    mode: "inline",
    source: "@Mixin(net.minecraft.server.MinecraftServer.class)\nclass M {}"
  },
  version: "1.21.10"
};

let manifestServer: Server;
let manifestUrl: string;

before(async () => {
  // Local deterministic Mojang-manifest stand-in: version "1.21.10" is absent,
  // so the validate-mixin call fails fast and offline AFTER entering its
  // first stage (stage entry precedes resolution work).
  manifestServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latest: { release: "1.99.9", snapshot: "1.99.9" }, versions: [] }));
  });
  await new Promise<void>((resolve) => manifestServer.listen(0, "127.0.0.1", resolve));
  const address = manifestServer.address() as { port: number };
  manifestUrl = `http://127.0.0.1:${address.port}/version_manifest_v2.json`;
});

after(async () => {
  await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
});

type ChildSession = {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  stderr: () => string;
  send: (message: object) => void;
};

function startChildSession(root: string, extraEnv: Record<string, string>): ChildSession {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db"),
      // Stage progress must be ON for the $/stageUpdate recipe (mirrors
      // tests/stdio/stdio-worker-protocol.test.ts).
      MIXIN_STAGE_PROGRESS_OFF: "",
      MCP_VERSION_MANIFEST_URL: manifestUrl,
      ...extraEnv
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

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  return {
    child,
    frames,
    stderr: () => stderrBuffer,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  };
}

function startWireSupervisor(root: string): ChildSession {
  return startChildSession(root, { MCP_SUPERVISOR_DEBUG: "1" });
}

function startDirectWorker(root: string): ChildSession {
  return startChildSession(root, { MCP_STDIO_WORKER_MODE: "1" });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("direct worker emits $/stageUpdate for the inline validate-mixin recipe (emission control for the suppression guards below)", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "notif-hygiene-worker-"));
  const worker = startDirectWorker(root);
  t.after(async () => {
    await stopSupervisor(worker.child, { leafProcess: true });
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => worker.stderr().includes("__MCP_STDIO_WORKER_READY__"), 30_000, "worker READY marker");

  worker.send({
    jsonrpc: "2.0",
    id: 10,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "notif-hygiene-test", version: "1.0.0" }
    }
  });
  await waitFor(() => worker.frames.some((frame) => frame.id === 10), 15_000, "initialize reply");
  worker.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  worker.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "validate-mixin", arguments: VALIDATE_MIXIN_ARGUMENTS }
  });
  await waitFor(
    () => framesWithMethod(worker.frames, "$/stageUpdate").length > 0 && worker.frames.some((frame) => frame.id === 11),
    60_000,
    "$/stageUpdate frame and tools/call reply"
  );

  // The recipe REALLY emits on a bare worker under this suite's env — the
  // scan predicate flags the live frame, so the supervisor-side zero-count
  // scans below cannot pass because emission silently stopped.
  const stageFrames = framesWithMethod(worker.frames, "$/stageUpdate");
  assert.ok(stageFrames.length > 0, "the direct worker must emit $/stageUpdate for the recipe");
  const stage = stageFrames[0] as { params?: { requestId?: unknown } };
  assert.equal(stage?.params?.requestId, 11, "the stage frame carries the originating request id");
});

test("legacy wire: $/stageUpdate never reaches the supervisor's client stream and notifications/message is never emitted", { timeout: 150_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "notif-hygiene-legacy-"));
  const session = startWireSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => session.stderr().includes("supervisor.debug.worker_ready"), 90_000, "supervisor worker_ready adoption");

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "notif-hygiene-test", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 30_000, "initialize reply");
  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "validate-mixin", arguments: VALIDATE_MIXIN_ARGUMENTS }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 60_000, "validate-mixin reply");

  // Positive control (same channel): the triggering request's reply is in the
  // scanned frames array.
  assert.ok(session.frames.some((frame) => frame.id === 2), "the client stream must carry the tools/call reply");
  // In-session emission proof: the debug log shows the worker DID send a
  // $/stageUpdate to the supervisor during this very session. The stderr
  // pipe is not ordered against the stdout reply, so poll (bounded) instead
  // of asserting immediately after the reply arrived.
  await waitFor(
    () => session.stderr().includes("$/stageUpdate"),
    15_000,
    "the supervisor debug log to show the worker's $/stageUpdate arriving"
  );

  // Predicate self-check: the scan flags a crafted frame carrying each
  // forbidden method, so the zero-count assertions below are falsifiable.
  assert.equal(framesWithMethod([{ method: "$/stageUpdate" }], "$/stageUpdate").length, 1);
  assert.equal(framesWithMethod([{ method: "notifications/message" }], "notifications/message").length, 1);

  assert.equal(
    framesWithMethod(session.frames, "$/stageUpdate").length,
    0,
    "$/stageUpdate must never reach the client stream"
  );
  assert.equal(
    framesWithMethod(session.frames, "notifications/message").length,
    0,
    "this server registers no logging capability and must never emit notifications/message"
  );
});

test("modern wire: $/stageUpdate never reaches the supervisor's client stream and notifications/message is never emitted", { timeout: 150_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "notif-hygiene-modern-"));
  const session = startWireSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => session.stderr().includes("supervisor.debug.worker_ready"), 90_000, "supervisor worker_ready adoption");

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "validate-mixin",
      arguments: VALIDATE_MIXIN_ARGUMENTS
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "modern validate-mixin reply");

  // Positive control + in-session emission proof, as on the legacy leg
  // (bounded stderr poll: cross-pipe ordering is not guaranteed).
  assert.ok(session.frames.some((frame) => frame.id === 1), "the client stream must carry the tools/call reply");
  await waitFor(
    () => session.stderr().includes("$/stageUpdate"),
    15_000,
    "the supervisor debug log to show the worker's $/stageUpdate arriving"
  );

  // Predicate self-check (falsifiability of the zero-count scans).
  assert.equal(framesWithMethod([{ method: "$/stageUpdate" }], "$/stageUpdate").length, 1);
  assert.equal(framesWithMethod([{ method: "notifications/message" }], "notifications/message").length, 1);

  assert.equal(
    framesWithMethod(session.frames, "$/stageUpdate").length,
    0,
    "$/stageUpdate must never reach the client stream on the modern era"
  );
  assert.equal(
    framesWithMethod(session.frames, "notifications/message").length,
    0,
    "this server registers no logging capability and must never emit notifications/message"
  );
});

test("in-process modern: the optional io.modelcontextprotocol/logLevel _meta key still succeeds and no notifications/message is ever emitted", async (t) => {
  const session = await startInProcessSession();
  t.after(async () => {
    await session.close();
  });

  const reply = await session.request({
    jsonrpc: "2.0",
    id: "loglevel-1",
    method: "tools/list",
    params: { _meta: { ...MODERN_META, [LOG_LEVEL_KEY]: "debug" } }
  });

  // The shallow era check ignores extra reserved keys: the logLevel-carrying
  // request must be SERVED, not rejected.
  assert.equal(reply.error, undefined, "a logLevel-carrying modern request must succeed");
  assert.ok(Array.isArray(reply.result?.tools), "the tools/list result must be served normally");

  // Positive control (same channel): the reply frame is in the scanned array.
  assert.ok(
    session.frames.some((frame) => frame.id === "loglevel-1"),
    "the session frame log must carry the triggering reply"
  );
  // Predicate self-check (falsifiability of the zero-count scan).
  assert.equal(framesWithMethod([{ method: "notifications/message" }], "notifications/message").length, 1);

  assert.equal(
    framesWithMethod(session.frames as Frame[], "notifications/message").length,
    0,
    "no notifications/message may be emitted (no logging capability is registered)"
  );
});
