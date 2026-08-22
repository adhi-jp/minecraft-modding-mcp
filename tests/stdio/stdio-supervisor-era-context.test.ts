import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * Per-request protocol-context carriage — the supervisor captures
 * {era, protocolVersion, clientCapabilities, clientInfo?} into pending/queued
 * request snapshots at admission and carries them across worker restarts.
 * Capture-and-carry with one carve-out: synthetic decoration reads the
 * snapshot's `era` (and only `era`) to gate modern-era result decoration; the
 * three captured context fields stay unread — no reply, synthesis,
 * decoration, or forwarded frame may depend on them (the no-leak tests pin
 * that invariant for downstream consumers).
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

type CapturedSnapshot = {
  id: string | number;
  method?: string;
  toolName?: string;
  era?: string;
  protocolVersion?: string;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: unknown;
};

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
  liveChildren: Set<FakeChild>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: CapturedSnapshot }>;
  pendingRequests: Map<string, CapturedSnapshot>;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  handleWorkerExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void;
  spawnWorker(): void;
  scheduleRestart(failedAttempt?: boolean): void;
  shutdown(): Promise<void>;
};

function createWorker(pid: number, writes: string[]): FakeChild {
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
    return createWorker(99_200_000 + index, writes);
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

type SentinelMeta = {
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: unknown;
};

function modernMeta(sentinel: SentinelMeta): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [PROTOCOL_VERSION_KEY]: sentinel.protocolVersion,
    [CLIENT_CAPABILITIES_KEY]: sentinel.clientCapabilities
  };
  if ("clientInfo" in sentinel) {
    meta[CLIENT_INFO_KEY] = sentinel.clientInfo;
  }
  return meta;
}

function modernCall(id: number, sentinel: SentinelMeta): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: modernMeta(sentinel), name: "list-versions", arguments: {} }
  } as JSONRPCRequest;
}

function legacyInitialize(id: number, extraParams: Record<string, unknown> = {}): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-context-test", version: "1.0.0" },
      ...extraParams
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

/** Parses the JSON body of a Content-Length-framed worker-bound frame. */
function parseWorkerFrame(frame: string): Record<string, unknown> {
  const headerEnd = frame.indexOf("\r\n\r\n");
  return JSON.parse(headerEnd >= 0 ? frame.slice(headerEnd + 4) : frame) as Record<string, unknown>;
}

function workerFrameById(writes: string[], id: number): Record<string, unknown> {
  const parsed = writes.map(parseWorkerFrame);
  const frame = parsed.find((entry) => entry.id === id);
  assert.ok(frame, `expected a worker-bound frame with id ${id}`);
  return frame;
}

function frameMeta(frame: Record<string, unknown>): Record<string, unknown> {
  const params = frame.params as { _meta?: Record<string, unknown> } | undefined;
  assert.ok(params?._meta, "expected the worker-bound frame to carry params._meta");
  return params._meta;
}

function collectKeysDeep(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeysDeep(entry, keys);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeysDeep(entry, keys);
    }
  }
}

