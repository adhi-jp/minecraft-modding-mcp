import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { encodeJsonRpcMessage, JsonRpcFrameReader } from "../../src/json-rpc-framing.ts";
import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * Three ways a request could still be stranded, all of them on a path that is
 * itself supposed to be the safety net.
 *
 * `forwardRequest`'s queue-limit fallback answers the request terminally
 * but ran after admission had already raised the validate barrier for it, so
 * the barrier stayed up with no occupant left to lower it.
 *
 * The admission catch in `handleClientMessage` reports, rolls back,
 * replies and drains. Only the drain was guarded, so a fault in any earlier
 * step escaped into the frame reader, which reports it as a parse error and
 * drops the frame — losing the very request the catch exists to answer.
 *
 * The worker reader's `onFrame` called `handleWorkerMessage` unguarded.
 * A throw there left the forwarded entry live with no reply and, for anything
 * other than validate-project (the only method that arms a deadline), nothing
 * left that could ever settle it. The recovery has two halves that fail
 * independently: answering the id the faulted frame was carrying, and running
 * the drain `handleWorkerMessage` performs as its last statement. The second
 * half is the one with no fallback — a queued non-validate request arms no
 * deadline — so the tests below exercise each recovery step's fault in turn
 * and check that the drain survives all of them.
 *
 * The cases under "Further fault paths found by review" are about the
 * recovery being WRONG rather than absent: a fault contained without the
 * request being recovered, a missing pending entry read as proof of delivery,
 * a terminal reply sent alongside state that can reply again, a carve-out
 * deferring to a lifecycle that is not armed, an error conversion that throws
 * before any guard is installed, and a release that threw after it had already
 * done its work. Where a case cannot be repaired without a mechanism the
 * project has ruled out at RC, the test pins the limited behaviour instead and
 * says so on the assertion.
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

type QueuedEntry = { message: JSONRPCRequest; pending: { id: string | number; method?: string } };

type LoggedEvent = { level: string; event: string; details?: Record<string, unknown> };

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  pendingRequests: Map<string, unknown>;
  queuedRequests: QueuedEntry[];
  validateBarrierKey?: string;
  runningValidateKey?: string;
  startupWatchdog?: unknown;
  clientReader: { currentMode: string; isFatal: boolean };
  workerReaders: Map<FakeChild, JsonRpcFrameReader>;
  writeToWorker(child: FakeChild, message: JSONRPCMessage): void;
  canDispatchImmediately(pending: unknown): boolean;
  rollbackFailedAdmission(key: string, preexisting: Set<unknown>): boolean;
  releaseForwardedRequest(key: string, pending: unknown): boolean;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerData(child: FakeChild, chunk: Buffer): void;
  handleClientData(chunk: Buffer): void;
  handleClientMessage(message: JSONRPCMessage): void;
  drainQueue(): void;
  recoverTimedOutWorker(): void;
  spawnWorker(): void;
  handleWorkerReady(child: FakeChild): void;
  timerClearer(timer: unknown): void;
  initializeRequest?: JSONRPCRequest;
  shutdown(): Promise<void>;
};

type ReplyFrame = {
  id?: unknown;
  error?: { code?: number; message?: string };
  result?: unknown;
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

function repliesFor(outbound: JSONRPCMessage[], id: number): ReplyFrame[] {
  return outbound.filter((frame) => (frame as ReplyFrame).id === id) as ReplyFrame[];
}

type Fixture = {
  supervisor: Harness;
  child: FakeChild;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
  events: LoggedEvent[];
  timers: FakeScheduledTimer[];
  /** Event names whose write must throw, simulating a faulting event writer. */
  failingEvents: Set<string>;
  /**
   * Request ids whose client-bound write must throw. `writeToClient` catches a
   * writer fault and reports it through `eventWriter`, so making the write
   * ESCAPE also needs `supervisor.client_write_error` in `failingEvents`.
   *
   * That pairing is a fixture arrangement, not a fact about the process. This
   * fixture INJECTS both writers, so one can fault without the other. In the
   * default configuration they are different channels — replies go to
   * `process.stdout`, `log` writes to `process.stderr` — so a broken stdout
   * does not by itself establish that the report fails too. Faulting both is
   * simply the arrangement that makes the reply step THROW rather than
   * swallow, which is the case these tests need to cover.
   */
  failingReplyIds: Set<unknown>;
  /**
   * One-shot variants of the two sets above: an entry throws on its FIRST use
   * and is then removed, so a later write on the same channel succeeds. This
   * is what a TRANSIENT fault looks like, and it is the only arrangement in
   * which a recovery's own client-bound write can be observed at all — a
   * permanently broken client channel swallows the recovery's reply along with
   * the reply it is recovering.
   */
  transientFailingEvents: Set<string>;
  transientFailingReplyIds: Set<unknown>;
};

function createFixture(): Fixture {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const events: LoggedEvent[] = [];
  const timers: FakeScheduledTimer[] = [];
  const failingEvents = new Set<string>();
  const failingReplyIds = new Set<unknown>();
  const transientFailingEvents = new Set<string>();
  const transientFailingReplyIds = new Set<unknown>();
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message: JSONRPCMessage) => {
      const id = (message as { id?: unknown }).id;
      if (transientFailingReplyIds.has(id)) {
        transientFailingReplyIds.delete(id);
        throw new Error("synthetic client write fault");
      }
      if (failingReplyIds.has(id)) {
        throw new Error("synthetic client write fault");
      }
      outbound.push(message);
    },
    eventWriter: (level: string, event: string, details?: Record<string, unknown>) => {
      events.push({ level, event, details });
      if (transientFailingEvents.has(event)) {
        transientFailingEvents.delete(event);
        throw new Error("synthetic event writer fault");
      }
      if (failingEvents.has(event)) {
        throw new Error("synthetic event writer fault");
      }
    },
    monotonicNow: () => 0,
    timerScheduler: (callback: () => void) => {
      const timer = {
        callback,
        cleared: false,
        unref() {
          return this;
        }
      } as unknown as FakeScheduledTimer;
      timers.push(timer);
      return timer;
    },
    timerClearer: (timer: unknown) => {
      (timer as FakeScheduledTimer).cleared = true;
    }
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 707,
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
  // spawnWorker installs the per-child frame reader; a fixture child that was
  // never spawned has to bring its own or handleWorkerData ignores every byte.
  supervisor.workerReaders.set(child, new JsonRpcFrameReader());
  supervisor.recoverTimedOutWorker = () => {};
  return {
    supervisor,
    child,
    outbound,
    workerWrites,
    events,
    timers,
    failingEvents,
    failingReplyIds,
    transientFailingEvents,
    transientFailingReplyIds
  };
}

/** Fills the supervisor queue to its limit with plausible, inert entries. */
function fillQueue(supervisor: Harness): void {
  for (const id of [901, 902]) {
    supervisor.queuedRequests.push({
      message: modernCall(id, "list-versions"),
      pending: { id, method: "tools/call" }
    });
  }
}

/**
 * Parks one ordinary request in the queue.
 *
 * A queued NON-validate request is the probe for whether a drain ran: nothing
 * but a drain dispatches it, no deadline is armed for it (only validate-project
 * arms one), and it reaches the worker the moment a drain is allowed to run.
 */
function queueRequest(supervisor: Harness, id: number): void {
  supervisor.queuedRequests.push({
    message: modernCall(id, "list-versions"),
    pending: { id, method: "tools/call" }
  });
}

/**
 * How many times `id` was written to the worker.
 *
 * A presence check (`.some()`) proves a queued request was dispatched but not
 * that it was dispatched ONCE. A recovery drain runs on top of a drain the
 * ordinary path may also have run, so double dispatch — the worker receiving
 * one request twice and answering it twice — is a live failure mode here, and
 * only a count can see it.
 */
