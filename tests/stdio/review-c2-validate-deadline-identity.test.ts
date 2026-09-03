import assert from "node:assert/strict";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * The validate-project deadline belongs to ONE request instance, not to an id.
 *
 * The supervisor deliberately tolerates a client reusing a live JSON-RPC id
 * (see the finality/id-reuse suite). The armed deadline was keyed by the id
 * alone, so a later request that reused the RUNNING validate-project's id and
 * queued behind its barrier was spliced out and answered with a queue-phase
 * timeout by the running request's own timer — while the running request kept
 * no deadline at all, `runningValidateKey`/`validateBarrierKey` stayed set, and
 * every request behind the barrier waited forever if the worker never answered.
 */

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
  liveChildren: Set<FakeChild>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number; toolName?: string } }>;
  pendingRequests: Map<string, unknown>;
  validateBarrierKey?: string;
  runningValidateKey?: string;
  recoverTimedOutWorker(): void;
  handleClientMessage(message: JSONRPCMessage): void;
  shutdown(): Promise<void>;
};

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

function createHarness(): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
  timers: FakeScheduledTimer[];
  recoveries(): number;
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const timers: FakeScheduledTimer[] = [];
  let now = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {},
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
  const child: FakeChild = {
    pid: 555,
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
  let recoveries = 0;
  supervisor.recoverTimedOutWorker = () => { recoveries += 1; };
  return { supervisor, outbound, workerWrites, timers, recoveries: () => recoveries };
}

type TimeoutReply = {
  id?: unknown;
  result?: {
    structuredContent?: {
      error?: { code?: string };
      meta?: { timeout?: { phase?: string; workerRestartInitiated?: boolean } };
    };
  };
};

test("a running validate-project deadline settles the running request, not an id-reusing queued duplicate", async () => {
  const { supervisor, outbound, timers, recoveries } = createHarness();

  // validate-project id 7 forwards and raises the barrier; its deadline is the
  // only timer this harness ever arms.
  supervisor.handleClientMessage(modernCall(7, "validate-project"));
  assert.equal(supervisor.runningValidateKey, "number:7");
  assert.equal(timers.length, 1, "the running validate-project must own exactly one deadline");

  // A later request REUSES the live id 7 and queues behind the barrier.
  supervisor.handleClientMessage(modernCall(7, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 1, "the duplicate id must queue behind the barrier");

  // Fire the RUNNING request's deadline.
  timers[0].callback();

  const replies = outbound.filter((frame) => (frame as { id?: unknown }).id === 7) as TimeoutReply[];
  assert.equal(replies.length, 1, "exactly one id-7 reply must be produced");
  assert.equal(replies[0].result?.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");
  assert.equal(
    replies[0].result?.structuredContent?.meta?.timeout?.phase,
    "running",
    "the deadline belongs to the RUNNING request, so it must report the running phase"
  );
  assert.equal(
    replies[0].result?.structuredContent?.meta?.timeout?.workerRestartInitiated,
    true,
    "a running-phase timeout recovers the worker"
  );
  assert.equal(recoveries(), 1, "the running-phase timeout must recover the stuck worker");

  // The barrier is released and the queued duplicate is untouched by the
  // running request's timer: it is either still queued or drained onward,
  // never terminalized by someone else's deadline.
  assert.equal(supervisor.runningValidateKey, undefined, "the running validate key must be released");
  assert.equal(supervisor.validateBarrierKey, undefined, "the validate barrier must be released");
  assert.equal(
    supervisor.pendingRequests.has("number:7"),
    false,
    "the settled running entry must be removed"
  );

  await supervisor.shutdown();
});

test("a queued validate-project deadline still settles its own queued entry", async () => {
  const { supervisor, outbound, timers } = createHarness();

  // A non-validate request occupies the worker so the validate-project queues.
  supervisor.handleClientMessage(modernCall(20, "list-versions"));
  supervisor.handleClientMessage(modernCall(21, "validate-project"));
  assert.equal(supervisor.queuedRequests.length, 1);
  assert.equal(timers.length, 1);

  timers[0].callback();

  const replies = outbound.filter((frame) => (frame as { id?: unknown }).id === 21) as TimeoutReply[];
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result?.structuredContent?.meta?.timeout?.phase, "queue");
  assert.equal(replies[0].result?.structuredContent?.meta?.timeout?.workerRestartInitiated, false);
  assert.equal(supervisor.queuedRequests.length, 0);
  assert.equal(supervisor.validateBarrierKey, undefined);

  await supervisor.shutdown();
});
