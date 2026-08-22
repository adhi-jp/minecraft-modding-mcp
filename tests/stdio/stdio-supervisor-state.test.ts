import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  staleChildren: Set<FakeChild>;
  cleanupStates: Map<FakeChild, { pid: number; status: "pending" | "accepted" | "unresolved"; parentExited: boolean }>;
  unresolvedTreeTokens: Set<number>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number } }>;
  pendingRequests: Map<string, unknown>;
  queuedNotifications: JSONRPCMessage[];
  restartTimer?: NodeJS.Timeout;
  cleanupRetryTimer?: NodeJS.Timeout;
  startupWatchdog?: NodeJS.Timeout;
  retryPaused: boolean;
  validateBarrierKey?: string;
  runningValidateKey?: string;
  currentRetryEpoch?: number;
  currentRetryReservation?: { epoch: number; notBefore: number; delayMs: number };
  handleClientMessage(message: JSONRPCMessage): void;
  handleValidateProjectDeadline(key: string): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  handleWorkerExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void;
  handleWorkerProcessError(child: FakeChild, error: Error): void;
  finishTreeTermination(child: FakeChild, success: boolean): void;
  scheduleRestart(failedAttempt?: boolean): void;
  resumePausedRestart(): void;
  adoptActiveChild(): void;
  spawnWorker(): void;
  recoverTimedOutWorker(): void;
  liveCapOccupancy(): number;
  readonly unresolvedTreeTokenCount: number;
  shutdown(): Promise<void>;
};

function createLifecycleChild(pid: number, writes: string[]): FakeChild {
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  stdin.destroyed = false;
  stdin.write = (payload: string) => {
    writes.push(payload);
    return true;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  return child;
}

type FakeScheduledTimer = NodeJS.Timeout & {
  at: number;
  callback: () => void;
  cleared: boolean;
};

function createRestartHarness() {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  let spawns = 0;
  const instance = new StdioSupervisor({
    entryFile: "fixture.ts",
    monotonicNow: () => now,
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
  instance.spawnWorker = () => { spawns += 1; };
  return {
    supervisor: instance,
    timers,
    setNow(value: number) { now = value; },
    spawns() { return spawns; }
  };
}

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

function createHarness(): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const instance = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    validateProjectTimeoutMs: 10_000
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 123,
    stdin: {
      destroyed: false,
      write(payload) {
        workerWrites.push(payload);
        return true;
      },
      removeAllListeners() {}
    },
    stdout: { removeAllListeners() {} },
    stderr: { removeAllListeners() {} },
    kill: () => true
  };
  instance.child = child;
  instance.childReady = true;
  instance.liveChildren.add(child);
  return { supervisor: instance, outbound, workerWrites };
}

function clearHarnessTimers(supervisor: Harness): void {
  for (const pending of supervisor.pendingRequests.values()) {
    const timer = (pending as { deadlineTimer?: NodeJS.Timeout }).deadlineTimer;
    if (timer) clearTimeout(timer);
  }
  for (const entry of supervisor.queuedRequests) {
    const timer = (entry.pending as { deadlineTimer?: NodeJS.Timeout }).deadlineTimer;
    if (timer) clearTimeout(timer);
  }
}

function call(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} }
  } as JSONRPCRequest;
}

const ERA_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const ERA_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Shallow-valid modern-era `_meta` envelope (protocol revision 2026-07-28). */
function modernMeta(): Record<string, unknown> {
  return { [ERA_PROTOCOL_VERSION_KEY]: "2026-07-28", [ERA_CLIENT_CAPABILITIES_KEY]: {} };
}

/**
 * tools/call carrying the modern era signal. The mechanics under test in this
 * file (queueing, validate barrier, timeouts, cancellation, cleanup, watchdog)
 * are era-independent; driving them with a shallow-valid modern envelope
 * establishes/keeps the supervisor's modern era at admission so the tests do
 * not depend on unselected-state admission rules.
 */
function modernCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: modernMeta(), name, arguments: {} }
  } as JSONRPCRequest;
}

