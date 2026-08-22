import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { validateProjectSchema } from "../../src/entry-tools/validate-project-service.ts";
import { StdioSupervisor } from "../../src/stdio-supervisor.ts";
import { getToolSchema, registerToolSchema } from "../../src/tool-schema-registry.ts";
import { emptySchema } from "../../src/tool-schemas.ts";

/**
 * Era × failure-type synthetic-inventory suite.
 *
 * Covers the seven premigration terminal synthesis paths in-process:
 *  - Legacy rows must stay byte-identical (after the capture harness's
 *    normalization rules N3/N4) to tests/fixtures/premigration/synthetic-shapes
 *    (legacy replies must never gain modern-only fields).
 *  - Modern rows: structured synthetic RESULTS carry `resultType: "complete"`
 *    and the canonical server identity under
 *    `_meta["io.modelcontextprotocol/serverInfo"]`; raw JSON-RPC error
 *    envelopes gain NO result-only fields in any era.
 *  - Finality: every synthesized response is terminal for its request id —
 *    a late CURRENT-generation worker response for a synthesized id must be
 *    discarded with a logged event, never forwarded as a second response.
 *
 * The toggle-off variant (SUPERVISOR_STRUCTURED_RESTART_OFF=1) lives in
 * stdio-supervisor-synthetic-toggle-off.test.ts because the flag is read at
 * module load; the live-SDK drift guard lives in
 * stdio-supervisor-synthetic-drift.test.ts.
 */

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "premigration", "synthetic-shapes");
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

/** The canonical identity the decorator must stamp (independent source: package.json). */
const PACKAGE_JSON = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
};

// Register the REAL production schemas (exactly the ones index.ts registers)
// so schema drift auto-propagates into this suite: get-runtime-metrics
// accepts {} (restart fixtures carry suggestedCall), while validate-project's
// schema REJECTS a bare {projectPath} (requires task/subject), so the timeout
// fixture carries NO suggestedCall.
if (getToolSchema("get-runtime-metrics") === undefined) {
  registerToolSchema("get-runtime-metrics", emptySchema);
}
if (getToolSchema("validate-project") === undefined) {
  registerToolSchema("validate-project", validateProjectSchema);
}

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
}

/**
 * The capture harness's normalization (scripts/premigration/lib.mjs) reduced
 * to the rules these replies exercise: N3 durationMs/lastStageElapsedMs
 * numbers -> "<DURATION_MS>", N4 JSON `text` blobs -> {__normalizedJson: ...}.
 * Key order is irrelevant under deepEqual, and these replies carry no
 * machine-specific paths, pids, or random request ids.
 */
function normalizeReply(value: unknown, keyName?: string): unknown {
  if (typeof value === "number" && (keyName === "durationMs" || keyName === "lastStageElapsedMs")) {
    return "<DURATION_MS>";
  }
  if (typeof value === "string" && keyName === "text") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { __normalizedJson: normalizeReply(JSON.parse(trimmed)) };
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeReply(entry));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = normalizeReply(entry, key);
    }
    return out;
  }
  return value;
}

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
  emit(event: string, ...args: unknown[]): boolean;
};

type FakeScheduledTimer = NodeJS.Timeout & {
  at: number;
  callback: () => void;
  cleared: boolean;
};

type CapturedEvent = { level: string; event: string; details?: Record<string, unknown> };

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  era?: unknown;
  liveChildren: Set<FakeChild>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number; era?: string } }>;
  pendingRequests: Map<string, { era?: string }>;
  syntheticTombstones?: Map<string, { generation: number }>;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  handleWorkerExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void;
  spawnWorker(): void;
  shutdown(): Promise<void>;
};

function createWorker(pid: number, writes: string[]): FakeChild {
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  stdin.destroyed = false;
  stdin.write = (payload: string) => {
    writes.push(payload);
    return true;
  };
  const child = new EventEmitter() as unknown as EventEmitter & FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = new EventEmitter() as EventEmitter & FakeChild["stdout"];
  child.stderr = new EventEmitter() as EventEmitter & FakeChild["stderr"];
  child.kill = () => true;
  return child;
}