function dispatchCount(workerWrites: string[], id: number): number {
  return workerWrites.filter((frame) => frame.includes(`"id":${id}`)).length;
}

function reachedWorker(workerWrites: string[], id: number): boolean {
  return dispatchCount(workerWrites, id) > 0;
}

/**
 * Captures what `log` writes while `run()` executes.
 *
 * `runRecoveryStep` reports through the module-level `log`, not through the
 * injected `eventWriter` — deliberately, so an injected writer is not also its
 * own reporter — and `log` writes JSON lines to stderr. Capturing them is the
 * only way to tell "the step faulted and was contained" from "the step faulted
 * and escaped into the frame reader", which is otherwise invisible: the reader
 * turns an escaping throw into a plain parse error that `handleWorkerData`
 * also reports through `log`.
 */
function captureLogLines(run: () => void): string[] {
  const lines: string[] = [];
  const stream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const original = stream.write;
  stream.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    stream.write = original;
  }
  return lines;
}

function loggedEvents(lines: string[]): string[] {
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: unknown };
      return typeof parsed.event === "string" ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
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

// --- forwardRequest's queue-limit fallback ------------------------------

test("a queue-limit rejection at the forward fallback lowers the barrier it took", async () => {
  const { supervisor, child, outbound, timers } = createFixture();
  fillQueue(supervisor);
  // Admission raises the validate barrier BEFORE forwarding, so only a request
  // that passes the admission-time queue check and then finds no usable child
  // reaches the fallback still holding it.
  supervisor.canDispatchImmediately = () => true;
  child.stdin.destroyed = true;

  supervisor.handleClientMessage(modernCall(30, "validate-project"));

  const replies = repliesFor(outbound, 30);
  assert.equal(replies.length, 1, "the rejected request must receive exactly one reply");
  assert.match(JSON.stringify(replies[0]), /ERR_LIMIT_EXCEEDED/);
  assert.equal(
    supervisor.validateBarrierKey,
    undefined,
    "a terminally answered request must not leave the dispatch barrier raised"
  );
  assert.equal(supervisor.pendingRequests.size, 0, "nothing was forwarded, so nothing may be live");
  assert.equal(timers.length, 1, "admission arms exactly one validate-project deadline");
  assert.equal(timers[0].cleared, true, "the armed deadline must be cleared by the rejection");

  await supervisor.shutdown();
});

test("a queue-limit rejection leaves a running namesake's barrier alone", async () => {
  const { supervisor, child, outbound } = createFixture();
  fillQueue(supervisor);
  supervisor.canDispatchImmediately = () => true;
  child.stdin.destroyed = true;
  // A client may legally reuse a live id. The barrier here belongs to the
  // RUNNING request at that key, and lowering it would admit concurrent work
  // alongside a live validate-project.
  supervisor.validateBarrierKey = "number:31";
  supervisor.runningValidateKey = "number:31";

  supervisor.handleClientMessage(modernCall(31, "validate-project"));

  assert.equal(repliesFor(outbound, 31).length, 1, "the rejected instance is still answered");
  assert.equal(
    supervisor.validateBarrierKey,
    "number:31",
    "the running namesake keeps the barrier it is holding"
  );

  await supervisor.shutdown();
});

// --- handleClientMessage's admission catch ----------------------------

test("an event-writer fault in the admission recovery still answers the request id", async () => {
  const { supervisor, outbound, failingEvents } = createFixture();
  failWorkerWritesFor(supervisor, new Set([40]));
  // The report is the FIRST step of the recovery, so its fault used to abort
  // the rollback, the reply and the drain that follow it.
  failingEvents.add("supervisor.admission_failed");

  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(40, "list-versions"), "content-length"));

  const replies = repliesFor(outbound, 40);
  assert.equal(replies.length, 1, "a faulting event writer must not cost the client its reply");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:40"),
    false,
    "the half-installed entry must still be rolled back"
  );
  assert.equal(
    supervisor.clientReader.currentMode,
    "content-length",
    "a recovery fault must not disturb the negotiated framing"
  );
  assert.equal(supervisor.clientReader.isFatal, false, "the session must survive a recovery fault");

  await supervisor.shutdown();
});

test("a rollback fault in the admission recovery still answers the request id", async () => {
  const { supervisor, outbound, workerWrites } = createFixture();
  failWorkerWritesFor(supervisor, new Set([41]));
  supervisor.rollbackFailedAdmission = () => {
    throw new Error("synthetic rollback fault");
  };

  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(41, "list-versions"), "content-length"));

  const replies = repliesFor(outbound, 41);
  assert.equal(replies.length, 1, "a rollback fault must not swallow the request");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(supervisor.clientReader.currentMode, "content-length");
  assert.equal(supervisor.clientReader.isFatal, false);

  // The reader is still accepting input and the supervisor still admitting.
  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(42, "list-versions"), "content-length"));
  assert.equal(
    workerWrites.some((frame) => frame.includes("\"id\":42")),
    true,
    "a later request must still reach the worker"
  );

  await supervisor.shutdown();
});

test("a reply fault in the admission recovery still drains the queue behind it", async () => {
  const { supervisor, workerWrites, failingEvents, failingReplyIds } = createFixture();
  failWorkerWritesFor(supervisor, new Set([43]));
  // Admission would otherwise queue behind a non-empty queue; forcing the
  // dispatch is what puts this request on the forward path with work parked
  // behind it, which is the only way the drain step has anything to prove.
  supervisor.canDispatchImmediately = () => true;
  queueRequest(supervisor, 903);
  // The terminal -32603 cannot be written, and neither can the write-error
  // report: one broken client channel breaks both, which is what makes the
  // reply step throw rather than swallow.
  failingReplyIds.add(43);
  failingEvents.add("supervisor.client_write_error");

  const lines = captureLogLines(() => {
    supervisor.handleClientData(
      encodeJsonRpcMessage(modernCall(43, "list-versions"), "content-length")
    );
  });

  assert.equal(
    dispatchCount(workerWrites, 903),
    1,
    "a reply that cannot be written must not cost the queue behind it its drain"
  );
  const logged = loggedEvents(lines);
  assert.equal(
    logged.includes("supervisor.recovery_step_failed"),
    true,
    "the reply fault is contained and reported"
  );
  assert.equal(
    logged.includes("supervisor.client_parse_error"),
    false,
    "and never reaches the reader, which would report it as a dropped frame"
  );

  await supervisor.shutdown();
});

// --- the worker reader's onFrame ----------------------------------------

/** A worker response frame for `id`, as the worker's reader would deliver it. */
function workerResponse(id: number): Buffer {
  return encodeJsonRpcMessage(
    { jsonrpc: "2.0", id, result: { content: [] } } as never,
    "content-length"
  );
}

test("a fault handling a worker response releases and answers the pending request", async () => {
  const { supervisor, child, outbound, events } = createFixture();
  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(50, "list-versions"), "content-length"));
  assert.equal(supervisor.pendingRequests.has("number:50"), true, "the request must be forwarded");

  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };
  supervisor.handleWorkerData(child, workerResponse(50));

  const replies = repliesFor(outbound, 50);
  assert.equal(replies.length, 1, "the client must still receive a terminal reply for the id");
  assert.equal(replies[0].error?.code, -32603);
  assert.match(String(replies[0].error?.message), /synthetic worker message fault/);
  assert.equal(
    supervisor.pendingRequests.has("number:50"),
    false,
    "the stranded entry must be released — nothing else would ever settle it"
  );
  assert.equal(
    events.some((entry) => entry.event === "supervisor.worker_message_failed"),
    true,
    "the fault must be observable in the event stream"
  );

  await supervisor.shutdown();
});

