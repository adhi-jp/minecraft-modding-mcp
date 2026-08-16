import assert from "node:assert/strict";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * Supervisor era state machine — admission-time classification, one-way era
 * lock, machine-readable rejections, and notification suppression.
 *
 * The supervisor is the SOLE era gatekeeper: the worker's own era
 * classification is unreliable for gating (a claim-less frame silently pins
 * the worker connection legacy), so every era decision here happens at
 * admission (handleClientMessage), in stdin order, before any forwarding.
 *
 * Machine-readable discrimination is by JSON-RPC error code + data only; the
 * full message strings are frozen as snapshots.
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

const ERA_CONFLICT_MODERN_MESSAGE =
  "initialize rejected: this server process is era-locked to protocol revision 2026-07-28 (modern per-request _meta era), so the legacy initialize handshake can no longer be accepted. Supported protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 (legacy initialize handshake) and 2026-07-28 (modern per-request _meta). To use the legacy handshake, start a fresh process: close this transport, terminate and respawn the configured server command as a fresh stdio process, discard or re-issue any pending request ids, then send initialize followed by notifications/initialized.";

const MISSING_META_UNSELECTED_MESSAGE =
  "Request rejected: no protocol era is selected yet and this request carries no valid era signal. Either send initialize followed by notifications/initialized to select the legacy handshake, or include the required io.modelcontextprotocol/* keys (io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities) in params._meta to select protocol revision 2026-07-28.";

const MISSING_META_MODERN_MESSAGE =
  "Request rejected: this server process is era-locked to protocol revision 2026-07-28 and the request lacks the required per-request _meta envelope. Include the required io.modelcontextprotocol/* keys (io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities) in params._meta.";

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
  era?: unknown;
  initializeRequest?: JSONRPCRequest;
  initializedNotification?: JSONRPCMessage;
  clientInitialized?: boolean;
  liveChildren: Set<FakeChild>;
  unresolvedTreeTokens: Set<number>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number } }>;
  queuedNotifications: JSONRPCMessage[];
  pendingRequests: Map<string, unknown>;
  restartTimer?: NodeJS.Timeout;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  scheduleRestart(failedAttempt?: boolean): void;
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
    kill: () => true
  };
}

function createEraHarness(): {
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
  const child = createWorker(123, workerWrites);
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  return { supervisor, child, outbound, workerWrites, events };
}

function modernMeta(): Record<string, unknown> {
  return { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };
}

function claimlessCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} }
  } as JSONRPCRequest;
}

function modernCall(id: number, name: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: modernMeta(), name, arguments: {} }
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
      clientInfo: { name: "era-state-test", version: "1.0.0" }
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

function hasFrame(writes: string[], methodSnippet: string): boolean {
  return writes.some((frame) => frame.includes(methodSnippet));
}

test("unselected claim-less tools/call is rejected with -32602 missing_meta naming both recovery paths", () => {
  const { supervisor, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(claimlessCall(1, "list-versions"));

  assert.equal(workerWrites.length, 0, "claim-less request must never reach the worker in the unselected state");
  assert.equal(outbound.length, 1);
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

test("unselected two-arm A: shallow-valid modern tools/call serves via the worker, locks modern, and a following initialize gets -32601 era_conflict", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(claimlessCall(1, "list-versions"));
  assert.equal((outbound.at(-1) as { error?: { code?: number } }).error?.code, -32602);

  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  assert.equal(workerWrites.length, 1, "shallow-valid modern request must forward to the worker");
  assert.equal(hasFrame(workerWrites, '"method":"tools/call"'), true);
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 2, result: { ok: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 2, result: { ok: true } });

  supervisor.handleClientMessage(legacyInitialize(3));
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 3,
    error: {
      code: -32601,
      message: ERA_CONFLICT_MODERN_MESSAGE,
      data: {
        kind: "era_conflict",
        selectedEra: "modern",
        requestedEra: "legacy",
        supported: ERA_SUPPORTED_VERSIONS
      }
    }
  });
  assert.equal(workerWrites.length, 1, "rejected initialize must never be forwarded");
  assert.equal(hasFrame(workerWrites, '"method":"initialize"'), false);
  assert.equal(supervisor.initializeRequest, undefined, "rejected initialize must never enter the replay cache");
});