function createHarness(childCount: number, options: { validateProjectTimeoutMs?: number } = {}): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  events: CapturedEvent[];
  children: FakeChild[];
  childWrites: string[][];
  timers: FakeScheduledTimer[];
  setNow(value: number): void;
} {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const events: CapturedEvent[] = [];
  const childWrites: string[][] = [];
  const children = Array.from({ length: childCount }, (_, index) => {
    const writes: string[] = [];
    childWrites.push(writes);
    return createWorker(99_300_000 + index, writes);
  });
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    ...(options.validateProjectTimeoutMs !== undefined
      ? { validateProjectTimeoutMs: options.validateProjectTimeoutMs }
      : {}),
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details }),
    monotonicNow: () => now,
    workerSpawner: () => children[spawnIndex++] as never,
    treeTerminator: () => true,
    timerScheduler: (callback, delayMs) => {
      const timer = {
        at: now + delayMs,
        callback,
        cleared: false,
        unref() { return this; }
      } as unknown as FakeScheduledTimer;
      timers.push(timer);
      return timer;
    },
    timerClearer: (timer) => { (timer as FakeScheduledTimer).cleared = true; }
  } as never) as unknown as Harness;
  return {
    supervisor,
    outbound,
    events,
    children,
    childWrites,
    timers,
    setNow(value: number) { now = value; }
  };
}

function legacyInitialize(id: number): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "premigration-harness", version: "0.0.0" }
    }
  } as JSONRPCRequest;
}

function initializeResult(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-fixture", version: "1.0.0" }
    }
  } as JSONRPCMessage;
}

function legacyCall(id: number, name: string, args: Record<string, unknown> = {}): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  } as JSONRPCRequest;
}

/**
 * Per-request DISTINCT modern context sentinels. Any synthesis path that
 * echoed a captured context VALUE into a reply — under any field name — would
 * make the exact-shape deepEqual assertions below diverge from the
 * fixture-derived expectation for at least one request.
 *
 * protocolVersion carries no sentinel: it must be the one SUPPORTED modern
 * revision, because an unsupported version VALUE is now answered -32022 at
 * admission and never reaches a synthesis path at all. The clientCapabilities
 * and clientInfo sentinels stay per-request unique, so a leaked context value
 * is still caught.
 */
function sentinelMeta(id: number): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_KEY]: "2026-07-28",
    [CLIENT_CAPABILITIES_KEY]: { [`cap-sentinel-${id}`]: { marker: id } },
    [CLIENT_INFO_KEY]: { name: `info-sentinel-${id}`, version: `${id}.0.0` }
  };
}

function modernCall(id: number, name: string, args: Record<string, unknown> = {}): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: sentinelMeta(id), name, arguments: args }
  } as JSONRPCRequest;
}

function modernRequest(id: number, method: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { _meta: sentinelMeta(id) }
  } as JSONRPCRequest;
}

/**
 * Fixture-derived exact expectation for a MODERN-era structured synthetic
 * reply: the corresponding legacy fixture's reply with its result extended by
 * exactly {resultType: "complete", _meta: {serverInfo identity}} — nothing
 * else may differ.
 */
function expectedModernReply(fixtureReply: Record<string, unknown>): Record<string, unknown> {
  const fixtureResult = fixtureReply.result as Record<string, unknown>;
  return {
    ...fixtureReply,
    result: {
      ...fixtureResult,
      resultType: "complete",
      _meta: { [SERVER_INFO_KEY]: { name: PACKAGE_JSON.name, version: PACKAGE_JSON.version } }
    }
  };
}

function legacyHandshake(supervisor: Harness, child: FakeChild): void {
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
}

function repliesFor(outbound: JSONRPCMessage[], id: number | string): JSONRPCMessage[] {
  return outbound.filter((message) => "id" in message && message.id === id);
}

/** Drives the overflow session exactly as the capture harness did (ids 1-6). */
function driveOverflowSession(era: "legacy" | "modern"): ReturnType<typeof createHarness> {
  const harness = createHarness(1);
  const { supervisor, children } = harness;
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  const call = era === "legacy" ? legacyCall : modernCall;
  if (era === "legacy") {
    legacyHandshake(supervisor, children[0]);
  }
  // R1 occupies the worker (pending); V arms the validate barrier from the
  // queue; N1 fills the queue to MAX_SUPERVISOR_QUEUE=2; id 5 overflows.
  supervisor.handleClientMessage(call(2, "get-runtime-metrics"));
  supervisor.handleClientMessage(call(3, "validate-project", { projectPath: "/workspace/example-mod" }));
  supervisor.handleClientMessage(call(4, "get-runtime-metrics"));
  supervisor.handleClientMessage(call(5, "get-runtime-metrics"));
  const other = era === "legacy"
    ? ({ jsonrpc: "2.0", id: 6, method: "resources/list", params: {} } as JSONRPCRequest)
    : modernRequest(6, "resources/list");
  supervisor.handleClientMessage(other);
  return harness;
}

