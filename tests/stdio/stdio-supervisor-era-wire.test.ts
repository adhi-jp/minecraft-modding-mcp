import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeJsonRpcMessage } from "../../src/json-rpc-framing.ts";

/**
 * Wire-level era test against the REAL supervisor + REAL worker:
 * spawn `node --import tsx src/cli.ts` WITHOUT MCP_STDIO_WORKER_MODE, so the
 * production supervisor runs and spawns the production SDK worker (the child
 * inherits `--import tsx` through process.execArgv).
 *
 * Pins the unsupported-modern-version passthrough: a shallow-VALID modern
 * request whose protocolVersion value is unsupported still LOCKS the modern
 * era at supervisor admission (shallow validity is the era signal; deep value
 * validation belongs to the worker), and the worker's -32022 reply reaches
 * the client unaltered.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

const ERA_SUPPORTED_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
  "2026-07-28"
];

const ERA_CONFLICT_MODERN_MESSAGE =
  "initialize rejected: this server process is era-locked to protocol revision 2026-07-28 (modern per-request _meta era), so the legacy initialize handshake can no longer be accepted. Supported protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (legacy initialize handshake) and 2026-07-28 (modern per-request _meta). To use the legacy handshake, start a fresh process: close this transport, terminate and respawn the configured server command as a fresh stdio process, discard or re-issue any pending request ids, then send initialize followed by notifications/initialized.";

const ERA_CONFLICT_LEGACY_MESSAGE =
  "Modern per-request _meta request rejected: this server process is era-locked to the legacy initialize handshake, so requests carrying the modern per-request _meta envelope can no longer be accepted. Supported protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (legacy initialize handshake) and 2026-07-28 (modern per-request _meta). To use the modern era, start a fresh process: close this transport, terminate and respawn the configured server command as a fresh stdio process, discard or re-issue any pending request ids, then send a request carrying the required io.modelcontextprotocol/* _meta envelope.";

type Frame = Record<string, unknown> & { id?: unknown };

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

function startSupervisor(root: string): {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  workerReady: () => boolean;
  send: (message: object) => void;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Debug logs expose the supervisor's worker_ready adoption on stderr so
      // wire tests can sequence sends deterministically around readiness.
      MCP_SUPERVISOR_DEBUG: "1",
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

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  return {
    child,
    frames,
    workerReady: () => stderrBuffer.includes("supervisor.debug.worker_ready"),
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

test("wire: unsupported modern protocol version locks modern and the worker's -32022 passes through to the client", { timeout: 90_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  // Shallow-valid modern envelope with an UNSUPPORTED version value: locks
  // modern at supervisor admission; the worker performs the deep value check
  // and answers -32022 with the supported/requested detail.
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2027-01-01", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "list-versions",
      arguments: {}
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "-32022 reply for id 1");
  const unsupported = session.frames.find((frame) => frame.id === 1) as { error?: unknown };
  assert.deepEqual(unsupported.error, {
    code: -32022,
    message: "Unsupported protocol version: 2027-01-01",
    data: {
      supported: ["2026-07-28"],
      requested: "2027-01-01"
    }
  });

  // The shallow-valid claim locked modern even though its value failed at the
  // worker: a legacy initialize now gets the supervisor's era_conflict.
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-wire-test", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 15_000, "era_conflict reply for id 2");
  const conflict = session.frames.find((frame) => frame.id === 2) as { error?: unknown };
  assert.deepEqual(conflict.error, {
    code: -32601,
    message: ERA_CONFLICT_MODERN_MESSAGE,
    data: {
      kind: "era_conflict",
      selectedEra: "modern",
      requestedEra: "legacy",
      supported: ERA_SUPPORTED_VERSIONS
    }
  });
});

test("wire: ready-first pipelined modern discover and legacy initialize on one process serve a DiscoverResult, negotiate legacy, and end era-locked legacy", { timeout: 90_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  // Wait for worker adoption, then pipeline BOTH frames back-to-back without
  // awaiting the discover reply: the SDK builds a probe instance for the
  // modern discover, the following legacy initialize discards it and re-pins
  // legacy — and BOTH must still be answered by their own ids.
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-wire-test", version: "1.0.0" }
    }
  });

  await waitFor(
    () => session.frames.some((frame) => frame.id === 1) && session.frames.some((frame) => frame.id === 2),
    30_000,
    "discover and initialize replies"
  );
  const discover = session.frames.find((frame) => frame.id === 1) as {
    result?: { supportedVersions?: unknown };
    error?: unknown;
  };
  assert.equal(discover.error, undefined, "the pipelined discover must be served, not rejected");
  assert.deepEqual(discover.result?.supportedVersions, ["2026-07-28"]);
  const initialize = session.frames.find((frame) => frame.id === 2) as {
    result?: { protocolVersion?: unknown };
    error?: unknown;
  };
  assert.equal(initialize.error, undefined, "the pipelined initialize must negotiate normally after the probe discard");
  assert.equal(initialize.result?.protocolVersion, "2025-06-18");

  // The discover did not lock modern: the supervisor era ended legacy.
  session.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "list-versions",
      arguments: {}
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 3), 15_000, "era_conflict reply for id 3");
  const conflict = session.frames.find((frame) => frame.id === 3) as { error?: unknown };
  assert.deepEqual(conflict.error, {
    code: -32600,
    message: ERA_CONFLICT_LEGACY_MESSAGE,
    data: {
      kind: "era_conflict",
      selectedEra: "legacy",
      requestedEra: "modern",
      supported: ERA_SUPPORTED_VERSIONS
    }
  });
});

test("wire: worker-down modern discover queues, releases to a DiscoverResult, and a legacy initialize then locks legacy", { timeout: 90_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  // Sent immediately after spawn: the worker is still starting, so the
  // era-neutral discover queues and must release on readiness as the worker
  // connection's first frame (probe instance → DiscoverResult).
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "queued discover release");
  const discover = session.frames.find((frame) => frame.id === 1) as {
    result?: { supportedVersions?: unknown };
    error?: unknown;
  };
  assert.equal(discover.error, undefined);
  assert.deepEqual(discover.result?.supportedVersions, ["2026-07-28"]);

  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-wire-test", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 15_000, "initialize reply");
  const initialize = session.frames.find((frame) => frame.id === 2) as {
    result?: { protocolVersion?: unknown };
    error?: unknown;
  };
  assert.equal(initialize.error, undefined, "the released discover must not have locked modern");
  assert.equal(initialize.result?.protocolVersion, "2025-06-18");

  session.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "list-versions",
      arguments: {}
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 3), 15_000, "era_conflict reply for id 3");
  const conflict = session.frames.find((frame) => frame.id === 3) as {
    error?: { code?: number; data?: { kind?: string; selectedEra?: string } };
  };
  assert.equal(conflict.error?.code, -32600);
  assert.equal(conflict.error?.data?.kind, "era_conflict");
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("wire: a Content-Length-framed claim-less request is rejected -32602 in Content-Length framing", { timeout: 30_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  // The rejection is supervisor-produced (no worker involved), so the light
  // fixture runtime is enough; what matters is that the reply uses the
  // ORIGINATING frame's Content-Length framing, not a hard-coded newline.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/stdio-supervisor-timeout-worker.runtime.ts"],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] }
  );
  t.after(() => child.kill("SIGKILL"));
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });

  child.stdin.write(
    encodeJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list-versions", arguments: {} }
      } as never,
      "content-length"
    )
  );

  const frameComplete = (): boolean => {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return false;
    const match = /content-length:\s*([0-9]+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
    if (!match) return false;
    return buffer.length >= headerEnd + 4 + Number(match[1]);
  };
  await waitFor(() => buffer.length > 0 && (buffer[0] !== 0x7b ? frameComplete() : true), 15_000, "-32602 reply frame");

  assert.notEqual(buffer[0], 0x7b, "the rejection must not be newline-framed JSON");
  const headerEnd = buffer.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1, "the rejection must carry a Content-Length header block");
  const lengthMatch = /content-length:\s*([0-9]+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
  assert.ok(lengthMatch, "the header block must declare Content-Length");
  const body = JSON.parse(
    buffer.subarray(headerEnd + 4, headerEnd + 4 + Number(lengthMatch[1])).toString("utf8")
  ) as { id?: unknown; error?: { code?: number; data?: { kind?: string } } };
  assert.equal(body.id, 1);
  assert.equal(body.error?.code, -32602);
  assert.equal(body.error?.data?.kind, "missing_meta");
});