test("unselected two-arm B: after a missing_meta rejection the legacy handshake still initializes and serves", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(claimlessCall(1, "list-versions"));
  assert.equal((outbound.at(-1) as { error?: { code?: number } }).error?.code, -32602);

  supervisor.handleClientMessage(legacyInitialize(2));
  assert.equal(hasFrame(workerWrites, '"method":"initialize"'), true, "era must remain unselected after the rejection: initialize must forward");
  supervisor.handleWorkerMessage(child, initializeResult(2));
  assert.deepEqual(
    (outbound.at(-1) as { id?: number; result?: { protocolVersion?: string } }).result?.protocolVersion,
    "2025-06-18"
  );

  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  assert.equal(hasFrame(workerWrites, '"method":"notifications/initialized"'), true);

  supervisor.handleClientMessage(claimlessCall(3, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 3, result: { served: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 3, result: { served: true } });
});

test("wrong-type-first claim (protocolVersion: 42) is rejected with missing clientCapabilities and invalid protocolVersion, then a modern lock still works", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: 42 }, name: "list-versions", arguments: {} }
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
        missing: [CLIENT_CAPABILITIES_KEY],
        invalid: [PROTOCOL_VERSION_KEY]
      }
    }
  });

  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  assert.equal(workerWrites.length, 1);
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 2, result: { ok: true } } as JSONRPCMessage);
  supervisor.handleClientMessage(legacyInitialize(3));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { kind?: string; selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32601);
  assert.equal(conflict.error?.data?.kind, "era_conflict");
  assert.equal(conflict.error?.data?.selectedEra, "modern");
});

test("wrong-type-first arm B: a claim-shaped-invalid rejection leaves legacy initialization available and omits empty invalid", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { _meta: { [CLIENT_CAPABILITIES_KEY]: {} }, name: "list-versions", arguments: {} }
  } as JSONRPCRequest);

  const rejection = outbound[0] as { error?: { code?: number; data?: Record<string, unknown> } };
  assert.equal(rejection.error?.code, -32602);
  assert.deepEqual(rejection.error?.data, {
    kind: "missing_meta",
    missing: [PROTOCOL_VERSION_KEY]
  });
  assert.equal(rejection.error !== undefined && "invalid" in (rejection.error.data ?? {}), false, "invalid must be omitted when empty");

  supervisor.handleClientMessage(legacyInitialize(2));
  assert.equal(hasFrame(workerWrites, '"method":"initialize"'), true);
  supervisor.handleWorkerMessage(child, initializeResult(2));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  supervisor.handleClientMessage(claimlessCall(3, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 3, result: { served: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 3, result: { served: true } });
});

test("modern-locked claim-less request is rejected -32602 at the supervisor and never forwarded", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1);

  supervisor.handleClientMessage(claimlessCall(2, "list-versions"));
  assert.equal(workerWrites.length, 1, "claim-less request must be rejected supervisor-side, never forwarded");
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32602,
      message: MISSING_META_MODERN_MESSAGE,
      data: {
        kind: "missing_meta",
        missing: [PROTOCOL_VERSION_KEY, CLIENT_CAPABILITIES_KEY]
      }
    }
  });
});

test("modern-locked claim-shaped-invalid request is rejected -32602 with the invalid key detail and never forwarded", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: null },
      name: "list-versions",
      arguments: {}
    }
  } as JSONRPCRequest);

  assert.equal(workerWrites.length, 1);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32602,
      message: MISSING_META_MODERN_MESSAGE,
      data: {
        kind: "missing_meta",
        missing: [],
        invalid: [CLIENT_CAPABILITIES_KEY]
      }
    }
  });
});

test("modern-locked subscriptions/listen is rejected -32601 Method not found at admission without a worker forward", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "subscriptions/listen",
    params: { _meta: modernMeta() }
  } as JSONRPCRequest);

  // Defense-in-depth note (not a test dependency): if admission were ever
  // bypassed, the worker (maxSubscriptions: 0) would answer -32603
  // "Subscription limit reached"; the plain -32601 below proves the
  // supervisor intercepted BEFORE any forward.
  assert.equal(workerWrites.length, 1, "subscriptions/listen must never reach the worker in the modern era");
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32601, message: "Method not found" }
  });
});

test("unselected modern-signal subscriptions/listen locks modern first, then rejects", () => {
  const { supervisor, outbound, workerWrites } = createEraHarness();
  // The modern-signal on subscriptions/listen counts as the era-locking
  // signal even though the method itself is rejected: lock modern first,
  // then reject -32601.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "subscriptions/listen",
    params: { _meta: modernMeta() }
  } as JSONRPCRequest);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" }
  });

  supervisor.handleClientMessage(legacyInitialize(2));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { kind?: string; selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32601);
  assert.equal(conflict.error?.data?.kind, "era_conflict");
  assert.equal(conflict.error?.data?.selectedEra, "modern", "subscriptions/listen must have locked modern before its rejection");
  assert.equal(workerWrites.length, 0);
});