/** Drives the restart session exactly as the capture harness did (SIGKILL exit). */
function driveRestartSession(
  era: "legacy" | "modern",
  request: (id: number) => JSONRPCRequest
): ReturnType<typeof createHarness> {
  const harness = createHarness(2);
  const { supervisor, children } = harness;
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  if (era === "legacy") {
    legacyHandshake(supervisor, children[0]);
  }
  supervisor.handleClientMessage(request(2));
  // REAL event emission (spawnWorker attached the exit/close listeners): the
  // supervisor reacts exactly as it would to a production child exit.
  children[0].emit("exit", null, "SIGKILL");
  return harness;
}

/** Drives the validate-project timeout session (deadline 10000, running phase). */
function driveTimeoutSession(era: "legacy" | "modern"): ReturnType<typeof createHarness> {
  const harness = createHarness(2, { validateProjectTimeoutMs: 10_000 });
  const { supervisor, children, timers } = harness;
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  const call = era === "legacy" ? legacyCall : modernCall;
  if (era === "legacy") {
    legacyHandshake(supervisor, children[0]);
  }
  supervisor.handleClientMessage(call(2, "validate-project", { projectPath: "/workspace/example-mod" }));
  const deadline = timers.find((timer) => timer.at === 10_000 && !timer.cleared);
  assert.ok(deadline, "the validate-project deadline timer must be armed");
  harness.setNow(10_000);
  deadline.callback();
  return harness;
}

/** Drives the startup-failure terminalization (legacy pipelined pre-ready). */
function driveStartupFailureSession(): ReturnType<typeof createHarness> {
  const harness = createHarness(2);
  const { supervisor, children } = harness;
  supervisor.spawnWorker();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleClientMessage(legacyCall(2, "get-runtime-metrics"));
  supervisor.handleClientMessage({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} } as JSONRPCRequest);
  children[0].emit("exit", 1, null);
  return harness;
}

/** Fires the armed restart retry timer and adopts the next generation. */
function adoptNextGeneration(harness: ReturnType<typeof createHarness>, expected: FakeChild): void {
  const retry = harness.timers.find((timer) => timer.at >= 100 && !timer.cleared && timer.at < 20_000);
  assert.ok(retry, "restart retry timer must be armed");
  harness.setNow(retry.at);
  retry.callback();
  assert.equal(harness.supervisor.child, expected, "the replacement generation must be current");
}

function assertUndecoratedRawError(message: JSONRPCMessage | undefined, label: string): void {
  assert.ok(message, `${label}: expected a reply`);
  const asRecord = message as unknown as Record<string, unknown>;
  assert.ok(asRecord.error, `${label}: expected a raw JSON-RPC error envelope`);
  assert.equal("result" in asRecord, false, `${label}: raw error envelope must not carry a result`);
  const serialized = JSON.stringify(message);
  assert.equal(serialized.includes("resultType"), false, `${label}: raw error envelope must not gain resultType`);
  assert.equal(serialized.includes(SERVER_INFO_KEY), false, `${label}: raw error envelope must not gain the serverInfo _meta key`);
  assert.equal(serialized.includes("ttlMs"), false, `${label}: raw error envelope must not gain ttlMs`);
  assert.equal(serialized.includes("cacheScope"), false, `${label}: raw error envelope must not gain cacheScope`);
}

function assertLateResponseDiscarded(
  harness: ReturnType<typeof createHarness>,
  child: FakeChild,
  id: number,
  label: string
): void {
  const before = repliesFor(harness.outbound, id).length;
  assert.equal(before, 1, `${label}: exactly one synthesized response must precede the late delivery`);
  harness.supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id,
    result: { late: true }
  } as JSONRPCMessage);
  assert.equal(
    repliesFor(harness.outbound, id).length,
    1,
    `${label}: a late current-generation worker response for a synthesized id must be discarded (exactly one response per id)`
  );
  assert.equal(
    harness.events.some((event) => event.event === "supervisor.late_response_discarded"),
    true,
    `${label}: the discarded late response must be logged`
  );
}

// ---------------------------------------------------------------------------
// Legacy byte-compat guard: fixture-identical shapes
// ---------------------------------------------------------------------------

