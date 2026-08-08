import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * Supervisor era lifecycle — era-gated initialize replay across worker
 * generations, purge-on-modern-lock, server/discover era neutrality, and the
 * capture-ordering fix (a REJECTED initialize must never enter the replay
 * cache).
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

const ERA_CONFLICT_LEGACY_MESSAGE =
  "Modern per-request _meta request rejected: this server process is era-locked to the legacy initialize handshake, so requests carrying the modern per-request _meta envelope can no longer be accepted. Supported protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (legacy initialize handshake) and 2026-07-28 (modern per-request _meta). To use the modern era, start a fresh process: close this transport, terminate and respawn the configured server command as a fresh stdio process, discard or re-issue any pending request ids, then send a request carrying the required io.modelcontextprotocol/* _meta envelope.";

const MISSING_META_UNSELECTED_MESSAGE =
  "Request rejected: no protocol era is selected yet and this request carries no valid era signal. Either send initialize followed by notifications/initialized to select the legacy handshake, or include the required io.modelcontextprotocol/* keys (io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities) in params._meta to select protocol revision 2026-07-28.";

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type FakeScheduledTimer = NodeJS.Timeout & {
  at: number;
  callback: () => void;
  cleared: boolean;
};

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  era?: unknown;
  initializeRequest?: JSONRPCRequest;
  initializedNotification?: JSONRPCMessage;
  clientInitialized?: boolean;
  replayingInitialization?: boolean;
  initializeSentToWorker?: boolean;
  liveChildren: Set<FakeChild>;
  unresolvedTreeTokens: Set<number>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number } }>;
  queuedNotifications: JSONRPCMessage[];
  pendingRequests: Map<string, unknown>;
  restartTimer?: NodeJS.Timeout;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  handleWorkerExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void;
  spawnWorker(): void;
  scheduleRestart(failedAttempt?: boolean): void;
  shutdown(): Promise<void>;
};

function createWorker(pid: number, writes: string[]): FakeChild {
  // EventEmitter-backed streams so the REAL spawnWorker() can attach its
  // data/error/exit listeners to injected children.
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  stdin.destroyed = false;
  stdin.write = (payload: string) => {
    writes.push(payload);
    return true;
  };
  const child = new EventEmitter() as EventEmitter & FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = new EventEmitter() as EventEmitter & FakeChild["stdout"];
  child.stderr = new EventEmitter() as EventEmitter & FakeChild["stderr"];
  child.kill = () => true;
  return child;
}

function createEraHarness(): {
  supervisor: Harness;
  child: FakeChild;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {}
  } as never) as unknown as Harness;
  const child = createWorker(321, workerWrites);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  return { supervisor, child, outbound, workerWrites };
}

function createGenerationHarness(childCount: number): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  children: FakeChild[];
  childWrites: string[][];
  timers: FakeScheduledTimer[];
  setNow(value: number): void;
} {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const childWrites: string[][] = [];
  const children = Array.from({ length: childCount }, (_, index) => {
    const writes: string[] = [];
    childWrites.push(writes);
    return createWorker(99_100_000 + index, writes);
  });
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {},
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
    children,
    childWrites,
    timers,
    setNow(value: number) { now = value; }
  };
}

function modernMeta(): Record<string, unknown> {
  return { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };
}

function modernCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: modernMeta(), name, arguments: {} }
  } as JSONRPCRequest;
}

function modernDiscover(id: number): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: { _meta: modernMeta() }
  } as JSONRPCRequest;
}

function legacyInitialize(id: number): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-lifecycle-test", version: "1.0.0" }
    }
  } as JSONRPCRequest;
}

function initializeResult(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "era-fixture", version: "1.0.0" }
    }
  } as JSONRPCMessage;
}

function countFrames(writes: string[], methodSnippet: string): number {
  return writes.filter((frame) => frame.includes(methodSnippet)).length;
}