test("a fault handling a worker response neither ends the session nor stops later frames", async () => {
  const { supervisor, child, outbound } = createFixture();
  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(51, "list-versions"), "content-length"));
  supervisor.handleClientData(encodeJsonRpcMessage(modernCall(52, "list-versions"), "content-length"));

  const realHandler = supervisor.handleWorkerMessage.bind(supervisor);
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };
  supervisor.handleWorkerData(child, workerResponse(51));

  assert.equal(supervisor.child, child, "one unhandled frame is not evidence the worker is unusable");
  supervisor.handleWorkerMessage = realHandler;
  supervisor.handleWorkerData(child, workerResponse(52));

  const passthrough = repliesFor(outbound, 52);
  assert.equal(passthrough.length, 1, "the next worker frame must still be delivered");
  assert.deepEqual(passthrough[0].result, { content: [] }, "and delivered unchanged");

  await supervisor.shutdown();
});

test("a fault handling a worker response preserves the in-flight initialize carve-out", async () => {
  const { supervisor, child, outbound, events } = createFixture();
  // The handshake's pending entry belongs to the initialization lifecycle,
  // which owns its own recovery paths; releasing it here would answer an id
  // that replay correlation still expects to settle itself.
  //
  // `initializeRequest` is set alongside the pending entry, matching the real
  // admission invariant (handleClientMessage sets both together): it is what
  // failPendingRequestsOnWorkerExit's preservedInitializeKey carve-out keys
  // off, not `pending.method`.
  supervisor.initializeRequest = {
    jsonrpc: "2.0",
    id: 60,
    method: "initialize",
    params: {}
  } as unknown as JSONRPCRequest;
  supervisor.pendingRequests.set("number:60", {
    id: 60,
    method: "initialize",
    startedAt: 0,
    mode: "content-length",
    era: "unselected"
  });

  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };
  supervisor.handleWorkerData(child, workerResponse(60));

  assert.equal(repliesFor(outbound, 60).length, 0, "an in-flight initialize must not be answered here");
  assert.equal(
    supervisor.pendingRequests.has("number:60"),
    true,
    "the handshake entry must survive the fault"
  );
  assert.equal(
    events.some((entry) => entry.event === "supervisor.worker_message_failed"),
    true,
    "the fault is still reported"
  );

  await supervisor.shutdown();
});

test("a fault after the pending entry was already removed still drains the queue", async () => {
  const { supervisor, child, outbound, workerWrites, events, failingEvents, failingReplyIds } =
    createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(55, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 907);
  // The commonest fault shape, and the one an early return used to strand.
  // handleWorkerMessage deletes a response's pending entry BEFORE the client
  // write, and its drainQueue() is the statement after that write — so a write
  // fault reaches the recovery with nothing left to release AND the queue
  // still parked. A recovery that drained only after a successful release
  // would skip exactly this case.
  failingReplyIds.add(55);
  failingEvents.add("supervisor.client_write_error");

  supervisor.handleWorkerData(child, workerResponse(55));

  assert.equal(
    supervisor.pendingRequests.has("number:55"),
    false,
    "the premise: handleWorkerMessage had already removed the entry when it faulted"
  );
  assert.equal(
    events.some((entry) => entry.event === "supervisor.worker_message_failed"),
    true,
    "the fault is still reported"
  );
  assert.equal(
    dispatchCount(workerWrites, 907),
    1,
    "the queued request must still be dispatched — no deadline would ever rescue it"
  );
  assert.deepEqual(outbound, [], "the client channel is broken, so nothing reached the client");

  await supervisor.shutdown();
});

test("a fault-released id is tombstoned, so the worker's late answer is discarded", async () => {
  const { supervisor, child, outbound, events } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(56, "list-versions"), "content-length")
  );

  const realHandler = supervisor.handleWorkerMessage.bind(supervisor);
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };
  supervisor.handleWorkerData(child, workerResponse(56));
  assert.equal(repliesFor(outbound, 56).length, 1, "the recovery answers the id once");

  // The worker owes nothing once the supervisor has synthesized a terminal
  // reply, but it does not know that: its own answer for the id can still
  // arrive. Releasing the entry without recording the finality tombstone would
  // let that answer through as a SECOND response for one request.
  supervisor.handleWorkerMessage = realHandler;
  supervisor.handleWorkerData(child, workerResponse(56));

  assert.equal(
    repliesFor(outbound, 56).length,
    1,
    "exactly one response per request id survives the late answer"
  );
  assert.equal(
    events.some((entry) => entry.event === "supervisor.late_response_discarded"),
    true,
    "and the discard is observable rather than silent"
  );

  await supervisor.shutdown();
});

test("an event-writer fault in the worker recovery still answers the request id", async () => {
  const { supervisor, child, outbound, failingEvents } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(57, "list-versions"), "content-length")
  );
  // The report is the FIRST step of the recovery, so an unguarded fault there
  // aborts the release, the reply and the drain that follow it.
  failingEvents.add("supervisor.worker_message_failed");
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  supervisor.handleWorkerData(child, workerResponse(57));

  const replies = repliesFor(outbound, 57);
  assert.equal(replies.length, 1, "a faulting event writer must not cost the client its reply");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:57"),
    false,
    "the stranded entry is still released"
  );

  await supervisor.shutdown();
});

test("a release fault in the worker recovery leaves the id alone but still drains", async () => {
  const { supervisor, child, outbound, workerWrites } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(58, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 908);
  supervisor.releaseForwardedRequest = () => {
    throw new Error("synthetic release fault");
  };
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  const lines = captureLogLines(() => supervisor.handleWorkerData(child, workerResponse(58)));

  assert.equal(
    supervisor.pendingRequests.has("number:58"),
    true,
    "a release that threw released nothing, so the entry still owns its id"
  );
  assert.equal(
    repliesFor(outbound, 58).length,
    0,
    "and a still-live entry must not be answered on its behalf"
  );
  assert.equal(
    dispatchCount(workerWrites, 908),
    1,
    "the queue behind it is drained regardless — that is the half a release cannot block"
  );
  const logged = loggedEvents(lines);
  assert.equal(logged.includes("supervisor.recovery_step_failed"), true, "the fault is reported");
  assert.equal(
    logged.includes("supervisor.worker_parse_error"),
    false,
    "and contained: escaping into the reader would report it as a dropped frame"
  );

  await supervisor.shutdown();
});

test("a reply fault in the worker recovery still drains the queue behind it", async () => {
  const { supervisor, child, workerWrites, failingEvents, failingReplyIds } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(59, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 909);
  failingReplyIds.add(59);
  failingEvents.add("supervisor.client_write_error");
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  const lines = captureLogLines(() => supervisor.handleWorkerData(child, workerResponse(59)));

  assert.equal(
    supervisor.pendingRequests.has("number:59"),
    false,
    "the entry was released before the reply that could not be written"
  );
  assert.equal(
    dispatchCount(workerWrites, 909),
    1,
    "an unwritable reply must not cost the queue behind it its drain"
  );
  const logged = loggedEvents(lines);
  assert.equal(logged.includes("supervisor.recovery_step_failed"), true, "the fault is reported");
  assert.equal(logged.includes("supervisor.worker_parse_error"), false, "and contained");

  await supervisor.shutdown();
});