test("legacy overflow replies stay byte-identical to the premigration overflow fixtures", () => {
  const harness = driveOverflowSession("legacy");
  const overflowFixture = readFixture("overflow-toolscall.json");
  const otherFixture = readFixture("overflow-other.json");

  const overflowReplies = repliesFor(harness.outbound, 5);
  assert.equal(overflowReplies.length, 1);
  assert.deepEqual(normalizeReply(overflowReplies[0]), overflowFixture.reply);

  const otherReplies = repliesFor(harness.outbound, 6);
  assert.equal(otherReplies.length, 1);
  assert.deepEqual(normalizeReply(otherReplies[0]), otherFixture.reply);
});

test("legacy restart tools/call structured reply stays byte-identical to the premigration fixture", () => {
  const harness = driveRestartSession("legacy", (id) => legacyCall(id, "get-runtime-metrics"));
  const fixture = readFixture("restart-toolscall-structured.json");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(normalizeReply(replies[0]), fixture.reply);
});

test("legacy restart non-tools/call raw -32603 reply stays byte-identical to the premigration fixture", () => {
  const harness = driveRestartSession(
    "legacy",
    (id) => ({ jsonrpc: "2.0", id, method: "resources/list", params: {} } as JSONRPCRequest)
  );
  const fixture = readFixture("restart-other-raw.json");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(normalizeReply(replies[0]), fixture.reply);
});

test("legacy validate-project timeout reply stays byte-identical to the premigration fixture", () => {
  const harness = driveTimeoutSession("legacy");
  const fixture = readFixture("timeout-validate-project.json");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(normalizeReply(replies[0]), fixture.reply);
});

test("legacy startup-failure terminalization replies stay byte-identical to the premigration fixture and occur under the legacy era", () => {
  const harness = driveStartupFailureSession();
  const fixture = readFixture("startup-failure-terminalization.json");
  const fixtureReplies = fixture.replies as Record<string, unknown>;

  // The startup-failure row is LEGACY-ONLY: the modern era has no initialize
  // replay, so the retained-initialize -32603 leg can only exist era-locked
  // legacy. Pin the era at synthesis time.
  assert.equal(harness.supervisor.era, "legacy", "startup-failure terminalization with a retained initialize must occur under the legacy era");

  const initReplies = repliesFor(harness.outbound, 1);
  assert.equal(initReplies.length, 1);
  assert.deepEqual(normalizeReply(initReplies[0]), fixtureReplies.initialize);

  const callReplies = repliesFor(harness.outbound, 2);
  assert.equal(callReplies.length, 1);
  assert.deepEqual(normalizeReply(callReplies[0]), fixtureReplies.toolsCall);

  const otherReplies = repliesFor(harness.outbound, 3);
  assert.equal(otherReplies.length, 1);
  assert.deepEqual(normalizeReply(otherReplies[0]), fixtureReplies.other);
});

// ---------------------------------------------------------------------------
// Modern-era decoration
// ---------------------------------------------------------------------------

test("modern-era structured restart synthesis carries resultType complete and the canonical server identity", () => {
  const harness = driveRestartSession("modern", (id) => modernCall(id, "get-runtime-metrics"));
  const fixture = readFixture("restart-toolscall-structured.json");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  // EXACT shape: the whole decorated reply must equal the legacy fixture's
  // reply plus exactly {resultType, _meta[serverInfo]}. The session runs with
  // per-request DISTINCT context sentinels, so any echoed context value —
  // under ANY field name — breaks this deepEqual.
  assert.deepEqual(
    normalizeReply(replies[0]),
    expectedModernReply(fixture.reply as Record<string, unknown>)
  );
});

test("modern-era validate-project timeout synthesis carries resultType complete and the canonical server identity", () => {
  const harness = driveTimeoutSession("modern");
  const fixture = readFixture("timeout-validate-project.json");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(
    normalizeReply(replies[0]),
    expectedModernReply(fixture.reply as Record<string, unknown>)
  );
});

test("modern-era queue-limit synthesis carries resultType complete and the canonical server identity", () => {
  const harness = driveOverflowSession("modern");
  const fixture = readFixture("overflow-toolscall.json");
  const replies = repliesFor(harness.outbound, 5);
  assert.equal(replies.length, 1);
  assert.deepEqual(
    normalizeReply(replies[0]),
    expectedModernReply(fixture.reply as Record<string, unknown>)
  );
});

