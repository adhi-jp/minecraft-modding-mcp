import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeJsonRpcMessage, JsonRpcFrameReader, type ConcreteFramingMode } from "../../src/json-rpc-framing.ts";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";
import { stopSupervisor } from "../helpers/stdio-child-lifecycle.ts";

type RpcResponse = {
  id: string | number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

function startFixture(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/stdio-supervisor-timeout-worker.runtime.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, MCP_VALIDATE_PROJECT_TIMEOUT_MS: "10000", ...env },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
}

function collectLogEvents(child: ChildProcessWithoutNullStreams): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
      } catch {
        // Ignore non-structured fixture diagnostics.
      }
    }
  });
  return events;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function send(child: ChildProcessWithoutNullStreams, message: object, mode: ConcreteFramingMode): void {
  child.stdin.write(encodeJsonRpcMessage(message as never, mode));
}

function collectResponses(child: ChildProcessWithoutNullStreams): {
  next(id: string | number, timeoutMs?: number): Promise<RpcResponse>;
} {
  const responses: RpcResponse[] = [];
  const waiters = new Map<string, (response: RpcResponse) => void>();
  const reader = new JsonRpcFrameReader();
  child.stdout.on("data", (chunk: Buffer) => {
    reader.processChunk(chunk, {
      onFrame: ({ message }) => {
        if (!("id" in message)) return;
        const response = message as RpcResponse;
        const key = String(response.id);
        const waiter = waiters.get(key);
        if (waiter) {
          waiters.delete(key);
          waiter(response);
        } else {
          responses.push(response);
        }
      },
      onError: (error) => {
        throw error;
      }
    });
  });
  return {
    next(id, timeoutMs = 15_000) {
      const existingIndex = responses.findIndex((entry) => entry.id === id);
      if (existingIndex >= 0) {
        return Promise.resolve(responses.splice(existingIndex, 1)[0]);
      }
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(String(id));
          reject(new Error(`timed out waiting for response ${String(id)}`));
        }, timeoutMs);
        waiters.set(String(id), (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    }
  };
}

for (const framing of ["line", "content-length"] as const) test(`running timeout and overflow use exact envelopes with ${framing} framing`, { timeout: 20_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = startFixture();
  t.after(() => stopSupervisor(child));
  const replies = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-timeout-test", version: "1.0.0" } } }, framing);
  await replies.next(1);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "validate-project", arguments: { task: "project-summary", subject: { kind: "project", path: "." } } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 6,
    method: "resources/read",
    params: { uri: "mc://versions" }
  }, framing);

  const overflow = await replies.next(5, 2_000);
  const overflowResult = overflow.result as { structuredContent?: { error?: { code?: string }; meta?: { queue?: { queuedCount?: number } } } };
  assert.equal(overflowResult.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
  assert.equal(overflowResult.structuredContent?.meta?.queue?.queuedCount, 2);
  assert.deepEqual(await replies.next(6, 2_000), {
    jsonrpc: "2.0",
    id: 6,
    error: { code: -32000, message: "MCP supervisor request queue is full." }
  });

  const timeoutReply = await replies.next(2);
  const timeoutResult = timeoutReply.result as { structuredContent?: { error?: { code?: string }; meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } } } };
  assert.equal(timeoutResult.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.deepEqual(timeoutResult.structuredContent?.meta?.timeout?.phase, "running");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.workerRestartInitiated, true);

  const recovered = await replies.next(3, 5_000);
  assert.ok(recovered.result);
});

for (const framing of ["line", "content-length"] as const) test(`queued timeout preserves the worker with ${framing} framing`, { timeout: 18_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = startFixture();
  t.after(() => stopSupervisor(child));
  const replies = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-timeout-test", version: "1.0.0" } } }, framing);
  await replies.next(10);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "list-versions", arguments: { delayMs: 11_000 } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "validate-project", arguments: { task: "project-summary", subject: { kind: "project", path: "." } } }
  }, framing);
  send(child, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  }, framing);

  const timeoutReply = await replies.next(12, 13_000);
  const timeoutResult = timeoutReply.result as { structuredContent?: { error?: { code?: string }; meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } } } };
  assert.equal(timeoutResult.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.phase, "queue");
  assert.equal(timeoutResult.structuredContent?.meta?.timeout?.workerRestartInitiated, false);

  const held = await replies.next(11, 3_000);
  const later = await replies.next(13, 3_000);
  const heldPid = ((held.result as { structuredContent?: { result?: { pid?: number } } }).structuredContent?.result?.pid);
  const laterPid = ((later.result as { structuredContent?: { result?: { pid?: number } } }).structuredContent?.result?.pid);
  assert.equal(laterPid, heldPid);
});

