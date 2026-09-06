import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeJsonRpcMessage,
  isJsonRpcFramingFatalError,
  JsonRpcFrameReader
} from "../../src/json-rpc-framing.ts";

/**
 * Where a Content-Length header block ends, and what it costs to get it wrong.
 *
 * `findHeaderBoundary` scans forward for the FIRST EMPTY LINE: a line ends at
 * an LF, a CR immediately before that LF belongs to the terminator, and the
 * block ends at the first line holding nothing but its own terminator. The
 * four shapes a peer can write — CRLFCRLF, LFLF, LFCRLF, CRLFLF — are
 * consequences of that one rule rather than four patterns to match, so the
 * tests below pin the rule from both sides: every shape must frame, and
 * neither a body byte nor an extra blank line may move the cut.
 *
 * The cost of a wrong cut is not a lost frame. A body window that does not
 * span a JSON value is framing-fatal (see JsonRpcFramingFatalError), which
 * ends the client session or restarts the worker — so every "still delimits
 * the frame" assertion below is also a session-survival assertion.
 */

type FramingHarness = {
  reader: JsonRpcFrameReader;
  frames: Array<{ id: unknown; mode: string }>;
  errors: Error[];
  process: (chunk: Buffer) => void;
};

function createHarness(): FramingHarness {
  const reader = new JsonRpcFrameReader({ maxFrameBytes: 1_048_576 });
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

function pingBody(id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
}

/** A Content-Length frame whose header block is terminated by `terminator`. */
function framedWith(id: number, terminator: string, body = pingBody(id)): string {
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${terminator}${body}`;
}

function pingFrame(id: number): Buffer {
  return encodeJsonRpcMessage({ jsonrpc: "2.0", id, method: "ping" } as never, "content-length");
}

/**
 * Frames `terminator`'s shape and asserts the cut landed exactly on the body.
 *
 * A TRAILING frame is what makes the assertion exact. On its own a frame only
 * proves its own body parsed; the frame BEHIND it starts at a byte the peer
 * named, so it is delivered only when this frame consumed exactly the bytes
 * the peer allotted — one byte over or short and the second frame is mis-read
 * or lost.
 */
function assertFramesCleanly(terminator: string, id: number, body?: string): void {
  const harness = createHarness();

  harness.process(Buffer.concat([
    Buffer.from(framedWith(id, terminator, body), "utf8"),
    pingFrame(id + 1)
  ]));

  assert.deepEqual(harness.errors, [], `${JSON.stringify(terminator)} is not a framing violation`);
  assert.equal(harness.reader.isFatal, false, "the session must survive");
  assert.deepEqual(harness.frames, [
    { id, mode: "content-length" },
    { id: id + 1, mode: "content-length" }
  ]);
}

test("a CRLFCRLF header block cuts at its empty line", () => {
  assertFramesCleanly("\r\n\r\n", 20);
});

test("an LFLF header block cuts at its empty line", () => {
  assertFramesCleanly("\n\n", 22);
});

test("an LF-terminated header line closed by a CRLF empty line still delimits the frame", () => {
  // A peer that ends its header LINES with LF may still end the empty
  // terminating line with CRLF. Matching only literal CRLFCRLF and LFLF left
  // this block with no terminator at all: the reader accumulated to the 8 KiB
  // header ceiling and went framing-fatal, losing that frame and every frame
  // behind it.
  assertFramesCleanly("\n\r\n", 24);
});

test("a CRLF-terminated header line closed by an LF empty line still delimits the frame", () => {
  // The mirror shape. Under the first-empty-line rule the CR in front of the
  // first LF is delimiter, not header text, so the cut is a 3-byte one at the
  // CR — and the body still opens on the byte the peer counted from.
  assertFramesCleanly("\r\n\n", 26);
});

test("a multi-line header block ends at its empty line, not at its first line terminator", () => {
  // Every other frame here carries ONE header line, where "the first line
  // terminator" and "the first EMPTY line" are the same byte and a reader that
  // confused them would still look correct. A second header line separates
  // them: cutting at the first terminator would leave `X-Trace: c2` as the
  // body's opening bytes and destroy this frame and the next.
  const harness = createHarness();
  const body = pingBody(28);
  const frame =
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\nX-Trace: c2\r\n\r\n${body}`;

  harness.process(Buffer.concat([Buffer.from(frame, "utf8"), pingFrame(29)]));

  assert.deepEqual(harness.errors, [], "an unknown header line is ignored, not a violation");
  assert.equal(harness.reader.isFatal, false);
  assert.deepEqual(harness.frames, [
    { id: 28, mode: "content-length" },
    { id: 29, mode: "content-length" }
  ]);
});