test("a drain fault whose own settle cannot run is still contained, and pinned", async () => {
  const { supervisor, child, outbound, workerWrites, failingEvents, failingReplyIds } =
    createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(61, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 910);
  // The drain forwards the queued request, and forwarding writes to the worker
  // — the step of a drain that realistically throws. Installed after id 61 was
  // forwarded so only the drain's own write fails.
  failWorkerWritesFor(supervisor, new Set([910]));
  // ...and then the per-entry settle that answers 910 cannot be written either.
  // This is the layer BELOW the repair: the dispatch fault is answered by
  // dispatchQueuedRequest, but that answer travels the same broken client
  // channel, so here even the recovery's own reply is lost.
  failingReplyIds.add(910);
  failingEvents.add("supervisor.client_write_error");
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  const lines = captureLogLines(() => supervisor.handleWorkerData(child, workerResponse(61)));

  assert.equal(
    repliesFor(outbound, 61).length,
    1,
    "the answering half completed before the drain faulted"
  );
  assert.equal(dispatchCount(workerWrites, 910), 0, "the drain's own write is what threw");
  // Pinned limitation: the entry is released and tombstoned, so it can never
  // produce a second reply — but with the client channel refusing writes it
  // produces no reply at all. Nothing in this file can deliver to a channel
  // that will not accept bytes; what it guarantees is that the id is not left
  // live and unanswerable.
  assert.equal(
    supervisor.pendingRequests.has("number:910"),
    false,
    "the undispatched request does not stay live at an id nothing can settle"
  );
  assert.deepEqual(outbound.filter((frame) => (frame as ReplyFrame).id === 910), []);
  const logged = loggedEvents(lines);
  assert.equal(
    logged.includes("supervisor.recovery_step_failed"),
    true,
    "the settle's own fault is contained and reported"
  );
  assert.equal(
    logged.includes("supervisor.worker_parse_error"),
    false,
    "and never reaches the reader, which would report it as a dropped frame"
  );

  await supervisor.shutdown();
});

// --- Further fault paths found by review -----------------------------------

/**
 * A thrown value whose string conversion itself throws.
 *
 * `String(value)` calls `toString`, so this reaches every unguarded
 * `error instanceof Error ? error.message : String(error)` in the recovery
 * paths — before any guard runs, which is what makes it a bypass rather than
 * a contained fault.
 */
function unstringifiableThrowable(): unknown {
  return {
    toString() {
      throw new Error("conversion failed");
    }
  };
}

/** An `Error` whose `message` getter throws, the same bypass by the other branch. */
function errorWithThrowingMessage(): Error {
  const error = new Error("placeholder");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("message getter failed");
    }
  });
  return error;
}

test("a dispatch fault during the recovery drain terminally answers the request it stranded", async () => {
  const { supervisor, child, outbound, workerWrites, events } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(61, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 910);
  queueRequest(supervisor, 911);
  // The drain shifts 910 out of the queue and installs it in pendingRequests
  // BEFORE the write that throws, so containing the throw leaves 910 owning an
  // id nothing will ever answer: no deadline is armed for a non-validate tool.
  failWorkerWritesFor(supervisor, new Set([910]));
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  const lines = captureLogLines(() => supervisor.handleWorkerData(child, workerResponse(61)));

  assert.equal(repliesFor(outbound, 61).length, 1, "the faulted frame's own id is answered");
  const stranded = repliesFor(outbound, 910);
  assert.equal(stranded.length, 1, "the request the drain could not dispatch is answered too");
  assert.equal(stranded[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:910"),
    false,
    "and it does not stay live at an id nothing can settle"
  );
  assert.equal(dispatchCount(workerWrites, 910), 0, "its write is what threw");
  assert.equal(
    dispatchCount(workerWrites, 911),
    1,
    "the request behind it is dispatched exactly once — a dispatch fault is per-entry"
  );
  assert.equal(supervisor.queuedRequests.length, 0, "and the queue is emptied, not parked");
  assert.equal(
    events.some((entry) => entry.event === "supervisor.queued_dispatch_failed"),
    true,
    "the dispatch fault is observable rather than silent"
  );
  assert.equal(
    loggedEvents(lines).includes("supervisor.worker_parse_error"),
    false,
    "and nothing escaped into the reader"
  );

  await supervisor.shutdown();
});

test("a transient client-write fault after the entry was removed still answers the id", async () => {
  const {
    supervisor,
    child,
    outbound,
    events,
    transientFailingEvents,
    transientFailingReplyIds
  } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(55, "list-versions"), "content-length")
  );
  // handleWorkerMessage deletes the pending entry BEFORE writing the reply, so
  // a write fault there reaches the recovery with the entry already gone. A
  // missing entry proves neither that the id was answered nor that it was
  // never tracked, and treating it as settled leaves 55 permanently unanswered
  // while the session stays healthy. Both faults are transient, so the
  // recovery's own reply can get out.
  transientFailingReplyIds.add(55);
  transientFailingEvents.add("supervisor.client_write_error");

  supervisor.handleWorkerData(child, workerResponse(55));

  const replies = repliesFor(outbound, 55);
  assert.equal(replies.length, 1, "the id the worker answered must still reach the client");
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:55"),
    false,
    "nothing is left live at the id"
  );

  // The recovery answered on the worker's behalf, so the worker's own answer —
  // which it may still repeat — must not become a second response.
  supervisor.handleWorkerData(child, workerResponse(55));
  assert.equal(repliesFor(outbound, 55).length, 1, "exactly one response per request id");
  assert.equal(
    events.some((entry) => entry.event === "supervisor.late_response_discarded"),
    true,
    "and the discard is observable"
  );

  await supervisor.shutdown();
});

test("a rollback fault leaves nothing live that could answer the id a second time", async () => {
  const { supervisor, child, outbound, events } = createFixture();
  failWorkerWritesFor(supervisor, new Set([41]));
  supervisor.rollbackFailedAdmission = () => {
    throw new Error("synthetic rollback fault");
  };

  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(41, "list-versions"), "content-length")
  );

  assert.equal(repliesFor(outbound, 41).length, 1, "the id is answered once");
  assert.equal(
    supervisor.pendingRequests.has("number:41"),
    false,
    "the half-installed entry the faulted rollback left behind is gone"
  );

  // The -32603 is terminal for the id. A surviving entry would let the worker's
  // own answer through as a second reply for one request.
  supervisor.handleWorkerData(child, workerResponse(41));
  assert.equal(repliesFor(outbound, 41).length, 1, "the late worker answer is not a second reply");
  assert.equal(
    events.some((entry) => entry.event === "supervisor.late_response_discarded"),
    true,
    "and it is discarded through the finality tombstone, not by chance"
  );

  await supervisor.shutdown();
});

test("an admission whose cleanup cannot run at all withholds the terminal reply", async () => {
  const { supervisor, child, outbound } = createFixture();
  failWorkerWritesFor(supervisor, new Set([44]));
  supervisor.rollbackFailedAdmission = () => {
    throw new Error("synthetic rollback fault");
  };
  supervisor.releaseForwardedRequest = () => {
    throw new Error("synthetic release fault");
  };

  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(44, "list-versions"), "content-length")
  );

  // Nothing could remove the entry, so it still owns the id. Answering anyway
  // would be the second terminal reply the moment anything else settles it, so
  // the recovery declines instead and leaves the id to its ordinary settle
  // paths (a worker answer, the worker-exit terminalization).
  assert.equal(
    supervisor.pendingRequests.has("number:44"),
    true,
    "the premise: the entry could not be removed"
  );
  assert.equal(
    repliesFor(outbound, 44).length,
    0,
    "so the recovery must not add a terminal reply alongside it"
  );

  // Known limitation, pinned so it cannot silently get worse: no deadline is
  // armed for a non-validate tool, so this id waits for the worker or for the
  // worker's exit. The worker-exit path is what settles it.
  supervisor.handleWorkerData(child, workerResponse(44));
  assert.equal(repliesFor(outbound, 44).length, 1, "the worker's own answer settles it, once");

  await supervisor.shutdown();
});