test("era lock is one-way across worker generations: a modern-locked process never replays initialize and still releases queued modern work", () => {
  const harness = createGenerationHarness(2);
  const { supervisor, outbound, children, childWrites, timers } = harness;

  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  assert.equal(countFrames(childWrites[0], '"method":"tools/call"'), 1);
  supervisor.handleWorkerMessage(children[0], { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  supervisor.handleClientMessage(legacyInitialize(2));
  const conflict = outbound.at(-1) as { id?: number; error?: { code?: number; data?: { kind?: string } } };
  assert.equal(conflict.id, 2);
  assert.equal(conflict.error?.code, -32601);
  assert.equal(conflict.error?.data?.kind, "era_conflict");
  assert.equal(supervisor.initializeRequest, undefined, "an era-conflict-rejected initialize must never enter the replay cache");
  assert.equal(countFrames(childWrites[0], '"method":"initialize"'), 0);

  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(supervisor.initializedNotification, undefined, "a stray initialized must not be captured in the modern era");

  supervisor.handleWorkerExit(children[0], 1, null);
  supervisor.handleClientMessage(modernCall(3, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 1, "modern request must queue while the worker is down");

  const retry = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry, "restart retry timer must be armed");
  harness.setNow(100);
  retry.callback();
  assert.equal(supervisor.child, children[1]);
  supervisor.handleWorkerReady(children[1]);

  // Positive control: an empty second-generation capture must fail the test.
  assert.equal(childWrites[1].length > 0, true, "released queued modern work must reach the replacement worker");
  assert.equal(countFrames(childWrites[1], '"method":"initialize"'), 0, "no initialize may ever reach a modern-locked generation");
  assert.equal(countFrames(childWrites[1], '"method":"notifications/initialized"'), 0, "no initialized notification may ever reach a modern-locked generation");
  assert.equal(countFrames(childWrites[1], '"method":"tools/call"'), 1);
  assert.equal(childWrites[1].some((frame) => frame.includes('"id":3')), true);

  supervisor.handleWorkerMessage(children[1], { jsonrpc: "2.0", id: 3, result: { served: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 3, result: { served: true } });

  supervisor.handleClientMessage(legacyInitialize(4));
  const secondConflict = outbound.at(-1) as { error?: { code?: number; data?: { kind?: string } } };
  assert.equal(secondConflict.error?.code, -32601, "the era lock must survive the worker restart");
  assert.equal(secondConflict.error?.data?.kind, "era_conflict");
});

test("modern lock purges cached legacy lifecycle state so replay can never target a modern worker", () => {
  const { supervisor, child, workerWrites } = createEraHarness();
  // Defensive purge: no admission path should leave legacy lifecycle state in
  // an unselected process, but the modern lock must still clear all of it so
  // no later generation can ever see initialize/notifications/initialized.
  supervisor.initializeRequest = legacyInitialize(91);
  supervisor.initializedNotification = { jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage;
  supervisor.clientInitialized = true;
  supervisor.replayingInitialization = true;
  supervisor.initializeSentToWorker = true;

  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  assert.equal(supervisor.initializeRequest, undefined, "modern lock must purge the cached initialize request");
  assert.equal(supervisor.initializedNotification, undefined, "modern lock must purge the cached initialized notification");
  assert.equal(supervisor.clientInitialized, false, "modern lock must clear clientInitialized");
  assert.equal(supervisor.replayingInitialization, false, "modern lock must clear replayingInitialization");
  assert.equal(supervisor.initializeSentToWorker, false, "modern lock must clear initializeSentToWorker");
  assert.equal(countFrames(workerWrites, '"method":"initialize"'), 0);
});

test("modern-signal request after legacy lock is rejected -32600 era_conflict with the frozen message", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  const writesAfterHandshake = workerWrites.length;

  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  assert.equal(workerWrites.length, writesAfterHandshake, "an era-conflicting modern request must never be forwarded");
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32600,
      message: ERA_CONFLICT_LEGACY_MESSAGE,
      data: {
        kind: "era_conflict",
        selectedEra: "legacy",
        requestedEra: "modern",
        supported: ERA_SUPPORTED_VERSIONS
      }
    }
  });
});

test("legacy replay across restart is unchanged and the supervisor reports the legacy era", () => {
  const harness = createGenerationHarness(2);
  const { supervisor, children, childWrites, timers } = harness;

  supervisor.spawnWorker();
  supervisor.handleClientMessage(legacyInitialize(72));
  supervisor.handleWorkerReady(children[0]);
  assert.equal(countFrames(childWrites[0], '"method":"initialize"'), 1);
  supervisor.handleWorkerMessage(children[0], initializeResult(72));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(countFrames(childWrites[0], '"method":"notifications/initialized"'), 1);

  supervisor.handleWorkerExit(children[0], 1, null);
  const retry = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry);
  harness.setNow(100);
  retry.callback();
  supervisor.handleWorkerReady(children[1]);
  assert.equal(countFrames(childWrites[1], '"method":"initialize"'), 1, "legacy replay must still fire on the replacement generation");
  supervisor.handleWorkerMessage(children[1], initializeResult(72));
  assert.equal(countFrames(childWrites[1], '"method":"notifications/initialized"'), 1, "legacy replay must still re-send notifications/initialized");

  assert.equal(supervisor.era, "legacy", "the supervisor must report the legacy era after a legacy handshake");
});

