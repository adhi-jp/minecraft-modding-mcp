import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeJsonRpcMessage,
  isJsonRpcFramingFatalError,
  JsonRpcFrameReader,
  loadMaxFrameBytes
} from "../../src/json-rpc-framing.ts";

/**
 * The reader's framing invariant: after ANY framing violation it either
 * provably resynchronizes — resuming where the peer itself delimited — or it
 * terminates the session with a diagnostic. It never silently consumes a
 * later valid frame, and it never waits on bytes an untrusted declared length
 * merely promised.
 */

const NORMAL_MESSAGE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "ping"
};

function createHarness(maxFrameBytes: number): {
  reader: JsonRpcFrameReader;
  frames: unknown[];
  errors: Error[];
  process: (chunk: Buffer) => void;
} {
  const reader = new JsonRpcFrameReader({ maxFrameBytes });
  const frames: unknown[] = [];
  const errors: Error[] = [];
  return {
    reader,
    frames,
    errors,
    process(chunk) {
      reader.processChunk(chunk, {
        onFrame: ({ message }) => frames.push(message),
        onError: (error) => errors.push(error)
      });
    }
  };
}

test("oversized Content-Length frames report the limit and preserve the next frame", () => {
  // The provable-resynchronization arm: the ENTIRE declared body is already in
  // the reader's buffer, so dropping exactly those bytes is a bounded
  // operation on data in hand that lands on the offset the peer itself named
  // as the next frame's first byte. No unarrived byte is trusted.
  const harness = createHarness(64);
  const oversizedBody = Buffer.alloc(96, 0x20);
  const oversizedFrame = Buffer.concat([
    Buffer.from(`Content-Length: ${oversizedBody.length}\r\n\r\n`, "utf8"),
    oversizedBody
  ]);

  harness.process(Buffer.concat([
    oversizedFrame,
    encodeJsonRpcMessage(NORMAL_MESSAGE, "line")
  ]));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /Content-Length 96.*limit.*64/i);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), false, "a verified skip is recoverable");
  assert.equal(harness.reader.isFatal, false);
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("an oversized Content-Length whose body has NOT arrived is framing-fatal instead of wedging the reader", () => {
  // The defect this replaces: the reader armed a discard countdown with the
  // ATTACKER-DECLARED length and refused to reclassify any later input until
  // it drained, so a 26-byte header with no body silently swallowed every
  // subsequent valid frame for the process lifetime. Skipping an unarrived
  // body cannot be made sound — an arbitrary binary body offers no delimiter
  // to scan forward to — so the session ends instead.
  const harness = createHarness(64);

  harness.process(Buffer.from("Content-Length: 999999999\r\n\r\n", "utf8"));

  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true, "the violation must be terminal");
  assert.match(harness.errors[0]?.message ?? "", /Content-Length 999999999.*limit.*64/i);
  assert.match(harness.errors[0]?.message ?? "", /Only 0 of the declared 999999999 body bytes/);
  assert.match(harness.errors[0]?.message ?? "", /session is terminated/);
  assert.equal(harness.reader.isFatal, true);

  // The reader is stopped, not merely blocked: a perfectly valid frame after
  // the violation is neither delivered NOR silently absorbed into a phantom
  // body, and no second error is reported.
  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  assert.deepEqual(harness.frames, []);
  assert.equal(harness.errors.length, 1);
});