test("queued cancellation removes the validate barrier without forwarding a result", { timeout: 5_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = startFixture();
  t.after(() => stopSupervisor(child));
  const replies = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-timeout-test", version: "1.0.0" } } }, "line");
  await replies.next(20);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send(child, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "list-versions", arguments: { delayMs: 500 } } }, "line");
  send(child, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "validate-project", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 22, reason: "test" } }, "line");

  await replies.next(21, 2_000);
  await replies.next(23, 2_000);
  await assert.rejects(replies.next(22, 250), /timed out waiting/);
});

test("running cancellation suppresses timeout output but still recovers queued work", { timeout: 16_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = startFixture();
  t.after(() => stopSupervisor(child));
  const replies = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 30, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-timeout-test", version: "1.0.0" } } }, "line");
  await replies.next(30);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send(child, { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "validate-project", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 31, reason: "test" } }, "line");

  await replies.next(32, 13_000);
  await assert.rejects(replies.next(31, 250), /timed out waiting/);
});

test("fatal worker exception exits, restarts, replays initialization, and serves the next call", { timeout: 15_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "stdio-supervisor-fatal-"));
  const child = startFixture({ MCP_TEST_FATAL_WORKER_MARKER: join(root, "first-worker-faulted") });
  t.after(async () => {
    await stopSupervisor(child);
    await rm(root, { recursive: true, force: true });
  });
  const replies = collectResponses(child);
  const events = collectLogEvents(child);

  send(child, {
    jsonrpc: "2.0",
    id: 40,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fatal-worker-test", version: "1.0.0" }
    }
  }, "line");
  await replies.next(40);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");

  await waitFor(
    () => events.filter(({ event }) => event === "supervisor.worker_spawn").length >= 2,
    "fatal worker did not produce a replacement generation"
  );
  assert.equal(events.some(({ event }) => event === "process.uncaught_exception"), true);
  const spawnedPids = events
    .filter(({ event }) => event === "supervisor.worker_spawn")
    .map(({ pid }) => pid);
  assert.notEqual(spawnedPids[0], spawnedPids[1]);

  send(child, { jsonrpc: "2.0", id: 41, method: "tools/list", params: {} }, "line");
  const recovered = await replies.next(41, 5_000);
  assert.ok(recovered.result);
  assert.equal(recovered.error, undefined);
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pid of the DESCENDANT the fixture worker spawned into its own process
 * group. Nothing but process-group termination can reach it: ending the
 * supervisor's stdin reaches the supervisor, and the worker's own stdin-EOF
 * stand-down reaches the worker — neither touches a grandchild.
 */
async function waitForWorkerDescendantPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = await readFile(pidFile, "utf8").then(
      (value) => Number(value.trim()) || undefined,
      () => undefined
    );
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the fixture worker never reported a descendant pid");
}