test("running validate barrier queues two requests, forwards notifications, and overflows the third", (t) => {
  const { supervisor, outbound, workerWrites } = createHarness();
  t.after(() => clearHarnessTimers(supervisor));
  supervisor.handleClientMessage(modernCall(1, "validate-project"));
  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  supervisor.handleClientMessage(modernCall(3, "list-versions"));
  const writesBeforeNotification = workerWrites.length;
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { _meta: modernMeta(), progressToken: "p", progress: 1 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, writesBeforeNotification + 1);
  assert.equal(supervisor.queuedRequests.length, 2);

  supervisor.handleClientMessage(modernCall(4, "list-versions"));
  const overflow = outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string }; meta?: { queue?: { queuedCount?: number } } } } };
  assert.equal(overflow.result?.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
  assert.equal(overflow.result?.structuredContent?.meta?.queue?.queuedCount, 2);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { _meta: modernMeta(), uri: "mc://versions" }
  } as JSONRPCRequest);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32000, message: "MCP supervisor request queue is full." }
  });
});

test("overflowing validate-project never acquires a deadline timer or barrier", () => {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  let scheduled = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message) => outbound.push(message),
    timerScheduler: () => {
      scheduled += 1;
      return { unref() { return this; } } as unknown as NodeJS.Timeout;
    },
    timerClearer: () => {}
  } as never) as unknown as Harness;
  const child = createLifecycleChild(99_999_967, workerWrites);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);

  supervisor.handleClientMessage(modernCall(7, "validate-project"));
  supervisor.handleClientMessage(modernCall(8, "list-versions"));
  supervisor.handleClientMessage(modernCall(9, "list-versions"));
  assert.equal(scheduled, 1);
  supervisor.handleClientMessage(modernCall(10, "validate-project"));

  assert.equal(scheduled, 1);
  assert.equal(supervisor.validateBarrierKey, "number:7");
  assert.equal(supervisor.queuedRequests.length, 2);
  assert.equal((outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
});

test("queued validate barrier counts as one FIFO slot and cancellation releases later work", (t) => {
  const { supervisor, outbound, workerWrites } = createHarness();
  t.after(() => clearHarnessTimers(supervisor));
  supervisor.handleClientMessage(modernCall(10, "list-versions"));
  supervisor.handleClientMessage(modernCall(11, "validate-project"));
  supervisor.handleClientMessage(modernCall(12, "list-versions"));
  supervisor.handleClientMessage(modernCall(13, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 2);
  assert.equal((outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");

  const writesBeforeCancel = workerWrites.length;
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 11 }
  } as JSONRPCMessage);
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal(workerWrites.length, writesBeforeCancel + 1);
  assert.equal(outbound.some((entry) => "id" in entry && entry.id === 11), false);
});

test("queue deadline returns phase queue without worker recovery", (t) => {
  const { supervisor, outbound } = createHarness();
  t.after(() => clearHarnessTimers(supervisor));
  supervisor.handleClientMessage(modernCall(20, "list-versions"));
  supervisor.handleClientMessage(modernCall(21, "validate-project"));
  supervisor.handleValidateProjectDeadline("number:21");
  const response = outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string }; meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } } } } };
  assert.equal(response.result?.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(response.result?.structuredContent?.meta?.timeout?.phase, "queue");
  assert.equal(response.result?.structuredContent?.meta?.timeout?.workerRestartInitiated, false);
  assert.equal(supervisor.childReady, true);
});

test("cap-blocked degraded admission fails requests immediately and drops notifications", () => {
  const outbound: JSONRPCMessage[] = [];
  const events: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details })
  } as never) as unknown as Harness;
  supervisor.child = undefined;
  supervisor.unresolvedTreeTokens.add(1001);
  supervisor.unresolvedTreeTokens.add(1002);
  supervisor.handleClientMessage(modernCall(30, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal((outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_WORKER_RESTART");

  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/progress", params: { _meta: modernMeta() } } as JSONRPCMessage);
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal(supervisor.queuedNotifications.length, 0);
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/progress", reason: "live-cap-blocked" }
  });
});

test("cap-blocked initialize is terminalized instead of retained indefinitely", () => {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message)
  } as never) as unknown as Harness;
  supervisor.unresolvedTreeTokens.add(1001);
  supervisor.unresolvedTreeTokens.add(1002);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 31,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-state-test", version: "1.0.0" } }
  } as JSONRPCRequest);

  assert.equal(supervisor.queuedNotifications.length, 0);
  assert.deepEqual(outbound, [{
    jsonrpc: "2.0",
    id: 31,
    error: {
      code: -32603,
      message: "MCP worker restarted while handling the request. Retry the request."
    }
  }]);

  supervisor.unresolvedTreeTokens.clear();
  const replacement = createLifecycleChild(99_999_990, workerWrites);
  supervisor.child = replacement;
  supervisor.liveChildren.add(replacement);
  supervisor.handleWorkerReady(replacement);
  assert.equal(workerWrites.length, 0);
  assert.equal(outbound.length, 1);
});