test("a fault handling an in-flight initialize's response replaces the worker generation", async () => {
  const { supervisor, child, outbound } = createFixture();
  let recoveries = 0;
  supervisor.recoverTimedOutWorker = () => {
    recoveries += 1;
  };
  // The lifecycle the carve-out defers to: the client's initialize reached an
  // ALREADY-READY worker, so adoptActiveChild had cleared the startup watchdog
  // before admission forwarded it.
  //
  // `initializeRequest` mirrors the real admission invariant: it is what
  // failPendingRequestsOnWorkerExit's preservedInitializeKey carve-out keys
  // off (see answerFaultedWorkerResponse's initialize_recovery step).
  supervisor.initializeRequest = {
    jsonrpc: "2.0",
    id: 62,
    method: "initialize",
    params: {}
  } as unknown as JSONRPCRequest;
  supervisor.pendingRequests.set("number:62", {
    id: 62,
    method: "initialize",
    startedAt: 0,
    mode: "content-length",
    era: "unselected"
  });
  assert.equal(
    supervisor.startupWatchdog,
    undefined,
    "the premise: no watchdog is armed once the worker has been adopted"
  );

  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };
  supervisor.handleWorkerData(child, workerResponse(62));

  assert.equal(repliesFor(outbound, 62).length, 0, "the handshake entry is still not answered here");
  assert.equal(
    supervisor.pendingRequests.has("number:62"),
    true,
    "and it still belongs to the initialization lifecycle"
  );
  assert.equal(
    recoveries,
    1,
    "but the generation whose initialize answer was lost is replaced, which re-arms the watchdog"
  );

  await supervisor.shutdown();
});

test("a worker-handler fault whose error cannot be stringified still recovers the request", async () => {
  const { supervisor, child, outbound, workerWrites } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(63, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 912);
  supervisor.handleWorkerMessage = () => {
    throw unstringifiableThrowable();
  };

  const lines = captureLogLines(() => supervisor.handleWorkerData(child, workerResponse(63)));

  assert.equal(
    repliesFor(outbound, 63).length,
    1,
    "formatting the error must not bypass the recovery it is describing"
  );
  assert.equal(repliesFor(outbound, 63)[0].error?.code, -32603);
  assert.equal(supervisor.pendingRequests.has("number:63"), false, "the entry is released");
  assert.equal(dispatchCount(workerWrites, 912), 1, "and the queue behind it is drained once");
  assert.equal(
    loggedEvents(lines).includes("supervisor.worker_parse_error"),
    false,
    "nothing escaped into the reader"
  );

  await supervisor.shutdown();
});

test("an Error with a throwing message getter still recovers the request", async () => {
  const { supervisor, child, outbound } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(64, "list-versions"), "content-length")
  );
  supervisor.handleWorkerMessage = () => {
    throw errorWithThrowingMessage();
  };

  supervisor.handleWorkerData(child, workerResponse(64));

  assert.equal(repliesFor(outbound, 64).length, 1, "the other branch of the conversion is guarded too");
  assert.equal(supervisor.pendingRequests.has("number:64"), false);

  await supervisor.shutdown();
});

test("an admission fault whose error cannot be stringified still answers the request id", async () => {
  const { supervisor, outbound } = createFixture();
  supervisor.writeToWorker = () => {
    throw unstringifiableThrowable();
  };

  const lines = captureLogLines(() => {
    supervisor.handleClientData(
      encodeJsonRpcMessage(modernCall(65, "list-versions"), "content-length")
    );
  });

  assert.equal(repliesFor(outbound, 65).length, 1, "the admission catch has the identical conversion");
  assert.equal(repliesFor(outbound, 65)[0].error?.code, -32603);
  assert.equal(
    loggedEvents(lines).includes("supervisor.client_parse_error"),
    false,
    "and it no longer escapes into the reader"
  );

  await supervisor.shutdown();
});

test("a release that throws after removing the entry still answers the request", async () => {
  const { supervisor, child, outbound, workerWrites } = createFixture();
  supervisor.handleClientData(
    encodeJsonRpcMessage(modernCall(58, "list-versions"), "content-length")
  );
  queueRequest(supervisor, 913);
  // releaseForwardedRequest deletes the entry and records its tombstone BEFORE
  // it returns, so a throw part-way through can still have taken the id away
  // from its entry. The assignment to `released` never completes, but the
  // release did happen — and an entry that no longer owns its id has nothing
  // left that could ever answer it.
  const realRelease = supervisor.releaseForwardedRequest.bind(supervisor);
  supervisor.releaseForwardedRequest = (key: string, pending: unknown) => {
    realRelease(key, pending);
    throw new Error("synthetic post-mutation release fault");
  };
  supervisor.handleWorkerMessage = () => {
    throw new Error("synthetic worker message fault");
  };

  supervisor.handleWorkerData(child, workerResponse(58));

  assert.equal(
    supervisor.pendingRequests.has("number:58"),
    false,
    "the premise: the release completed its mutation before it threw"
  );
  assert.equal(
    repliesFor(outbound, 58).length,
    1,
    "so the id is answered rather than left to nothing"
  );
  assert.equal(repliesFor(outbound, 58)[0].error?.code, -32603);
  assert.equal(dispatchCount(workerWrites, 913), 1, "and the queue behind it is drained once");

  await supervisor.shutdown();
});

test("a queue-limit rejection lowers a barrier a QUEUED namesake owns, which re-raises it", async () => {
  const { supervisor, child, outbound } = createFixture();
  fillQueue(supervisor);
  supervisor.canDispatchImmediately = () => true;
  child.stdin.destroyed = true;
  // The third owner shape: not the rejected instance and not a RUNNING
  // namesake, but another QUEUED request at the same id holding the barrier.
  supervisor.queuedRequests.push({
    message: modernCall(32, "validate-project"),
    pending: { id: 32, method: "tools/call", toolName: "validate-project" }
  } as never);
  supervisor.validateBarrierKey = "number:32";

  supervisor.handleClientMessage(modernCall(32, "validate-project"));

  assert.equal(repliesFor(outbound, 32).length, 1, "the rejected instance is answered");
  assert.equal(
    supervisor.validateBarrierKey,
    undefined,
    "the rejection lowers the barrier: only a RUNNING namesake is exempt"
  );

  // Lowering it is safe because the queued owner re-raises it the moment it
  // reaches the head of the queue, which is the only place a queued
  // validate-project can dispatch from.
  child.stdin.destroyed = false;
  supervisor.drainQueue();
  assert.equal(
    supervisor.validateBarrierKey,
    "number:32",
    "the queued owner takes the barrier back at the next drain"
  );
  assert.equal(
    supervisor.pendingRequests.has("number:32"),
    false,
    "and it stays queued behind the work already in flight"
  );

  await supervisor.shutdown();
});

// --- Recovery-path order-of-operations and fault-isolation hardening -------
// Settling-window barrier release, initialize-recovery cleanup ordering,
// queued-dispatch release verification, and per-entry fault isolation in
// failPendingRequestsOnWorkerExit.

/** An EventEmitter-backed fake child, for tests that drive a real `spawnWorker`. */
function createEmitterChild(pid: number, writes: string[]): FakeChild {
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  stdin.destroyed = false;
  stdin.write = (payload: string) => {
    writes.push(payload);
    return true;
  };
  const child = new EventEmitter() as unknown as EventEmitter & FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = new EventEmitter() as unknown as FakeChild["stdout"];
  child.stderr = new EventEmitter() as unknown as FakeChild["stderr"];
  child.kill = () => true;
  return child;
}

