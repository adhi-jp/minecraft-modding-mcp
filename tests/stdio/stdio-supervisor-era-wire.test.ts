import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeJsonRpcMessage } from "../../src/json-rpc-framing.ts";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";
import { stopSupervisor } from "../helpers/stdio-child-lifecycle.ts";

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

test("wire: unsupported modern protocol version locks modern and -32022 reaches the client on the FIRST request", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });

  // Shallow-valid modern envelope with an UNSUPPORTED version value: the
  // shallow claim locks modern at admission, and the deep value check then
  // answers -32022 with the supported/requested detail. (The value check used
  // to belong to the worker, where the SDK applies it only while the
  // connection is still opening — see the per-request test below.)
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

test("wire: two concurrent modern requests with different unsupported versions each get their own -32022 requested value", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });

  // Public-transport guard for per-request protocol-context carriage: two
  // modern requests pipelined back-to-back with DIFFERENT unsupported
  // versions must each be answered with their OWN data.requested — a
  // last-seen-global version carrier would collapse both onto one value.
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");
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
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2028-02-02", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "list-versions",
      arguments: {}
    }
  });

  await waitFor(
    () => session.frames.some((frame) => frame.id === 1) && session.frames.some((frame) => frame.id === 2),
    60_000,
    "-32022 replies for ids 1 and 2"
  );
  const first = session.frames.find((frame) => frame.id === 1) as { error?: unknown };
  assert.deepEqual(first.error, {
    code: -32022,
    message: "Unsupported protocol version: 2027-01-01",
    data: { supported: ["2026-07-28"], requested: "2027-01-01" }
  });
  const second = session.frames.find((frame) => frame.id === 2) as { error?: unknown };
  assert.deepEqual(second.error, {
    code: -32022,
    message: "Unsupported protocol version: 2028-02-02",
    data: { supported: ["2026-07-28"], requested: "2028-02-02" }
  });
});

test("wire: ready-first pipelined modern discover and legacy initialize on one process serve a DiscoverResult, negotiate legacy, and end era-locked legacy", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
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
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
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

test("wire: after a modern lock, a deep-invalid clientInfo _meta value forwards to the worker and answers the SDK's bare -32602", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // Modern lock via a fully VALID modern request (tools/list is served and
  // pins the worker's SDK connection to the modern era).
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 30_000, "valid modern tools/list reply");
  const locked = session.frames.find((frame) => frame.id === 1) as { result?: unknown; error?: unknown };
  assert.equal(locked.error, undefined, "the locking request must be VALID and served");
  assert.ok(locked.result, "the locking tools/list must answer a result");

  // Deep value violation behind a shallow-VALID claim: the supervisor
  // admission gate checks only protocolVersion (string) + clientCapabilities
  // (object) — "io.modelcontextprotocol/clientInfo" is not part of the
  // shallow check, so `clientInfo: 42` FORWARDS to the worker, whose SDK
  // validates the full envelope and rejects it -32602.
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {
      _meta: {
        [PROTOCOL_VERSION_KEY]: "2026-07-28",
        [CLIENT_CAPABILITIES_KEY]: {},
        "io.modelcontextprotocol/clientInfo": 42
      }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "-32602 reply for id 2");
  const rejected = session.frames.find((frame) => frame.id === 2) as {
    result?: unknown;
    error?: Record<string, unknown>;
  };

  // PINS the previously-extrapolated SDK pinned-path envelope shape the
  // integrator docs describe: a bare JSON-RPC -32602 with the SDK's
  // "Invalid _meta envelope …" message and NO `data` field — observed live
  // here, discriminating it from every supervisor-built rejection (those
  // always carry `data.kind`, e.g. missing_meta / era_conflict).
  assert.equal(rejected.result, undefined, "the deep violation must answer an error, not a result");
  assert.deepEqual(rejected.error, {
    code: -32602,
    message:
      "Invalid _meta envelope for protocol revision 2026-07-28: Invalid input: expected object, received number"
  });
  assert.equal(
    "data" in (rejected.error ?? {}),
    false,
    "the SDK pinned-path rejection carries NO data field (a supervisor data.kind rejection would)"
  );
});