test("outbound failure cannot prevent queue timeout from draining later work", (t) => {
  const workerWrites: string[] = [];
  const events: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: () => { throw new Error("closed"); },
    eventWriter: (_level, event) => events.push(event)
  } as never) as unknown as Harness;
  const child = createLifecycleChild(99_999_989, workerWrites);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  t.after(() => clearHarnessTimers(supervisor));

  supervisor.handleClientMessage(modernCall(32, "list-versions"));
  supervisor.handleClientMessage(modernCall(33, "validate-project"));
  supervisor.handleClientMessage(modernCall(34, "list-versions"));
  supervisor.handleValidateProjectDeadline("number:33");

  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal(workerWrites.length, 2);
  assert.equal(events.includes("supervisor.client_write_error"), true);
});

test("outbound failure cannot prevent one running-timeout recovery", (t) => {
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: () => { throw new Error("closed"); },
    eventWriter: () => {}
  } as never) as unknown as Harness;
  const child = createLifecycleChild(99_999_988, []);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  let recoveries = 0;
  supervisor.recoverTimedOutWorker = () => { recoveries += 1; };
  t.after(() => clearHarnessTimers(supervisor));

  supervisor.handleClientMessage(modernCall(35, "validate-project"));
  supervisor.handleValidateProjectDeadline("number:35");

  assert.equal(recoveries, 1);
  assert.equal(supervisor.runningValidateKey, undefined);
  assert.equal(supervisor.validateBarrierKey, undefined);
  assert.equal(supervisor.pendingRequests.size, 0);
});

test("unavailable worker queue enforces the same two-request overflow bound", () => {
  const outbound: JSONRPCMessage[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message)
  } as never) as unknown as Harness;
  supervisor.scheduleRestart = () => {};

  supervisor.handleClientMessage(modernCall(36, "list-versions"));
  supervisor.handleClientMessage(modernCall(37, "list-versions"));
  supervisor.handleClientMessage(modernCall(38, "list-versions"));

  assert.equal(supervisor.queuedRequests.length, 2);
  assert.equal((outbound[0] as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
});

test("worker exit and deadline races each produce one terminal response", (t) => {
  const first = createHarness();
  const firstChild = first.supervisor.child as FakeChild;
  first.supervisor.handleClientMessage(modernCall(39, "validate-project"));
  first.supervisor.handleWorkerExit(firstChild, 1, null);
  first.supervisor.handleValidateProjectDeadline("number:39");
  const firstResponses = first.outbound.filter((message) => "id" in message && message.id === 39);
  assert.equal(firstResponses.length, 1);
  // Pinned semantics: exit-first must terminalize via the worker-restart
  // synthesis, not any admission-time rejection.
  assert.equal(
    (firstResponses[0] as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code,
    "ERR_WORKER_RESTART"
  );

  const second = createHarness();
  const secondChild = second.supervisor.child as FakeChild;
  second.supervisor.recoverTimedOutWorker = () => {};
  second.supervisor.handleClientMessage(modernCall(40, "validate-project"));
  second.supervisor.handleValidateProjectDeadline("number:40");
  second.supervisor.handleWorkerExit(secondChild, 1, null);
  const secondResponses = second.outbound.filter((message) => "id" in message && message.id === 40);
  assert.equal(secondResponses.length, 1);
  // Pinned semantics: deadline-first must terminalize via the timeout
  // synthesis, not any admission-time rejection.
  assert.equal(
    (secondResponses[0] as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code,
    "ERR_TOOL_TIMEOUT"
  );
  t.after(() => {
    clearHarnessTimers(first.supervisor);
    clearHarnessTimers(second.supervisor);
    if (first.supervisor.restartTimer) clearTimeout(first.supervisor.restartTimer);
    if (second.supervisor.restartTimer) clearTimeout(second.supervisor.restartTimer);
  });
});

test("stale buffered response is ignored and the request ID can be reused on the replacement", (t) => {
  const { supervisor, outbound, workerWrites } = createHarness();
  const stale = supervisor.child as FakeChild;
  supervisor.handleClientMessage(modernCall(41, "list-versions"));
  supervisor.handleWorkerExit(stale, 1, null);
  const replacement = createLifecycleChild(99_999_986, workerWrites);
  supervisor.child = replacement;
  supervisor.childReady = true;
  supervisor.liveChildren.add(replacement);
  supervisor.handleClientMessage(modernCall(41, "list-versions"));

  supervisor.handleWorkerMessage(stale, { jsonrpc: "2.0", id: 41, result: { stale: true } } as JSONRPCMessage);
  supervisor.handleWorkerMessage(replacement, { jsonrpc: "2.0", id: 41, result: { fresh: true } } as JSONRPCMessage);

  assert.equal(outbound.filter((message) => "id" in message && message.id === 41).length, 2);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 41, result: { fresh: true } });
  t.after(() => {
    if (supervisor.restartTimer) clearTimeout(supervisor.restartTimer);
  });
});

