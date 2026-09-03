import assert from "node:assert/strict";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor, redactToolArgs } from "../../src/stdio-supervisor.ts";

/**
 * Admission-time argument redaction must survive a pathological `arguments`
 * graph.
 *
 * `redactToolArgs` walks the client's tool arguments recursively at admission
 * of every `tools/call`. A deeply nested payload (~3.4 KB on the wire for the
 * depth used here) overflowed the JS stack, and the RangeError propagated out
 * of admission into the frame reader, which swallows it as a parse error — so
 * the request received NO reply at all and the client waited forever.
 */

const OVERFLOW_DEPTH = 1710;

/** `{"deep": [[[...]]]}` nested `depth` levels — a stack-overflow shaped payload. */
function deeplyNestedArguments(depth: number): Record<string, unknown> {
  let node: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    node = [node];
  }
  return { deep: node };
}

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  pendingRequests: Map<string, unknown>;
  queuedRequests: unknown[];
  createPendingRequest(message: JSONRPCRequest, eraSignal?: unknown): unknown;
  handleClientMessage(message: JSONRPCMessage): void;
  shutdown(): Promise<void>;
};

const ERA_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const ERA_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

function modernMeta(): Record<string, unknown> {
  return { [ERA_PROTOCOL_VERSION_KEY]: "2026-07-28", [ERA_CLIENT_CAPABILITIES_KEY]: {} };
}

function createHarness(): {
  supervisor: Harness;
  child: FakeChild;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
  events: Array<{ level: string; event: string; details?: Record<string, unknown> }>;
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const events: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details })
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 777,
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
  return { supervisor, child, outbound, workerWrites, events };
}

test("redactToolArgs bounds its recursion instead of overflowing the stack", () => {
  const args = deeplyNestedArguments(OVERFLOW_DEPTH);

  const redacted = redactToolArgs(args);

  assert.equal(
    typeof redacted.args,
    "object",
    "a pathological depth must still produce a redacted object"
  );
  assert.equal(
    redacted.modified,
    true,
    "a depth-truncated copy must be flagged modified so no suggestedCall is derived from it"
  );
  // The bounded copy must be serializable: an unbounded structure clone would
  // overflow again in every downstream diagnostic path.
  assert.ok(JSON.stringify(redacted.args).length > 0);
});

test("a tools/call with a stack-overflow shaped arguments graph is answered, never silently dropped", async () => {
  const { supervisor, outbound, workerWrites } = createHarness();

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: { _meta: modernMeta(), name: "list-versions", arguments: deeplyNestedArguments(OVERFLOW_DEPTH) }
  } as JSONRPCRequest);

  const forwarded = workerWrites.some((frame) => frame.includes("\"id\":91"));
  const answered = outbound.some((frame) => (frame as { id?: unknown }).id === 91);
  assert.equal(
    forwarded || answered,
    true,
    "the request must reach the worker or receive a reply — silence strands the client"
  );

  await supervisor.shutdown();
});

test("an admission fault answers the request id with -32603 instead of dropping it", async () => {
  const { supervisor, outbound, events } = createHarness();
  supervisor.createPendingRequest = () => {
    throw new Error("synthetic admission fault");
  };

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 92,
    method: "tools/call",
    params: { _meta: modernMeta(), name: "list-versions", arguments: {} }
  } as JSONRPCRequest);

  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 92) as
    | { id?: unknown; error?: { code?: number; message?: string } }
    | undefined;
  assert.ok(reply, "an admission fault must not swallow the request");
  assert.equal(reply.error?.code, -32603);
  assert.match(String(reply.error?.message), /synthetic admission fault/);
  assert.equal(
    events.some((entry) => entry.event === "supervisor.admission_failed"),
    true,
    "the fault must be observable in the event stream"
  );

  await supervisor.shutdown();
});

test("an admission fault on a notification produces no reply", async () => {
  const { supervisor, outbound } = createHarness();
  supervisor.createPendingRequest = () => {
    throw new Error("synthetic admission fault");
  };
  // handleClientNotification never reaches createPendingRequest; force the
  // fault from the notification path to prove an id-less frame is not answered.
  (supervisor as unknown as { handleClientNotification(message: JSONRPCMessage): void })
    .handleClientNotification = () => {
      throw new Error("synthetic notification fault");
    };

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { _meta: modernMeta(), progressToken: "p", progress: 1 }
  } as JSONRPCMessage);

  assert.equal(outbound.length, 0, "a notification has no id to answer");

  await supervisor.shutdown();
});
