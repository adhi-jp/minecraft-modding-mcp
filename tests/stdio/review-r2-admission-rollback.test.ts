import assert from "node:assert/strict";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * The admission safety net must leave NO half-installed request behind.
 *
 * `handleClientMessage` answers a faulted admission with -32603 so the id is
 * never dropped. But admission installs state BEFORE it can fault: the
 * forwarding step inserts the pending entry, arms a validate-project deadline
 * and takes the validate barrier, and only then writes to the worker's stdin.
 * A synchronous write (or encode) failure there left the entry live with its
 * deadline armed while the client had already been answered — so the deadline
 * later wrote a SECOND terminal reply for the same id, and every request
 * behind the barrier waited for it.
 */

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type FakeScheduledTimer = NodeJS.Timeout & {
  callback: () => void;
  cleared: boolean;
};

type QueuedEntry = { message: JSONRPCRequest; pending: { id: string | number } };

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  pendingRequests: Map<string, unknown>;
  queuedRequests: QueuedEntry[];
  validateBarrierKey?: string;
  runningValidateKey?: string;
  writeToWorker(child: FakeChild, message: JSONRPCMessage): void;
  canDispatchImmediately(pending: unknown): boolean;
  scheduleRestart(failedAttempt?: boolean): void;
  recoverTimedOutWorker(): void;
  handleClientMessage(message: JSONRPCMessage): void;
  shutdown(): Promise<void>;
};

type ErrorReply = { id?: unknown; error?: { code?: number; message?: string } };

const ERA_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const ERA_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

function modernMeta(): Record<string, unknown> {
  return { [ERA_PROTOCOL_VERSION_KEY]: "2026-07-28", [ERA_CLIENT_CAPABILITIES_KEY]: {} };
}

function modernCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: modernMeta(), name, arguments: {} }
  } as JSONRPCRequest;
}

function repliesFor(outbound: JSONRPCMessage[], id: number): ErrorReply[] {
  return outbound.filter((frame) => (frame as ErrorReply).id === id) as ErrorReply[];
}

function createHarness(): {
  supervisor: Harness;
  child: FakeChild;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
  timers: FakeScheduledTimer[];
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const timers: FakeScheduledTimer[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {},
    monotonicNow: () => 0,
    timerScheduler: (callback) => {
      const timer = {
        callback,
        cleared: false,
        unref() { return this; }
      } as unknown as FakeScheduledTimer;
      timers.push(timer);
      return timer;
    },
    timerClearer: (timer) => { (timer as FakeScheduledTimer).cleared = true; }
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 909,
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
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  supervisor.recoverTimedOutWorker = () => {};
  return { supervisor, child, outbound, workerWrites, timers };
}

/** Makes the worker write throw for `failingIds` and behave normally otherwise. */
function failWorkerWritesFor(supervisor: Harness, failingIds: Set<number>): void {
  supervisor.writeToWorker = (child, message) => {
    const id = (message as { id?: unknown }).id;
    if (typeof id === "number" && failingIds.has(id)) {
      throw new Error("synthetic worker stdin fault");
    }
    child.stdin.write(JSON.stringify(message));
  };
}

test("an admission fault after forwarding removes the pending entry it installed", async () => {
  const { supervisor, outbound, workerWrites } = createHarness();
  failWorkerWritesFor(supervisor, new Set([92]));

  supervisor.handleClientMessage(modernCall(92, "list-versions"));

  const replies = repliesFor(outbound, 92);
  assert.equal(replies.length, 1, "the faulted id must receive exactly one reply");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:92"),
    false,
    "an answered admission must not leave the request live in pendingRequests"
  );

  // A fresh id must still be admitted normally: the fault released nothing the
  // next request depends on.
  supervisor.handleClientMessage(modernCall(93, "list-versions"));
  assert.equal(
    workerWrites.some((frame) => frame.includes("\"id\":93")),
    true,
    "a later request must still reach the worker"
  );
  assert.equal(repliesFor(outbound, 93).length, 0, "the later request must not be answered locally");

  await supervisor.shutdown();
});