test("duplicate Content-Length headers are framing-fatal rather than last-wins", () => {
  const harness = createHarness(1_048_576);
  const body = JSON.stringify(NORMAL_MESSAGE);

  harness.process(Buffer.from(
    `Content-Length: 30\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    "utf8"
  ));

  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true);
  assert.match(harness.errors[0]?.message ?? "", /Duplicate Content-Length header \(30 then \d+\)/);
  assert.deepEqual(harness.frames, [], "an ambiguous body length may never yield a frame");
  assert.equal(harness.reader.isFatal, true);
});

test("oversized Content-Length frames are rejected before a chunked body is buffered", () => {
  const maxFrameBytes = 64;
  const body = Buffer.alloc(256, 0x20);
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body
  ]);
  const harness = createHarness(maxFrameBytes);
  let deliveredBytes = 0;

  for (const byte of frame) {
    harness.process(Buffer.from([byte]));
    deliveredBytes += 1;
    if (harness.errors.length > 0) {
      break;
    }
  }

  assert.equal(harness.errors.length, 1);
  assert.ok(deliveredBytes <= maxFrameBytes + 64, `rejection waited for ${deliveredBytes} bytes`);
  assert.ok(deliveredBytes < frame.length);
});

test("headerless garbage exceeding the frame limit is rejected and the reader recovers", () => {
  const harness = createHarness(64);

  harness.process(Buffer.alloc(65, 0x78));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /65.*limit.*64/i);

  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("an overlong line-delimited frame is rejected and the reader recovers", () => {
  const harness = createHarness(64);
  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  harness.frames.length = 0;

  harness.process(Buffer.alloc(65, 0x78));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /line-delimited.*65.*limit.*64/i);

  harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("loadMaxFrameBytes applies defaults, overrides, fallback, and the minimum clamp", () => {
  assert.equal(loadMaxFrameBytes(undefined), 67_108_864);
  assert.equal(loadMaxFrameBytes("2097152"), 2_097_152);
  assert.equal(loadMaxFrameBytes("invalid"), 67_108_864);
  assert.equal(loadMaxFrameBytes("9007199254740992"), 67_108_864);
  assert.equal(loadMaxFrameBytes("1024"), 1_048_576);
});

function createModeHarness(): {
  reader: JsonRpcFrameReader;
  frames: Array<{ id: unknown; mode: string }>;
  errors: Error[];
  process: (chunk: Buffer) => void;
} {
  const reader = new JsonRpcFrameReader();
  const frames: Array<{ id: unknown; mode: string }> = [];
  const errors: Error[] = [];
  return {
    reader,
    frames,
    errors,
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

test("reader switches from line to Content-Length mid-stream and reports each frame's mode", () => {
  const harness = createModeHarness();
  harness.process(pingFrame(1, "line"));
  harness.process(pingFrame(2, "content-length"));
  harness.process(pingFrame(3, "content-length"));

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [
    { id: 1, mode: "line" },
    { id: 2, mode: "content-length" },
    { id: 3, mode: "content-length" }
  ]);
});

test("reader switches from Content-Length back to line mid-stream and reports each frame's mode", () => {
  const harness = createModeHarness();
  harness.process(pingFrame(1, "content-length"));
  harness.process(pingFrame(2, "line"));
  harness.process(pingFrame(3, "content-length"));
  harness.process(pingFrame(4, "line"));

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [
    { id: 1, mode: "content-length" },
    { id: 2, mode: "line" },
    { id: 3, mode: "content-length" },
    { id: 4, mode: "line" }
  ]);
});

test("reader switches from Content-Length to a whitespace-prefixed line frame", () => {
  const harness = createModeHarness();
  harness.process(pingFrame(1, "content-length"));
  // Blank separator lines plus leading spaces/tab before the JSON opener:
  // pure line mode tolerates both (blank lines are skipped; JSON.parse accepts
  // a whitespace-prefixed line), so the mid-stream switch must too.
  harness.process(Buffer.from(`\r\n\n  \t${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`, "utf8"));

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [
    { id: 1, mode: "content-length" },
    { id: 2, mode: "line" }
  ]);
});

test("reader rejects a line-delimited JSON array after Content-Length and recovers", () => {
  const harness = createModeHarness();
  const arrayFrame = Buffer.from(
    `${JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "ping" }])}\n`,
    "utf8"
  );

  harness.process(Buffer.concat([
    pingFrame(1, "content-length"),
    arrayFrame,
    pingFrame(3, "line")
  ]));

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0]?.message ?? "", /json-rpc|object|array/i);
  assert.deepEqual(harness.frames, [
    { id: 1, mode: "content-length" },
    { id: 3, mode: "line" }
  ]);
  assert.equal(harness.reader.currentMode, "line");
});

test("a Content-Length frame terminated by bare LF (no CR anywhere) decodes in content-length mode", () => {
  // Pins the \n\n header-boundary acceptance (findHeaderBoundary's
  // delimiterBytes-2 branch): some peers frame Content-Length with bare LF
  // line endings, and no other test sends one.
  const modeHarness = createModeHarness();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 21, method: "ping" });
  modeHarness.process(Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\n\n${body}`, "utf8"));

  assert.deepEqual(modeHarness.errors, []);
  assert.deepEqual(modeHarness.frames, [{ id: 21, mode: "content-length" }]);
  assert.equal(modeHarness.reader.currentMode, "content-length");

  // Full-message decode check on the message-capturing harness.
  const harness = createHarness(1_048_576);
  const normalBody = JSON.stringify(NORMAL_MESSAGE);
  harness.process(Buffer.from(`Content-Length: ${Buffer.byteLength(normalBody, "utf8")}\n\n${normalBody}`, "utf8"));
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
});