test("worker exit and close cleanup is idempotent and releases one logical slot", () => {
  const { supervisor } = createHarness();
  const child = supervisor.child as FakeChild;
  supervisor.child = undefined;
  supervisor.staleChildren.add(child);
  supervisor.cleanupStates.set(child, {
    pid: child.pid,
    status: "accepted",
    parentExited: false
  });

  supervisor.handleWorkerExit(child, 0, null);
  supervisor.handleWorkerExit(child, 0, null);
  assert.equal(supervisor.liveChildren.size, 0);
  assert.equal(supervisor.staleChildren.size, 0);
  assert.equal(supervisor.cleanupStates.size, 0);
});

test("parent close before tree result keeps one token until success resolves it", () => {
  const { supervisor } = createHarness();
  const child = supervisor.child as FakeChild;
  supervisor.child = undefined;
  supervisor.staleChildren.add(child);
  supervisor.cleanupStates.set(child, {
    pid: child.pid,
    status: "pending",
    parentExited: false
  });
  supervisor.handleWorkerExit(child, null, null);
  assert.deepEqual([...supervisor.unresolvedTreeTokens], [child.pid]);
  supervisor.finishTreeTermination(child, true);
  assert.equal(supervisor.unresolvedTreeTokens.size, 0);
  assert.equal(supervisor.cleanupStates.size, 0);
});

test("failed tree cleanup retains one logical token in both event orders and resumes once on proof", (t) => {
  for (const resultFirst of [true, false]) {
    const { supervisor, workerWrites } = createHarness();
    const stale = supervisor.child as FakeChild;
    supervisor.child = undefined;
    supervisor.childReady = false;
    supervisor.staleChildren.add(stale);
    supervisor.cleanupStates.set(stale, {
      pid: stale.pid,
      status: "pending",
      parentExited: false
    });
    if (resultFirst) {
      supervisor.finishTreeTermination(stale, false);
      supervisor.handleWorkerExit(stale, null, null);
    } else {
      supervisor.handleWorkerExit(stale, null, null);
      supervisor.finishTreeTermination(stale, false);
    }
    assert.deepEqual([...supervisor.unresolvedTreeTokens], [stale.pid]);
    assert.equal(supervisor.liveCapOccupancy(), 1);

    const replacement = createLifecycleChild(99_999_980 + Number(resultFirst), workerWrites);
    supervisor.child = replacement;
    supervisor.childReady = true;
    supervisor.liveChildren.add(replacement);
    supervisor.handleClientMessage(modernCall(resultFirst ? 75 : 76, "validate-project"));
    assert.equal(supervisor.queuedRequests.length, 1);
    assert.equal(supervisor.liveCapOccupancy(), 2);

    supervisor.finishTreeTermination(stale, true);
    assert.equal(supervisor.unresolvedTreeTokens.size, 0);
    assert.equal(supervisor.queuedRequests.length, 0);
    assert.equal(workerWrites.length, 1);
    t.after(() => clearHarnessTimers(supervisor));
  }
});

