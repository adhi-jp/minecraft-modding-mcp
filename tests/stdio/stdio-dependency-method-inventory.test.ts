import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
 *  - subscriptions/listen (modern): -32601 at supervisor admission
 *    (tests/stdio/stdio-supervisor-era-state.test.ts).
 *
 * Rows driven HERE (previously uncovered): ping, logging/setLevel,
 * tasks/list, tasks/get, prompts/list — each in both eras — plus the
 * LEGACY subscriptions/listen answer from the REAL worker (the era-state
 * suite hand-injects that reply through a fake worker, so the live wire
 * outcome is proven here), and the no-prompts-capability assertions on the
 * initialize result AND the server/discover capabilities.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const MODERN_META = { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };

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
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
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
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
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
  const findAcknowledgment = (): Frame | undefined =>
    session.frames.find((frame) => frame.method === "notifications/subscriptions/acknowledged");
  await waitFor(
    () => findAcknowledgment() !== undefined || session.frames.some((frame) => frame.id === subscriptionRequestId),
    30_000,
    "modern subscription acknowledgment or terminal rejection"
  );
  const acknowledgment = findAcknowledgment();
  assert.ok(acknowledgment, "valid modern subscriptions/listen must emit an acknowledgment notification");
  const acknowledgmentParams = acknowledgment.params as {
    notifications?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  assert.deepEqual(acknowledgmentParams.notifications, { toolsListChanged: true });
  assert.equal(
    acknowledgmentParams._meta?.["io.modelcontextprotocol/subscriptionId"],
    subscriptionRequestId,
    "the SDK acknowledgment correlates the subscription to the listen request id"
  );
  assert.equal(
    session.frames.some((frame) => frame.id === subscriptionRequestId),
    false,
    "an active subscription must not emit an application result before cancellation"
  );

  session.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: subscriptionRequestId }
  });
  session.send({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { _meta: MODERN_META } });
  const barrier = await reply(session, 8, "post-cancellation tools/list barrier");
  assert.equal(barrier.error, undefined, "the worker must remain usable after subscription cancellation");
  assert.equal(
    session.frames.some((frame) => frame.id === subscriptionRequestId),
    false,
    "claim-less cancellation ends the subscription without a duplicate application result"
  );
});