test("an under-declared Content-Length is framing-fatal instead of corrupting the next frame", () => {
  // This test previously DOCUMENTED the corruption: the body was sliced at the
  // declared length, the 10-byte tail stayed buffered, and it destroyed the
  // NEXT perfectly valid line frame (a second parse error, one frame silently
  // lost). A declared length whose bytes do not parse as JSON has failed its
  // only verification, so it cannot be trusted to say where the next frame
  // starts — under-declaration, over-declaration and an honestly framed bad
  // body are indistinguishable at this point.
  const harness = createModeHarness();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
  harness.process(Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8") - 10}\r\n\r\n${body}`, "utf8"));

  assert.equal(harness.frames.length, 0);
  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true);
  assert.match(harness.errors[0]?.message ?? "", /is not valid JSON/);
  assert.equal(harness.reader.isFatal, true);

  // The next valid frame is neither delivered nor corrupted into a second
  // error: the reader stopped, and the client learns that from the diagnostic.
  harness.process(pingFrame(8, "line"));
  harness.process(pingFrame(9, "line"));
  assert.equal(harness.frames.length, 0);
  assert.equal(harness.errors.length, 1);
});

test("an over-declared Content-Length is framing-fatal rather than swallowing the following frame", () => {
  // The mirror hazard: a length LONGER than the body makes the reader wait,
  // absorbing the next frame's bytes into this body. Detected by the same
  // rule, because the concatenation is not valid JSON.
  const harness = createModeHarness();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" });
  harness.process(Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8") + 20}\r\n\r\n${body}`, "utf8"));
  assert.deepEqual(harness.errors, [], "the reader is still waiting for the declared remainder");

  harness.process(pingFrame(12, "line"));
  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), true);
  assert.equal(harness.frames.length, 0, "neither frame may be delivered from a desynchronized stream");
  assert.equal(harness.reader.isFatal, true);
});

test("a Content-Length body that is valid JSON but not a JSON-RPC message stays recoverable", () => {
  // Valid JSON of exactly the declared length PROVES the frame boundary, so a
  // schema violation is an ordinary message-level error and the next frame is
  // still delivered — the reader only terminates when the boundary itself is
  // in doubt.
  const harness = createModeHarness();
  const body = JSON.stringify([{ jsonrpc: "2.0", id: 13, method: "ping" }]);
  harness.process(Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`, "utf8"));

  assert.equal(harness.errors.length, 1);
  assert.equal(isJsonRpcFramingFatalError(harness.errors[0]), false);
  assert.equal(harness.reader.isFatal, false);

  harness.process(pingFrame(14, "line"));
  assert.deepEqual(harness.frames, [{ id: 14, mode: "line" }]);
  assert.equal(harness.errors.length, 1);
});

test("frames split across chunk boundaries survive a framing switch", () => {
  const harness = createModeHarness();
  const stream = Buffer.concat([
    pingFrame(1, "content-length"),
    pingFrame(2, "line"),
    pingFrame(3, "content-length"),
    pingFrame(4, "line")
  ]);
  for (const chunkSize of [1, 3, 7]) {
    harness.frames.length = 0;
    harness.reader.clear();
    for (let offset = 0; offset < stream.length; offset += chunkSize) {
      harness.process(stream.subarray(offset, Math.min(offset + chunkSize, stream.length)));
    }
    assert.deepEqual(harness.errors, [], `chunkSize=${chunkSize}`);
    assert.deepEqual(harness.frames, [
      { id: 1, mode: "content-length" },
      { id: 2, mode: "line" },
      { id: 3, mode: "content-length" },
      { id: 4, mode: "line" }
    ], `chunkSize=${chunkSize}`);
  }
});

test("reset and clear cancel oversized-frame discard state", () => {
  // An oversized header whose body never arrives now leaves the reader in the
  // terminal framing-fatal state instead of a discard countdown; reset() and
  // clear() are the explicit re-arm for both, so a transport that rebuilds its
  // session gets a working reader back.
  for (const resetReader of [
    (reader: JsonRpcFrameReader) => reader.reset(),
    (reader: JsonRpcFrameReader) => reader.clear()
  ]) {
    const harness = createHarness(64);
    harness.process(Buffer.from("Content-Length: 96\r\n\r\n", "utf8"));
    assert.equal(harness.errors.length, 1);
    assert.equal(harness.reader.isFatal, true);

    resetReader(harness.reader);
    assert.equal(harness.reader.isFatal, false);
    harness.process(encodeJsonRpcMessage(NORMAL_MESSAGE, "line"));
    assert.deepEqual(harness.frames, [NORMAL_MESSAGE]);
  }
});
