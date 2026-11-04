import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeModSchema } from "../../src/entry-tools/analyze-mod-service.ts";
import { compareMinecraftSchema } from "../../src/entry-tools/compare-minecraft-service.ts";
import { validateProjectSchema } from "../../src/entry-tools/validate-project-service.ts";
import { encodeJsonRpcMessage, JsonRpcFrameReader, type ConcreteFramingMode } from "../../src/json-rpc-framing.ts";
import {
  buildSupervisorQueueLimitReply,
  buildSyntheticCallToolResult,
  buildValidateProjectTimeoutReply
} from "../../src/stdio-supervisor.ts";
import { getToolSchema, registerToolSchema } from "../../src/tool-schema-registry.ts";
import { emptySchema } from "../../src/tool-schemas.ts";
import { mixinValidateSpec, projectValidateSpec } from "../../src/tools/families/validation.ts";
import { finalizeNextActions } from "../../src/tools/next-actions.ts";

import { expectedDeprecation } from "../aliases/deprecation.ts";
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

// ---------------------------------------------------------------------------
// Long-running catalog tools
// ---------------------------------------------------------------------------

test("project-validate and mixin-validate get the deadline, and the second waits behind the first", { timeout: 25_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = startFixture();
  t.after(() => stopSupervisor(child));
  const replies = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 80, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-timeout-test", version: "1.0.0" } } }, "line");
  await replies.next(80);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  // The fixture worker answers any tool after delayMs; both calls would
  // outlive the 10 s deadline.
  send(child, {
    jsonrpc: "2.0",
    id: 81,
    method: "tools/call",
    params: { name: "project-validate", arguments: { projectPath: "/workspace/example-mod", delayMs: 15_000 } }
  }, "line");
  send(child, {
    jsonrpc: "2.0",
    id: 82,
    method: "tools/call",
    params: { name: "mixin-validate", arguments: { discover: true, projectPath: "/workspace/example-mod", delayMs: 15_000 } }
  }, "line");

  type TimeoutReply = {
    structuredContent?: {
      error?: { code?: string; detail?: string; suggestedCall?: unknown };
      meta?: { timeout?: { tool?: string; phase?: string; workerRestartInitiated?: boolean } };
    };
  };
  const running = (await replies.next(81, 14_000)).result as TimeoutReply;
  assert.equal(running.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(running.structuredContent?.error?.detail, "project-validate exceeded its 10000 ms deadline.");
  assert.equal(running.structuredContent?.meta?.timeout?.tool, "project-validate");
  assert.equal(running.structuredContent?.meta?.timeout?.phase, "running");
  assert.equal(running.structuredContent?.meta?.timeout?.workerRestartInitiated, true);
  assert.equal(running.structuredContent?.error?.suggestedCall, undefined);

  // mixin-validate never reached the worker: it waited behind project-validate
  // and its own deadline ran out in the queue.
  const queued = (await replies.next(82, 5_000)).result as TimeoutReply;
  assert.equal(queued.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(queued.structuredContent?.error?.detail, "mixin-validate exceeded its 10000 ms deadline.");
  assert.equal(queued.structuredContent?.meta?.timeout?.tool, "mixin-validate");
  assert.equal(queued.structuredContent?.meta?.timeout?.phase, "queue");
  assert.equal(queued.structuredContent?.meta?.timeout?.workerRestartInitiated, false);

  send(child, { jsonrpc: "2.0", id: 83, method: "tools/call", params: { name: "list-versions", arguments: {} } }, "line");
  assert.ok((await replies.next(83, 8_000)).result, "the replacement worker serves the next call");
});

// The schemas the worker registers, so recovery calls validate here as they
// do in the supervisor process (src/cli.ts loads the server before it starts),
// and the aliases below count as served.
for (const spec of [projectValidateSpec, mixinValidateSpec]) {
  if (getToolSchema(spec.name) === undefined) registerToolSchema(spec.name, spec.inputSchema);
}
for (const [name, schema] of [
  ["validate-project", validateProjectSchema],
  ["get-runtime-metrics", emptySchema],
  ["analyze-mod", analyzeModSchema],
  ["compare-minecraft", compareMinecraftSchema]
] as const) {
  if (getToolSchema(name) === undefined) registerToolSchema(name, schema);
}

type SyntheticBody = {
  error: Record<string, unknown> & { detail?: string; hints?: string[]; suggestedCall?: unknown };
  meta: Record<string, unknown> & {
    timeout?: Record<string, unknown>;
    restart?: Record<string, unknown>;
    nextActions?: Array<{ tool: string; params: Record<string, unknown> }>;
  };
};

function syntheticBody(reply: unknown): SyntheticBody {
  const result = (reply as { result: { content: Array<{ text: string }>; structuredContent: SyntheticBody } }).result;
  assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent, "the text and structuredContent agree");
  return result.structuredContent;
}

const MIXIN_ARGS = {
  configPaths: ["/workspace/example-mod/src/main/resources/example.mixins.json"],
  projectPath: "/workspace/example-mod"
};

test("a timed-out catalog call names itself and offers its retry as a validated next action", () => {
  for (const [tool, args] of [
    ["mixin-validate", MIXIN_ARGS],
    ["project-validate", { projectPath: "/workspace/example-mod", detail: "standard" }]
  ] as const) {
    const body = syntheticBody(buildValidateProjectTimeoutReply({
      request: { id: 7, method: "tools/call", toolName: tool, toolArgsRedacted: { ...args }, toolArgsRedactedModified: false, startedAt: 0 },
      phase: "running",
      deadlineMs: 120_000,
      now: 120_000,
      workerRestartInitiated: true
    }));
    assert.equal(body.error.code, "ERR_TOOL_TIMEOUT");
    assert.equal(body.error.detail, `${tool} exceeded its 120000 ms deadline.`);
    assert.equal(body.meta.timeout?.tool, tool);
    assert.equal("suggestedCall" in body.error, false, `${tool}: recovery is not an error.suggestedCall`);
    assert.deepEqual(body.meta.nextActions, [{ tool, params: args }]);
    assert.deepEqual(finalizeNextActions(body.meta.nextActions!), body.meta.nextActions, "the retry validates");
  }

  const redacted = syntheticBody(buildValidateProjectTimeoutReply({
    request: { id: 8, method: "tools/call", toolName: "mixin-validate", toolArgsRedacted: { source: "<truncated:4096 bytes>" }, toolArgsRedactedModified: true, startedAt: 0 },
    phase: "queue",
    deadlineMs: 120_000,
    now: 120_000,
    workerRestartInitiated: false
  }));
  assert.equal(redacted.meta.timeout?.tool, "mixin-validate");
  assert.equal(redacted.meta.nextActions, undefined, "arguments changed by redaction are not offered for a retry");
});

test("a restarted catalog call names itself, offers its retry as a next action and names no 8.x input", () => {
  const base = {
    durationMs: 900,
    lastStage: "target-lookup",
    lastStageElapsedMs: 300,
    lastStageMeta: { targetIndex: 6, targetTotal: 9 },
    exit: { code: 1, signal: null },
    retryRecommendation: "narrow-query" as const
  };
  const catalog = syntheticBody(buildSyntheticCallToolResult(9, {
    ...base,
    toolName: "mixin-validate",
    toolArgsRedacted: { ...MIXIN_ARGS },
    toolArgsRedactedModified: false
  }));
  assert.equal(catalog.error.detail, "The worker process exited while handling tools/call (mixin-validate).");
  assert.equal(catalog.meta.restart?.tool, "mixin-validate");
  assert.equal("suggestedCall" in catalog.error, false);
  assert.deepEqual(catalog.meta.nextActions, [{ tool: "mixin-validate", params: MIXIN_ARGS }]);
  assert.deepEqual(catalog.error.hints, [
    "lastStage=target-lookup at index 6/9 — validate fewer mixin classes per call and retry"
  ]);

  const project = syntheticBody(buildSyntheticCallToolResult(12, {
    ...base,
    toolName: "project-validate",
    toolArgsRedacted: { projectPath: "/workspace/example-mod" },
    toolArgsRedactedModified: false
  }));
  assert.equal(project.meta.restart?.tool, "project-validate");
  assert.deepEqual(project.meta.nextActions, [{ tool: "project-validate", params: { projectPath: "/workspace/example-mod" } }]);
  assert.deepEqual(project.error.hints, [
    "lastStage=target-lookup at index 6/9 — validate its mixin configs one at a time with mixin-validate configPaths and retry"
  ]);

  const eightX = syntheticBody(buildSyntheticCallToolResult(10, {
    ...base,
    toolName: "validate-project",
    toolArgsRedacted: { task: "project-summary", subject: { kind: "workspace", projectPath: "/workspace/example-mod" } },
    toolArgsRedactedModified: false
  }));
  assert.deepEqual(eightX.error.hints, [
    "lastStage=target-lookup at index 6/9 — narrow mixinConfigPath to one file and retry"
  ]);
  assert.deepEqual(eightX.error.suggestedCall, {
    tool: "validate-project",
    params: { task: "project-summary", subject: { kind: "workspace", projectPath: "/workspace/example-mod" } }
  });
  assert.equal(eightX.meta.nextActions, undefined, "the 8.x reply keeps error.suggestedCall and gains no next actions");
});

test("the validate-project timeout reply keeps its frozen 8.x shape plus meta.deprecated", () => {
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), "tests", "fixtures", "premigration", "synthetic-shapes", "timeout-validate-project.json"),
    "utf8"
  )) as {
    request: { id: number; params: { name: string; arguments: Record<string, unknown> } };
    reply: { result: { structuredContent: SyntheticBody } };
  };
  const reply = buildValidateProjectTimeoutReply({
    request: {
      id: fixture.request.id,
      method: "tools/call",
      toolName: fixture.request.params.name,
      toolArgsRedacted: fixture.request.params.arguments,
      toolArgsRedactedModified: false,
      startedAt: 0
    },
    phase: "running",
    deadlineMs: 10_000,
    now: 10_250,
    workerRestartInitiated: true
  }) as unknown as { result: { content: Array<{ text: string }>; structuredContent: SyntheticBody } };
  const expected = fixture.reply.result.structuredContent;
  const actual = reply.result.structuredContent;
  assert.equal(actual.meta.timeout?.durationMs, 10_250);
  const { deprecated, ...frozenMeta } = actual.meta;
  assert.deepEqual(deprecated, expectedDeprecation("validate-project", fixture.request.params.arguments));
  assert.deepEqual(
    { ...actual, meta: { ...frozenMeta, timeout: { ...actual.meta.timeout, durationMs: "<DURATION_MS>" } } },
    expected
  );
  assert.equal(reply.result.content[0]!.text, JSON.stringify(actual), "the text is the structured reply, byte for byte");

  const withRetry = syntheticBody(buildValidateProjectTimeoutReply({
    request: {
      id: 11,
      method: "tools/call",
      toolName: "validate-project",
      toolArgsRedacted: { task: "project-summary", subject: { kind: "workspace", projectPath: "/workspace/example-mod" } },
      toolArgsRedactedModified: false,
      startedAt: 0
    },
    phase: "running",
    deadlineMs: 10_000,
    now: 10_000,
    workerRestartInitiated: true
  }));
  assert.equal(withRetry.meta.timeout?.tool, "validate-project");
  assert.deepEqual(withRetry.error.suggestedCall, {
    tool: "validate-project",
    params: { task: "project-summary", subject: { kind: "workspace", projectPath: "/workspace/example-mod" } }
  });
  assert.equal(withRetry.meta.nextActions, undefined);
});

