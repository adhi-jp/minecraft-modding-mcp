import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

/**
 * Dependency-method inventory (per-method × per-era), over the REAL wire
 * (production supervisor + production SDK worker).
 *
 * Rows already covered by committed suites (named; not re-driven here):
 *  - initialize: legacy-only; modern-locked initialize → -32601 era_conflict
 *    (tests/stdio/stdio-supervisor-era-state.test.ts,
 *     tests/stdio/stdio-supervisor-era-wire.test.ts).
 *  - notifications (cancelled / progress / initialized): never answered in
 *    either era (tests/stdio/stdio-supervisor-era-state.test.ts).
 *  - server/discover: modern → DiscoverResult; legacy-locked → -32601
 *    era-consistent rejection (tests/stdio/stdio-supervisor-era-state.test.ts,
 *     tests/stdio/stdio-supervisor-era-wire.test.ts).
 * Rows driven HERE (previously uncovered): ping, logging/setLevel,
 * tasks/list, tasks/get, prompts/list — each in both eras — plus the
 * subscriptions/listen answer from the REAL worker in BOTH eras (the
 * era-state suite drives a fake worker, so the live wire outcome is proven
 * here), and the no-prompts-capability assertions on the initialize result AND
 * the server/discover capabilities.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const MODERN_META = { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };

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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function reply(session: { frames: Frame[] }, id: number, label: string): Promise<Frame> {
  await waitFor(() => session.frames.some((frame) => frame.id === id), 30_000, label);
  return session.frames.find((frame) => frame.id === id)!;
}

test("wire dependency-method inventory: legacy era (ping pong, setLevel/tasks/prompts -32601, no prompts capability)", { timeout: 150_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "dep-methods-legacy-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 90_000, "supervisor worker_ready adoption");

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dep-methods-test", version: "1.0.0" }
    }
  });
  const init = await reply(session, 1, "initialize reply");
  const initResult = init.result as { protocolVersion?: unknown; capabilities?: Record<string, unknown> };
  assert.equal(initResult.protocolVersion, "2025-06-18");
  assert.ok(initResult.capabilities, "initialize must advertise capabilities");
  assert.equal(
    "prompts" in initResult.capabilities,
    false,
    "no prompts capability may be advertised while no prompts are registered"
  );
  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  session.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  const pong = await reply(session, 2, "legacy ping pong");
  assert.equal(pong.error, undefined, "legacy ping must be auto-ponged");
  assert.deepEqual(pong.result, {}, "the legacy pong is the empty result, with no modern decoration");

  const notFoundRows: Array<[number, string, Record<string, unknown> | undefined]> = [
    [3, "logging/setLevel", { level: "info" }],
    [4, "tasks/list", {}],
    [5, "tasks/get", { taskId: "p3-task" }],
    [6, "prompts/list", {}],
    // Legacy subscriptions/listen reaches the REAL worker (the supervisor
    // only intercepts the modern era), whose 2025 registry has no such
    // method → -32601 from the live SDK instance.
    [7, "subscriptions/listen", {}],
    // CLAIM-LESS server/discover on a legacy-locked process: claim-less
    // traffic forwards to the worker unchanged, whose legacy registry has no
    // server/discover → -32601 from the live SDK instance. (The MODERN-
    // enveloped discover on a legacy lock gets the supervisor's era-consistent
    // rejection instead — covered by the era-state/era-wire suites.)
    [8, "server/discover", {}]
  ];
  for (const [id, method, params] of notFoundRows) {
    session.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    const frame = await reply(session, id, `legacy ${method} reply`);
    assert.equal(
      (frame.error as { code?: number } | undefined)?.code,
      -32601,
      `legacy ${method} must answer -32601 (never registered on this server)`
    );
  }
});

test("wire dependency-method inventory: modern era (ping/setLevel/tasks/prompts -32601, discover without prompts capability)", { timeout: 150_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "dep-methods-modern-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 90_000, "supervisor worker_ready adoption");

  session.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_META } });
  const discover = await reply(session, 1, "modern discover reply");
  assert.equal(discover.error, undefined, "the modern discover must be served");
  const capabilities = (discover.result as { capabilities?: Record<string, unknown> }).capabilities;
  assert.ok(capabilities, "the discover must advertise capabilities");
  assert.equal(
    "prompts" in capabilities,
    false,
    "no prompts capability may be advertised in discover while no prompts are registered"
  );

  const notFoundRows: Array<[number, string, Record<string, unknown>]> = [
    [2, "ping", { _meta: MODERN_META }],
    [3, "logging/setLevel", { _meta: MODERN_META, level: "info" }],
    [4, "tasks/list", { _meta: MODERN_META }],
    [5, "tasks/get", { _meta: MODERN_META, taskId: "p3-task" }],
    [6, "prompts/list", { _meta: MODERN_META }]
  ];
  for (const [id, method, params] of notFoundRows) {
    session.send({ jsonrpc: "2.0", id, method, params });
    const frame = await reply(session, id, `modern ${method} reply`);
    assert.equal(
      (frame.error as { code?: number } | undefined)?.code,
      -32601,
      `modern ${method} must answer -32601 (absent from the modern registry / never registered)`
    );
  }

  // subscriptions/listen carrying a CONFORMANT filter is the dangerous shape:
  // the SDK stdio entry auto-provides the method with zero registration and
  // ACCEPTS a valid filter, answering with an id-less
  // notifications/subscriptions/acknowledged that never settles the request
  // id. docs/tool-reference.md pins the surface as intentionally absent in
  // BOTH eras with a -32601 rejection, so the supervisor must refuse it at
  // admission — before it can occupy a pendingRequests slot and wedge every
  // dispatch barrier behind it.
  const subscriptionRequestId = 7;
  session.send({
    jsonrpc: "2.0",
    id: subscriptionRequestId,
    method: "subscriptions/listen",
    params: {
      _meta: MODERN_META,
      notifications: { toolsListChanged: true }
    }
  });
  const listenReply = await reply(session, subscriptionRequestId, "modern subscriptions/listen reply");
  assert.deepEqual(
    listenReply.error,
    { code: -32601, message: "Method not found" },
    "modern subscriptions/listen must be answered -32601 with no data, indistinguishable from any unknown method"
  );
  assert.equal(listenReply.result, undefined, "the rejection carries no result");
  assert.equal(
    session.frames.some((frame) => frame.method === "notifications/subscriptions/acknowledged"),
    false,
    "no subscription may be established: an acknowledgment notification would prove the worker accepted the listen"
  );

  // The rejection settled the id, so the connection is not wedged: ordinary
  // requests behind it — including a tools/call, which the pre-repair build
  // never dispatched once a listen occupied pendingRequests — still answer.
  session.send({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { _meta: MODERN_META } });
  const barrier = await reply(session, 8, "post-rejection tools/list barrier");
  assert.equal(barrier.error, undefined, "the connection must stay usable after the listen rejection");
  session.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { _meta: MODERN_META, name: "list-versions", arguments: {} }
  });
  const call = await reply(session, 9, "post-rejection tools/call");
  assert.equal(call.error, undefined, "tool dispatch must not be blocked by a phantom pending listen");
});