test("modern-era raw error syntheses gain no result-only fields", () => {
  // EXACT shape: modern raw error envelopes must equal the legacy fixture
  // replies with NO additions at all.
  const overflow = driveOverflowSession("modern");
  const overflowOther = repliesFor(overflow.outbound, 6);
  assert.equal(overflowOther.length, 1);
  assert.deepEqual(normalizeReply(overflowOther[0]), readFixture("overflow-other.json").reply);
  assertUndecoratedRawError(overflowOther[0], "modern overflow other");

  const restart = driveRestartSession("modern", (id) => modernRequest(id, "resources/list"));
  const restartOther = repliesFor(restart.outbound, 2);
  assert.equal(restartOther.length, 1);
  assert.deepEqual(normalizeReply(restartOther[0]), readFixture("restart-other-raw.json").reply);
  assertUndecoratedRawError(restartOther[0], "modern restart other");
});

// ---------------------------------------------------------------------------
// Finality: exactly one response per id across the synthesis variants
// ---------------------------------------------------------------------------

test("never-forwarded queue-limit rejections record no tombstones even under a flood of distinct ids", () => {
  // A queue-limit rejection never reaches a worker, so no worker can ever
  // answer its id — a tombstone would guard nothing while letting a client
  // grow the map without bound inside a healthy generation.
  const harness = driveOverflowSession("modern");
  for (let id = 100; id < 120; id += 1) {
    harness.supervisor.handleClientMessage(
      id % 2 === 0 ? modernCall(id, "get-runtime-metrics") : modernRequest(id, "resources/list")
    );
    assert.equal(repliesFor(harness.outbound, id).length, 1, `flood id ${id} must be rejected`);
  }
  const tombstones = harness.supervisor.syntheticTombstones;
  assert.ok(tombstones, "the supervisor must keep a synthetic-tombstone map");
  assert.equal(
    tombstones.size,
    0,
    "never-forwarded rejections must record NO tombstones (bounded map under client-driven floods)"
  );
});

test("restart tools/call synthesis is final: a late current-generation response is discarded", () => {
  const harness = driveRestartSession("modern", (id) => modernCall(id, "get-runtime-metrics"));
  adoptNextGeneration(harness, harness.children[1]);
  assertLateResponseDiscarded(harness, harness.children[1], 2, "restart tools/call");
});

test("restart non-tools/call synthesis is final: a late current-generation response is discarded", () => {
  const harness = driveRestartSession("legacy", (id) => ({ jsonrpc: "2.0", id, method: "resources/list", params: {} } as JSONRPCRequest));
  adoptNextGeneration(harness, harness.children[1]);
  assertLateResponseDiscarded(harness, harness.children[1], 2, "restart other (legacy)");
});

test("validate-project timeout synthesis is final: a late current-generation response is discarded", () => {
  const harness = driveTimeoutSession("modern");
  // recoverTimedOutWorker replaced the SIGSTOPped generation; the late answer
  // arrives from the CURRENT generation (the residual risk this closes).
  assert.equal(harness.supervisor.child, harness.children[1], "the timeout recovery must have spawned the replacement generation");
  assertLateResponseDiscarded(harness, harness.children[1], 2, "validate-project timeout");
});

test("startup-failure terminalization of queued work records no tombstones", () => {
  // Every startup-failure-terminalized id (queued tools/call, queued other,
  // retained initialize) died BEFORE reaching a worker: no generation ever
  // saw them, so no worker can answer them and no tombstone is recorded.
  const harness = driveStartupFailureSession();
  for (const id of [1, 2, 3]) {
    assert.equal(repliesFor(harness.outbound, id).length, 1, `id ${id} must be terminalized exactly once`);
  }
  const tombstones = harness.supervisor.syntheticTombstones;
  assert.ok(tombstones, "the supervisor must keep a synthetic-tombstone map");
  assert.equal(
    tombstones.size,
    0,
    "startup-failure terminalization of never-forwarded work must record NO tombstones"
  );
});

// ---------------------------------------------------------------------------
// Tombstone lifecycle
// ---------------------------------------------------------------------------