function assertNoContextLeak(reply: JSONRPCMessage, label: string): void {
  const keys = new Set<string>();
  collectKeysDeep(reply, keys);
  for (const forbidden of ["era", "protocolVersion", "clientCapabilities", "clientInfo"]) {
    assert.equal(keys.has(forbidden), false, `${label}: reply must not carry a "${forbidden}" key`);
  }
  const serialized = JSON.stringify(reply);
  // EVERY reserved-namespace occurrence in the reply must be exactly the
  // SERVER-side identity key — the era carve-out is bounded both ways: the
  // serverInfo stamp is legitimate on decorated modern-era synthetic results
  // (canonical server identity, not captured request context), while any
  // OTHER io.modelcontextprotocol/* occurrence (the request-context keys
  // included) is a leak.
  const reservedOccurrences = serialized.match(/io\.modelcontextprotocol\/[^"\\]*/g) ?? [];
  for (const occurrence of reservedOccurrences) {
    assert.equal(
      occurrence,
      SERVER_INFO_KEY,
      `${label}: unexpected reserved-namespace occurrence "${occurrence}"`
    );
  }
  assert.equal(serialized.includes("sentinel-noleak"), false, `${label}: reply must not embed the captured clientInfo sentinel`);
}

/** The decorated modern synthetic reply must positively CARRY the identity stamp. */
function assertServerIdentityStamped(reply: JSONRPCMessage, label: string): void {
  const meta = (reply as { result?: { _meta?: Record<string, unknown> } }).result?._meta;
  assert.ok(
    meta && meta[SERVER_INFO_KEY],
    `${label}: the decorated modern synthetic result must carry _meta["${SERVER_INFO_KEY}"]`
  );
}

test("admission captures era and the verbatim modern protocol context into the pending snapshot", () => {
  const { supervisor } = createEraHarness();
  const clientCapabilities = { sampling: {} };
  const clientInfo = { name: "sentinel-a", version: "1" };
  supervisor.handleClientMessage(
    modernCall(1, { protocolVersion: "2026-07-28", clientCapabilities, clientInfo })
  );

  const pending = supervisor.pendingRequests.get("number:1");
  assert.ok(pending, "the admitted modern call must have a pending snapshot");
  assert.equal(pending.era, "modern", "the snapshot must carry the era at admission");
  assert.equal(pending.protocolVersion, "2026-07-28");
  assert.equal(pending.clientCapabilities, clientCapabilities, "clientCapabilities must be captured as-is (shallow, same reference)");
  assert.equal(pending.clientInfo, clientInfo, "clientInfo must be captured as-is (shallow, same reference)");
  assert.deepEqual(pending.clientCapabilities, { sampling: {} });
  assert.deepEqual(pending.clientInfo, { name: "sentinel-a", version: "1" });
});

test("a claim-less legacy tools/call carries era legacy and no invented protocol context", () => {
  const { supervisor, child } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list-versions", arguments: {} }
  } as JSONRPCRequest);

  const pending = supervisor.pendingRequests.get("number:2");
  assert.ok(pending, "the claim-less legacy call must have a pending snapshot");
  assert.equal(pending.era, "legacy");
  assert.equal(pending.protocolVersion, undefined, "claim-less traffic must not gain an invented protocolVersion");
  assert.equal(pending.clientCapabilities, undefined, "claim-less traffic must not gain invented clientCapabilities");
  assert.equal(pending.clientInfo, undefined, "claim-less traffic must not gain an invented clientInfo");
});

test("an era-neutral modern discover admitted before any lock carries era unselected with its context and still does not lock", () => {
  const { supervisor } = createEraHarness();
  const clientCapabilities = { sampling: {} };
  const clientInfo = { name: "sentinel-a", version: "1" };
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: modernMeta({ protocolVersion: "2026-07-28", clientCapabilities, clientInfo }) }
  } as JSONRPCRequest);

  const pending = supervisor.pendingRequests.get("number:1");
  assert.ok(pending, "the era-neutral discover must have a pending snapshot");
  assert.equal(pending.era, "unselected", "an unlocked discover admission must snapshot the unselected era");
  assert.equal(pending.protocolVersion, "2026-07-28");
  assert.deepEqual(pending.clientCapabilities, { sampling: {} });
  assert.deepEqual(pending.clientInfo, { name: "sentinel-a", version: "1" });
  assert.equal(supervisor.era, "unselected", "the era-neutral discover must not lock the era");
});