test("synthetic timeout, restart and queue-overflow replies to an alias carry meta.deprecated in both representations; catalog ones do not", () => {
  const timeout = (toolName: string, toolArgsRedacted: Record<string, unknown>) =>
    syntheticBody(buildValidateProjectTimeoutReply({
      request: { id: 21, method: "tools/call", toolName, toolArgsRedacted, toolArgsRedactedModified: false, startedAt: 0 },
      phase: "running",
      deadlineMs: 10_000,
      now: 10_000,
      workerRestartInitiated: true
    }));
  const restart = (toolName: string, toolArgsRedacted: Record<string, unknown>) =>
    syntheticBody(buildSyntheticCallToolResult(22, {
      toolName,
      toolArgsRedacted,
      toolArgsRedactedModified: false,
      durationMs: 900,
      lastStage: undefined,
      lastStageElapsedMs: undefined,
      lastStageMeta: undefined,
      exit: { code: 1, signal: null },
      retryRecommendation: "same-request"
    }));
  const overflow = (toolName?: string, toolArgs?: Record<string, unknown>) =>
    syntheticBody(buildSupervisorQueueLimitReply(23, "tools/call", toolName, toolArgs));

  // syntheticBody asserts that the JSON text equals structuredContent, so each
  // block below is in both representations.
  const aliasCases: Array<[string, SyntheticBody, unknown]> = [
    ["timeout validate-project", timeout("validate-project", { projectPath: "/workspace/example-mod" }), { replacedBy: ["project-validate", "mixin-validate", "access-validate"], removeIn: "10.0.0" }],
    ["timeout validate-project task mixin", timeout("validate-project", { task: "mixin" }), { replacedBy: ["mixin-validate"], removeIn: "10.0.0" }],
    ["restart get-runtime-metrics", restart("get-runtime-metrics", {}), { replacedBy: ["server-metrics"], removeIn: "10.0.0" }],
    ["restart analyze-mod task summary", restart("analyze-mod", { task: "summary" }), { replacedBy: ["mod-inspect"], removeIn: "10.0.0" }],
    ["overflow validate-project task access-widener", overflow("validate-project", { task: "access-widener" }), { replacedBy: ["access-validate"], removeIn: "10.0.0" }],
    ["overflow compare-minecraft", overflow("compare-minecraft", {}), { replacedBy: ["version-compare", "class-diff"], removeIn: "10.0.0" }]
  ];
  for (const [label, body, expected] of aliasCases) {
    assert.deepEqual(body.meta.deprecated, expected, `${label}: meta.deprecated`);
  }

  const catalogCases: Array<[string, SyntheticBody]> = [
    ["timeout project-validate", timeout("project-validate", { projectPath: "/workspace/example-mod" })],
    ["restart mixin-validate", restart("mixin-validate", { ...MIXIN_ARGS })],
    ["overflow server-metrics", overflow("server-metrics", {})],
    ["overflow of an unidentified call", overflow()]
  ];
  for (const [label, body] of catalogCases) {
    assert.equal("deprecated" in body.meta, false, `${label}: no meta.deprecated`);
  }

  const rawOverflow = buildSupervisorQueueLimitReply(24, "resources/list", "get-runtime-metrics", {}) as unknown as Record<string, unknown>;
  assert.equal("result" in rawOverflow, false, "a non-tool overflow stays a raw JSON-RPC error");
});