test("an admission fault on validate-project disarms its deadline and releases the barrier", async () => {
  const { supervisor, outbound, workerWrites, timers } = createHarness();
  failWorkerWritesFor(supervisor, new Set([5]));

  supervisor.handleClientMessage(modernCall(5, "validate-project"));

  assert.equal(repliesFor(outbound, 5).length, 1, "the faulted id must receive exactly one reply");
  assert.equal(repliesFor(outbound, 5)[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.size,
    0,
    "the forwarded validate-project entry must not survive its own admission fault"
  );
  assert.equal(supervisor.runningValidateKey, undefined, "the validate slot must be released");
  assert.equal(supervisor.validateBarrierKey, undefined, "the validate barrier must be released");
  assert.equal(timers.length, 1, "admission arms exactly one validate-project deadline");
  assert.equal(timers[0].cleared, true, "the armed deadline must be cleared by the rollback");

  // Nothing may still be able to write a SECOND terminal reply for id 5.
  for (const timer of timers) {
    if (!timer.cleared) timer.callback();
  }
  assert.equal(
    repliesFor(outbound, 5).length,
    1,
    "the -32603 must be the only terminal reply for the faulted id"
  );

  // The barrier is genuinely free: the next validate-project dispatches.
  supervisor.handleClientMessage(modernCall(6, "validate-project"));
  assert.equal(
    workerWrites.some((frame) => frame.includes("\"id\":6")),
    true,
    "a later validate-project must dispatch instead of queueing behind a stale barrier"
  );

  await supervisor.shutdown();
});

test("an admission fault rolls back only the queued entry it installed", async () => {
  const { supervisor, child, outbound } = createHarness();
  // A destroyed stdin makes admission queue rather than forward, so the first
  // call leaves a legitimately queued entry at id 7.
  child.stdin.destroyed = true;
  supervisor.handleClientMessage(modernCall(7, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 1, "the first call must queue");
  const original = supervisor.queuedRequests[0];

  // Force the forward path against the same destroyed stdin: forwardRequest
  // re-queues the request and then faults, so a SECOND entry at id 7 is
  // installed before the throw.
  supervisor.canDispatchImmediately = () => true;
  supervisor.scheduleRestart = () => {
    throw new Error("synthetic restart fault");
  };
  supervisor.handleClientMessage(modernCall(7, "list-versions"));

  const replies = repliesFor(outbound, 7);
  assert.equal(replies.length, 1, "the faulted id must receive exactly one reply");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.queuedRequests.length,
    1,
    "the queued entry this admission installed must be rolled back"
  );
  assert.equal(
    supervisor.queuedRequests[0],
    original,
    "the pre-existing queued instance at the same id must be left untouched"
  );

  await supervisor.shutdown();
});

test("an admission fault dispatches the work that was queued behind the rolled-back entry", async () => {
  const { supervisor, child, outbound, workerWrites } = createHarness();
  // Queue one request against a momentarily unusable stdin, then restore it so
  // the next admission forwards — and faults.
  child.stdin.destroyed = true;
  supervisor.handleClientMessage(modernCall(8, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 1, "the first call must queue");

  child.stdin.destroyed = false;
  failWorkerWritesFor(supervisor, new Set([9]));
  supervisor.handleClientMessage(modernCall(9, "list-versions"));

  assert.equal(repliesFor(outbound, 9).length, 1, "the faulted id must receive exactly one reply");
  assert.equal(repliesFor(outbound, 9)[0].error?.code, -32603);
  assert.equal(
    workerWrites.some((frame) => frame.includes("\"id\":8")),
    true,
    "queued work must move once the faulted admission released its state"
  );
  assert.equal(supervisor.queuedRequests.length, 0, "nothing may stay stranded in the queue");

  await supervisor.shutdown();
});