test("two back-to-back modern requests hold their own context simultaneously and each worker frame carries its own _meta verbatim", () => {
  const { supervisor, workerWrites } = createEraHarness();
  // The distinguishing sentinels are clientCapabilities and clientInfo: a
  // last-seen-global context carrier would collapse both requests onto the
  // second one's values. (This test used an UNSUPPORTED protocolVersion as a
  // third sentinel; unsupported versions are now answered -32022 at admission
  // and never reach a pending snapshot at all, so per-request carriage of
  // DIFFERENT version values is pinned over the wire instead — see the
  // concurrent -32022 test in stdio-supervisor-era-wire.test.ts.)
  const capsA = { sampling: {} };
  const capsB = { elicitation: {} };
  const infoA = { name: "sentinel-a", version: "1" };
  const infoB = { name: "sentinel-b", version: "2" };
  supervisor.handleClientMessage(
    modernCall(1, { protocolVersion: "2026-07-28", clientCapabilities: capsA, clientInfo: infoA })
  );
  supervisor.handleClientMessage(
    modernCall(2, { protocolVersion: "2026-07-28", clientCapabilities: capsB, clientInfo: infoB })
  );

  // Both snapshots must hold their OWN values BEFORE any response — a
  // last-seen-global carrier would collapse them onto the second request.
  const first = supervisor.pendingRequests.get("number:1");
  const second = supervisor.pendingRequests.get("number:2");
  assert.ok(first && second, "both concurrent modern calls must have pending snapshots");
  assert.equal(first.era, "modern");
  assert.equal(second.era, "modern");
  assert.equal(first.protocolVersion, "2026-07-28");
  assert.equal(second.protocolVersion, "2026-07-28");
  assert.equal(first.clientCapabilities, capsA);
  assert.equal(second.clientCapabilities, capsB);
  assert.equal(first.clientInfo, infoA);
  assert.equal(second.clientInfo, infoB);

  // The worker-bound frames each carry their own _meta verbatim.
  const metaA = frameMeta(workerFrameById(workerWrites, 1));
  const metaB = frameMeta(workerFrameById(workerWrites, 2));
  assert.equal(metaA[PROTOCOL_VERSION_KEY], "2026-07-28");
  assert.equal(metaB[PROTOCOL_VERSION_KEY], "2026-07-28");
  assert.deepEqual(metaA[CLIENT_CAPABILITIES_KEY], { sampling: {} });
  assert.deepEqual(metaB[CLIENT_CAPABILITIES_KEY], { elicitation: {} });
  assert.deepEqual(metaA[CLIENT_INFO_KEY], { name: "sentinel-a", version: "1" });
  assert.deepEqual(metaB[CLIENT_INFO_KEY], { name: "sentinel-b", version: "2" });
});

test("an unsupported modern protocolVersion is answered -32022 at admission and captures no request context", () => {
  const { supervisor, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(
    modernCall(1, {
      protocolVersion: "2027-09-09",
      clientCapabilities: { sampling: {} },
      clientInfo: { name: "sentinel-a", version: "1" }
    })
  );

  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32022,
      message: "Unsupported protocol version: 2027-09-09",
      data: { supported: ["2026-07-28"], requested: "2027-09-09" }
    }
  });
  assert.equal(workerWrites.length, 0, "an unsupported version must never reach the worker");
  assert.equal(supervisor.pendingRequests.size, 0, "a rejected request captures no snapshot");
  // The shallow claim still locked the era, exactly as documented.
  assert.equal(supervisor.era, "modern", "an unsupported version string still locks modern");
});