test("old stale cleanup plus failed replacement stays at two logical slots until proven cleanup", () => {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    eventWriter: () => {},
    monotonicNow: () => now,
    treeTerminator: () => false,
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
  const oldStale = createLifecycleChild(99_999_968, []);
  const failedReplacement = createLifecycleChild(99_999_969, []);
  supervisor.liveChildren.add(oldStale);
  supervisor.staleChildren.add(oldStale);
  supervisor.cleanupStates.set(oldStale, {
    pid: oldStale.pid,
    status: "pending",
    parentExited: false
  });
  supervisor.child = failedReplacement;
  supervisor.liveChildren.add(failedReplacement);

  supervisor.handleWorkerProcessError(failedReplacement, new Error("pre-ready failure"));
  assert.equal(supervisor.liveCapOccupancy(), 2);
  assert.equal(supervisor.unresolvedTreeTokens.size, 0);
  assert.equal(supervisor.retryPaused, true);
  assert.equal(timers.length, 0);

  supervisor.handleWorkerExit(oldStale, null, null);
  assert.equal(supervisor.liveCapOccupancy(), 2);
  assert.deepEqual([...supervisor.unresolvedTreeTokens], [oldStale.pid]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 1_000);

  supervisor.finishTreeTermination(oldStale, true);
  assert.equal(supervisor.liveCapOccupancy(), 1);
  assert.equal(supervisor.retryPaused, false);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].at, 100);
  now = 100;
});

test("shutdown retries token-only tree cleanup without scheduling restart", async () => {
  const retried: number[] = [];
  const outbound: JSONRPCMessage[] = [];
  let cleanupTimerCleared = false;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message),
    cleanupTokenRetryBaseMs: 10,
    timerScheduler: (callback, delayMs) => ({
      callback,
      delayMs,
      unref() { return this; }
    }) as unknown as NodeJS.Timeout,
    timerClearer: () => { cleanupTimerCleared = true; },
    treeTokenRetrier: async (pid: number) => {
      retried.push(pid);
      return true;
    }
  } as never) as unknown as Harness;
  const stale = createLifecycleChild(444_444, []);
  supervisor.liveChildren.add(stale);
  supervisor.cleanupStates.set(stale, {
    pid: stale.pid,
    status: "pending",
    parentExited: false
  });
  supervisor.handleWorkerExit(stale, null, null);
  assert.ok(supervisor.cleanupRetryTimer);
  await supervisor.shutdown();
  assert.deepEqual(retried, [444_444]);
  assert.equal(supervisor.unresolvedTreeTokens.size, 0);
  assert.equal(cleanupTimerCleared, true);
  assert.equal(outbound.length, 0);
});

test("normal operation retries unresolved cleanup tokens and unblocks restart and queued work", async () => {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const events: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
  const attempts = new Map<number, number>();
  const workerWrites: string[] = [];
  const replacement = createLifecycleChild(444_445, workerWrites);
  let spawns = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    cleanupTokenRetryBaseMs: 10,
    cleanupTokenRetryCapMs: 20,
    eventWriter: (level, event, details) => events.push({ level, event, details }),
    monotonicNow: () => now,
    treeTokenRetrier: async (pid: number) => {
      const attempt = (attempts.get(pid) ?? 0) + 1;
      attempts.set(pid, attempt);
      return attempt > 1;
    },
    workerSpawner: () => {
      spawns += 1;
      return replacement as never;
    },
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

  for (const pid of [444_441, 444_442]) {
    const stale = createLifecycleChild(pid, []);
    supervisor.liveChildren.add(stale);
    supervisor.cleanupStates.set(stale, { pid, status: "pending", parentExited: false });
    supervisor.handleWorkerExit(stale, null, null);
  }
  supervisor.queuedRequests.push({
    message: call(90, "list-versions"),
    pending: { id: 90, method: "tools/call", toolName: "list-versions", startedAt: 0 }
  } as never);
  supervisor.scheduleRestart(true);

  assert.equal(supervisor.unresolvedTreeTokenCount, 2);
  assert.equal(supervisor.retryPaused, true);
  assert.equal(events.filter(({ event }) => event === "supervisor.live_cap.saturated").length, 1);
  const firstRetry = timers.find((timer) => timer.at === 10 && !timer.cleared);
  assert.ok(firstRetry);

  now = 10;
  firstRetry.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...attempts.values()], [1, 1]);
  assert.equal(supervisor.unresolvedTreeTokenCount, 2);
  const secondRetry = timers.find((timer) => timer.at === 30 && !timer.cleared);
  assert.ok(secondRetry);

  now = 30;
  secondRetry.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.equal(supervisor.unresolvedTreeTokenCount, 0);
  assert.equal(supervisor.retryPaused, false);
  assert.equal(events.filter(({ event }) => event === "supervisor.cleanup_token.retry").length, 4);
  assert.equal(events.filter(({ event }) => event === "supervisor.cleanup_token.recovered").length, 2);

  const restart = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(restart);
  now = 100;
  restart.callback();
  supervisor.handleWorkerReady(replacement);
  assert.equal(spawns, 1);
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal(workerWrites.length, 1);
});