test("a client retry reusing a synthesized id is served normally after re-forwarding", () => {
  const harness = driveRestartSession("modern", (id) => modernCall(id, "get-runtime-metrics"));
  adoptNextGeneration(harness, harness.children[1]);
  harness.supervisor.handleWorkerReady(harness.children[1]);

  // The synthesized reply told the client to retry; a retry may legally reuse
  // the id. The retry must be forwarded and its worker answer must reach the
  // client (finality is per request instance, not per id forever).
  harness.supervisor.handleClientMessage(modernCall(2, "get-runtime-metrics"));
  assert.equal(
    harness.childWrites[1].some((frame) => frame.includes('"id":2')),
    true,
    "the retried id must be forwarded to the current generation"
  );

  // Direct injection tagged with the OLD (pre-restart) child object. The
  // load-bearing invariant here is the pre-existing CHILD-IDENTITY GUARD —
  // handleWorkerMessage's leading `child !== this.child` check: the retry's
  // re-forward cleared the id's tombstone, so that guard is the only thing
  // standing between a stale generation's frame and the client.
  harness.supervisor.handleWorkerMessage(harness.children[0], {
    jsonrpc: "2.0",
    id: 2,
    result: { staleGeneration: true }
  } as JSONRPCMessage);
  assert.equal(
    repliesFor(harness.outbound, 2).length,
    1,
    "a stale-generation frame for the retried id must be dropped by the child-identity guard"
  );

  harness.supervisor.handleWorkerMessage(harness.children[1], {
    jsonrpc: "2.0",
    id: 2,
    result: { served: true }
  } as JSONRPCMessage);
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 2, "the retry must produce exactly one genuine response (one per request instance)");
  assert.deepEqual(replies.at(-1), { jsonrpc: "2.0", id: 2, result: { served: true } });
});

test("tombstones are bounded: entries are dropped once their generation is gone with streams closed, while current-generation discard still works", () => {
  const harness = driveRestartSession("modern", (id) => modernCall(id, "get-runtime-metrics"));
  const tombstones = harness.supervisor.syntheticTombstones;
  assert.ok(tombstones, "the supervisor must keep a synthetic-tombstone map");
  assert.equal(tombstones.size, 1, "the restart synthesis must record one tombstone");

  adoptNextGeneration(harness, harness.children[1]);
  // Discard still works while the tombstone is retained (current generation).
  assertLateResponseDiscarded(harness, harness.children[1], 2, "pre-purge discard");

  // Generation 1's process is gone AND its streams are closed ('close' fires
  // only after both) -> its tombstones may be dropped.
  harness.children[0].emit("close", null, "SIGKILL");
  assert.equal(tombstones.size, 0, "tombstones for a closed generation must be dropped");
});

test("tombstone purge is generation-selective: a newer generation's tombstone survives an older generation's close", () => {
  const harness = createHarness(3, { validateProjectTimeoutMs: 10_000 });
  const { supervisor, children, timers } = harness;

  // Generation 1: forward id 2, then die (REAL exit emission) -> restart
  // synthesis records a generation-1 tombstone.
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleClientMessage(modernCall(2, "get-runtime-metrics"));
  children[0].emit("exit", null, "SIGKILL");
  adoptNextGeneration(harness, children[1]);
  supervisor.handleWorkerReady(children[1]);

  // Generation 2: forward a validate-project and drive the running-phase
  // deadline -> a generation-2 tombstone while generation 1 is still un-closed.
  supervisor.handleClientMessage(modernCall(3, "validate-project", { projectPath: "/workspace/example-mod" }));
  const deadline = timers.find((timer) => timer.at === 10_100 && !timer.cleared);
  assert.ok(deadline, "the validate-project deadline timer must be armed on generation 2");
  harness.setNow(10_100);
  deadline.callback();
  assert.equal(supervisor.child, children[2], "timeout recovery must spawn generation 3");

  const tombstones = supervisor.syntheticTombstones;
  assert.ok(tombstones, "the supervisor must keep a synthetic-tombstone map");
  assert.equal(tombstones.size, 2, "both forwarded syntheses must be tombstoned");

  // Complete generation 1's lifecycle for REAL: 'close' purges generation-1
  // entries and ONLY those (an unconditional clear would fail below).
  children[0].emit("close", null, "SIGKILL");
  assert.equal(tombstones.has("number:2"), false, "the generation-1 tombstone must be purged by generation 1's close");
  assert.equal(tombstones.has("number:3"), true, "the generation-2 tombstone must SURVIVE generation 1's close");

  // The surviving tombstone still discards a late response delivered via the
  // current generation.
  assertLateResponseDiscarded(harness, children[2], 3, "post-gen-1-close timeout");
});