test(
  "a timerClearer fault settling a validate-project response still lowers the barrier",
  async () => {
    const { supervisor, child, workerWrites } = createFixture();
    supervisor.handleClientData(
      encodeJsonRpcMessage(modernCall(30, "validate-project"), "content-length")
    );
    assert.equal(supervisor.runningValidateKey, "number:30", "premise: 30 holds the running slot");
    assert.equal(supervisor.validateBarrierKey, "number:30", "premise: 30 holds the barrier");

    // canDispatchImmediately declines any non-validate request while the
    // barrier is held, so 31 queues behind it rather than dispatching.
    supervisor.handleClientData(
      encodeJsonRpcMessage(modernCall(31, "list-versions"), "content-length")
    );
    assert.equal(supervisor.queuedRequests.length, 1, "premise: 31 is queued, not dispatched");

    const pendingThirty = supervisor.pendingRequests.get("number:30") as { deadlineTimer?: unknown };
    const validateTimer = pendingThirty.deadlineTimer;
    assert.ok(validateTimer, "premise: a deadline is armed for the running validate-project");

    // Throws exactly once, and only for 30's own deadline timer.
    const realTimerClearer = supervisor.timerClearer.bind(supervisor);
    let thrown = false;
    supervisor.timerClearer = (timer: unknown) => {
      if (timer === validateTimer && !thrown) {
        thrown = true;
        throw new Error("synthetic timer clearer fault");
      }
      realTimerClearer(timer);
    };

    supervisor.handleWorkerData(child, workerResponse(30));

    assert.equal(
      supervisor.runningValidateKey,
      undefined,
      "the running slot must be freed despite the timerClearer fault"
    );
    assert.equal(
      supervisor.validateBarrierKey,
      undefined,
      "and the barrier too, or every later request queues behind it forever"
    );
    assert.equal(
      dispatchCount(workerWrites, 31),
      1,
      "the request parked behind the barrier must reach the worker exactly once"
    );

    await supervisor.shutdown();
  }
);

test(
  "failPendingRequestsOnWorkerExit does not redundantly re-clear an already-cleared timer",
  async () => {
    const outbound: JSONRPCMessage[] = [];
    const workerWritesA: string[] = [];
    const workerWritesB: string[] = [];
    const childA = createEmitterChild(920_301, workerWritesA);
    const childB = createEmitterChild(920_302, workerWritesB);
    let spawnIndex = 0;
    // Assigned below, after construction, and read by reference from the
    // closure — mirrors the fixtures above.
    let watchedTimer: unknown;
    let watchedTimerClears = 0;
    const supervisor = new StdioSupervisor({
      entryFile: "fixture.ts",
      clientWriter: (message: JSONRPCMessage) => outbound.push(message),
      eventWriter: () => {},
      monotonicNow: () => 0,
      workerSpawner: () => [childA, childB][spawnIndex++] as never,
      treeTerminator: () => true,
      timerScheduler: () =>
        ({ unref() { return this; } }) as unknown as NodeJS.Timeout,
      // Succeeds on the FIRST invocation for id 63's own deadline timer, but
      // throws on any SECOND invocation for that SAME timer object — this is
      // the reviewer's exact scenario: a timer clearer that tolerates being
      // called once but faults on a redundant repeat call for the same
      // timer. Before the fix, the fail_pending_cleanup step's first clear
      // left `pending.deadlineTimer` still set, so writeSyntheticReply's own
      // internal `if (pending.deadlineTimer)` check would fire a SECOND,
      // avoidable clear attempt on the same timer and throw BEFORE the entry
      // was deleted from pendingRequests — stranding it forever, unanswered.
      timerClearer: (timer: unknown) => {
        if (timer !== watchedTimer) return;
        watchedTimerClears += 1;
        if (watchedTimerClears > 1) {
          throw new Error(
            "synthetic timerClearer fault on a redundant second clear of id 63's deadline"
          );
        }
      }
    } as never) as unknown as Harness;

    supervisor.spawnWorker();
    supervisor.handleWorkerReady(childA);

    // The retained `initialize` (id 62), carved out of
    // failPendingRequestsOnWorkerExit via `this.initializeRequest`.
    supervisor.initializeRequest = {
      jsonrpc: "2.0",
      id: 62,
      method: "initialize",
      params: {}
    } as unknown as JSONRPCRequest;
    supervisor.pendingRequests.set("number:62", {
      id: 62,
      method: "initialize",
      startedAt: 0,
      mode: "content-length",
      era: "unselected"
    });

    // id 63 is a validate-project entry (also confirms the running/barrier
    // slots clear correctly) whose deadline timer is the one under watch.
    watchedTimer = { unref() { return this; } };
    supervisor.pendingRequests.set("number:63", {
      id: 63,
      method: "tools/call",
      toolName: "validate-project",
      startedAt: 0,
      mode: "content-length",
      era: "unselected",
      deadlineTimer: watchedTimer
    });
    supervisor.runningValidateKey = "number:63";
    supervisor.validateBarrierKey = "number:63";

    // Force answerFaultedWorkerResponse to fault handling id 62's response,
    // taking the initialize_recovery branch — same trigger as the tests
    // above, which is the call path this file already uses to reach
    // failPendingRequestsOnWorkerExit.
    supervisor.handleWorkerMessage = () => {
      throw new Error("synthetic worker message fault");
    };
    supervisor.handleWorkerData(childA, workerResponse(62));

    assert.equal(
      repliesFor(outbound, 63).length,
      1,
      "the request must receive exactly one reply"
    );
    assert.equal(
      supervisor.pendingRequests.has("number:63"),
      false,
      "the entry must actually be removed from pendingRequests, not stranded"
    );
    assert.equal(
      supervisor.runningValidateKey,
      undefined,
      "the running slot must be freed"
    );
    assert.equal(
      supervisor.validateBarrierKey,
      undefined,
      "and the barrier too"
    );
    assert.equal(
      watchedTimerClears,
      1,
      "timerClearer must be invoked exactly once for the timer — the redundant " +
        "second clear must never be attempted at all"
    );

    await supervisor.shutdown();
  }
);

test(
  "an initialize-recovery fault also terminalizes other in-flight requests on the replaced generation",
  async () => {
    const outbound: JSONRPCMessage[] = [];
    const workerWritesA: string[] = [];
    const workerWritesB: string[] = [];
    const childA = createEmitterChild(920_001, workerWritesA);
    const childB = createEmitterChild(920_002, workerWritesB);
    let spawnIndex = 0;
    const supervisor = new StdioSupervisor({
      entryFile: "fixture.ts",
      clientWriter: (message: JSONRPCMessage) => outbound.push(message),
      eventWriter: () => {},
      monotonicNow: () => 0,
      workerSpawner: () => [childA, childB][spawnIndex++] as never,
      treeTerminator: () => true,
      timerScheduler: () =>
        ({ unref() { return this; } }) as unknown as NodeJS.Timeout,
      timerClearer: () => {}
    } as never) as unknown as Harness;

    supervisor.spawnWorker();
    supervisor.handleWorkerReady(childA);

    // The retained `initialize` (id 62) is excluded from
    // failPendingRequestsOnWorkerExit via `this.initializeRequest`, mirroring
    // the real handshake carve-out.
    supervisor.initializeRequest = {
      jsonrpc: "2.0",
      id: 62,
      method: "initialize",
      params: {}
    } as unknown as JSONRPCRequest;
    supervisor.pendingRequests.set("number:62", {
      id: 62,
      method: "initialize",
      startedAt: 0,
      mode: "content-length",
      era: "unselected"
    });

    // id 63 is an ordinary in-flight request on the same (childA) generation.
    // Admitting it through the real modern admission path would call
    // lockModernEra(), which deliberately wipes `initializeRequest` — modern
    // era never reuses the legacy handshake lifecycle — so it is installed
    // directly instead, the same way 62 is above.
    supervisor.pendingRequests.set("number:63", {
      id: 63,
      method: "tools/call",
      toolName: "list-versions",
      startedAt: 0,
      mode: "content-length",
      era: "unselected"
    });

    // Force answerFaultedWorkerResponse to fault handling id 62's response,
    // taking the initialize_recovery branch. recoverTimedOutWorker is NOT
    // stubbed here — unlike the existing stubbed test above — so the real
    // generation replacement runs.
    supervisor.handleWorkerMessage = () => {
      throw new Error("synthetic worker message fault");
    };
    supervisor.handleWorkerData(childA, workerResponse(62));

    assert.equal(
      repliesFor(outbound, 63).length,
      1,
      "the in-flight request stranded on the replaced generation must still be answered"
    );
    assert.equal(
      supervisor.pendingRequests.has("number:63"),
      false,
      "and it must not stay live at an id nothing will ever settle"
    );
    assert.equal(
      supervisor.pendingRequests.has("number:62"),
      true,
      "the retained initialize's pending entry survives the terminalization — replay to a " +
        "successor is a separate mechanism (gated on this.era === \"legacy\" in " +
        "handleWorkerReady) that this test does not exercise"
    );

    await supervisor.shutdown();
  }
);