test("unselected modern-signal discover forwards without locking and a pipelined initialize still locks legacy", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernDiscover(1));
  assert.equal(countFrames(workerWrites, '"method":"server/discover"'), 1, "era-neutral discover must forward while unselected");

  supervisor.handleClientMessage(legacyInitialize(2));
  assert.equal(countFrames(workerWrites, '"method":"initialize"'), 1, "the pipelined initialize must still be admitted and lock legacy");

  // Out-of-order answers: initialize first, then the discover by its own id.
  supervisor.handleWorkerMessage(child, initializeResult(2));
  assert.equal((outbound.at(-1) as { id?: number }).id, 2);
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    result: { supportedVersions: ["2026-07-28"] }
  } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 1,
    result: { supportedVersions: ["2026-07-28"] }
  });

  supervisor.handleClientMessage(modernCall(3, "list-versions"));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32600, "discover must NOT have locked modern: initialize owns the era lock");
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("worker-down modern discover queues, releases on readiness, and does not lock the era", () => {
  const outbound: JSONRPCMessage[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {}
  } as never) as unknown as Harness;
  supervisor.scheduleRestart = () => {};

  supervisor.handleClientMessage(modernDiscover(1));
  assert.equal(supervisor.queuedRequests.length, 1, "worker-down discover must queue like an ordinary request");
  assert.equal(outbound.length, 0);

  const workerWrites: string[] = [];
  const child = createWorker(99_100_050, workerWrites);
  supervisor.child = child;
  supervisor.liveChildren.add(child);
  supervisor.handleWorkerReady(child);
  assert.equal(countFrames(workerWrites, '"method":"server/discover"'), 1, "queued discover must release on worker readiness");
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    result: { supportedVersions: ["2026-07-28"] }
  } as JSONRPCMessage);
  assert.equal((outbound.at(-1) as { id?: number }).id, 1);

  supervisor.handleClientMessage(legacyInitialize(2));
  assert.equal(countFrames(workerWrites, '"method":"initialize"'), 1, "the released discover must not have locked modern");
  supervisor.handleWorkerMessage(child, initializeResult(2));
  assert.equal((outbound.at(-1) as { id?: number; error?: unknown }).id, 2);
  assert.equal((outbound.at(-1) as { error?: unknown }).error, undefined);

  supervisor.handleClientMessage(modernCall(3, "list-versions"));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32600);
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("unselected claim-less discover is rejected -32602 missing_meta", () => {
  const { supervisor, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {}
  } as JSONRPCRequest);

  assert.equal(workerWrites.length, 0);
  assert.deepEqual(outbound[0], {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32602,
      message: MISSING_META_UNSELECTED_MESSAGE,
      data: {
        kind: "missing_meta",
        missing: [PROTOCOL_VERSION_KEY, CLIENT_CAPABILITIES_KEY]
      }
    }
  });
});

test("legacy-locked discover forwards as legacy traffic and the worker's -32601 reaches the client", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  const writesAfterHandshake = workerWrites.length;

  // Discover is era-neutral: even a modern-signal discover forwards under the
  // legacy lock (exempt from the -32600 era_conflict rule); the legacy-pinned
  // worker answers -32601 for the unregistered method.
  supervisor.handleClientMessage(modernDiscover(5));
  assert.equal(workerWrites.length, writesAfterHandshake + 1);
  assert.equal(countFrames(workerWrites, '"method":"server/discover"'), 1);
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32601, message: "Method not found" }
  } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32601, message: "Method not found" }
  });

  supervisor.handleClientMessage(modernCall(6, "list-versions"));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32600, "the forwarded discover must not have flipped the era");
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("a cap-blocked re-initialize is rejected without corrupting the captured legacy lifecycle", () => {
  const { supervisor, child, outbound } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(supervisor.clientInitialized, true);

  // Live-cap saturation with no active child: the re-initialize must be
  // rejected AND must never touch the replay cache (capture-ordering fix —
  // previously the rejected initialize was captured first and the rejection
  // path then wiped the ORIGINAL handshake too).
  supervisor.child = undefined;
  supervisor.liveChildren.clear();
  supervisor.unresolvedTreeTokens.add(1001);
  supervisor.unresolvedTreeTokens.add(1002);

  supervisor.handleClientMessage(legacyInitialize(9));
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 9,
    error: {
      code: -32603,
      message: "MCP worker restarted while handling the request. Retry the request."
    }
  });
  assert.equal((supervisor.initializeRequest as { id?: unknown } | undefined)?.id, 1, "the ORIGINAL captured initialize must survive a rejected re-initialize");
  assert.equal(supervisor.clientInitialized, true, "the completed handshake state must survive a rejected re-initialize");
});

