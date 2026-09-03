import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeJsonRpcMessage,
  isJsonRpcFramingFatalError,
  JsonRpcFrameReader
} from "../../src/json-rpc-framing.ts";

/**
 * Four framing defects the reader's own invariant already forbade: a declared
 * body that never arrives must not park the reader forever, a header block
 * that declared a length and then contradicted itself must not let the second
 * declaration win, the header terminator must be the FIRST one in the stream
 * rather than the first CRLFCRLF anywhere, and a bug in the frame HANDLER must
 * not rewrite framing state.
 */

type ScheduledIdleTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

type FramingHarness = {
  reader: JsonRpcFrameReader;
  frames: Array<{ id: unknown; mode: string }>;
  errors: Error[];
  timers: ScheduledIdleTimer[];
  process: (chunk: Buffer) => void;
};

function createHarness(options: Record<string, unknown> = {}): FramingHarness {
  const timers: ScheduledIdleTimer[] = [];
  const reader = new JsonRpcFrameReader({
    timerScheduler: (callback: () => void, delayMs: number) => {
      const timer: ScheduledIdleTimer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    timerClearer: (handle: unknown) => {
      (handle as ScheduledIdleTimer).cleared = true;
    },
    ...options
  } as never);
  const frames: Array<{ id: unknown; mode: string }> = [];
  const errors: Error[] = [];
  return {
    reader,
    frames,
    errors,
    timers,
    process(chunk) {
      reader.processChunk(chunk, {
        onFrame: ({ message, mode }) => frames.push({ id: (message as { id?: unknown }).id, mode }),
        onError: (error) => errors.push(error)
      });
    }
  };
}

function pingFrame(id: number, mode: "line" | "content-length"): Buffer {
  return encodeJsonRpcMessage({ jsonrpc: "2.0", id, method: "ping" } as never, mode);
}

/** The single live idle timer, or undefined when none is armed. */
function armedTimer(harness: FramingHarness): ScheduledIdleTimer | undefined {
  return harness.timers.find((timer) => !timer.cleared);
}

test("a declared body that never arrives ends the session once the idle budget expires", () => {
  // The reviewer's wedge: `Content-Length: 4096` with no body armed
  // awaitedFrameEnd, and because the declaration is UNDER the frame limit
  // nothing ever reclassified it — 50 later line frames were absorbed into a
  // body that was never coming. An under-limit declaration is now on a clock.
  const harness = createHarness({ maxFrameBytes: 1_048_576, incompleteFrameIdleMs: 5_000 });

  harness.process(Buffer.from("Content-Length: 4096\r\n\r\n", "utf8"));
  assert.deepEqual(harness.errors, [], "the header alone is not yet a violation");
  assert.equal(harness.reader.currentMode, "content-length");

  const timer = armedTimer(harness);
  assert.ok(timer, "an incomplete declared body must arm the idle budget");
  assert.equal(timer.delayMs, 5_000);

  timer.callback();

  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true, "the wedge must be terminal");
  assert.match(harness.errors[0]?.message ?? "", /declared 4096 body bytes/);
  assert.match(harness.errors[0]?.message ?? "", /only 0 arrived/);
  assert.match(harness.errors[0]?.message ?? "", /session is terminated/);
  assert.equal(harness.reader.isFatal, true);

  // Every later frame is refused rather than silently swallowed, exactly as
  // the over-limit arm of the same violation already behaved.
  harness.process(pingFrame(2, "line"));
  assert.deepEqual(harness.frames, []);
  assert.equal(harness.errors.length, 1);
});

test("bytes arriving before the idle budget expires re-arm it and the completed frame is delivered", () => {
  const harness = createHarness({ maxFrameBytes: 1_048_576, incompleteFrameIdleMs: 5_000 });
  const frame = pingFrame(3, "content-length");
  const split = frame.length - 5;

  harness.process(frame.subarray(0, split));
  const firstTimer = armedTimer(harness);
  assert.ok(firstTimer, "the partial body arms the budget");

  harness.process(frame.subarray(split));

  assert.equal(firstTimer.cleared, true, "arriving bytes must clear the pending budget");
  assert.equal(armedTimer(harness), undefined, "a completed frame leaves no timer armed");
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [{ id: 3, mode: "content-length" }]);
  assert.equal(harness.reader.isFatal, false);

  // A stale timer that already fired its clear must be inert: firing it after
  // the frame completed may not fabricate a violation.
  firstTimer.callback();
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.reader.isFatal, false);
});