test("shutdown bounds a never-settling token cleanup retry", async () => {
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    treeCleanupTimeoutMs: 20,
    treeTokenRetrier: () => new Promise<boolean>(() => {})
  } as never) as unknown as Harness;
  supervisor.unresolvedTreeTokens.add(555_555);

  await Promise.race([
    supervisor.shutdown(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown hung")), 250))
  ]);
  assert.deepEqual([...supervisor.unresolvedTreeTokens], [555_555]);
});

test("cap-paused restart preserves remaining backoff and resumes once", () => {
  const harness = createRestartHarness();
  const { supervisor, timers } = harness;
  supervisor.unresolvedTreeTokens.add(1);
  supervisor.unresolvedTreeTokens.add(2);

  supervisor.scheduleRestart(true);
  assert.equal(supervisor.retryPaused, true);
  assert.equal(timers.length, 0);
  harness.setNow(50);
  supervisor.unresolvedTreeTokens.clear();
  supervisor.resumePausedRestart();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 100);

  harness.setNow(100);
  timers[0].callback();
  assert.equal(harness.spawns(), 1);
  assert.equal(supervisor.currentRetryEpoch, undefined);
});

test("elapsed backoff resumes immediately after cap cleanup", () => {
  const harness = createRestartHarness();
  const { supervisor, timers } = harness;
  supervisor.scheduleRestart(true);
  assert.equal(timers[0].at, 100);
  supervisor.unresolvedTreeTokens.add(1);
  supervisor.unresolvedTreeTokens.add(2);
  harness.setNow(100);
  timers[0].callback();
  assert.equal(supervisor.retryPaused, true);
  assert.equal(harness.spawns(), 0);

  supervisor.unresolvedTreeTokens.clear();
  supervisor.resumePausedRestart();
  assert.equal(timers[1].at, 100);
  timers[1].callback();
  assert.equal(harness.spawns(), 1);
});

test("active adoption invalidates a stale retry epoch and resets backoff", () => {
  const harness = createRestartHarness();
  const { supervisor, timers } = harness;
  supervisor.scheduleRestart(true);
  const stale = timers[0];
  supervisor.adoptActiveChild();
  stale.callback();
  assert.equal(harness.spawns(), 0);

  supervisor.scheduleRestart(true);
  assert.equal(timers[1].at, 100);
});