test(
  "a fault in failPendingRequestsOnWorkerExit still lets recoverTimedOutWorker replace the worker",
  async () => {
    const outbound: JSONRPCMessage[] = [];
    const workerWritesA: string[] = [];
    const workerWritesB: string[] = [];
    const childA = createEmitterChild(920_101, workerWritesA);
    const childB = createEmitterChild(920_102, workerWritesB);
    let spawnIndex = 0;
    // Assigned below, after construction, and read by reference from the
    // closure — the fixture's timerClearer must exist before id 63's
    // deadline timer object does.
    let faultingTimer: unknown;
    const supervisor = new StdioSupervisor({
      entryFile: "fixture.ts",
      clientWriter: (message: JSONRPCMessage) => outbound.push(message),
      eventWriter: () => {},
      monotonicNow: () => 0,
      workerSpawner: () => [childA, childB][spawnIndex++] as never,
      treeTerminator: () => true,
      timerScheduler: () =>
        ({ unref() { return this; } }) as unknown as NodeJS.Timeout,
      // Faults only ONCE for id 63's OWN deadline timer — mirrors Defect 2's
      // account of failPendingRequestsOnWorkerExit's internal timerClearer
      // call throwing for some OTHER, unrelated pending request. One-shot so
      // that shutdown's own unrelated cleanup pass over the same (still-live,
      // since the fault left id 63 unsettled) timer does not also throw.
      timerClearer: (() => {
        let thrown = false;
        return (timer: unknown) => {
          if (timer === faultingTimer && !thrown) {
            thrown = true;
            throw new Error("synthetic timerClearer fault for id 63's deadline");
          }
        };
      })()
    } as never) as unknown as Harness;

    supervisor.spawnWorker();
    supervisor.handleWorkerReady(childA);

    // The retained `initialize` (id 62), carved out of
    // failPendingRequestsOnWorkerExit via `this.initializeRequest`.
    supervisor.initializeRequest = {
      jsonrpc: "2.0",
      id: 62,
      method: "initialize",
      params: {}
    } as unknown as JSONRPCRequest;
    supervisor.pendingRequests.set("number:62", {
      id: 62,
      method: "initialize",
      startedAt: 0,
      mode: "content-length",
      era: "unselected"
    });

    // id 63 is an ordinary in-flight request whose deadline-timer clearing is
    // the fault this test drives through failPendingRequestsOnWorkerExit.
    faultingTimer = { unref() { return this; } };
    supervisor.pendingRequests.set("number:63", {
      id: 63,
      method: "tools/call",
      toolName: "list-versions",
      startedAt: 0,
      mode: "content-length",
      era: "unselected",
      deadlineTimer: faultingTimer
    });

    // Force answerFaultedWorkerResponse to fault handling id 62's response,
    // taking the initialize_recovery branch — same trigger as the test above.
    supervisor.handleWorkerMessage = () => {
      throw new Error("synthetic worker message fault");
    };
    supervisor.handleWorkerData(childA, workerResponse(62));

    // recoverTimedOutWorker's effect — the generation is replaced — must still
    // happen despite failPendingRequestsOnWorkerExit throwing while clearing id
    // 63's deadline timer in the SAME initialize_recovery branch. Before the
    // fix, both calls ran inside one runRecoveryStep, so this throw would have
    // silently suppressed recoverTimedOutWorker and left `this.child`
    // pointing at the dead childA forever.
    assert.equal(
      supervisor.child,
      childB,
      "the worker generation must be replaced even though the sibling cleanup step faulted"
    );

    await supervisor.shutdown();
  }
);

test(
  "a fault clearing one stranded request's timer does not stop " +
    "failPendingRequestsOnWorkerExit from answering the others",
  async () => {
    const outbound: JSONRPCMessage[] = [];
    const workerWritesA: string[] = [];
    const workerWritesB: string[] = [];
    const childA = createEmitterChild(920_201, workerWritesA);
    const childB = createEmitterChild(920_202, workerWritesB);
    let spawnIndex = 0;
    // Assigned below, after construction, and read by reference from the
    // closure — mirrors the single-entry fixture above, but this fixture
    // carries two OTHER pending entries after the faulting one in Map
    // insertion order, which is what the unfixed single unguarded loop lets
    // an escaping throw strand.
    let faultingTimer: unknown;
    const supervisor = new StdioSupervisor({
      entryFile: "fixture.ts",
      clientWriter: (message: JSONRPCMessage) => outbound.push(message),
      eventWriter: () => {},
      monotonicNow: () => 0,
      workerSpawner: () => [childA, childB][spawnIndex++] as never,
      treeTerminator: () => true,
      timerScheduler: () =>
        ({ unref() { return this; } }) as unknown as NodeJS.Timeout,
      // Faults only once, and only for id 63's own deadline timer.
      timerClearer: (() => {
        let thrown = false;
        return (timer: unknown) => {
          if (timer === faultingTimer && !thrown) {
            thrown = true;
            throw new Error("synthetic timerClearer fault for id 63's deadline");
          }
        };
      })()
    } as never) as unknown as Harness;

    supervisor.spawnWorker();
    supervisor.handleWorkerReady(childA);

    // The retained `initialize` (id 62), carved out of
    // failPendingRequestsOnWorkerExit via `this.initializeRequest`.
    supervisor.initializeRequest = {
      jsonrpc: "2.0",
      id: 62,
      method: "initialize",
      params: {}
    } as unknown as JSONRPCRequest;
    supervisor.pendingRequests.set("number:62", {
      id: 62,
      method: "initialize",
      startedAt: 0,
      mode: "content-length",
      era: "unselected"
    });

    // id 63 is the entry whose OWN deadline-timer clearing throws.
    faultingTimer = { unref() { return this; } };
    supervisor.pendingRequests.set("number:63", {
      id: 63,
      method: "tools/call",
      toolName: "list-versions",
      startedAt: 0,
      mode: "content-length",
      era: "unselected",
      deadlineTimer: faultingTimer
    });

    // id 64 is an ordinary entry that clears normally, inserted AFTER 63 —
    // the unfixed single `for` loop aborts on 63's throw and never reaches
    // this entry at all.
    supervisor.pendingRequests.set("number:64", {
      id: 64,
      method: "tools/call",
      toolName: "list-versions",
      startedAt: 0,
      mode: "content-length",
      era: "unselected",
      deadlineTimer: { unref() { return this; } }
    });

    // id 65 is a validate-project entry, also inserted after 63, holding the
    // running/barrier slots. If the loop aborts before reaching it, both
    // slots stay stuck forever — every later validate-project request would
    // queue behind a barrier nothing will ever release.
    supervisor.pendingRequests.set("number:65", {
      id: 65,
      method: "tools/call",
      toolName: "validate-project",
      startedAt: 0,
      mode: "content-length",
      era: "unselected",
      deadlineTimer: { unref() { return this; } }
    });
    supervisor.runningValidateKey = "number:65";
    supervisor.validateBarrierKey = "number:65";

    // Force answerFaultedWorkerResponse to fault handling id 62's response,
    // taking the initialize_recovery branch — same trigger as the tests above.
    supervisor.handleWorkerMessage = () => {
      throw new Error("synthetic worker message fault");
    };
    supervisor.handleWorkerData(childA, workerResponse(62));

    assert.equal(
      repliesFor(outbound, 64).length,
      1,
      "an ordinary entry stranded AFTER the faulting one must still be answered exactly once"
    );
    assert.equal(
      repliesFor(outbound, 65).length,
      1,
      "the validate-project entry stranded after the faulting one must still be answered exactly once"
    );
    assert.equal(
      supervisor.runningValidateKey,
      undefined,
      "the running slot must be freed despite a DIFFERENT entry's timerClearer fault"
    );
    assert.equal(
      supervisor.validateBarrierKey,
      undefined,
      "and the barrier too, or every later validate-project request queues behind it forever"
    );

    await supervisor.shutdown();
  }
);