test("a non-numeric Content-Length followed by a numeric one is fatal, not last-wins", () => {
  // `5x` made the reader throw a RECOVERABLE error after consuming only the
  // header block, so the 44 declared body bytes stayed buffered and were
  // re-dispatched as line frames: the second declaration effectively won.
  const harness = createHarness({ maxFrameBytes: 1_048_576 });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" });

  harness.process(Buffer.from(
    `Content-Length: 5x\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    "utf8"
  ));

  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true);
  assert.equal(harness.reader.isFatal, true);
  assert.deepEqual(harness.frames, [], "a contradicted header block may never yield a frame");

  harness.process(pingFrame(5, "line"));
  assert.deepEqual(harness.frames, []);
  assert.equal(harness.errors.length, 1);
});

test("a malformed header line after a numeric Content-Length is fatal, while a lone unusable value stays recoverable", () => {
  // `Content-Length: 44` then `JUNKLINE` consumed only the header block and
  // left the 44 declared body bytes to be re-read as line frames.
  const declared = createHarness({ maxFrameBytes: 1_048_576 });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" });

  declared.process(Buffer.from(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\nJUNKLINE\r\n\r\n${body}`,
    "utf8"
  ));

  assert.equal(declared.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(declared.errors[0]), true);
  assert.equal(declared.reader.isFatal, true);
  assert.deepEqual(declared.frames, [], "body bytes behind a broken header block are never frames");

  // The boundary the reader's doc comment draws, unchanged: a header block
  // that declared NO usable body length consumes only itself, so the recovery
  // is provable and the session survives.
  const undeclared = createHarness({ maxFrameBytes: 1_048_576 });
  undeclared.process(Buffer.from("Content-Length: nope\r\n\r\n", "utf8"));
  assert.equal(undeclared.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(undeclared.errors[0]), false);
  assert.equal(undeclared.reader.isFatal, false);
  undeclared.process(pingFrame(7, "line"));
  assert.deepEqual(undeclared.frames, [{ id: 7, mode: "line" }]);
});

test("an LF-framed header is not mis-terminated by a CRLFCRLF inside the JSON body", () => {
  // CR and LF are legal JSON inter-token whitespace, so a body may legitimately
  // contain \r\n\r\n. findHeaderBoundary preferred that CRLFCRLF over the
  // EARLIER \n\n that actually ended the header, mis-slicing the block and
  // destroying this frame and the next.
  const harness = createHarness({ maxFrameBytes: 1_048_576 });
  const body = `{\r\n\r\n"jsonrpc":"2.0","id":8,"method":"ping"}`;

  harness.process(Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\n\n${body}`, "utf8"),
    pingFrame(9, "content-length")
  ]));

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [
    { id: 8, mode: "content-length" },
    { id: 9, mode: "content-length" }
  ]);
});

test("an exception thrown by the frame handler leaves framing state untouched", () => {
  // processChunk wrapped onFrame in the framing try/catch, so a handler bug was
  // reported as a parse error AND reset mode/awaitedFrameEnd. The compat
  // transport picks its response framing from currentMode, so the reset
  // silently downgraded later replies to line framing.
  const reader = new JsonRpcFrameReader();
  const frames: Array<{ id: unknown; mode: string }> = [];
  const errors: Error[] = [];
  let throwNext = true;
  const handlers = {
    onFrame: ({ message, mode }: { message: unknown; mode: string }) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("frame handler exploded");
      }
      frames.push({ id: (message as { id?: unknown }).id, mode });
    },
    onError: (error: Error) => {
      errors.push(error);
    }
  };

  const second = pingFrame(11, "content-length");
  // A complete frame followed by a PARTIAL next header: nothing in that tail
  // lets the reader re-detect content-length framing, so a mode reset here is
  // directly observable.
  reader.processChunk(
    Buffer.concat([pingFrame(10, "content-length"), second.subarray(0, 11)]),
    handlers as never
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /frame handler exploded/);
  assert.equal(isJsonRpcFramingFatalError(errors[0]), false, "a handler bug is not a framing violation");
  assert.equal(reader.isFatal, false);
  assert.equal(reader.currentMode, "content-length", "a handler bug must not rewrite the framing mode");

  reader.processChunk(second.subarray(11), handlers as never);

  assert.deepEqual(frames, [{ id: 11, mode: "content-length" }]);
  assert.equal(errors.length, 1);
});