test("a modern request queued while the worker is down carries its context through restart and release unchanged", () => {
  const harness = createGenerationHarness(2);
  const { supervisor, children, childWrites, timers } = harness;

  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleClientMessage(
    modernCall(1, { protocolVersion: "2026-07-28", clientCapabilities: {} })
  );
  supervisor.handleWorkerMessage(children[0], { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  supervisor.handleWorkerExit(children[0], 1, null);

  const clientCapabilities = { sampling: {} };
  const clientInfo = { name: "sentinel-a", version: "1" };
  supervisor.handleClientMessage(
    modernCall(3, { protocolVersion: "2026-07-28", clientCapabilities, clientInfo })
  );
  assert.equal(supervisor.queuedRequests.length, 1, "the modern request must queue while the worker is down");
  const queued = supervisor.queuedRequests[0].pending;
  assert.equal(queued.era, "modern", "the queued snapshot must carry the era captured at admission");
  assert.equal(queued.protocolVersion, "2026-07-28");
  assert.equal(queued.clientCapabilities, clientCapabilities);
  assert.equal(queued.clientInfo, clientInfo);

  const retry = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry, "restart retry timer must be armed");
  harness.setNow(100);
  retry.callback();
  assert.equal(supervisor.child, children[1]);
  supervisor.handleWorkerReady(children[1]);

  // The released gen-2 frame carries the SAME _meta verbatim.
  const meta = frameMeta(workerFrameById(childWrites[1], 3));
  assert.equal(meta[PROTOCOL_VERSION_KEY], "2026-07-28");
  assert.deepEqual(meta[CLIENT_CAPABILITIES_KEY], { sampling: {} });
  assert.deepEqual(meta[CLIENT_INFO_KEY], { name: "sentinel-a", version: "1" });

  // The still-pending snapshot (now in flight on gen 2) still holds the context.
  const pending = supervisor.pendingRequests.get("number:3");
  assert.ok(pending, "the released request must be pending on the replacement generation");
  assert.equal(pending.era, "modern");
  assert.equal(pending.protocolVersion, "2026-07-28");
  assert.equal(pending.clientCapabilities, clientCapabilities);
  assert.equal(pending.clientInfo, clientInfo);
});

test("a legacy initialize snapshot carries era legacy and no modern context fields even when it carries a _meta envelope", () => {
  const { supervisor } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));

  const plain = supervisor.pendingRequests.get("number:1");
  assert.ok(plain, "the initialize must have a pending snapshot");
  assert.equal(plain.era, "legacy", "an initialize snapshot's era is legacy");
  assert.equal(plain.protocolVersion, undefined);
  assert.equal(plain.clientCapabilities, undefined);
  assert.equal(plain.clientInfo, undefined);

  // initialize is the legacy signal regardless of any _meta envelope it
  // carries; the envelope is ignored for era classification AND for capture.
  supervisor.handleClientMessage(
    legacyInitialize(2, {
      _meta: modernMeta({
        protocolVersion: "2026-07-28",
        clientCapabilities: { sampling: {} },
        clientInfo: { name: "sentinel-a", version: "1" }
      })
    })
  );
  const enveloped = supervisor.pendingRequests.get("number:2");
  assert.ok(enveloped, "the enveloped initialize must have a pending snapshot");
  assert.equal(enveloped.era, "legacy");
  assert.equal(enveloped.protocolVersion, undefined, "an initialize envelope must never be captured as protocol context");
  assert.equal(enveloped.clientCapabilities, undefined);
  assert.equal(enveloped.clientInfo, undefined);
});

test("captured context never leaks into worker-exit synthesis or queue-limit replies", () => {
  const harness = createGenerationHarness(1);
  const { supervisor, outbound, children } = harness;

  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  const sentinel: SentinelMeta = {
    protocolVersion: "2026-07-28",
    clientCapabilities: { sampling: {} },
    clientInfo: { name: "sentinel-noleak", version: "1" }
  };
  supervisor.handleClientMessage(modernCall(1, sentinel));
  const pendingBeforeExit = supervisor.pendingRequests.get("number:1");
  assert.ok(pendingBeforeExit, "precondition: the modern call must be pending before the exit");

  supervisor.handleWorkerExit(children[0], 1, null);
  const restartReply = outbound.find((message) => (message as { id?: unknown }).id === 1);
  assert.ok(restartReply, "the worker exit must synthesize a restart reply for the pending modern call");
  const structured = (restartReply as {
    result?: { structuredContent?: { error?: { code?: unknown } } };
  }).result?.structuredContent;
  assert.equal(structured?.error?.code, "ERR_WORKER_RESTART", "precondition: the structured restart envelope must be used");
  assertNoContextLeak(restartReply, "worker-restart synthesis");
  assertServerIdentityStamped(restartReply, "worker-restart synthesis");

  // Queue-limit reply: worker down, fill the queue, then overflow with a
  // context-carrying modern call.
  supervisor.handleClientMessage(modernCall(11, sentinel));
  supervisor.handleClientMessage(modernCall(12, sentinel));
  assert.equal(supervisor.queuedRequests.length, 2, "precondition: the supervisor queue must be full");
  supervisor.handleClientMessage(modernCall(13, sentinel));
  const limitReply = outbound.find((message) => (message as { id?: unknown }).id === 13);
  assert.ok(limitReply, "the overflow modern call must receive a queue-limit reply");
  const limitStructured = (limitReply as {
    result?: { structuredContent?: { error?: { code?: unknown } } };
  }).result?.structuredContent;
  assert.equal(limitStructured?.error?.code, "ERR_LIMIT_EXCEEDED", "precondition: the queue-limit envelope must be used");
  assertNoContextLeak(limitReply, "queue-limit reply");
  assertServerIdentityStamped(limitReply, "queue-limit reply");
});