test(
  "a dispatch-settle release that throws after removing the entry still answers the queued request",
  async () => {
    const { supervisor, child, outbound, workerWrites } = createFixture();
    queueRequest(supervisor, 914);
    queueRequest(supervisor, 915);
    failWorkerWritesFor(supervisor, new Set([914]));
    // Mirrors "a release that throws after removing the entry still answers
    // the request" above, but drives dispatchQueuedRequest's catch instead of
    // answerFaultedWorkerResponse's.
    const realRelease = supervisor.releaseForwardedRequest.bind(supervisor);
    supervisor.releaseForwardedRequest = (key: string, pending: unknown) => {
      realRelease(key, pending);
      throw new Error("synthetic post-mutation release fault");
    };

    supervisor.drainQueue();

    assert.equal(
      supervisor.pendingRequests.has("number:914"),
      false,
      "the premise: the release completed its mutation before it threw"
    );
    assert.equal(
      repliesFor(outbound, 914).length,
      1,
      "so the id is answered rather than left to nothing"
    );
    assert.equal(repliesFor(outbound, 914)[0].error?.code, -32603);
    assert.equal(dispatchCount(workerWrites, 915), 1, "and the queue behind it is drained once");

    await supervisor.shutdown();
  }
);

test(
  "a queued dispatch whose no-child fallback re-queues the entry is not double-answered when the fallback itself later throws",
  async () => {
    const { supervisor, child, outbound, workerWrites } = createFixture();

    // No usable child at dispatch time: forwardRequest's no-child fallback
    // re-queues the SAME entry (the queue is not full) and then calls
    // scheduleRestart(), which this test makes throw via the injectable
    // timerScheduler seam. scheduleRestart's own guard bails out immediately
    // whenever `this.child` is set, so the child has to be removed — not just
    // have a destroyed stdin — to actually reach armRestartReservation's
    // `this.timerScheduler(...)` call.
    supervisor.child = undefined;
    (
      supervisor as unknown as {
        timerScheduler: (callback: () => void, delayMs: number) => NodeJS.Timeout;
      }
    ).timerScheduler = () => {
      throw new Error("synthetic scheduleRestart timer fault");
    };

    const entry: QueuedEntry = {
      message: modernCall(914, "list-versions"),
      pending: { id: 914, method: "tools/call" }
    };
    const dispatched = (
      supervisor as unknown as { dispatchQueuedRequest(entry: QueuedEntry): boolean }
    ).dispatchQueuedRequest(entry);

    assert.equal(dispatched, false, "premise: the fault propagated out of forwardRequest");
    assert.equal(
      supervisor.queuedRequests.length,
      1,
      "premise: the no-child fallback re-queued the SAME entry before the later fault"
    );
    assert.equal(
      supervisor.pendingRequests.has("number:914"),
      false,
      "premise: forwardRequest's no-child branch never installs the entry into pendingRequests"
    );
    assert.equal(
      repliesFor(outbound, 914).length,
      0,
      "must not be answered yet — it is still waiting in the queue for a real dispatch, " +
        "not released by queue.dispatch_settle in the first place"
    );

    // Let the re-queued entry dispatch for real: restore a usable child and a
    // non-throwing timerScheduler.
    supervisor.child = child;
    (
      supervisor as unknown as {
        timerScheduler: (callback: () => void, delayMs: number) => NodeJS.Timeout;
      }
    ).timerScheduler = () => ({ unref() { return this; } }) as unknown as NodeJS.Timeout;

    supervisor.drainQueue();
    assert.equal(
      dispatchCount(workerWrites, 914),
      1,
      "the re-queued entry reaches the worker exactly once"
    );

    supervisor.handleWorkerData(child, workerResponse(914));

    assert.equal(
      repliesFor(outbound, 914).length,
      1,
      "exactly one reply is ever produced for this id — not two from a spurious " +
        "queue.dispatch_settle_verify tombstone racing the real answer"
    );

    await supervisor.shutdown();
  }
);

// --- The DEFAULT writer configuration --------------------------------------

/**
 * A supervisor with NOTHING injected, which is how the process actually runs.
 *
 * Every other fixture here injects both writers, so it never exercises what
 * the shipped default does: `this.eventWriter = options.eventWriter ?? log`,
 * so the event writer IS `log`, and `writeToClient` with no `clientWriter`
 * encodes the reply and writes it to `process.stdout`. `runRecoveryStep`
 * reports through `log` to avoid making an INJECTED writer its own reporter —
 * a narrowing that does not apply here, because in this configuration the
 * reporter and the event writer are the same function.
 */
function createDefaultWriterFixture(): { supervisor: Harness; child: FakeChild } {
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    validateProjectTimeoutMs: 10_000,
    monotonicNow: () => 0,
    timerScheduler: (callback: () => void) =>
      ({ callback, cleared: false, unref() { return this; } }) as unknown as NodeJS.Timeout,
    timerClearer: () => {}
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 808,
    stdin: {
      destroyed: false,
      write() {
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
  supervisor.workerReaders.set(child, new JsonRpcFrameReader());
  supervisor.recoverTimedOutWorker = () => {};
  return { supervisor, child };
}

/** Captures both real output channels while `run()` executes. */
function captureStdio(run: () => void): { stdout: Buffer[]; stderr: string[] } {
  const stdout: Buffer[] = [];
  const stderr: string[] = [];
  const out = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const err = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const originalOut = out.write;
  const originalErr = err.write;
  out.write = (chunk: unknown) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    return true;
  };
  err.write = (chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    out.write = originalOut;
    err.write = originalErr;
  }
  return { stdout, stderr };
}

/** Decodes whatever the supervisor wrote to the real stdout. */
function decodeStdoutFrames(stdout: Buffer[]): ReplyFrame[] {
  const reader = new JsonRpcFrameReader();
  const frames: ReplyFrame[] = [];
  reader.processChunk(Buffer.concat(stdout), {
    onFrame: ({ message }) => frames.push(message as ReplyFrame),
    onError: () => {}
  });
  return frames;
}

test("the default writer configuration recovers an unstringifiable worker fault", async () => {
  const { supervisor, child } = createDefaultWriterFixture();

  const captured = captureStdio(() => {
    supervisor.handleClientData(
      encodeJsonRpcMessage(modernCall(70, "list-versions"), "content-length")
    );
    supervisor.handleWorkerMessage = () => {
      throw unstringifiableThrowable();
    };
    supervisor.handleWorkerData(child, workerResponse(70));
  });

  const replies = decodeStdoutFrames(captured.stdout).filter((frame) => frame.id === 70);
  assert.equal(
    replies.length,
    1,
    "with no writers injected the recovery still reaches the real stdout"
  );
  assert.equal(replies[0].error?.code, -32603);
  assert.equal(
    supervisor.pendingRequests.has("number:70"),
    false,
    "and the entry is released rather than stranded"
  );
  assert.equal(
    loggedEvents(captured.stderr).includes("supervisor.worker_message_failed"),
    true,
    "the fault is reported through log, which in this configuration IS the event writer"
  );
  assert.equal(
    loggedEvents(captured.stderr).includes("supervisor.worker_parse_error"),
    false,
    "and nothing escaped into the reader"
  );

  await supervisor.shutdown();
});