test("wire: a Content-Length-framed claim-less request is rejected -32602 in Content-Length framing", { timeout: 30_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
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
  t.after(() => stopSupervisor(child));
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

test("wire: initialize carrying a valid modern _meta envelope still completes the LEGACY handshake", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });

  // A hybrid client attaches a VALID modern era claim to a legacy initialize.
  // The supervisor's admission rule is "initialize is the legacy era signal;
  // the envelope is ignored" — and the SDK's opening classifier would treat
  // the claim-bearing initialize as MODERN, so the supervisor must strip the
  // era-claim keys before the frame reaches the worker. The observable
  // contract: the handshake COMPLETES as legacy (v1 ignored unknown _meta).
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-wire-hybrid", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "initialize reply for id 1");
  const reply = session.frames.find((frame) => frame.id === 1) as {
    result?: { protocolVersion?: unknown };
    error?: unknown;
  };
  assert.equal(reply.error, undefined, "the enveloped initialize must negotiate, not error");
  assert.equal(reply.result?.protocolVersion, "2025-06-18", "the legacy body version must be echoed");

  // The process is legacy-locked and SERVES: initialized + tools/list work.
  session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "tools/list reply for id 2");
  const list = session.frames.find((frame) => frame.id === 2) as {
    result?: { tools?: unknown };
    error?: unknown;
  };
  assert.equal(list.error, undefined, "tools/list must be served on the legacy-locked process");
  assert.ok(Array.isArray(list.result?.tools), "tools/list must carry a tools array");
});

test("wire: a malformed initialize is rejected -32602 WITHOUT burning the one-way era lock, and the modern era is still reachable", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // Generically valid JSON-RPC, but missing EVERY required MCP initialize
  // field. The pre-repair supervisor committed the one-way legacy lock on the
  // method name alone, before any schema check: the worker then failed the
  // handshake, the client was told "MCP worker restarted ... Retry the
  // request" (a transient-sounding -32603), and the process was legacy-locked
  // for its whole life even though NO valid era opening had ever completed.
  session.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 30_000, "rejection reply for the malformed initialize");
  const rejection = session.frames.find((frame) => frame.id === 1) as {
    error?: { code?: number; message?: string; data?: Record<string, unknown> };
  };
  assert.equal(rejection.error?.code, -32602, "a malformed initialize is a params error, not a worker restart");
  assert.equal(rejection.error?.data?.kind, "invalid_initialize");
  assert.deepEqual(rejection.error?.data?.required, ["protocolVersion", "capabilities", "clientInfo"]);
  assert.equal(rejection.error?.data?.eraSelected, false, "the rejection states that no era was selected");
  assert.doesNotMatch(
    rejection.error?.message ?? "",
    /worker restarted/i,
    "the client must not be told a schema violation was a transient worker failure"
  );

  // The era is still UNSELECTED, so the modern era remains reachable — the
  // exact recovery the pre-repair build made impossible.
  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "modern tools/list reply for id 2");
  const list = session.frames.find((frame) => frame.id === 2) as {
    result?: { tools?: unknown };
    error?: { code?: number; data?: unknown };
  };
  assert.equal(list.error, undefined, `the modern era must still be selectable, got ${JSON.stringify(list.error)}`);
  assert.ok(Array.isArray(list.result?.tools), "the modern tools/list must be served");
});

test("wire: after a malformed initialize the legacy handshake still succeeds on a retry", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // The other half of "the era was not burned": retrying the SAME era with a
  // well-formed frame works. The pre-repair build answered the first frame
  // with retry advice it could not honor — the worker had been restarted and
  // the legacy lock kept, so a corrected initialize raced a replayed handshake
  // instead of negotiating cleanly.
  session.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 30_000, "rejection for the partial initialize");
  const rejection = session.frames.find((frame) => frame.id === 1) as { error?: { code?: number } };
  assert.equal(rejection.error?.code, -32602, "a partial initialize (no capabilities/clientInfo) is rejected too");

  session.send({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-wire-retry", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "initialize reply for the corrected frame");
  const initialize = session.frames.find((frame) => frame.id === 2) as {
    result?: { protocolVersion?: unknown };
    error?: unknown;
  };
  assert.equal(initialize.error, undefined, "the corrected initialize must negotiate");
  assert.equal(initialize.result?.protocolVersion, "2025-06-18");

  session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  session.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  await waitFor(() => session.frames.some((frame) => frame.id === 3), 30_000, "tools/list reply for id 3");
  const list = session.frames.find((frame) => frame.id === 3) as { result?: { tools?: unknown }; error?: unknown };
  assert.equal(list.error, undefined, "the legacy-locked process must serve after the retry");
  assert.ok(Array.isArray(list.result?.tools));
});