test("startup watchdog terminalizes queued work and late ready cannot adopt the replacement", () => {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const writes: string[] = [];
  const children = [
    createLifecycleChild(99_999_991, writes),
    createLifecycleChild(99_999_992, writes)
  ];
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message) => outbound.push(message),
    eventWriter: () => {},
    monotonicNow: () => now,
    workerSpawner: () => children[spawnIndex++] as never,
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

  supervisor.spawnWorker();
  const stale = supervisor.child as FakeChild;
  supervisor.handleClientMessage(modernCall(70, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 1);
  now = 10_000;
  timers.find((timer) => timer.at === 10_000)?.callback();
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal((outbound[0] as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_WORKER_RESTART");

  const retry = timers.find((timer) => timer.at === 10_100);
  assert.ok(retry);
  now = 10_100;
  retry.callback();
  assert.equal(supervisor.child, children[1]);
  assert.equal(supervisor.childReady, false);
  supervisor.handleWorkerReady(stale);
  assert.equal(supervisor.child, children[1]);
  assert.equal(supervisor.childReady, false);
});

test("initial initialization error terminalizes retained initialization exactly once", (t) => {
  const outbound: JSONRPCMessage[] = [];
  const writes: string[] = [];
  const child = createLifecycleChild(99_999_993, writes);
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message),
    eventWriter: () => {},
    workerSpawner: () => child as never
  } as never) as unknown as Harness;
  t.after(() => {
    if (supervisor.startupWatchdog) clearTimeout(supervisor.startupWatchdog);
    if (supervisor.restartTimer) clearTimeout(supervisor.restartTimer);
  });
  supervisor.spawnWorker();
  supervisor.handleClientMessage({ jsonrpc: "2.0", id: 71, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-state-test", version: "1.0.0" } } } as JSONRPCRequest);
  supervisor.handleWorkerReady(child);
  assert.equal(writes.length, 1);

  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 71,
    error: { code: -32603, message: "replay failed" }
  } as JSONRPCMessage);
  assert.deepEqual(outbound, [{
    jsonrpc: "2.0",
    id: 71,
    error: {
      code: -32603,
      message: "MCP worker restarted while handling the request. Retry the request."
    }
  }]);

  const replacement = createLifecycleChild(99_999_987, writes);
  supervisor.child = replacement;
  supervisor.liveChildren.add(replacement);
  supervisor.handleWorkerReady(replacement);
  assert.equal(writes.length, 1);
  assert.equal(outbound.length, 1);

  supervisor.handleClientMessage({ jsonrpc: "2.0", id: 74, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-state-test", version: "1.0.0" } } } as JSONRPCRequest);
  assert.equal(writes.length, 2);
  supervisor.handleWorkerMessage(replacement, {
    jsonrpc: "2.0",
    id: 74,
    result: { capabilities: {} }
  } as JSONRPCMessage);
  assert.equal(outbound.length, 2);
  assert.equal((outbound[1] as { id?: number }).id, 74);
});

test("replacement initialization replay failure terminalizes queued work without duplicating initialize", () => {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const writes: string[] = [];
  const children = [
    createLifecycleChild(99_999_994, writes),
    createLifecycleChild(99_999_995, writes)
  ];
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message),
    eventWriter: () => {},
    monotonicNow: () => now,
    workerSpawner: () => children[spawnIndex++] as never,
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

  supervisor.spawnWorker();
  supervisor.handleClientMessage({ jsonrpc: "2.0", id: 72, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-state-test", version: "1.0.0" } } } as JSONRPCRequest);
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleWorkerMessage(children[0], { jsonrpc: "2.0", id: 72, result: { capabilities: {} } } as JSONRPCMessage);
  assert.equal(outbound.length, 1);

  supervisor.handleWorkerExit(children[0], 1, null);
  supervisor.handleClientMessage(call(73, "list-versions"));
  now = 100;
  const retry = timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry);
  retry.callback();
  supervisor.handleWorkerReady(children[1]);
  supervisor.handleWorkerMessage(children[1], {
    jsonrpc: "2.0",
    id: 72,
    error: { code: -32603, message: "replay failed" }
  } as JSONRPCMessage);

  assert.equal(outbound.filter((message) => "id" in message && message.id === 72).length, 1);
  assert.equal((outbound.at(-1) as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code, "ERR_WORKER_RESTART");
  assert.equal((outbound.at(-1) as { id?: number }).id, 73);
  const countAfterFailure = outbound.length;
  supervisor.handleWorkerMessage(children[1], {
    jsonrpc: "2.0",
    id: 72,
    result: { capabilities: {} }
  } as JSONRPCMessage);
  assert.equal(outbound.length, countAfterFailure);
});

test("consecutive replay failures use one exponential retry owner and adoption resets it", () => {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const writes: string[] = [];
  const children = Array.from({ length: 5 }, (_, index) =>
    createLifecycleChild(99_999_970 + index, writes)
  );
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message) => outbound.push(message),
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

  supervisor.spawnWorker();
  supervisor.handleClientMessage({ jsonrpc: "2.0", id: 77, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervisor-state-test", version: "1.0.0" } } } as JSONRPCRequest);
  supervisor.handleWorkerReady(children[0]);
  supervisor.handleWorkerMessage(children[0], { jsonrpc: "2.0", id: 77, result: { capabilities: {} } } as JSONRPCMessage);
  supervisor.handleWorkerExit(children[0], 1, null);

  for (const [index, at] of [100, 300, 700].entries()) {
    const retry = timers.find((timer) => timer.at === at && !timer.cleared);
    assert.ok(retry, `missing retry at ${at}`);
    now = at;
    retry.callback();
    const child = children[index + 1];
    supervisor.handleWorkerReady(child);
    supervisor.handleWorkerMessage(child, {
      jsonrpc: "2.0",
      id: 77,
      error: { code: -32603, message: "replay failed" }
    } as JSONRPCMessage);
    supervisor.handleWorkerExit(child, 1, null);
  }

  const fourthRetry = timers.find((timer) => timer.at === 1_500 && !timer.cleared);
  assert.ok(fourthRetry);
  now = 1_500;
  fourthRetry.callback();
  supervisor.handleWorkerReady(children[4]);
  supervisor.handleWorkerMessage(children[4], {
    jsonrpc: "2.0",
    id: 77,
    result: { capabilities: {} }
  } as JSONRPCMessage);
  supervisor.handleWorkerExit(children[4], 1, null);

  const resetRetry = timers.find((timer) => timer.at === 1_600 && !timer.cleared);
  assert.ok(resetRetry);
  assert.equal(supervisor.currentRetryReservation?.delayMs, 100);
});

test("running cancellation suppresses a worker response and drains queued work", (t) => {
  const { supervisor, outbound, workerWrites } = createHarness();
  t.after(() => clearHarnessTimers(supervisor));
  const child = supervisor.child as FakeChild;
  supervisor.handleClientMessage(modernCall(40, "validate-project"));
  supervisor.handleClientMessage(modernCall(41, "list-versions"));
  const writesBeforeCancel = workerWrites.length;
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 40 }
  } as JSONRPCMessage);
  // The cancellation itself drains the queue: it terminally settles id 40, so
  // the validate barrier and the pendingRequests slot are released right here
  // rather than waiting for a worker answer that MCP cancellation semantics
  // say may never arrive (the pre-repair build drained only if and when the
  // worker happened to answer, and never at all otherwise).
  assert.equal(supervisor.pendingRequests.has("number:40"), false, "the cancelled request is settled at once");
  assert.equal(
    workerWrites.length,
    writesBeforeCancel + 2,
    "the cancellation is forwarded and the queued list-versions is released behind it"
  );
  assert.equal(workerWrites.at(-1)?.includes('"id":41'), true, "the queued request reaches the worker");

  const writesBeforeResponse = workerWrites.length;
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 40,
    result: { content: [{ type: "text", text: "late" }] }
  } as JSONRPCMessage);
  assert.equal(outbound.some((message) => "id" in message && message.id === 40), false);
  assert.equal(workerWrites.length, writesBeforeResponse, "a suppressed late answer changes nothing further");
});