test("modern-locked claim-less subscriptions/listen is rejected -32602 missing_meta before the method rejection", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);

  // The locked-state shallow check applies to EVERY request at admission:
  // a non-signal envelope fails -32602 before the method-level -32601.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "subscriptions/listen",
    params: {}
  } as JSONRPCRequest);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32602,
      message: MISSING_META_MODERN_MESSAGE,
      data: {
        kind: "missing_meta",
        missing: [PROTOCOL_VERSION_KEY, CLIENT_CAPABILITIES_KEY]
      }
    }
  });

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "subscriptions/listen",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28" } }
  } as JSONRPCRequest);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 3,
    error: {
      code: -32602,
      message: MISSING_META_MODERN_MESSAGE,
      data: {
        kind: "missing_meta",
        missing: [CLIENT_CAPABILITIES_KEY]
      }
    }
  });

  // Shallow-valid listen still gets the plain method rejection.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "subscriptions/listen",
    params: { _meta: modernMeta() }
  } as JSONRPCRequest);
  assert.deepEqual(outbound.at(-1), {
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32601, message: "Method not found" }
  });
  assert.equal(workerWrites.length, 1, "no listen variant may reach the worker in the modern era");
});

test("initialize carrying a shallow-valid modern _meta envelope still locks legacy", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  // initialize is the legacy era signal; any _meta envelope on it is ignored
  // for era classification.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      _meta: {
        ...modernMeta(),
        "io.modelcontextprotocol/clientInfo": { name: "hybrid", version: "0" },
        progressToken: "keep-me"
      },
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "era-state-test", version: "1.0.0" }
    }
  } as JSONRPCRequest);
  assert.equal(hasFrame(workerWrites, '"method":"initialize"'), true);
  // The forwarded frame must not carry the modern era-claim keys: the SDK's
  // opening classifier treats an initialize WITH a valid modern claim as
  // MODERN, which would diverge from this admission rule and fail the
  // handshake on a real worker. Non-era _meta keys pass through untouched.
  assert.equal(
    hasFrame(workerWrites, "io.modelcontextprotocol/"),
    false,
    "the era-claim _meta keys must be stripped before the initialize reaches the worker"
  );
  assert.equal(
    hasFrame(workerWrites, "keep-me"),
    true,
    "non-era _meta keys must survive the strip"
  );
  supervisor.handleWorkerMessage(child, initializeResult(1));
  assert.equal((outbound.at(-1) as { id?: number; error?: unknown }).id, 1);
  assert.equal((outbound.at(-1) as { error?: unknown }).error, undefined);

  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { selectedEra?: string } } };
  assert.equal(conflict.error?.code, -32600, "the enveloped initialize must have locked LEGACY, not modern");
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("modern-locked claim-less notifications/cancelled is dropped but its bookkeeping still suppresses the late response", (t) => {
  const { supervisor, child, outbound, workerWrites, events } = createEraHarness();
  t.after(() => {
    for (const pending of (supervisor as unknown as { pendingRequests: Map<string, { deadlineTimer?: NodeJS.Timeout }> }).pendingRequests.values()) {
      if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    }
  });
  supervisor.handleClientMessage(modernCall(1, "validate-project"));
  assert.equal(workerWrites.length, 1);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1, "a claim-less cancellation must not reach a modern-locked worker connection");
  assert.equal(outbound.length, 0);
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/cancelled", reason: "missing-meta" }
  });

  // Supervisor-side bookkeeping still marked the request cancelled: the
  // worker's late response must be suppressed.
  supervisor.handleWorkerMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "late" }] }
  } as JSONRPCMessage);
  assert.equal(outbound.some((message) => "id" in message && message.id === 1), false);
});

test("modern-locked shallow-valid notifications/cancelled forwards to the worker", () => {
  const { supervisor, child, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { _meta: modernMeta(), requestId: 99 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, 2, "a shallow-valid cancellation is legitimate modern traffic and must forward");
  assert.equal(hasFrame(workerWrites, '"method":"notifications/cancelled"'), true);
});

test("legacy-locked claim-less notifications/cancelled forwards as it does pre-migration", () => {
  const { supervisor, child, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  supervisor.handleClientMessage(claimlessCall(2, "list-versions"));
  const writesBeforeCancel = workerWrites.length;

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 2 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, writesBeforeCancel + 1, "legacy-locked cancellations forward with any envelope");
  assert.equal(hasFrame(workerWrites, '"method":"notifications/cancelled"'), true);
});

test("legacy-locked subscriptions/listen forwards to the worker and the era stays legacy", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  const writesAfterHandshake = workerWrites.length;

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "subscriptions/listen",
    params: {}
  } as JSONRPCRequest);
  assert.equal(workerWrites.length, writesAfterHandshake + 1, "legacy-locked subscriptions/listen must forward as ordinary legacy traffic");
  assert.equal(hasFrame(workerWrites, '"method":"subscriptions/listen"'), true);
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
  assert.equal(conflict.error?.code, -32600, "era must still be legacy after the forwarded listen");
  assert.equal(conflict.error?.data?.selectedEra, "legacy");
});