test("a body that opens with CRLF is body, not more terminator", () => {
  // The opposite failure: a rule that swallowed every consecutive blank line
  // would start the body window two bytes late here and read two bytes of the
  // NEXT frame as this one's tail. Only the FIRST empty line ends the block;
  // the `\r\n` that follows it is counted by the peer's Content-Length.
  assertFramesCleanly("\n\n", 30, `\r\n${pingBody(30)}`);
});

test("a header block and its empty line may arrive in separate reads", () => {
  // Byte-granular arrival: the header line's CRLF is complete, the empty
  // line's has not been read yet. The boundary must be found across the join
  // and nowhere else — a reader that cut at the first chunk's own CRLF would
  // frame an empty header block and lose the declaration.
  const harness = createHarness();
  const frame = framedWith(32, "\r\n\r\n");
  const splitAt = frame.indexOf("\r\n\r\n") + 2;

  harness.process(Buffer.from(frame.slice(0, splitAt), "utf8"));
  assert.deepEqual(harness.frames, [], "the header block is not complete yet");
  assert.deepEqual(harness.errors, [], "an unterminated block is not yet a violation");

  harness.process(Buffer.from(frame.slice(splitAt), "utf8"));

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.frames, [{ id: 32, mode: "content-length" }]);
});

test("a Content-Length frame after a line frame is re-framed through the CRLF re-injection path", () => {
  // The one path that BUILDS a mixed-style boundary rather than receiving one.
  // readLineDelimitedMessage strips the header line's own terminator, then
  // re-injects CRLF in front of whatever is buffered — here an LF-terminated
  // empty line — producing a CRLFLF boundary the peer never wrote. Reaching
  // this path needs a line frame first: detectMode otherwise recognizes the
  // `content-length` prefix and the re-injection never runs.
  const harness = createHarness();
  const lineFrame = `${JSON.stringify({ jsonrpc: "2.0", id: 34, method: "ping" })}\n`;

  harness.process(Buffer.from(`${lineFrame}${framedWith(35, "\n\n")}`, "utf8"));

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.reader.isFatal, false);
  assert.deepEqual(harness.frames, [
    { id: 34, mode: "line" },
    { id: 35, mode: "content-length" }
  ]);
});

test("blank lines before the first header block are skipped rather than read as a boundary", () => {
  // The closest observable approach to a boundary at buffer index 0. Both
  // detectMode and readContentLengthMessage strip leading LF and CRLF pairs
  // before the scan runs, so a stream that OPENS with empty lines never hands
  // the scan an index-0 terminator — it hands it a header block starting at
  // byte 0. Those strip loops are therefore also why the scan's `lineEnd > 0`
  // lookbehind guard has no reachable case through this reader: it is a bound
  // on the function, not a behavior any input here can exercise.
  const harness = createHarness();

  harness.process(Buffer.concat([
    Buffer.from("\r\n\r\n\n\n", "utf8"),
    pingFrame(36)
  ]));

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.reader.isFatal, false);
  assert.deepEqual(harness.frames, [{ id: 36, mode: "content-length" }]);
});

/**
 * An EXTRA empty line after the terminator is body, and the peer's declared
 * length does not cover it.
 *
 * Under the first-empty-line rule all four shapes read alike: the block ends
 * at the first empty line, the body window opens on the second one, and the
 * declared length then stops short of the JSON's last bytes. That reaches
 * readContentLengthMessage's body-parse failure, which is framing-fatal by a
 * deliberate, documented policy this repair did not change — an under- or
 * over-declared length is indistinguishable from an honestly framed bad body,
 * and the first two have already desynchronized the stream.
 *
 * These tests pin that outcome; they do not endorse it. Two of the four
 * (CRLFCRLF+CRLF and LFLF+CRLF) were already fatal before the terminator work
 * began. The other two framed only because the old two-pattern matcher
 * happened to skip past the extra line, which is an accident of the pattern
 * list rather than a reading of the bytes.
 */