/** Handshakes the fixture and returns the pid of the worker it spawned. */
async function handshakeForWorkerPid(
  child: ChildProcessWithoutNullStreams,
  replies: ReturnType<typeof collectResponses>,
  baseId: number
): Promise<number> {
  send(child, { jsonrpc: "2.0", id: baseId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-lifecycle-test", version: "1.0.0" } } }, "line");
  await replies.next(baseId);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send(child, { jsonrpc: "2.0", id: baseId + 1, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  const reply = await replies.next(baseId + 1);
  const pid = (reply.result as { structuredContent?: { result?: { pid?: number } } }).structuredContent?.result?.pid;
  assert.equal(typeof pid, "number", "the fixture worker must report its pid");
  return pid as number;
}

test("SIGHUP shuts the supervisor down through its own path instead of orphaning the worker", { timeout: 20_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  // SIGHUP is what a terminating launcher sends when its controlling terminal
  // or session goes away. Left to the OS default it kills the supervisor
  // outright, and the detached worker process group survives with nobody to
  // reap it — the same leak a bare SIGKILL produces.
  const root = await mkdtemp(join(tmpdir(), "stdio-supervisor-sighup-"));
  const descendantPidFile = join(root, "worker-descendant.pid");
  const child = startFixture({ MCP_TEST_WORKER_DESCENDANT_PID_FILE: descendantPidFile });
  t.after(async () => {
    await stopSupervisor(child);
    await rm(root, { recursive: true, force: true });
  });
  const replies = collectResponses(child);
  const workerPid = await handshakeForWorkerPid(child, replies, 50);
  const descendantPid = await waitForWorkerDescendantPid(descendantPidFile);
  t.after(() => {
    try { process.kill(workerPid, "SIGTERM"); } catch { /* already reaped */ }
    try { process.kill(descendantPid, "SIGTERM"); } catch { /* already reaped */ }
  });
  // Non-vacuity: an assertion that the descendant is gone proves nothing if it
  // was never running.
  assert.equal(processAlive(descendantPid), true, "the fixture worker's descendant must be running");

  child.kill("SIGHUP");

  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    "the supervisor to exit after SIGHUP",
    10_000
  );
  assert.equal(
    child.signalCode,
    null,
    "SIGHUP must run the supervisor's own shutdown, not the OS default that terminates it where it stands"
  );
  // The worker alone proves little: it stands down on stdin EOF whether or not
  // the supervisor's shutdown path ran at all. Its DESCENDANT is the load-
  // bearing one — only the process-group termination inside shutdown() reaches
  // a grandchild, so this is what a dropped group-kill would break.
  await waitFor(
    () => !processAlive(descendantPid),
    "the worker's descendant to be reaped by the SIGHUP shutdown",
    5_000
  );
  await waitFor(
    () => !processAlive(workerPid),
    "the worker to be reaped by the SIGHUP shutdown",
    5_000
  );
});

test("an uncaught supervisor exception is reported, exits non-zero, and still reaps the worker", { timeout: 40_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  // Nothing owned the supervisor process's fatal handlers: a crash in the
  // supervisor left node's default handler to print a stack and exit, with no
  // route to shutdown() and therefore no reaping of the detached worker.
  const root = await mkdtemp(join(tmpdir(), "stdio-supervisor-fatal-reap-"));
  const descendantPidFile = join(root, "worker-descendant.pid");
  const child = startFixture({
    MCP_TEST_FATAL_SUPERVISOR_AFTER_MS: "4000",
    MCP_TEST_WORKER_DESCENDANT_PID_FILE: descendantPidFile
  });
  t.after(async () => {
    await stopSupervisor(child);
    await rm(root, { recursive: true, force: true });
  });
  const replies = collectResponses(child);
  const events = collectLogEvents(child);
  const workerPid = await handshakeForWorkerPid(child, replies, 60);
  const descendantPid = await waitForWorkerDescendantPid(descendantPidFile);
  t.after(() => {
    try { process.kill(workerPid, "SIGTERM"); } catch { /* already reaped */ }
    try { process.kill(descendantPid, "SIGTERM"); } catch { /* already reaped */ }
  });
  // Non-vacuity: an assertion that the descendant is gone proves nothing if it
  // was never running.
  assert.equal(processAlive(descendantPid), true, "the fixture worker's descendant must be running");

  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    "the supervisor to exit after its injected fatal error",
    25_000
  );
  assert.equal(child.exitCode, 1, "a fatal supervisor error must exit non-zero");
  assert.equal(
    events.some(({ event }) => event === "supervisor.fatal"),
    true,
    `the supervisor must name its own fatal error on stderr; saw events: ${events.map(({ event }) => String(event)).join(", ")}`
  );
  // As above: the worker's own stdin-EOF stand-down would satisfy a
  // worker-only assertion even if shutdown() never ran, so the descendant —
  // reachable only by the process-group termination — carries the claim.
  await waitFor(
    () => !processAlive(descendantPid),
    "the worker's descendant to be reaped by the fatal-error shutdown",
    10_000
  );
  await waitFor(
    () => !processAlive(workerPid),
    "the worker to be reaped by the fatal-error shutdown",
    10_000
  );
});

test("a fatal supervisor error ends the process even while a referenced handle holds the event loop", { timeout: 40_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  // Registering uncaughtException/unhandledRejection handlers SUPPRESSES node's
  // default abort, so the promised non-zero exit stops being a guarantee and
  // becomes a bet on the event loop draining. The fixture holds a referenced
  // interval that is never cleared, so nothing but an explicit exit can end it.
  const child = startFixture({
    MCP_TEST_FATAL_SUPERVISOR_AFTER_MS: "2000",
    MCP_TEST_SUPERVISOR_HOLD_EVENT_LOOP: "1"
  });
  t.after(async () => {
    await stopSupervisor(child);
  });
  const replies = collectResponses(child);
  const workerPid = await handshakeForWorkerPid(child, replies, 70);
  t.after(() => {
    try { process.kill(workerPid, "SIGTERM"); } catch { /* already reaped */ }
  });

  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    "the supervisor to end itself after its injected fatal error",
    20_000
  );
  assert.equal(child.signalCode, null, "the supervisor must end itself rather than wait to be signalled");
  assert.equal(child.exitCode, 1, "a fatal supervisor error must exit non-zero");
  await waitFor(
    () => !processAlive(workerPid),
    "the worker to be reaped before the forced exit",
    10_000
  );
});