test("running cancellation followed by shutdown emits no terminal response or replacement", async () => {
  const { supervisor, outbound } = createHarness();
  supervisor.handleClientMessage(modernCall(42, "validate-project"));
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 42 }
  } as JSONRPCMessage);

  await supervisor.shutdown();

  assert.equal(outbound.some((message) => "id" in message && message.id === 42), false);
  assert.equal(supervisor.pendingRequests.size, 0);
  assert.equal(supervisor.restartTimer, undefined);
});

test("cancel-first deadline performs cleanup without ERR_TOOL_TIMEOUT", (t) => {
  const { supervisor, outbound } = createHarness();
  t.after(() => {
    clearHarnessTimers(supervisor);
    if (supervisor.restartTimer) clearTimeout(supervisor.restartTimer);
  });
  supervisor.handleClientMessage(modernCall(50, "validate-project"));
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 50 }
  } as JSONRPCMessage);
  supervisor.child = undefined;
  supervisor.liveChildren.clear();
  supervisor.handleValidateProjectDeadline("number:50");
  assert.equal(outbound.some((message) => "id" in message && message.id === 50), false);
});

test("timeout-first cancellation does not create a second terminal response", (t) => {
  const { supervisor, outbound } = createHarness();
  t.after(() => {
    clearHarnessTimers(supervisor);
    if (supervisor.restartTimer) clearTimeout(supervisor.restartTimer);
  });
  supervisor.handleClientMessage(modernCall(60, "validate-project"));
  supervisor.child = undefined;
  supervisor.liveChildren.clear();
  supervisor.handleValidateProjectDeadline("number:60");
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 60 }
  } as JSONRPCMessage);
  const responses = outbound.filter((message) => "id" in message && message.id === 60);
  assert.equal(responses.length, 1);
  // Pinned semantics: the single terminal response must be the timeout
  // synthesis, not any admission-time rejection.
  assert.equal(
    (responses[0] as { result?: { structuredContent?: { error?: { code?: string } } } }).result?.structuredContent?.error?.code,
    "ERR_TOOL_TIMEOUT"
  );
});