function assertExtraBlankLineIsFramingFatal(terminator: string, id: number): void {
  const harness = createHarness();

  harness.process(Buffer.concat([
    Buffer.from(framedWith(id, terminator), "utf8"),
    pingFrame(id + 1)
  ]));

  assert.deepEqual(harness.frames, [], "the frame and everything behind it are lost");
  assert.equal(harness.errors.length, 1, "exactly one violation is reported");
  assert.equal(
    isJsonRpcFramingFatalError(harness.errors[0]),
    true,
    "the reported violation is the session-ending kind"
  );
  assert.match(
    String(harness.errors[0]?.message),
    /is not valid JSON/,
    "and it arrives through the body-parse channel, not the header-terminator one"
  );
  assert.equal(harness.reader.isFatal, true, "the reader refuses all further input");
}

test("a CRLFCRLF header block followed by an extra CRLF empty line is framing-fatal", () => {
  assertExtraBlankLineIsFramingFatal("\r\n\r\n\r\n", 40);
});

test("an LFLF header block followed by an extra CRLF empty line is framing-fatal", () => {
  assertExtraBlankLineIsFramingFatal("\n\n\r\n", 42);
});

test("an LFCRLF header block followed by an extra CRLF empty line is framing-fatal", () => {
  assertExtraBlankLineIsFramingFatal("\n\r\n\r\n", 44);
});

test("an LFCRLF header block followed by an extra LF empty line is framing-fatal", () => {
  assertExtraBlankLineIsFramingFatal("\n\r\n\n", 46);
});

/**
 * Two claims the surrounding comments used to make that the bytes do not
 * support. Both behaviours are pre-existing and deliberately left alone; these
 * tests exist so the corrected comments cannot drift back.
 */

test("an extra blank line is absorbed when the declared length counts trailing whitespace", () => {
  const harness = createHarness();
  const body = pingBody(60);
  // The extra CRLF contributes two UNCOUNTED leading bytes; the two counted
  // trailing spaces give the window two bytes of slack at the other end. The
  // window is shifted, not mis-sized, so it lands exactly on the JSON.
  const declared = Buffer.byteLength(body, "utf8") + 2;

  harness.process(Buffer.concat([
    Buffer.from(`Content-Length: ${declared}\r\n\r\n\r\n${body}  `, "utf8"),
    pingFrame(61)
  ]));

  assert.deepEqual(
    harness.frames.map((frame) => frame.id),
    [60, 61],
    "an extra blank line does not NECESSARILY cost the frame — the shift can be absorbed"
  );
  assert.deepEqual(harness.errors, [], "and no violation is reported");
  assert.equal(harness.reader.isFatal, false, "so the session continues");
});

/**
 * A pure-LF header block of exactly `bytes` bytes, ending in the empty line.
 * `Content-Length` comes first so `readLineDelimitedMessage` recognizes it.
 */
function lfHeaderBlock(bodyBytes: number, bytes: number): string {
  const first = `Content-Length: ${bodyBytes}\n`;
  const padPrefix = "X-Pad: ";
  const padLength = bytes - first.length - padPrefix.length - 2;
  return `${first}${padPrefix}${"p".repeat(padLength)}\n\n`;
}

test("re-injecting CRLF costs one byte, which a header block at the 8 KiB ceiling cannot spare", () => {
  const body = pingBody(62);
  const block = lfHeaderBlock(Buffer.byteLength(body, "utf8"), 8 * 1024);
  assert.equal(Buffer.byteLength(block, "utf8"), 8 * 1024, "the block is exactly at the limit");

  // On its own the block is accepted: 8192 bytes is not over the ceiling.
  const alone = createHarness();
  alone.process(Buffer.from(block + body, "utf8"));
  assert.deepEqual(alone.frames.map((frame) => frame.id), [62], "at the limit it frames");

  // After a line-delimited frame the same bytes take the mode-switch path,
  // where the stripped LF is written back as CRLF — one byte more than the
  // peer sent, which is one byte too many.
  const afterLine = createHarness();
  afterLine.process(Buffer.from(`${pingBody(63)}\n${block}${body}`, "utf8"));
  assert.deepEqual(
    afterLine.frames.map((frame) => frame.id),
    [63],
    "the line frame is delivered; the header block behind it is not"
  );
  assert.equal(afterLine.errors.length, 1, "exactly one violation is reported");
  assert.match(
    String(afterLine.errors[0]?.message),
    /Content-Length header is 8193 bytes, exceeding the header limit of 8192 bytes/,
    "and it names the byte the re-injection added"
  );
});