test("a claim-less cancellation after a modern-locked restart never becomes the fresh generation's first frame", () => {
  const harness = createGenerationHarness(2);
  const { supervisor, children, childWrites, timers } = harness;

  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(children[0], { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  supervisor.handleWorkerExit(children[0], 1, null);
  const retry = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry);
  harness.setNow(100);
  retry.callback();
  supervisor.handleWorkerReady(children[1]);
  assert.equal(childWrites[1].length, 0);

  // The claim-less cancellation would be the fresh connection's FIRST frame;
  // the SDK would classify that opening frame legacy and pin the worker
  // against the modern-locked supervisor.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 99 }
  } as JSONRPCMessage);
  assert.equal(childWrites[1].length, 0, "the claim-less cancellation must never open a modern-locked generation");

  // Positive control: the next modern request is the true first frame.
  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  assert.equal(childWrites[1].length, 1);
  assert.equal(countFrames(childWrites[1], '"method":"tools/call"'), 1);
  assert.equal(childWrites[1][0].includes('"id":2'), true);
});

test("a cap-rejected initialize locks legacy without capture and a stray initialized is neither captured nor delivered later", () => {
  const outbound: JSONRPCMessage[] = [];
  const events: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details })
  } as never) as unknown as Harness;
  supervisor.unresolvedTreeTokens.add(1001);
  supervisor.unresolvedTreeTokens.add(1002);

  supervisor.handleClientMessage(legacyInitialize(1));
  assert.equal((outbound.at(-1) as { error?: { code?: number } }).error?.code, -32603);
  assert.equal(supervisor.era, "legacy", "even a cap-rejected initialize locks the legacy era at admission");
  assert.equal(supervisor.initializeRequest, undefined, "a cap-rejected initialize is never captured");

  // No handshake is in progress (nothing captured): a stray initialized must
  // be dropped, not captured — otherwise it could later be replayed around an
  // uninitialized worker.
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(supervisor.initializedNotification, undefined, "a stray initialized outside an in-progress handshake must not be captured");
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/initialized", reason: "no-active-handshake" }
  });

  // A later worker generation never receives the stray frame.
  supervisor.unresolvedTreeTokens.clear();
  const workerWrites: string[] = [];
  const child = createWorker(99_100_060, workerWrites);
  supervisor.child = child;
  supervisor.liveChildren.add(child);
  supervisor.handleWorkerReady(child);
  assert.equal(workerWrites.length, 0, "nothing may replay: no handshake was ever captured");

  // A REAL initialize + initialized handshake then works normally.
  supervisor.handleClientMessage(legacyInitialize(2));
  assert.equal(countFrames(workerWrites, '"method":"initialize"'), 1);
  supervisor.handleWorkerMessage(child, initializeResult(2));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.notEqual(supervisor.initializedNotification, undefined, "initialized within a real handshake must be captured");
  assert.equal(countFrames(workerWrites, '"method":"notifications/initialized"'), 1);
});

test("unselected cancellation targeting an in-flight discover stays supervisor-side and the discover still answers", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernDiscover(1));
  assert.equal(workerWrites.length, 1);

  // Accepted limitation: the cancellation cannot be delivered without
  // legacy-pinning the worker connection, so an in-flight era-neutral
  // discover is not cancellable server-side; supervisor bookkeeping only.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1, "the unselected-state cancellation must not be forwarded");
  assert.equal(outbound.length, 0);

  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    result: { supportedVersions: ["2026-07-28"] }
  } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 1,
    result: { supportedVersions: ["2026-07-28"] }
  });
});