test("wire: an unsupported modern protocolVersion is rejected -32022 on EVERY request, not only the one that opened the connection", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  const badMeta = { [PROTOCOL_VERSION_KEY]: "1999-12-31", [CLIENT_CAPABILITIES_KEY]: {} };
  const goodMeta = { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };
  const errorFor = (id: number): { code?: number; message?: string; data?: unknown } | undefined =>
    (session.frames.find((frame) => frame.id === id) as { error?: { code?: number; message?: string; data?: unknown } } | undefined)?.error;

  // A VALID request first, so the worker connection is pinned. The SDK
  // re-reads the envelope only while the connection is opening; once pinned it
  // delivers straight to the instance. Everything after this point used to be
  // served with any version string at all.
  session.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: goodMeta } });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "tools/list reply for id 1");
  assert.equal(errorFor(1), undefined, "the valid-version request pins the connection and is served");

  session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: badMeta } });
  await waitFor(() => session.frames.some((frame) => frame.id === 2), 30_000, "-32022 for the post-pin tools/list");
  assert.deepEqual(errorFor(2), {
    code: -32022,
    message: "Unsupported protocol version: 1999-12-31",
    data: { supported: ["2026-07-28"], requested: "1999-12-31" }
  }, "a post-pin list method must not be served with an unsupported version (it used to answer 41 tools)");

  session.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { _meta: badMeta, name: "json-to-nbt", arguments: { json: { hello: "world" }, rootName: "t" } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 3), 30_000, "-32022 for the post-pin tools/call");
  assert.deepEqual(errorFor(3), {
    code: -32022,
    message: "Unsupported protocol version: 1999-12-31",
    data: { supported: ["2026-07-28"], requested: "1999-12-31" }
  }, "a post-pin tool handler must never EXECUTE under an unsupported version");
  assert.equal(
    (session.frames.find((frame) => frame.id === 3) as { result?: unknown }).result,
    undefined,
    "the rejected call carries no result"
  );

  // Per-request, not sticky: a valid version still works afterwards.
  session.send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: goodMeta } });
  await waitFor(() => session.frames.some((frame) => frame.id === 4), 30_000, "tools/list reply for id 4");
  assert.equal(errorFor(4), undefined, "the rejection is per-request and does not poison the connection");
});

test("wire: the -32022 contract does not depend on which method the client happens to send first", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "era-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    await stopSupervisor(session.child);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // server/discover is era-neutral and does NOT pin the worker connection, so
  // before the repair a client that probed first still got -32022 while a
  // client that called tools/list first did not. Correctness must not depend
  // on the client's opening move.
  const badMeta = { [PROTOCOL_VERSION_KEY]: "1999-12-31", [CLIENT_CAPABILITIES_KEY]: {} };
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} } }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 60_000, "discover reply for id 1");

  for (const [id, method, params] of [
    [2, "server/discover", { _meta: badMeta }],
    [3, "resources/list", { _meta: badMeta }],
    [4, "subscriptions/listen", { _meta: badMeta, notifications: { toolsListChanged: true } }]
  ] as Array<[number, string, Record<string, unknown>]>) {
    session.send({ jsonrpc: "2.0", id, method, params });
    await waitFor(() => session.frames.some((frame) => frame.id === id), 30_000, `-32022 for ${method}`);
    const frame = session.frames.find((candidate) => candidate.id === id) as {
      error?: { code?: number; data?: unknown };
      result?: unknown;
    };
    assert.equal(frame.error?.code, -32022, `${method} with an unsupported version must answer -32022`);
    assert.deepEqual(frame.error?.data, { supported: ["2026-07-28"], requested: "1999-12-31" });
    assert.equal(frame.result, undefined, `${method} must not be served`);
  }
});
