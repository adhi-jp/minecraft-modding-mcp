import assert from "node:assert/strict";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * Finality entitlement under client-side id reuse.
 *
 * writeSyntheticReply settles and tombstones ONLY the exact forwarded pending
 * instance the synthesis answers. A never-forwarded snapshot (queue-limit
 * overflow, cap-blocked reply, unknown-tool intercept, queued terminalization)
 * whose id collides with a DIFFERENT live forwarded request must not delete or
 * tombstone that live entry: doing so would discard the worker's real answer
 * for the live request and permanently strand the validate barrier — the
 * queued requests behind it would never drain while the worker stays healthy.
 *
 * Reusing a live id is a client-side JSON-RPC violation, but the supervisor
 * must keep the live request's exactly-one-response guarantee regardless.
 */

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type CapturedEvent = { level: string; event: string; details?: Record<string, unknown> };

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  unresolvedTreeTokens: Set<number>;
  initializeRequest?: JSONRPCRequest;
  pendingRequests: Map<string, { method?: string }>;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  shutdown(): Promise<void>;
};

function createWorker(pid: number, writes: string[]): FakeChild {
  return {
    pid,
    stdin: {
      destroyed: false,
      write(payload) {
        writes.push(payload);
        return true;
      },
      removeAllListeners() {}
    },
    stdout: { removeAllListeners() {} },
    stderr: { removeAllListeners() {} },
    kill() {
      return true;
    }
  };
}

function createHarness(): {
  supervisor: Harness;
  child: FakeChild;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
  events: CapturedEvent[];
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const events: CapturedEvent[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details })
  } as never) as unknown as Harness;
  const child = createWorker(321, workerWrites);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  return { supervisor, child, outbound, workerWrites, events };
}

function legacyInitialize(id: number): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "finality-id-reuse-test", version: "1.0.0" }
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
      serverInfo: { name: "finality-fixture", version: "1.0.0" }
    }
  } as JSONRPCMessage;
}

function claimlessCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} }
  } as JSONRPCRequest;
}

test("a queue-limit reply for a reused live id must not settle the live validate-project entry", async () => {
  const { supervisor, child, outbound, workerWrites, events } = createHarness();

  // Legacy handshake so ordinary claim-less requests are admissible.
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));

  // validate-project id 7 forwards and raises the barrier.
  supervisor.handleClientMessage(claimlessCall(7, "validate-project"));
  assert.equal(
    workerWrites.some((frame) => frame.includes("validate-project")),
    true,
    "validate-project must be forwarded to the worker"
  );

  // Two requests queue behind the barrier (MAX_SUPERVISOR_QUEUE = 2)...
  supervisor.handleClientMessage(claimlessCall(8, "list-versions"));
  supervisor.handleClientMessage(claimlessCall(9, "list-versions"));
  assert.equal(
    workerWrites.some((frame) => frame.includes('"id":8')),
    false,
    "id 8 must be queued behind the validate barrier"
  );

  // ...and a THIRD request REUSING the live id 7 overflows the queue. The
  // queue-limit reply answers the duplicate id 7 — that is fine — but it must
  // not touch the live validate-project entry that shares the id.
  supervisor.handleClientMessage(claimlessCall(7, "list-versions"));
  const overflowReplies = outbound.filter(
    (frame) => (frame as { id?: unknown }).id === 7 && JSON.stringify(frame).includes("limit-exceeded")
  );
  assert.equal(overflowReplies.length, 1, "the duplicate id 7 must receive the queue-limit reply");

  // The worker's REAL validate-project answer must still reach the client...
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 7,
    result: {
      content: [{ type: "text", text: "validate-ok" }],
      structuredContent: { ok: true }
    }
  } as JSONRPCMessage);
  assert.equal(
    outbound.some((frame) => JSON.stringify(frame).includes("validate-ok")),
    true,
    "the live validate-project result must be delivered, not tombstone-discarded"
  );
  assert.equal(
    events.some((entry) => entry.event === "supervisor.late_response_discarded"),
    false,
    "the live answer must not be treated as a late response"
  );

  // ...and settling it must release the barrier so the queued requests drain.
  assert.equal(
    workerWrites.some((frame) => frame.includes('"id":8')),
    true,
    "queued id 8 must be forwarded after the barrier clears"
  );
  assert.equal(
    workerWrites.some((frame) => frame.includes('"id":9')),
    true,
    "queued id 9 must be forwarded after the barrier clears"
  );

  await supervisor.shutdown();
});

test("a cap-blocked re-initialize discards the preserved same-id initialize entry instead of leaking it", async () => {
  const { supervisor, outbound } = createHarness();

  // A forwarded initialize whose worker died before answering: the map entry
  // is preserved for replay correlation and initializeRequest stays cached.
  supervisor.handleClientMessage(legacyInitialize(1));
  assert.equal(supervisor.pendingRequests.has("number:1"), true, "the forwarded initialize must be pending");

  // Worker gone, live cap saturated by unresolved process-tree tokens.
  supervisor.child = undefined;
  supervisor.childReady = false;
  supervisor.unresolvedTreeTokens.add(11);
  supervisor.unresolvedTreeTokens.add(12);

  // A cap-blocked re-initialize with the SAME id discards the cached
  // handshake; the preserved map entry is orphaned by that discard (no
  // replay can answer it) and must be dropped with it — leaking it would
  // block validate-project dispatch forever and resurface at the next
  // worker exit as a duplicate reply.
  supervisor.handleClientMessage(legacyInitialize(1));
  const reply = outbound.at(-1) as { id?: unknown; error?: { code?: number } };
  assert.equal(reply.id, 1, "the cap-blocked re-initialize must be answered");
  assert.equal(reply.error?.code, -32603, "the cap-blocked reply is the legacy -32603");
  assert.equal(supervisor.initializeRequest, undefined, "the discarded handshake must not linger");
  assert.equal(
    supervisor.pendingRequests.has("number:1"),
    false,
    "the orphaned preserved initialize entry must be dropped with the discarded handshake"
  );

  await supervisor.shutdown();
});