test("stray notifications/initialized in the unselected state is dropped without capture and a later modern lock still serves", () => {
  const { supervisor, child, outbound, workerWrites, events } = createEraHarness();
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);

  assert.equal(workerWrites.length, 0, "a stray initialized notification must not be forwarded (it would pin the worker legacy)");
  assert.equal(outbound.length, 0, "notifications never receive responses");
  assert.equal(supervisor.initializedNotification, undefined, "a stray initialized notification must not be captured");
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/initialized", reason: "era-unselected" }
  });

  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  assert.equal(workerWrites.length, 1);
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("claim-less notifications/cancelled before any era signal stays supervisor-side and a modern request then locks and serves", () => {
  const { supervisor, child, outbound, workerWrites } = createEraHarness();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 99 }
  } as JSONRPCMessage);

  assert.equal(workerWrites.length, 0, "an unselected-state cancellation must not be forwarded to the worker");
  assert.equal(outbound.length, 0);

  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 1, result: { ok: true } });

  supervisor.handleClientMessage(legacyInitialize(2));
  const conflict = outbound.at(-1) as { error?: { code?: number; data?: { kind?: string } } };
  assert.equal(conflict.error?.code, -32601);
  assert.equal(conflict.error?.data?.kind, "era_conflict");
});

test("modern-locked claim-less notification is dropped with no response while shallow-valid notifications forward", () => {
  const { supervisor, child, outbound, workerWrites, events } = createEraHarness();
  supervisor.handleClientMessage(modernCall(1, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1);
  const outboundAfterLock = outbound.length;

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: "p", progress: 1 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, 1, "modern-locked claim-less notification must be dropped");
  assert.equal(outbound.length, outboundAfterLock, "dropped notifications emit no response");
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/progress", reason: "missing-meta" }
  });

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { _meta: modernMeta(), progressToken: "p", progress: 2 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, 2, "modern-locked shallow-valid notification must forward");

  supervisor.handleClientMessage(modernCall(2, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 2, result: { still: "served" } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 2, result: { still: "served" } });
});

test("unselected non-lifecycle notification is consumed at the supervisor and a legacy handshake still proceeds", () => {
  const { supervisor, child, outbound, workerWrites, events } = createEraHarness();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: "p", progress: 1 }
  } as JSONRPCMessage);

  assert.equal(workerWrites.length, 0, "forwarding an unselected notification would pin the worker connection legacy");
  assert.equal(outbound.length, 0);
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/progress", reason: "era-unselected" }
  });

  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  supervisor.handleClientMessage(claimlessCall(2, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 2, result: { served: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 2, result: { served: true } });
});

test("legacy-locked modern-signal notification is dropped while claim-shaped-invalid notifications forward as today", () => {
  const { supervisor, child, workerWrites, events, outbound } = createEraHarness();
  supervisor.handleClientMessage(legacyInitialize(1));
  supervisor.handleWorkerMessage(child, initializeResult(1));
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  const writesAfterHandshake = workerWrites.length;
  const outboundAfterHandshake = outbound.length;

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { _meta: modernMeta(), progressToken: "p", progress: 1 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, writesAfterHandshake, "a shallow-VALID modern-signal notification must be dropped under the legacy lock");
  assert.equal(outbound.length, outboundAfterHandshake, "dropped notifications emit no response");
  assert.deepEqual(events.at(-1), {
    level: "warn",
    event: "supervisor.notification_dropped",
    details: { method: "notifications/progress", reason: "era-conflict" }
  });

  // Legacy-locked claim-shaped-invalid traffic forwards as it does
  // pre-migration — only shallow-VALID modern signals trigger the
  // era-conflict rules, keeping the legacy era maximally permissive.
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { _meta: { [PROTOCOL_VERSION_KEY]: 42 }, progressToken: "p", progress: 2 }
  } as JSONRPCMessage);
  assert.equal(workerWrites.length, writesAfterHandshake + 1, "claim-shaped-invalid notification must forward as today in the legacy era");

  supervisor.handleClientMessage(claimlessCall(2, "list-versions"));
  supervisor.handleWorkerMessage(child, { jsonrpc: "2.0", id: 2, result: { served: true } } as JSONRPCMessage);
  assert.deepEqual(outbound.at(-1), { jsonrpc: "2.0", id: 2, result: { served: true } });
});
